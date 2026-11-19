/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * NTS - Collections  (one Suitelet, three tabs)
 * ---------------------------------------------------------------
 * Replaces two scripts:
 *   nts_collections_notes_portal_sl.js  (NTS - Collections Portal)   -> tab "Notes Upload"
 *   nts_invoice_status_upload_sl.js     (NTS - CAT Collections)      -> tabs "CAT Status Upload" and "ICG # Import"
 *
 * Tabs
 *   notes  Notes Upload       Any customer. The file's FIRST column is looked up as Invoice # (external ID)
 *                             or Reference # (CFG.REF_FIELDS), chosen on the page.
 *   cat    CAT Status Upload  Only invoices under the CAT parent customer. Takes the raw CASS export
 *                             (.zip/.tsv/.xlsx) or the formatted notes file (Invoice/Pro Number, Notes, Status).
 *   icg    ICG # Import       Only CAT invoices. Overwrites CFG.CAT_REF_FIELD with the ICG #.
 *   Open a tab directly with &tab=notes|cat|icg on the deployment URL. CFG.TABS turns tabs off.
 *
 * Every request names its scope ('all' for the Notes tab, 'cat' for the CAT tabs). The server applies that
 * scope's customer guard to every search and write, and refuses a scope whose tab is switched off.
 *
 * Status/notes flow (both upload tabs)
 *   1. A status file (.xlsx/.csv/.tsv/.zip) is parsed IN THE BROWSER by a built-in reader (no libraries).
 *   2. Rows are matched to OPEN invoices (server-side search).
 *   3. Review in the grid: several invoices for one number -> red, user picks one; no status -> blue,
 *      user assigns one; no invoice found -> grey, excluded (downloadable as exceptions).
 *   4. "Apply" stays disabled until every red/blue row is resolved or skipped. Updates go in small
 *      batches so each request has its own governance budget. One invoice failing never stops a batch,
 *      and nothing is auto-retried.
 *
 * Notes: CFG.NOTE_MODE sets, per scope, whether the grid's note REPLACES the invoice's notes field
 * ('replace', what the old Collections Portal did) or is APPENDED as a new line ('append', what the CAT
 * script does; a line that is already there is not added twice). Field changes are still captured in
 * the invoice's System Notes.
 *
 * Restrict the deployment to the AR roles that should use it.
 */
define(['N/search', 'N/record', 'N/https', 'N/file', 'N/log'], (search, record, https, file, log) => {

    // ------------------------------------------------------------------
    // CONFIG
    // ------------------------------------------------------------------
    const CFG = {
        // Tabs shown on the page (and scopes the server accepts). Remove 'notes' to switch off the
        // all-customer upload; remove 'cat' and 'icg' to switch off the CAT tabs.
        TABS: ['notes', 'cat', 'icg'],

        // Invoice body field(s) holding the customer's reference / pro / CASS number.
        // The "Reference #" lookup and the CAT upload match a row if ANY of these equals the file's number.
        REF_FIELDS: ['custbody_cat_reference_number'],
        // The CASS # field the ICG # Import overwrites.
        CAT_REF_FIELD: 'custbody_cat_reference_number',

        // CAT scope: only invoices for customers UNDER this parent are ever matched or changed.
        // Preferred: the parent customer's internal ID. Fallback: its company name / customer ID
        // (must find exactly one customer, otherwise the request stops and says to set the ID).
        CAT_PARENT_ID: '',
        CAT_PARENT_NAME: 'CATERPILLAR PARENT',

        // Raw CASS export -> NS status. Key = status worked out from the CASS columns, value = the NS
        // status name (Note Type list). Anything not listed is left for the user to pick.
        CASS_STATUS_MAP: { 'Approved for Pay': 'Approved for Pay' },

        // Status: custom body field (List/Record) and the list behind it.
        STATUS_FIELD: 'custbody_collections_status',
        STATUS_LIST_ID: 'notetype',               // the built-in Note Type list
        STATUS_EXCLUDE_NAMES: ['System Logged Note'],

        // Notes: custom body field (Text Area / long text, not Free-Form Text).
        NOTES_FIELD: 'custbody_collections_notes',
        NOTES_MAX: 4000,                           // longer text keeps the newest lines
        NOTE_MODE: { all: 'replace', cat: 'append' },

        // "Promised to Pay Date", filled for rows whose status is Approved for Pay.
        // '' = disabled (dates are then added to the note text instead).
        PAY_DATE_FIELD: 'custbody_promised_to_pay_date',

        OPEN_ONLY: true,          // only match open invoices (status CustInvc:A)
        MATCH_BATCH: 200,         // rows per match request (client side)
        COMMIT_BATCH: 25,         // invoices per update request (client side)
        MATCH_CHUNK: 50,          // keys per search (server side)
        MAX_ROWS: 3000,           // hard cap per upload (a full CASS export is ~1,400 rows)

        // Existing "Send Balance Due" Suitelet (nts_ar_balance_due_sl.js). Text IDs, not numeric ones.
        BD_SCRIPT_ID: 'customscript_nts_ar_balance_due_sl',
        BD_DEPLOY_ID: 'customdeploy_nts_ar_balance_due_sl',
        SEND_WEIGHT: 5,           // a send counts as this many invoices when batching

        // Per-invoice attachments, emailed with the balance due / resent invoice. MUST be the same folder
        // as UPLOAD_FOLDER_ID in nts_ar_balance_due_sl.js ("Balance Due Invoices").
        // More than one file per invoice needs the Balance Due Suitelet patched to read "fileids";
        // until then only the first file ("fileid") is attached.
        ATTACH_FOLDER_ID: 2126,
        ATTACH_MAX_B64: 7000000,                  // ~5 MB per file once base64-encoded
        ATTACH_MAX_FILES: { all: 1, cat: 5 },     // files per invoice, per scope
        ATTACH_MAX_TOTAL: 10 * 1024 * 1024,       // combined size of one invoice's files (bytes)

        // Nussbaum theme assets (File Cabinet URLs, e.g. '/core/media/media.nl?id=123&c=...&h=...').
        // Leave '' to fall back to Arial Narrow / Arial and a text-only header.
        // The Univers files are licensed for internal use only: keep them in a File Cabinet folder
        // that is NOT "Available Without Login".
        LOGO_URL: '',             // nussbaum-logo-reversed.png (the header is black)
        FONT_URLS: {
            LIGHT_COND: '',       // UniversLTPro-LightCond.ttf   (47)
            COND: '',             // UniversLTPro-Condensed.ttf   (57)
            BOLD_COND: '',        // UniversLTPro-BoldCond.ttf    (67)
            ROMAN: '',            // UniversLTPro-55Roman.ttf     (55)
            BOLD: ''              // UniversLTPro-65Bold.ttf      (65)
        }
    };

    const SCOPE_TABS = { all: ['notes'], cat: ['cat', 'icg'] };
    const SCOPE_DENIED = { all: 'That is not an invoice.', cat: 'This invoice is not under the CAT parent customer.' };

    // ------------------------------------------------------------------
    // Entry point
    // ------------------------------------------------------------------
    const onRequest = (ctx) => {
        _catIds = null;   // resolve the CAT customer set fresh on every request
        if (ctx.request.method === 'GET') {
            ctx.response.write(renderPage(ctx.request.parameters.tab));
            return;
        }
        let out;
        try {
            const body = JSON.parse(ctx.request.body);
            switch (body.action) {
                case 'match':     out = matchRows(body.rows, false, body.by, scopeOf(body.scope)); break;
                case 'matchall':  out = matchRows(body.rows, true, body.by, scopeOf(body.scope)); break;  // every invoice with the number, any status
                case 'upload':    out = uploadAttachment(body, scopeOf(body.scope)); break;
                case 'commit':    out = commitItems(body.items, scopeOf(body.scope)); break;
                case 'icgmatch':  scopeOf('cat', 'icg'); out = icgMatch(body.rows, !!body.byLoad); break;
                case 'icgcommit': scopeOf('cat', 'icg'); out = icgCommit(body.items); break;
                default: throw new Error('Unknown action');
            }
        } catch (e) {
            log.error({ title: 'Collections request failed', details: e });
            out = { error: 'The request could not be processed. ' + friendly(e) };
        }
        ctx.response.setHeader({ name: 'Content-Type', value: 'application/json' });
        ctx.response.write(JSON.stringify(out));
    };

    const friendly = (e) => String((e && e.message) || 'Unknown error').slice(0, 300);

    // A scope is accepted only if one of its tabs is switched on (or the named tab, when given).
    const scopeOf = (s, tab) => {
        s = String(s || '');
        if (!SCOPE_TABS[s]) throw new Error('Unknown scope.');
        const tabs = tab ? [tab] : SCOPE_TABS[s];
        if (!tabs.some((t) => CFG.TABS.indexOf(t) >= 0)) throw new Error('That tab is switched off.');
        return s;
    };

    // ------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------
    const loadStatuses = () => {
        const out = [];
        search.create({
            type: CFG.STATUS_LIST_ID,
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'name', sort: search.Sort.ASC })
            ]
        }).run().each((r) => {
            const nm = r.getValue('name');
            if (CFG.STATUS_EXCLUDE_NAMES.indexOf(nm) < 0) out.push({ id: String(r.getValue('internalid')), name: nm });
            return true;
        });
        return out;
    };

    const chunk = (arr, n) => {
        const out = [];
        for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
        return out;
    };

    // ------------------------------------------------------------------
    // CAT parent limit. Fails closed: if the parent can't be identified nothing is searched or written.
    // ------------------------------------------------------------------
    let _catIds = null;
    const catCustomerIds = () => {
        if (_catIds) return _catIds;
        let parentId = String(CFG.CAT_PARENT_ID || '').trim();
        if (!parentId) {
            const found = [];
            search.create({
                type: search.Type.CUSTOMER,
                filters: [['companyname', 'is', CFG.CAT_PARENT_NAME], 'OR', ['entityid', 'is', CFG.CAT_PARENT_NAME]],
                columns: [search.createColumn({ name: 'entityid' })]
            }).run().each((r) => { found.push(String(r.id)); return true; });
            if (found.length !== 1) {
                throw new Error('Setup needed: could not identify the CAT parent customer (' + found.length +
                    ' matches for "' + CFG.CAT_PARENT_NAME + '"). Set CAT_PARENT_ID in the script to the parent customer\'s internal ID.');
            }
            parentId = found[0];
        }
        const all = {};
        let level = [parentId];
        for (let depth = 0; depth < 4 && level.length; depth++) {   // children, grandchildren, ...
            const next = [];
            search.create({
                type: search.Type.CUSTOMER,
                filters: [['parent', 'anyof', level]],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each((r) => {
                const id = String(r.id);
                if (!all[id]) { all[id] = true; next.push(id); }
                return true;
            });
            level = next;
        }
        const ids = Object.keys(all);
        if (!ids.length) throw new Error('Setup needed: no customers were found under the CAT parent customer.');
        _catIds = ids;
        return ids;
    };

    // Customer limit for a scope: null = any customer, otherwise the list of allowed customer ids.
    const scopeEntities = (scope) => (scope === 'cat' ? catCustomerIds() : null);

    // Guard for every write: which of these ids are invoices the scope may touch (guards against hand-edited requests).
    const invoiceSet = (invoiceIds, scope) => {
        const ok = {};
        const ents = scopeEntities(scope);
        const ids = (invoiceIds || []).map(String).filter((x) => /^\d+$/.test(x));
        chunk(ids, 200).forEach((group) => {
            const filters = [['mainline', 'is', 'T'], 'AND', ['internalid', 'anyof', group]];
            if (ents) filters.push('AND', ['entity', 'anyof', ents]);
            search.create({
                type: search.Type.INVOICE,
                filters,
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each((r) => { ok[String(r.id)] = true; return true; });
        });
        return ok;
    };

    // ------------------------------------------------------------------
    // MATCH: file keys -> candidate open invoices (+ current status/notes for no-change detection)
    //   by = 'extid'  the key is the invoice's external ID (equals the invoice number; never ambiguous)
    //   by = 'ref'    the key is a reference number (CFG.REF_FIELDS); several invoices can share one
    // ------------------------------------------------------------------
    // The external ID filter is tried in this order; the first form the account accepts is remembered.
    const EXT_FILTERS = [
        (group) => {
            const f = [];
            group.forEach((p) => { if (f.length) f.push('OR'); f.push(['externalidstring', 'is', p]); });
            return f;
        },
        (group) => ['externalid', 'anyof', group]
    ];
    let extFilterIdx = 0;

    const matchRows = (rows, includeAll, by, scope) => {
        if (!Array.isArray(rows) || rows.length > CFG.MAX_ROWS) throw new Error('Too many rows in one request.');
        if (by !== 'extid' && by !== 'ref') throw new Error('Choose how to look up the invoices (Invoice # or Reference #).');
        const byExt = by === 'extid';
        const norm = (k) => (byExt ? String(k).trim().toLowerCase() : String(k).trim());   // external IDs are not case-sensitive
        const ents = scopeEntities(scope);

        const wanted = {};
        rows.forEach((r) => {
            const p = String((r && r.pro) || '').trim();
            if (p) wanted[p] = true;
        });
        const keys = Object.keys(wanted);
        const keyOf = {};                         // normalised key -> key exactly as it appears in the file
        keys.forEach((p) => { keyOf[norm(p)] = p; });
        const byKey = {};                         // key -> { invoiceId: invoiceObj }
        const allIds = {};

        const columns = () => {
            const c = [
                search.createColumn({ name: 'tranid' }),
                search.createColumn({ name: 'entity' }),
                search.createColumn({ name: 'trandate' }),
                search.createColumn({ name: 'amountremaining' }),
                search.createColumn({ name: CFG.STATUS_FIELD }),
                search.createColumn({ name: CFG.NOTES_FIELD }),
                search.createColumn({ name: 'status' })
            ];
            if (CFG.PAY_DATE_FIELD) c.push(search.createColumn({ name: CFG.PAY_DATE_FIELD }));
            if (byExt) c.push(search.createColumn({ name: 'externalid' }));
            else CFG.REF_FIELDS.forEach((f) => c.push(search.createColumn({ name: f })));
            return c;
        };

        const runGroup = (group) => {
            const base = [['mainline', 'is', 'T']];
            if (CFG.OPEN_ONLY && !includeAll) base.push('AND', ['status', 'anyof', 'CustInvc:A']);
            if (ents) base.push('AND', ['entity', 'anyof', ents]);
            // keyFilter is ONE nested expression: wrapped so it stays grouped under the AND (concat would spread it)
            const open = (keyFilter) => search.create({
                type: search.Type.INVOICE, filters: base.concat(['AND'], [keyFilter]), columns: columns()
            }).runPaged({ pageSize: 1000 });

            if (!byExt) {
                const f = [];
                group.forEach((p) => CFG.REF_FIELDS.forEach((fld) => { if (f.length) f.push('OR'); f.push([fld, 'is', p]); }));
                return open(f);
            }
            let lastErr = null;
            for (let i = extFilterIdx; i < EXT_FILTERS.length; i++) {
                try {
                    const paged = open(EXT_FILTERS[i](group));
                    extFilterIdx = i;
                    return paged;
                } catch (e) { lastErr = e; }
            }
            throw lastErr;
        };

        chunk(keys, CFG.MATCH_CHUNK).forEach((group) => {
            const paged = runGroup(group);
            paged.pageRanges.forEach((pr) => {
                paged.fetch({ index: pr.index }).data.forEach((res) => {
                    const id = String(res.id);
                    const inv = {
                        id,
                        tranid: res.getValue('tranid'),
                        invStatus: res.getText('status') || '',
                        entityInternalId: String(res.getValue('entity') || ''),
                        billTo: res.getText('entity') || '',   // fallback; replaced by customer ID below
                        date: res.getValue('trandate'),
                        amountRemaining: Number(res.getValue('amountremaining') || 0),
                        statusId: String(res.getValue(CFG.STATUS_FIELD) || ''),
                        statusText: res.getText(CFG.STATUS_FIELD) || '',
                        payDate: CFG.PAY_DATE_FIELD ? toIso(res.getValue(CFG.PAY_DATE_FIELD)) : '',
                        lastNote: String(res.getValue(CFG.NOTES_FIELD) || '')
                    };
                    const found = byExt
                        ? [res.getValue('externalid'), res.getText('externalid')]
                        : CFG.REF_FIELDS.map((f) => res.getValue(f));
                    found.forEach((v) => {
                        const n = norm(v || '');
                        const k = keyOf[n];
                        if (k === undefined || !n) return;
                        byKey[k] = byKey[k] || {};
                        byKey[k][id] = inv;
                        allIds[id] = inv;
                    });
                });
            });
        });

        attachBillTo(allIds);

        const out = {};
        keys.forEach((p) => { out[p] = Object.keys(byKey[p] || {}).map((id) => byKey[p][id]); });
        return { matches: out };
    };

    // Bill-To shown as the customer's ID (entityid) only, not the full hierarchical name.
    const attachBillTo = (invById) => {
        const entIds = {};
        Object.keys(invById).forEach((id) => { if (invById[id].entityInternalId) entIds[invById[id].entityInternalId] = true; });
        const idMap = {};
        chunk(Object.keys(entIds), 500).forEach((group) => {
            search.create({
                type: search.Type.CUSTOMER,
                filters: [['internalid', 'anyof', group]],
                columns: [search.createColumn({ name: 'entityid' })]
            }).run().each((r) => {
                idMap[String(r.id)] = String(r.getValue('entityid') || '');
                return true;
            });
        });
        Object.keys(invById).forEach((id) => {
            const inv = invById[id];
            if (idMap[inv.entityInternalId]) inv.billTo = idMap[inv.entityInternalId];
        });
    };

    // NetSuite date value -> yyyy-mm-dd (for the browser's <input type=date>)
    const toIso = (v) => {
        if (!v) return '';
        const d = (v instanceof Date) ? v : new Date(v);
        if (isNaN(d.getTime())) return '';
        const p = (n) => (n < 10 ? '0' + n : '' + n);
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    };

    // ------------------------------------------------------------------
    // ATTACHMENTS: saves a dropped file to the File Cabinet and attaches it to the invoice
    // (same as the Send Balance Due form does). Returns the file's internal id.
    // ------------------------------------------------------------------
    const ATTACH_TYPES = {
        pdf: file.Type.PDF, jpg: file.Type.JPGIMAGE, jpeg: file.Type.JPGIMAGE, png: file.Type.PNGIMAGE,
        doc: file.Type.WORD, docx: file.Type.WORD, xls: file.Type.EXCEL, xlsx: file.Type.EXCEL
    };
    const uploadAttachment = (b, scope) => {
        const id = String(b.id || '');
        if (!/^\d+$/.test(id)) throw new Error('Invalid invoice id');
        if (!invoiceSet([id], scope)[id]) throw new Error(SCOPE_DENIED[scope]);
        const name = String(b.name || '').replace(/[^\w.\- ()]/g, '_').slice(0, 100);
        const ext = (name.split('.').pop() || '').toLowerCase();
        const fileType = ATTACH_TYPES[ext];
        if (!fileType) throw new Error('That file type is not allowed. Use PDF, JPG, PNG, Word or Excel.');
        const b64 = String(b.b64 || '');
        if (!b64) throw new Error('The file is empty.');
        if (b64.length > CFG.ATTACH_MAX_B64) throw new Error('The file is too large (limit about 5 MB).');

        const tranid = String(search.lookupFields({ type: search.Type.INVOICE, id, columns: ['tranid'] }).tranid || id);
        const f = file.create({
            name: tranid + '_' + Date.now() + '_' + name,
            fileType,
            contents: b64,          // binary types take base64
            folder: CFG.ATTACH_FOLDER_ID
        });
        const fileId = f.save();
        record.attach({ record: { type: 'file', id: fileId }, to: { type: 'invoice', id } });
        return { fileId: String(fileId) };
    };

    // Attachment ids sent from the browser: digits only, capped per scope. Throws before anything is emailed.
    const parseFileIds = (v, scope) => {
        const max = CFG.ATTACH_MAX_FILES[scope] || 1;
        const ids = (Array.isArray(v) ? v : (v ? [v] : [])).map(String);
        if (ids.length > max) throw new Error('Too many attachments (limit ' + max + ').');
        ids.forEach((x) => { if (!/^\d+$/.test(x)) throw new Error('Invalid attachment id'); });
        return ids;
    };

    const todayStamp = () => {
        const d = new Date();
        return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2);
    };

    // ---- notes ----
    // True when the note already exists as a whole line in the existing text (so a re-upload does not duplicate it).
    // The page uses the same rule to show "No change".
    const noteHasLine = (existing, add) => {
        const a = String(add || '').trim();
        if (!a) return true;
        return String(existing || '').split(/\r?\n/).some((l) => l.trim() === a);
    };
    // Keeps the newest NOTES_MAX characters, dropping a partly cut first line.
    const trimNewest = (text) => {
        if (text.length <= CFG.NOTES_MAX) return text;
        const start = text.length - CFG.NOTES_MAX;
        let cut = text.slice(start);
        if (text.charAt(start - 1) !== '\n') {
            const nl = cut.indexOf('\n');
            if (nl >= 0 && nl < cut.length - 1) cut = cut.slice(nl + 1);
        }
        return cut;
    };

    // ------------------------------------------------------------------
    // EMAILS: both go through the existing Balance Due Suitelet (one script, two modes):
    //   default -> Balance Due notice          mode=resend -> plain invoice, like the Resend Invoice button
    // Attachments go as "fileids" (comma separated). "fileid" (the first one) is also sent so an
    // un-patched Balance Due Suitelet still attaches at least that file.
    // ------------------------------------------------------------------
    const callBalanceDueSuitelet = (invoiceId, extra, fileIds, what) => {
        const body = Object.assign({ action: 'autosend', invid: String(invoiceId) }, extra);
        if (fileIds.length) {
            body.fileids = fileIds.join(',');
            body.fileid = fileIds[0];
        }
        const resp = https.requestSuitelet({
            scriptId: String(CFG.BD_SCRIPT_ID),
            deploymentId: String(CFG.BD_DEPLOY_ID),
            method: https.Method.POST,
            body
        });
        let j;
        try { j = JSON.parse(resp.body); } catch (e) { throw new Error('Unexpected reply from the Balance Due Suitelet'); }
        if (!j.ok) throw new Error(j.error || (what + ' was not sent'));
        return j;
    };
    const sendBalanceDue = (invoiceId, fileIds) => callBalanceDueSuitelet(invoiceId, {}, fileIds, 'Balance due');
    const resendInvoice = (invoiceId, fileIds) => callBalanceDueSuitelet(invoiceId, { mode: 'resend' }, fileIds, 'Invoice');

    // ------------------------------------------------------------------
    // COMMIT: write status / pay date / note, optionally email. One invoice failing never stops the batch.
    // ------------------------------------------------------------------
    const commitItems = (items, scope) => {
        if (!Array.isArray(items) || items.length > 50) throw new Error('Invalid batch.');
        const append = CFG.NOTE_MODE[scope] === 'append';
        const invOk = invoiceSet(items.map((i) => i && i.id), scope);   // only invoices in scope may be changed or emailed
        const validStatus = {};
        loadStatuses().forEach((s) => { validStatus[s.id] = true; });

        const results = items.map((it) => {
            it = it || {};
            const id = String(it.id || '');
            let sent = null;      // balance due result
            let resent = null;    // invoice resend result
            try {
                if (!/^\d+$/.test(id)) throw new Error('Invalid invoice id');
                if (!invOk[id]) throw new Error(SCOPE_DENIED[scope]);

                // 1. validate / read everything BEFORE anything is emailed
                if (it.sendBD && it.resendInv) throw new Error('Choose either Send Balance Due or Resend Invoice, not both.');
                const fileIds = parseFileIds(it.fileIds, scope);
                const values = {};
                if (it.setStatus) {
                    if (!validStatus[String(it.statusId)]) throw new Error('Invalid status');
                    values[CFG.STATUS_FIELD] = String(it.statusId);
                }
                if (it.setDate && CFG.PAY_DATE_FIELD) {
                    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(it.payDate || ''));
                    if (!m) throw new Error('Invalid date');
                    values[CFG.PAY_DATE_FIELD] = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
                }
                const newNote = String(it.note || '').trim();
                const wantsNote = !!(it.addNote && newNote);
                // append mode: the note is added to what the invoice holds RIGHT NOW (not what the page loaded),
                // so edits made by someone else in the meantime are kept.
                let existingNote = '';
                if (append && (wantsNote || it.sendBD || it.resendInv)) {
                    existingNote = String(search.lookupFields({ type: search.Type.INVOICE, id, columns: [CFG.NOTES_FIELD] })[CFG.NOTES_FIELD] || '').trim();
                }

                // 2a. optional balance due (failure here never blocks the status/note update)
                let sendError = '';
                if (it.sendBD) {
                    try { sent = sendBalanceDue(id, fileIds); } catch (e) {
                        sendError = friendly(e);
                        log.error({ title: 'Balance due not sent for invoice ' + id, details: e });
                    }
                }
                // 2b. optional invoice resend (independent of the balance due, same failure rule)
                let resendError = '';
                if (it.resendInv) {
                    try { resent = resendInvoice(id, fileIds); } catch (e) {
                        resendError = friendly(e);
                        log.error({ title: 'Invoice not resent for invoice ' + id, details: e });
                    }
                }

                // 3. note, plus one line per email that went out
                const emailLines = [];
                if (sent) emailLines.push((sent.testMode ? 'Balance due TEST (not emailed) on ' : 'Balance due sent on ') + todayStamp());
                if (resent) emailLines.push((resent.testMode ? 'Invoice resent TEST (not emailed) on ' : 'Invoice resent on ') + todayStamp());
                let noteText = null;
                if (append) {
                    const adds = [];
                    if (wantsNote && !noteHasLine(existingNote, newNote)) adds.push(newNote);
                    adds.push.apply(adds, emailLines);
                    if (adds.length) noteText = (existingNote ? existingNote + '\n' : '') + adds.join('\n');
                } else if (emailLines.length) {
                    const base = String(it.baseNote || '').trim();          // the new note, or the existing one
                    noteText = (base ? base + '\n' : '') + emailLines.join('\n');
                } else if (wantsNote) {
                    noteText = String(it.note);
                }
                if (noteText !== null) values[CFG.NOTES_FIELD] = trimNewest(noteText);

                if (Object.keys(values).length) {
                    try {
                        record.submitFields({
                            type: record.Type.INVOICE,
                            id,
                            values,
                            options: { enableSourcing: false, ignoreMandatoryFields: true }
                        });
                    } catch (e) {
                        if (sent || resent) {
                            const what = [sent ? 'balance due' : '', resent ? 'invoice' : ''].filter(Boolean).join(' and ');
                            log.error({ title: 'Email WAS sent but invoice update failed: ' + id, details: e });
                            return { id, ok: false, sent: !!sent, resent: !!resent,
                                     error: 'The ' + what + (sent && resent ? ' emails WERE' : ' email WAS') + ' sent, but the invoice update failed: ' + friendly(e) };
                        }
                        throw e;
                    }
                }
                return { id, ok: true, sent: !!sent, resent: !!resent, sendError, resendError };
            } catch (e) {
                log.error({ title: 'Update failed for invoice ' + id, details: e });
                return { id, ok: false, sent: !!sent, resent: !!resent, error: friendly(e) };
            }
        });
        return { results };
    };

    // ------------------------------------------------------------------
    // ICG # IMPORT: invoice number -> new CASS # (overwrites CFG.CAT_REF_FIELD). CAT invoices only.
    // ------------------------------------------------------------------
    const ICG_RE = /^[A-Za-z0-9._\-]{1,40}$/;

    const icgMatch = (rows, byLoad) => {
        if (!Array.isArray(rows) || rows.length > CFG.MAX_ROWS) throw new Error('Too many rows in one request.');
        const invs = {};
        const icgs = {};
        rows.forEach((r) => {
            const a = String((r && r.inv) || '').trim();
            const b = String((r && r.icg) || '').trim();
            if (a) invs[a] = true;
            if (ICG_RE.test(b)) icgs[b] = true;
        });
        const cat = catCustomerIds();

        // Invoices named in the file (any status). Normally matched on the full invoice number; with byLoad
        // (the raw ICG export) the file gives the LOAD number, i.e. the invoice number without its trailing
        // letter, so 1465936 finds 1465936A (and 1465936B, if there is one).
        const matches = {};
        const byId = {};
        chunk(Object.keys(invs), CFG.MATCH_CHUNK).forEach((group) => {
            const orFilter = [];
            group.forEach((n) => { if (orFilter.length) orFilter.push('OR'); orFilter.push(['tranid', byLoad ? 'startswith' : 'is', n]); });
            const paged = search.create({
                type: search.Type.INVOICE,
                filters: [['mainline', 'is', 'T'], 'AND', ['entity', 'anyof', cat], 'AND', orFilter],
                columns: ['tranid', 'entity', 'trandate', 'amountremaining', 'status', CFG.CAT_REF_FIELD].map((n) => search.createColumn({ name: n }))
            }).runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach((pr) => {
                paged.fetch({ index: pr.index }).data.forEach((res) => {
                    const inv = {
                        id: String(res.id),
                        tranid: res.getValue('tranid'),
                        entityInternalId: String(res.getValue('entity') || ''),
                        billTo: res.getText('entity') || '',
                        date: res.getValue('trandate'),
                        amountRemaining: Number(res.getValue('amountremaining') || 0),
                        invStatus: res.getText('status') || '',
                        refNow: String(res.getValue(CFG.CAT_REF_FIELD) || '').trim()
                    };
                    let key = inv.tranid;
                    if (byLoad) {
                        const m = /^(\d+)[A-Za-z]?$/.exec(String(inv.tranid));   // 1465936A -> 1465936 (14659360A is not a match)
                        if (!m || !invs[m[1]]) return;
                        key = m[1];
                    }
                    matches[key] = matches[key] || [];
                    matches[key].push(inv);
                    byId[inv.id] = inv;
                });
            });
        });
        attachBillTo(byId);

        // who already carries each new number (CAT bill-tos, any status) -> duplicate flagging
        const holders = {};
        chunk(Object.keys(icgs), CFG.MATCH_CHUNK).forEach((group) => {
            const orFilter = [];
            group.forEach((n) => { if (orFilter.length) orFilter.push('OR'); orFilter.push([CFG.CAT_REF_FIELD, 'is', n]); });
            const paged = search.create({
                type: search.Type.INVOICE,
                filters: [['mainline', 'is', 'T'], 'AND', ['entity', 'anyof', cat], 'AND', orFilter],
                columns: ['tranid', 'status', CFG.CAT_REF_FIELD].map((n) => search.createColumn({ name: n }))
            }).runPaged({ pageSize: 1000 });
            paged.pageRanges.forEach((pr) => {
                paged.fetch({ index: pr.index }).data.forEach((res) => {
                    const key = String(res.getValue(CFG.CAT_REF_FIELD) || '').trim();
                    holders[key] = holders[key] || [];
                    holders[key].push({ id: String(res.id), tranid: res.getValue('tranid'), invStatus: res.getText('status') || '' });
                });
            });
        });
        return { matches, holders };
    };

    const icgCommit = (items) => {
        if (!Array.isArray(items) || items.length > 50) throw new Error('Invalid batch.');
        const okSet = invoiceSet(items.map((i) => i && i.id), 'cat');
        const results = items.map((it) => {
            it = it || {};
            const id = String(it.id || '');
            try {
                if (!/^\d+$/.test(id)) throw new Error('Invalid invoice id');
                if (!okSet[id]) throw new Error(SCOPE_DENIED.cat);
                const icg = String(it.icg || '').trim();
                if (!ICG_RE.test(icg)) throw new Error('Invalid ICG # (letters, numbers, . _ - only, up to 40 characters)');
                const before = String(search.lookupFields({ type: search.Type.INVOICE, id, columns: [CFG.CAT_REF_FIELD] })[CFG.CAT_REF_FIELD] || '').trim();
                if (it.expectOld !== undefined && String(it.expectOld).trim() !== before) {
                    throw new Error('Changed since this page loaded (now "' + before + '"). Reload and try again.');
                }
                record.submitFields({
                    type: record.Type.INVOICE,
                    id,
                    values: { [CFG.CAT_REF_FIELD]: icg },
                    options: { enableSourcing: false, ignoreMandatoryFields: true }
                });
                return { id, ok: true, before, after: icg };
            } catch (e) {
                log.error({ title: 'ICG update failed for invoice ' + id, details: e });
                return { id, ok: false, error: friendly(e) };
            }
        });
        return { results };
    };

    // ------------------------------------------------------------------
    // PAGE
    // ------------------------------------------------------------------
    const escAttr = (s) => String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cssUrl = (s) => String(s || '').replace(/['"\\<>()\s]/g, (c) => '%' + ('0' + c.charCodeAt(0).toString(16).toUpperCase()).slice(-2));

    const fontCss = () => {
        const F = CFG.FONT_URLS || {};
        const face = (family, weight, url) => (url
            ? "@font-face{font-family:'" + family + "';src:url('" + cssUrl(url) + "') format('truetype');font-weight:" + weight + ";font-display:swap}"
            : '');
        return [
            face('Univers LT Pro Cond', 300, F.LIGHT_COND),
            face('Univers LT Pro Cond', 400, F.COND),
            face('Univers LT Pro Cond', 700, F.BOLD_COND),
            face('Univers LT Pro', 400, F.ROMAN),
            face('Univers LT Pro', 700, F.BOLD)
        ].join('\n');
    };

    const renderPage = (tabParam) => {
        const tabs = ['notes', 'cat', 'icg'].filter((t) => CFG.TABS.indexOf(t) >= 0);
        const boot = {
            statuses: loadStatuses(),
            hasPayDate: !!CFG.PAY_DATE_FIELD,
            matchBatch: CFG.MATCH_BATCH,
            commitBatch: CFG.COMMIT_BATCH,
            sendWeight: CFG.SEND_WEIGHT,
            maxRows: CFG.MAX_ROWS,
            cassStatusMap: CFG.CASS_STATUS_MAP,
            attachMaxFiles: CFG.ATTACH_MAX_FILES,
            attachMaxTotal: CFG.ATTACH_MAX_TOTAL,
            noteMode: CFG.NOTE_MODE,
            tabs,
            tab: tabs.indexOf(String(tabParam || '')) >= 0 ? String(tabParam) : tabs[0]
        };
        const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
        const logo = CFG.LOGO_URL ? '<img class="logo" src="' + escAttr(CFG.LOGO_URL) + '" alt="Nussbaum">' : '';
        // function replacements, so a "$" in the data is never read as a replacement pattern
        return PAGE_HTML
            .replace('/*__FONTS__*/', () => fontCss())
            .replace('<!--__LOGO__-->', () => logo)
            .replace('__BOOT__', () => bootJson);
    };

    const PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Collections</title>
<style>
/*__FONTS__*/
/* Nussbaum design system tokens (light theme). Internal Blue is allowed here: this is an internal Suitelet. */
:root{
  color-scheme:light;
  --nb-white:#ffffff; --nb-black:#000008; --nb-red:#ee3124; --nb-red-hover:#c8271c; --nb-red-press:#a51e14;
  --nb-gray-5:#e9e9ea; --nb-gray-10:#d8d9db; --nb-gray-20:#bbbfc1; --nb-gray-30:#a0a4a8; --nb-gray-50:#6f767a;
  --nb-gray-70:#474f53; --nb-gray-90:#1b2428; --nb-blue:#1e5a78; --nb-blue-10:#e3ebee; --nb-blue-5:#f3f6f8;

  --bg-1:var(--nb-white); --bg-2:var(--nb-gray-5); --bg-3:var(--nb-gray-10); --bg-inverse:var(--nb-black);
  --fg-1:var(--nb-gray-90); --fg-2:var(--nb-gray-70); --fg-3:var(--nb-gray-50); --fg-inverse:var(--nb-white);
  --fg-accent:var(--nb-red); --accent-hover:var(--nb-red-hover); --accent-press:var(--nb-red-press);
  --border-subtle:var(--nb-gray-20); --border-control:var(--nb-gray-50); --border-strong:var(--nb-black);
  --focus-ring:var(--nb-red);

  /* row and chip states: red = conflict/failure, Internal Blue = needs input, green = done (functional only) */
  --bad:var(--nb-red-hover); --bad-tint:#fdeceb;
  --need:var(--nb-blue);     --need-tint:var(--nb-blue-10);
  --ok:#2f6b3f;              --ok-tint:#e7f0e9;

  --font-display:"Univers LT Pro Cond","Arial Narrow",Arial,sans-serif;
  --font-body:"Univers LT Pro","Helvetica Neue",Arial,sans-serif;
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px; --space-5:24px; --space-6:32px; --space-7:48px;
  --radius-1:2px; --radius-2:4px;
  --ease:cubic-bezier(0,0,.2,1);
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg-1);color:var(--fg-1)}
body{font:400 14px/1.5 var(--font-body)}
a{color:var(--fg-1);text-decoration:underline;text-decoration-color:var(--border-subtle);text-underline-offset:2px}
a:hover{color:var(--accent-hover);text-decoration-color:var(--accent-hover)}
:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}

/* header band */
.masthead{background:var(--bg-inverse);color:var(--fg-inverse);padding:var(--space-5) var(--space-6);display:flex;align-items:center;gap:var(--space-5)}
.masthead .logo{height:40px;width:auto;display:block}
.masthead .rule{width:1px;align-self:stretch;background:var(--nb-gray-70)}
.overline{font:700 12px/1.3 var(--font-display);letter-spacing:.18em;text-transform:uppercase;color:var(--fg-accent);margin:0 0 var(--space-1)}
.masthead h1{font:700 36px/1.05 var(--font-display);text-transform:uppercase;margin:0;letter-spacing:0}

/* tabs */
.tabs{display:flex;gap:var(--space-6);padding:0 var(--space-6);border-bottom:1px solid var(--border-subtle);background:var(--bg-1)}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;padding:var(--space-4) 0 var(--space-3);
     font:400 14px/1.3 var(--font-display);letter-spacing:.06em;text-transform:uppercase;color:var(--fg-2);cursor:pointer}
.tab:hover{color:var(--fg-1)}
.tab[aria-selected=true]{color:var(--fg-1);font-weight:700;border-bottom-color:var(--nb-red)}

main{padding:var(--space-5) var(--space-6) var(--space-7)}
.panel-intro{max-width:880px;margin:0 0 var(--space-5);color:var(--fg-2)}
.panel-intro h2{font:700 22px/1.1 var(--font-display);text-transform:uppercase;color:var(--fg-1);margin:0 0 var(--space-2)}
.panel-intro p{margin:0}

/* lookup choice */
.lookup{border:0;margin:0 0 var(--space-4);padding:0;display:flex;gap:var(--space-5);align-items:center;flex-wrap:wrap}
.lookup legend{float:left;margin-right:var(--space-2);font:400 14px/1.3 var(--font-display);letter-spacing:.06em;text-transform:uppercase;color:var(--fg-1)}
.lookup label{display:flex;align-items:center;gap:var(--space-2);cursor:pointer}
input[type=radio],input[type=checkbox]{accent-color:var(--nb-red);width:16px;height:16px;margin:0}

/* drop zone */
.drop{border:1px dashed var(--border-control);border-radius:var(--radius-1);background:var(--bg-1);padding:var(--space-7) var(--space-5);
      text-align:center;cursor:pointer;transition:background-color 150ms var(--ease),border-color 150ms var(--ease)}
.drop strong{display:block;font:700 18px/1.2 var(--font-display);text-transform:uppercase;color:var(--fg-1);margin-bottom:var(--space-2)}
.drop:hover{background:var(--nb-blue-5)}
.drop.over{border:2px solid var(--nb-red);background:var(--bg-2)}
.hint{display:block;font-size:13px;line-height:1.45;color:var(--fg-3)}

/* messages */
.msg{margin:var(--space-3) 0;min-height:1.5em;color:var(--fg-2)}
.msg:empty{min-height:0;margin:0}
.msg.err{color:var(--bad);font-weight:700}

/* chips (filters) */
.chips{display:flex;gap:var(--space-2);flex-wrap:wrap;margin:var(--space-4) 0}
.chip{appearance:none;font:400 13px/1.3 var(--font-display);letter-spacing:.06em;text-transform:uppercase;
      padding:var(--space-2) var(--space-3);border:1px solid var(--border-control);border-radius:var(--radius-1);background:var(--bg-1);color:var(--fg-2);cursor:pointer}
.chip b{font-weight:700;margin-right:var(--space-1);color:var(--fg-1)}
.chip:hover{background:var(--bg-2)}
.chip.bad{border-color:var(--bad);color:var(--bad)} .chip.bad b{color:var(--bad)}
.chip.need{border-color:var(--need);color:var(--need)} .chip.need b{color:var(--need)}
.chip.ok{border-color:var(--ok);color:var(--ok)} .chip.ok b{color:var(--ok)}
.chip[aria-pressed=true]{background:var(--fg-1);border-color:var(--fg-1);color:var(--fg-inverse)}
.chip[aria-pressed=true] b{color:var(--fg-inverse)}

/* action bar + buttons */
.bar{display:flex;gap:var(--space-3);align-items:center;flex-wrap:wrap;margin:0 0 var(--space-4)}
.btn{appearance:none;font:700 14px/1 var(--font-display);letter-spacing:.06em;text-transform:uppercase;padding:var(--space-3) var(--space-5);
     border-radius:var(--radius-1);cursor:pointer;transition:background-color 150ms var(--ease),transform 150ms var(--ease)}
.btn.primary{background:var(--nb-red);border:1px solid var(--nb-red);color:var(--fg-inverse)}
.btn.primary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
.btn.primary:active{background:var(--accent-press);transform:scale(.98)}
.btn.secondary{background:var(--bg-1);border:2px solid var(--border-strong);color:var(--fg-1);padding:calc(var(--space-3) - 1px) calc(var(--space-5) - 1px)}
.btn.secondary:hover{background:var(--bg-2)}
.btn.ghost{background:none;border:1px solid transparent;color:var(--fg-2)}
.btn.ghost:hover{color:var(--fg-1);text-decoration:underline;text-decoration-color:var(--nb-red)}
.btn:disabled,.btn:disabled:hover{background:var(--bg-3);border-color:var(--bg-3);color:var(--fg-3);cursor:not-allowed;transform:none}
.applymsg{color:var(--fg-2)}
progress{width:220px;height:8px;accent-color:var(--nb-red)}

/* grid */
.tablewrap{max-height:72vh;overflow:auto;border:1px solid var(--border-subtle)}
table.grid{border-collapse:separate;border-spacing:0;width:100%;background:var(--bg-1)}
.grid th{position:sticky;top:0;z-index:1;background:var(--bg-2);color:var(--fg-1);text-align:left;vertical-align:bottom;white-space:nowrap;
         font:400 13px/1.3 var(--font-display);letter-spacing:.06em;text-transform:uppercase;padding:var(--space-3);border-bottom:1px solid var(--border-subtle)}
.grid td{padding:var(--space-2) var(--space-3);border-bottom:1px solid var(--border-subtle);vertical-align:middle;color:var(--fg-1)}
.grid tbody tr:hover td{background:var(--nb-blue-5)}
.grid .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.grid .ctr{text-align:center}
.grid td:first-child{border-left:4px solid transparent}
select,input[type=text],input[type=date]{font:inherit;color:var(--fg-1);background:var(--bg-1);padding:6px var(--space-2);
  border:1px solid var(--border-control);border-radius:var(--radius-1);max-width:100%}
select:disabled,input:disabled{background:var(--bg-2);color:var(--fg-3)}
input.note{width:100%;min-width:260px}
.curnote{color:var(--fg-2);font-size:13px;min-width:200px;max-width:340px;white-space:pre-wrap;word-break:break-word}
.curstat{color:var(--fg-2);white-space:nowrap}
.state{white-space:nowrap;font-weight:700}

tr[data-state=pick] td,tr[data-state=dup] td,tr[data-state=failed] td,tr[data-state=dupinv] td,tr[data-state=badicg] td{background:var(--bad-tint)}
tr[data-state=pick] td:first-child,tr[data-state=dup] td:first-child,tr[data-state=failed] td:first-child,
tr[data-state=dupinv] td:first-child,tr[data-state=badicg] td:first-child{border-left-color:var(--bad)}
tr[data-state=pick] .state,tr[data-state=dup] .state,tr[data-state=failed] .state,tr[data-state=dupinv] .state,tr[data-state=badicg] .state{color:var(--bad)}
tr[data-state=status] td,tr[data-state=neednote] td,tr[data-state=dupicg] td{background:var(--need-tint)}
tr[data-state=status] td:first-child,tr[data-state=neednote] td:first-child,tr[data-state=dupicg] td:first-child{border-left-color:var(--need)}
tr[data-state=status] .state,tr[data-state=neednote] .state,tr[data-state=dupicg] .state{color:var(--need)}
tr[data-state=notfound] td,tr[data-state=skipped] td{background:var(--bg-2);color:var(--fg-2)}
tr[data-state=nochange] td{color:var(--fg-2)} tr[data-state=nochange] .state{font-weight:400}
tr[data-state=ready] .state{color:var(--ok)}
tr[data-state=done] td{background:var(--ok-tint)} tr[data-state=done] td:first-child{border-left-color:var(--ok)} tr[data-state=done] .state{color:var(--ok)}

/* attachment drop cells */
.afile{border:1px dashed var(--border-control);border-radius:var(--radius-1);padding:var(--space-2) var(--space-3);font-size:13px;color:var(--fg-2);
       cursor:pointer;text-align:center;min-width:160px;background:var(--bg-1)}
.afile+.afile{margin-top:var(--space-1)}
.afile.over{border:2px solid var(--nb-red);background:var(--bg-2)}
.afile.off{border-color:var(--border-subtle);color:var(--fg-3);cursor:default;background:transparent}
.afile.has{border-style:solid;border-color:var(--border-subtle);cursor:default;text-align:left}
.afile b{color:var(--fg-1);word-break:break-all}
.afile .x{appearance:none;background:none;border:0;color:var(--bad);cursor:pointer;margin-left:var(--space-2);font:700 13px/1 var(--font-body);padding:2px 4px}
.locked{opacity:.45;pointer-events:none}

@media (max-width:720px){
  .masthead{padding:var(--space-4)} .masthead h1{font-size:28px}
  .tabs{padding:0 var(--space-4);gap:var(--space-5);overflow-x:auto} main{padding:var(--space-4)}
}
</style></head>
<body>
<header class="masthead">
  <!--__LOGO__-->
  <div>
    <p class="overline">Accounts receivable</p>
    <h1>Collections</h1>
  </div>
</header>
<nav class="tabs" role="tablist" id="tabs"></nav>
<main id="panels"></main>
<script>
(function(){
  var B = window.__BOOT = __BOOT__;
  var G = { busy:false };                       // one job at a time across all tabs
  var $ = function(id){ return document.getElementById(id); };

  // ---------- helpers ----------
  function el(tag, props, kids){
    var e = document.createElement(tag);
    Object.keys(props||{}).forEach(function(k){
      if(k==='text') e.textContent = props[k];
      else if(k==='attrs') Object.keys(props.attrs).forEach(function(a){ e.setAttribute(a, props.attrs[a]); });
      else e[k] = props[k];
    });
    (kids||[]).forEach(function(c){ if(c) e.appendChild(typeof c==='string' ? document.createTextNode(c) : c); });
    return e;
  }
  function money(n){ return Number(n||0).toLocaleString('en-US',{style:'currency',currency:'USD'}); }
  function q(s){ return '"'+String(s==null?'':s).replace(/"/g,'""')+'"'; }
  function downloadCsv(lines, name){
    var a = el('a',{href:URL.createObjectURL(new Blob([lines.join('\r\n')],{type:'text/csv'})),download:name});
    document.body.appendChild(a); a.click(); a.remove();
  }
  function api(body){
    return fetch(window.location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){ return r.json(); })
      .then(function(j){ if(j.error) throw new Error(j.error); return j; });
  }
  function todayStamp(){ var d0 = new Date(); return (d0.getMonth()+1)+'/'+d0.getDate()+'/'+String(d0.getFullYear()).slice(-2); }
  function wireDrop(zone, input, onFile){
    zone.onclick = function(){ input.click(); };
    zone.onkeydown = function(e){ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); input.click(); } };
    input.onchange = function(){ if(input.files[0]) onFile(input.files[0]); input.value=''; };
    ['dragenter','dragover'].forEach(function(ev){ zone.addEventListener(ev,function(e){ e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave','drop'].forEach(function(ev){ zone.addEventListener(ev,function(e){ e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop',function(e){ if(e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
  }
  window.addEventListener('dragover',function(e){ e.preventDefault(); });
  window.addEventListener('drop',function(e){ e.preventDefault(); });
  window.addEventListener('beforeunload',function(e){ if(G.busy){ e.preventDefault(); e.returnValue=''; } });

  // ==== READERS (no external libraries) ====
  function decodeXml(s){
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,function(m,e){
      if(e==='amp') return '&'; if(e==='lt') return '<'; if(e==='gt') return '>';
      if(e==='quot') return '"'; if(e==='apos') return "'";
      return String.fromCodePoint(e.charAt(1)==='x' ? parseInt(e.slice(2),16) : parseInt(e.slice(1),10));
    });
  }
  function pad2(n){ return n<10 ? '0'+n : ''+n; }
  function isoFromSerial(serial){
    var d = new Date(Date.UTC(1899,11,30) + Math.floor(Number(serial))*86400000);
    return d.getUTCFullYear()+'-'+pad2(d.getUTCMonth()+1)+'-'+pad2(d.getUTCDate());
  }
  function colIndex(ref){
    var letters = /^[A-Z]+/.exec(ref)[0], n = 0;
    for(var i=0;i<letters.length;i++) n = n*26 + (letters.charCodeAt(i)-64);
    return n-1;
  }

  // CSV -> grid of {v,date}
  function readCsv(text, delim){
    delim = delim || ',';
    if(text.charCodeAt(0)===0xFEFF) text = text.slice(1);
    var rowsOut=[], row=[], cur='', inQ=false, i=0, c;
    function endCell(){ row.push({v:cur.trim(),date:''}); cur=''; }
    function endRow(){ endCell(); if(row.some(function(x){ return x.v!==''; })) rowsOut.push(row); row=[]; }
    for(;i<text.length;i++){
      c = text.charAt(i);
      if(inQ){
        if(c==='"'){ if(text.charAt(i+1)==='"'){ cur+='"'; i++; } else inQ=false; }
        else cur+=c;
      } else if(c==='"') inQ=true;
      else if(c===delim) endCell();
      else if(c==='\r'){ if(text.charAt(i+1)==='\n') i++; endRow(); }
      else if(c==='\n') endRow();
      else cur+=c;
    }
    if(cur!=='' || row.length) endRow();
    return rowsOut;
  }

  // XLSX / ZIP. Uses the browser's built-in DecompressionStream.
  function inflateRaw(u8){
    var ds = new DecompressionStream('deflate-raw');
    return new Response(new Blob([u8]).stream().pipeThrough(ds)).arrayBuffer().then(function(b){ return new Uint8Array(b); });
  }
  function readZip(buf){
    var u8 = new Uint8Array(buf), dv = new DataView(buf), entries = {}, eocd=-1, i;
    for(i=u8.length-22;i>=Math.max(0,u8.length-65557);i--){ if(dv.getUint32(i,true)===0x06054b50){ eocd=i; break; } }
    if(eocd<0) throw new Error('Not a valid .xlsx or .zip file');
    var count = dv.getUint16(eocd+10,true), p = dv.getUint32(eocd+16,true);
    for(i=0;i<count;i++){
      if(dv.getUint32(p,true)!==0x02014b50) throw new Error('Corrupt zip file');
      if(dv.getUint16(p+8,true) & 1) throw new Error('Password-protected zip files are not supported');
      var method=dv.getUint16(p+10,true), csize=dv.getUint32(p+20,true), nlen=dv.getUint16(p+28,true),
          xlen=dv.getUint16(p+30,true), clen=dv.getUint16(p+32,true), lho=dv.getUint32(p+42,true);
      var name = new TextDecoder().decode(u8.subarray(p+46,p+46+nlen));
      entries[name] = {method:method,csize:csize,lho:lho};
      p += 46+nlen+xlen+clen;
    }
    function getBytes(name){
      var e = entries[name]; if(!e) return Promise.resolve(null);
      if(e.method!==0 && e.method!==8) return Promise.reject(new Error('Unsupported zip compression'));
      var start = e.lho + 30 + dv.getUint16(e.lho+26,true) + dv.getUint16(e.lho+28,true);
      var data = u8.subarray(start,start+e.csize);
      return e.method===0 ? Promise.resolve(data) : inflateRaw(data);
    }
    function get(name){ return getBytes(name).then(function(b){ return b ? new TextDecoder().decode(b) : null; }); }
    return {get:get,getBytes:getBytes,has:function(n){ return !!entries[n]; },names:function(){ return Object.keys(entries); }};
  }
  function readXlsx(buf){
    var zip = readZip(buf), shared=[], dateStyle=[];
    function parseSheet(sheet){
      var cells={}, maxR=-1, maxC=-1;
      (sheet.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)||[]).forEach(function(cx){
        var ref=/\br="([A-Z]+)(\d+)"/.exec(cx); if(!ref) return;
        var t=(/\bt="([^"]+)"/.exec(cx)||[])[1], sidx=(/\bs="(\d+)"/.exec(cx)||[])[1];
        var vm=/<v>([\s\S]*?)<\/v>/.exec(cx), val='', date='';
        if(t==='inlineStr'){ (cx.match(/<t\b[^>]*>[\s\S]*?<\/t>/g)||[]).forEach(function(m){ val+=decodeXml(m.replace(/<[^>]+>/g,'')); }); }
        else if(vm){
          if(t==='s') val = shared[Number(vm[1])]||'';
          else if(t==='str'||t==='e') val = decodeXml(vm[1]);
          else if(t==='b') val = vm[1]==='1' ? 'TRUE' : 'FALSE';
          else if(sidx!==undefined && dateStyle[Number(sidx)]) date = isoFromSerial(vm[1]);
          else val = vm[1];
        }
        var r=Number(ref[2])-1, c=colIndex(ref[1]);
        cells[r+','+c]={v:String(val).trim(),date:date}; if(r>maxR) maxR=r; if(c>maxC) maxC=c;
      });
      var grid=[];
      for(var r=0;r<=maxR;r++){
        var row=[], any=false;
        for(var c=0;c<=maxC;c++){ var x=cells[r+','+c]||{v:'',date:''}; if(x.v||x.date) any=true; row.push(x); }
        if(any) grid.push(row);
      }
      return grid;
    }
    return zip.get('xl/sharedStrings.xml').then(function(x){
      if(x) (x.match(/<si\b[\s\S]*?<\/si>/g)||[]).forEach(function(si){
        var t=''; (si.match(/<t\b[^>]*>[\s\S]*?<\/t>/g)||[]).forEach(function(m){ t+=decodeXml(m.replace(/<[^>]+>/g,'')); });
        shared.push(t);
      });
      return zip.get('xl/styles.xml');
    }).then(function(x){
      if(x){
        var custom={}; (x.match(/<numFmt\b[^>]*>/g)||[]).forEach(function(m){
          var id=/numFmtId="(\d+)"/.exec(m), fc=/formatCode="([^"]*)"/.exec(m);
          if(id&&fc) custom[id[1]] = /[ymdhs]/i.test(decodeXml(fc[1]).replace(/"[^"]*"/g,'').replace(/\[[^\]]*\]/g,'').replace(/\\./g,''));
        });
        var blk = /<cellXfs\b[\s\S]*?<\/cellXfs>/.exec(x);
        (blk ? blk[0].match(/<xf\b[^>]*>/g)||[] : []).forEach(function(m){
          var id=/numFmtId="(\d+)"/.exec(m); var n = id ? Number(id[1]) : 0;
          dateStyle.push(custom[n]!==undefined ? custom[n] : ((n>=14&&n<=22)||(n>=45&&n<=47)));
        });
      }
      return zip.get('xl/workbook.xml');
    }).then(function(wb){
      return zip.get('xl/_rels/workbook.xml.rels').then(function(rels){
        var sheets=[];
        if(wb && rels){
          var relMap={};
          (rels.match(/<Relationship\b[^>]*>/g)||[]).forEach(function(m){
            var id=/\bId="([^"]+)"/.exec(m), t=/\bTarget="([^"]+)"/.exec(m);
            if(id&&t) relMap[id[1]] = t[1].charAt(0)==='/' ? t[1].slice(1) : 'xl/'+t[1];
          });
          (wb.match(/<sheet\b[^>]*>/g)||[]).forEach(function(m){
            var n=/\bname="([^"]*)"/.exec(m), r=/\br:id="([^"]+)"/.exec(m);
            if(n && r && relMap[r[1]]) sheets.push({name:decodeXml(n[1]),path:relMap[r[1]]});
          });
        }
        if(!sheets.length) sheets=[{name:'Sheet1',path:'xl/worksheets/sheet1.xml'}];
        // a sheet called "NS Import" wins; otherwise sheets are tried in order until one has data rows
        sheets.sort(function(a,b){ return (/ns import/i.test(b.name)?1:0) - (/ns import/i.test(a.name)?1:0); });
        var i=0;
        function next(){
          if(i>=sheets.length) return Promise.resolve([]);
          return zip.get(sheets[i++].path).then(function(x){ var g = x ? parseSheet(x) : []; return g.length>1 ? g : next(); });
        }
        return next();
      });
    });
  }

  // Text files from other systems are often UTF-16 (Excel/NetSuite exports); UTF-8 is the fallback.
  function decodeText(buf){
    var u = new Uint8Array(buf), i;
    if(u[0]===0xFF && u[1]===0xFE) return new TextDecoder('utf-16le').decode(u.subarray(2));
    if(u[0]===0xFE && u[1]===0xFF) return new TextDecoder('utf-16be').decode(u.subarray(2));
    var n = Math.min(u.length,200), zeros = 0;
    for(i=1;i<n;i+=2) if(u[i]===0) zeros++;
    if(n>=8 && zeros > (n/2)*0.8) return new TextDecoder('utf-16le').decode(u);   // UTF-16 without a BOM
    return new TextDecoder('utf-8').decode(u);
  }

  // A dropped file (or the file inside a .zip) -> grid. Handles .xlsx, .csv, .tsv/.txt and .zip.
  function gridFromBytes(name, buf){
    var n = String(name||'').toLowerCase();
    if(/\.xlsx$/.test(n)) return readXlsx(buf);
    if(/\.zip$/.test(n)) return readZipGrid(buf);
    if(/\.(csv|tsv|txt)$/.test(n)){
      var text = decodeText(buf);
      var first = text.split(/\r?\n/,1)[0], tabs = first.split('\t').length-1, commas = first.split(',').length-1;
      return Promise.resolve(readCsv(text, tabs>commas ? '\t' : ','));     // a ".csv" can really be tab-separated
    }
    return Promise.reject(new Error('Unsupported file type'));
  }
  function readZipGrid(buf){
    var z = readZip(buf);
    var names = z.names().filter(function(x){ return !/\/$/.test(x) && !/^__MACOSX\//.test(x) && /\.(xlsx|csv|tsv|txt)$/i.test(x); });
    if(!names.length) return Promise.reject(new Error('The zip does not contain an .xlsx, .csv or .tsv file'));
    return z.getBytes(names[0]).then(function(b){ return gridFromBytes(names[0], b.buffer.slice(b.byteOffset, b.byteOffset+b.byteLength)); });
  }

  function at(row,c){ return (c>=0 && row[c]) ? row[c] : {v:'',date:''}; }

  // text date (m/d/yyyy, yyyy-mm-dd, or an Excel serial) -> yyyy-mm-dd ('' if it is not a date)
  function isoFromAny(v){
    v = String(v||'').trim(); if(!v) return '';
    if(/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    if(/^\d{5}$/.test(v)) return isoFromSerial(v);
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
    if(m){ var y=Number(m[3]); if(y<100) y+=2000; return y+'-'+pad2(Number(m[1]))+'-'+pad2(Number(m[2])); }
    return '';
  }

  // ---- raw CASS export: same rules as the formatter workbook's "Notes" and "CAT Status" columns ----
  function cassNum(v){ var n=Number(v); return isNaN(n) ? String(v) : String(parseFloat(n.toPrecision(15))); }
  function cassDerive(g){
    var cut=String(g.cut||''), disp=String(g.disp||''), D=disp.toUpperCase(), paid=isoFromAny(g.paid), note='', date='';
    if(cut!=='') note = cut+' - Short paid  '+cassNum(g.diff);
    else if(D==='INVOICE REJECTED TO CARRIER.') note = disp;
    else if(paid!=='') date = paid;
    else if(D==='INVOICE ROUTED TO CUSTOMER.') note = disp;
    else if(D==='INVOICE CURRENTLY BEING AUDITED.') note = disp;
    else note = String(g.base||'')+' '+String(g.exp1||'');
    note = note.trim();
    var norm = note.replace(/\./g,'').trim().toUpperCase(), status;
    if(cut!=='') status='Balance Due';
    else if(!note && !date) status='Missing in CASS';
    else if(date) status='Approved for Pay';
    else if(norm==='INVOICE BEING AUDITED' || norm==='INVOICE CURRENTLY BEING AUDITED') status='Invoice being Audited';
    else if(norm==='INVOICE REJECTED TO CARRIER') status='Rejected';
    else if(norm==='INVOICE ROUTED TO CUSTOMER') status='Routed to Customer';
    else status='Look Into';
    return {note:note,date:date,status:status};
  }

  // A dropped notes file -> grid rows.
  //   opt.allowRaw  recognise the raw CASS export (Disposition + Cut Reason columns)
  //   opt.findKey   find the key column by its header (Invoice/Pro Number); otherwise column 1 is the key
  // Formatted layout: key | Collections Notes | Collections Status | Promised to Pay Date (found by header;
  // notes/status default to columns 2 and 3). A column with "billed" or "amount" in its header is shown for reference.
  function parseNotesGrid(grid, opt){
    if(!grid.length) return {error:'No data found in that file.'};
    var hdr = grid[0].map(function(c){ return c.v.toLowerCase(); });
    function idx(re){ return hdr.findIndex(function(h){ return re.test(h); }); }
    var raw = !!opt.allowRaw && idx(/^disposition$/)>=0 && idx(/^cut reason$/)>=0;
    var cKey = 0;
    if(raw || opt.findKey){ cKey = idx(/invoice\/pro/); if(cKey<0) cKey = idx(/pro number|^invoice/); if(cKey<0) cKey = idx(/pro|invoice/); if(cKey<0) cKey = 0; }
    var cAmt = idx(/billed/); if(cAmt<0) cAmt = idx(/amount/);
    var cNote=-1, cStat=-1, cDate=-1, cCut, cDiff, cDisp, cPaid, cBase, cExp, cNs, cProc;
    if(raw){
      cCut=idx(/^cut reason$/); cDiff=idx(/^diff$/); cDisp=idx(/^disposition$/); cPaid=idx(/^paid\/reject date$/);
      cBase=idx(/^base reason$/); cExp=idx(/^expanded reason 1$/); cNs=idx(/^ns status$/); cProc=idx(/^process\/reject date$/);
    } else {
      cNote = idx(/note/); if(cNote<0 || cNote===cKey) cNote = 1;
      cStat = idx(/status/); if(cStat<0 || cStat===cKey || cStat===cNote) cStat = 2;
      cDate = idx(/promis|pay\s*date/);
    }
    var out=[], ignored=0, firstIgnored='', badDates=0, anyBilled=false;
    for(var r=1;r<grid.length;r++){
      var row=grid[r], key=at(row,cKey).v.replace(/\.0+$/,'');
      if(!key) continue;
      if(raw && /\s/.test(key)){ ignored++; if(!firstIgnored) firstIgnored=key; continue; }   // not a CASS number
      var notes, payDate, statusText, cass='', procDate;
      if(raw){
        var pd = at(row,cPaid);
        var d = cassDerive({cut:at(row,cCut).v, diff:at(row,cDiff).v, disp:at(row,cDisp).v, paid:(pd.date||pd.v), base:at(row,cBase).v, exp1:at(row,cExp).v});
        notes = d.note; payDate = d.date; cass = d.status;
        var pr = at(row,cProc); procDate = pr.date || isoFromAny(pr.v);
        statusText = at(row,cNs).v || (opt.cassMap && opt.cassMap[d.status]) || '';
      } else {
        var nt = at(row,cNote), st = at(row,cStat), dt = at(row,cDate);
        notes = nt.v; statusText = st.v;
        payDate = dt.date || isoFromAny(dt.v) || nt.date || '';
        if(dt.v && !dt.date && !isoFromAny(dt.v)) badDates++;
      }
      var billed=null;
      if(cAmt>=0){
        var bv = at(row,cAmt).v;
        if(bv!==''){ var bn = Number(String(bv).replace(/[$,\s]/g,'').replace(/^\((.*)\)$/,'-$1')); if(!isNaN(bn)){ billed=bn; anyBilled=true; } }
      }
      if(payDate && !opt.hasPayDate){ notes = (notes ? notes+' - ' : '')+'Pay date '+payDate.slice(5,7)+'/'+payDate.slice(8,10)+'/'+payDate.slice(0,4); payDate=''; }
      out.push({n:r+1,pro:key,billed:billed,notes:notes,payDate:payDate,statusText:statusText,cass:cass,procDate:procDate,
                matches:[],chosen:'',statusId:'',skip:false,state:'',msg:''});
    }
    if(!out.length) return {error:'No data rows found.'};
    return {rows:out, raw:raw, ignored:ignored, firstIgnored:firstIgnored, badDates:badDates, hasBilled:anyBilled};
  }

  // A dropped ICG file -> rows. Two layouts:
  //   simple: "Invoice #", "ICG #"
  //   raw ICG export: "Freight Bill ID" is the ICG #, "Load Description" is the load = invoice number minus its letter
  function parseIcgGrid(grid){
    if(!grid.length) return {error:'No data found in that file.'};
    var hdr = grid[0].map(function(c){ return c.v.toLowerCase(); });
    function idx(re){ return hdr.findIndex(function(h){ return re.test(h); }); }
    var cFb = idx(/^freight bill id$/), cLoad = idx(/^load description$/), cTot = idx(/^actual total$/);
    var raw = cFb>=0 && cLoad>=0, cInv=-1, cIcg=-1;
    if(!raw){
      cInv = idx(/invoice/); cIcg = idx(/icg|cass/);
      if(cInv<0 || cIcg<0) return {error:'The file needs two columns named "Invoice #" and "ICG #", or be the raw ICG export (Freight Bill ID and Load Description).'};
    }
    var out=[], ign={total:0,na:0,blank:0,other:0};
    for(var r=1;r<grid.length;r++){
      var row = grid[r], inv, icg, total=null;
      if(raw){
        icg = at(row,cFb).v.replace(/\.0+$/,''); inv = at(row,cLoad).v;
        if(!icg && !inv) continue;
        if(!/^\d{5,}$/.test(inv) || /^0+$/.test(inv)){        // NA, blank, a route name, 000000 ... -> no load number to match
          ign.total++; if(inv==='') ign.blank++; else if(inv.toUpperCase()==='NA') ign.na++; else ign.other++;
          continue;
        }
        var tv = at(row,cTot).v;
        if(tv!==''){ var tn = Number(String(tv).replace(/[$,\s]/g,'')); if(!isNaN(tn)) total = tn; }
      } else {
        inv = at(row,cInv).v; icg = at(row,cIcg).v.replace(/\.0+$/,'');
        if(!inv && !icg) continue;
      }
      out.push({n:r+1,inv:inv,icg:icg,total:total,matches:[],chosen:'',skip:false,allowDup:false,state:'',msg:''});
    }
    if(!out.length) return {error: ign.total ? 'None of the '+ign.total+' rows has a usable Load Description, so nothing can be matched to an invoice.' : 'No data rows found.'};
    return {rows:out, raw:raw, ignored:ign};
  }
  // ==== END READERS ====

  function readInto(f, say, handler){
    if(G.busy) return say('Please wait until the current step finishes.', true);
    if(!/\.(xlsx|csv|tsv|txt|zip)$/i.test(f.name)) return say('Use an .xlsx, .csv or .tsv file, or a .zip export. Older .xls files: open in Excel and save as .xlsx.',true);
    say('Reading ' + f.name + ' ...');
    f.arrayBuffer().then(function(ab){ return gridFromBytes(f.name, ab); }).then(handler)
      .catch(function(err){ say('Could not read that file: '+err.message,true); });
  }

  // ===================================================================
  // STATUS / NOTES UPLOAD  (one instance per upload tab)
  //   P.scope     'all' | 'cat'  (server applies that scope's customer guard)
  //   P.lookup    true: the user chooses Invoice # (external ID) or Reference #; false: Reference # only
  //   P.raw       accept the raw CASS export
  // ===================================================================
  function StatusTool(root, P){
    var rows=[], filter='', notice='', lastGrid=null, hasBilled=false, widenCache={};
    var curBy = P.lookup ? 'extid' : 'ref';
    var append = B.noteMode[P.scope]==='append';
    var maxFiles = (B.attachMaxFiles && B.attachMaxFiles[P.scope]) || 1;
    var statusByName = {};
    B.statuses.forEach(function(s){ statusByName[s.name.toLowerCase()] = s.id; });

    // ---------- layout ----------
    var byExt, byRef;
    root.appendChild(el('div',{className:'panel-intro'},[el('h2',{text:P.title}), el('p',{text:P.intro})]));
    if(P.lookup){
      byExt = el('input',{type:'radio',name:P.key+'-by',checked:true});
      byRef = el('input',{type:'radio',name:P.key+'-by'});
      root.appendChild(el('fieldset',{className:'lookup'},[
        el('legend',{text:'Look up invoices by'}),
        el('label',{},[byExt,'Invoice # (external ID)']),
        el('label',{},[byRef,'Reference # (CASS #)'])
      ]));
    }
    var msg = el('div',{className:'msg',attrs:{role:'status','aria-live':'polite'}});
    var pick = el('input',{type:'file',accept:'.xlsx,.csv,.tsv,.txt,.zip'}); pick.hidden = true;
    var drop = el('div',{className:'drop',tabIndex:0,attrs:{role:'button','aria-label':'Choose the status file'}},
      [el('strong',{text:'Drop the status file here, or click to browse'}), el('span',{className:'hint',text:P.dropHint})]);
    var chips = el('div',{className:'chips'});
    var applyBtn = el('button',{type:'button',className:'btn primary',text:'Apply updates',disabled:true});
    var dlBtn = el('button',{type:'button',className:'btn secondary',text:'Download exceptions (CSV)'});
    var resetBtn = el('button',{type:'button',className:'btn ghost',text:'Start over'});
    var prog = el('progress',{value:0,max:1}); prog.hidden = true;
    var applyMsg = el('span',{className:'applymsg'});
    var thead = el('thead'), tb = el('tbody');
    var work = el('div',{},[chips, el('div',{className:'bar'},[applyBtn,dlBtn,resetBtn,prog,applyMsg]),
      el('div',{className:'tablewrap'},[el('table',{className:'grid'},[thead,tb])])]);
    work.hidden = true;
    [msg, drop, pick, work].forEach(function(n){ root.appendChild(n); });

    function say(t, isErr){ msg.textContent = t || ''; msg.className = 'msg'+(isErr ? ' err' : ''); }
    wireDrop(drop, pick, function(f){ readInto(f, say, ingest); });

    function keyName(){ return curBy==='ref' ? (P.refName || 'Reference #') : 'Invoice #'; }
    function byLabel(){ return curBy==='ref' ? keyName() : 'Invoice # (external ID)'; }

    function ingest(grid){
      lastGrid = grid;
      var res = parseNotesGrid(grid, {hasPayDate:B.hasPayDate, cassMap:B.cassStatusMap, allowRaw:P.raw, findKey:!P.lookup});
      if(res.error) return say(res.error,true);
      if(res.rows.length>B.maxRows) return say('The file has '+res.rows.length+' rows; the limit is '+B.maxRows+'.',true);
      hasBilled = res.hasBilled;
      notice = (res.ignored ? 'Ignored '+res.ignored+' row(s) with no usable CASS # (for example "'+res.firstIgnored+'"). ' : '')
             + (res.badDates ? res.badDates+' row(s) have a Promised to Pay Date that could not be read; those dates were ignored. ' : '');
      rows = res.rows; widenCache = {}; runMatch();
    }

    // ---------- match ----------
    function runMatch(){
      G.busy = true; say('Matching ' + rows.length + ' rows to open invoices by ' + byLabel() + ' ...');
      var keys = [], seenKey = {};
      rows.forEach(function(r){ if(!seenKey[r.pro]){ seenKey[r.pro]=true; keys.push(r.pro); } });
      var batches = []; for(var i=0;i<keys.length;i+=B.matchBatch) batches.push(keys.slice(i,i+B.matchBatch));
      var all = {};
      batches.reduce(function(p,b){
        return p.then(function(){
          return api({action:'match',scope:P.scope,by:curBy,rows:b.map(function(x){ return {pro:x}; })}).then(function(j){
            Object.keys(j.matches).forEach(function(k){ all[k]=j.matches[k]; });
          });
        });
      },Promise.resolve()).then(function(){
        rows.forEach(function(r){
          r.matches = all[r.pro] || [];
          if(r.matches.length===1) r.chosen = r.matches[0].id;
          var sid = statusByName[(r.statusText||'').toLowerCase()];
          if(sid) r.statusId = sid;
        });
        // Raw CASS repeats a number when a charge is cut and later re-billed. For a number that at most ONE invoice
        // carries, keep only the row with the most recent Process/Reject Date (a tie keeps the later row in the file).
        var groups={}, dropIdx={}, olderDropped=0;
        rows.forEach(function(r,i){ if(r.procDate!==undefined && r.matches.length<=1){ (groups[r.pro]=groups[r.pro]||[]).push(i); } });
        Object.keys(groups).forEach(function(k){
          var g=groups[k]; if(g.length<2) return;
          var best=g[0]; g.forEach(function(i){ if(rows[i].procDate >= rows[best].procDate) best=i; });
          g.forEach(function(i){ if(i!==best){ dropIdx[i]=true; olderDropped++; } });
        });
        rows = rows.filter(function(r,i){ return !dropIdx[i]; });
        // identical repeats (same key, amount, note, date, status) of a key that at most ONE invoice carries are merged;
        // keys carried by several invoices keep every row so each invoice can still be picked.
        var seen={}, kept=[], merged=0;
        rows.forEach(function(r){
          var key=[r.pro,r.billed,r.notes,r.payDate,r.statusText].join('\u0001');
          if(r.matches.length<=1){ if(seen[key]){ merged++; return; } seen[key]=true; }
          kept.push(r);
        });
        rows = kept;
        G.busy=false;
        var hits = rows.filter(function(r){ return r.matches.length; }).length;
        var none = hits===0 ? 'No open invoices matched by '+byLabel()+'.'+(P.lookup ? ' Check that the "Look up invoices by" choice fits the first column of your file. ' : ' ') : '';
        say(notice + none + (olderDropped ? 'Repeated CASS #s: kept the most recent Process/Reject Date, dropped '+olderDropped+' older row(s). ' : '')
                   + (merged ? 'Merged '+merged+' identical repeated row(s).' : ''), !!none);
        build();
      }).catch(function(e){ G.busy=false; say(e.message,true); });
    }

    // ---------- row rules ----------
    // Promised to Pay Date: filled from the file's date, but only for rows whose status is Approved for Pay
    // (the New status if one is chosen, otherwise the invoice's current status).
    function matchOf(r){ return r.matches.filter(function(m){ return m.id===r.chosen; })[0]; }
    function statusNameOf(r){
      var m = matchOf(r), id = r.statusId || (m ? m.statusId : ''), name = '';
      B.statuses.forEach(function(x){ if(x.id===id) name = x.name; });
      return name;
    }
    function effPayDate(r){ return (B.hasPayDate && r.payDate && statusNameOf(r)==='Approved for Pay') ? r.payDate : ''; }
    function dateWrite(r){ var m = matchOf(r), d = effPayDate(r); return (m && d && d!==m.payDate) ? d : ''; }
    // append mode: a note that is already a line of the existing text counts as there (same rule as the server)
    function noteHasLine(existing, add){
      var a = String(add||'').trim(); if(!a) return true;
      return String(existing||'').split(/\r?\n/).some(function(l){ return l.trim()===a; });
    }
    function noteChange(r,m){
      if(!r.notes || !m) return false;
      return append ? !noteHasLine(m.lastNote, r.notes) : r.notes!==m.lastNote;
    }
    function dupCount(){
      var c = {}; rows.forEach(function(r){ if(r.chosen && !r.skip) c[r.chosen]=(c[r.chosen]||0)+1; }); return c;
    }
    function changed(r){
      var m = matchOf(r); if(!m) return false;
      return (r.statusId && r.statusId!==m.statusId) || dateWrite(r) || noteChange(r,m) || r.sendBD || r.resendInv;
    }
    function stateOf(r,dups){
      if(r.state==='done'||r.state==='failed') return r.state;
      if(r.skip) return 'skipped';
      if(!r.matches.length) return 'notfound';
      if(!r.chosen) return 'pick';
      var m = matchOf(r);
      if(!r.statusId && !m.statusId) return 'status';                                                   // only when the invoice has none
      if(!r.notes && !m.lastNote && !r.sendBD && !r.resendInv && !dateWrite(r)) return 'neednote';    // a date being written counts as the update
      if(dups[r.chosen]>1) return 'dup';
      return changed(r) ? 'ready' : 'nochange';
    }
    var PROBLEM = {pick:1,status:1,neednote:1,dup:1};
    var LABEL = {pick:'Choose invoice',status:'Needs status',neednote:'Needs note',dup:'Same invoice picked twice - choose the right invoice',
                 ready:'Ready',nochange:'No change',notfound:'No open invoice found',skipped:'Skipped',done:'Updated',failed:'Failed'};
    function labelOf(st){ return (st==='dup' && curBy==='extid') ? 'Same invoice listed twice - skip one of the rows' : LABEL[st]; }

    // When two file rows land on the same invoice, load EVERY invoice carrying that number
    // (open or not) into the Invoice dropdown so the user can pick the right one per row.
    function widen(pro){
      if(curBy==='extid' || widenCache[pro]) return;   // an external ID is unique, so there is nothing to widen
      widenCache[pro] = api({action:'matchall',scope:P.scope,by:curBy,rows:[{pro:pro}]}).then(function(j){
        var list = j.matches[pro] || [];
        rows.forEach(function(x){
          if(x.pro!==pro) return;
          list.forEach(function(inv){ if(!x.matches.some(function(m){ return m.id===inv.id; })) x.matches.push(inv); });
          if(x.matches.length>1) fillInvoiceCells(x);
        });
        refresh();
      }).catch(function(e){ say('Could not load the other invoices for '+pro+': '+e.message,true); });
    }

    // ---------- per-row attachments (used when Send balance due OR Resend invoice is ticked) ----------
    var ATTACH_OK = /\.(pdf|jpe?g|png|docx?|xlsx?)$/i, ATTACH_MAX = 5 * 1024 * 1024;
    function sizeText(n){ return n >= 1048576 ? (n/1048576).toFixed(1)+' MB' : Math.max(1,Math.round(n/1024))+' KB'; }
    function attachTotal(r){ return (r.attachments||[]).reduce(function(s,a){ return s+a.size; },0); }
    function renderFileCell(r){
      var c = r.fileCell; c.innerHTML='';
      var word = maxFiles>1 ? 'files' : 'a file';
      if(!(r.sendBD || r.resendInv)){ c.appendChild(el('div',{className:'afile off',text:'Attach '+word+' to send with the invoice'})); return; }
      r.attachments.forEach(function(a,i){
        var x = el('button',{type:'button',className:'x',text:'x',title:'Remove',attrs:{'aria-label':'Remove '+a.name}});
        x.onclick=function(){ r.attachments.splice(i,1); renderFileCell(r); };
        c.appendChild(el('div',{className:'afile has'},[el('b',{text:a.name}),' ('+sizeText(a.size)+')',x]));
      });
      if(r.attachments.length >= maxFiles){
        if(maxFiles>1) c.appendChild(el('span',{className:'hint',text:'Maximum of '+maxFiles+' files'}));
        return;
      }
      var z = el('div',{className:'afile',tabIndex:0,attrs:{role:'button'},text: r.attachments.length ? 'Add more files' : 'Attach '+word+' to send with the invoice'});
      var inp = el('input',{type:'file',multiple:maxFiles>1,accept:'.pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx'}); inp.hidden = true;
      z.onclick=function(){ inp.click(); };
      z.onkeydown=function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); inp.click(); } };
      inp.onchange=function(){ takeAttach(r,inp.files); };
      ['dragenter','dragover'].forEach(function(ev){ z.addEventListener(ev,function(e){ e.preventDefault(); e.stopPropagation(); z.classList.add('over'); }); });
      ['dragleave','drop'].forEach(function(ev){ z.addEventListener(ev,function(e){ e.preventDefault(); e.stopPropagation(); z.classList.remove('over'); }); });
      z.addEventListener('drop',function(e){ takeAttach(r,e.dataTransfer.files); });
      c.appendChild(z); c.appendChild(inp);
    }
    function readB64(f){
      return new Promise(function(resolve,reject){
        var rd = new FileReader();
        rd.onload = function(){ resolve({name:f.name,size:f.size,b64:String(rd.result).split(',')[1]}); };
        rd.onerror = function(){ reject(new Error('Could not read '+f.name)); };
        rd.readAsDataURL(f);
      });
    }
    function takeAttach(r,list){
      var files = Array.prototype.slice.call(list||[]); if(!files.length) return;
      var room = maxFiles - r.attachments.length, total = attachTotal(r), pending = [], problems = [];
      files.forEach(function(f){
        if(r.attachments.some(function(a){ return a.name===f.name && a.size===f.size; }) ||
           pending.some(function(p){ return p.name===f.name && p.size===f.size; })) return;           // same file dropped twice
        if(!ATTACH_OK.test(f.name)){ problems.push(f.name+' (not PDF, JPG, PNG, Word or Excel)'); return; }
        if(f.size > ATTACH_MAX){ problems.push(f.name+' ('+sizeText(f.size)+'; limit 5 MB each)'); return; }
        if(pending.length >= room){ problems.push(f.name+' (limit of '+maxFiles+' file'+(maxFiles>1?'s':'')+' per invoice)'); return; }
        if(total + f.size > B.attachMaxTotal){ problems.push(f.name+' (would pass the '+sizeText(B.attachMaxTotal)+' total limit)'); return; }
        total += f.size; pending.push(f);
      });
      Promise.all(pending.map(readB64)).then(function(done){
        done.forEach(function(a){ r.attachments.push(a); });
        say(problems.length ? 'Not added: '+problems.join('; ') : '', problems.length>0);
        renderFileCell(r);
      }).catch(function(e){ say(e.message,true); });
    }

    // ---------- grid ----------
    function build(){
      work.hidden = false;
      var heads = [['Skip','ctr'],[keyName()+' (file)'],['Invoice'],['Bill-To'],['Open amount','num']];
      if(hasBilled) heads.push([P.billedHead,'num']);
      heads.push(['Current note'],[append ? 'Note to add' : 'New note'],['Current status'],['New status']);
      if(B.hasPayDate) heads.push(['Promised to pay']);
      heads.push(['State'],['Send balance due','ctr'],['Resend invoice','ctr'],[maxFiles>1 ? 'Attachments' : 'Attachment']);
      thead.innerHTML='';
      thead.appendChild(el('tr',{},heads.map(function(h){ return el('th',{className:h[1]||'',text:h[0],attrs:{scope:'col'}}); })));

      tb.innerHTML='';
      rows.forEach(function(r){
        var tr = el('tr'); r.tr = tr;
        r.attachments = [];
        r.skipBox = el('input',{type:'checkbox',attrs:{'aria-label':'Skip row '+r.n}}); r.skipBox.onchange=function(){ r.skip=r.skipBox.checked; refresh(); };

        // cells that refresh()/fillInvoiceCells() update later
        r.invCell = el('td'); r.custCell = el('td'); r.amtCell = el('td',{className:'num'});
        r.curNoteCell = el('td',{className:'curnote'}); r.curStatCell = el('td',{className:'curstat'});
        r.stateCell = el('td',{className:'state'});
        r.billedCell = el('td',{className:'num',text: r.billed==null ? '' : money(r.billed)});   // reference only, straight from the file
        r.sendBox = el('input',{type:'checkbox',attrs:{'aria-label':'Send balance due'}});
        r.resendBox = el('input',{type:'checkbox',attrs:{'aria-label':'Resend invoice'}});
        r.fileCell = el('td');
        r.resendBox.onchange=function(){
          r.resendInv=r.resendBox.checked;
          if(r.resendInv){ r.sendBD=false; r.sendBox.checked=false; }        // only one of the two
          if(!r.sendBD && !r.resendInv) r.attachments=[];
          renderFileCell(r); refresh();
        };
        r.sendBox.onchange=function(){
          r.sendBD=r.sendBox.checked;
          if(r.sendBD){ r.resendInv=false; r.resendBox.checked=false; }
          if(!r.sendBD && !r.resendInv) r.attachments=[];
          renderFileCell(r); refresh();
        };
        fillInvoiceCells(r);

        var ni = el('input',{type:'text',className:'note',value:r.notes,
                             title: append ? 'Added below the invoice\'s existing note' : 'Replaces the invoice\'s note'});
        ni.oninput=function(){ r.notes=ni.value; refresh(); };

        var sel = el('select'); sel.appendChild(el('option',{value:'',text:'Select'}));
        B.statuses.forEach(function(s){ sel.appendChild(el('option',{value:s.id,text:s.name})); });
        sel.value = r.statusId; sel.onchange=function(){ r.statusId=sel.value; refresh(); };
        r.statusSel = sel;
        var tdS = el('td',{},[sel]);
        if(r.statusText && !r.statusId) tdS.appendChild(el('span',{className:'hint',text:'File says: '+r.statusText+' (not in the list)'}));
        if(r.cass) tdS.appendChild(el('span',{className:'hint',text:'CASS: '+r.cass}));

        [el('td',{className:'ctr'},[r.skipBox]), el('td',{text:r.pro}), r.invCell, r.custCell, r.amtCell]
          .concat(hasBilled ? [r.billedCell] : [])
          .concat([r.curNoteCell, el('td',{},[ni]), r.curStatCell, tdS]).forEach(function(td){ tr.appendChild(td); });
        if(B.hasPayDate){
          var di = el('input',{type:'date',value:r.payDate}); di.onchange=function(){ r.payDate=di.value; refresh(); };
          r.dateInput = di;
          tr.appendChild(el('td',{},[di]));
        }
        tr.appendChild(r.stateCell);
        tr.appendChild(el('td',{className:'ctr'},[r.sendBox]));
        tr.appendChild(el('td',{className:'ctr'},[r.resendBox]));
        tr.appendChild(r.fileCell); renderFileCell(r);
        tb.appendChild(tr);
      });
      refresh();
    }

    function fillInvoiceCells(r){
      r.invCell.innerHTML='';
      if(!r.matches.length){ r.invCell.textContent='-'; r.custCell.textContent=''; r.amtCell.textContent=''; r.curStatCell.textContent=''; r.curNoteCell.textContent=''; return; }
      if(r.matches.length===1){
        var m=r.matches[0];
        r.invCell.appendChild(el('a',{href:'/app/accounting/transactions/custinvc.nl?id='+m.id,target:'_blank',text:m.tranid}));
        return;
      }
      var s = el('select'); s.appendChild(el('option',{value:'',text:r.matches.length+' matches: choose'}));
      r.matches.forEach(function(m){
        s.appendChild(el('option',{value:m.id,text:m.tranid+' | '+m.billTo+' | '+money(m.amountRemaining)+' | '+m.date+(m.invStatus && m.invStatus!=='Open' ? ' | '+m.invStatus : '')}));
      });
      s.value=r.chosen; s.onchange=function(){ r.chosen=s.value; refresh(); };
      r.invCell.appendChild(s);
    }

    function refresh(){
      var dups = dupCount(), counts = {pick:0,status:0,neednote:0,dup:0,ready:0,nochange:0,notfound:0,skipped:0,done:0,failed:0};
      rows.forEach(function(r){
        var m = matchOf(r);
        r.custCell.textContent = m ? m.billTo : '';
        r.amtCell.textContent = m ? money(m.amountRemaining) : '';
        r.curStatCell.textContent = m ? (m.statusText || '(none)') : '';
        r.curNoteCell.textContent = m ? (m.lastNote || '(none)') : '';
        r.curNoteCell.title = m ? (m.lastNote || '') : '';
        r.statusSel.options[0].text = (m && m.statusId) ? 'No change' : 'Select';
        var st = stateOf(r,dups); counts[st]++;
        if(st==='dup') widen(r.pro);
        if(r.dateInput){
          var ok = statusNameOf(r)==='Approved for Pay';
          r.dateInput.disabled = !ok;
          r.dateInput.title = ok ? '' : 'Only used when the status is Approved for Pay';
        }
        r.sendBox.disabled = !r.chosen || r.skip || st==='done' || st==='failed' || st==='notfound';
        r.resendBox.disabled = r.sendBox.disabled;
        r.fileCell.className = (st==='done' || st==='failed' || st==='skipped' || st==='notfound') ? 'locked' : '';
        r.tr.setAttribute('data-state', st);
        r.stateCell.textContent = labelOf(st) + (r.msg ? ' - '+r.msg : '');
        r.tr.hidden = !!filter && filter!==st && !(filter==='problem' && PROBLEM[st]);
      });
      var blockers = counts.pick+counts.status+counts.neednote+counts.dup;
      chips.innerHTML='';
      [['problem','Needs attention',blockers,'bad'],['pick','Choose invoice',counts.pick,'bad'],['dup','Picked twice',counts.dup,'bad'],
       ['status','Needs status',counts.status,'need'],['neednote','Needs note',counts.neednote,'need'],
       ['ready','Ready',counts.ready,'ok'],['nochange','No change',counts.nochange,''],['notfound','Not found',counts.notfound,''],
       ['skipped','Skipped',counts.skipped,''],['done','Updated',counts.done,'ok'],['failed','Failed',counts.failed,'bad']]
      .forEach(function(c){
        if(c[0]!=='problem' && !c[2]) return;
        var d = el('button',{type:'button',className:'chip '+c[3],attrs:{'aria-pressed':String(filter===c[0])}},[el('b',{text:String(c[2])}),c[1]]);
        d.onclick=function(){ filter = (filter===c[0]) ? '' : c[0]; refresh(); };
        chips.appendChild(d);
      });
      var sends = rows.filter(function(r){ return stateOf(r,dups)==='ready' && r.sendBD; }).length;
      var resends = rows.filter(function(r){ return stateOf(r,dups)==='ready' && r.resendInv; }).length;
      applyBtn.disabled = G.busy || blockers>0 || counts.ready===0;
      applyMsg.textContent = blockers ? (blockers+' row(s) still need attention, or tick Skip.')
        : (counts.ready+' invoice(s) will be updated'+(sends ? ', '+sends+' balance due notice(s) emailed' : '')+(resends ? ', '+resends+' invoice(s) resent' : '')+'.');
    }

    // ---------- apply ----------
    applyBtn.onclick = function(){
      var dups = dupCount();
      var todo = rows.filter(function(r){ return stateOf(r,dups)==='ready'; });
      if(!todo.length) return;
      var sendRows = todo.filter(function(r){ return r.sendBD; });
      var resendRows = todo.filter(function(r){ return r.resendInv; });
      var withFiles = todo.filter(function(r){ return (r.sendBD || r.resendInv) && r.attachments.length; });
      var fileCount = withFiles.reduce(function(s,r){ return s + r.attachments.length; },0);
      var today = todayStamp();
      var already = sendRows.filter(function(r){ var m=matchOf(r); return m.lastNote.indexOf('Balance due sent')>=0 && m.lastNote.indexOf(today)>=0; }).length;
      var alreadyRe = resendRows.filter(function(r){ var m=matchOf(r); return m.lastNote.indexOf('Invoice resent')>=0 && m.lastNote.indexOf(today)>=0; }).length;
      var text = 'Update '+todo.length+' invoice(s) in NetSuite?\n\n'
               + (append ? 'Notes are added below each invoice\'s existing note.' : 'Notes replace each invoice\'s existing note.');
      if(sendRows.length) text += '\n\nThis will also EMAIL a balance due notice to the customer for '+sendRows.length+' invoice(s).';
      if(already) text += '\nNote: '+already+' of those already show a balance due sent today.';
      if(resendRows.length) text += '\n\nThis will also RESEND the invoice by email for '+resendRows.length+' invoice(s).';
      if(alreadyRe) text += '\nNote: '+alreadyRe+' of those already show an invoice resent today.';
      if(withFiles.length) text += '\n\n'+withFiles.length+' email(s) will include attached files ('+fileCount+' in total).';
      if(!confirm(text)) return;
      G.busy=true; applyBtn.disabled=true; prog.hidden=false; prog.max=todo.length; prog.value=0;

      // 1. save attachments first (one request per file); a row where any attachment fails is NOT sent and NOT updated
      if(withFiles.length) say('Uploading attachments ...');
      var up = Promise.resolve();
      withFiles.forEach(function(r){
        r.fileIds = [];
        r.attachments.forEach(function(a){
          up = up.then(function(){
            if(r.state==='failed') return;
            return api({action:'upload',scope:P.scope,id:r.chosen,name:a.name,b64:a.b64})
              .then(function(j){ r.fileIds.push(j.fileId); })
              .catch(function(e){ r.state='failed'; r.msg='Attachment upload failed ('+a.name+') - nothing was sent or updated: '+e.message; });
          });
        });
      });

      // 2. update / send in batches; a send is slower, so it counts as several invoices per request
      up.then(function(){
        say('');
        todo = todo.filter(function(r){ return r.state!=='failed'; });
        refresh();
        var batches=[], cur=[], w=0;
        todo.forEach(function(r){
          var wt = ((r.sendBD ? B.sendWeight : 0) + (r.resendInv ? B.sendWeight : 0)) || 1;
          if(cur.length && w+wt>B.commitBatch){ batches.push(cur); cur=[]; w=0; }
          cur.push(r); w+=wt;
        });
        if(cur.length) batches.push(cur);
        var doneCount=0;
        return batches.reduce(function(p,b){
          return p.then(function(){
            var items = b.map(function(r){
              var m = matchOf(r);
              return {id:r.chosen,statusId:r.statusId,payDate:dateWrite(r),note:r.notes,
                      sendBD:!!r.sendBD, resendInv:!!r.resendInv,
                      baseNote:(r.notes || m.lastNote || ''),        // used when notes replace
                      fileIds:(r.fileIds || []),
                      setStatus:!!(r.statusId && r.statusId!==m.statusId),
                      setDate:!!dateWrite(r),
                      addNote:noteChange(r,m)};
            });
            return api({action:'commit',scope:P.scope,items:items}).then(function(j){
              j.results.forEach(function(res,idx){
                var r=b[idx], errs=[];
                if(res.sendError) errs.push('balance due NOT sent: '+res.sendError);
                if(res.resendError) errs.push('invoice NOT resent: '+res.resendError);
                if(res.ok && errs.length){ r.state='failed'; r.msg='Updated, but '+errs.join('; '); }
                else if(res.ok){ r.state='done'; r.msg=[res.sent?'balance due sent':'', res.resent?'invoice resent':''].filter(Boolean).join(', '); }
                else { r.state='failed'; r.msg=res.error; }
              });
              doneCount+=b.length; prog.value=doneCount; refresh();
            });
          });
        },Promise.resolve());
      }).catch(function(e){
        say('Stopped: '+e.message+' Rows already marked Updated were saved; nothing was retried.',true);
      }).then(function(){ G.busy=false; prog.hidden=true; refresh(); });
    };

    // ---------- exceptions / results CSV ----------
    dlBtn.onclick = function(){
      var dups = dupCount();
      var lines = [['Row',keyName(),'Notes','Status in file','Result'].join(',')];
      rows.forEach(function(r){
        var st = stateOf(r,dups);
        if(st==='nochange'||st==='ready') return;
        lines.push([r.n,r.pro,r.notes,r.statusText,labelOf(st)+(r.msg?' - '+r.msg:'')].map(q).join(','));
      });
      downloadCsv(lines, P.csvName);
    };
    resetBtn.onclick = function(){ if(G.busy) return; rows=[]; lastGrid=null; filter=''; work.hidden=true; say(''); };

    // ---------- lookup choice ----------
    // Changing the choice re-matches the loaded file (grid edits are discarded). Locked once rows were applied.
    function chooseBy(){
      var want = byRef.checked ? 'ref' : 'extid';
      if(want===curBy) return;
      var applied = rows.some(function(r){ return r.state==='done' || r.state==='failed'; });
      if(G.busy || applied){
        byExt.checked = curBy==='extid'; byRef.checked = curBy==='ref';
        return say(G.busy ? 'Please wait until the current step finishes.' : 'Some rows were already applied. Click Start over before changing the lookup.', true);
      }
      curBy = want; widenCache = {};
      if(rows.length && lastGrid) ingest(lastGrid);
    }
    if(P.lookup){ byExt.onchange = chooseBy; byRef.onchange = chooseBy; }
  }

  // ===================================================================
  // ICG # IMPORT  (CAT invoices only)
  // ===================================================================
  function IcgTool(root){
    var ICG_OK = /^[A-Za-z0-9._\-]{1,40}$/;
    var icgRows=[], icgHolders={}, icgFilter='', icgRaw=false, icgNotice='';

    root.appendChild(el('div',{className:'panel-intro'},[el('h2',{text:'ICG # import'}),
      el('p',{text:'Overwrites the CASS # on CAT invoices with the ICG #. Duplicates are flagged before anything is saved.'})]));
    var msg = el('div',{className:'msg',attrs:{role:'status','aria-live':'polite'}});
    var pick = el('input',{type:'file',accept:'.zip,.xlsx,.csv,.tsv,.txt'}); pick.hidden = true;
    var drop = el('div',{className:'drop',tabIndex:0,attrs:{role:'button','aria-label':'Choose the ICG file'}},
      [el('strong',{text:'Drop the ICG # file here, or click to browse'}),
       el('span',{className:'hint',text:'The raw ICG export (Freight Bill ID + Load Description), or a file with the columns Invoice # and ICG #. .csv, .tsv, .xlsx or .zip.'})]);
    var chips = el('div',{className:'chips'});
    var applyBtn = el('button',{type:'button',className:'btn primary',text:'Apply ICG # updates',disabled:true});
    var dlBtn = el('button',{type:'button',className:'btn secondary',text:'Download results (CSV)'});
    var resetBtn = el('button',{type:'button',className:'btn ghost',text:'Start over'});
    var prog = el('progress',{value:0,max:1}); prog.hidden = true;
    var applyMsg = el('span',{className:'applymsg'});
    var tb = el('tbody');
    var thead = el('thead',{},[el('tr',{},[['Skip','ctr'],['Invoice #'],['Bill-To'],['Current CASS #'],['New CASS #'],['State'],['Allow duplicate','ctr']]
      .map(function(h){ return el('th',{className:h[1]||'',text:h[0],attrs:{scope:'col'}}); }))]);
    var work = el('div',{},[chips, el('div',{className:'bar'},[applyBtn,dlBtn,resetBtn,prog,applyMsg]),
      el('div',{className:'tablewrap'},[el('table',{className:'grid'},[thead,tb])])]);
    work.hidden = true;
    [msg, drop, pick, work].forEach(function(n){ root.appendChild(n); });

    function say(t, isErr){ msg.textContent = t || ''; msg.className = 'msg'+(isErr ? ' err' : ''); }
    wireDrop(drop, pick, function(f){ readInto(f, say, icgIngest); });

    function icgIngest(grid){
      var res = parseIcgGrid(grid);
      if(res.error) return say(res.error,true);
      if(res.rows.length>B.maxRows) return say('The file has '+res.rows.length+' rows; the limit is '+B.maxRows+'.',true);
      var g = res.ignored;
      icgNotice = (g && g.total) ? 'Ignored '+g.total+' row(s) with no usable Load Description ('+[g.na?g.na+' NA':'', g.blank?g.blank+' blank':'', g.other?g.other+' other':''].filter(Boolean).join(', ')+'). ' : '';
      icgRaw = res.raw; icgRows = res.rows; icgRunMatch();
    }

    function icgRunMatch(){
      G.busy=true; say('Looking up '+icgRows.length+' invoices ...');
      var batches=[]; for(var i=0;i<icgRows.length;i+=B.matchBatch) batches.push(icgRows.slice(i,i+B.matchBatch));
      var all={}, holders={};
      batches.reduce(function(p,b){
        return p.then(function(){
          return api({action:'icgmatch',byLoad:icgRaw,rows:b.map(function(r){ return {inv:r.inv,icg:r.icg}; })}).then(function(j){
            Object.keys(j.matches).forEach(function(k){ all[k]=j.matches[k]; });
            Object.keys(j.holders).forEach(function(k){
              holders[k] = holders[k] || [];
              j.holders[k].forEach(function(h){ if(!holders[k].some(function(x){ return x.id===h.id; })) holders[k].push(h); });
            });
          });
        });
      },Promise.resolve()).then(function(){
        icgRows.forEach(function(r){ r.matches = all[r.inv] || []; if(r.matches.length===1) r.chosen = r.matches[0].id; });
        icgHolders = holders; G.busy=false; say(icgNotice); icgBuild();
      }).catch(function(e){ G.busy=false; say(e.message,true); });
    }

    function icgM(r){ return r.matches.filter(function(m){ return m.id===r.chosen; })[0]; }
    function icgCtx(){
      var c = {invCount:{},byIcg:{},target:{}};
      icgRows.forEach(function(r){
        if(r.skip || !r.chosen) return;
        c.invCount[r.chosen] = (c.invCount[r.chosen]||0)+1;
        (c.byIcg[r.icg] = c.byIcg[r.icg] || []).push(r);
        c.target[r.chosen] = r.icg;
      });
      return c;
    }
    // why a new ICG # counts as a duplicate: same number on another row of this file, or already on another CAT invoice
    function icgDupWhy(r,c){
      var why=[];
      (c.byIcg[r.icg]||[]).forEach(function(o){ if(o!==r && o.chosen!==r.chosen) why.push('also row '+o.n+' in this file'); });
      (icgHolders[r.icg]||[]).forEach(function(h){
        if(h.id===r.chosen) return;
        if(c.target[h.id]!==undefined && c.target[h.id]!==r.icg) return;   // that invoice is getting a different number in this run
        why.push('already on invoice '+h.tranid+(h.invStatus && h.invStatus!=='Open' ? ' ('+h.invStatus+')' : ''));
      });
      return why;
    }
    function icgState(r,c){
      if(r.state==='done' || r.state==='failed') return r.state;
      if(r.skip) return 'skipped';
      if(!ICG_OK.test(r.icg)) return 'badicg';
      if(!r.matches.length) return 'notfound';
      if(!r.chosen) return 'pick';
      if(c.invCount[r.chosen]>1) return 'dupinv';
      if(icgM(r).refNow===r.icg) return 'nochange';
      if(!r.allowDup && icgDupWhy(r,c).length) return 'dupicg';
      return 'ready';
    }
    var ILABEL = {ready:'Ready',nochange:'No change',notfound:'No CAT invoice with that number',pick:'Choose invoice',
                  dupinv:'Same invoice listed twice',dupicg:'Duplicate ICG #',badicg:'ICG # missing or invalid',
                  skipped:'Skipped',done:'Updated',failed:'Failed'};
    var IPROB = {pick:1,dupinv:1,dupicg:1,badicg:1};

    function icgBuild(){
      work.hidden = false;
      tb.innerHTML='';
      icgRows.forEach(function(r){
        var tr = el('tr'); r.tr = tr;
        r.skipBox = el('input',{type:'checkbox',attrs:{'aria-label':'Skip row '+r.n}}); r.skipBox.onchange=function(){ r.skip=r.skipBox.checked; icgRefresh(); };
        r.cInv = el('td'); r.cBill = el('td'); r.cRef = el('td');
        r.cIcg = el('td',{text:r.icg}); r.cState = el('td',{className:'state'});
        r.allowBox = el('input',{type:'checkbox',attrs:{'aria-label':'Allow duplicate'}}); r.allowBox.onchange=function(){ r.allowDup=r.allowBox.checked; icgRefresh(); };
        if(!r.matches.length) r.cInv.textContent = r.inv;
        else if(r.matches.length===1){
          r.cInv.appendChild(el('a',{href:'/app/accounting/transactions/custinvc.nl?id='+r.matches[0].id,target:'_blank',text:r.matches[0].tranid}));
        } else {
          var sel = el('select'); sel.appendChild(el('option',{value:'',text:r.matches.length+' matches: choose'}));
          r.matches.forEach(function(m){ sel.appendChild(el('option',{value:m.id,text:m.tranid+' | '+m.billTo+' | '+money(m.amountRemaining)+' | '+m.invStatus})); });
          sel.value = r.chosen; sel.onchange=function(){ r.chosen=sel.value; icgRefresh(); };
          r.cInv.appendChild(sel);
        }
        [el('td',{className:'ctr'},[r.skipBox]), r.cInv, r.cBill, r.cRef, r.cIcg, r.cState, el('td',{className:'ctr'},[r.allowBox])]
          .forEach(function(td){ tr.appendChild(td); });
        tb.appendChild(tr);
      });
      icgRefresh();
    }

    function icgRefresh(){
      var c = icgCtx(), counts = {};
      icgRows.forEach(function(r){
        var m = icgM(r), st = icgState(r,c); counts[st] = (counts[st]||0)+1;
        r.cBill.textContent = m ? m.billTo : '';
        r.cRef.textContent  = m ? (m.refNow || '(none)') : '';
        var why = st==='dupicg' ? icgDupWhy(r,c) : [];
        r.cState.textContent = ILABEL[st] + (why.length ? ' - '+why.join('; ') : '') + (r.msg ? ' - '+r.msg : '');
        r.tr.setAttribute('data-state', st);
        r.allowBox.disabled = !(st==='dupicg' || (r.allowDup && st==='ready'));
        r.skipBox.disabled = (st==='done' || st==='failed');
        r.tr.hidden = !!icgFilter && icgFilter!==st && !(icgFilter==='problem' && IPROB[st]);
      });
      var prob = (counts.pick||0)+(counts.dupinv||0)+(counts.dupicg||0)+(counts.badicg||0);
      chips.innerHTML='';
      [['problem','Needs attention',prob,'bad'],['dupicg','Duplicate ICG #',counts.dupicg||0,'need'],['dupinv','Same invoice twice',counts.dupinv||0,'bad'],
       ['pick','Choose invoice',counts.pick||0,'bad'],['badicg','Bad ICG #',counts.badicg||0,'bad'],['ready','Ready',counts.ready||0,'ok'],
       ['nochange','No change',counts.nochange||0,''],['notfound','Not found',counts.notfound||0,''],['skipped','Skipped',counts.skipped||0,''],
       ['done','Updated',counts.done||0,'ok'],['failed','Failed',counts.failed||0,'bad']].forEach(function(x){
        if(x[0]!=='problem' && !x[2]) return;
        var d = el('button',{type:'button',className:'chip '+x[3],attrs:{'aria-pressed':String(icgFilter===x[0])}},[el('b',{text:String(x[2])}),x[1]]);
        d.onclick=function(){ icgFilter = (icgFilter===x[0]) ? '' : x[0]; icgRefresh(); };
        chips.appendChild(d);
      });
      applyBtn.disabled = G.busy || prob>0 || !(counts.ready>0);
      applyMsg.textContent = prob ? (prob+' row(s) still need attention, or tick Skip.') : ((counts.ready||0)+' invoice(s) will be updated.');
    }

    applyBtn.onclick = function(){
      var c = icgCtx(), todo = icgRows.filter(function(r){ return icgState(r,c)==='ready'; });
      if(!todo.length) return;
      var allowed = todo.filter(function(r){ return r.allowDup; }).length;
      var text = 'Overwrite the CASS # on '+todo.length+' invoice(s)?\n\nThe old numbers are replaced. Download the results CSV afterwards if you want a record of them.';
      if(allowed) text += '\n\n'+allowed+' of these were flagged as duplicate ICG #s and you chose to allow them.';
      if(!confirm(text)) return;
      G.busy=true; applyBtn.disabled=true; prog.hidden=false; prog.max=todo.length; prog.value=0;
      var batches=[]; for(var i=0;i<todo.length;i+=40) batches.push(todo.slice(i,i+40));
      var doneCount=0;
      batches.reduce(function(p,b){
        return p.then(function(){
          var items = b.map(function(r){ return {id:r.chosen,icg:r.icg,expectOld:icgM(r).refNow}; });
          return api({action:'icgcommit',items:items}).then(function(j){
            j.results.forEach(function(res,idx){
              var r=b[idx];
              if(res.ok){ r.state='done'; r.msg='was '+(res.before||'(none)'); r.before=res.before; }
              else { r.state='failed'; r.msg=res.error; }
            });
            doneCount+=b.length; prog.value=doneCount; icgRefresh();
          });
        });
      },Promise.resolve()).catch(function(e){
        say('Stopped: '+e.message+' Rows already marked Updated were saved; nothing was retried.',true);
      }).then(function(){ G.busy=false; prog.hidden=true; icgRefresh(); });
    };

    dlBtn.onclick = function(){
      var c = icgCtx();
      var lines = [['Row','Invoice #','Bill-To','New ICG #','Previous CASS #','Result'].join(',')];
      icgRows.forEach(function(r){
        var m = icgM(r), st = icgState(r,c);
        lines.push([r.n,r.inv,m?m.billTo:'',r.icg,(r.before!==undefined ? r.before : (m?m.refNow:'')),ILABEL[st]+(r.msg?' - '+r.msg:'')].map(q).join(','));
      });
      downloadCsv(lines, 'icg_import_results.csv');
    };
    resetBtn.onclick = function(){ if(G.busy) return; icgRows=[]; icgHolders={}; icgFilter=''; work.hidden=true; say(''); };
  }

  // ===================================================================
  // TABS
  // ===================================================================
  var TAB_DEFS = {
    notes: {label:'Notes upload', make:function(root){ StatusTool(root,{
      key:'notes', scope:'all', lookup:true, raw:false, title:'Notes upload',
      intro:'Any customer. Drop a status file, review the matches, then apply notes, statuses and pay dates to open invoices.',
      dropHint:'.xlsx or .csv. Columns: Invoice # (or Reference #, to fit the choice above), Collections Notes, Collections Status, Promised to Pay Date.',
      billedHead:'Amount billed (file)', csvName:'collections_notes_exceptions.csv'}); }},
    cat: {label:'CAT status upload', make:function(root){ StatusTool(root,{
      key:'cat', scope:'cat', lookup:false, raw:true, refName:'CASS #', title:'CAT status upload',
      intro:'Invoices under the CAT parent customer only. Takes the raw CASS export as it comes, or the formatted notes file.',
      dropHint:'The raw CASS export (.zip, .tsv or .xlsx) or the formatted notes file (Invoice/Pro Number, Notes, Status).',
      billedHead:'Amount billed (CASS)', csvName:'status_upload_exceptions.csv'}); }},
    icg: {label:'ICG # import', make:function(root){ IcgTool(root); }}
  };
  var tabBtns = {}, panels = {};
  B.tabs.forEach(function(t){
    var btn = el('button',{type:'button',className:'tab',id:'tab-'+t,text:TAB_DEFS[t].label,
                           attrs:{role:'tab','aria-controls':'panel-'+t,'aria-selected':'false'}});
    var panel = el('section',{id:'panel-'+t,attrs:{role:'tabpanel','aria-labelledby':'tab-'+t}});
    panel.hidden = true;
    btn.onclick = function(){ showTab(t); };
    $('tabs').appendChild(btn); $('panels').appendChild(panel);
    tabBtns[t] = btn; panels[t] = panel;
    TAB_DEFS[t].make(panel);
  });
  if(B.tabs.length<2) $('tabs').hidden = true;
  function showTab(which){
    B.tabs.forEach(function(t){
      panels[t].hidden = t!==which;
      tabBtns[t].setAttribute('aria-selected', String(t===which));
      tabBtns[t].tabIndex = t===which ? 0 : -1;
    });
    try { var u = new URL(window.location.href); u.searchParams.set('tab', which); history.replaceState(null,'',u); } catch(e) {}
  }
  $('tabs').addEventListener('keydown',function(e){
    if(e.key!=='ArrowRight' && e.key!=='ArrowLeft') return;
    var i = B.tabs.indexOf(document.activeElement && document.activeElement.id ? document.activeElement.id.replace('tab-','') : '');
    if(i<0) return;
    var n = B.tabs[(i + (e.key==='ArrowRight' ? 1 : B.tabs.length-1)) % B.tabs.length];
    showTab(n); tabBtns[n].focus();
  });
  showTab(B.tab);
})();
</script>
</body></html>`;

    return { onRequest };
});
