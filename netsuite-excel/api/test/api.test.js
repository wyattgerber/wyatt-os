import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { getReport, listReports, validateParams } from '../src/lib/catalog.js';
import { formatMoney, parseMoney } from '../src/lib/money.js';
import { principalFromHeader } from '../src/lib/auth.js';
import { MockProvider } from '../src/lib/mock.js';
import { runReport } from '../src/lib/runReport.js';
import { meService, periodsService, reportsService, runService } from '../src/lib/service.js';
import { buildClientAssertion } from '../src/lib/netsuite.js';

const principal = (email) => Buffer.from(JSON.stringify({ userDetails: email, userRoles: ['authenticated'] })).toString('base64');
const ENV = { NETSUITE_MOCK: 'true', ALLOWED_USERS: 'ann@example.com, bob@example.com' };
const OCT = { fromPeriod: 'Oct 2026', toPeriod: 'Oct 2026' };

test('money: exact BigInt parse/format, no float drift, fails closed', () => {
  assert.equal(parseMoney('0.10') + parseMoney('0.20'), parseMoney('0.30')); // floats would fail this
  assert.equal(formatMoney(parseMoney('42216073.43')), '42216073.43');
  assert.equal(formatMoney(parseMoney(-5)), '-5.00');
  assert.equal(formatMoney(parseMoney(null)), '0.00');
  assert.equal(formatMoney(parseMoney('1.1234')), '1.1234');
  assert.throws(() => parseMoney('1.1234567')); // >6 decimals
  assert.throws(() => parseMoney('12abc'));
  // NetSuite has returned scientific notation; it must parse exactly, and still fail closed on lost precision.
  assert.equal(formatMoney(parseMoney('3.572068025E7')), '35720680.25');
  assert.equal(formatMoney(parseMoney('4.221607343e+7')), '42216073.43');
  assert.equal(formatMoney(parseMoney(1e21)), '1000000000000000000000.00');
  assert.equal(formatMoney(parseMoney('-1.5E2')), '-150.00');
  assert.throws(() => parseMoney('1E-7'));
});

test('params: unknown, malformed and injected values are rejected', () => {
  const gl = getReport('gl_detail');
  assert.throws(() => validateParams(gl, { ...OCT, sql: 'DROP' }), /Unknown parameter/);
  assert.throws(() => validateParams(gl, { fromPeriod: "Oct 2026'--", toPeriod: 'Oct 2026' }), /Period must be/);
  assert.throws(() => validateParams(gl, { fromPeriod: 'Oct 2026', toPeriod: "x') OR ('1'='1" }), /Period must be/);
  assert.throws(() => validateParams(gl, { ...OCT, startDate: '2026-10-01' }), /Unknown parameter/); // old date params are gone
  assert.throws(() => validateParams(gl, { ...OCT, account: "1000' OR '1'='1" }), /Account must be/);
  assert.throws(() => validateParams(gl, { fromPeriod: 'Oct 2026' }), /required/);
  assert.deepEqual(validateParams(gl, { ...OCT, account: ' 1000 ' }), { ...OCT, account: '1000' });
});

test('catalog: every row query has ORDER BY; SQL is built only from validated values', () => {
  const samples = {
    trial_balance: { period: 'Oct 2026' },
    journal_entries: OCT,
    gl_detail: { ...OCT, account: '1000' },
    ar_aging: {},
    ap_aging: {},
  };
  for (const r of listReports()) {
    const { rows, totals } = getReport(r.id).build(validateParams(getReport(r.id), samples[r.id]));
    assert.match(rows, /ORDER BY/, `${r.id} rows need ORDER BY`);
    assert.doesNotMatch(totals + rows, /;|--/, `${r.id} has no statement separators`);
    assert.equal(r.validated, true, `${r.id} validated flag`); // all five reconciled to NetSuite on 2026-11-13 (sandbox)
  }
  assert.equal(listReports().length, 5);
  assert.ok(!JSON.stringify(listReports()).includes('SELECT'), 'client listing must not leak SQL');
});

test('auth: identity only from a valid principal header', () => {
  assert.throws(() => principalFromHeader(null), /sign in/);
  assert.throws(() => principalFromHeader('not-base64-json'), /sign in/);
  assert.equal(principalFromHeader(principal('Ann@Example.com')).email, 'ann@example.com');
});

test('/api/me and /api/reports: allowlist enforced server-side', async () => {
  assert.equal((await meService(null, { env: ENV })).status, 401);
  const ok = await meService(principal('ann@example.com'), { env: ENV });
  assert.deepEqual(ok.body, { email: 'ann@example.com', allowed: true, role: 'reader', mock: true });
  const no = await meService(principal('eve@example.com'), { env: ENV });
  assert.deepEqual(no.body, { email: 'eve@example.com', allowed: false, role: 'none', mock: true });
  assert.equal((await reportsService(principal('eve@example.com'), { env: ENV })).status, 403);
  assert.equal((await reportsService(principal('bob@example.com'), { env: ENV })).status, 200);
});

test('run: mock GL pull pages 3x, reconciles, is balanced, and writes an AUDIT line', async () => {
  const logs = [];
  const r = await runService(principal('ann@example.com'), JSON.stringify({ report: 'gl_detail', params: OCT }), { env: ENV, log: (m) => logs.push(m) });
  assert.equal(r.status, 200);
  const body = r.body;
  assert.equal(body.rows.length, 2500); // > 1,000 so it exercised multiple pages
  assert.equal(body.info.rowCount, 2500);
  assert.equal(body.info.balanced, true);
  assert.equal(body.info.reconciliation, 'PASS');
  assert.equal(body.info.mock, true);
  assert.equal(body.info.user, 'ann@example.com');
  assert.equal(logs.filter((l) => l.startsWith('AUDIT ')).length, 1);
  assert.match(logs[0], /"status":"ok"/);
});

test('run: request body cannot carry SQL, extra fields, or identity', async () => {
  const send = (b) => runService(principal('ann@example.com'), JSON.stringify(b), { env: ENV });
  assert.equal((await send({ report: 'gl_detail', params: OCT, sql: 'SELECT 1' })).status, 400);
  assert.equal((await send({ report: 'gl_detail', params: OCT, user: 'bob@example.com' })).status, 400);
  assert.equal((await send({ report: 'nope', params: {} })).status, 404);
  assert.equal((await runService(principal('eve@example.com'), '{}', { env: ENV })).status, 403);
  assert.equal((await runService(null, '{}', { env: ENV })).status, 401);
});

test('run: row cap is enforced before paging', async () => {
  const r = await runService(principal('ann@example.com'), JSON.stringify({ report: 'gl_detail', params: OCT }), {
    env: { ...ENV, NETSUITE_MAX_ROWS: '100' },
  });
  assert.equal(r.status, 413);
  assert.equal((r.body).error.code, 'TOO_MANY_ROWS');
});

class Tampered {
  inner = new MockProvider();
  totalsCalls = 0;
  constructor(mode) {
    this.mode = mode;
  }
  async query(q, offset, limit) {
    const res = await this.inner.query(q, offset, limit);
    if (q.kind === 'totals') {
      if (this.mode === 'totals-move' && ++this.totalsCalls === 2) res.items[0] = { ...res.items[0], cnt: String(Number(res.items[0].cnt) + 1) };
      return res;
    }
    if (offset === 1000 && this.mode === 'drop-row') res.items.pop();
    if (offset === 1000 && this.mode === 'change-amount') res.items[0] = { ...res.items[0], debit: '999999.99' };
    return res;
  }
}

test('reconciliation gate: a dropped row, a changed amount, or moving totals all refuse to return data', async () => {
  const def = getReport('gl_detail');
  for (const [mode, code] of [['drop-row', 'RECONCILIATION_FAILED'], ['change-amount', 'RECONCILIATION_FAILED'], ['totals-move', 'DATA_CHANGED']]) {
    await assert.rejects(
      runReport(def, OCT, new Tampered(mode), { maxRows: 20000, user: 'ann@example.com', mock: true }),
      (e) => e.code === code,
      mode,
    );
  }
});

test('AR aging: buckets use US Eastern today and always sum to the open amount', async () => {
  // 2026-11-13 03:00 UTC is still 2026-11-12 in New York.
  const res = await runReport(getReport('ar_aging'), {}, new MockProvider(), { maxRows: 100, user: 'x', mock: true, now: new Date('2026-11-13T03:00:00Z') });
  const idx = (k) => res.columns.findIndex((c) => c.key === k);
  const inv2001 = res.rows.find((r) => r[idx('tranid')] === 'INV2001');
  assert.equal(inv2001[idx('dayspastdue')], '104'); // due 2026-07-31 -> 2026-11-12
  assert.equal(inv2001[idx('d90plus')], '1250.50');
  assert.equal(inv2001[idx('current')], '0.00');
  const total = res.rows.reduce((a, r) => a + parseMoney(r[idx('openamount')]), 0n);
  const buckets = res.rows.reduce((a, r) => a + ['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus'].reduce((s, k) => s + parseMoney(r[idx(k)]), 0n), 0n);
  assert.equal(total, buckets);
});

test('NetSuite JWT: ES256 header/claims correct and signature verifies (P1363)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const jwt = buildClientAssertion({ accountId: '3816459_SB1', clientId: 'cid', certificateId: 'kid1', privateKeyPem: pem }, 1_800_000_000);
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(header, { alg: 'ES256', typ: 'JWT', kid: 'kid1' });
  assert.equal(claims.iss, 'cid');
  assert.deepEqual(claims.scope, ['rest_webservices']);
  assert.equal(claims.aud, 'https://3816459-sb1.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token');
  assert.ok(claims.exp - claims.iat <= 3600);
  assert.equal(Buffer.from(s, 'base64url').length, 64);
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('config: mock is refused on Azure; real mode without NetSuite settings fails closed', async () => {
  const onAzure = await meService(principal('ann@example.com'), { env: { ...ENV, WEBSITE_INSTANCE_ID: 'abc' } });
  assert.equal(onAzure.status, 500);
  const unconfigured = await runService(principal('ann@example.com'), JSON.stringify({ report: 'ar_aging' }), {
    env: { ALLOWED_USERS: 'ann@example.com' },
  });
  assert.equal(unconfigured.status, 503);
});

test('trial balance: by posting period, FYTD P&L, prior-year P&L into the RE account, no injection', async () => {
  const tb = getReport('trial_balance');
  assert.throws(() => validateParams(tb, { period: "Oct 2026' OR '1'='1" }), /Period must be/);
  assert.throws(() => validateParams(tb, {}), /required/);
  const { totals, rows } = tb.build(validateParams(tb, { period: 'Oct 2026' }));
  for (const sql of [totals, rows]) {
    assert.match(sql, /accountingperiod/);
    assert.match(sql, /periodname = 'Oct 2026'/);
    assert.match(sql, /sspecacct = 'RetEarnings'/); // prior-year P&L rolls into the real RE account
  }
  assert.match(rows, /GROUP BY/);
  const groupBy = rows.slice(rows.indexOf('GROUP BY'));
  assert.doesNotMatch(groupBy, /SELECT/, 'no subqueries in GROUP BY/ORDER BY (Oracle rejects them)');
  assert.doesNotMatch(rows, /BUILTIN\.DF/, 'BUILTIN.DF on a derived id fails in SuiteQL');
  const r = await runService(principal('ann@example.com'), JSON.stringify({ report: 'trial_balance', params: { period: 'Oct 2026' } }), { env: ENV });
  assert.equal(r.status, 200);
  const body = r.body;
  assert.equal(body.info.balanced, true); // every transaction balances, so a cumulative TB must too
});

test('NetSuite omits null columns: missing debit/credit read as 0.00 and still reconcile', async () => {
  class OmitsZeros {
    inner = new MockProvider();
    async query(q, offset, limit) {
      const res = await this.inner.query(q, offset, limit);
      if (q.kind === 'rows') {
        for (const it of res.items) for (const k of ['debit', 'credit']) if (it[k] === '0.00') delete it[k]; // like NetSuite's null omission
      }
      return res;
    }
  }
  const res = await runReport(getReport('gl_detail'), OCT, new OmitsZeros(), { maxRows: 20000, user: 'ann@example.com', mock: true });
  const di = res.columns.findIndex((c) => c.key === 'debit');
  const ci = res.columns.findIndex((c) => c.key === 'credit');
  assert.ok(res.rows.every((r) => r[di] !== '' && r[ci] !== ''), 'no blank money cells');
  assert.ok(res.rows.some((r) => r[di] === '0.00') && res.rows.some((r) => r[ci] === '0.00'));
  assert.equal(res.info.reconciliation, 'PASS');
});

test('GL / JE: filter on posting period range (same basis as the TB), period column first, no subqueries in ORDER BY', () => {
  for (const id of ['gl_detail', 'journal_entries']) {
    const def = getReport(id);
    assert.equal(def.columns[0].key, 'postingperiod');
    const { totals, rows } = def.build(validateParams(def, { fromPeriod: 'Sep 2026', toPeriod: 'Oct 2026' }));
    for (const sql of [totals, rows]) {
      assert.match(sql, /pp\.startdate >= rg\.rstart AND pp\.enddate <= rg\.rend/);
      assert.match(sql, /periodname = 'Sep 2026'/);
      assert.match(sql, /periodname = 'Oct 2026'/);
      assert.doesNotMatch(sql, /trandate >=|trandate <=/, 'no transaction-date filter any more');
    }
    assert.doesNotMatch(rows.slice(rows.indexOf('ORDER BY')), /SELECT/);
  }
});

// The PowerShell test scripts carry a copy of the SQL (they cannot import TypeScript). Evaluate the
// simple string assignments between BEGIN-SQL/END-SQL in scripts/NsCommon.ps1 and require an exact match.
test('scripts/NsCommon.ps1 SQL copies are identical to catalog.js', () => {
  const src = readFileSync(new URL('../../scripts/NsCommon.ps1', import.meta.url), 'utf8');
  const evalBlock = (tag, vars) => {
    let blk = src.slice(src.indexOf(`# BEGIN-SQL ${tag}`) + `# BEGIN-SQL ${tag}`.length, src.indexOf(`# END-SQL ${tag}`));
    blk = blk.replace(/"\s*\+\s*\n\s*"/g, '').replace(/'\s*\+\s*\n\s*'/g, '');
    for (const line of blk.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = /^\$(\w+)\s*=\s*(.*)$/.exec(line);
      assert.ok(m, `unexpected line in ${tag} block: ${line}`);
      let out = '';
      for (const p of m[2].matchAll(/'((?:[^']|'')*)'|"([^"]*)"|\$(\w+)/g)) {
        if (p[3] !== undefined) out += vars[p[3]];
        else if (p[1] !== undefined) out += p[1].replace(/''/g, "'");
        else out += p[2].replace(/\$(\w+)/g, (_, v) => vars[v]);
      }
      vars[m[1]] = out;
    }
    return vars;
  };
  const line = evalBlock('line', { From: 'Sep 2026', To: 'Oct 2026', ExtraWhere: '' });
  const gl = getReport('gl_detail').build({ fromPeriod: 'Sep 2026', toPeriod: 'Oct 2026' });
  assert.equal(line.totalsSql, gl.totals);
  assert.equal(line.rowsSql, gl.rows);
  const acct = evalBlock('glacct', { Account: '1040' });
  const lineA = evalBlock('line', { From: 'Oct 2026', To: 'Oct 2026', ExtraWhere: acct.extra });
  const glA = getReport('gl_detail').build({ fromPeriod: 'Oct 2026', toPeriod: 'Oct 2026', account: '1040' });
  assert.equal(lineA.totalsSql, glA.totals);
  assert.equal(lineA.rowsSql, glA.rows);
  const je = evalBlock('je', {});
  const lineJ = evalBlock('line', { From: 'Oct 2026', To: 'Oct 2026', ExtraWhere: je.extra });
  const jeTs = getReport('journal_entries').build({ fromPeriod: 'Oct 2026', toPeriod: 'Oct 2026' });
  assert.equal(lineJ.totalsSql, jeTs.totals);
  assert.equal(lineJ.rowsSql, jeTs.rows);
  for (const [id, vars] of [
    ['ar_aging', { kindName: 'AcctRec', docType: 'CustInvc', credits: "'CustCred', 'CustPymt'", noName: '- No Customer -', lineAmt: '(NVL(tal.debit, 0) - NVL(tal.credit, 0))' }],
    ['ap_aging', { kindName: 'AcctPay', docType: 'VendBill', credits: "'VendCred', 'VendPymt'", noName: '- No Vendor -', lineAmt: '(NVL(tal.credit, 0) - NVL(tal.debit, 0))' }],
  ]) {
    const ag = evalBlock('aging', { ...vars });
    const agTs = getReport(id).build({});
    assert.equal(ag.totalsSql, agTs.totals, `${id} totals`);
    assert.equal(ag.rowsSql, agTs.rows, `${id} rows`);
  }
  const tbv = evalBlock('tb', { Period: 'Oct 2026' });
  const tb = getReport('trial_balance').build({ period: 'Oct 2026' });
  assert.equal(tbv.totalsSql, tb.totals);
  assert.equal(tbv.rowsSql, tb.rows);
});

test('aging: verified fields only, journals at full amount, named "no customer/vendor", ties to control account', async () => {
  for (const [id, kind, noName] of [['ar_aging', 'AcctRec', '- No Customer -'], ['ap_aging', 'AcctPay', '- No Vendor -']]) {
    const { totals, rows } = getReport(id).build({});
    for (const sql of [totals, rows]) {
      assert.doesNotMatch(sql, /[^n]amountunpaid|[^n]paymentamountunused|amountremaining/, 'only foreign* fields exist (amountunpaid etc. return HTTP 500)');
      assert.match(sql, new RegExp(`a\\.accttype = '${kind}'`));
    }
    assert.match(totals, /AS control/);
    assert.match(rows, new RegExp(noName));
  }
  // The control-account tie fails closed.
  class Untied {
    inner = new MockProvider();
    async query(q, offset, limit) {
      const res = await this.inner.query(q, offset, limit);
      if (q.kind === 'totals') res.items[0] = { ...res.items[0], control: '1.00' };
      return res;
    }
  }
  await assert.rejects(
    runReport(getReport('ar_aging'), {}, new Untied(), { maxRows: 100, user: 'x', mock: true }),
    (e) => e.code === 'RECONCILIATION_FAILED' && /control account/.test(e.message ?? ''),
  );
});

test('periods: /api/periods lists real periods; runs reject unknown names and reversed ranges', async () => {
  const r = await periodsService(principal('ann@example.com'), { env: ENV });
  assert.equal(r.status, 200);
  const names = (r.body).periods.map((p) => p.name);
  assert.ok(names.includes('Oct 2026') && names.includes('Jan 2026'));
  assert.equal((await periodsService(principal('eve@example.com'), { env: ENV })).status, 403);
  const run = (params) =>
    runService(principal('ann@example.com'), JSON.stringify({ report: 'gl_detail', params }), { env: ENV });
  const typo = await run({ fromPeriod: 'Okt 2026', toPeriod: 'Oct 2026' });
  assert.equal(typo.status, 400);
  assert.equal((typo.body).error.code, 'UNKNOWN_PERIOD');
  const reversed = await run({ fromPeriod: 'Oct 2026', toPeriod: 'Sep 2026' });
  assert.equal((reversed.body).error.code, 'BAD_RANGE');
  assert.equal((await run({ fromPeriod: 'Sep 2026', toPeriod: 'Oct 2026' })).status, 200);
});
