// Task 3(a): convertIds() in nts_is_cpm_sl.js. Saved definitions hold dimension records as 'x:<external id>' and fixed
// quarters/years as 'q:<start>' / 'y:<start>'; loading turns them back into this account's internal ids.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { read, loadAmd, sliceDecl, mockLog } = require('./helpers');

const SL = read('nts_is_cpm_sl.js');

// ---- the function itself, lifted out of the Suitelet with the two tables it reads ----
const convertIds = vm.runInNewContext(
    sliceDecl(SL, 'const EXT_TABLES = {') + '\n' + sliceDecl(SL, 'const PIVOT_DIMS = {') + '\n' + sliceDecl(SL, 'function convertIds(') + '\nconvertIds;');

// This account: profit center 11 = 'PC-OTR', 12 has no external id; department 7 = 'D-SHOP'; subsidiary 2 = 'SUB-NTS'.
// Quarter 501 starts 2026-07-01, year 900 starts 2026-01-01.
const MAPS = () => ({
    toExt: { subs: { 2: 'SUB-NTS' }, pcs: { 11: 'PC-OTR' }, deps: { 7: 'D-SHOP' }, locs: {}, mods: {}, svcs: {} },
    toId: { subs: { 'SUB-NTS': 2 }, pcs: { 'PC-OTR': 11 }, deps: { 'D-SHOP': 7 }, locs: {}, mods: {}, svcs: {} },
    qById: { 501: '2026-07-01' }, qByStart: { '2026-07-01': 501 },
    yById: { 900: '2026-01-01' }, yByStart: { '2026-01-01': 900 }
});
const clone = x => JSON.parse(JSON.stringify(x));

function sampleDef() {
    return {
        v: 1, kind: 'layout', pub: true,
        cols: [{ t: 'month', o: 0 }, { t: 'quarter', o: 0, fx: 501 }, { t: 'year', o: 0, fx: 900 }],
        layout: {
            lines: [
                { lf: { pcs: [11, 12], deps: [7] }, a: [['6070', 'pcs', 11], ['6080', 'deps', 7], ['6090', null, null]] }
            ],
            pages: [{ n: 'OTR', f: { pcs: [11] } }],
            pivot: { rows: [{ f: 'pc', v: [11, 12] }], cols: [{ f: 'period', v: [{ t: 'quarter', fx: 501 }] }] }
        },
        sched: { view: { filters: { subs: [2], pcs: [11], pcg: [11] } } }
    };
}

test('save then load gives back the same definition', () => {
    const m = MAPS(), getM = () => m;
    const saved = convertIds(sampleDef(), true, getM);
    assert.deepEqual(saved.cols[1], { t: 'quarter', o: 0, fx: 'q:2026-07-01' });
    assert.deepEqual(saved.cols[2], { t: 'year', o: 0, fx: 'y:2026-01-01' });
    assert.deepEqual(saved.layout.lines[0].lf, { pcs: ['x:PC-OTR', 12], deps: ['x:D-SHOP'] });
    assert.deepEqual(saved.layout.lines[0].a, [['6070', 'pcs', 'x:PC-OTR'], ['6080', 'deps', 'x:D-SHOP'], ['6090', null, null]]);
    assert.deepEqual(saved.layout.pages[0].f, { pcs: ['x:PC-OTR'] });
    assert.deepEqual(saved.layout.pivot.rows[0].v, ['x:PC-OTR', 12]);
    assert.deepEqual(saved.layout.pivot.cols[0].v, [{ t: 'quarter', fx: 'q:2026-07-01' }]);
    assert.deepEqual(saved.sched.view.filters, { subs: ['x:SUB-NTS'], pcs: ['x:PC-OTR'], pcg: ['x:PC-OTR'] });
    // through JSON, as it is stored
    const loaded = convertIds(JSON.parse(JSON.stringify(saved)), false, getM);
    assert.deepEqual(loaded, sampleDef());
});

test('a record with no external id keeps its internal id both ways', () => {
    const getM = () => MAPS();
    const saved = convertIds({ layout: { lines: [{ lf: { pcs: [12] } }] } }, true, getM);
    assert.deepEqual(saved.layout.lines[0].lf.pcs, [12]);
    assert.deepEqual(convertIds(saved, false, getM).layout.lines[0].lf.pcs, [12]);
});

test('a record missing in this account is dropped from lists and becomes -1 on an account line', () => {
    const getM = () => MAPS();
    const stored = {
        layout: { lines: [{ lf: { pcs: ['x:PC-GONE', 'x:PC-OTR'] }, a: [['6070', 'pcs', 'x:PC-GONE']] }],
                  pivot: { rows: [{ f: 'pc', v: ['x:PC-GONE'] }] } },
        sched: { view: { filters: { pcs: ['x:PC-GONE'] } } }
    };
    const out = convertIds(stored, false, getM);
    assert.deepEqual(out.layout.lines[0].lf.pcs, [11]);
    assert.deepEqual(out.layout.lines[0].a[0], ['6070', 'pcs', -1]);
    assert.deepEqual(out.layout.pivot.rows[0].v, []);
    // NOTE (reported, not changed): a schedule filtered only to a missing record loads with an EMPTY filter list.
    assert.deepEqual(out.sched.view.filters.pcs, []);
});

test('an old-format definition (plain internal ids) loads as it is and converts on the next save', () => {
    const m = MAPS(), getM = () => m;
    const old = { cols: [{ t: 'quarter', o: 0, fx: 501 }], layout: { lines: [{ lf: { pcs: [11] }, a: [['6070', 'pcs', 11]] }] } };
    const loaded = convertIds(clone(old), false, getM);
    assert.deepEqual(loaded, old);
    const saved = convertIds(loaded, true, getM);
    assert.equal(saved.cols[0].fx, 'q:2026-07-01');
    assert.deepEqual(saved.layout.lines[0].lf.pcs, ['x:PC-OTR']);
    // ids that arrive as digit strings are converted too
    assert.deepEqual(convertIds({ layout: { lines: [{ lf: { pcs: ['11'] } }] } }, true, getM).layout.lines[0].lf.pcs, ['x:PC-OTR']);
});

test('a stale fixed quarter (no such quarter here) loses its fx and falls back to the relative offset', () => {
    const getM = () => MAPS();
    const out = convertIds({ cols: [{ t: 'quarter', o: -1, fx: 'q:2019-01-01' }, { t: 'year', o: 0, fx: 'y:2019-01-01' }] }, false, getM);
    assert.deepEqual(out.cols, [{ t: 'quarter', o: -1 }, { t: 'year', o: 0 }]);
});

test('maps are built only when needed, and junk passes through', () => {
    let built = 0; const getM = () => { built++; return MAPS(); };
    assert.equal(convertIds(null, true, getM), null);
    assert.equal(convertIds('x', false, getM), 'x');
    convertIds({ v: 1, kind: 'is', cols: [{ t: 'month', o: 0 }] }, true, getM);
    assert.equal(built, 0);
});

// ---- end to end through the Suitelet: savereport stores tokens, reports hands back internal ids ----
test('Suitelet savereport/reports round trip with mocked NetSuite', () => {
    const DB = [];                              // rows of customrecord_nts_is_report
    const EXT = { subsidiary: [{ id: 2, externalid: 'SUB-NTS' }], classification: [{ id: 11, externalid: 'PC-OTR' }, { id: 12, externalid: null }],
                  department: [], location: [], customrecord_cseg_appf_mode: [], customrecord_cseg_appf_serv_type: [] };
    const query = { runSuiteQLPaged({ query: sql }) {
        let rows;
        const m = /SELECT id, externalid FROM (\w+)/.exec(sql);
        if (m) rows = EXT[m[1]];
        else if (/FROM customrecord_nts_is_report/.test(sql)) rows = DB.map(r => ({ id: r.id, name: r.name, def: r.def, owner: 5, ownername: 'Tester' }));
        else throw new Error('unexpected SQL in test: ' + sql.slice(0, 80));
        return { pageRanges: [{ index: 0 }], fetch: () => ({ data: { asMappedResults: () => rows } }) };
    } };
    const periods = { isquarter: [{ id: 501, start: '7/1/2026' }], isyear: [{ id: 900, start: '1/1/2026' }] };
    const search = { Sort: { DESC: 'DESC' }, createColumn: o => o, create({ filters }) {
        const list = periods[filters[0][0]] || [];
        return { run: () => ({ each(cb) { list.forEach(p => cb({ id: p.id, getValue: k => k === 'startdate' ? p.start : '' })); } }) };
    } };
    const format = { Type: { DATE: 'date' }, parse: ({ value }) => { const [mo, d, y] = value.split('/').map(Number); return new Date(y, mo - 1, d); } };
    const record = { create: () => { const v = {}; return { setValue: ({ fieldId, value }) => { v[fieldId] = value; },
        save: () => { const id = 100 + DB.length; DB.push({ id, name: v.name, def: v.custrecord_nts_isr_definition }); return id; } }; } };
    const runtime = { getCurrentUser: () => ({ id: 5, role: 1018, roleId: 'customrole_x' }), getCurrentScript: () => ({ id: 'customscript_test_sl', deploymentId: 'customdeploy_test_sl' }) };
    const sl = loadAmd('nts_is_cpm_sl.js', { 'N/query': query, 'N/search': search, 'N/file': {}, 'N/render': {}, 'N/url': {}, 'N/runtime': runtime,
        'N/log': mockLog(), 'N/format': format, 'N/record': record, 'N/email': {}, 'N/task': {} });
    const call = (action, params, method) => {
        let out = '';
        sl.onRequest({ request: { method: method || 'GET', parameters: Object.assign({ action }, params) },
                       response: { setHeader() {}, write: s => { out += s; } } });
        return JSON.parse(out);
    };
    const def = { kind: 'is', pub: false, cols: [{ t: 'month', o: 0 }, { t: 'quarter', o: 0, fx: 501 }] };
    const saved = call('savereport', { name: 'Q test', def: JSON.stringify(def) }, 'POST');
    assert.equal(saved.ok, true, saved.message);
    assert.match(DB[0].def, /"fx":"q:2026-07-01"/);
    const back = call('reports', {}).reports.find(r => r.name === 'Q test');
    assert.deepEqual(back.def.cols, def.cols);

    const sched = { kind: 'schedule', sched: { reportName: 'R', emails: ['a@example.com'], view: { filters: { subs: [2], pcs: [11, 12] } } } };
    assert.equal(call('savereport', { name: 'S test', def: JSON.stringify(sched) }, 'POST').ok, true);
    const stored = JSON.parse(DB[1].def);
    assert.deepEqual(stored.sched.view.filters, { subs: ['x:SUB-NTS'], pcs: ['x:PC-OTR', 12] });
    assert.deepEqual(stored.sched.sl, { script: 'customscript_test_sl', deploy: 'customdeploy_test_sl' });
    const sBack = call('reports', {}).reports.find(r => r.name === 'S test');
    assert.deepEqual(sBack.def.sched.view.filters, { subs: [2], pcs: [11, 12] });
});
