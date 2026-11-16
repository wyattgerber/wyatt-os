// F9-style formula engine: answers many =NS.BALANCE / =NS.ACTIVITY cells with as few SuiteQL queries as possible.
//
//   NS.BALANCE(account, periodOrDate, [filters])   ending balance (debit - credit; credits are negative)
//       - period name ("Oct 2026"): the VALIDATED Trial Balance SQL (balance sheet cumulative, P&L fiscal YTD,
//         prior-year P&L rolled into the retained-earnings account).
//       - date ("2026-10-31"): the same structure on transaction dates (UNVALIDATED until checked against the
//         period result at month-ends).
//   NS.ACTIVITY(account, fromPeriod, toPeriod, [filters])   net movement over a period range (VALIDATED GL basis).
//
// account: "4000" or an inclusive range "4000:4999" (numeric compare when all parts are digits).
// filters: subsidiary, profitCenter (NetSuite Class, renamed), department, location, mode, serviceType (custom segments).
//   Each value is an internal ID or a name. Names are resolved to IDs HERE; only digits ever reach the SQL.
//
// Requests are grouped by (function, period/date/range, filter set); each group is ONE SuiteQL query plus its
// totals query, and must pass the same gate as the reports (rows = NetSuite's totals; unfiltered results balance).
// A failing group returns an error for its cells only, never a wrong number.

import { ApiError } from './errors.js';
import { formatMoney, parseMoney } from './money.js';
import { TAL_FROM, TAL_BASE, PL_TYPES, periodRange, tbParts, isIsoDate } from './catalog.js';
import { pool } from './runReport.js';

export const MAX_REQUESTS = 1000;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,30}$/;
const ID_RE = /^\d{1,10}$/;
const MAX_NAME = 120;

export const FILTERS = {
  subsidiary: { column: 'tl.subsidiary', table: 'subsidiary', label: 'Subsidiary' },
  profitCenter: { column: 'tl.class', table: 'classification', label: 'Profit Center' },
  department: { column: 'tl.department', table: 'department', label: 'Department' },
  location: { column: 'tl.location', table: 'location', label: 'Location' },
  mode: { column: 'tl.cseg_appf_mode', table: 'customrecord_cseg_appf_mode', label: 'Mode' },
  serviceType: { column: 'tl.cseg_appf_serv_type', table: 'customrecord_cseg_appf_serv_type', label: 'Service Type' },
};

const TL_JOIN = ' LEFT JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline';

// ---------- request validation ----------

function parseAccount(spec) {
  const s = String(spec ?? '').trim();
  const parts = s.split(':').map((x) => x.trim());
  if (parts.length > 2 || !parts.every((p) => ACCOUNT_RE.test(p))) {
    throw new ApiError(400, 'BAD_ACCOUNT', `Account "${s.slice(0, 40)}" is not valid. Use an account number like 4000, or a range like 4000:4999.`);
  }
  const [lo, hi = lo] = parts;
  if (compareAcct(lo, hi) > 0) throw new ApiError(400, 'BAD_ACCOUNT', `Account range "${s}" is backwards.`);
  return { lo, hi, text: s };
}

/** Account-number order: numeric when both are all digits, otherwise natural text order. */
export function compareAcct(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const d = BigInt(a) - BigInt(b);
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function checkPeriodName(name, periods, what) {
  const s = String(name ?? '').trim();
  if (!periods.some((p) => p.name === s)) throw new ApiError(400, 'UNKNOWN_PERIOD', `${what} "${s.slice(0, 30)}" is not an accounting period.`);
  return s;
}

/**
 * Validates one formula request. Returns a normalised request, or throws ApiError(400) with a message for the cell.
 * Shape in: { fn: 'balance'|'activity', account, period?|date?, from?, to?, filters?: { subsidiary?: ..., ... } }
 */
export function normalizeRequest(raw, periods) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(400, 'BAD_REQUEST', 'Bad formula request.');
  const allowed = new Set(['fn', 'account', 'period', 'date', 'from', 'to', 'filters']);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new ApiError(400, 'UNKNOWN_FIELD', `Unknown field "${String(k).slice(0, 20)}".`);
  const account = parseAccount(raw.account);
  const filters = {};
  if (raw.filters !== undefined && raw.filters !== null) {
    if (typeof raw.filters !== 'object' || Array.isArray(raw.filters)) throw new ApiError(400, 'BAD_FILTERS', 'Bad filters.');
    for (const [k, v] of Object.entries(raw.filters)) {
      if (!FILTERS[k]) throw new ApiError(400, 'UNKNOWN_FILTER', `Unknown filter "${String(k).slice(0, 20)}".`);
      if (v === undefined || v === null || String(v).trim() === '') continue; // blank argument = no filter
      const s = String(v).trim();
      if (s.length > MAX_NAME) throw new ApiError(400, 'BAD_FILTER', `${FILTERS[k].label} value is too long.`);
      filters[k] = s;
    }
  }
  if (raw.fn === 'balance') {
    if (raw.date !== undefined && raw.date !== null && raw.date !== '') {
      const d = String(raw.date).trim();
      if (!isIsoDate(d)) throw new ApiError(400, 'BAD_DATE', `"${d.slice(0, 20)}" is not a valid date.`);
      return { fn: 'balance', basis: 'date', date: d, account, filters };
    }
    return { fn: 'balance', basis: 'period', period: checkPeriodName(raw.period, periods, 'Period'), account, filters };
  }
  if (raw.fn === 'activity') {
    const from = checkPeriodName(raw.from, periods, 'From period');
    const to = checkPeriodName(raw.to ?? raw.from, periods, 'To period');
    const fs = periods.find((p) => p.name === from).start;
    const ts = periods.find((p) => p.name === to).start;
    if (fs > ts) throw new ApiError(400, 'BAD_RANGE', 'The From period must not be after the To period.');
    return { fn: 'activity', basis: 'range', from, to, account, filters };
  }
  throw new ApiError(400, 'BAD_FUNCTION', 'Unknown formula function.');
}

/** Turns filter names into internal IDs using the lookup lists. Throws a cell-level ApiError if a name is unknown/ambiguous. */
export function resolveFilters(filters, lookups) {
  const out = {};
  for (const [k, v] of Object.entries(filters)) {
    if (ID_RE.test(v)) { out[k] = v; continue; }
    const list = lookups[k];
    if (!list) throw new ApiError(400, 'LOOKUP_UNAVAILABLE', `${FILTERS[k].label} names could not be looked up; use the internal ID.`);
    const hits = list.filter((x) => String(x.name).trim().toLowerCase() === v.toLowerCase());
    if (hits.length === 0) throw new ApiError(400, 'UNKNOWN_NAME', `No ${FILTERS[k].label} named "${v.slice(0, 60)}".`);
    if (hits.length > 1) throw new ApiError(400, 'AMBIGUOUS_NAME', `More than one ${FILTERS[k].label} is named "${v.slice(0, 60)}"; use the internal ID.`);
    out[k] = String(hits[0].id);
  }
  return out;
}

// ---------- SQL (built only from validated period names, ISO dates and digit IDs) ----------

function filterSql(ids) {
  const keys = Object.keys(ids).sort();
  if (keys.length === 0) return { join: '', where: '' };
  for (const k of keys) if (!ID_RE.test(ids[k])) throw new Error('filter id must be digits'); // defence in depth
  return { join: TL_JOIN, where: keys.map((k) => ` AND ${FILTERS[k].column} = ${ids[k]}`).join('') };
}

function groupedQueries(from, where, key, num) {
  return {
    totals: `SELECT COUNT(DISTINCT ${key}) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits ${from} WHERE ${where}`,
    rows:
      `SELECT ${num} AS acctnumber, ROUND(SUM(tal.debit), 2) AS debit, ROUND(SUM(tal.credit), 2) AS credit ` +
      `${from} WHERE ${where} GROUP BY ${key}, ${num} ORDER BY ${num}, ${key}`,
  };
}

/** Balance as of a period: the validated Trial Balance structure, plus optional segment filters. */
export function balancePeriodSql(period, ids) {
  const t = tbParts(period);
  const f = filterSql(ids);
  return groupedQueries(t.from + f.join, t.where + f.where, t.key, t.num);
}

/** Balance as of a date: same structure as the TB, on transaction dates; fiscal year = the one containing the date. */
export function balanceDateSql(date, ids) {
  const d = `TO_DATE('${date}', 'YYYY-MM-DD')`;
  const dfy = `(SELECT MAX(y.startdate) AS fystart FROM accountingperiod y WHERE y.isyear = 'T' AND y.startdate <= ${d})`;
  const priorPL = `(a.accttype IN (${PL_TYPES}) AND t.trandate < dfy.fystart)`;
  const f = filterSql(ids);
  const from =
    `${TAL_FROM} INNER JOIN account a ON a.id = tal.account INNER JOIN ${dfy} dfy ON 1 = 1 ` +
    `INNER JOIN (SELECT MAX(id) AS reid FROM account WHERE sspecacct = 'RetEarnings') rx ON 1 = 1 ` +
    `INNER JOIN account rea ON rea.id = rx.reid${f.join}`;
  const where = `${TAL_BASE} AND dfy.fystart IS NOT NULL AND t.trandate <= ${d}${f.where}`;
  return groupedQueries(from, where, `CASE WHEN ${priorPL} THEN rea.id ELSE a.id END`, `CASE WHEN ${priorPL} THEN rea.acctnumber ELSE a.acctnumber END`);
}

/** Net activity over a period range: the validated GL period-range basis, grouped by account. */
export function activitySql(fromPeriod, toPeriod, ids) {
  const f = filterSql(ids);
  const from =
    `${TAL_FROM} INNER JOIN accountingperiod pp ON pp.id = t.postingperiod ` +
    `INNER JOIN ${periodRange(fromPeriod, toPeriod)} rg ON 1 = 1 INNER JOIN account a ON a.id = tal.account${f.join}`;
  const where = `${TAL_BASE} AND pp.startdate >= rg.rstart AND pp.enddate <= rg.rend${f.where}`;
  return groupedQueries(from, where, 'tal.account', 'a.acctnumber');
}

// ---------- running ----------

function groupKey(r, ids) {
  return JSON.stringify([r.fn, r.basis, r.period ?? r.date ?? `${r.from}..${r.to}`, Object.entries(ids).sort()]);
}

async function runGroup(g, provider) {
  const { req, ids } = g;
  const sql = req.basis === 'period' ? balancePeriodSql(req.period, ids) : req.basis === 'date' ? balanceDateSql(req.date, ids) : activitySql(req.from, req.to, ids);
  const params = { fn: req.fn, basis: req.basis, period: req.period ?? '', date: req.date ?? '', from: req.from ?? '', to: req.to ?? '', filters: JSON.stringify(ids) };
  const tq = await provider.query({ report: 'formula', kind: 'totals', params, sql: sql.totals }, 0, 1);
  if (tq.items.length !== 1) throw new ApiError(502, 'NS_TOTALS', 'NetSuite returned an unexpected totals result.');
  const count = Number(tq.items[0].cnt);
  const wantD = parseMoney(tq.items[0].debits);
  const wantC = parseMoney(tq.items[0].credits);
  const rows = [];
  for (let off = 0; off < count; off += 1000) {
    const page = await provider.query({ report: 'formula', kind: 'rows', params, sql: sql.rows }, off, 1000);
    rows.push(...page.items);
  }
  let d = 0n;
  let c = 0n;
  for (const r of rows) { d += parseMoney(r.debit); c += parseMoney(r.credit); }
  if (rows.length !== count || d !== wantD || c !== wantC) {
    throw new ApiError(502, 'RECONCILIATION_FAILED', 'NetSuite data did not reconcile; no value returned.', `rows ${rows.length}/${count} dr ${d}/${wantD} cr ${c}/${wantC}`);
  }
  if (Object.keys(ids).length === 0 && wantD !== wantC) {
    throw new ApiError(502, 'NOT_BALANCED', 'NetSuite totals did not balance; no value returned.', `dr ${wantD} cr ${wantC}`);
  }
  return rows.map((r) => ({ acct: r.acctnumber === null || r.acctnumber === undefined ? '' : String(r.acctnumber), net: parseMoney(r.debit) - parseMoney(r.credit) }));
}

function sumAccounts(accounts, spec) {
  let total = 0n;
  for (const a of accounts) {
    if (a.acct && compareAcct(a.acct, spec.lo) >= 0 && compareAcct(a.acct, spec.hi) <= 0) total += a.net;
  }
  return total;
}

/**
 * Answers a batch. `periods` = monthly periods; `loadLookup(filterKey)` returns [{id, name}] (only called for names).
 * Returns { results: [{ value } | { error }], groups } aligned with the input.
 */
export async function evaluateBatch(rawRequests, { periods, loadLookup, provider, log = () => {} }) {
  const results = new Array(rawRequests.length);
  const normalized = [];
  rawRequests.forEach((raw, i) => {
    try { normalized.push({ i, req: normalizeRequest(raw, periods) }); } catch (e) { results[i] = { error: e instanceof ApiError ? e.message : 'Bad formula request.' }; }
  });

  // Resolve names -> IDs (load each lookup list at most once, only if a name is used).
  const needed = new Set();
  for (const n of normalized) for (const [k, v] of Object.entries(n.req.filters)) if (!ID_RE.test(v)) needed.add(k);
  const lookups = {};
  for (const k of needed) {
    try { lookups[k] = await loadLookup(k); } catch (e) { log(`lookup ${k} failed: ${e instanceof ApiError ? e.detail ?? e.message : String(e)}`); }
  }
  const groups = new Map();
  for (const n of normalized) {
    try {
      const ids = resolveFilters(n.req.filters, lookups);
      const key = groupKey(n.req, ids);
      if (!groups.has(key)) groups.set(key, { req: n.req, ids, members: [] });
      groups.get(key).members.push(n);
    } catch (e) {
      results[n.i] = { error: e instanceof ApiError ? e.message : 'Bad formula request.' };
    }
  }

  const list = [...groups.values()];
  await pool(3, list.map((g) => async () => {
    try {
      const accounts = await runGroup(g, provider);
      for (const m of g.members) results[m.i] = { value: formatMoney(sumAccounts(accounts, m.req.account)) };
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'NetSuite could not answer this formula.';
      log(`formula group failed: ${e instanceof ApiError ? `${e.code}${e.detail ? ': ' + e.detail : ''}` : String(e)}`);
      for (const m of g.members) results[m.i] = { error: msg };
    }
  }));
  return { results, groups: list.length };
}
