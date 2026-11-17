// Task 3(b): nts_is_cpm_sched.js with a mocked engine and mocked N/* modules.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAmd, mockLog } = require('./helpers');
// the script runs in its own vm context, so its arrays are compared by value as JSON
const deq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

const SCHED_ID = 42;
function scheduleDef(over) {
    return { v: 1, kind: 'schedule', sched: Object.assign({
        reportName: 'Month End', emails: ['a@example.com', 'b@example.com'], freq: 'daily', time: '00:00', attach: 'pdf',
        subject: '', message: '', enabled: true, lastSent: '', view: { graph: false },
        sl: { script: 'customscript_saved_sl', deploy: 'customdeploy_saved_sl' } }, over || {}) };
}

// engine: { rows: what dataRows() returns, bs: isBS(), files: what an export "downloads" }
function setup({ def = scheduleDef(), params = {}, engine = {} } = {}) {
    const sent = [], submitted = [], calls = [], log = mockLog();
    const rows = [{ id: SCHED_ID, name: 'My schedule', def: JSON.stringify(def) }];
    const search = { create: ({ filters }) => ({ run: () => ({ each(cb) {
        const only = filters.find(f => Array.isArray(f) && f[0] === 'internalid');
        rows.filter(r => !only || r.id === only[2]).forEach(r => cb({ id: String(r.id), getValue: k => k === 'name' ? r.name : r.def }));
    } }) }) };
    const createEngine = host => {
        const api = {
            init: () => calls.push('init'),
            applySchedule: id => calls.push('applySchedule:' + id),
            isBS: () => !!engine.bs, isLayout: () => false,
            dataRows: () => (engine.rows === undefined ? 5 : engine.rows),
            exportPdf: () => { calls.push('exportPdf'); host.download({ toBytes: () => [1, 2, 3] }, 'Report.pdf'); },
            exportXlsx: () => { calls.push('exportXlsx'); host.download({ toBytes: () => [4, 5] }, 'Report.xlsx'); }
        };
        if (engine.loadError) api.applySchedule = () => host.status(engine.loadError, true);
        return { api, drain() {}, bytesToB64: () => 'AAAA' };
    };
    const P = Object.assign({ custscript_nts_sched_author: '7' }, params);
    const mocks = {
        'N/search': search,
        'N/record': { submitFields: o => submitted.push(o), load: () => { throw new Error('not expected'); } },
        'N/email': { send: o => sent.push(o) },
        'N/url': { HostType: { APPLICATION: 'app' }, resolveDomain: () => 'acct.app.netsuite.com',
                   resolveScript: o => '/app/site/hosting/scriptlet.nl?script=' + o.scriptId + '&deploy=' + o.deploymentId + '&sid=' + o.params.sid },
        'N/runtime': { getCurrentScript: () => ({ deploymentId: 'customdeploy_nts_is_cpm_sched', getParameter: ({ name }) => P[name] || null }) },
        'N/format': { Type: { DATE: 'date', TIMEOFDAY: 'time' },
                      format: ({ value, type }) => (type === 'time' ? '11:59 pm' : value), parse: ({ value }) => value },
        'N/log': log, 'N/https': {},
        'N/file': { Type: { PDF: 'PDF', EXCEL: 'EXCEL' }, create: o => o },
        './nts_is_cpm_engine': createEngine
    };
    const sched = loadAmd('nts_is_cpm_sched.js', mocks);
    return { run: () => sched.execute(), sent, submitted, calls, log };
}

test('a normal send attaches the PDF, emails every recipient and records the day', () => {
    const t = setup(); t.run();
    assert.equal(t.sent.length, 1);
    const m = t.sent[0];
    deq(m.recipients, ['a@example.com', 'b@example.com']);
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].fileType, 'PDF');
    assert.doesNotMatch(m.body, /Open Month End/);           // attachment present, no graph: no link
    assert.equal(t.submitted.length, 1);
    assert.match(JSON.parse(t.submitted[0].values.custrecord_nts_isr_definition).sched.lastSent, /^\d{4}-\d{2}-\d{2}$/);
    deq(t.calls.slice(0, 2), ['init', 'applySchedule:' + SCHED_ID]);
});

test('empty report: dataRows() === 0 stops the ATTACHMENT; the email still goes with a link and a note', () => {
    const t = setup({ engine: { rows: 0 } }); t.run();
    assert.ok(!t.calls.includes('exportPdf'), 'no export is attempted');
    assert.equal(t.sent.length, 1, 'the email itself is still sent, with the link and note (decided 2026-11-17)');
    assert.equal(t.sent[0].attachments, undefined);
    assert.match(t.sent[0].body, /came back empty/);
    assert.match(t.sent[0].body, /<a href="https:\/\/acct\.app\.netsuite\.com\/app\/site\/hosting\/scriptlet\.nl\?script=customscript_saved_sl/);
    assert.equal(t.submitted.length, 1, 'and the day is recorded as sent');
});

test('dataRows() null (balance sheet / pivot / cannot tell) is not treated as empty', () => {
    const t = setup({ engine: { rows: null } }); t.run();
    assert.equal(t.sent[0].attachments.length, 1);
    const bs = setup({ engine: { rows: 0, bs: true } }); bs.run();
    assert.equal(bs.sent[0].attachments.length, 1, 'balance sheet skips the empty check');
});

test('a data load error gives a link email, not a statement of zeros', () => {
    const t = setup({ engine: { loadError: 'HTTP 500' } }); t.run();
    assert.equal(t.sent[0].attachments, undefined);
    assert.match(t.sent[0].body, /did not load: HTTP 500/);
});

test('graph: Include Graph adds a link "with the graph" next to the attachment', () => {
    const t = setup({ def: scheduleDef({ view: { graph: true } }) }); t.run();
    assert.equal(t.sent[0].attachments.length, 1);
    assert.match(t.sent[0].body, /Open Month End with the graph in the Reporting Lab/);
    assert.match(t.sent[0].body, /sid=42/);
});

test('attach "both" makes an Excel workbook and a PDF; "link" makes neither', () => {
    const both = setup({ def: scheduleDef({ attach: 'both' }) }); both.run();
    deq(both.sent[0].attachments.map(a => a.fileType), ['EXCEL', 'PDF']);
    const link = setup({ def: scheduleDef({ attach: 'link' }) }); link.run();
    assert.equal(link.sent[0].attachments, undefined);
    assert.ok(!link.calls.includes('init'), 'a link-only schedule does not build the report');
    assert.match(link.sent[0].body, /Open Month End in the Reporting Lab/);
});

test('the schedule\'s own Suitelet ids win over the script parameters', () => {
    const t = setup({ def: scheduleDef({ attach: 'link' }), params: { custscript_nts_sched_script: 'customscript_param_sl' } }); t.run();
    assert.match(t.sent[0].body, /script=customscript_saved_sl/);
    const noSl = setup({ def: scheduleDef({ attach: 'link', sl: undefined }) }); noSl.run();
    assert.match(noSl.sent[0].body, /script=customscript_nts_is_cpm_sl&amp;deploy=customdeploy_nts_is_cpm_sl/, 'built-in default when neither is set');
});

test('already sent today, disabled, or not due: nothing is sent', () => {
    const today = new Date(), key = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    for (const over of [{ lastSent: key }, { enabled: false }, { freq: 'weekly', dow: (today.getDay() + 1) % 7 }]) {
        const t = setup({ def: scheduleDef(over) }); t.run();
        assert.equal(t.sent.length, 0, JSON.stringify(over));
    }
});

test('test-send: one schedule, now, only to the requester, marked [Test], nothing recorded', () => {
    const t = setup({ def: scheduleDef({ lastSent: '2099-01-01', enabled: false }),
                      params: { custscript_nts_sched_only: String(SCHED_ID), custscript_nts_sched_test_to: '99' } });
    t.run();
    assert.equal(t.sent.length, 1);
    deq(t.sent[0].recipients, [99]);
    assert.match(t.sent[0].subject, /^\[Test\] /);
    assert.match(t.sent[0].body, /Scheduler build \d{4}-\d{2}-\d{2}/);
    assert.equal(t.sent[0].attachments.length, 1, 'a test ignores enabled/lastSent and builds the real attachment');
    assert.equal(t.submitted.length, 0);
});

test('test-send of a schedule that cannot be found tells the requester', () => {
    const t = setup({ params: { custscript_nts_sched_only: '777', custscript_nts_sched_test_to: '99' } }); t.run();
    assert.equal(t.sent.length, 1);
    deq(t.sent[0].recipients, [99]);
    assert.match(t.sent[0].subject, /could not be sent/);
});

test('no Sender parameter is an error', () => {
    const t = setup({ params: { custscript_nts_sched_author: '' } });
    assert.throws(() => t.run(), /custscript_nts_sched_author/);
});
