/**
 * Nussbaum Reporting Lab — income statement with cost per mile
 *
 * A read-only Suitelet that renders an income statement for any combination of accounting
 * periods and subsidiaries, with an amount and a per-mile figure for every period, filterable
 * by profit center, department, location, mode and service type, and exportable to Excel and PDF.
 *
 * Actions (query parameter `action`):
 *   page  (default) — serves the report page from the File Cabinet
 *   meta            — picker values: periods, subsidiary tree, profit centers, dimension values
 *   data            — the statement data for the selected periods and subsidiaries
 *   pdf   (POST)    — renders a PDF from the statement(s) the browser posts: the current view,
 *                     or one statement per profit center
 *   flags           — (POST) resolutions for a list of flag keys
 *   resolveflag     — (POST) resolve a flag, with an optional comment; resolving again updates it
 *   schedulesend    — (POST) email the person asking a test of one of the scheduled reports
 *   comments        — (POST) the comments on the lines asked for; addcomment / deletecomment — add one; delete your own
 *   notes           — (POST) every saved flag comment, newest first, including reopened ones; optional account filter
 *   reopenflag      — (POST) undo a resolution (the note stays in the history); only whoever resolved it or an administrator can
 *   reports         — saved reports (also returned with meta)
 *   savereport      — (POST) create a saved report, or overwrite one of your own with the same name
 *   deletereport    — (POST) delete a saved report; only its creator or an administrator can
 *   entry           — every posting line of one transaction (debit, credit, memo, dimensions), so a
 *                     drill-down row can expand in place
 *   compare         — one set of accounts across two period sets, grouped by name on the
 *                     transaction, so a flagged swing can say which vendor or customer moved
 *   detail          — the transactions behind one statement amount (GL), or the statistical
 *                     entries behind its miles, filtered exactly as the statement is
 *   diag            — read-only self-test of every data path this script depends on
 *
 * Data sources:
 *   Dollars — SuiteQL on transactionaccountingline (posting lines only), consolidated with
 *             BUILTIN.CONSOLIDATE to the lowest common ancestor of the selected subsidiaries.
 *   Miles   — N/search on account 9000. Statistical journal entries are absent from every
 *             SuiteQL transaction table (header and line), so they cannot be read with N/query.
 *             The saved-search engine does see them.
 *
 * Runs as the current user (deployment Execute As Role left blank), so NetSuite's own
 * subsidiary restrictions apply to whoever opens it.
 *
 * Statement sections come only from the Account Group field on each account. Accounts without
 * one are left off the statement and returned as `excluded` so unassigned activity stays visible.
 *
 * Conventions: no hardcoded internal IDs. Accounts resolve by number, files by File Cabinet
 * path, everything else is read live. Resolvers fail loudly on no match or an ambiguous match.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 */
define(['N/query', 'N/search', 'N/file', 'N/render', 'N/url', 'N/runtime', 'N/log', 'N/format', 'N/record', 'N/email', 'N/task'],
(query, search, file, render, url, runtime, log, format, record, email, task) => {

    // ------------------------------------------------------------------------------------------
    // Policy constants. Changing these is a code change and a redeploy, by design.
    // ------------------------------------------------------------------------------------------

    const FILE_PATHS = {
        page: 'SuiteScripts/Reporting/nts_is_cpm_page.html',
        pdf:  'SuiteScripts/Reporting/nts_is_cpm_pdf.xml',
        logo: 'Images/NTS - Updated'                          // optional — page hides the logo if absent
    };

    // Current year earnings on the balance sheet: income and expense accounts numbered FROM..TO, less the excluded ones.
    // Account numbers are compared by their leading digits, so 4180 and 4180-01 are both "4180".
    const EARNINGS_FROM = 4000, EARNINGS_TO = 8999, EARNINGS_EXCLUDE = [4180];
    const earningsFormulaText = () => {
        const x = EARNINGS_EXCLUDE.map(String);
        const list = x.length > 1 ? x.slice(0, -1).join(', ') + ' and ' + x[x.length - 1] : x.join('');
        return `Accounts ${EARNINGS_FROM}\u2013${EARNINGS_TO}` + (x.length ? `, except ${list}` : '');
    };
    function inCurrentEarnings(num) {
        const m = /^\s*(\d+)/.exec(String(num || ''));
        if (!m) return false;
        const n = Number(m[1]);
        return n >= EARNINGS_FROM && n <= EARNINGS_TO && EARNINGS_EXCLUDE.indexOf(n) < 0;
    }

    const MILES_ACCOUNT_NUMBER = '9000';      // 9002 is "Miles - Old"; 9005 is Weighted Miles

    // Account record field holding the statement section. Auto-generated ID — if it is renamed
    // (recommended: custrecord_nts_account_group), change it here.
    const ACCOUNT_GROUP_FIELD = 'custrecord1393';
    const ACCOUNT_GROUP_LIST = 'customlist1126';     // the Account Groups list behind that field
    // The Shop Cost Center's own group on each account ("Shop Cost Center Group", the same Account Groups list). The Shop Cost Center
    // report is built from it: the four values below are its sections, matched by name so list internal IDs never matter.
    const SHOP_GROUP_FIELD = 'custrecord1394';
    const SHOP_GROUP_NAMES = {
        'shop revenues': 'rev', 'shop revenue': 'rev',
        'truck and trailer repair cost': 'repair', 'truck and trailer repair costs': 'repair',
        'truck & trailer repair cost': 'repair', 'truck & trailer repair costs': 'repair',
        'shop personnel costs': 'pers', 'shop personnel cost': 'pers',
        'shop overhead': 'over'
    };

    // Account Groups list values, matched by name (case-insensitive) so list internal IDs never matter.
    const GROUP_NAMES = {
        // income statement sections
        'revenue': 'revenue',
        'variable expenses': 'variable',
        'fixed expenses': 'fixed',
        'other income/expenses': 'other',
        'income taxes': 'tax',
        'esop related expenses': 'esop',
        // balance sheet headings — the groups that hold accounts directly (matched without apostrophes)
        'cash': 'bs_cash',
        'accounts receivable': 'bs_ar',
        'prepaid expenses': 'bs_prepaid',
        'inventories': 'bs_inventory',
        'land and buildings': 'bs_land',
        'revenue equipment': 'bs_equipment',
        'other fixed assets': 'bs_otherfixed',
        'operating right of use assets': 'bs_rou',
        'deferred charges': 'bs_deferred',
        'accounts payable': 'bs_ap',
        'other current liabilities': 'bs_ocl',
        'long term liabilities': 'bs_ltl',
        'stockholders equity': 'bs_equity',
        'capital stock': 'bs_capital',          // equity section: the two groups that sit under Stockholders' Equity
        'retained earnings': 'bs_retained',
        'accrued liabilities': 'bs_accrued',     // current liabilities
        'long term assets': 'bs_lta'             // after current assets, before fixed assets
    };

    // Section codes sent to the browser. 5 is retired (was the fallback "Not yet grouped").
    // Codes below BS_FIRST belong to the income statement, the rest to the balance sheet.
    const G = { revenue: 0, variable: 1, fixed: 2, other: 3, tax: 4, esop: 6,
                bs_cash: 10, bs_ar: 11, bs_prepaid: 12, bs_inventory: 13, bs_land: 14, bs_equipment: 15,
                bs_otherfixed: 16, bs_rou: 17, bs_deferred: 18, bs_ap: 19, bs_ocl: 20, bs_ltl: 21, bs_equity: 22, bs_retained: 23, bs_capital: 24, bs_accrued: 25, bs_lta: 26 };
    const BS_FIRST = 10;
    // Months of data one request can pull. A month-end package (this month, last year's month, and
    // three years of YTD) touches up to 36; the page caps what it shows at 16 columns separately.
    const MAX_PERIODS = 240;
    const MAX_BS_COLUMNS = 16;       // balance sheet dates in one request
    // NetSuite's own accounts (NS10, NS18, ...) are left out of the "not on the report" lists and warnings
    const isSystemAccount = num => /^NS\d+$/i.test(String(num || ''));
    const MAX_PDF_SECTIONS = 60;      // consolidated plus profit centers and their rollups
    const MAX_DETAIL = 2000;          // transactions listed in one drill-down; the total always covers all
    const MAX_DETAIL_ACCOUNTS = 400;
    const MAX_BS_ENTRIES = 10000;      // posting lines returned for one request of the detailed balance sheet export
    const MAX_COMPARE_NAMES = 300;
    const MAX_ENTRY_LINES = 500;

    // Saved reports: one custom record per report. The definition is a column template relative to
    // the As of month, so a saved report rolls forward exactly like the built-in ones.
    const SCHED_SCRIPT = 'customscript_nts_is_cpm_sched';        // the Scheduled Script that sends scheduled reports ("Send me a test" runs it on demand)
    const SCHED_DEPLOY = 'customdeploy_nts_is_cpm_sched';
    // "Send me a test" tries this deployment first (same script, status Not Scheduled, no repeat), then the repeating one above.
    // A deployment that repeats can refuse an on-demand run while it holds a queued one; a deployment that never repeats does not.
    const SCHED_TEST_DEPLOY = 'customdeploy_nts_is_cpm_sched_test';
    const REPORT_RECORD = 'customrecord_nts_is_report';
    const REPORT_DEF_FIELD = 'custrecord_nts_isr_definition';
    const MAX_SAVED_COLUMNS = 16;
    const TEMPLATE_TYPES = ['month', 'quarter', 'year', 'ytd', 'range', 'avg', 'diff', 'pchg'];

    // Flag resolutions: one custom record per resolved flag. The key is a hash the page builds from
    // the account(s) and the two exact period sets compared, so a resolution follows that comparison
    // wherever it appears — on the statement or in Review.
    const FLAG_RECORD = 'customrecord_nts_is_flag';
    const FLAG_KEY_FIELD = 'custrecord_nts_isf_key';
    const FLAG_COMMENT_FIELD = 'custrecord_nts_isf_comment';
    const FLAG_KEY_RE = /^v\d+-[0-9a-f]{16}$/;
    const MAX_FLAG_KEYS = 2000;
    const PAGE_SIZE = 5000;

    // P&L account types read by the dollar query.
    const PL_TYPES = ['Income', 'OthIncome', 'Expense', 'OthExpense', 'COGS'];
    // Postable balance sheet account types. NonPosting and Stat accounts never carry a balance.
    const BS_TYPES = ['Bank', 'AcctRec', 'UnbilledRec', 'OthCurrAsset', 'FixedAsset', 'OthAsset', 'DeferExpense',
                      'AcctPay', 'CredCard', 'OthCurrLiab', 'LongTermLiab', 'DeferRevenue', 'Equity'];

    /**
     * Which statement section an account belongs to — read only from the Account Group field on
     * the account record, matched by list value name. Returns null when the field is blank or holds
     * a value the report does not know; those accounts are left off the statement and reported
     * separately as excluded, so unassigned activity is visible rather than silently dropped.
     */
    // Group names compared without case, apostrophes or extra spaces, so "Stockholders' Equity",
    // "Stockholders’ Equity" and "stockholders equity" are all the same value.
    const normGroup = name => String(name || '').toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/\s+/g, ' ').trim();
    function groupKey(name) { return GROUP_NAMES[normGroup(name)]; }          // built-in groups only

    // Groups that exist in the Account Groups list but not in this file are placed from the accounts that carry
    // them, so adding a value to the list never needs a change here. loadGroups() fills DYN on every request.
    //   income statement: an expense-style section after Fixed expenses (credits show as negatives)
    //   balance sheet:    the subtotal that matches the accounts' types — current or fixed or other assets,
    //                     current or long term liabilities, equity — on the side those types belong to
    const BUCKET = { Bank: 'ca', AcctRec: 'ca', UnbilledRec: 'ca', OthCurrAsset: 'ca', DeferExpense: 'ca', FixedAsset: 'fa', OthAsset: 'oa',
                     AcctPay: 'cl', CredCard: 'cl', OthCurrLiab: 'cl', DeferRevenue: 'cl', LongTermLiab: 'ltl', Equity: 'eq' };
    const BUCKET_ORDER = ['ca', 'fa', 'oa', 'cl', 'ltl', 'eq'];
    // A group placed by name instead of by its accounts' types. "Error Accounts" holds the error trap accounts, which are income
    // statement types, but it belongs at the bottom of Current Assets on the balance sheet (a new group is listed after the built-in
    // ones in its subtotal). Keys are the group name as normGroup() writes it.
    const GROUP_PLACEMENT = { 'error accounts': { kind: 'bs', bucket: 'ca' } };
    const BUCKET_LABEL = { ca: 'Current Assets', fa: 'Fixed Assets', oa: 'Other Assets', cl: 'Current Liabilities',
                           ltl: 'Long Term Liabilities', eq: "Stockholders' Equity" };
    let DYN = {};
    let BUILTIN_NAMES = {};      // section code -> the group's name exactly as it is spelled in the Account Groups list
    function groupNames() { return BUILTIN_NAMES; }
    function groupDefs() { return Object.keys(DYN).map(k => ({ code: DYN[k].code, name: DYN[k].name, kind: DYN[k].kind, bucket: DYN[k].bucket })); }

    // kind 'is' or 'bs' returns null for a group that belongs to the other statement; no kind returns the raw code.
    function getSectionGroup(fieldGroupName, kind) {
        const key = normGroup(fieldGroupName);
        if (!key) return null;
        let code, gk;
        if (GROUP_NAMES[key]) { code = G[GROUP_NAMES[key]]; gk = code >= BS_FIRST ? 'bs' : 'is'; }
        else if (DYN[key]) { code = DYN[key].code; gk = DYN[key].kind; }
        else return null;
        if (kind && gk !== kind) return null;
        return code;
    }

    // ------------------------------------------------------------------------------------------
    // Entry point
    // ------------------------------------------------------------------------------------------

    function onRequest(ctx) {
        const action = (ctx.request.parameters.action || 'page').toLowerCase();
        try {
            switch (action) {
                case 'page': return servePage(ctx);
                case 'meta': return json(ctx, getMeta());
                case 'data': return json(ctx, getData(ctx.request.parameters));
                case 'detail': return json(ctx, getDetail(ctx.request.parameters));
                case 'compare': return json(ctx, getCompare(ctx.request.parameters));
                case 'entry': return json(ctx, getEntry(ctx.request.parameters));
                case 'bsdata': return json(ctx, getBsData(ctx.request.parameters));
                case 'bsentries':
                case 'entries': return json(ctx, getEntries(ctx.request.parameters));
                case 'reports': return json(ctx, { ok: true, reports: listReports() });
                case 'savereport': return json(ctx, saveReport(ctx));
                case 'deletereport': return json(ctx, deleteReport(ctx));
                case 'flags': return json(ctx, { ok: true, resolutions: listResolutions(ctx) });
                case 'resolveflag': return json(ctx, resolveFlag(ctx));
                case 'notes': return json(ctx, listNotes(ctx));
                case 'comments': return json(ctx, listComments(ctx));
                case 'addcomment': return json(ctx, addComment(ctx));
                case 'deletecomment': return json(ctx, deleteComment(ctx));
                case 'schedulesend': return json(ctx, sendScheduleTest(ctx));
                case 'stat': return json(ctx, getStat(ctx.request.parameters));
                case 'reopenflag': return json(ctx, reopenFlag(ctx));
                case 'pdf':  return servePdf(ctx);
                case 'pdfb64': return servePdf(ctx, true);          // the same PDF as base64 in JSON, for the scheduled script, which cannot read binary replies
                case 'diag': return json(ctx, runDiagnostics());
                default:     throw error('BAD_ACTION', `Unknown action "${action}".`);
            }
        } catch (e) {
            log.error({ title: `nts_is_cpm_sl ${action} failed`, details: e });
            const message = e.message || String(e);
            if (action === 'page') {
                ctx.response.write(`<p style="font-family:sans-serif">The report could not load: ${esc(message)}</p>`);
            } else {
                ctx.response.setHeader({ name: 'Content-Type', value: 'application/json' });
                ctx.response.write(JSON.stringify({ ok: false, error: e.name || 'ERROR', message }));
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // page
    // ------------------------------------------------------------------------------------------

    function servePage(ctx) {
        const html = loadFile(FILE_PATHS.page).getContents();
        const self = url.resolveScript({
            scriptId: runtime.getCurrentScript().id,
            deploymentId: runtime.getCurrentScript().deploymentId
        });
        const user = runtime.getCurrentUser();
        let logo = '';
        try { logo = file.load({ id: FILE_PATHS.logo }).url || ''; } catch (e) { /* logo is optional */ }
        ctx.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        ctx.response.write(html
            .split('__ENDPOINT__').join(self)
            .split('__LOGO_URL__').join(esc(logo))
            .split('__USER_NAME__').join(esc(user.name))
            .split('__ACCOUNT_ENV__').join(esc(runtime.envType)));
    }

    // ------------------------------------------------------------------------------------------
    // meta
    // ------------------------------------------------------------------------------------------

    function getMeta() {
        return {
            ok: true,
            periods: getPeriods(),
            years: getYears(),
            quarters: getQuarters(),
            subsidiaries: suiteql(
                `SELECT id, name, parent, iselimination FROM subsidiary WHERE isinactive = 'F'`)
                .map(r => ({ id: r.id, name: r.name, parent: r.parent || 0, elim: r.iselimination === 'T' })),
            classes:     tree(`SELECT id, name, parent FROM classification WHERE isinactive = 'F'`),
            departments: tree(`SELECT id, name, parent FROM department WHERE isinactive = 'F'`),
            locations:   tree(`SELECT id, name, parent FROM location WHERE isinactive = 'F'`),
            modes:       flat(`SELECT id, name FROM customrecord_cseg_appf_mode WHERE isinactive = 'F'`),
            milesAccount: MILES_ACCOUNT_NUMBER,
            ...savedReportsForMeta(),
            ...flagsReadyForMeta(),
            ...chartForMeta(),
            groupDefs: groupDefs(), groupNames: groupNames(),
            services:    flat(`SELECT id, name FROM customrecord_cseg_appf_serv_type WHERE isinactive = 'F'`),
            maxPeriods: MAX_PERIODS
        };
    }

    function tree(sql) {
        return suiteql(sql).map(r => ({ id: r.id, name: r.name, parent: r.parent || 0 }));
    }
    function flat(sql) {
        return suiteql(sql).map(r => ({ id: r.id, name: r.name }));
    }

    // Fiscal years from NetSuite's own year periods, so a non-calendar fiscal year is handled.
    function getYears() {
        const out = [];
        search.create({
            type: 'accountingperiod',
            filters: [['isyear', 'is', 'T']],
            columns: [search.createColumn({ name: 'startdate', sort: search.Sort.DESC }), 'periodname', 'enddate']
        }).run().each(r => {
            out.push({ id: Number(r.id), name: r.getValue('periodname'),
                       start: isoDate(r.getValue('startdate')), end: isoDate(r.getValue('enddate')) });
            return true;
        });
        return out;
    }

    // Fiscal quarters, from NetSuite's own quarter periods.
    function getQuarters() {
        const out = [];
        search.create({
            type: 'accountingperiod',
            filters: [['isquarter', 'is', 'T']],
            columns: [search.createColumn({ name: 'startdate', sort: search.Sort.DESC }), 'periodname', 'enddate']
        }).run().each(r => {
            out.push({ id: Number(r.id), name: r.getValue('periodname'),
                       start: isoDate(r.getValue('startdate')), end: isoDate(r.getValue('enddate')) });
            return true;
        });
        return out;
    }

    // accountingperiod is not readable through SuiteQL in this account, so periods come from search.
    // Each month is tagged with the fiscal year and quarter whose date ranges contain it.
    function getPeriods() {
        const years = getYears();
        const quarters = getQuarters();
        const out = [];
        search.create({
            type: 'accountingperiod',
            filters: [
                ['isquarter', 'is', 'F'], 'AND',
                ['isyear', 'is', 'F'], 'AND',
                ['isadjust', 'is', 'F']
            ],
            columns: [
                search.createColumn({ name: 'startdate', sort: search.Sort.DESC }),
                'periodname', 'enddate', 'closed'
            ]
        }).run().each(r => {
            out.push({
                id: Number(r.id),
                name: r.getValue('periodname'),
                start: isoDate(r.getValue('startdate')),
                end: isoDate(r.getValue('enddate')),
                closed: r.getValue('closed') === true || r.getValue('closed') === 'T'
            });
            return true;
        });
        out.forEach(p => {
            const y = years.find(y => p.start >= y.start && p.start <= y.end);
            const q = quarters.find(q => p.start >= q.start && p.start <= q.end);
            p.year = y ? y.id : 0;
            p.quarter = q ? q.id : 0;
        });
        return out;
    }

    // ------------------------------------------------------------------------------------------
    // data
    // ------------------------------------------------------------------------------------------

    function getData(params) {
        const periodIds = idList(params.periods, 'periods');
        const subIds = idList(params.subs, 'subs');
        if (periodIds.length > MAX_PERIODS) {
            throw error('TOO_MANY_PERIODS', `These columns need ${periodIds.length} months of data; one report can use up to ${MAX_PERIODS}.`);
        }

        const periods = getPeriods().filter(p => periodIds.includes(p.id))
            .sort((a, b) => a.start < b.start ? -1 : 1);
        if (periods.length !== periodIds.length) {
            throw error('BAD_PERIOD', 'One or more selected periods do not exist or are not monthly periods.');
        }
        const pIndex = {};
        periods.forEach((p, i) => { pIndex[p.id] = i; });

        const subs = suiteql(`SELECT id, parent FROM subsidiary WHERE isinactive = 'F'`);
        const consolidateTo = commonAncestor(subIds, subs);

        const dollars = getDollars(periodIds, subIds, consolidateTo);
        const sars = getSarsPaid(periods, subIds, consolidateTo);
        const miles = getMiles(periods, subIds);
        const groups = getAccountGroups();
        const warnings = [];
        const unknown = new Set();

        // Compact the dollar rows: account list once, rows reference it by index. Accounts without a
        // recognised Account Group go to `excluded`, summed by account and period only.
        const accounts = [];
        const aIndex = {};
        const rows = [];
        const excl = {};
        dollars.forEach(r => {
            const amt = Number(r.amt) || 0;
            if (Math.abs(amt) < 0.005) return;
            const fg = groups[r.acctid];
            const g = getSectionGroup(fg, 'is');
            const name = cleanAccountName(r.aname, r.num);
            if (g === null) {
                if (fg && getSectionGroup(fg) === null) unknown.add(fg);
                if (isSystemAccount(r.num)) return;
                const k = r.acctid;
                if (!excl[k]) excl[k] = { id: Number(r.acctid), num: r.num || '', name, group: fg || '', type: r.atype,
                                          amounts: periods.map(() => 0) };
                excl[k].amounts[pIndex[r.pp]] += amt;
                return;
            }
            const key = r.num || ('id:' + r.acctid);
            if (aIndex[key] === undefined) {
                aIndex[key] = accounts.length;
                accounts.push([r.num || '', name, g, r.atype, Number(r.acctid)]);
            }
            rows.push([pIndex[r.pp], aIndex[key], r.cls || 0, r.dep || 0, r.loc || 0, r.md || 0, r.svc || 0,
                       Math.round(amt * 100) / 100, Number(r.sub) || 0]);      // [8] subsidiary, for layout filters
        });
        // Parent accounts, walked up from every account on the statement, so the page can group
        // children under their parents at any depth. Keyed by internal id: [number, name, parent id].
        const allAccts = {};
        suiteql(`SELECT id, acctnumber, accountsearchdisplayname AS aname, parent FROM account`)
            .forEach(a => { allAccts[a.id] = a; });
        const tree = {};
        accounts.forEach(a => {
            let id = a[4], guard = 0;
            while (id && allAccts[id] && guard++ < 20) {
                const x = allAccts[id];
                if (!tree[id]) tree[id] = [x.acctnumber || '', cleanAccountName(x.aname, x.acctnumber), Number(x.parent) || 0];
                id = Number(x.parent) || 0;
            }
        });

        const excluded = Object.values(excl)
            .map(x => Object.assign(x, { amounts: x.amounts.map(v => Math.round(v * 100) / 100) }))
            .filter(x => x.amounts.some(v => Math.abs(v) >= 0.005))
            .sort((a, b) => (a.num > b.num ? 1 : -1));

        if (unknown.size) {
            warnings.push(`Account Group value${unknown.size > 1 ? 's' : ''} the report doesn't recognise: ` +
                          [...unknown].join(', ') + '. Those accounts are listed as excluded.');
        }
        const assigned = new Set(Object.values(groups).map(v => groupKey(v)));
        if (!assigned.has('revenue')) warnings.push('No accounts are assigned to the Revenue account group.');
        groupDefs().filter(d => d.kind === 'is' && accounts.some(a => a[2] === d.code)).forEach(d => {
            warnings.push(`Account Group "${d.name}" isn't one of the built-in groups, so it is shown as an expense section after ` +
                          'Fixed expenses (credits show as negatives).' +
                          (DYN[normGroup(d.name)].mixed ? ' It also holds balance sheet accounts, which are not shown here.' : ''));
        });
        if (excluded.length) {
            const n = excluded.length;
            warnings.push(`${n} account${n > 1 ? 's' : ''} with activity ${n > 1 ? 'have' : 'has'} no Account Group ` +
                          `and ${n > 1 ? 'are' : 'is'} left off the report — see "Accounts not on Report" below.`);
        }

        return {
            ok: true,
            warnings,
            generated: new Date().toISOString(),
            consolidatedTo: consolidateTo,
            periods: periods.map(p => ({ id: p.id, name: p.name, closed: p.closed })),
            subsidiaries: subIds,
            groupDefs: groupDefs(), groupNames: groupNames(),
            accounts,
            tree,
            rows,
            excluded,
            miles: miles.map(m => [pIndex[m.pp], m.cls, m.miles]),
            sars,
            usage: runtime.getCurrentScript().getRemainingUsage()
        };
    }

    // Cash payments for SARs, by period: the activity on SARS PAID (a balance sheet account, so the income statement query never sees it).
    // EBITDAE takes it off. Debit-positive, as the account is posted. Reads as zeros if the account isn't there.
    const SARS_PAID_ACCOUNT = '3470';
    function getSarsPaid(periods, subIds, consolidateTo) {
        const zeros = periods.map(() => 0);
        let id = 0;
        try { id = Number(resolveAccountByNumber(SARS_PAID_ACCOUNT)) || 0; } catch (e) { return zeros; }
        if (!id) return zeros;
        try {
            const ids = periods.map(p => p.id), pIdx = {};
            periods.forEach((p, i) => { pIdx[p.id] = i; });
            const rows = suiteql(`
                SELECT t.postingperiod AS pp,
                       SUM(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${Number(consolidateTo)}, t.postingperiod, 'DEFAULT')) AS amt
                  FROM transactionaccountingline tal
                  JOIN transaction t      ON t.id = tal.transaction
                  JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
                 WHERE tal.posting = 'T' AND tal.account = ?
                   AND t.postingperiod IN (${ids.map(() => '?').join(',')})
                   AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})
                 GROUP BY t.postingperiod`, [id, ...ids, ...subIds]);
            const out = zeros.slice();
            rows.forEach(r => { const i = pIdx[Number(r.pp)]; if (i !== undefined) out[i] += Number(r.amt) || 0; });
            return out;
        } catch (e) { log.error('SARs paid could not be read', (e && e.message) || e); return zeros; }
    }

    function getDollars(periodIds, subIds, consolidateTo) {
        // consolidateTo is an integer validated against the live subsidiary list; BUILTIN functions
        // do not accept bind parameters, so it is inlined.
        const sql = `
            SELECT t.postingperiod AS pp,
                   a.id AS acctid, a.acctnumber AS num, a.accountsearchdisplayname AS aname, a.accttype AS atype,
                   tl.class AS cls, tl.department AS dep, tl.location AS loc,
                   tl.cseg_appf_mode AS md, tl.cseg_appf_serv_type AS svc, tl.subsidiary AS sub,
                   SUM(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${Number(consolidateTo)},
                                           t.postingperiod, 'DEFAULT')) AS amt
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
              JOIN account a          ON a.id = tal.account
             WHERE tal.posting = 'T'
               AND a.accttype IN (${PL_TYPES.map(() => '?').join(',')})
               AND t.postingperiod IN (${periodIds.map(() => '?').join(',')})
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})
             GROUP BY t.postingperiod, a.id, a.acctnumber, a.accountsearchdisplayname, a.accttype,
                      tl.class, tl.department, tl.location, tl.cseg_appf_mode, tl.cseg_appf_serv_type, tl.subsidiary`;
        return suiteql(sql, [...PL_TYPES, ...periodIds, ...subIds]);
    }

    /**
     * statistical account values by posting period (truck and driver counts and the like), summed over the subsidiaries asked for.
     * Each entry is read as the level for its month, as the miles are read as that month's miles.
     */
    function getStat(params) {
        const nums = String(params.accounts || '').split(',').map(x => x.trim()).filter(Boolean);
        if (!nums.length || nums.length > 12 || nums.some(n => !/^[0-9A-Za-z.\-]{1,20}$/.test(n))) throw error('BAD_ACCT', 'Invalid accounts.');
        const periodIds = idList(params.periods, 'periods');
        if (periodIds.length > MAX_PERIODS) throw error('TOO_MANY_PERIODS', `Up to ${MAX_PERIODS} months can be read at once.`);
        const subIds = idList(params.subs, 'subs');
        const ps = getPeriods().filter(p => periodIds.indexOf(p.id) >= 0);
        if (!ps.length) return { ok: true, values: {} };
        const numById = {}, ids = [];
        nums.forEach(n => { try { const id = resolveAccountByNumber(n); if (id) { numById[String(id)] = n; ids.push(id); } } catch (e) { /* an account that isn't there reads as nothing */ } });
        if (!ids.length) return { ok: true, values: {} };
        const wanted = new Set(periodIds), pad = 92 * 86400000;
        const from = new Date(Math.min(...ps.map(p => parseIso(p.start).getTime())) - pad);
        const to = new Date(Math.max(...ps.map(p => parseIso(p.end).getTime())) + pad);
        const values = {};
        search.create({
            type: search.Type.TRANSACTION,
            filters: [['account', 'anyof', ids], 'AND', ['subsidiary', 'anyof', subIds], 'AND',
                      ['trandate', 'within', format.format({ value: from, type: format.Type.DATE }), format.format({ value: to, type: format.Type.DATE })]],
            columns: [search.createColumn({ name: 'postingperiod', summary: search.Summary.GROUP }),
                      search.createColumn({ name: 'account', summary: search.Summary.GROUP }),
                      search.createColumn({ name: 'amount', summary: search.Summary.SUM })]
        }).run().each(r => {
            const pp = Number(r.getValue({ name: 'postingperiod', summary: search.Summary.GROUP }));
            const num = numById[String(r.getValue({ name: 'account', summary: search.Summary.GROUP }))];
            if (num && wanted.has(pp)) { (values[num] = values[num] || {})[pp] = (values[num][pp] || 0) + (Number(r.getValue({ name: 'amount', summary: search.Summary.SUM })) || 0); }
            return true;
        });
        return { ok: true, values };
    }

    /**
     * Miles by posting period and profit center, from statistical entries to account 9000.
     *
     * The posting period filter is deliberately not used: given several periods it returned only
     * the first. Instead the search covers a date window around the selected periods, groups by
     * posting period, and keeps the selected periods in code. The window is padded so entries
     * dated outside their posting period are still caught.
     */
    function getMiles(periods, subIds) {
        const milesAcctId = resolveAccountByNumber(MILES_ACCOUNT_NUMBER);
        const wanted = new Set(periods.map(p => p.id));
        const pad = 92 * 86400000;
        const from = new Date(Math.min(...periods.map(p => parseIso(p.start).getTime())) - pad);
        const to = new Date(Math.max(...periods.map(p => parseIso(p.end).getTime())) + pad);
        const out = [];
        // Only statistical entries can post to a statistical account, so filtering on the account
        // is sufficient — no transaction-type filter needed.
        search.create({
            type: search.Type.TRANSACTION,
            filters: [
                ['account', 'anyof', milesAcctId], 'AND',
                ['subsidiary', 'anyof', subIds], 'AND',
                ['trandate', 'within',
                    format.format({ value: from, type: format.Type.DATE }),
                    format.format({ value: to, type: format.Type.DATE })]
            ],
            columns: [
                search.createColumn({ name: 'postingperiod', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'class', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'amount', summary: search.Summary.SUM })
            ]
        }).run().each(r => {
            const pp = Number(r.getValue({ name: 'postingperiod', summary: search.Summary.GROUP }));
            if (wanted.has(pp)) {
                out.push({
                    pp,
                    cls: Number(r.getValue({ name: 'class', summary: search.Summary.GROUP })) || 0,
                    miles: Number(r.getValue({ name: 'amount', summary: search.Summary.SUM })) || 0
                });
            }
            return true;
        });
        return out;
    }

    // Account internal id -> Account Group display value, for accounts where the field is set.
    // Every income statement and balance sheet account — active or not, with or without postings — so the page
    // can show the full chart and how it nests. `g` is the section from the Account Group field, or null when
    // the account isn't on any report (no group, or a group the report doesn't know); `bs` marks balance sheet
    // accounts (an income statement type account whose Account Group is a balance sheet group counts as one), and the
    // page checks the group belongs to the statement it is showing.
    function getChart() {
        if (!/^custrecord[a-z0-9_]+$/.test(ACCOUNT_GROUP_FIELD)) {
            throw error('CONFIG', `ACCOUNT_GROUP_FIELD "${ACCOUNT_GROUP_FIELD}" is not a valid field id.`);
        }
        const types = PL_TYPES.concat(BS_TYPES);
        const eg = loadGroups();
        const shop = loadShopGroups();
        return suiteql(
            `SELECT id, acctnumber, accountsearchdisplayname AS aname, accttype, parent, issummary, isinactive
               FROM account WHERE accttype IN (${types.map(() => '?').join(',')})`, types)
            .map(r => { const grp = eg.groups[r.id] || '';
                return { id: Number(r.id), num: r.acctnumber || '', name: cleanAccountName(r.aname, r.acctnumber),
                         type: r.accttype, parent: Number(r.parent) || 0, summary: r.issummary === 'T',
                         inactive: r.isinactive === 'T', group: grp, g: getSectionGroup(grp),
                         inherited: !!eg.inherited[r.id], bs: BS_TYPES.indexOf(r.accttype) >= 0 || getSectionGroup(grp, 'bs') !== null, sg: shop.groups[r.id] || '', sgi: !!shop.inherited[r.id] }; });
    }
    // meta still loads if the chart can't be read; the Accounts view then says so
    function chartForMeta() {
        try { return { chart: getChart() }; } catch (e) { return { chart: [], chartError: e.message }; }
    }

    /**
     * Every account's Account Group, after inheritance. An account whose ancestor carries a recognised group
     * takes that group, whatever group the account has itself (or none); with several such ancestors the topmost
     * one wins, so a whole branch of the chart sits together. `inherited` maps an account id to the ancestor it
     * took its group from. A value the report doesn't recognise can't place anything, so it is never inherited.
     */
    function loadGroups() {
        if (!/^custrecord[a-z0-9_]+$/.test(ACCOUNT_GROUP_FIELD)) {
            throw error('CONFIG', `ACCOUNT_GROUP_FIELD "${ACCOUNT_GROUP_FIELD}" is not a valid field id.`);
        }
        const parent = {}, own = {}, type = {};
        suiteql(`SELECT id, parent, accttype, BUILTIN.DF(${ACCOUNT_GROUP_FIELD}) AS g FROM account`).forEach(r => {
            parent[r.id] = Number(r.parent) || 0;
            type[r.id] = r.accttype;
            if (r.g) own[r.id] = r.g;
        });
        const groups = {}, inherited = {};
        Object.keys(parent).forEach(id => {
            let top = null, cur = Number(id), guard = 0;
            while (cur && guard++ < 20) {
                if (own[cur]) top = cur;                                // keeps climbing: the topmost group wins
                cur = parent[cur];
            }
            if (top !== null) {
                groups[id] = own[top];
                // flagged only when inheriting changed something: no group of its own, or a different one
                if (top !== Number(id) && normGroup(own[id]) !== normGroup(own[top])) inherited[id] = top;
            } else if (own[id]) {
                groups[id] = own[id];
            }
        });

        // groups this file doesn't know: classify each from the types of the accounts that carry it
        const members = {};
        Object.keys(groups).forEach(id => {
            const key = normGroup(groups[id]);
            if (!key || GROUP_NAMES[key]) return;
            const m = members[key] || (members[key] = { name: groups[id], is: 0, bs: 0, buckets: {} });
            if (PL_TYPES.indexOf(type[id]) >= 0) m.is++;
            else if (BUCKET[type[id]]) { m.bs++; m.buckets[BUCKET[type[id]]] = (m.buckets[BUCKET[type[id]]] || 0) + 1; }
        });
        DYN = {};
        const used = new Set();
        Object.keys(members).sort().forEach(key => {
            const m = members[key];
            const ov = GROUP_PLACEMENT[key];
            const kind = ov ? ov.kind : (m.bs > m.is ? 'bs' : 'is');
            const bucket = ov ? (ov.bucket || null) : (kind === 'bs' ? BUCKET_ORDER.slice().sort((x, y) => (m.buckets[y] || 0) - (m.buckets[x] || 0))[0] : null);
            // a code that depends only on the name, so the chart and every data request agree on it
            let h = 0x811c9dc5;
            for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
            let code = 1000 + (h % 9000);
            while (used.has(code)) code = 1000 + ((code - 999) % 9000);
            used.add(code);
            DYN[key] = { code, name: m.name, kind, bucket, mixed: !ov && m.is > 0 && m.bs > 0 };
        });
        // The statements print each built-in group under the name it has in the list, capitalisation and all.
        // Read the list itself; a group no account carries yet falls back to the page's own wording.
        BUILTIN_NAMES = {};
        const nameOf = nm => { const k = GROUP_NAMES[normGroup(nm)]; if (k !== undefined && BUILTIN_NAMES[G[k]] === undefined) BUILTIN_NAMES[G[k]] = String(nm).trim(); };
        try { suiteql(`SELECT name FROM ${ACCOUNT_GROUP_LIST}`).forEach(r => nameOf(r.name)); } catch (e) { /* list not readable: use the names on the accounts */ }
        Object.keys(groups).forEach(id => nameOf(groups[id]));
        return { groups, inherited };
    }
    function getAccountGroups() { return loadGroups().groups; }

    /**
     * Every account's Shop Cost Center Group: 'rev', 'repair', 'pers' or 'over' (see SHOP_GROUP_NAMES), as { groups: { accountId: key }, inherited: { accountId: true } }.
     * An account's own value wins; one with none takes the nearest parent account's, so a group set on a parent covers its
     * children, and a child can still be set differently. A value that is not one of the four sections is ignored.
     * `inherited` marks the accounts that took theirs from a parent. If the field is not on this account (an environment that
     * does not have it yet), nothing is assigned and nothing breaks.
     */
    function loadShopGroups() {
        const none = { groups: {}, inherited: {} };
        if (!/^custrecord[a-z0-9_]+$/.test(SHOP_GROUP_FIELD)) return none;
        const parent = {}, own = {}, out = {}, inh = {};
        try {
            suiteql(`SELECT id, parent, BUILTIN.DF(${SHOP_GROUP_FIELD}) AS g FROM account`).forEach(r => {
                parent[r.id] = Number(r.parent) || 0;
                const k = SHOP_GROUP_NAMES[normGroup(r.g).replace(/\s*&\s*/g, ' & ')];
                if (k) own[r.id] = k;
            });
        } catch (e) { log.error('Shop Cost Center Group could not be read', (e && e.message) || e); return none; }
        Object.keys(parent).forEach(id => {
            let cur = Number(id), guard = 0;
            while (cur && guard++ < 20) { if (own[cur]) { out[id] = own[cur]; if (cur !== Number(id)) inh[id] = true; break; } cur = parent[cur]; }
        });
        return { groups: out, inherited: inh };
    }

    // Lowest subsidiary that is an ancestor of (or equal to) every selected subsidiary.
    function commonAncestor(subIds, subs) {
        const parent = {};
        subs.forEach(s => { parent[s.id] = s.parent || 0; });
        subIds.forEach(id => {
            if (parent[id] === undefined) throw error('BAD_SUBSIDIARY', `Subsidiary ${id} does not exist or is inactive.`);
        });
        const chain = id => { const c = []; for (let x = id; x; x = parent[x]) c.push(x); return c; };
        let common = chain(subIds[0]);
        subIds.slice(1).forEach(id => { const c = new Set(chain(id)); common = common.filter(x => c.has(x)); });
        if (!common.length) throw error('NO_COMMON_PARENT', 'The selected subsidiaries share no common parent.');
        return common[0];
    }

    // ------------------------------------------------------------------------------------------
    // bsdata — balance sheet. Each column is the balance AT a month end: everything posted to the account
    // through that date (by transaction date), consolidated the same way as the income statement.
    //
    // Stockholders' equity also needs two calculated lines, as NetSuite's own balance sheet has:
    //   current year earnings  = net income from the fiscal year start through the date, on accounts 4000-8999
    //                            except 4180 (see EARNINGS_* above)
    //   prior years' earnings  = net income before that fiscal year on every income and expense account, not yet
    //                            closed to retained earnings
    // Income and expense accounts outside the current-year set leave the sheet out of balance by their amount,
    // and the page says so.
    // Amounts are debit-positive as posted; the page flips liabilities and equity to read as credits.
    // All subsidiaries here are USD; a non-USD subsidiary would need period-end rates for its balances.
    // ------------------------------------------------------------------------------------------

    function getBsData(params) {
        const periodIds = idList(params.periods, 'periods');
        const subIds = idList(params.subs, 'subs');
        if (periodIds.length > MAX_BS_COLUMNS) {
            throw error('TOO_MANY_PERIODS', `A balance sheet can show up to ${MAX_BS_COLUMNS} dates; ${periodIds.length} were requested.`);
        }
        const periods = getPeriods().filter(p => periodIds.includes(p.id)).sort((a, b) => a.start < b.start ? -1 : 1);
        if (periods.length !== periodIds.length) {
            throw error('BAD_PERIOD', 'One or more selected periods do not exist or are not monthly periods.');
        }
        const years = getYears();
        const isoRe = /^\d{4}-\d{2}-\d{2}$/;
        periods.forEach(p => {
            const y = years.find(y => p.start >= y.start && p.start <= y.end);
            if (!y) throw error('NO_FISCAL_YEAR', `No fiscal year is defined for ${p.name}.`);
            p.fyStart = y.start;
            if (!isoRe.test(p.end) || !isoRe.test(p.fyStart)) throw error('BAD_PERIOD', `Unexpected dates on ${p.name}.`);
        });

        const subs = suiteql(`SELECT id, parent FROM subsidiary WHERE isinactive = 'F'`);
        const to = Number(commonAncestor(subIds, subs));
        const amt = `BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${to}, t.postingperiod, 'DEFAULT')`;
        const d = iso => `TO_DATE('${iso}', 'YYYY-MM-DD')`;       // dates are validated above, so inlining is safe
        const lastEnd = periods[periods.length - 1].end;
        const from = `FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
              JOIN account a          ON a.id = tal.account`;

        // An income statement type account whose Account Group is a balance sheet group (the error trap accounts, for one)
        // is shown on the balance sheet, and is kept out of the two earnings lines so it is not counted twice.
        const groups = getAccountGroups();
        const plAll = suiteql(`SELECT id, acctnumber FROM account WHERE accttype IN (${PL_TYPES.map(() => '?').join(',')})`, PL_TYPES);
        const bsPl = plAll.map(r => Number(r.id)).filter(n => Number.isInteger(n) && n > 0 && getSectionGroup(groups[n], 'bs') !== null);
        const bsPlSet = new Set(bsPl);

        const rows = suiteql(`
            SELECT a.id AS acctid, a.acctnumber AS num, a.accountsearchdisplayname AS aname, a.accttype AS atype,
                   ${periods.map((p, i) => `SUM(CASE WHEN t.trandate <= ${d(p.end)} THEN ${amt} ELSE 0 END) AS b${i}`).join(',\n                   ')}
              ${from}
             WHERE tal.posting = 'T'
               AND (a.accttype IN (${BS_TYPES.map(() => '?').join(',')})${bsPl.length ? ` OR a.id IN (${bsPl.join(',')})` : ''})
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})
               AND t.trandate <= ${d(lastEnd)}
             GROUP BY a.id, a.acctnumber, a.accountsearchdisplayname, a.accttype`, [...BS_TYPES, ...subIds]);

        // ids are digits only (they come from the account table), so inlining the list is safe
        const curIds = plAll
            .filter(r => inCurrentEarnings(r.acctnumber)).map(r => Number(r.id)).filter(n => Number.isInteger(n) && n > 0 && !bsPlSet.has(n));
        const inCur = curIds.length ? `a.id IN (${curIds.join(',')})` : '1 = 0';
        const pl = suiteql(`
            SELECT ${periods.map((p, i) =>
                `SUM(CASE WHEN ${inCur} AND t.trandate >= ${d(p.fyStart)} AND t.trandate <= ${d(p.end)} THEN ${amt} ELSE 0 END) AS cy${i},
                   SUM(CASE WHEN t.trandate < ${d(p.fyStart)} THEN ${amt} ELSE 0 END) AS pr${i}`).join(',\n                   ')}
              ${from}
             WHERE tal.posting = 'T'
               AND a.accttype IN (${PL_TYPES.map(() => '?').join(',')})${bsPl.length ? ` AND a.id NOT IN (${bsPl.join(',')})` : ''}
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})
               AND t.trandate <= ${d(lastEnd)}`, [...PL_TYPES, ...subIds])[0] || {};
        const cents = v => Math.round((Number(v) || 0) * 100) / 100;
        // income is a credit, so net income is the negative of the debit-positive total
        const earnings = {
            current: periods.map((_, i) => cents(-(Number(pl['cy' + i]) || 0))),
            prior:   periods.map((_, i) => cents(-(Number(pl['pr' + i]) || 0)))
        };

        const warnings = [];
        const unknown = new Set();
        const accounts = [], bal = [], excl = {};
        rows.forEach(r => {
            const b = periods.map((_, i) => cents(r['b' + i]));
            if (b.every(v => Math.abs(v) < 0.005)) return;
            const fg = groups[r.acctid];
            const g = getSectionGroup(fg, 'bs');
            const name = cleanAccountName(r.aname, r.num);
            if (g === null) {
                if (fg && getSectionGroup(fg) === null) unknown.add(fg);
                if (isSystemAccount(r.num)) return;
                excl[r.acctid] = { id: Number(r.acctid), num: r.num || '', name, group: fg || '', type: r.atype, amounts: b };
                return;
            }
            accounts.push([r.num || '', name, g, r.atype, Number(r.acctid)]);
            bal.push(b);
        });

        const allAccts = {};
        suiteql(`SELECT id, acctnumber, accountsearchdisplayname AS aname, parent FROM account`)
            .forEach(a => { allAccts[a.id] = a; });
        const tree = {};
        accounts.forEach(a => {
            let id = a[4], guard = 0;
            while (id && allAccts[id] && guard++ < 20) {
                const x = allAccts[id];
                if (!tree[id]) tree[id] = [x.acctnumber || '', cleanAccountName(x.aname, x.acctnumber), Number(x.parent) || 0];
                id = Number(x.parent) || 0;
            }
        });

        const excluded = Object.values(excl).sort((a, b) => (a.num > b.num ? 1 : -1));
        if (unknown.size) {
            warnings.push(`Account Group value${unknown.size > 1 ? 's' : ''} the report doesn't recognise: ` +
                          [...unknown].join(', ') + '. Those accounts are listed as not on the report.');
        }
        groupDefs().filter(d => d.kind === 'bs' && accounts.some(a => a[2] === d.code)).forEach(d => {
            warnings.push(`Account Group "${d.name}" isn't one of the built-in groups, so it is placed under ${BUCKET_LABEL[d.bucket]}, ` +
                          'from the types of its accounts.' + (DYN[normGroup(d.name)].mixed ? ' It also holds income statement accounts, which are not shown here.' : ''));
        });
        const anyBsGroup = Object.values(groups).some(v => { const c = getSectionGroup(v, 'bs'); return c !== null; });
        if (!anyBsGroup) {
            warnings.push('No account has a balance sheet Account Group yet. Add the 17 balance sheet values to the ' +
                          'Account Groups list and assign them; until then every balance is listed under "Accounts not on Report".');
        } else if (excluded.length) {
            const n = excluded.length;
            warnings.push(`${n} account${n > 1 ? 's' : ''} with a balance ${n > 1 ? 'have' : 'has'} no balance sheet Account Group, ` +
                          'so the sheet will not balance until they are assigned — see "Accounts not on Report" below.');
        }
        return {
            ok: true, kind: 'bs', warnings, generated: new Date().toISOString(), consolidatedTo: to,
            periods: periods.map(p => ({ id: p.id, name: p.name, end: p.end, closed: p.closed })),
            subsidiaries: subIds, groupDefs: groupDefs(), groupNames: groupNames(), accounts, bal, tree, excluded, earnings,
            earningsFormula: earningsFormulaText()
        };
    }

    // ------------------------------------------------------------------------------------------
    // entry — the posting lines of one transaction, for expanding a drill-down row in place.
    // Amounts are the debit and credit as posted. Every subsidiary in this account is USD today; if a
    // non-USD subsidiary is added, lines here are in that subsidiary's currency, not consolidated.
    // ------------------------------------------------------------------------------------------

    // ------------------------------------------------------------------------------------------
    // entries — every posting line behind the requested accounts, for the "Excel (detailed)" export.
    //   period  : balance sheet — from the start of the books through the end of that one period
    //   periods : income statement — posting inside those periods, with the statement's dimension filters
    // Consolidated and filtered exactly as bsdata / data, so the lines add up to what the statement shows.
    // ------------------------------------------------------------------------------------------

    function getEntries(params) {
        const subIds = idList(params.subs, 'subs');
        const acctIds = idList(params.accounts, 'accounts');
        if (acctIds.length > MAX_DETAIL_ACCOUNTS) throw error('TOO_MANY_ACCOUNTS', `Up to ${MAX_DETAIL_ACCOUNTS} accounts can be listed at once.`);

        const asOf = params.period !== undefined && params.period !== '';
        let period = null, periodIds = [];
        if (asOf) {
            const pid = Number(params.period);
            if (!Number.isInteger(pid) || pid <= 0) throw error('BAD_PERIOD', 'Choose one balance sheet date.');
            period = getPeriods().find(p => p.id === pid);
            if (!period || !/^\d{4}-\d{2}-\d{2}$/.test(period.end)) throw error('BAD_PERIOD', 'That balance sheet date does not exist.');
        } else {
            periodIds = idList(params.periods, 'periods');
            if (periodIds.length > MAX_PERIODS) throw error('TOO_MANY_PERIODS', `Up to ${MAX_PERIODS} months can be listed.`);
        }
        const dims = {};
        if (!asOf) Object.keys(DIM_COLUMNS).forEach(k => { if (params[k] !== undefined) dims[k] = idList0(params[k], k); });
        if (Object.keys(dims).some(k => !dims[k].length)) return { ok: true, totals: {}, count: 0, truncated: false, limit: MAX_BS_ENTRIES, rows: [] };

        const subs = suiteql(`SELECT id, parent FROM subsidiary WHERE isinactive = 'F'`);
        const to = Number(commonAncestor(subIds, subs));
        const amt = `BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${to}, t.postingperiod, 'DEFAULT')`;
        const binds = [...acctIds, ...periodIds, ...subIds];
        let dimSql = '';
        Object.keys(dims).forEach(k => {
            dimSql += ` AND NVL(${DIM_COLUMNS[k]}, 0) IN (${dims[k].map(() => '?').join(',')})`;
            binds.push(...dims[k]);
        });
        const when = asOf
            ? `AND t.trandate <= TO_DATE('${period.end}', 'YYYY-MM-DD')`          // validated above, so inlining is safe
            : `AND t.postingperiod IN (${periodIds.map(() => '?').join(',')})`;
        const where = `
             WHERE tal.posting = 'T'
               AND tal.account IN (${acctIds.map(() => '?').join(',')})
               ${when}
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})${dimSql}`;
        const from = `
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline`;

        // the true count and total per account, whatever the listing below is cut to
        const totals = {};
        suiteql(`SELECT tal.account AS acct, COUNT(*) AS n, SUM(${amt}) AS amt ${from} ${where} GROUP BY tal.account`, binds)
            .forEach(r => { totals[r.acct] = { n: Number(r.n) || 0, amt: Math.round((Number(r.amt) || 0) * 100) / 100 }; });

        const paged = query.runSuiteQLPaged({
            query: `
            SELECT tal.account AS acct, t.id AS tid, t.tranid AS num, BUILTIN.DF(t.type) AS ttype,
                   TO_CHAR(t.trandate, 'YYYY-MM-DD') AS tdate, t.postingperiod AS pp, BUILTIN.DF(t.postingperiod) AS period,
                   BUILTIN.DF(t.entity) AS entity, tl.memo AS memo, BUILTIN.DF(tl.subsidiary) AS sub,
                   BUILTIN.DF(tl.department) AS dep, BUILTIN.DF(tl.class) AS cls, BUILTIN.DF(tl.location) AS loc,
                   BUILTIN.DF(tl.cseg_appf_mode) AS md, BUILTIN.DF(tl.cseg_appf_serv_type) AS svc,
                   ${amt} AS amt
              ${from} ${where}
             ORDER BY tal.account, t.trandate, t.id, tl.id`,
            params: binds, pageSize: 1000
        });
        const rows = [];
        for (const range of paged.pageRanges) {
            paged.fetch({ index: range.index }).data.asMappedResults().forEach(r => rows.push(r));
            if (rows.length >= MAX_BS_ENTRIES) break;
        }
        return {
            ok: true, period: period ? { id: period.id, name: period.name, end: period.end } : null,
            totals, count: paged.count, truncated: paged.count > MAX_BS_ENTRIES, limit: MAX_BS_ENTRIES,
            rows: rows.slice(0, MAX_BS_ENTRIES).map(r => ({
                a: Number(r.acct), id: Number(r.tid), num: r.num || '', type: r.ttype || '', date: r.tdate || '',
                pp: Number(r.pp) || 0, period: r.period || '', name: r.entity || '', memo: r.memo || '', sub: r.sub || '',
                dep: r.dep || '', cls: r.cls || '', loc: r.loc || '', md: r.md || '', svc: r.svc || '',
                amt: Math.round((Number(r.amt) || 0) * 100) / 100
            }))
        };
    }

    // The Vendor Invoice Lookup Suitelet, which AP invoices link to ("Open in Vendor Lookup"). Script and deployment ids differ
    // between sandbox and production: update them when this file is promoted. The deployment needs an external URL.
    const VENDOR_LOOKUP = { script: 1911, deploy: 1 };

    function getEntry(params) {
        const id = Number(params.id);
        if (!Number.isInteger(id) || id <= 0) throw error('BAD_ID', 'Invalid transaction.');
        const mine = new Set(params.accounts ? idList(params.accounts, 'accounts') : []);

        const head = suiteql(
            `SELECT t.tranid AS num, BUILTIN.DF(t.type) AS ttype, t.trandate AS tdate, t.memo AS memo
               FROM transaction t WHERE t.id = ?`, [id])[0];
        if (!head) throw error('NOT_FOUND', 'That transaction could not be found, or your role cannot see it.');

        const all = suiteql(`
            SELECT tl.id AS lid, tal.account AS acct, a.acctnumber AS num, a.accountsearchdisplayname AS aname,
                   tl.memo AS memo, BUILTIN.DF(tl.class) AS cls, BUILTIN.DF(tl.department) AS dep,
                   BUILTIN.DF(tl.location) AS loc, BUILTIN.DF(tl.cseg_appf_mode) AS md,
                   BUILTIN.DF(tl.cseg_appf_serv_type) AS svc, BUILTIN.DF(tl.subsidiary) AS sub,
                   tal.debit AS dr, tal.credit AS cr
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
              JOIN account a          ON a.id = tal.account
             WHERE tal.transaction = ? AND tal.posting = 'T'
             ORDER BY tl.id`, [id]);

        const lines = all.map(r => ({
            lid: Number(r.lid), acct: Number(r.acct), num: r.num || '', name: cleanAccountName(r.aname, r.num),
            memo: r.memo || '', cls: r.cls || '', dep: r.dep || '', loc: r.loc || '', md: r.md || '', svc: r.svc || '',
            sub: r.sub || '', dr: Math.round((Number(r.dr) || 0) * 100) / 100, cr: Math.round((Number(r.cr) || 0) * 100) / 100,
            mine: mine.has(Number(r.acct))
        }));
        const debit = Math.round(lines.reduce((t, l) => t + l.dr, 0) * 100) / 100;
        const credit = Math.round(lines.reduce((t, l) => t + l.cr, 0) * 100) / 100;

        // The order id (body field custbody_url_reference_id) and the Invoice Type (custbody_invoice_type) decide which outside system the
        // page links to. AR invoices follow the Invoice Type: Sales opens in Integrity, Service/Repairs in TMT's invoice page, and with
        // no Invoice Type there is no link. AP invoices always open TMT's purchase page and GL entries its repair page. Other types: no link.
        // Read on their own so an account without these fields still shows the entry.
        let orderId = '', ext = '';
        try {
            const t = suiteql(`SELECT t.custbody_url_reference_id AS oid, t.type AS ttype, BUILTIN.DF(t.custbody_invoice_type) AS itype FROM transaction t WHERE t.id = ?`, [id])[0];
            const it = String((t && t.itype) || '').trim();
            if (t && /^\d{1,12}$/.test(String(t.oid || '').trim())) {
                if (String(t.ttype) === 'VendBill') ext = 'tmtpurchase';
                else if (String(t.ttype) === 'Journal') ext = 'tmtrepair';
                else if (String(t.ttype) === 'CustInvc') {
                    if (/^sales$/i.test(it)) ext = 'integrity';
                    else if (/^service\s*\/\s*repairs?$/i.test(it)) ext = 'tmt';
                }
                if (ext) orderId = String(t.oid).trim();
            }
        } catch (e) { log.debug('Order id could not be read', (e && e.message) || e); }

        // AP invoices (vendor bills) also link to the vendor lookup, which opens the bill with its scanned document (&b=<bill id>).
        let lookup = '';
        try {
            const ty = suiteql(`SELECT t.type AS ttype FROM transaction t WHERE t.id = ?`, [id])[0];
            if (ty && String(ty.ttype) === 'VendBill') {
                lookup = url.resolveScript({ scriptId: VENDOR_LOOKUP.script, deploymentId: VENDOR_LOOKUP.deploy, returnExternalUrl: true, params: { b: id } });
            }
        } catch (e) { log.debug('Vendor lookup link could not be built', (e && e.message) || e); }

        // a very large entry: keep the requested accounts' lines first, then the rest, in line order
        let shown = lines;
        if (lines.length > MAX_ENTRY_LINES) {
            shown = lines.slice().sort((x, y) => (y.mine - x.mine) || (x.lid - y.lid)).slice(0, MAX_ENTRY_LINES)
                         .sort((x, y) => x.lid - y.lid);
        }
        return { ok: true, id, num: head.num || '', type: head.ttype || '', date: head.tdate || '', memo: head.memo || '', orderId, ext, lookup,
                 lines: shown, count: lines.length, truncated: lines.length > shown.length, debit, credit };
    }

    // ------------------------------------------------------------------------------------------
    // compare — the same accounts over two period sets, grouped by the name on the transaction.
    // Lets a flagged swing be explained as "this vendor was here last month and isn't now".
    // Filtered exactly as the statement is, so the two sides are comparable.
    // ------------------------------------------------------------------------------------------

    function getCompare(params) {
        const acctIds = idList(params.accounts, 'accounts');
        if (acctIds.length > MAX_DETAIL_ACCOUNTS) throw error('TOO_MANY_ACCOUNTS', 'Too many accounts to compare at once.');
        const cur = idList(params.periods, 'periods');
        const base = idList(params.base, 'base');
        const subIds = idList(params.subs, 'subs');
        const dims = {};
        Object.keys(DIM_COLUMNS).forEach(k => { if (params[k] !== undefined) dims[k] = idList0(params[k], k); });
        if (Object.keys(dims).some(k => !dims[k].length)) return { ok: true, names: [], curTotal: 0, baseTotal: 0 };

        const subs = suiteql(`SELECT id, parent FROM subsidiary WHERE isinactive = 'F'`);
        const to = Number(commonAncestor(subIds, subs));
        const all = [...new Set([...cur, ...base])];
        const amt = `BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${to}, t.postingperiod, 'DEFAULT')`;

        // bind order follows the SQL text: CASE lists first, then the WHERE clauses
        const binds = [...cur, ...base, ...acctIds, ...all, ...subIds];
        let dimSql = '';
        Object.keys(DIM_COLUMNS).forEach(k => {
            if (!dims[k]) return;
            dimSql += ` AND NVL(${DIM_COLUMNS[k]}, 0) IN (${dims[k].map(() => '?').join(',')})`;
            binds.push(...dims[k]);
        });
        const sql = `
            SELECT NVL(BUILTIN.DF(t.entity), '(no name)') AS nm,
                   SUM(CASE WHEN t.postingperiod IN (${cur.map(() => '?').join(',')})  THEN ${amt} ELSE 0 END) AS curamt,
                   SUM(CASE WHEN t.postingperiod IN (${base.map(() => '?').join(',')}) THEN ${amt} ELSE 0 END) AS baseamt,
                   COUNT(DISTINCT t.id) AS ntx,
                   MAX(t.id) AS lastid
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
             WHERE tal.posting = 'T'
               AND tal.account IN (${acctIds.map(() => '?').join(',')})
               AND t.postingperiod IN (${all.map(() => '?').join(',')})
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})${dimSql}
             GROUP BY NVL(BUILTIN.DF(t.entity), '(no name)')`;

        const rows = suiteql(sql, binds).map(r => ({
            name: r.nm || '(no name)',
            cur: Math.round((Number(r.curamt) || 0) * 100) / 100,
            base: Math.round((Number(r.baseamt) || 0) * 100) / 100,
            ntx: Number(r.ntx) || 0,
            lastId: Number(r.lastid) || 0
        })).filter(r => Math.abs(r.cur) >= 0.005 || Math.abs(r.base) >= 0.005);

        rows.sort((a, b) => Math.abs(b.cur - b.base) - Math.abs(a.cur - a.base));
        return {
            ok: true,
            names: rows.slice(0, MAX_COMPARE_NAMES),
            truncated: rows.length > MAX_COMPARE_NAMES,
            curTotal: Math.round(rows.reduce((t, r) => t + r.cur, 0) * 100) / 100,
            baseTotal: Math.round(rows.reduce((t, r) => t + r.base, 0) * 100) / 100
        };
    }

    // ------------------------------------------------------------------------------------------
    // Flag resolutions
    // ------------------------------------------------------------------------------------------

    function flagsReadyForMeta() {
        try { suiteql(`SELECT id FROM ${FLAG_RECORD} WHERE ROWNUM <= 1`); return { flagsReady: true }; }
        catch (e) { return { flagsReady: false, flagsError: e.message }; }
    }

    function flagRows(keys) {
        const out = [];
        for (let i = 0; i < keys.length; i += 500) {
            const part = keys.slice(i, i + 500);
            suiteql(`SELECT id, name, ${FLAG_KEY_FIELD} AS k, ${FLAG_COMMENT_FIELD} AS c, owner,
                            BUILTIN.DF(owner) AS ownername, created
                       FROM ${FLAG_RECORD}
                      WHERE isinactive = 'F' AND ${FLAG_KEY_FIELD} IN (${part.map(() => '?').join(',')})`, part)
                .forEach(r => out.push(r));
        }
        const me = Number(runtime.getCurrentUser().id), admin = isAdmin();
        return out.map(r => ({ id: Number(r.id), key: r.k, label: r.name || '', comment: r.c || '',
                               by: r.ownername || '', on: r.created || '',
                               canReopen: admin || Number(r.owner) === me }));
    }

    function readKeys(raw) {
        let keys;
        try { keys = JSON.parse(raw || '[]'); } catch (e) { throw error('BAD_KEYS', 'Flag keys could not be read.'); }
        if (!Array.isArray(keys)) throw error('BAD_KEYS', 'Flag keys could not be read.');
        keys = [...new Set(keys.map(String))];
        if (keys.length > MAX_FLAG_KEYS) throw error('BAD_KEYS', 'Too many flags at once.');
        if (keys.some(k => !FLAG_KEY_RE.test(k))) throw error('BAD_KEYS', 'Invalid flag key.');
        return keys;
    }

    function listResolutions(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Must be a POST.');
        const keys = readKeys(ctx.request.parameters.keys);
        return keys.length ? flagRows(keys) : [];
    }

    // Line comments: anyone can read them and add to them; only the person who wrote one can delete it.
    // They are stored in the flag record as  name = c1|<12-hex line id>|<line label>,  one record per comment, owned by its author.
    const CMT_HASH_RE = /^[0-9a-f]{12}$/;
    function commentsFor(hashes) {
        const want = {}; hashes.forEach(h => { want[h] = true; });
        const me = Number(runtime.getCurrentUser().id), out = {};
        if (!hashes.length) return out;
        suiteql(`SELECT id, name, ${FLAG_COMMENT_FIELD} AS c, owner, BUILTIN.DF(owner) AS ownername, created
                   FROM ${FLAG_RECORD} WHERE name LIKE 'c1|%' ORDER BY created, id`).forEach(r => {
            const m = /^c1\|([0-9a-f]{12})\|/.exec(r.name || '');
            if (!m || !want[m[1]]) return;
            (out[m[1]] = out[m[1]] || []).push({ id: Number(r.id), by: r.ownername || '', on: r.created || '', text: r.c || '', mine: Number(r.owner) === me });
        });
        return out;
    }
    function listComments(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Must be a POST.');
        let keys; try { keys = JSON.parse(ctx.request.parameters.keys || '[]'); } catch (e) { keys = []; }
        if (!Array.isArray(keys)) keys = [];
        keys = keys.filter(k => CMT_HASH_RE.test(String(k))).slice(0, 2000);
        return { ok: true, comments: commentsFor(keys) };
    }
    function addComment(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Saving must be a POST.');
        const p = ctx.request.parameters, hash = String(p.hash || '');
        if (!CMT_HASH_RE.test(hash)) throw error('BAD_LINE', 'That line could not be identified.');
        const text = String(p.text || '').trim().slice(0, 2000);
        if (!text) throw error('NO_TEXT', 'Write a comment first.');
        const label = String(p.label || '').replace(/[|\r\n]/g, ' ').trim().slice(0, 200);
        const rec = record.create({ type: FLAG_RECORD });
        rec.setValue({ fieldId: 'name', value: 'c1|' + hash + '|' + label });
        rec.setValue({ fieldId: FLAG_KEY_FIELD, value: 'c1-' + hash + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) });
        rec.setValue({ fieldId: FLAG_COMMENT_FIELD, value: text });
        rec.save();
        return { ok: true, comments: commentsFor([hash]) };
    }
    function deleteComment(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Deleting must be a POST.');
        const id = Number(ctx.request.parameters.id);
        if (!Number.isInteger(id) || id <= 0) throw error('BAD_ID', 'That comment could not be identified.');
        const r = suiteql(`SELECT id, name, owner FROM ${FLAG_RECORD} WHERE id = ?`, [id])[0];
        const m = r && /^c1\|([0-9a-f]{12})\|/.exec(r.name || '');
        if (!m) throw error('NOT_FOUND', 'That comment no longer exists.');
        if (Number(r.owner) !== Number(runtime.getCurrentUser().id)) throw error('NOT_YOURS', 'Only the person who wrote a comment can delete it.');
        record.delete({ type: FLAG_RECORD, id });
        return { ok: true, comments: commentsFor([m[1]]) };
    }

    // Notes history: every comment ever saved on a flag, newest first, including the ones since reopened.
    // The flag's saved title starts with the account number ("6730 Fuel — Aug 2026 vs Jul 2026"), which is what finds an account's notes.
    function listNotes(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Must be a POST.');
        const p = ctx.request.parameters;
        const acct = String(p.acct || '').trim();
        if (acct && !/^[0-9A-Za-z.\-]{1,20}$/.test(acct)) throw error('BAD_ACCT', 'Invalid account.');
        const skip = String(p.skip || '');
        if (skip && !FLAG_KEY_RE.test(skip)) throw error('BAD_KEY', 'Invalid flag.');
        const binds = []; let where = "name NOT LIKE 'c1|%'";        // line comments live in the same record; they are not flag notes
        if (acct) { where += ' AND name LIKE ?'; binds.push(acct + ' %'); }
        if (skip) { where += ` AND ${FLAG_KEY_FIELD} <> ?`; binds.push(skip); }
        const rows = suiteql(`SELECT id, name, ${FLAG_KEY_FIELD} AS k, ${FLAG_COMMENT_FIELD} AS c, owner, BUILTIN.DF(owner) AS ownername,
                                     created, isinactive
                                FROM ${FLAG_RECORD} WHERE ${where} ORDER BY created DESC, id DESC`, binds);
        const me = Number(runtime.getCurrentUser().id), admin = isAdmin();
        const all = p.empty === '1' ? rows : rows.filter(r => String(r.c || '').trim());
        return { ok: true, truncated: all.length > 1000,
                 notes: all.slice(0, 1000).map(r => ({
                     id: Number(r.id), key: r.k || '', label: r.name || '', comment: r.c || '', by: r.ownername || '', on: r.created || '',
                     reopened: r.isinactive === 'T' || r.isinactive === true,
                     canReopen: admin || Number(r.owner) === me })) };
    }

    function resolveFlag(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Must be a POST.');
        const p = ctx.request.parameters;
        const key = String(p.key || '');
        if (!FLAG_KEY_RE.test(key)) throw error('BAD_KEY', 'Invalid flag.');
        const label = String(p.label || '').trim().slice(0, 290) || 'Flag';
        const comment = String(p.comment || '').trim().slice(0, 4000);
        const existing = flagRows([key])[0];
        if (existing) {
            record.submitFields({ type: FLAG_RECORD, id: existing.id, values: { [FLAG_COMMENT_FIELD]: comment } });
        } else {
            try {
                const rec = record.create({ type: FLAG_RECORD });
                rec.setValue({ fieldId: 'name', value: label });
                rec.setValue({ fieldId: FLAG_KEY_FIELD, value: key });
                rec.setValue({ fieldId: FLAG_COMMENT_FIELD, value: comment });
                rec.save();
            } catch (e) {
                // if the record insists on one entry per key, bring the reopened one back instead
                const old = suiteql(`SELECT id FROM ${FLAG_RECORD} WHERE ${FLAG_KEY_FIELD} = ? ORDER BY id DESC`, [key])[0];
                if (!old) throw e;
                record.submitFields({ type: FLAG_RECORD, id: Number(old.id), values: { isinactive: false, [FLAG_COMMENT_FIELD]: comment } });
            }
        }
        return { ok: true, resolution: flagRows([key])[0] };
    }

    function reopenFlag(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Must be a POST.');
        const key = String(ctx.request.parameters.key || '');
        if (!FLAG_KEY_RE.test(key)) throw error('BAD_KEY', 'Invalid flag.');
        const r = flagRows([key])[0];
        if (!r) return { ok: true };
        if (!r.canReopen) throw error('NOT_ALLOWED', `Only ${r.by || 'whoever resolved it'} or an administrator can reopen this flag.`);
        record.submitFields({ type: FLAG_RECORD, id: r.id, values: { isinactive: true } });     // kept in the notes history
        return { ok: true };
    }

    // ------------------------------------------------------------------------------------------
    // Saved reports
    // ------------------------------------------------------------------------------------------

    // Meta still loads if the custom record hasn't been created yet; the page then disables saving.
    function savedReportsForMeta() {
        try { return { reports: listReports(), reportsReady: true }; }
        catch (e) { return { reports: [], reportsReady: false, reportsError: e.message }; }
    }

    // ---- portable ids ----
    // Saved definitions (layouts, pivots, schedules, saved columns) hold each dimension record by its EXTERNAL id, written 'x:<external id>',
    // and each fixed fiscal quarter or year by its start date ('q:2026-07-01'), never by an internal id. A sandbox refresh or a move to
    // production renumbers internal ids but keeps external ids, so a saved report cannot end up pointing at the wrong record.
    // listReports() turns the tokens back into this account's internal ids before the page sees them, and saveReport() does the reverse,
    // so nothing on screen changes. Definitions saved before this still hold plain internal ids; they are read as they are and convert
    // the next time they are saved. A record with no external id keeps its internal id.
    const EXT_TABLES = { subs: 'subsidiary', pcs: 'classification', deps: 'department', locs: 'location',
                         mods: 'customrecord_cseg_appf_mode', svcs: 'customrecord_cseg_appf_serv_type' };
    const PIVOT_DIMS = { sub: 'subs', pc: 'pcs', dep: 'deps', loc: 'locs', mode: 'mods', svc: 'svcs' };

    function portableMaps() {
        const m = { toExt: {}, toId: {}, qById: {}, qByStart: {}, yById: {}, yByStart: {} };
        Object.keys(EXT_TABLES).forEach(k => {
            m.toExt[k] = {}; m.toId[k] = {};
            try {
                suiteql(`SELECT id, externalid FROM ${EXT_TABLES[k]}`).forEach(r => {
                    if (r.externalid) { m.toExt[k][String(r.id)] = String(r.externalid); m.toId[k][String(r.externalid)] = Number(r.id); }
                });
            } catch (e) { log.error('External ids could not be read for ' + EXT_TABLES[k], (e && e.message) || e); }
        });
        try {
            getQuarters().forEach(q => { m.qById[q.id] = q.start; m.qByStart[q.start] = q.id; });
            getYears().forEach(y => { m.yById[y.id] = y.start; m.yByStart[y.start] = y.id; });
        } catch (e) { log.error('Fiscal quarters and years could not be read', (e && e.message) || e); }
        return m;
    }

    // toExt true: internal ids -> tokens (saving). false: tokens -> this account's internal ids (loading). getM builds the maps once, on first use.
    function convertIds(def, toExt, getM) {
        if (!def || typeof def !== 'object') return def;
        const one = (k, x) => {
            if (toExt) {
                const n = Number(x);
                return (typeof x === 'number' || /^\d+$/.test(String(x))) && n > 0 && getM().toExt[k][String(n)] ? 'x:' + getM().toExt[k][String(n)] : x;
            }
            if (typeof x === 'string' && x.indexOf('x:') === 0) { const id = getM().toId[k][x.slice(2)]; return id === undefined ? null : id; }
            return x;
        };
        const list = (k, a) => (Array.isArray(a) ? a : []).map(x => one(k, x)).filter(x => x !== null);
        const filt = f => { if (f && typeof f === 'object') Object.keys(EXT_TABLES).forEach(k => { if (Array.isArray(f[k])) f[k] = list(k, f[k]); }); };
        const tpl = arr => (Array.isArray(arr) ? arr : []).forEach(c => {
            if (!c || c.fx === undefined || (c.t !== 'quarter' && c.t !== 'year')) return;
            const q = c.t === 'quarter', pre = q ? 'q:' : 'y:', byId = q ? getM().qById : getM().yById, byStart = q ? getM().qByStart : getM().yByStart;
            if (toExt) { if (byId[c.fx]) c.fx = pre + byId[c.fx]; }
            else if (typeof c.fx === 'string' && c.fx.indexOf(pre) === 0) { if (byStart[c.fx.slice(2)] !== undefined) c.fx = byStart[c.fx.slice(2)]; else delete c.fx; }
        });
        tpl(def.cols);
        const L = def.layout;
        if (L && typeof L === 'object') {
            (Array.isArray(L.lines) ? L.lines : []).forEach(l => {
                filt(l.lf);
                (Array.isArray(l.a) ? l.a : []).forEach(a => {                          // [account number, dimension, record id]
                    if (Array.isArray(a) && a[1] && EXT_TABLES[a[1]] && a[2] !== null && a[2] !== undefined) { const v = one(a[1], a[2]); a[2] = v === null ? -1 : v; }
                });
            });
            (Array.isArray(L.pages) ? L.pages : []).forEach(pg => filt(pg && pg.f));
            if (L.pivot && typeof L.pivot === 'object') ['rows', 'cols'].forEach(ax => (Array.isArray(L.pivot[ax]) ? L.pivot[ax] : []).forEach(lv => {
                if (lv && PIVOT_DIMS[lv.f]) lv.v = list(PIVOT_DIMS[lv.f], lv.v);
                else if (lv && lv.f === 'period') tpl(lv.v);
            }));
        }
        const V = def.sched && def.sched.view;
        if (V && V.filters && typeof V.filters === 'object') {
            filt(V.filters);
            if (Array.isArray(V.filters.pcg)) V.filters.pcg = list('pcs', V.filters.pcg);       // an older schedule's profit center groups
        }
        return def;
    }

    // A custom report (layout, or saved columns) is private to the person who made it unless they ticked Public.
    // Flag settings and schedules are shared settings and stay visible to everyone, with who made them.
    // Changing a schedule: its owner, an administrator, or anyone at all when the owner ticked Shared (pub).
    // Deleting one stays with its owner or an administrator. allRows = true skips the filter
    // (name checks and deletes by the owner or an administrator).
    function listReports(allRows) {
        const me = runtime.getCurrentUser();
        const admin = isAdmin();
        let pm = null;
        const getM = () => pm || (pm = portableMaps());
        const all = suiteql(`SELECT id, name, ${REPORT_DEF_FIELD} AS def, owner, BUILTIN.DF(owner) AS ownername
                          FROM ${REPORT_RECORD} WHERE isinactive = 'F' ORDER BY name`)
            .map(r => {
                let def = null;
                try { def = convertIds(JSON.parse(r.def), false, getM); } catch (e) { /* unreadable definitions are listed but not usable */ }
                return { id: Number(r.id), name: r.name, def, owner: Number(r.owner) || 0, ownerName: r.ownername || '',
                         pub: !!(def && def.pub === true), mine: Number(r.owner) === Number(me.id),
                         canDelete: Number(r.owner) === Number(me.id) || (admin && def && (def.kind === 'flagcfg' || def.kind === 'schedule')),
                         sharedSchedule: !!(def && def.kind === 'schedule' && def.pub === true) };
            });
        all.forEach(r => { r.canEdit = r.canDelete || r.sharedSchedule; delete r.sharedSchedule; });
        if (allRows) return all;
        const shared = k => k === 'flagcfg' || k === 'schedule';
        return all.filter(r => r.mine || r.pub || (r.def && shared(r.def.kind)));
    }

    function saveReport(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Saving must be a POST.');
        const p = ctx.request.parameters;
        const name = String(p.name || '').trim().replace(/\s+/g, ' ');
        if (!name) throw error('NO_NAME', 'Give the report a name.');
        if (name.length > 80) throw error('NAME_TOO_LONG', 'Report names can be up to 80 characters.');
        let def;
        try { def = JSON.parse(p.def || ''); } catch (e) { throw error('BAD_DEFINITION', 'The report definition could not be read.'); }
        const isLayout = def && def.kind === 'layout';
        let payload;
        if (def && def.kind === 'flagcfg') payload = JSON.stringify({ v: 1, kind: 'flagcfg', cfg: cleanFlagCfg(def.cfg) });
        else if (def && def.kind === 'schedule') payload = JSON.stringify({ v: 1, kind: 'schedule', sched: cleanSchedule(def.sched), pub: def.pub === true });
        else if (isLayout) {
            const lay = cleanLayout(def.layout);
            let cols;
            if (Array.isArray(def.cols) && def.cols.length) { validateTemplate({ cols: def.cols }); cols = def.cols; }
            payload = JSON.stringify({ v: 1, kind: 'layout', layout: lay, cols, pub: def.pub === true });
        }
        else { validateTemplate(def); payload = JSON.stringify({ v: 1, kind: def.kind === 'bs' ? 'bs' : 'is', cols: def.cols, pub: def.pub === true }); }

        // stored by external ids, so a sandbox refresh cannot repoint it (see "portable ids" above)
        let pmS = null;
        payload = JSON.stringify(convertIds(JSON.parse(payload), true, () => pmS || (pmS = portableMaps())));

        const me = runtime.getCurrentUser();
        const all = listReports(true);
        // a layout being edited is saved back by id, so it can be renamed
        const editId = Number(p.id) || 0;
        let target = null;
        if (editId) {
            target = all.find(r => r.id === editId);
            if (!target) throw error('NOT_FOUND', 'That layout no longer exists.');
            if (!target.canEdit) throw error('NOT_ALLOWED', `Only ${target.ownerName || 'its creator'} or an administrator can change "${target.name}".`);
            if (!target.canDelete) {                                    // someone else's shared schedule: it stays a schedule, and stays shared
                if (!def || def.kind !== 'schedule') throw error('NOT_ALLOWED', `"${target.name}" is a shared schedule; it can only be saved as a schedule.`);
                const keep = JSON.parse(payload); keep.pub = true; payload = JSON.stringify(keep);
            }
        }
        // a name only clashes with reports this person can see (theirs and the public ones), and a public report needs a name no other public report has
        const wantPub = def && def.pub === true && (isLayout || def.kind === 'is' || def.kind === 'bs');
        const same = all.filter(r => r.name.toLowerCase() === name.toLowerCase() && r.id !== editId && (r.mine || r.pub || (r.def && (r.def.kind === 'flagcfg' || r.def.kind === 'schedule'))));
        if (wantPub) {
            const clash = all.find(r => r.pub && !r.mine && r.id !== editId && r.name.toLowerCase() === name.toLowerCase());
            if (clash) throw error('NAME_TAKEN', `A public report called \"${name}\" already exists. Pick another name to make this one public.`);
        }
        if (same.length && !same.some(r => r.owner === Number(me.id))) {
            throw error('NAME_TAKEN', `A report called "${name}" was already saved by ${same[0].ownerName || 'someone else'}. Pick another name.`);
        }
        const mine = same.find(r => r.owner === Number(me.id));
        if (!target && mine) {
            if (p.overwrite !== 'T') return { ok: false, error: 'EXISTS', message: `You already have a report called "${name}".`, id: mine.id };
            target = mine;
        } else if (target && mine) {
            throw error('NAME_TAKEN', `You already have a report called "${name}". Pick another name.`);
        }
        let id;
        try {
            if (target) {
                id = record.submitFields({ type: REPORT_RECORD, id: target.id, values: { name, [REPORT_DEF_FIELD]: payload } });
            } else {
                const rec = record.create({ type: REPORT_RECORD });
                rec.setValue({ fieldId: 'name', value: name });
                rec.setValue({ fieldId: REPORT_DEF_FIELD, value: payload });
                id = rec.save();
            }
        } catch (e) {
            if (isLayout && /length|too long|exceed/i.test(e.message || '')) {
                throw error('TOO_LONG', `This layout is ${payload.length.toLocaleString()} characters, more than the saved-report field holds. Change ${REPORT_DEF_FIELD} to a Long Text field.`);
            }
            throw e;
        }
        return { ok: true, id: Number(id), reports: listReports() };
    }

    // Flag sensitivity: normal thresholds for every account, overrides for some, and the High/Low factors.
    function cleanFlagCfg(c) {
        const num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
        const D = { pct: 0.25, amt: 0.002, dol: 5000 };
        const LIM = { pct: 100, amt: 100, dol: 1e9 };
        const use = u => (u && typeof u === 'object') ? { pct: !!u.pct, cpm: !!u.cpm, dol: !!u.dol } : null;       // which tests apply
        const mode = m => (m === 'all' || m === 'any') ? m : null;                                                // the old setting: all of them, or any one
        // and / or between the tests (percent and dollar; then before cost per mile); an old all / any becomes and / or. "" on an account: the default decides
        const join = x => (x === 'and' || x === 'or') ? x : '';
        const opsOf = o => { const m = mode(o && o.mode), l = m === 'any' ? 'or' : m === 'all' ? 'and' : '', a = Array.isArray(o && o.ops) ? o.ops : [];
                             return [join(a[0]) || l, join(a[1]) || l]; };
        c = c || {};
        const base = {}; Object.keys(D).forEach(f => { base[f] = num(c.base && c.base[f], 0, LIM[f], D[f]); });
        base.use = use(c.base && c.base.use) || { pct: true, cpm: true, dol: false };
        base.ops = opsOf(c.base).map(x => x || 'and');
        const accts = {};
        Object.keys(c.accts || {}).slice(0, 3000).forEach(k => {
            const key = String(k).slice(0, 20).trim(), o = c.accts[k] || {}, out = {};
            Object.keys(D).forEach(f => { if (o[f] !== undefined && o[f] !== null && o[f] !== '') out[f] = num(o[f], 0, LIM[f], base[f]); });
            if (use(o.use)) out.use = use(o.use);
            const ops = opsOf(o); if (ops[0] || ops[1]) out.ops = ops;
            if (key && Object.keys(out).length) accts[key] = out;
        });
        return { base, high: num(c.high, 0.05, 20, 0.5), low: num(c.low, 0.05, 20, 2), accts };
    }

    // A layout: lines (heading, accounts, total, calculation, miles, blank), each accounts line with its
    // account numbers, each optionally narrowed to one dimension value, and pages (sets of locations).
    const LAYOUT_TYPES = ['heading', 'detail', 'total', 'calc', 'miles', 'blank', 'roa', 'stat', 'growth', 'assets', 'bal', 'ttm', 'sars'];
    const LAYOUT_DIMS = ['', 'subs', 'locs', 'deps', 'pcs', 'mods', 'svcs'];
    // a set of dimension filters: {locs:[ids], deps:[...], pcs:[...], mods:[...], svcs:[...]}; 0 is "none"
    function cleanFilter(f) {
        if (!f || typeof f !== 'object') return null;
        const out = {};
        LAYOUT_DIMS.filter(Boolean).forEach(k => {
            const v = (Array.isArray(f[k]) ? f[k] : []).map(Number).filter(x => Number.isInteger(x) && x >= 0).slice(0, 500);
            if (v.length) out[k] = Array.from(new Set(v));
        });
        return Object.keys(out).length ? out : null;
    }
    function cleanLayout(L) {
        if (!L || !Array.isArray(L.lines)) throw error('BAD_LAYOUT', 'The layout has no lines.');
        if (L.lines.length > 400) throw error('BAD_LAYOUT', 'A layout can have up to 400 lines.');
        const str = (x, n) => String(x === undefined || x === null ? '' : x).slice(0, n);
        const lines = L.lines.map(l => {
            const c = Number(l.c);
            if (!Number.isInteger(c) || c < 0 || c > 999999) throw error('BAD_LAYOUT', `Line code "${l.c}" must be a whole number.`);
            const t = LAYOUT_TYPES.indexOf(l.t) >= 0 ? l.t : 'detail';
            const out = { c, l: str(l.l, 120), t, i: Math.max(0, Math.min(6, Number(l.i) || 0)) };
            if (t === 'total' || t === 'calc' || t === 'roa' || t === 'growth' || t === 'ttm') out.f = str(l.f, 400);
            if (['begin', 'end', 'avg'].indexOf(l.m) >= 0 && t === 'assets') out.m = l.m;     // which balance an assets line shows
            if (l.per && t === 'roa') out.per = true;                                         // a return for the period, not annualized
            if (l.ys && (t === 'roa' || t === 'assets')) out.ys = true;
            if (l.d2 && (t === 'roa' || t === 'calc')) out.d2 = true;                         // percentages to two decimals                       // monthly columns measure from the start of the fiscal year
            if (l.k === 'equity' && t === 'bal') out.k = 'equity';                             // a balance line that is total stockholders' equity
            if (l.neg && t === 'bal') out.neg = true;                                         // liabilities shown as positive amounts
            if (['avg', 'sum'].indexOf(l.agg) >= 0 && t === 'stat') out.agg = l.agg;           // how a count rolls up: the last month (default), the average or the sum
            if (t === 'detail' || t === 'roa' || t === 'stat' || t === 'assets' || t === 'bal') {
                const a = Array.isArray(l.a) ? l.a.slice(0, 300) : [];
                out.a = a.map(x => {
                    const num = str(Array.isArray(x) ? x[0] : '', 20).trim();
                    const dim = LAYOUT_DIMS.indexOf(x[1]) >= 0 ? x[1] : '';
                    const val = dim ? Number(x[2]) : null;
                    if (!num) throw error('BAD_LAYOUT', 'An account on the layout has no number.');
                    if (dim && !(Number.isInteger(val) && val >= 0)) throw error('BAD_LAYOUT', `Pick a value for the dimension on account ${num}.`);
                    return [num, dim, dim ? val : null];
                });
            }
            if (l.n !== undefined && l.n !== null) out.n = str(l.n, 20);      // '' is kept: a parent line with no number of its own
            if (l.nf) out.nf = true;                                   // counts the whole company, ignoring the page's filters
            if (l.pm) out.pm = true;                                   // miles that follow the page's profit centers
            if (l.h) out.h = true;                                   // hidden: used by formulas, not shown
            if (l.ch) out.ch = true;                                 // a child line, shown only when the report is expanded
            if (Array.isArray(l.xc)) out.xc = l.xc.slice(0, 3).map(n => Number.isInteger(n) ? n : null);        // the lines whose figures fill the extra columns
            if (Array.isArray(l.xfmt)) out.xfmt = l.xfmt.slice(0, 3).map(f => ['pct', 'usd', 'num'].indexOf(f) >= 0 ? f : 'pct');
            if (l.sx) out.sx = true;                                 // a line inside a section, hidden when only section totals show
            if (t === 'calc' && (l.fmt === 'pct' || l.fmt === 'cpm' || l.fmt === 'num')) out.fmt = l.fmt;    // a calculation shown as a percentage, or as dollars per mile
            const lf = cleanFilter(l.lf);
            if (lf) out.lf = lf;
            return out;
        });
        const pages = (Array.isArray(L.pages) ? L.pages : []).slice(0, 40).map(pg => {
            const f = cleanFilter(pg.f) || cleanFilter({ locs: pg.locs }) || {};
            return { n: str(pg.n, 80) || 'Page', f };
        });
        const pivot = cleanPivot(L.pivot);
        return { lines, pages, pivot, T: L.T ? true : undefined, nest: L.nest ? (L.nest === 'months' || L.nest === 'all' ? L.nest : true) : undefined, noCpm: L.noCpm ? true : undefined, xcols: Array.isArray(L.xcols) && L.xcols.length ? L.xcols.slice(0, 3).map(x => str(x, 80)) : undefined, fullMonths: L.fullMonths ? true : undefined };   // T: columns down the side; nest: quarters under their year; noCpm: amounts only
    }

    // A pivot report: rows and columns are each a list of levels (nested in order); a level is a field and the values chosen for it.
    function cleanPivot(P) {
        if (!P || typeof P !== 'object') return undefined;
        const FIELDS = ['account', 'period', 'measure', 'sub', 'pc', 'dep', 'loc', 'mode', 'svc'];
        const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
        const period = x => {
            if (!x || typeof x !== 'object') return null;
            if (x.t === 'month' || x.t === 'ytd') return int(x.o, -240, 240) ? { t: x.t, o: x.o } : null;
            if (x.t === 'quarter') return int(x.o, -80, 80) ? { t: x.t, o: x.o } : null;
            if (x.t === 'year') return int(x.o, -20, 20) ? { t: x.t, o: x.o } : null;
            if (x.t === 'range' || x.t === 'avg') return int(x.f, -240, 240) && int(x.to, -240, 240) ? { t: x.t, f: x.f, to: x.to, name: String(x.name || '').slice(0, 60) || undefined } : null;
            return null;
        };
        const axis = a => (Array.isArray(a) ? a : []).slice(0, 6).map(lv => {
            const f = lv && FIELDS.indexOf(lv.f) >= 0 ? lv.f : null; if (!f) return null;
            const vs = (Array.isArray(lv.v) ? lv.v : []).slice(0, 300);
            let v;
            if (f === 'account') v = vs.map(x => String(x).slice(0, 20));
            else if (f === 'measure') v = vs.filter(x => ['amt', 'cpm', 'pct'].indexOf(x) >= 0);
            else if (f === 'period') v = vs.map(period).filter(Boolean);
            else v = vs.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 1e9);
            return { f, v };
        }).filter(Boolean);
        return { rows: axis(P.rows), cols: axis(P.cols) };
    }

    // A scheduled email: who gets it, when, and the view the link opens. A Scheduled Script (nts_is_cpm_sched.js) sends them.
    function cleanSchedule(S) {
        S = S || {};
        const str = (x, n) => String(x === undefined || x === null ? '' : x).slice(0, n);
        const emails = (Array.isArray(S.emails) ? S.emails : []).map(e => str(e, 120).trim()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)).slice(0, 25);
        if (!emails.length) throw error('NO_RECIPIENTS', 'Add at least one valid email address.');
        const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi) ? Number(v) : d;
        const ids = a => (Array.isArray(a) ? a : []).slice(0, 600).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 1e9);
        const V = S.view || {}, filters = {};
        ['subs', 'pcg', 'pcs', 'deps', 'locs', 'mods', 'svcs'].forEach(k => { if (Array.isArray(V.filters && V.filters[k])) filters[k] = ids(V.filters[k]); });
        return {
            reportName: str(S.reportName, 80), emails,
            freq: ['daily', 'weekly', 'monthly'].indexOf(S.freq) >= 0 ? S.freq : 'weekly',
            dow: int(S.dow, 0, 6, 1), dom: S.dom === 'last' ? 'last' : int(S.dom, 1, 31, 1), hour: int(S.hour, 0, 23, 7),
            time: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(S.time || '')) ? S.time : (String(int(S.hour, 0, 23, 7)).padStart(2, '0') + ':00'),
            asof: S.asof === 'current' ? 'current' : 'latest',
            attach: ['pdf', 'xlsx', 'both', 'link'].indexOf(S.attach) >= 0 ? S.attach : 'pdf',      // what the email carries: a PDF, an Excel workbook, both, or only a link
            subject: str(S.subject, 120), message: str(S.message, 1000), enabled: S.enabled !== false,
            sl: { script: String(runtime.getCurrentScript().id), deploy: String(runtime.getCurrentScript().deploymentId) },      // the Suitelet a scheduled send calls back for its data
            lastSent: /^\d{4}-\d{2}-\d{2}$/.test(String(S.lastSent || '')) ? S.lastSent : '',
            view: { preset: str(V.preset, 60), layoutId: Number.isInteger(Number(V.layoutId)) ? Number(V.layoutId) : null, mode: V.mode === 'analyze' ? 'analyze' : 'view',
                    showAll: !!V.showAll, oldOR: !!V.oldOR, page: int(V.page, 0, 39, 0), filters,
                    graph: !!V.graph, gsel: (Array.isArray(V.gsel) ? V.gsel : []).slice(0, 8).map(k => str(k, 160)),
                    gtype: V.gtype === 'bar' ? 'bar' : 'line', gmetric: V.gmetric === 'cpm' ? 'cpm' : 'amt' }
        };
    }

    // "Send me a test": the Scheduled Script runs now for this one schedule and sends it to the person who asked, attachments and all,
    // exactly as a real send would. If it cannot be started, say why; a link-only email would not be a test of the real one.
    function sendScheduleTest(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Sending must be a POST.');
        const id = Number(ctx.request.parameters.id), r = listReports().find(x => x.id === id);
        if (!r || !r.def || r.def.kind !== 'schedule') throw error('NOT_FOUND', 'That schedule no longer exists.');
        const me = Number(runtime.getCurrentUser().id);
        // the sender is passed in, so a deployment used only for tests needs no parameter values of its own
        const cur = runtime.getCurrentScript();                         // this Suitelet's own ids, so the test calls back the right one
        const params = { custscript_nts_sched_only: String(id), custscript_nts_sched_test_to: String(me), custscript_nts_sched_author: String(me),
                         custscript_nts_sched_script: String(cur.id), custscript_nts_sched_deploy: String(cur.deploymentId) };
        const tried = [];
        let started = false;
        [SCHED_TEST_DEPLOY, SCHED_DEPLOY].forEach(dep => {
            if (started) return;
            try {
                task.create({ taskType: task.TaskType.SCHEDULED_SCRIPT, scriptId: SCHED_SCRIPT, deploymentId: dep, params }).submit();
                started = true;
            } catch (e) {
                tried.push(dep + ': ' + String((e && (e.message || e.name)) || e).slice(0, 160));
                log.error('Schedule test: could not start ' + dep, (e && (e.stack || e.message)) || e);
            }
        });
        if (!started) {
            throw error('SCHED_NOT_STARTED', 'The test could not be started. ' + tried.join(' | ')
                + ' Check that the script is deployed, that its status allows it to run, and that your role is allowed to run it.'
                + ' If the deployment repeats, add a second deployment of the same script with status Not Scheduled (id ' + SCHED_TEST_DEPLOY.replace('customdeploy', '') + ') for tests.');
        }
        return { ok: true, how: 'scheduled script' };
    }

    function deleteReport(ctx) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'Deleting must be a POST.');
        const id = Number(ctx.request.parameters.id);
        if (!Number.isInteger(id) || id <= 0) throw error('BAD_ID', 'Invalid report.');
        const r = listReports(true).find(x => x.id === id);
        if (!r) throw error('NOT_FOUND', 'That report no longer exists.');
        if (!r.canDelete) throw error('NOT_ALLOWED', `Only ${r.ownerName || 'its creator'} or an administrator can delete "${r.name}".`);
        record.delete({ type: REPORT_RECORD, id });
        return { ok: true, reports: listReports() };
    }

    function isAdmin() {
        const u = runtime.getCurrentUser();
        return u.role === 3 || String(u.roleId || '').toLowerCase() === 'administrator';
    }

    // A template column: {t, o} for month/ytd/quarter/year offsets from the As of month,
    // {t, f, to, name?} for range/avg, {t, a, b} for comparisons referencing earlier positions.
    function validateTemplate(def) {
        if (!def || !Array.isArray(def.cols) || !def.cols.length) throw error('BAD_DEFINITION', 'A report needs at least one column.');
        if (def.cols.length > MAX_SAVED_COLUMNS) throw error('BAD_DEFINITION', `A report can have up to ${MAX_SAVED_COLUMNS} columns.`);
        const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
        if (def.kind !== undefined && def.kind !== 'is' && def.kind !== 'bs') throw error('BAD_DEFINITION', 'Unknown report kind.');
        def.cols.forEach((c, i) => {
            if (!c || TEMPLATE_TYPES.indexOf(c.t) < 0) throw error('BAD_DEFINITION', `Column ${i + 1} has an unknown type.`);
            const ok = (c.t === 'month' || c.t === 'ytd') ? int(c.o, -240, 240)
                     : (c.t === 'quarter') ? int(c.o, -80, 80)
                     : (c.t === 'year') ? int(c.o, -20, 20)
                     : (c.t === 'range' || c.t === 'avg') ? int(c.f, -240, 240) && int(c.to, -240, 240)
                       && (c.name === undefined || (typeof c.name === 'string' && c.name.length <= 60))
                     : int(c.a, 0, def.cols.length - 1) && int(c.b, 0, def.cols.length - 1) && c.a !== c.b
                       && ['diff', 'pchg'].indexOf(def.cols[c.a].t) < 0 && ['diff', 'pchg'].indexOf(def.cols[c.b].t) < 0;
            // a column picked as a specific period also carries it (fx), and the As of month does not move it
            const ym = v => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v);
            const fxOk = c.fx === undefined ? true
                       : (c.t === 'month' || c.t === 'ytd') ? ym(c.fx)
                       : (c.t === 'range' || c.t === 'avg') ? Array.isArray(c.fx) && c.fx.length === 2 && ym(c.fx[0]) && ym(c.fx[1])
                       : (c.t === 'quarter' || c.t === 'year') ? Number.isInteger(c.fx) && c.fx > 0
                       : false;
            if (!ok || !fxOk) throw error('BAD_DEFINITION', `Column ${i + 1} is not valid.`);
        });
    }

    // ------------------------------------------------------------------------------------------
    // detail — drill-down. One row per transaction, summed over the requested accounts, months,
    // subsidiaries and dimension filters, consolidated the same way as the statement so the total
    // ties to the amount that was clicked.
    // ------------------------------------------------------------------------------------------

    // Dimension filters as the page sends them. A missing filter means "everything"; 0 means
    // "untagged", matched with NVL so lines without that dimension are included or excluded exactly
    // as the statement does.
    const DIM_COLUMNS = { cls: 'tl.class', dep: 'tl.department', loc: 'tl.location',
                          mode: 'tl.cseg_appf_mode', svc: 'tl.cseg_appf_serv_type' };

    function getDetail(params) {
        const kind = params.kind === 'miles' ? 'miles' : 'gl';
        const periodIds = idList(params.periods, 'periods');
        if (periodIds.length > MAX_PERIODS) throw error('TOO_MANY_PERIODS', `Up to ${MAX_PERIODS} months can be listed.`);
        const subIds = idList(params.subs, 'subs');
        const dims = {};
        Object.keys(DIM_COLUMNS).forEach(k => {
            if (params[k] !== undefined) dims[k] = idList0(params[k], k);
        });
        const empty = Object.keys(dims).some(k => !dims[k].length);
        // asof: the balance sheet drill — everything posted through the end of one period, not just inside it
        const asOf = kind === 'gl' && (params.asof === '1' || params.asof === 'true');
        let asOfEnd = '';
        if (asOf) {
            if (periodIds.length !== 1) throw error('BAD_PERIOD', 'A balance sheet drill covers one date.');
            const ap = getPeriods().find(p => p.id === periodIds[0]);
            if (!ap || !/^\d{4}-\d{2}-\d{2}$/.test(ap.end)) throw error('BAD_PERIOD', 'That balance sheet date does not exist.');
            asOfEnd = ap.end;
        }

        if (kind === 'miles') {
            return empty ? detailResult('miles', [], 0, 0) : getMilesDetail(periodIds, subIds, dims.cls || null);
        }

        const acctIds = idList(params.accounts, 'accounts');
        if (acctIds.length > MAX_DETAIL_ACCOUNTS) throw error('TOO_MANY_ACCOUNTS', `Up to ${MAX_DETAIL_ACCOUNTS} accounts can be listed at once.`);
        if (empty) return detailResult('gl', [], 0, 0);

        const subs = suiteql(`SELECT id, parent FROM subsidiary WHERE isinactive = 'F'`);
        const to = Number(commonAncestor(subIds, subs));
        const binds = [...acctIds, ...(asOf ? [] : periodIds), ...subIds];
        let dimSql = '';
        Object.keys(DIM_COLUMNS).forEach(k => {
            if (!dims[k]) return;
            dimSql += ` AND NVL(${DIM_COLUMNS[k]}, 0) IN (${dims[k].map(() => '?').join(',')})`;
            binds.push(...dims[k]);
        });
        // by=dims: the same selection as the transaction list, totalled for each dimension (no transaction rows)
        if (params.by === 'dims') {
            const DIMS = [['cls', 'Profit center', 'tl.class'], ['dep', 'Department', 'tl.department'], ['loc', 'Location', 'tl.location'],
                          ['mode', 'Mode', 'tl.cseg_appf_mode'], ['svc', 'Service type', 'tl.cseg_appf_serv_type'], ['sub', 'Subsidiary', 'tl.subsidiary']];
            const conAmt = `BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${to}, t.postingperiod, 'DEFAULT')`;
            const body = `
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
             WHERE tal.posting = 'T'
               AND tal.account IN (${acctIds.map(() => '?').join(',')})
               ${asOf ? `AND t.trandate <= TO_DATE('${asOfEnd}', 'YYYY-MM-DD')` : `AND t.postingperiod IN (${periodIds.map(() => '?').join(',')})`}
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})${dimSql}`;
            const tot = suiteql(`SELECT SUM(${conAmt}) AS amt, COUNT(DISTINCT tal.transaction) AS ntx ${body}`, binds)[0] || {};
            const groups = [];
            DIMS.forEach(([key, label, col]) => {
                try {
                    const rows = suiteql(`SELECT ${col} AS did, BUILTIN.DF(${col}) AS dname, SUM(${conAmt}) AS amt, COUNT(DISTINCT tal.transaction) AS ntx ${body}
                                           GROUP BY ${col}, BUILTIN.DF(${col})`, binds)
                        .map(r => ({ id: Number(r.did) || 0, name: r.dname || 'Not tagged', amount: Math.round((Number(r.amt) || 0) * 100) / 100, tx: Number(r.ntx) || 0 }))
                        .filter(r => Math.abs(r.amount) >= 0.005)
                        .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
                    if (rows.length && !(key === 'sub' && rows.length === 1)) groups.push({ key, label, rows });
                } catch (e) {
                    log.error('Detail by dimension: ' + label + ' could not be totalled', (e && (e.stack || e.message)) || e);
                    groups.push({ key, label, rows: [], error: 'These totals could not be read.' });
                }
            });
            return { ok: true, kind: 'dims', total: Math.round((Number(tot.amt) || 0) * 100) / 100, count: Number(tot.ntx) || 0, groups };
        }
        const inner = `
            SELECT tal.transaction AS tid,
                   SUM(BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', ${to}, t.postingperiod, 'DEFAULT')) AS amt,
                   COUNT(*) AS nlines
              FROM transactionaccountingline tal
              JOIN transaction t      ON t.id = tal.transaction
              JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
             WHERE tal.posting = 'T'
               AND tal.account IN (${acctIds.map(() => '?').join(',')})
               ${asOf ? `AND t.trandate <= TO_DATE('${asOfEnd}', 'YYYY-MM-DD')` : `AND t.postingperiod IN (${periodIds.map(() => '?').join(',')})`}
               AND tl.subsidiary IN (${subIds.map(() => '?').join(',')})${dimSql}
             GROUP BY tal.transaction`;
        const sql = `
            SELECT x.tid AS tid, x.amt AS amt, x.nlines AS nlines,
                   t.tranid AS num, BUILTIN.DF(t.type) AS ttype, t.trandate AS tdate,
                   BUILTIN.DF(t.postingperiod) AS period, t.memo AS memo, BUILTIN.DF(t.entity) AS entity
              FROM (${inner}) x
              JOIN transaction t ON t.id = x.tid
             WHERE ABS(x.amt) >= 0.005
             ORDER BY t.trandate DESC, t.id DESC`;

        const paged = query.runSuiteQLPaged({ query: sql, params: binds, pageSize: 1000 });
        const rows = [];
        for (const range of paged.pageRanges) {
            paged.fetch({ index: range.index }).data.asMappedResults().forEach(r => rows.push(r));
            if (rows.length >= MAX_DETAIL) break;
        }
        const count = paged.count;
        let total = rows.reduce((t, r) => t + (Number(r.amt) || 0), 0);
        if (count > rows.length || count > MAX_DETAIL) {
            // listing was capped — take the total from all of it, not just the rows shown
            total = Number((suiteql(`SELECT SUM(x.amt) AS t FROM (${inner}) x`, binds)[0] || {}).t) || 0;
        }
        return detailResult('gl', rows.slice(0, MAX_DETAIL).map(r => ({
            id: Number(r.tid), num: r.num || '', type: r.ttype || '', date: r.tdate || '', period: r.period || '',
            memo: r.memo || '', entity: r.entity || '', lines: Number(r.nlines) || 0,
            amount: Math.round((Number(r.amt) || 0) * 100) / 100
        })), total, count);
    }

    // Statistical entries behind the miles, one row per entry. Same posting-period handling as
    // getMiles: search a date window, keep the requested posting periods in code.
    function getMilesDetail(periodIds, subIds, clsIds) {
        const periods = getPeriods().filter(p => periodIds.includes(p.id));
        if (!periods.length) return detailResult('miles', [], 0, 0);
        const milesAcctId = resolveAccountByNumber(MILES_ACCOUNT_NUMBER);
        const wanted = new Set(periods.map(p => p.id));
        const pad = 92 * 86400000;
        const from = new Date(Math.min(...periods.map(p => parseIso(p.start).getTime())) - pad);
        const to = new Date(Math.max(...periods.map(p => parseIso(p.end).getTime())) + pad);
        const filters = [
            ['account', 'anyof', milesAcctId], 'AND',
            ['subsidiary', 'anyof', subIds], 'AND',
            ['trandate', 'within', format.format({ value: from, type: format.Type.DATE }),
                                   format.format({ value: to, type: format.Type.DATE })]
        ];
        if (clsIds) filters.push('AND', ['class', 'anyof', clsIds.map(c => c === 0 ? '@NONE@' : c)]);
        const rows = [];
        search.create({
            type: search.Type.TRANSACTION,
            filters,
            columns: [
                search.createColumn({ name: 'internalid', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'tranid', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'trandate', summary: search.Summary.GROUP, sort: search.Sort.DESC }),
                search.createColumn({ name: 'postingperiod', summary: search.Summary.GROUP }),
                search.createColumn({ name: 'amount', summary: search.Summary.SUM })
            ]
        }).run().each(r => {
            const pp = Number(r.getValue({ name: 'postingperiod', summary: search.Summary.GROUP }));
            if (!wanted.has(pp)) return true;
            rows.push({
                id: Number(r.getValue({ name: 'internalid', summary: search.Summary.GROUP })),
                num: r.getValue({ name: 'tranid', summary: search.Summary.GROUP }) || '',
                type: 'Statistical Journal',
                date: r.getValue({ name: 'trandate', summary: search.Summary.GROUP }) || '',
                period: r.getText({ name: 'postingperiod', summary: search.Summary.GROUP }) || '',
                memo: '', entity: '', lines: 0,
                amount: Number(r.getValue({ name: 'amount', summary: search.Summary.SUM })) || 0
            });
            return rows.length < MAX_DETAIL;
        });
        return detailResult('miles', rows, rows.reduce((t, r) => t + r.amount, 0), rows.length);
    }

    function detailResult(kind, rows, total, count) {
        return { ok: true, kind, rows, total: Math.round(total * 100) / 100, count,
                 truncated: count > rows.length, limit: MAX_DETAIL };
    }

    // ------------------------------------------------------------------------------------------
    // pdf — renders whatever statement the browser posts, so the PDF always matches the screen.
    // ------------------------------------------------------------------------------------------

    function servePdf(ctx, asJson) {
        if (ctx.request.method !== 'POST') throw error('METHOD', 'PDF export must be requested with POST.');
        const doc = JSON.parse(ctx.request.parameters.payload || '{}');
        if (!Array.isArray(doc.sections) || !doc.sections.length) throw error('EMPTY', 'Nothing to print.');
        if (doc.sections.length > MAX_PDF_SECTIONS) {
            throw error('TOO_MANY_SECTIONS', `A PDF can hold ${MAX_PDF_SECTIONS} statements; ${doc.sections.length} were requested.`);
        }

        // Escape every string for XML here, once, so the template never has to.
        const clean = JSON.parse(JSON.stringify(doc), (k, v) => typeof v === 'string' ? escXml(v) : v);
        // Column widths computed here rather than in FreeMarker, where number formatting is locale-dependent.
        const portrait = clean.orient === 'portrait';
        const tableW = portrait ? 554 : 734;                                                   // points across the page
        // Fit to page: one scale for the whole PDF, so every page of every statement fits on one sheet. Nothing changes when it is not asked for or the statements already fit.
        // Row = type size x 1.2 line height (1.15) + the cell padding above and below; the padding is kept tight (and the margins narrow) once the type has to shrink.
        const FS = { det: 7, par: 7.2, sec: 8.5, tot: 7.5, ratio: 7.5, grand: 9, plain: 7.5 };
        const PADV = {   // top + bottom cell padding in points: [normal, tight]
            det: [1.6, 0.6], par: [2.8, 1.2], sec: [8.5, 3.5], tot: [4.5, 2.2], ratio: [3, 1], grand: [8.5, 3.5], plain: [3, 1] };
        const sumH = (tight, k) => {                                                             // height of every row on the busiest page, at scale k
            let worst = 0;
            clean.sections.forEach(sec => (sec.chunks || []).forEach(ch => {
                let h = 0;
                (ch.rows || []).forEach(r => { const kind = FS[r.kind] ? r.kind : 'plain'; h += FS[kind] * k * 1.15 + PADV[kind][tight ? 1 : 0]; });
                const head = (tight ? 5 : 10) + (Math.max(tight ? 9 : 16, 16 * k) * 1.15 + 3) + (sec.title ? Math.max(8, 11 * k) * 1.2 + 3 : 0)
                           + (clean.note ? 11 : 0) + (ch.part ? 11 : 0) + (tight ? 3 : 6) + (tight ? 10 : 13) * k * 1.15 + (tight ? 4 : 6) + 8 * k * 1.15 * (Number(ch.xn) > 0 ? 3 : 1) + 4;
                worst = Math.max(worst, h + head);
            }));
            return worst;
        };
        // Width: the longest figure in each column, and the account names, must fit across the page at the type size chosen. This is the scale at which they just do.
        const emw = str => { let w = 0; String(str || '').replace(/&[a-z#0-9]+;/g, 'x').split('').forEach(c => { w += /[0-9$]/.test(c) ? 0.556 : /[,.\s]/.test(c) ? 0.278 : /[()]/.test(c) ? 0.333 : c === '%' ? 0.889 : 0.56; }); return w; };      // width in type sizes (Helvetica)
        const word = str => Math.max(0, ...String(str || '').replace(/&[a-z#0-9]+;/g, 'x').split(/\s+/).map(w => emw(w)));            // the longest word of a heading, in type sizes
        const widthScale = () => {
            let k = 1;
            clean.sections.forEach(sec => (sec.chunks || []).forEach(ch => {
                const per = clean.single ? 1 : 2 + Math.max(0, Math.min(2, Number(ch.xn) || 0));
                let lab = 0;
                (ch.rows || []).forEach(r => { const txt = String(r.label || '').replace(/&[a-z#0-9]+;/g, 'x'); lab = Math.max(lab, (Number(r.pad) || 3) / 7.5 + emw(txt) * 1.04); });
                let figs = 0;
                (ch.cols || []).forEach((c, ci) => {
                    const len = f => Math.max(0, ...(ch.rows || []).map(r => emw((r.cells[ci] || {})[f])), word(((ch.heads || [])[ci] || {})[f]) * 8 / 7.5 * 1.1);
                    const w = (len('a') + (per > 1 ? len('m') : 0) + (per > 2 ? len('x1') : 0) + (per > 3 ? len('x2') : 0)) * 1.03 + 0.5 * per;
                    const head = emw(((ch.heads || [])[ci] || {}).label) * 1.08 * 10 / 7.5;
                    figs += Math.max(w, head);
                });
                const room = (tableW + 14) - 14;                                                  // points across, less a little air
                k = Math.min(k, room / (7.5 * (lab + figs) + 3 * (ch.cols || []).length * per + 14));
            }));
            return k;
        };
        let sc = 1, tight = false;
        const wk = clean.fit === true ? widthScale() : 1;
        if (clean.fit === true && (sumH(false, 1) > (portrait ? 725 : 545) * 0.96 || wk < 1)) {
            tight = true;
            const avail = (portrait ? 735 : 555) * 0.96;                                        // page less the narrower margins and the footer, with a little room to spare
            let lo = 0.06, hi = 1;
            for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (sumH(true, mid) <= avail) lo = mid; else hi = mid; }
            sc = Math.floor(Math.min(lo, wk) * 100) / 100;
            sc = Math.max(0.06, sc);                                                         // however small it has to be: everything stays on one sheet
        }
        const pt = x => (Math.round(x * sc * 100) / 100) + 'pt';                               // text, not a number: no locale in the way
        const fx = (n, t) => (tight ? t : n) + 'pt';                                            // a fixed size: the normal one, or the tight one
        clean.z = { body: pt(7.5), hm: tight ? pt(10) : pt(13), hc: pt(8), sec: pt(8.5), det: pt(7), par: pt(7.2), grand: pt(9),
                    t16: (tight ? Math.max(9, Math.round(16 * sc * 100) / 100) : 16) + 'pt', t11: (tight ? Math.max(8, Math.round(11 * sc * 100) / 100) : 11) + 'pt', t75: pt(7.5),
                    tdp: tight ? '0.3pt 1pt' : '1.5pt 3pt', hmpad: fx(4, 1), hmpb: fx(2, 0.5), secpad: fx(7, 2.5), detp: fx(0.8, 0.3), parpt: fx(2, 0.8), totpt: fx(3, 1), grandpt: fx(4, 1.5),
                    gap5: fx(5, 2), gap6: fx(6, 3), bar: fx(5, 3), foot: tight ? '5.5pt' : '6.5pt',
                    page: tight ? '0.25in 0.3in 0.25in 0.3in' : '0.35in 0.4in 0.3in 0.4in' };
        clean.fitMode = clean.fit === true ? 'yes' : 'no';
        clean.sections.forEach(sec => {
            sec.title = sec.title || '';
            (sec.chunks || []).forEach(ch => {
                const per = clean.single ? 1 : 2 + Math.max(0, Math.min(2, Number(ch.xn) || 0));      // the balance sheet has no per-mile column; a report with an extra column beside it has three
                // The account column is only as wide as the longest account name needs, plus a small gap, so the first figures sit close to the names.
                let need = 60;
                (ch.rows || []).forEach(r => {
                    const txt = String(r.label || '').replace(/&[a-z#0-9]+;/g, 'x');
                    const bold = r.kind === 'sec' || r.kind === 'tot' || r.kind === 'grand' || r.kind === 'par';
                    need = Math.max(need, (Number(r.pad) || 3) + 6 + txt.length * (bold ? 4.5 : 4.1) * sc);
                });
                const label = Math.max(14, Math.min(34, (need + (tight ? 7 : 12)) / tableW * 100));
                const col = (100 - label) / (Math.max(1, ch.cols.length) * per);
                ch.labelW = label.toFixed(2) + '%';
                ch.colW = col.toFixed(2) + '%';
                ch.pairW = (col * per).toFixed(2) + '%';
                ch.span = per;
                // with figures right-aligned under the headings, the month sits over the figures, not the middle of the empty space left of them
                ch.hpad = 0;                                                                // the month is centred over its amount and per-mile columns
                // Each column under a month gets the room its own figures and heading need: the amount is wider than the per-mile figure beside it, and so on.
                const fields = ['a', 'm', 'x1', 'x2'].slice(0, per), room = {};
                fields.forEach(f => {
                    let w = 1.5;
                    (ch.cols || []).forEach((c, ci) => {
                        (ch.rows || []).forEach(r => { w = Math.max(w, emw((r.cells[ci] || {})[f])); });
                        w = Math.max(w, word(((ch.heads || [])[ci] || {})[f]) * 8 / 7 * 1.1);
                    });
                    room[f] = w;
                });
                const roomSum = fields.reduce((t, f) => t + room[f], 0), wOf = f => (col * per * room[f] / roomSum).toFixed(2) + '%';
                ch.aW = per === 1 ? ch.colW : wOf('a');
                ch.mW = per > 1 ? wOf('m') : ch.colW;
                ch.x1W = per > 2 ? wOf('x1') : ch.colW;
                ch.x2W = per > 3 ? wOf('x2') : ch.colW;
                ch.single = !!clean.single;
                ch.part = ch.part || '';
            });
        });
        // Column headings stay on one line: the heading type is cut down until the longest heading fits over its columns (a wrapped heading was being spread across the cell).
        let hmPt = parseFloat(clean.z.hm);
        clean.sections.forEach(sec => (sec.chunks || []).forEach(ch => {
            const room = parseFloat(ch.pairW) / 100 * tableW - (tight ? 2 : 6);
            (ch.heads || []).forEach(h => { const w = emw(String(h.label || '').trim()) * 1.1; if (w > 0) hmPt = Math.min(hmPt, Math.max(5, room * 0.94 / w)); });
        }));
        clean.z.hm = (Math.floor(hmPt * 100) / 100) + 'pt';
        let hcPt = parseFloat(clean.z.hc);
        clean.sections.forEach(sec => (sec.chunks || []).forEach(ch => {
            const wpt = { a: ch.aW, m: ch.mW, x1: ch.x1W, x2: ch.x2W };
            (ch.heads || []).forEach(h => ['a', 'm', 'x1', 'x2'].forEach(f => {
                const w = word(h[f]) * 1.1, room = parseFloat(wpt[f]) / 100 * tableW - (tight ? 2 : 6);
                if (w > 0 && room > 0) hcPt = Math.min(hcPt, Math.max(2, room * 0.94 / w));
            }));
        }));
        clean.z.hc = (Math.floor(hcPt * 100) / 100) + 'pt';
        // The graph, when one was sent: a PNG on a page of its own at the front. The PDF engine fetches images by address,
        // so the picture is saved as a temporary file next to the page (available without login, as the engine requires), used in the render, and deleted straight afterwards.
        delete clean.graph; delete clean.graphPage;               // only this function sets the graph page, never the request
        let graphFileId = null, graphSkipped = false;
        const g = doc.graph;
        if (g && typeof g.uri === 'string' && g.uri.length < 4000000 && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(g.uri)) {
            const gw = Number(g.w), gh = Number(g.h);
            if (gw > 0 && gh > 0 && gw <= 5000 && gh <= 5000) {
                try {
                    const f = file.create({ name: 'nts_graph_' + runtime.getCurrentUser().id + '_' + Date.now() + '.png', fileType: file.Type.PNGIMAGE,
                                            contents: g.uri.split(',')[1], folder: loadFile(FILE_PATHS.page).folder, isOnline: true });      // the PDF engine only loads pictures that are available without login
                    graphFileId = f.save();
                    const gW = doc.orient === 'portrait' ? 540 : 720;          // as wide as the page allows
                    // the PDF engine fetches the picture by its full address: a path alone is not enough
                    const path = file.load({ id: graphFileId }).url;
                    const full = /^https?:\/\//i.test(path) ? path : 'https://' + url.resolveDomain({ hostType: url.HostType.APPLICATION }) + path;
                    clean.graphPage = { url: escXml(full), w: gW, h: Math.round(gW * gh / gw) };
                } catch (e) { graphSkipped = true; graphFileId = null; }           // no permission to save a file: the PDF is made without the graph
            }
        }
        clean.showGraph = !!clean.graphPage;
        clean.graphMode = clean.graphPage ? 'yes' : 'no';         // text, not a true/false: the template prints a graph page only on a yes
        clean.pageSize = doc.orient === 'portrait' ? 'Letter' : 'Letter-landscape';      // the person's choice of page; landscape is the default
        clean.printedBy = escXml(runtime.getCurrentUser().name);
        clean.printedAt = escXml(format.format({ value: new Date(), type: format.Type.DATETIME }));

        const r = render.create();
        r.templateContent = loadFile(FILE_PATHS.pdf).getContents();
        r.addCustomDataSource({ format: render.DataSource.OBJECT, alias: 'doc', data: clean });
        let pdf;
        try { pdf = r.renderAsPdf(); }
        finally { if (graphFileId) { try { file.delete({ id: graphFileId }); } catch (e) { /* the temporary picture is harmless if it stays */ } } }
        pdf.name = (doc.fileName || 'NTS_Income_Statement') + '.pdf';
        if (asJson) return json(ctx, { ok: true, name: pdf.name, base64: pdf.getContents() });
        if (graphSkipped) ctx.response.setHeader({ name: 'X-Graph-Skipped', value: '1' });
        ctx.response.writeFile({ file: pdf, isInline: false });
    }

    // ------------------------------------------------------------------------------------------
    // diag — exercises every data path and reports what it found. Read-only.
    // ------------------------------------------------------------------------------------------

    function runDiagnostics() {
        const out = { ok: true, user: runtime.getCurrentUser().name, role: runtime.getCurrentUser().roleId,
                      env: runtime.envType, checks: [] };
        const check = (name, fn) => {
            const t0 = Date.now();
            try { out.checks.push({ name, ok: true, result: fn(), ms: Date.now() - t0 }); }
            catch (e) { out.ok = false; out.checks.push({ name, ok: false, error: e.message || String(e), ms: Date.now() - t0 }); }
        };

        let periods = [];
        check('page file', () => loadFile(FILE_PATHS.page).size + ' bytes');
        check('pdf template', () => loadFile(FILE_PATHS.pdf).size + ' bytes');
        check('accounting periods (N/search)', () => { periods = getPeriods(); return periods.length + ' monthly periods'; });
        check('subsidiaries (N/query)', () => getMeta().subsidiaries.length + ' subsidiaries');
        check('miles account resolves', () => 'internal id ' + resolveAccountByNumber(MILES_ACCOUNT_NUMBER));

        const recent = periods.filter(p => p.start <= isoDate(new Date())).slice(0, 3).map(p => p.id);
        const subs = suiteql(`SELECT id FROM subsidiary WHERE isinactive = 'F'`).map(r => r.id);
        check('dollar query, last 3 periods, all subsidiaries', () => {
            const rows = getDollars(recent, subs, commonAncestor(subs, suiteql(`SELECT id, parent FROM subsidiary`)));
            const g = getAccountGroups();
            const rev = rows.filter(r => getSectionGroup(g[r.acctid]) === G.revenue)
                            .reduce((s, r) => s - Number(r.amt || 0), 0);
            const segs = rows.filter(r => r.md || r.svc).length;
            return `${rows.length} grouped rows, revenue ${rev.toFixed(2)}, ${segs} rows carry mode or service type`;
        });
        check('miles search, last 3 periods', () => {
            const ps = periods.filter(p => recent.includes(p.id));
            const m = getMiles(ps, subs);
            return ps.map(p => `${p.name} ${m.filter(x => x.pp === p.id).reduce((s, x) => s + x.miles, 0)}`).join(' · ') + ' miles';
        });
        check('chart of accounts', () => {
            const c = getChart();
            const isC = c.filter(a => !a.bs), bsC = c.filter(a => a.bs);
            const onIs = isC.filter(a => a.g !== null && a.g < BS_FIRST).length;
            const onBs = bsC.filter(a => a.g !== null && a.g >= BS_FIRST).length;
            const inh = c.filter(a => a.inherited).length;
            return `income statement: ${isC.length} accounts, ${onIs} on the report · balance sheet: ${bsC.length} accounts, ${onBs} on the report` +
                   ` · ${inh} take their group from a parent`;
        });
                check('balance sheet', () => {
            const ps = getPeriods().filter(p => p.end && p.end < isoDate(new Date())).sort((a, b) => a.start < b.start ? 1 : -1);
            if (!ps.length) return 'no completed period to test with';
            const sid = suiteql(`SELECT id FROM subsidiary WHERE isinactive = 'F' AND iselimination = 'F'`).map(r => Number(r.id));
            const b = getBsData({ periods: String(ps[0].id), subs: sid.join(',') });
            const isLE = g => g >= 19 && g !== 26;          // 26 Long Term Assets is an asset group
            const side = (g, v) => isLE(g) ? -v : v;
            const ta = b.accounts.reduce((t, a, i) => t + (!isLE(a[2]) ? b.bal[i][0] : 0), 0);
            const tle = b.accounts.reduce((t, a, i) => t + (isLE(a[2]) ? side(a[2], b.bal[i][0]) : 0), 0) + b.earnings.current[0] + b.earnings.prior[0];
            return `${ps[0].name}: ${b.accounts.length} accounts on the sheet, ${b.excluded.length} not on the report — assets ${Math.round(ta)}, ` +
                   `liabilities + equity ${Math.round(tle)}${b.excluded.length ? ' (differs until those are assigned)' : ''} — current year earnings: ${earningsFormulaText()}`;
        });
        check('entry lines (drill-down expand)', () => {
            const t = suiteql(`SELECT MAX(t.id) AS id FROM transaction t WHERE t.posting = 'T'`)[0];
            if (!t || !t.id) return 'no posting transactions to test with';
            const e = getEntry({ id: String(t.id) });
            return `${e.num || ('#' + t.id)}: ${e.count} lines, debits ${e.debit} credits ${e.credit}`;
        });
                check('flag resolutions record', () => {
            suiteql(`SELECT id FROM ${FLAG_RECORD} WHERE ROWNUM <= 1`);
            return `${FLAG_RECORD} readable`;
        });
                check('saved reports record', () => {
            const r = listReports();
            return `${REPORT_RECORD} readable — ${r.length} saved report${r.length === 1 ? '' : 's'}`;
        });
                check('account group field', () => {
            const g = getAccountGroups();
            const vals = {};
            Object.values(g).forEach(v => { vals[v] = (vals[v] || 0) + 1; });
            const unknown = [];                                              // nothing is unrecognised any more: new groups are placed
            const present = new Set(Object.keys(vals).map(v => groupKey(v)));
            const missing = Object.keys(GROUP_NAMES).filter(n => !present.has(GROUP_NAMES[n]));
            const placed = groupDefs().map(d => `${d.name} → ${d.kind === 'bs' ? 'balance sheet, ' + BUCKET_LABEL[d.bucket] : 'income statement, after Fixed expenses'}`);
            return `${Object.keys(g).length} accounts assigned — ` +
                   Object.entries(vals).map(([k, n]) => `${k} ${n}`).join(', ') +
                   (missing.length ? ` — NO ACCOUNTS IN: ${missing.join(', ')}` : '') +
                   (placed.length ? ` — PLACED FROM THEIR ACCOUNTS: ${placed.join('; ')}` : '');
        });
        out.remainingUsage = runtime.getCurrentScript().getRemainingUsage();
        return out;
    }

    // ------------------------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------------------------

    function suiteql(sql, params) {
        const out = [];
        const paged = query.runSuiteQLPaged({ query: sql, params: params || [], pageSize: PAGE_SIZE });
        paged.pageRanges.forEach(range => {
            paged.fetch({ index: range.index }).data.asMappedResults().forEach(r => out.push(r));
        });
        return out;
    }

    function resolveAccountByNumber(num) {
        const rows = suiteql(`SELECT id FROM account WHERE acctnumber = ? AND isinactive = 'F'`, [num]);
        if (rows.length === 0) throw error('ACCOUNT_NOT_FOUND', `No active account numbered ${num}.`);
        if (rows.length > 1) throw error('ACCOUNT_AMBIGUOUS', `${rows.length} active accounts are numbered ${num}.`);
        return rows[0].id;
    }

    function loadFile(path) {
        try { return file.load({ id: path }); }
        catch (e) { throw error('FILE_NOT_FOUND', `File Cabinet file ${path} could not be loaded: ${e.message}`); }
    }

    // like idList, but allows 0 ("untagged") and an empty list
    function idList0(raw, name) {
        const ids = String(raw || '').split(',').map(x => x.trim()).filter(x => x !== '');
        const nums = ids.map(Number);
        if (nums.some(n => !Number.isInteger(n) || n < 0)) throw error('BAD_' + name.toUpperCase(), `Invalid ${name} list.`);
        return [...new Set(nums)];
    }

    function idList(raw, name) {
        const ids = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!ids.length) throw error('MISSING_' + name.toUpperCase(), `No ${name} selected.`);
        const nums = ids.map(Number);
        if (nums.some(n => !Number.isInteger(n) || n <= 0)) throw error('BAD_' + name.toUpperCase(), `Invalid ${name} list.`);
        return [...new Set(nums)];
    }

    // "6070 DRIVER WAGES" -> "Driver Wages"
    function cleanAccountName(display, num) {
        let s = String(display || '');
        if (num && s.indexOf(num + ' ') === 0) s = s.slice(num.length + 1);
        return s.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/'S\b/g, "'s")
                .replace(KEEP_CAPS_RE, m => KEEP_CAPS[m.toLowerCase()]);
    }
    // Abbreviations that appear in the chart of accounts keep their capitals when names are tidied.
    const KEEP_CAPS = { nts: 'NTS', cti: 'CTI', img: 'IMG', npi: 'NPI', ntech: 'NTECH', efs: 'EFS', esop: 'ESOP', tmt: 'TMT',
                        rou: 'ROU', irp: 'IRP', hni: 'HNI', mcb: 'MCB', umb: 'UMB', tbe: 'TBE', fmvs: 'FMVs', sar: 'SAR', sars: 'SARs',
                        st: 'ST', lt: 'LT', ic: 'IC', pic: 'PIC', al: 'AL', pd: 'PD', ai: 'AI' };
    const KEEP_CAPS_RE = new RegExp('\\b(' + Object.keys(KEEP_CAPS).join('|') + ')\\b', 'gi');

    function isoDate(v) {
        if (!v) return '';
        const d = v instanceof Date ? v : format.parse({ value: v, type: format.Type.DATE });
        const p = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    }

    function parseIso(s) { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); }

    function json(ctx, obj) {
        ctx.response.setHeader({ name: 'Content-Type', value: 'application/json' });
        ctx.response.write(JSON.stringify(obj));
    }

    function error(name, message) { const e = new Error(message); e.name = name; return e; }
    function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function escXml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

    return { onRequest };
});