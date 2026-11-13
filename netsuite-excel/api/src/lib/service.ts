// Transport-independent endpoint logic, so tests can call it without Azure Functions.

import { principalFromHeader, isAllowed, requireAllowed } from './auth';
import { getReport, isPeriodParam, listReports, PERIODS_SQL, validateParams } from './catalog';
import { loadConfig } from './config';
import { ApiError, toErrorBody } from './errors';
import { MockProvider } from './mock';
import { NetSuiteClient } from './netsuite';
import { runReport } from './runReport';
import { QueryProvider } from './types';

export interface Reply {
  status: number;
  body: unknown;
}
export interface Deps {
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  provider?: QueryProvider; // tests inject one
}

const MAX_BODY_BYTES = 4096;
let cachedClient: { key: string; client: NetSuiteClient } | undefined;

function providerFor(cfg: ReturnType<typeof loadConfig>, log: (m: string) => void): QueryProvider {
  if (cfg.mock) return new MockProvider();
  const c = cfg.netsuite!;
  const key = `${c.accountId}|${c.clientId}|${c.certificateId}`;
  if (!cachedClient || cachedClient.key !== key) cachedClient = { key, client: new NetSuiteClient(c, log) };
  return cachedClient.client;
}

export interface Period { name: string; start: string; end: string }
const PERIOD_CACHE_MS = 10 * 60 * 1000;
let periodCache: { key: string; at: number; periods: Period[] } | undefined;

/** Monthly posting periods from NetSuite, cached for 10 minutes per data source. */
async function loadPeriods(provider: QueryProvider, cacheKey: string): Promise<Period[]> {
  if (periodCache && periodCache.key === cacheKey && Date.now() - periodCache.at < PERIOD_CACHE_MS) return periodCache.periods;
  const res = await provider.query({ report: 'periods', kind: 'rows', params: {}, sql: PERIODS_SQL }, 0, 1000);
  const periods = res.items.map((r) => ({ name: String(r.name ?? ''), start: String(r.startdate ?? ''), end: String(r.enddate ?? '') }));
  periodCache = { key: cacheKey, at: Date.now(), periods };
  return periods;
}

/** Period names must be real monthly periods, and From must not be after To. */
function checkPeriods(params: Record<string, string>, periods: Period[]) {
  const byName = new Map(periods.map((p) => [p.name, p]));
  for (const [k, v] of Object.entries(params)) {
    if (isPeriodParam(k) && !byName.has(v)) {
      throw new ApiError(400, 'UNKNOWN_PERIOD', `"${v.slice(0, 30)}" is not an accounting period. Pick one from the list.`);
    }
  }
  if (params.fromPeriod && params.toPeriod && byName.get(params.fromPeriod)!.start > byName.get(params.toPeriod)!.start) {
    throw new ApiError(400, 'BAD_RANGE', 'The From period must not be after the To period.');
  }
}

export async function periodsService(principalHeader: string | null, deps: Deps = {}): Promise<Reply> {
  try {
    const cfg = loadConfig(deps.env);
    requireAllowed(principalHeader, cfg.allowedUsers);
    const provider = deps.provider ?? providerFor(cfg, deps.log ?? (() => {}));
    return { status: 200, body: { periods: await loadPeriods(provider, cfg.mock ? 'mock' : 'netsuite') } };
  } catch (e) {
    return toErrorBody(e);
  }
}

export async function meService(principalHeader: string | null, deps: Deps = {}): Promise<Reply> {
  try {
    const cfg = loadConfig(deps.env);
    const p = principalFromHeader(principalHeader);
    const allowed = isAllowed(p, cfg.allowedUsers);
    return { status: 200, body: { email: p.email, allowed, role: allowed ? 'reader' : 'none', mock: cfg.mock } };
  } catch (e) {
    return toErrorBody(e);
  }
}

export async function reportsService(principalHeader: string | null, deps: Deps = {}): Promise<Reply> {
  try {
    const cfg = loadConfig(deps.env);
    requireAllowed(principalHeader, cfg.allowedUsers);
    return { status: 200, body: { mock: cfg.mock, maxRows: cfg.maxRows, reports: listReports() } };
  } catch (e) {
    return toErrorBody(e);
  }
}

export async function runService(principalHeader: string | null, rawBody: string, deps: Deps = {}): Promise<Reply> {
  const log = deps.log ?? (() => {});
  const started = Date.now();
  let user = 'unknown';
  let reportId = 'unknown';
  let params: Record<string, string> = {};
  try {
    const cfg = loadConfig(deps.env);
    user = requireAllowed(principalHeader, cfg.allowedUsers).email;

    if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request was too large.');
    let body: { report?: unknown; params?: unknown };
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
