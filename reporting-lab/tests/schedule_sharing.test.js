// Who may change a schedule (nts_is_cpm_sl.js): everyone sees every schedule and who made it; its owner or an administrator
// can change or delete it; when the owner ticked Shared, anyone can change (edit, pause) it, but still not delete it.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAmd, mockLog } = require('./helpers');

const OWNER = 5, OTHER = 6, ADMIN = 9;

function suitelet() {
    const DB = [];
    let me = OWNER;
    const query = { runSuiteQLPaged({ query: sql }) {
        let rows;
        if (/SELECT id, externalid FROM/.test(sql)) rows = [];
        else if (/FROM customrecord_nts_is_report/.test(sql)) rows = DB.map(r => ({ id: r.id, name: r.name, def: r.def, owner: r.owner, ownername: 'User ' + r.owner }));
        else throw new Error('unexpected SQL in test: ' + sql.slice(0, 80));
        return { pageRanges: [{ index: 0 }], fetch: () => ({ data: { asMappedResults: () => rows } }) };
    } };
    const search = { Sort: {}, createColumn: o => o, create: () => ({ run: () => ({ each() {} }) }) };
    const record = {
        create: () => { const v = {}; return { setValue: ({ fieldId, value }) => { v[fieldId] = value; },
            save: () => { const id = 100 + DB.length; DB.push({ id, owner: me, name: v.name, def: v.custrecord_nts_isr_definition }); return id; } }; },
        submitFields: ({ id, values }) => { const r = DB.find(x => x.id === id); r.name = values.name; r.def = values.custrecord_nts_isr_definition; return id; },
        delete: ({ id }) => { DB.splice(DB.findIndex(x => x.id === id), 1); }
    };
    const runtime = { getCurrentUser: () => ({ id: me, role: me === ADMIN ? 3 : 1018, roleId: me === ADMIN ? 'administrator' : 'customrole_x' }),
                      getCurrentScript: () => ({ id: 'customscript_sl', deploymentId: 'customdeploy_sl' }) };
    const sl = loadAmd('nts_is_cpm_sl.js', { 'N/query': query, 'N/search': search, 'N/file': {}, 'N/render': {}, 'N/url': {}, 'N/runtime': runtime,
        'N/log': mockLog(), 'N/format': {}, 'N/record': record, 'N/email': {}, 'N/task': {} });
    const call = (as, action, params) => {
        me = as; let out = '';
        sl.onRequest({ request: { method: 'POST', parameters: Object.assign({ action }, params) }, response: { setHeader() {}, write: s => { out += s; } } });
        return JSON.parse(out);
    };
    return { DB, call };
}
const sched = (over) => Object.assign({ reportName: 'Month End', emails: ['a@example.com'], freq: 'weekly', dow: 1 }, over || {});
const save = (h, as, params, s, pub) => h.call(as, 'savereport', Object.assign({ name: 'Schedule · Month End · x' }, params, { def: JSON.stringify({ kind: 'schedule', sched: s, pub }) }));
const row = (h, as, id) => h.call(as, 'reports', {}).reports.find(r => r.id === id);

test('everyone sees every schedule and who made it', () => {
    const h = suitelet();
    const id = save(h, OWNER, {}, sched(), false).id;
    const r = row(h, OTHER, id);
    assert.ok(r, 'visible to another user');
    assert.equal(r.ownerName, 'User 5');
    assert.equal(r.canEdit, false);
    assert.equal(r.canDelete, false);
});

test('a schedule that is not shared: only its owner or an administrator can change it', () => {
    const h = suitelet();
    const id = save(h, OWNER, {}, sched(), false).id;
    const res = save(h, OTHER, { id }, sched({ freq: 'daily' }), false);
    assert.equal(res.ok, false);
    assert.match(res.message, /Only User 5 or an administrator can change/);
    assert.equal(JSON.parse(h.DB[0].def).sched.freq, 'weekly');
    assert.equal(save(h, ADMIN, { id }, sched({ freq: 'daily' }), false).ok, true);
    assert.equal(save(h, OWNER, { id }, sched({ freq: 'monthly' }), false).ok, true);
});

test('a shared schedule: anyone can change it, it stays shared, and its owner stays the owner', () => {
    const h = suitelet();
    const id = save(h, OWNER, {}, sched(), true).id;
    const seen = row(h, OTHER, id);
    assert.equal(seen.canEdit, true);
    assert.equal(seen.canDelete, false);
    assert.equal(seen.def.pub, true);
    const res = save(h, OTHER, { id }, sched({ freq: 'daily', enabled: false }), false);       // tries to untick Shared too
    assert.equal(res.ok, true, res.message);
    const stored = JSON.parse(h.DB[0].def);
    assert.equal(stored.sched.freq, 'daily');
    assert.equal(stored.sched.enabled, false, 'pausing works');
    assert.equal(stored.pub, true, 'someone else cannot make it private');
    assert.equal(h.DB[0].owner, OWNER);
    // the owner can turn sharing off
    assert.equal(save(h, OWNER, { id }, sched(), false).ok, true);
    assert.equal(JSON.parse(h.DB[0].def).pub, false);
    assert.equal(row(h, OTHER, id).canEdit, false);
});

test('a shared schedule cannot be deleted, or turned into another kind of report, by someone else', () => {
    const h = suitelet();
    const id = save(h, OWNER, {}, sched(), true).id;
    const del = h.call(OTHER, 'deletereport', { id });
    assert.equal(del.ok, false);
    assert.match(del.message, /Only User 5 or an administrator can delete/);
    const asIs = h.call(OTHER, 'savereport', { id, name: 'x', def: JSON.stringify({ kind: 'is', cols: [{ t: 'month', o: 0 }], pub: true }) });
    assert.equal(asIs.ok, false);
    assert.match(asIs.message, /can only be saved as a schedule/);
    assert.equal(JSON.parse(h.DB[0].def).kind, 'schedule');
    assert.equal(h.call(OWNER, 'deletereport', { id }).ok, true);
});

test('a shared schedule does not open up layouts or saved reports', () => {
    const h = suitelet();
    const id = h.call(OWNER, 'savereport', { name: 'Mine', def: JSON.stringify({ kind: 'is', cols: [{ t: 'month', o: 0 }], pub: true }) }).id;
    const r = row(h, OTHER, id);
    assert.equal(r.canEdit, false);
    assert.equal(h.call(OTHER, 'savereport', { id, name: 'Mine', def: JSON.stringify({ kind: 'schedule', sched: sched(), pub: true }) }).ok, false);
});

test('recipients are hidden from anyone who cannot change the schedule; they see how many there are', () => {
    const h = suitelet();
    const two = sched({ emails: ['a@example.com', 'b@example.com'] });
    const priv = save(h, OWNER, {}, two, false).id;
    const shared = save(h, OWNER, { name: 'Schedule · other · y' }, two, true).id;
    const other = row(h, OTHER, priv);
    assert.deepEqual([...other.def.sched.emails], []);
    assert.equal(other.def.sched.emailCount, 2);
    assert.equal(other.ownerName, 'User 5', 'who made it is still shown');
    assert.deepEqual([...row(h, OWNER, priv).def.sched.emails], ['a@example.com', 'b@example.com']);
    assert.deepEqual([...row(h, ADMIN, priv).def.sched.emails], ['a@example.com', 'b@example.com']);
    assert.deepEqual([...row(h, OTHER, shared).def.sched.emails], ['a@example.com', 'b@example.com'], 'a shared schedule can be changed, so its recipients show');
    assert.equal(row(h, OTHER, priv).def.sched.emailCount !== undefined && row(h, OWNER, priv).def.sched.emailCount, undefined);
    assert.ok(JSON.parse(h.DB[0].def).sched.emails.length === 2, 'the stored record is untouched');
});
