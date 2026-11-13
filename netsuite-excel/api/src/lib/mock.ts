// Fake data for local dev and tests ONLY (NETSUITE_MOCK=true). Deterministic. Balanced debits = credits.

import { formatMoney, parseMoney } from './money';
import { BuiltQuery, QueryProvider } from './types';

interface Line {
  trandate: string;
  trantype: string;
  tranid: string;
  id: number;
  lineno: number;
  acctnumber: string;
  acctname: string;
  accttype: string;
  entityname: string;
  subsidiary: string;
  memo: string;
  debit: bigint;
  credit: bigint;
}

const ACCOUNTS: [string, string, string][] = [
  ['1000', 'Cash', 'Bank'],
  ['1200', 'Accounts Receivable', 'AcctRec'],
  ['2000', 'Accounts Payable', 'AcctPay'],
  ['4000', 'Freight Revenue', 'Income'],
  ['5000', 'Fuel Expense', 'Expense'],
  ['5100', 'Driver Pay', 'Expense'],
];
const TYPES = ['Journal', 'CustInvc', 'VendBill'];
const MICRO = 1_000_000n;

function buildLines(txns: number): Line[] {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const out: Line[] = [];
  for (let i = 1; i <= txns; i++) {
    const day = 1 + (i % 31);
    const date = `2026-10-${String(day).padStart(2, '0')}`;
    const type = TYPES[i % TYPES.length];
    const amt = BigInt(1 + rnd(500_000)) * (MICRO / 100n); // whole cents
    const a = ACCOUNTS[rnd(ACCOUNTS.length)];
    let b = ACCOUNTS[rnd(ACCOUNTS.length)];
    if (b === a) b = ACCOUNTS[(ACCOUNTS.indexOf(a) + 1) % ACCOUNTS.length];
    for (const [lineno, acct, debit, credit] of [
      [1, a, amt, 0n],
      [2, b, 0n, amt],
    ] as [number, [string, string, string], bigint, bigint][]) {
      out.push({
        trandate: date, trantype: type, tranid: `${type === 'Journal' ? 'JE' : type === 'CustInvc' ? 'INV' : 'BILL'}${1000 + i}`,
        id: i, lineno, acctnumber: acct[0], acctname: acct[1], accttype: acct[2],
        entityname: type === 'Journal' ? '' : `Mock Co ${1 + (i % 7)}`, subsidiary: `Mock Sub ${1 + (i % 3)}`,
        memo: `mock line ${i}.${lineno}`, debit, credit,
      });
    }
  }
  return out;
}

const LINES = buildLines(1250); // 2,500 lines -> exercises paging at 1,000/page
const TYPE_AR = ['CustInvc', 'CustCred', 'CustPymt'];

const OPEN_AR = [
  ['Mock Co 1', 'CustInvc', 'INV2001', '2026-07-01', '2026-07-31', 1250.5],
  ['Mock Co 2', 'CustInvc', 'INV2002', '2026-09-15', '2026-10-15', 980],
  ['Mock Co 2', 'CustInvc', 'INV2003', '2026-10-20', '2026-11-19', 4000.25],
  ['Mock Co 3', 'CustPymt', 'PYMT2004', '2026-10-01', '2026-10-01', -300],
] as const;
const OPEN_AP = [
  ['Mock Vendor A', 'VendBill', 'BILL3001', '2026-08-01', '2026-08-31', 760.4],
  ['Mock Vendor B', 'VendBill', 'BILL3002', '2026-10-25', '2026-11-24', 2210],
] as const;

/** Mock only: "Oct 2026" -> "2026-10-31". Ignores fiscal-year / retained-earnings logic (real SQL does that). */
function mockPeriodEnd(period: string): string {
  const d = new Date(`${period} 1 UTC`);
  if (Number.isNaN(d.getTime())) throw new Error('mock: unknown period');
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return end.toISOString().slice(0, 10);
}

const sumOf = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

export class MockProvider implements QueryProvider {
  async query(q: BuiltQuery, offset: number, limit: number) {
    const rows = this.allRows(q);
    if (q.kind === 'totals') return { items: [this.totals(q, rows)], hasMore: false };
    const items = rows.slice(offset, offset + limit);
    return { items, hasMore: offset + limit < rows.length };
  }

  private moneyStr = (n: bigint) => formatMoney(n);

  private totals(q: BuiltQuery, rows: Record<string, unknown>[]): Record<string, unknown> {
    const col = (k: string) => sumOf(rows.map((r) => parseMoney(r[k])));
    if (q.report === 'ar_aging' || q.report === 'ap_aging') {
      return { cnt: String(rows.length), openamount: this.moneyStr(col('openamount')) };
    }
    return { cnt: String(rows.length), debits: this.moneyStr(col('debit')), credits: this.moneyStr(col('credit')) };
  }

  private allRows(q: BuiltQuery): Record<string, unknown>[] {
    const p = q.params;
    const m = this.moneyStr;
    switch (q.report) {
      case 'trial_balance': {
        const byAcct = new Map<string, { l: Line; d: bigint; c: bigint }>();
        for (const l of LINES.filter((x) => x.trandate <= mockPeriodEnd(p.period))) {
          const e = byAcct.get(l.acctnumber) ?? { l, d: 0n, c: 0n };
          e.d += l.debit;
          e.c += l.credit;
          byAcct.set(l.acctnumber, e);
        }
        return [...byAcct.values()]
          .sort((a, b) => a.l.acctnumber.localeCompare(b.l.acctnumber))
          .map((e) => ({ acctnumber: e.l.acctnumber, acctname: e.l.acctname, accttype: e.l.accttype, debit: m(e.d), credit: m(e.c) }));
      }
      case 'journal_entries':
      case 'gl_detail': {
        return LINES.filter(
          (l) =>
            l.trandate >= p.startDate && l.trandate <= p.endDate &&
            (q.report === 'gl_detail' || l.trantype === 'Journal') &&
            (!p.account || l.acctnumber === p.account),
        )
          .sort((a, b) => a.trandate.localeCompare(b.trandate) || a.id - b.id || a.lineno - b.lineno || a.acctnumber.localeCompare(b.acctnumber))
          .map((l) => ({
            trandate: l.trandate, trantype: l.trantype, tranid: l.tranid, acctnumber: l.acctnumber, acctname: l.acctname,
            entityname: l.entityname, subsidiary: l.subsidiary, memo: l.memo, debit: m(l.debit), credit: m(l.credit),
          }));
      }
      case 'ar_aging':
      case 'ap_aging': {
        const src = q.report === 'ar_aging' ? OPEN_AR : OPEN_AP;
        void TYPE_AR;
        return src.map(([entityname, trantype, tranid, trandate, duedate, amt]) => ({
          entityname, trantype, tranid, trandate, duedate, openamount: amt.toFixed(2),
        }));
      }
      default:
        throw new Error(`mock: no data for ${q.report}`);
    }
  }
}
