// Excel custom functions =NS.BALANCE(...) and =NS.ACTIVITY(...).
// Runs in the add-in's shared runtime (same page and sign-in as the task pane).
//
// Excel calls a custom function once per cell. Calls that arrive within FLUSH_MS are sent to /api/balances
// as ONE request; the server answers them with one SuiteQL query per (function, period, filters) group.
// A bad cell shows #VALUE! with the reason as its tooltip; it never gets a made-up number.

const FLUSH_MS = 40;
const MAX_BATCH = 1000; // server limit per request
const FILTER_NAMES = ['subsidiary', 'profitCenter', 'department', 'location', 'mode', 'serviceType'];

/** Last request per cell address, for a future "show detail" drill-down. */
export const lastRequestByCell = new Map();

let queue = [];
let timer = null;

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function fail(message, code) {
  const C = globalThis.CustomFunctions;
  return new C.Error(code ?? C.ErrorCode.invalidValue, message);
}

/** Excel date serial (days since 1899-12-30) -> YYYY-MM-DD. */
function serialToIso(n) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return d.toISOString().slice(0, 10);
}

/** "Oct 2026" -> { period }, a date cell / "2026-10-31" / "10/31/2026" -> { date }. */
function periodOrDate(v) {
  if (typeof v === 'number') return { date: serialToIso(v) };
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) return { date: `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}` };
  return { period: s };
}

/** Account cells are often numbers (4000); ranges are text ("4000:4999"). */
function accountText(v) {
  return typeof v === 'number' ? String(Math.trunc(v)) : String(v ?? '').trim();
}

function filtersFrom(values) {
  const out = {};
  values.forEach((v, i) => { if (!blank(v)) out[FILTER_NAMES[i]] = typeof v === 'number' ? String(Math.trunc(v)) : String(v).trim(); });
  return out;
}

function enqueue(request, invocation) {
  if (invocation && invocation.address) lastRequestByCell.set(invocation.address, request);
  return new Promise((resolve, reject) => {
    queue.push({ request, resolve, reject });
    if (queue.length >= MAX_BATCH) { flush(); return; }
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });
}

async function flush() {
  clearTimeout(timer);
  timer = null;
  const batch = queue.splice(0, MAX_BATCH);
  if (queue.length) timer = setTimeout(flush, 0); // more than one batch's worth: send the rest next
  if (batch.length === 0) return;
  const C = globalThis.CustomFunctions;
  let res;
  try {
    res = await fetch('/api/balances', {
      method: 'POST',
      credentials: 'include',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: batch.map((b) => b.request) }),
    });
  } catch {
    batch.forEach((b) => b.reject(fail("Couldn't reach the server. Check your connection, then recalculate.", C.ErrorCode.notAvailable)));
    return;
  }
  if (res.type === 'opaqueredirect' || res.status === 401) {
    batch.forEach((b) => b.reject(fail('Sign in from the NetSuite pane, then recalculate.', C.ErrorCode.notAvailable)));
    return;
  }
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !body || !Array.isArray(body.results)) {
    const msg = (body && body.error && body.error.message) || 'NetSuite formulas are unavailable right now. Please recalculate later.';
    batch.forEach((b) => b.reject(fail(msg, C.ErrorCode.notAvailable)));
    return;
  }
  batch.forEach((b, i) => {
    const r = body.results[i];
    if (r && r.value !== undefined) b.resolve(Number(r.value));
    else b.reject(fail((r && r.error) || 'No value returned.'));
  });
}

/** =NS.BALANCE(account, period_or_date, [subsidiary], [profit_center], [department], [location], [mode], [service_type]) */
async function balance(account, periodDate, subsidiary, profitCenter, department, location, mode, serviceType, invocation) {
  if (blank(account) || blank(periodDate)) throw fail('Account and period (or date) are required.');
  const request = { fn: 'balance', account: accountText(account), ...periodOrDate(periodDate), filters: filtersFrom([subsidiary, profitCenter, department, location, mode, serviceType]) };
  return enqueue(request, invocation);
}

/** =NS.ACTIVITY(account, from_period, [to_period], [subsidiary], [profit_center], [department], [location], [mode], [service_type]) */
async function activity(account, fromPeriod, toPeriod, subsidiary, profitCenter, department, location, mode, serviceType, invocation) {
  if (blank(account) || blank(fromPeriod)) throw fail('Account and from-period are required.');
  const from = String(fromPeriod).trim();
  const request = { fn: 'activity', account: accountText(account), from, to: blank(toPeriod) ? from : String(toPeriod).trim(), filters: filtersFrom([subsidiary, profitCenter, department, location, mode, serviceType]) };
  return enqueue(request, invocation);
}

if (globalThis.CustomFunctions) {
  globalThis.CustomFunctions.associate('BALANCE', balance);
  globalThis.CustomFunctions.associate('ACTIVITY', activity);
}
