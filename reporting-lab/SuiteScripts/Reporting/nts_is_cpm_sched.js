/**
 * Nussbaum Reporting Lab — scheduled reports, emailed as a PDF and/or Excel attachment
 *
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 *
 * People schedule a report from the Export menu in the Reporting Lab ("Schedule Report"). Each schedule is a record in the
 * same saved-report custom record as the reports (kind "schedule"). This script runs on a repeating schedule, finds the
 * schedules that are due, builds each report fresh, and emails it to the recipients as a PDF, an Excel workbook, or both
 * (or just a link, if that is what the schedule asks for).
 *
 * How the report is built: nts_is_cpm_engine.js is the Reporting Lab page's own calculation and export code, run without a
 * browser. It asks the Reporting Lab Suitelet for the same data the page would (https.requestSuitelet, as the user this script
 * runs as), makes the same Excel workbook and the same PDF statement the page makes, and this script attaches them.
 * If a report cannot be built here, the email still goes out, with a link to open the report instead and a note saying why.
 *
 * Setup (once):
 *   1. Upload these files to the File Cabinet, the first two in the SAME folder:
 *        nts_is_cpm_sched.js    (this file)
 *        nts_is_cpm_engine.js   (the report engine; upload a new copy whenever the page is updated)
 *      and keep nts_is_cpm_page.html / nts_is_cpm_sl.js / nts_is_cpm_pdf.xml where they already are.
 *   2. Create a Script record from this file. Script id: customscript_nts_is_cpm_sched
 *      Create these parameters on it (Free-Form Text):
 *        custscript_nts_sched_author   Sender: the employee the emails come from, as an internal id or an email address
 *                                      (an email address is looked up among active employees). Required.
 *        custscript_nts_sched_script   Script id of the Reporting Lab Suitelet.      Default: customscript_nts_reporting_lab
 *        custscript_nts_sched_deploy   Deployment id of the Reporting Lab Suitelet.  Default: customdeploy_nts_reporting_lab
 *        custscript_nts_sched_only     (leave blank) used by "Send me a test": one schedule's id to run now
 *        custscript_nts_sched_test_to  (leave blank) used by "Send me a test": the person to send that test to
 *   3. Deploy it. Deployment id: customdeploy_nts_is_cpm_sched. Status Scheduled, repeat every 15 minutes or every hour,
 *      Execute as an administrator (so it can read every schedule and the Suitelet's data).
 *
 * A schedule sends once a day at most: on the day its frequency names, at or after the time it asks for (in the time zone
 * of the user the script runs as). The day it last sent is saved in the schedule itself. The time is checked each time the
 * script runs, so a 15-minute repeat sends within 15 minutes of it.
 *
 * Not in the attachment: the graph (a graph cannot be drawn on the server). A schedule with Include Graph? ticked adds a
 * link that opens the report with the graph.
 */
define(['N/search', 'N/record', 'N/email', 'N/url', 'N/runtime', 'N/format', 'N/log', 'N/https', 'N/file', 'N/query', './nts_is_cpm_engine'],
(search, record, email, url, runtime, format, log, https, file, query, createEngine) => {

    const BUILD = '2026-11-18a';                                        // shown in the Execution Log and on test emails, to tell which copy of this script is running
    const REPORT_RECORD = 'customrecord_nts_is_report';
    const DEF_FIELD = 'custrecord_nts_isr_definition';
    // The Reporting Lab Suitelet, by its text Script ID and Deployment ID (the same in sandbox and production), used when the
    // parameters are blank and a schedule does not name its own Suitelet.
    const DEFAULT_SL_SCRIPT = 'customscript_nts_reporting_lab';
    const DEFAULT_SL_DEPLOY = 'customdeploy_nts_reporting_lab';

    const esc = x => String(x === undefined || x === null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

    // A schedule's definition is a long-text field, and a search column hands back only the first part of a long one, which then
    // does not parse. So when the column's text is not valid JSON, the record itself is loaded and its field read whole.
    function readDef(id, raw) {
        try { return JSON.parse(raw); } catch (e) { /* truncated: read it whole below */ }
        try { return JSON.parse(record.load({ type: REPORT_RECORD, id: Number(id) }).getValue(DEF_FIELD)); }
        catch (e) { log.error('Could not read schedule ' + id, (e && (e.stack || e.message)) || e); return null; }
    }

    // The Sender parameter: an employee internal id, or an email address looked up among active employees (once per run).
    // No match, or more than one, stops the run with a message that names the address.
    const senderCache = {};
    function resolveSender(raw) {
        const v = String(raw === undefined || raw === null ? '' : raw).trim();
        if (!v) throw new Error('Set the Sender parameter (custscript_nts_sched_author) to an employee internal id or email address.');
        if (/^\d+$/.test(v)) return Number(v);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('The Sender parameter (custscript_nts_sched_author) is "' + v + '": use an employee internal id or email address.');
        const key = v.toLowerCase();
        if (senderCache[key]) return senderCache[key];
        const rows = query.runSuiteQL({ query: "SELECT id FROM employee WHERE LOWER(email) = ? AND isinactive = 'F'", params: [key] }).asMappedResults();
        if (!rows.length) throw new Error('Sender lookup: no active employee has the email address ' + v + ' (custscript_nts_sched_author).');
        if (rows.length > 1) throw new Error('Sender lookup: ' + rows.length + ' active employees have the email address ' + v + ' (custscript_nts_sched_author). Use the employee internal id instead.');
        return (senderCache[key] = Number(rows[0].id));
    }

    function schedules(onlyId) {
        const out = [];
        const collect = (id, name, raw) => {
            const def = readDef(id, raw);
            if (def && def.kind === 'schedule' && def.sched && (!onlyId || Number(id) === onlyId)) out.push({ id: Number(id), name, def });
        };
        const base = [['isinactive', 'is', 'F']];
        if (onlyId) {                                                   // one schedule asked for by id: no need to search the text
            base.push('AND', ['internalid', 'anyof', onlyId]);
            search.create({ type: REPORT_RECORD, filters: base, columns: ['name', DEF_FIELD] })
                .run().each(r => { collect(r.id, r.getValue('name'), r.getValue(DEF_FIELD)); return true; });
            return out;
        }
        try {
            search.create({ type: REPORT_RECORD, filters: base.concat(['AND', [DEF_FIELD, 'contains', '"kind":"schedule"']]), columns: ['name', DEF_FIELD] })
                .run().each(r => { collect(r.id, r.getValue('name'), r.getValue(DEF_FIELD)); return true; });
        } catch (e) {
            // a long-text field that cannot be searched by content: read every report and keep the schedules
            search.create({ type: REPORT_RECORD, filters: base, columns: ['name', DEF_FIELD] })
                .run().each(r => { collect(r.id, r.getValue('name'), r.getValue(DEF_FIELD)); return true; });
        }
        return out;
    }

    // The engine's window onto the Suitelet: every request the page would make goes to the Suitelet, as this script's user.
    function makeHost(scriptId, deployId, captured, errs) {
        const call = (action, params, body) => {
            const urlParams = Object.assign({}, params, { action });
            const req = { scriptId, deploymentId: deployId, urlParams };
            if (body !== undefined) { req.body = body; req.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
            return https.requestSuitelet(req).body;
        };
        return {
            fetch(u, opts, sh) {
                const qs = u.indexOf('?') >= 0 ? u.slice(u.indexOf('?') + 1) : '', params = {};
                qs.split('&').forEach(kv => { if (!kv) return; const p = kv.split('='); params[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); });
                const action = params.action || 'page'; delete params.action;
                if (action === 'pdf') {                                   // the PDF comes back as base64 inside JSON
                    const text = call('pdfb64', {}, opts.body); let j = {};
                    try { j = JSON.parse(text); } catch (e) { /* reported below */ }
                    if (j.base64) return { status: 200, headers: { get: k => k === 'Content-Type' ? 'application/pdf' : null }, text: () => text, blob: () => new sh.Blob([sh.b64ToBytes(j.base64)]) };
                    return { status: 500, headers: { get: () => 'application/json' }, text: () => text };
                }
                const text = call(action, params, opts && opts.method === 'POST' ? opts.body : undefined);
                return { status: 200, headers: { get: () => 'application/json' }, text: () => text };
            },
            download(blob, name) { captured.push({ name, bytes: blob.toBytes() }); },
            status(msg, isErr) { if (isErr && msg) { errs.push(String(msg)); log.error('Report engine', msg); } },      // e.g. the data request failed
            error(e) { errs.push(String((e && e.message) || e)); log.error('Report engine', (e && (e.stack || e.message)) || e); }
        };
    }

    // Builds the report the schedule describes and returns the files it makes. Throws if it cannot.
    function buildFiles(s, scriptId, deployId) {
        const S = s.def.sched, attach = S.attach || 'pdf', want = { xlsx: attach === 'xlsx' || attach === 'both', pdf: attach === 'pdf' || attach === 'both' };
        const captured = [], errs = [], engine = createEngine(makeHost(scriptId, deployId, captured, errs)), api = engine.api;
        api.init(); engine.drain();
        api.applySchedule(s.id); engine.drain();                            // the report, its filters and the month, as scheduled
        if (errs.length) throw new Error('the report data did not load: ' + errs[0]);      // better a clear note than a statement full of zeros
        if (!api.isBS() && api.dataRows && api.dataRows() === 0) throw new Error('the report data came back empty (no figures for this month and these filters)');
        const book = api.isLayout() && !api.isBS(), files = [];
        const take = (type) => {
            captured.forEach(c => files.push(file.create({ name: c.name, fileType: type, contents: engine.bytesToB64(c.bytes) })));
            captured.length = 0;
        };
        if (want.xlsx) { api.exportXlsx(book); engine.drain(); take(file.Type.EXCEL); }
        if (want.pdf) { api.exportPdf(book); engine.drain(); take(file.Type.PDF); }
        if (errs.length) throw new Error(errs[0]);
        if (!files.length) throw new Error('The report came out empty.');
        return files;
    }

    function sendOne(s, author, scriptId, deployId, host, testTo) {
        const S = s.def.sched;
        if (S.sl && S.sl.script && S.sl.deploy) { scriptId = S.sl.script; deployId = S.sl.deploy; }      // the Suitelet the schedule was saved from
        let files = [], note = '';
        if ((S.attach || 'pdf') !== 'link') {
            try { files = buildFiles(s, scriptId, deployId); }
            catch (e) { note = 'The attachment could not be built (' + esc(e.message || e) + '), so this email carries a link instead.'; log.error('Scheduled report could not be built: ' + s.name, (e && (e.stack || e.message)) || e); }
        }
        const link = host + url.resolveScript({ scriptId, deploymentId: deployId, returnExternalUrl: false, params: { sid: s.id } });
        const withGraph = S.view && S.view.graph;
        const linkOnly = (S.attach || 'pdf') === 'link' || !files.length;      // the link is the content only when nothing is attached
        const body = '<p>' + esc(S.message || 'Your scheduled report is attached.').replace(/\n/g, '<br>') + '</p>'
                   + (note ? '<p style="color:#b00020">' + note + '</p>' : '')
                   + (linkOnly || withGraph ? '<p><a href="' + esc(link) + '">Open ' + esc(S.reportName || 'the report') + (withGraph ? ' with the graph' : '') + ' in the Reporting Lab</a> (you need to be signed in to NetSuite).</p>' : '')
                   + (testTo ? '<p style="color:#666;font-size:12px">This is a test of a scheduled report. Scheduler build ' + BUILD + '.</p>' : '');
        email.send({ author, recipients: testTo ? [testTo] : S.emails, subject: (testTo ? '[Test] ' : '') + (S.subject || S.reportName || 'Scheduled report'), body, attachments: files.length ? files : undefined });
    }

    function execute() {
        const script = runtime.getCurrentScript();
        log.audit('Reporting Lab scheduler ' + BUILD, 'deployment ' + script.deploymentId);
        const author = resolveSender(script.getParameter({ name: 'custscript_nts_sched_author' }));
        const scriptId = script.getParameter({ name: 'custscript_nts_sched_script' }) || DEFAULT_SL_SCRIPT;
        const deployId = script.getParameter({ name: 'custscript_nts_sched_deploy' }) || DEFAULT_SL_DEPLOY;
        const only = Number(script.getParameter({ name: 'custscript_nts_sched_only' })) || 0;
        const testTo = Number(script.getParameter({ name: 'custscript_nts_sched_test_to' })) || 0;
        const host = 'https://' + url.resolveDomain({ hostType: url.HostType.APPLICATION });

        if (only) {                                                     // "Send me a test": one schedule, now, to one person, nothing recorded
            const to = testTo || author;
            log.audit('Scheduled report test started', 'schedule ' + only + ', to employee ' + to + ', sender ' + author);
            const notify = (why) => {                                   // a test that cannot finish says so, rather than going quiet
                try { email.send({ author, recipients: [to], subject: '[Test] Scheduled report could not be sent', body: '<p>' + esc(why) + '</p><p>See the Execution Log of the Reporting Lab scheduled script for details.</p>' }); }
                catch (e2) { log.error('Could not send the test failure notice', (e2 && (e2.stack || e2.message)) || e2); }
            };
            const found = schedules(only);
            if (!found.length) { log.error('Scheduled report test: schedule not found', only); notify('The schedule (id ' + only + ') could not be found or read.'); return; }
            found.forEach(s => {
                try { sendOne(s, author, scriptId, deployId, host, to); log.audit('Scheduled report test sent', s.name); }
                catch (e) { log.error('Scheduled report test failed: ' + s.name, (e && (e.stack || e.message)) || e); notify('The test of "' + s.name + '" failed: ' + ((e && e.message) || e)); }
            });
            return;
        }

        const now = new Date();
        const today = format.parse({ value: format.format({ value: now, type: format.Type.DATE }), type: format.Type.DATE });
        const tm = /(\d+):(\d+)\s*([ap]m)?/i.exec(format.format({ value: now, type: format.Type.TIMEOFDAY }) || '');
        let hour = tm ? Number(tm[1]) : 0;
        if (tm && tm[3]) { const pm = /pm/i.test(tm[3]); hour = (hour % 12) + (pm ? 12 : 0); }
        const nowMin = hour * 60 + (tm ? Number(tm[2]) : 0);                // minutes since midnight, in the running user's time zone
        const key = ymd(today), dow = today.getDay(), dom = today.getDate();
        const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();

        schedules(0).forEach(s => {
            const S = s.def.sched;
            try {
                const tt = /^(\d{1,2}):(\d{2})$/.exec(String(S.time || ''));
                const dueMin = tt ? Number(tt[1]) * 60 + Number(tt[2]) : Number(S.hour || 0) * 60;     // the time typed in the schedule
                if (S.enabled === false || S.lastSent === key || nowMin < dueMin) return;
                const due = S.freq === 'daily' ? true
                          : S.freq === 'weekly' ? dow === Number(S.dow)
                          : (S.dom === 'last' ? dom === lastDay : dom === Math.min(Number(S.dom) || 1, lastDay));
                if (!due) return;
                sendOne(s, author, scriptId, deployId, host, 0);
                S.lastSent = key;
                record.submitFields({ type: REPORT_RECORD, id: s.id, values: { [DEF_FIELD]: JSON.stringify(s.def) } });
                log.audit('Scheduled report sent', s.name + ' to ' + S.emails.join(', '));
            } catch (e) {
                log.error('Scheduled report failed: ' + s.name, (e && (e.stack || e.message)) || e);
            }
        });
    }

    return { execute };
});
