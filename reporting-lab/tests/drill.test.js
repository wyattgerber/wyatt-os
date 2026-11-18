// Task 3(c): drill-down helpers. tMetric and EXT_URL are lifted out of the page; the link rules (which transaction gets which
// "Open in ..." link) live in the Suitelet's getEntry(), run here through onRequest(action=entry) with mocked NetSuite.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { read, loadAmd, sliceDecl, mockLog } = require('./helpers');

const PAGE = read('nts_is_cpm_page.html');
const deq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

// ---- EXT_URL ----
const EXT_URL = vm.runInNewContext(sliceDecl(PAGE, 'const EXT_URL = ') + '\nEXT_URL;');

test('EXT_URL: each kind opens the right outside page', () => {
    assert.equal(EXT_URL('integrity', '123'), 'https://integrity.nussbaum.com/move/123');
    assert.equal(EXT_URL('tmt', '123'), 'https://tmt.nussbaum.com/AMSApp/Orders/InvoiceDetail.aspx?OrderId=123');
    assert.equal(EXT_URL('tmtpurchase', '123'), 'https://tmt.nussbaum.com/AMSApp/Orders/PurchaseCreate.aspx?OrderId=123');
    assert.equal(EXT_URL('tmtrepair', '123'), 'https://tmt.nussbaum.com/AMSApp/Orders/RepairCreate.aspx?OrderId=123');
    assert.equal(EXT_URL('integrity', 'a b&c'), 'https://integrity.nussbaum.com/move/a%20b%26c', 'the id is URL-encoded');
});

// ---- tMetric ----
function makeTMetric(xcols) {
    const ctx = { xcols };
    const src = [
        PAGE.match(/  const usd = n => .*\n/)[0], PAGE.match(/  const cpm = n => .*\n/)[0], PAGE.match(/  const pct = n => .*\n/)[0],
        'const tXLabels = () => xcols ? xcols.map(String) : [];',
        sliceDecl(PAGE, 'function tMetric('), 'tMetric;'
    ].join('\n');
    return vm.runInNewContext(src, ctx);
}

test('tMetric: CPM row, then one row per extra column, formatted by kind', () => {
    const tMetric = makeTMetric(['% of Revenue', 'Per Working Day', 'Loads']);
    const ms = [
        { kind: 'det', vals: [1000, 2000], cpms: [1.2346, -0.5], xs: [[0.25, 0.5], [50, 100], [12.4, 13.6]], xf: ['pct', 'usd', 'num'] },
        { kind: 'calc', vals: [5, 6], cpms: [0.1, 0.2], xs: [[null, NaN], [null, null], [null, null]], xf: ['pct', 'usd', 'num'] },
        { kind: 'tot', vals: [null, 2000], cpms: [1, 2], xs: [], xf: [] }
    ];
    const out = deqRows(tMetric(ms, {}, 0));
    deq(out.map(r => r[0]), ['CPM', '% of Revenue', 'Per Working Day', 'Loads']);
    deq(out[0][1], [{ t: '$1.235', n: 1.2346, s: 'cpm' }, { t: '', n: null, s: 'cpm' }, { t: '', n: null, s: 'cpm' }],
        'CPM shows on detail and total rows only, and is blank when the amount is missing');
    deq(out[1][1][0], { t: '25.0%', n: 0.25, s: 'pct' });
    deq(out[2][1][0], { t: '$50', n: 50, s: 'amt' });
    deq(out[3][1][0], { t: '12', n: 12.4, s: 'amt' });
    deq(out[1][1][1], { t: '', n: null, s: 'amt' }, 'missing extra value is blank');
    deq(deqRows(tMetric(ms, {}, 1))[0][1][0], { t: '($0.500)', n: -0.5, s: 'cpm' }, 'negative CPM in brackets');
});

test('tMetric: with no extra columns only the CPM row', () => {
    const out = makeTMetric(null)([{ kind: 'ldet', vals: [1], cpms: [2] }], {}, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0][0], 'CPM');
});
function deqRows(x) { return JSON.parse(JSON.stringify(x)); }

// ---- link rules through the Suitelet ----
function entryFor(tx) {
    const query = { runSuiteQLPaged({ query: sql }) {
        let rows;
        if (/SELECT t\.tranid AS num/.test(sql)) rows = [{ num: 'X1', ttype: tx.type, tdate: '1/1/2026', memo: '' }];
        else if (/FROM transactionaccountingline/.test(sql)) rows = [];
        else if (/custbody_url_reference_id/.test(sql)) { if (tx.noFields) throw new Error('Field not found'); rows = [{ oid: tx.oid, ttype: tx.type, itype: tx.itype }]; }
        else if (/SELECT t\.type AS ttype/.test(sql)) rows = [{ ttype: tx.type }];
        else throw new Error('unexpected SQL: ' + sql.slice(0, 60));
        return { pageRanges: [{ index: 0 }], fetch: () => ({ data: { asMappedResults: () => rows } }) };
    } };
    const resolved = [];
    const url = { resolveScript: o => { resolved.push(o); return 'https://ext/vendorlookup?script=' + o.scriptId + '&deploy=' + o.deploymentId + '&b=' + o.params.b; } };
    const sl = loadAmd('nts_is_cpm_sl.js', { 'N/query': query, 'N/search': {}, 'N/file': {}, 'N/render': {}, 'N/url': url, 'N/runtime': {},
        'N/log': mockLog(), 'N/format': {}, 'N/record': {}, 'N/email': {}, 'N/task': {} });
    let out = '';
    sl.onRequest({ request: { method: 'GET', parameters: { action: 'entry', id: '55' } }, response: { setHeader() {}, write: s => { out += s; } } });
    const j = JSON.parse(out);
    assert.equal(j.ok, true, j.message);
    return { ext: j.ext, orderId: j.orderId, lookup: j.lookup, resolved };
}

const CASES = [
    // [what, transaction, expected ext, expected order id]
    ['AR Sales invoice -> Integrity', { type: 'CustInvc', oid: '881', itype: 'Sales' }, 'integrity', '881'],
    ['AR Service/Repairs invoice -> TMT invoice page', { type: 'CustInvc', oid: '881', itype: 'Service/Repairs' }, 'tmt', '881'],
    ['AR "Service / Repair" spelling also -> TMT', { type: 'CustInvc', oid: '881', itype: 'service / repair' }, 'tmt', '881'],
    ['AR invoice with blank type -> no link', { type: 'CustInvc', oid: '881', itype: '' }, '', ''],
    ['AR invoice of another type -> no link', { type: 'CustInvc', oid: '881', itype: 'Fuel' }, '', ''],
    ['AP bill -> TMT purchase page', { type: 'VendBill', oid: '77', itype: '' }, 'tmtpurchase', '77'],
    ['Journal -> TMT repair page', { type: 'Journal', oid: '66', itype: 'Sales' }, 'tmtrepair', '66'],
    ['Other transaction type -> no link', { type: 'CustPymt', oid: '55', itype: 'Sales' }, '', ''],
    ['Order id that is not a number -> no link', { type: 'CustInvc', oid: 'ABC', itype: 'Sales' }, '', ''],
    ['No order id -> no link', { type: 'VendBill', oid: null, itype: '' }, '', ''],
    ['Account without the body fields -> entry still loads, no link', { type: 'CustInvc', noFields: true }, '', '']
];
for (const [what, tx, ext, oid] of CASES) {
    test('link rule: ' + what, () => {
        const r = entryFor(tx);
        assert.equal(r.ext, ext);
        assert.equal(r.orderId, oid);
    });
}

test('AP bills, and only AP bills, get "Open in Vendor Lookup" (by text Script ID and Deployment ID, external URL)', () => {
    const bill = entryFor({ type: 'VendBill', oid: null });
    assert.equal(bill.lookup, 'https://ext/vendorlookup?script=customscript_vendor_invoice_lookup&deploy=customdeploy_vendor_invoice_lookup&b=55');
    deq(bill.resolved[0], { scriptId: 'customscript_vendor_invoice_lookup', deploymentId: 'customdeploy_vendor_invoice_lookup', returnExternalUrl: true, params: { b: 55 } });
    for (const type of ['CustInvc', 'Journal', 'CustPymt']) assert.equal(entryFor({ type, oid: '1', itype: 'Sales' }).lookup, '', type);
});

test('page: the TMT/Integrity link label and the Vendor Lookup link are drawn from ext / lookup', () => {
    assert.match(PAGE, /e\.orderId \? '<a href="'\+EXT_URL\(e\.ext, e\.orderId\)\+'"[^]*?Open in '\+\(e\.ext==='integrity' \? 'Integrity' : 'TMT'\)/);
    assert.match(PAGE, /e\.lookup \? '<a href="'\+esc\(e\.lookup\)\+'"[^]*?Open in Vendor Lookup/);
});
