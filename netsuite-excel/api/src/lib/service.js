// Transport-independent endpoint logic, so tests can call it without Azure Functions.

import { principalFromHeader, isAllowed, requireAllowed } from './auth.js';
import { getReport, isPeriodParam, listReports, PERIODS_SQL, validateParams } from './catalog.js';
import { loadConfig } from './config.js';
import { ApiError, toErrorBody } from './errors.js';
import { MockProvider } from './mock.js';
import { NetSuiteClient } from './netsuite.js';
import { runReport } from './runReport.js';
import { buildDetail, evaluateBatch, FILTERS, MAX_REQUESTS } from './formulas.js';

const MAX_BODY_BYTES = 4096;
let cachedClient;

function providerFor(cfg, log) {
  if (cfg.mock) return new MockProvider();
  const c = cfg.netsuite;
  const key = `${c.accountId}|${c.clientId}|${c.certificateId}`;
  if (!cachedClient || cachedClient.key !== key) cachedClient = { key, client: new NetSuiteClient(c, log) };
  return cachedClient.client;
}

const PERIOD_CACHE_MS = 10 * 60 * 1000;
let periodCache;

/** Monthly posting periods from NetSuite, cached for 10 minutes per data source. */
async function loadPeriods(provider, cacheKey) {
  if (periodCache && periodCache.key === cacheKey && Date.now() - periodCache.at < PERIOD_CACHE_MS) return periodCache.periods;
  const res = await provider.query({ report: 'periods', kind: 'rows', params: {}, sql: PERIODS_SQL }, 0, 1000);
  const periods = res.items.map((r) => ({ name: String(r.name ?? ''), start: String(r.startdate ?? ''), end: String(r.enddate ?? '') }));
  periodCache = { key: cacheKey, at: Date.now(), periods };
  return periods;
}

/** Period names must be real monthly periods, and From must not be after To. */
function checkPeriods(params, periods) {
  const byName = new Map(periods.map((p) => [p.name, p]));
  for (const [k, v] of Object.entries(params)) {
    if (isPeriodParam(k) && !byName.has(v)) {
      throw new ApiError(400, 'UNKNOWN_PERIOD', `"${v.slice(0, 30)}" is not an accounting period. Pick one from the list.`);
    }
  }
  if (params.fromPeriod && params.toPeriod && byName.get(params.fromPeriod).start > byName.get(params.toPeriod).start) {
    throw new ApiError(400, 'BAD_RANGE', 'The From period must not be after the To period.');
  }
}

export async function periodsService(principalHeader, deps = {}) {
  try {
    const cfg = loadConfig(deps.env);
    requireAllowed(principalHeader, cfg.allowedUsers);
    const provider = deps.provider ?? providerFor(cfg, deps.log ?? (() => {}));
    return { status: 200, body: { periods: await loadPeriods(provider, cfg.mock ? 'mock' : 'netsuite') } };
  } catch (e) {
    return toErrorBody(e);
  }
}

const MAX_FORMULA_BODY_BYTES = 256 * 1024;
const LOOKUP_CACHE_MS = 10 * 60 * 1000;
const lookupCache = new Map(); // `${source}|${filterKey}` -> { at, list }

/** [{id, name}] for a filter's list table (subsidiaries, profit centers, ...), cached 10 minutes. */
async function loadLookup(provider, source, filterKey) {
  const ck = `${source}|${filterKey}`;
  const hit = lookupCache.get(ck);
  if (hit && Date.now() - hit.at < LOOKUP_CACHE_MS) return hit.list;
  const table = FILTERS[filterKey].table; // fixed table names only, never user input
  const res = await provider.query({ report: 'lookup', kind: 'rows', params: { table }, sql: `SELECT id, name FROM ${table} ORDER BY id` }, 0, 1000);
  const list = res.items.map((r) => ({ id: String(r.id), name: String(r.name ?? '') }));
  lookupCache.set(ck, { at: Date.now(), list });
  return list;
}

/** [{id, acctnumber}] for every account, cached 10 minutes (drill-down expands account ranges with it). */
async function loadAccounts(provider, source) {
  const ck = `${source}|accounts`;
  const hit = lookupCache.get(ck);
  if (hit && Date.now() - hit.at < LOOKUP_CACHE_MS) return hit.list;
  const list = [];
  for (let off = 0; ; off += 1000) {
    const res = await provider.query({ report: 'lookup', kind: 'rows', params: { table: 'account' }, sql: 'SELECT id, acctnumber FROM account ORDER BY id' }, off, 1000);
    list.push(...res.items.map((r) => ({ id: String(r.id), acctnumber: r.acctnumber === null || r.acctnumber === undefined ? '' : String(r.acctnumber) })));
    if (!res.hasMore || res.items.length < 1000) break;
  }
  lookupCache.set(ck, { at: Date.now(), list });
  return list;
}

/** POST /api/detail  { request: {...one formula request...} }  ->  ReportResult whose rows add up to the cell. */
export async function detailService(principalHeader, rawBody, deps = {}) {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  let user = 'unknown';
  let request = null;
  try {
    const cfg = loadConfig(deps.env);
    user = requireAllowed(principalHeader, cfg.allowedUsers).email;
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request was too large.');
    let body;
    try { body = JSON.parse(rawBody); } catch { throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.'); }
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => k !== 'request')) throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.');
    request = body.request;
    const provider = deps.provider ?? providerFor(cfg, log);
    const source = cfg.mock ? 'mock' : 'netsuite';
    const result = await buildDetail(request, {
      periods: await loadPeriods(provider, source),
      provider,
      log,
      loadLookup: (k) => loadLookup(provider, source, k),
      loadAccounts: () => loadAccounts(provider, source),
      maxRows: cfg.maxRows,
      user,
      mock: cfg.mock,
    });
    log(`AUDIT ${JSON.stringify({ user, report: 'detail', request, status: 'ok', rows: result.info.rowCount, ms: Date.now() - started })}`);
    return { status: 200, body: result };
  } catch (e) {
    const detail = e instanceof ApiError ? `${e.code}${e.detail ? ': ' + e.detail : ''}` : String(e);
    log(`AUDIT ${JSON.stringify({ user, report: 'detail', request, status: 'error', error: detail.slice(0, 500), ms: Date.now() - started })}`);
    return toErrorBody(e);
  }
}

/** POST /api/balances  { requests: [...] }  ->  { results: [{ value } | { error }] }  (see formulas.js) */
export async function formulasService(principalHeader, rawBody, deps = {}) {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  let user = 'unknown';
  let n = 0;
  try {
    const cfg = loadConfig(deps.env);
    user = requireAllowed(principalHeader, cfg.allowedUsers).email;
    if (Buffer.byteLength(rawBody, 'utf8') > MAX_FORMULA_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', 'Too many formulas in one request.');
    let body;
    try { body = JSON.parse(rawBody); } catch { throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.'); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.requests) || Object.keys(body).some((k) => k !== 'requests')) {
      throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.');
    }
    n = body.requests.length;
    if (n > MAX_REQUESTS) throw new ApiError(413, 'TOO_MANY_FORMULAS', `At most ${MAX_REQUESTS} formulas per request.`);
    const provider = deps.provider ?? providerFor(cfg, log);
    const source = cfg.mock ? 'mock' : 'netsuite';
    const periods = await loadPeriods(provider, source);
    const out = await evaluateBatch(body.requests, { periods, provider, log, loadLookup: (k) => loadLookup(provider, source, k) });
    const errors = out.results.filter((r) => r.error).length;
    log(`AUDIT ${JSON.stringify({ user, report: 'formulas', requests: n, groups: out.groups, errors, status: 'ok', ms: Date.now() - started })}`);
    return { status: 200, body: { results: out.results, mock: cfg.mock } };
  } catch (e) {
    const detail = e instanceof ApiError ? `${e.code}${e.detail ? ': ' + e.detail : ''}` : String(e);
    log(`AUDIT ${JSON.stringify({ user, report: 'formulas', requests: n, status: 'error', error: detail.slice(0, 500), ms: Date.now() - started })}`);
    return toErrorBody(e);
  }
}

export async function meService(principalHeader, deps = {}) {
  try {
    const cfg = loadConfig(deps.env);
    const p = principalFromHeader(principalHeader);
    const allowed = isAllowed(p, cfg.allowedUsers);
    return { status: 200, body: { email: p.email, allowed, role: allowed ? 'reader' : 'none', mock: cfg.mock } };
  } catch (e) {
    return toErrorBody(e);
  }
}

export async function reportsService(principalHeader, deps = {}) {
  try {
    const cfg = loadConfig(deps.env);
    requireAllowed(principalHeader, cfg.allowedUsers);
    return { status: 200, body: { mock: cfg.mock, maxRows: cfg.maxRows, reports: listReports() } };
  } catch (e) {
    return toErrorBody(e);
  }
}

export async function runService(principalHeader, rawBody, deps = {}) {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  let user = 'unknown';
  let reportId = 'unknown';
  let params = {};
  try {
    const cfg = loadConfig(deps.env);
    user = requireAllowed(principalHeader, cfg.allowedUsers).email;

    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request was too large.');
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'BAD_JSON', 'The request was not in the expected format.');
    for (const k of Object.keys(body)) {
      if (k !== 'report' && k !== 'params') throw new ApiError(400, 'UNKNOWN_FIELD', 'The request had unexpected fields.');
    }
    const def = getReport(body.report);
    reportId = def.id;
    params = validateParams(def, body.params);

    const provider = deps.provider ?? providerFor(cfg, log);
    if (Object.keys(params).some(isPeriodParam)) checkPeriods(params, await loadPeriods(provider, cfg.mock ? 'mock' : 'netsuite'));
    const result = await runReport(def, params, provider, { maxRows: cfg.maxRows, user, mock: cfg.mock });
    log(`AUDIT ${JSON.stringify({ user, report: reportId, params, status: 'ok', rows: result.info.rowCount, debits: result.info.debits, credits: result.info.credits, ms: Date.now() - started })}`);
    return { status: 200, body: result };
  } catch (e) {
    const detail = e instanceof ApiError ? `${e.code}${e.detail ? ': ' + e.detail : ''}` : String(e);
    log(`AUDIT ${JSON.stringify({ user, report: reportId, params, status: 'error', error: detail.slice(0, 500), ms: Date.now() - started })}`);
    return toErrorBody(e);
  }
}
