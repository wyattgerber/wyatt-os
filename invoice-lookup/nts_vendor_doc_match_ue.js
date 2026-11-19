/**
 * nts_vendor_doc_match_ue.js
 *
 * Attaches PDFs that were uploaded ahead of time to the vendor bill they belong to,
 * and carries the unit # entered at upload onto the bill.
 *
 * People drop invoice PDFs into the "Upload invoices" tab of the vendor invoice
 * lookup (nts_vendor_doc_lookup_sl.js), label each with an order # and, if they
 * like, a unit #. Until a vendor bill with that order # exists, the PDF waits in the
 * queue. This script runs when a vendor bill is saved: if PDFs are waiting for its
 * order # (the bill's Reference No. / tranid), it
 *   - before the save: fills the bill's Unit # from the waiting PDF, but only when the
 *     bill has no unit # of its own (a unit # that came with the bill always wins), and
 *   - after the save: attaches the PDFs to the bill and marks them matched, which
 *     takes them out of the queue.
 *
 * Works for bills created by a CSV import, a script, a web service call or the UI.
 *
 * A waiting PDF is a File Cabinet file whose description looks like
 *   NTSINV|PENDING|ORDER=EPO-00019653|UNIT=2222|BY=Some Person
 * and once attached
 *   NTSINV|MATCHED|ORDER=EPO-00019653|UNIT=2222|BY=Some Person|BILL=2508|AT=2026-11-10
 * (UNIT is left out when none was entered.)
 * DOC_MARK and UNIT_FIELD below must stay identical to the ones in the Suitelet.
 *
 * DEPLOYMENT (see the notes that came with this file):
 *   Script type    User Event, deployed to Vendor Bill
 *   Functions      beforeSubmit AND afterSubmit
 *   Execute as     a role that can edit File Cabinet files and attach them to bills
 *   Contexts       leave blank (all), so CSV imports and web services are covered
 *
 * It never throws: a problem here must not stop a bill from saving. Failures are
 * written to the execution log, and the Suitelet's Queue tab retries any PDF whose
 * bill exists.
 *
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/query', 'N/file', 'N/log'],
function (record, query, file, log) {

    var DOC_MARK = 'NTSINV|';

    // The bill's Unit # custom body field. Set to '' to ignore unit #s entirely.
    var UNIT_FIELD = 'custbody_unit';

    // Most PDFs attached by a single bill save (keeps well inside governance).
    var MAX_FILES = 10;

    function norm(s) {
        return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    }

    /** NTSINV|STATE|KEY=value|... -> { state, order, unit, by, bill, at } or null. */
    function parse(desc) {
        if (!desc || String(desc).indexOf(DOC_MARK) !== 0) return null;
        var parts = String(desc).split('|');
        var out = { state: parts[1] || '' };
        parts.slice(2).forEach(function (p) {
            var i = p.indexOf('=');
            if (i > 0) out[p.substring(0, i).toLowerCase()] = p.substring(i + 1);
        });
        return out;
    }

    function matchedDesc(order, unit, by, billId) {
        return DOC_MARK + 'MATCHED|ORDER=' + order + (unit ? '|UNIT=' + unit : '') + '|BY=' + (by || '')
             + '|BILL=' + billId + '|AT=' + new Date().toISOString().slice(0, 10);
    }

    /** PDFs waiting for this order #, parsed, oldest first (at most MAX_FILES). */
    function findWaiting(order) {
        // LIKE treats _ and % as wildcards, so confirm each hit exactly below.
        var rows = query.runSuiteQL({
            query: 'SELECT id, description FROM file WHERE description LIKE ? ORDER BY id',
            params: [DOC_MARK + 'PENDING|ORDER=' + order + '|%']
        }).asMappedResults();

        var out = [];
        rows.forEach(function (r) {
            var d = parse(r.description);
            if (d && d.state === 'PENDING' && d.order === order) {
                d.id = Number(r.id);
                out.push(d);
            }
        });
        return out.slice(0, MAX_FILES);
    }

    /**
     * Is there a different bill with this order #? Then we cannot tell which one the
     * PDF belongs to, so it stays in the queue for a person to sort out.
     */
    function otherBillExists(order, billId) {
        return query.runSuiteQL({
            query: "SELECT id FROM transaction WHERE type = 'VendBill' AND UPPER(tranid) = ? AND id <> ?",
            params: [order, Number(billId || 0)]
        }).asMappedResults().length > 0;
    }

    /** The order # to act on for this save, or '' when there is nothing to do. */
    function orderToMatch(context) {
        var UT = context.UserEventType;
        if (context.type !== UT.CREATE && context.type !== UT.EDIT) return '';

        var order = norm(context.newRecord.getValue({ fieldId: 'tranid' }));
        if (!order) return '';

        // On edit, only act when the order # itself changed.
        if (context.type === UT.EDIT) {
            var before = norm(context.oldRecord.getValue({ fieldId: 'tranid' }));
            if (before === order) return '';
        }
        return order;
    }

    /** Before the bill is saved: fill in its unit # from a waiting PDF, if it has none. */
    function beforeSubmit(context) {
        try {
            if (!UNIT_FIELD) return;

            var order = orderToMatch(context);
            if (!order) return;

            var rec = context.newRecord;

            // The Unit # field may not exist in this account (a sandbox refresh can remove a
            // custom field that was only ever created there). Then there is nothing to fill in.
            if (!rec.getField({ fieldId: UNIT_FIELD })) return;

            // A unit # that arrived with the bill always wins.
            if (String(rec.getValue({ fieldId: UNIT_FIELD }) || '').trim()) return;

            var withUnit = findWaiting(order).filter(function (d) { return d.unit; })[0];
            if (!withUnit) return;

            if (otherBillExists(order, rec.id)) return;

            rec.setValue({ fieldId: UNIT_FIELD, value: withUnit.unit });
            log.audit({
                title: 'vendor doc unit set',
                details: 'Order # ' + order + ': unit # ' + withUnit.unit + ' taken from file ' + withUnit.id
            });
        } catch (e) {
            log.error({ title: 'vendor doc unit failed', details: e.name + ': ' + e.message });
        }
    }

    /** After the bill is saved: attach the waiting PDFs and take them out of the queue. */
    function afterSubmit(context) {
        try {
            var order = orderToMatch(context);
            if (!order) return;

            var billId = context.newRecord.id;
            var mine = findWaiting(order);
            if (!mine.length) return;

            if (otherBillExists(order, billId)) {
                log.audit({
                    title: 'vendor doc match skipped',
                    details: 'Order # ' + order + ' is used by more than one bill; ' + mine.length + ' PDF(s) left in the queue.'
                });
                return;
            }

            mine.forEach(function (d) {
                try {
                    // Attach first. Only mark it matched once the attach worked, so a
                    // failure leaves the PDF in the queue rather than losing track of it.
                    record.attach({
                        record: { type: 'file', id: d.id },
                        to: { type: record.Type.VENDOR_BILL, id: Number(billId) }
                    });

                    var f = file.load({ id: d.id });
                    f.description = matchedDesc(order, d.unit, d.by, billId);
                    f.save();

                    log.audit({
                        title: 'vendor doc attached',
                        details: 'File ' + d.id + ' attached to bill ' + billId + ' (order # ' + order + ')'
                    });
                } catch (e) {
                    log.error({ title: 'vendor doc attach failed', details: 'File ' + d.id + ' :: ' + e.name + ': ' + e.message });
                }
            });
        } catch (e) {
            log.error({ title: 'vendor doc match failed', details: e.name + ': ' + e.message });
        }
    }

    return { beforeSubmit: beforeSubmit, afterSubmit: afterSubmit };
});
