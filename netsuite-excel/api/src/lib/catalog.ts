// The ONLY place SuiteQL is written. Clients send a report id + parameters; SQL is built here
// from validated values. Every row query has a deterministic ORDER BY (paging depends on it).
//
// STATUS: every report is validated:false. See README "Known problems" before trusting numbers.
// Schema names marked (UNVERIFIED) have not been confirmed against the sandbox yet.

import { ApiError } from './errors';
import { formatMoney, parseMoney } from './money';
import { Column, ParamSpec, ReportMeta } from './types';

export interface ReportDef extends ReportMeta {
  build(params: Record<string, string>): { totals: string; rows: string };
  /** Money columns whose row-sum must equal the matching alias in the totals query. */
  sums: { column: string; alias: string }[];
  /** Adds derived columns to a row (all values already strings). `today` is YYYY-MM-DD in US Eastern. */
  derive?(row: Record<string, string>, today: string): Record<string, string>;
}

// ---------- parameter validation ----------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{1,30}$/;
const PERIOD_RE = /^[A-Za-z0-9 .-]{1,30}$/;
const MAX_PARAM_LEN = 64;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function validateParams(def: ReportDef, raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'BAD_PARAMS', 'The report parameters were not in the expected format.');
  }
  const input = raw as Record<string, unknown>;
  const known = new Map(def.params.map((p) => [p.name, p]));
  for (const k of Object.keys(input)) {
    if (!known.has(k)) throw new ApiError(400, 'UNKNOWN_PARAM', `Unknown parameter "${k.slice(0, 40)}" for this report.`);
  }
  const out: Record<string, string> = {};
  for (const spec of def.params) {
    const v = input[spec.name];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (spec.required) throw new ApiError(400, 'MISSING_PARAM', `${spec.label} is required.`);
      continue;
    }
    if (typeof v !== 'string' || v.length > MAX_PARAM_LEN) {
      throw new ApiError(400, 'BAD_PARAM', `${spec.label} is not valid.`);
    }
    const s = v.trim();
    if (spec.type === 'date' && !isIsoDate(s)) {
      throw new ApiError(400, 'BAD_DATE', `${spec.label} must be a real date in YYYY-MM-DD format.`);
    }
    if (spec.name === 'account' && !ACCOUNT_RE.test(s)) {
      throw new ApiError(400, 'BAD_ACCOUNT', 'Account must be an account number (letters, digits, . _ - only).');
    }
    if (spec.name === 'period' && !PERIOD_RE.test(s)) {
      throw new ApiError(400, 'BAD_PERIOD', 'Period must be an accounting period name like "Oct 2026" (letters, digits, spaces, . - only).');
    }
    out[spec.name] = s;
  }
  if (out.startDate && out.endDate && out.endDate < out.startDate) {
    throw new ApiError(400, 'BAD_RANGE', 'End date must be on or after the start date.');
  }
  return out;
}

// ---------- SQL fragments (only ever fed validated values) ----------

const toDate = (iso: string) => `TO_DATE('${iso}', 'YYYY-MM-DD')`;
const TAL_FROM = 'FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction';
const TAL_BASE = `tal.posting = 'T' AND tal.accountingbook = 1`;

const dateParams: ParamSpec[] = [
  { name: 'startDate', label: 'Start date', type: 'date', required: true },
  { name: 'endDate', label: 'End date', type: 'date', required: true },
];

const lineColumns: Column[] = [
  { key: 'trandate', label: 'Date', type: 'date' },
  { key: 'trantype', label: 'Type', type: 'text' },
  { key: 'tranid', label: 'Transaction #', type: 'text' },
  { key: 'acctnumber', label: 'Account #', type: 'text' },
  { key: 'acctname', label: 'Account', type: 'text' },
  { key: 'entityname', label: 'Name', type: 'text' },
  { key: 'subsidiary', label: 'Subsidiary', type: 'text' },
  { key: 'memo', label: 'Memo', type: 'text' },
  { key: 'debit', label: 'Debit', type: 'money' },
  { key: 'credit', label: 'Credit', type: 'money' },
];

function lineQueries(where: string) {
  return {
    totals: `SELECT COUNT(*) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits ${TAL_FROM} WHERE ${where}`,
    rows:
      `SELECT TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, t.type AS trantype, t.tranid AS tranid, ` +
      `a.acctnumber AS acctnumber, BUILTIN.DF(tal.account) AS acctname, BUILTIN.DF(t.entity) AS entityname, ` +
      `BUILTIN.DF(tl.subsidiary) AS subsidiary, tl.memo AS memo, tal.debit AS debit, tal.credit AS credit ` +
      `${TAL_FROM} INNER JOIN account a ON a.id = tal.account ` +
      `LEFT JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline ` +
      `WHERE ${where} ORDER BY t.trandate, t.id, tal.transactionline, tal.account`,
  };
}

const lineSums = [
  { column: 'debit', alias: 'debits' },
  { column: 'credit', alias: 'credits' },
];

// ---------- reports ----------

// Trial Balance by POSTING PERIOD (UNVERIFIED SuiteQL: accountingperiod columns periodname/startdate/enddate/isyear/isquarter).
//  - Balance-sheet accounts: cumulative through the end of the chosen period.
//  - P&L accounts: fiscal year-to-date only (periods from the fiscal-year start through the chosen period).
//  - Prior fiscal years' P&L is rolled into the system retained-earnings account (netted with its own balance),
//    matching NetSuite's Trial Balance report. Rows' sums still equal the totals query exactly.
const PL_TYPES = `'Income', 'COGS', 'Expense', 'OthIncome', 'OthExpense'`;

function tbParts(period: string) {
  // One-row inline view with the period's start/end and its fiscal-year start. MAX() makes it exactly one row
  // (NULLs if the name matches nothing -> empty TB, visible). No subqueries in GROUP BY/ORDER BY (Oracle rejects them).
  const per =
    `(SELECT p.pstart AS pstart, p.pend AS pend, ` +
    `(SELECT MAX(y.startdate) FROM accountingperiod y WHERE y.isyear = 'T' AND y.startdate <= p.pstart) AS fystart ` +
    `FROM (SELECT MAX(tp.startdate) AS pstart, MAX(tp.enddate) AS pend FROM accountingperiod tp ` +
    `WHERE tp.periodname = '${period}' AND tp.isquarter = 'F' AND tp.isyear = 'F') p)`;
  const priorPL = `(a.accttype IN (${PL_TYPES}) AND pp.startdate < per.fystart)`;
  // Prior-year P&L is rolled INTO the system retained-earnings account (sspecacct = 'RetEarnings', verified: 3400),
  // netted with that account's own balance, exactly like NetSuite's Trial Balance report.
  // Names come from account.accountsearchdisplayname (verified); BUILTIN.DF on a derived id errors in SuiteQL.
  const from =
    `FROM transactionaccountingline tal INNER JOIN transaction t ON t.id = tal.transaction ` +
    `INNER JOIN accountingperiod pp ON pp.id = t.postingperiod INNER JOIN account a ON a.id = tal.account ` +
    `INNER JOIN ${per} per ON 1 = 1 ` +
    `INNER JOIN (SELECT MAX(id) AS reid FROM account WHERE sspecacct = 'RetEarnings') rx ON 1 = 1 ` +
    `INNER JOIN account rea ON rea.id = rx.reid`;
  // fystart IS NOT NULL: if no fiscal year is found, return nothing rather than a silently cumulative P&L.
  // The INNER JOIN to rea likewise returns nothing if no retained-earnings account exists.
  const where = `${TAL_BASE} AND per.fystart IS NOT NULL AND pp.enddate <= per.pend`;
  const key = `CASE WHEN ${priorPL} THEN rea.id ELSE a.id END`;
  const num = `CASE WHEN ${priorPL} THEN rea.acctnumber ELSE a.acctnumber END`;
  const name = `CASE WHEN ${priorPL} THEN rea.accountsearchdisplayname ELSE a.accountsearchdisplayname END`;
  const type = `CASE WHEN ${priorPL} THEN rea.accttype ELSE a.accttype END`;
  return { from, where, key, num, name, type };
}

const trialBalance: ReportDef = {
  id: 'trial_balance',
  title: 'Trial Balance',
  validated: false,
  params: [{ name: 'period', label: 'Accounting period (e.g. Oct 2026)', type: 'text', required: true }],
  columns: [
    { key: 'acctnumber', label: 'Account #', type: 'text' },
    { key: 'acctname', label: 'Account', type: 'text' },
    { key: 'accttype', label: 'Type', type: 'text' },
    { key: 'debit', label: 'Debit', type: 'money' },
    { key: 'credit', label: 'Credit', type: 'money' },
    { key: 'balance', label: 'Net (Dr - Cr)', type: 'money' },
  ],
  notes: [
    'By posting period: balance-sheet accounts cumulative; P&L accounts fiscal year-to-date; prior-year P&L rolled into the retained-earnings account, as NetSuite does.',
    'All subsidiaries combined, accounting book 1. The period name must match exactly one monthly posting period.',
    'SuiteQL for accounting periods is UNVERIFIED. Reconcile to the NetSuite Trial Balance report before use.',
  ],
  sums: lineSums,
  build(p) {
    const t = tbParts(p.period);
    return {
      totals:
        `SELECT COUNT(DISTINCT ${t.key}) AS cnt, ROUND(SUM(tal.debit), 2) AS debits, ROUND(SUM(tal.credit), 2) AS credits ` +
        `${t.from} WHERE ${t.where}`,
      rows:
        `SELECT ${t.num} AS acctnumber, ${t.name} AS acctname, ${t.type} AS accttype, ` +
        `ROUND(SUM(tal.debit), 2) AS debit, ROUND(SUM(tal.credit), 2) AS credit ${t.from} WHERE ${t.where} ` +
        `GROUP BY ${t.key}, ${t.num}, ${t.name}, ${t.type} ORDER BY ${t.num}, ${t.key}`,
    };
  },
  derive(row) {
    return { balance: formatMoney(parseMoney(row.debit) - parseMoney(row.credit)) };
  },
};

const journalEntries: ReportDef = {
  id: 'journal_entries',
  title: 'Journal Entries',
  validated: false,
  params: dateParams,
  columns: lineColumns,
  notes: [
    "Posting lines of transactions with type 'Journal' (UNVERIFIED type code), filtered on transaction date.",
    'Not yet compared to a NetSuite saved search.',
  ],
  sums: lineSums,
  build(p) {
    return lineQueries(
      `${TAL_BASE} AND t.type = 'Journal' AND t.trandate >= ${toDate(p.startDate)} AND t.trandate <= ${toDate(p.endDate)}`,
    );
  },
};

const glDetail: ReportDef = {
  id: 'gl_detail',
  title: 'GL Detail',
  validated: false,
  params: [
    ...dateParams,
    { name: 'account', label: 'Account # (optional)', type: 'text', required: false, help: 'Leave blank for all accounts' },
  ],
  columns: lineColumns,
  notes: ['All posting lines, accounting book 1, filtered on transaction date.', 'Not yet reconciled to the Trial Balance.'],
  sums: lineSums,
  build(p) {
    let where = `${TAL_BASE} AND t.trandate >= ${toDate(p.startDate)} AND t.trandate <= ${toDate(p.endDate)}`;
    if (p.account) where += ` AND tal.account IN (SELECT id FROM account WHERE acctnumber = '${p.account}')`;
    return lineQueries(where);
  },
};

// Aging buckets are computed from US Eastern "today". Open-amount fields are UNVERIFIED.
const agingColumns: Column[] = [
  { key: 'entityname', label: 'Name', type: 'text' },
  { key: 'trantype', label: 'Type', type: 'text' },
  { key: 'tranid', label: 'Transaction #', type: 'text' },
  { key: 'trandate', label: 'Date', type: 'date' },
  { key: 'duedate', label: 'Due date', type: 'date' },
  { key: 'dayspastdue', label: 'Days past due', type: 'int' },
  { key: 'openamount', label: 'Open amount', type: 'money' },
  { key: 'current', label: 'Current', type: 'money' },
  { key: 'd1_30', label: '1-30', type: 'money' },
  { key: 'd31_60', label: '31-60', type: 'money' },
  { key: 'd61_90', label: '61-90', type: 'money' },
  { key: 'd90plus', label: '90+', type: 'money' },
];

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function deriveAging(row: Record<string, string>, today: string): Record<string, string> {
  const due = row.duedate || row.trandate;
  const days = Math.max(0, daysBetween(due, today));
  const amt = formatMoney(parseMoney(row.openamount));
  const zero = '0.00';
  const out: Record<string, string> = { dayspastdue: String(days), current: zero, d1_30: zero, d31_60: zero, d61_90: zero, d90plus: zero };
  const bucket = days === 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90plus';
  out[bucket] = amt;
  return out;
}

function agingReport(id: string, title: string, invType: string, otherTypes: string[], what: string): ReportDef {
  const types = [invType, ...otherTypes].map((t) => `'${t}'`).join(', ');
  const amount = `CASE WHEN t.type = '${invType}' THEN t.amountunpaid ELSE 0 - t.paymentamountunused END`;
  const where =
    `t.type IN (${types}) AND t.posting = 'T' AND ((t.type = '${invType}' AND NVL(t.amountunpaid, 0) <> 0) ` +
    `OR (t.type <> '${invType}' AND NVL(t.paymentamountunused, 0) <> 0))`;
  return {
    id,
    title,
    validated: false,
    params: [],
    columns: agingColumns,
    notes: [
      `Open ${what} as of the moment of the pull (current open items only; cannot be run as of a past date).`,
      'Days past due use US Eastern time. No subsidiary filter. Fields amountunpaid / paymentamountunused are UNVERIFIED.',
      'Must be reconciled to the control account before use.',
    ],
    sums: [{ column: 'openamount', alias: 'openamount' }],
    build() {
      return {
        totals: `SELECT COUNT(*) AS cnt, ROUND(SUM(${amount}), 2) AS openamount FROM transaction t WHERE ${where}`,
        rows:
          `SELECT BUILTIN.DF(t.entity) AS entityname, t.type AS trantype, t.tranid AS tranid, ` +
          `TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate, ` +
          `${amount} AS openamount FROM transaction t WHERE ${where} ORDER BY BUILTIN.DF(t.entity), t.duedate, t.id`,
      };
    },
    derive: deriveAging,
  };
}

const arAging = agingReport('ar_aging', 'AR Aging', 'CustInvc', ['CustCred', 'CustPymt'], 'invoices, credit memos and unapplied payments');
const apAging = agingReport('ap_aging', 'AP Aging', 'VendBill', ['VendCred', 'VendPymt'], 'bills, vendor credits and unapplied payments');

const REPORTS: ReportDef[] = [trialBalance, journalEntries, glDetail, arAging, apAging];
const BY_ID = new Map(REPORTS.map((r) => [r.id, r]));

export function getReport(id: unknown): ReportDef {
  const def = typeof id === 'string' ? BY_ID.get(id) : undefined;
  if (!def) throw new ApiError(404, 'UNKNOWN_REPORT', 'That report does not exist.');
  return def;
}

/** Client-safe listing: no SQL, no functions. */
export function listReports(): ReportMeta[] {
  return REPORTS.map(({ id, title, validated, params, columns, notes }) => ({ id, title, validated, params, columns, notes }));
}
