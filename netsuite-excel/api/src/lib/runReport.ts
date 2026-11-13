// Runs one report with a hard reconciliation gate: data is returned ONLY if the pulled rows match
// NetSuite's own COUNT/SUM exactly (and NetSuite's totals did not move during the pull).

import { ApiError } from './errors';
import { ReportDef } from './catalog';
import { formatMoney, parseMoney } from './money';
import { PullInfo, QueryProvider, ReportResult } from './types';

export interface RunOptions {
  maxRows: number;
  pageSize?: number; // NetSuite SuiteQL max is 1,000
  concurrency?: number;
  user: string;
  mock: boolean;
  now?: Date;
}

interface Totals {
  count: number;
  sums: Map<string, bigint>;
}

async function fetchTotals(def: ReportDef, params: Record<string, string>, provider: QueryProvider): Promise<Totals> {
  const { totals } = def.build(params);
  const res = await provider.query({ report: def.id, kind: 'totals', params, sql: totals }, 0, 1);
  if (res.items.length !== 1) throw new ApiError(502, 'NS_TOTALS', 'NetSuite returned an unexpected totals result.', `items=${res.items.length}`);
  const row = res.items[0];
  const count = Number(row.cnt);
  if (!Number.isSafeInteger(count) || count < 0) throw new ApiError(502, 'NS_TOTALS', 'NetSuite returned an unexpected row count.');
  const sums = new Map<string, bigint>();
  for (const s of def.sums) sums.set(s.column, parseMoney(row[s.alias]));
  return { count, sums };
}

/** Run tasks with at most `n` in flight; results keep input order; first failure rejects. */
async function pool<T>(n: number, tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return results;
}

/** Today's date (YYYY-MM-DD) in US Eastern. */
export function todayEastern(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function runReport(
  def: ReportDef,
  params: Record<string, string>,
  provider: QueryProvider,
  opts: RunOptions,
): Promise<ReportResult> {
  const pageSize = opts.pageSize ?? 1000;
  const concurrency = opts.concurrency ?? 3;
  const now = opts.now ?? new Date();

  // 1. NetSuite's own totals, and the row cap.
  const before = await fetchTotals(def, params, provider);
  if (before.count > opts.maxRows) {
    throw new ApiError(
      413,
      'TOO_MANY_ROWS',
      `This pull has ${before.count.toLocaleString('en-US')} rows, over the ${opts.maxRows.toLocaleString('en-US')} row limit. Narrow the date range or filter to an account.`,
    );
  }

  // 2. Page through rows (deterministic ORDER BY lives in the catalog).
  const { rows: rowsSql } = def.build(params);
  const pageCount = Math.ceil(before.count / pageSize);
  const pages = await pool(
    concurrency,
    Array.from({ length: pageCount }, (_, i) => async () => {
      const offset = i * pageSize;
      const res = await provider.query({ report: def.id, kind: 'rows', params, sql: rowsSql }, offset, pageSize);
      const expected = Math.min(pageSize, before.count - offset);
      if (res.items.length !== expected) {
        throw new ApiError(502, 'RECONCILIATION_FAILED', 'The data from NetSuite did not match its totals, so nothing was returned. Please try again.', `page ${i}: got ${res.items.length} expected ${expected}`);
      }
      return res.items;
    }),
  );
  const raw = pages.flat();

  // 3. Reconcile: count and every money sum must match exactly.
  if (raw.length !== before.count) {
    throw new ApiError(502, 'RECONCILIATION_FAILED', 'The row count did not match NetSuite, so nothing was returned.', `rows ${raw.length} vs ${before.count}`);
  }
  for (const s of def.sums) {
    const got = raw.reduce((acc, r) => acc + parseMoney(r[s.column]), 0n);
    const want = before.sums.get(s.column) as bigint;
    if (got !== want) {
      throw new ApiError(502, 'RECONCILIATION_FAILED', 'The totals did not match NetSuite, so nothing was returned.', `${s.column}: rows ${got} vs NetSuite ${want}`);
    }
  }

  // 4. Data must not have moved while we were paging.
  const after = await fetchTotals(def, params, provider);
  if (after.count !== before.count || def.sums.some((s) => after.sums.get(s.column) !== before.sums.get(s.column))) {
    throw new ApiError(409, 'DATA_CHANGED', 'NetSuite data changed while the report was running. Please run it again.');
  }

  // 5. Shape rows to columns (money exact, derived columns added).
  const today = todayEastern(now);
  const rows: string[][] = raw.map((r) => {
    const base: Record<string, string> = {};
    for (const c of def.columns) {
      const v = r[c.key];
      if (c.type === 'money') base[c.key] = v === undefined ? '' : formatMoney(parseMoney(v));
      else base[c.key] = v === null || v === undefined ? '' : String(v);
    }
    const full = def.derive ? { ...base, ...def.derive(base, today) } : base;
    return def.columns.map((c) => full[c.key] ?? '');
  });

  const debits = before.sums.get('debit');
  const credits = before.sums.get('credit');
  const info: PullInfo = {
    report: def.id,
    title: def.title,
    params,
    user: opts.user,
    pulledAt: now.toISOString(),
    rowCount: rows.length,
    debits: debits === undefined ? null : formatMoney(debits),
    credits: credits === undefined ? null : formatMoney(credits),
    balanced: debits === undefined || credits === undefined ? null : debits === credits,
    reconciliation: 'PASS',
    validated: def.validated,
    notes: [...(def.validated ? [] : ['UNVALIDATED REPORT: not yet reconciled to NetSuite reports.']), ...def.notes],
    mock: opts.mock,
  };
  return { columns: def.columns, rows, info };
}
