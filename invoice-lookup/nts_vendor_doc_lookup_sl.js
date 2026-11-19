/**
 * nts_vendor_doc_lookup_sl.js
 *
 * Type-ahead search by vendor name, vendor ID, Invoice # or Order #, then
 * view the matching invoices and the scanned document attached to each.
 *
 * Modes:
 *   <url>                              search page (type-ahead)
 *   <url>&mode=suggest&q=1pas          JSON suggestions (vendors + invoices)
 *   <url>&mode=vendors&q=1pas          JSON vendor-only suggestions (legacy)
 *   <url>&s=EPO-0001                   search results: matches vendor name/ID, order #, invoice #, unit #
 *   <url>&s=&from=2026-10-01&to=2026-10-31   every invoice in a date range (add &p=2 for page 2)
 *   any list also takes &sort=date|order|invoice|unit|amount|vendor|vendorid&dir=asc|desc
 *   any page takes &group=AP or &group=TMT: which vendors' invoices are shown (remembered per browser)
 *   <url>&v=1PASSWOR                   invoices + documents for that vendor
 *   <url>&b=2508                       one invoice + its document
 *   <url>&mode=file&id=5309&bill=2508  streams a document (a scan opens only if its folder is a Bill Capture
 *                                      scan folder AND it is attached to that vendor bill)
 *   <url>&tab=upload                   drag-and-drop invoice upload (see INVOICE UPLOAD below)
 *   <url>&tab=queue                    PDFs waiting for their invoice
 *   <url>&tab=missing                  invoices in NetSuite that have no document attached
 *   <url>&mode=upload|queueedit|queuedel   POST endpoints used by those two tabs (JSON)
 *   <url>&mode=attach                  POST: attach a dropped PDF to one specific invoice (JSON)
 *   <url>&mode=unit                    POST: change one invoice's unit # (JSON)
 *   <url>&mode=brand&n=cond700         streams a brand font (see BRAND_FILES)
 *   <url>&mode=lib&n=pdfjs             streams a PDF viewer library (see PDF_TOOL_FILES)
 *   <url>&mode=diag&tran=INV_CAN310    JSON: which attachment read method works
 *
 * Styled with the Nussbaum design system (tokens, type, table/button/input).
 *
 * Sign-in: while REQUIRE_LOGIN (further down) is true, which is how this ships, people must
 * sign in with their work email and a passcode before anything is shown. Setting it to false
 * removes the sign-in and lets anyone with the link see every vendor's documents, so only do
 * that on a private test deployment.
 *
 * IDs: nothing in here depends on a record's internal ID, so it keeps working after a sandbox
 * refresh and when promoted to production. The Bill Capture scan folders are all the folders of
 * type SCANNED_VENDOR_BILLS, the Pending Vendor Invoices folder is found by External ID and then
 * by its File Cabinet path, fonts are File Cabinet paths, and custom fields are found by script ID
 * (and only used when they exist). The one place an internal ID is stored is the BILL=<id> note
 * on a PDF that has been attached, which is for information only; nothing reads it back.
 *
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */
define(['N/search', 'N/file', 'N/record', 'N/query', 'N/runtime', 'N/format',
        'N/crypto', 'N/encode', 'N/log', 'N/url', 'N/cache'],
function (search, file, record, query, runtime, format, crypto, encode, log, url, cache) {

    // ---------------------------------------------------------------------
    // FOLDER AND PASSCODE POLICY (nothing here is an internal ID)
    // ---------------------------------------------------------------------

    // Bill Capture keeps one "Scanned Vendor Bills" folder PER USER, all of folder type
    // SCANNED_VENDOR_BILLS. Every folder of that type is a scan folder. The type is the same in
    // every account and after a sandbox refresh, so no folder ID is ever written down.
    // A scanned document opens from the lookup only when its folder is one of these AND the
    // file is attached to the vendor bill named in the link.
    var SCAN_FOLDER_TYPE = 'SCANNED_VENDOR_BILLS';

    // Where PDFs uploaded through this lookup are kept (waiting ones and attached ones).
    // The folder is found by its External ID first, then by this exact File Cabinet path
    // (every folder on the path must match exactly one folder, or a readable error says
    // which). If the last folder does not exist yet it is created at this path and given the
    // External ID, unless PENDING_FOLDER_CREATE_IF_MISSING is false (then a missing folder is
    // an error). Set PENDING_FOLDER_EXTERNAL_ID to '' to look it up by path only.
    var PENDING_FOLDER_PATH = 'SuiteScripts/AP Invoice Lookup/Pending Vendor Invoices';
    var PENDING_FOLDER_EXTERNAL_ID = 'NTS_PENDING_VENDOR_INVOICES';
    var PENDING_FOLDER_CREATE_IF_MISSING = true;

    // A value typed by hand into the employee passcode field is never accepted as a normal
    // passcode. It works once as a TEMPORARY passcode: signing in with it leads straight to
    // "choose your new passcode", and the new passcode is stored as a hash in its place. This
    // is how long (minutes) the person has to choose the new passcode after the temporary one
    // was accepted.
    var TEMP_PASSCODE_MINUTES = 10;

    // AP / TMT toggle. Every vendor has a Category, and the lookup shows the invoices of ONE
    // group at a time: the search suggestions, results, date lists, vendor pages and the
    // Missing documents list all follow it. Each group is a vendor category, found by its
    // External ID first and then by its exact name (never by internal ID); if neither matches
    // exactly one category the page says which one it was looking for. Vendors with some other
    // category (or none) are not shown under either group.
    //   key / label   what the toggle button says (key is also what &group= carries)
    //   externalId    the vendor category's External ID ('' to skip that step)
    //   name          the vendor category's exact name
    var VENDOR_GROUPS = [
        { key: 'AP',  label: 'AP',  externalId: 'AP',  name: 'AP'  },
        { key: 'TMT', label: 'TMT', externalId: 'TMT', name: 'TMT' }
    ];
    // Someone who may see more than one group also gets a "Both" choice (all of their groups at
    // once). ALL_GROUPS_KEY is what &group= and the cookie carry for it.
    var ALL_GROUPS_KEY = 'ALL';

    // The group shown the first time someone opens the lookup ('AP', 'TMT' or ALL_GROUPS_KEY for
    // both). After that each browser keeps the last one chosen (a cookie), for GROUP_COOKIE_DAYS days.
    var DEFAULT_VENDOR_GROUP = 'AP';
    var GROUP_COOKIE_NAME = 'nts_doclookup_group';
    var GROUP_COOKIE_DAYS = 365;

    var GROUP = '';        // the group (key) in effect for this request, or ALL_GROUPS_KEY for all of the person's groups
    var GROUP_IDS = {};    // group key -> vendor category id, looked up once per request
    var GROUP_UI = false;  // does this page show the toggle?
    var GROUP_BASE = '';   // the address the toggle links start from (this page, without a group)

    function groupDef(key) {
        for (var i = 0; i < VENDOR_GROUPS.length; i++) if (VENDOR_GROUPS[i].key === key) return VENDOR_GROUPS[i];
        return null;
    }

    /** Ids of the vendor categories with this External ID or name; a database error becomes a readable one. */
    function categoryRows(column, value, g) {
        try {
            return query.runSuiteQL({
                query: 'SELECT id FROM vendorcategory WHERE ' + column + ' = ? ORDER BY id',
                params: [value]
            }).asMappedResults().map(function (r) { return Number(r.id); });
        } catch (e) {
            throw new Error('Could not look up the vendor category for the ' + g.label + ' group (VENDOR_GROUPS): ' + e.message);
        }
    }

    /** The vendor category id for a group: External ID first, then exact name. Cached for the request. */
    function groupCategoryId(key) {
        if (GROUP_IDS.hasOwnProperty(key)) return GROUP_IDS[key];
        var g = groupDef(key);
        if (!g) throw new Error('"' + key + '" is not one of the vendor groups in VENDOR_GROUPS.');

        var ids;
        if (g.externalId) {
            ids = categoryRows('externalid', g.externalId, g);
            if (ids.length > 1) {
                throw new Error('More than one vendor category has the External ID "' + g.externalId + '" (category ids '
                    + ids.join(', ') + '), needed for the ' + g.label + ' group (VENDOR_GROUPS).');
            }
            if (ids.length === 1) { GROUP_IDS[key] = ids[0]; return ids[0]; }
        }
        ids = categoryRows('name', g.name, g);
        if (!ids.length) {
            throw new Error('Could not find the vendor category for the ' + g.label + ' group: looked for the External ID "' + g.externalId
                + '", then the name "' + g.name + '" (VENDOR_GROUPS).');
        }
        if (ids.length > 1) {
            throw new Error('More than one vendor category is named "' + g.name + '" (category ids ' + ids.join(', ')
                + '), needed for the ' + g.label + ' group. Give the right one the External ID "' + g.externalId + '" or rename the others.');
        }
        GROUP_IDS[key] = ids[0];
        return ids[0];
    }

    /** The choices this person has: each group they may see, plus "Both" when that is more than one. */
    function groupChoices() {
        var mine = allowedGroupKeys();
        return mine.length > 1 ? mine.concat([ALL_GROUPS_KEY]) : mine.slice();
    }

    /** The group keys in effect for this request (all of the person's groups for "Both"). */
    function currentGroupKeys() {
        return GROUP === ALL_GROUPS_KEY ? allowedGroupKeys() : [GROUP];
    }

    /** Vendor category ids of the groups in effect. */
    function currentCategoryIds() {
        return currentGroupKeys().map(groupCategoryId);
    }

    /** "AP", "TMT", or "AP and TMT" for Both. */
    function groupLabel(key) {
        if (key === ALL_GROUPS_KEY) return allowedGroupKeys().map(function (k) { return groupDef(k).label; }).join(' and ');
        var g = groupDef(key);
        return g ? g.label : key;
    }

    /** Which group (key) a vendor category id belongs to, or '' when it is in neither. */
    function groupKeyForCategory(catId) {
        for (var i = 0; i < VENDOR_GROUPS.length; i++) {
            if (groupCategoryId(VENDOR_GROUPS[i].key) === Number(catId)) return VENDOR_GROUPS[i].key;
        }
        return '';
    }

    function cookieValue(req, name) {
        var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
        var mine = '';
        raw.split(';').forEach(function (c) {
            var bits = c.split('=');
            if (bits[0] && bits[0].trim() === name) mine = (bits[1] || '').trim();
        });
        return mine;
    }

    /** The group for this request: &group= first, then the saved choice, then the default. */
    function pickGroup(req) {
        var keys = VENDOR_GROUPS.map(function (g) { return g.key; }).concat([ALL_GROUPS_KEY]);
        var asked = String(req.parameters.group || '').trim().toUpperCase();
        if (keys.indexOf(asked) >= 0) return { key: asked, chosen: true };
        var saved = cookieValue(req, GROUP_COOKIE_NAME).toUpperCase();
        if (keys.indexOf(saved) >= 0) return { key: saved, chosen: false };
        var dflt = String(DEFAULT_VENDOR_GROUP || '').toUpperCase();
        return { key: keys.indexOf(dflt) >= 0 ? dflt : keys[0], chosen: false };
    }

    function setGroupCookie(res, key) {
        res.setHeader({
            name: 'Set-Cookie',
            value: GROUP_COOKIE_NAME + '=' + key + '; Path=/; Max-Age=' + (GROUP_COOKIE_DAYS * 86400)
                 + '; Secure; HttpOnly; SameSite=Lax'
        });
    }

    // The ids of every scan folder, looked up once per request.
    var SCAN_FOLDER_IDS = null;
    function scanFolderIds() {
        if (SCAN_FOLDER_IDS !== null) return SCAN_FOLDER_IDS;
        var rows;
        try {
            rows = query.runSuiteQL({
                query: "SELECT id FROM mediaitemfolder WHERE foldertype = '" + SCAN_FOLDER_TYPE + "' ORDER BY id",
                params: []
            }).asMappedResults();
        } catch (e) {
            log.error({ title: 'scan folder lookup failed', details: e.name + ': ' + e.message });
            throw new Error('Could not look up the Bill Capture scan folders (folders of type ' + SCAN_FOLDER_TYPE + '): ' + e.message);
        }
        log.audit({ title: 'scan folders', details: rows.length + ' Bill Capture scan folder(s) of type ' + SCAN_FOLDER_TYPE });
        if (!rows.length) {
            throw new Error('No Bill Capture scan folders (folder type ' + SCAN_FOLDER_TYPE + ') exist in this account, so scanned documents cannot be opened.');
        }
        SCAN_FOLDER_IDS = rows.map(function (r) { return Number(r.id); });
        return SCAN_FOLDER_IDS;
    }

    /** True when this transaction id is a vendor bill. */
    function isVendorBill(id) {
        if (!/^\d+$/.test(String(id || ''))) return false;
        return query.runSuiteQL({
            query: "SELECT id FROM transaction WHERE id = ? AND type = 'VendBill'",
            params: [Number(id)]
        }).asMappedResults().length === 1;
    }

    var MAX_BILLS = 25;

    // ---------------------------------------------------------------------
    // INVOICE UPLOAD
    //
    // People drop invoice PDFs on the Upload tab and label each with an order #.
    // The PDF waits in the Queue tab until a vendor bill with that order # (its
    // Reference No.) exists, then it is attached to that bill and leaves the
    // queue. nts_vendor_doc_match_ue.js does the attaching when a bill is saved;
    // opening the Queue tab also attaches anything whose bill already exists.
    //
    // Waiting PDFs live in the File Cabinet folder at PENDING_FOLDER_PATH (see the policy
    // constants at the top), created the first time someone uploads. The folder also keeps
    // the PDFs after they are attached. Each PDF's description records its state:
    //   NTSINV|PENDING|ORDER=EPO-00019653|BY=Some Person
    //   NTSINV|MATCHED|ORDER=EPO-00019653|BY=Some Person|BILL=2508|AT=2026-11-10
    // DOC_MARK must stay identical to DOC_MARK in nts_vendor_doc_match_ue.js.
    // ---------------------------------------------------------------------
    var DOC_MARK = 'NTSINV|';

    // Largest PDF accepted, in bytes. The file is sent to NetSuite in a web request,
    // which has its own size cap, so keep this modest.
    var MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

    var MAX_QUEUE = 200;      // most queue rows shown
    var SWEEP_MAX = 8;        // most PDFs the Missing Invoices tab attaches per visit (governance)
    var MISSING_PAGE_SIZE = 50;   // invoices per page on the Missing documents tab

    // The number on the Missing documents tab counts every bill with no document, which
    // means searching all bills. It is remembered for this many seconds (NetSuite keeps it
    // for every user) so ordinary page loads stay fast. After a PDF is attached through
    // the lookup the number refreshes at once; one attached by the bill-save script can
    // take up to this long to show.
    var MISSING_COUNT_TTL = 300;

    // Who may use the Upload and Queue tabs.
    //   false = everyone who can sign in (the default)
    //   true  = only employees with the box below ticked on their employee record.
    // Create the employee field first (Check Box), then switch this to true.
    var REQUIRE_UPLOAD_FLAG = false;
    var FLD_UPLOAD = 'custentity_vendor_invoice_upload';

    // Max suggestions per group (vendors / invoices) in the type-ahead dropdown.
    var MAX_SUGGEST = 8;

    // Bill fields searched when the user searches by "Invoice #" (or "All").
    // "Order #" is always the bill's tranid (the Reference No. field on the
    // bill form). These are SuiteQL column names on the transaction table:
    //   externalid        External ID (source-system / migrated reference)
    //   otherrefnum       PO/Check Number
    // Both are also shown in the Invoice # column, in that order.
    var REF_FIELDS = ['externalid', 'otherrefnum'];

    // The bill's "Unit #" custom body field (its Field ID, as a SuiteQL column). The main
    // search box matches against it and every invoice table shows it in a Unit # column.
    // Set to '' to turn that off.
    var UNIT_FIELD = 'custbody_unit';

    // Link each Order # to its vendor bill inside NetSuite?
    //   'access' = only for signed-in people whose employee record has Give Access
    //              ticked (they can log in to NetSuite). Everyone else sees plain text,
    //              and the NetSuite address never appears in their page.
    //   'all'    = for everyone
    //   'none'   = for no one
    // The link opens in a new tab. NetSuite still applies its own permissions, so someone
    // with Give Access but no bill permission lands on a NetSuite permission message.
    var NETSUITE_LINKS = 'access';

    // UNIT_COL is UNIT_FIELD when that custom field exists in this account right now, otherwise ''
    // (and then the Unit # column, search, sort and editing are simply off). It is worked out at
    // the start of every request, so a sandbox refresh that removes the field cannot break
    // searches, and a field created later is picked up without a redeploy. The answer is
    // remembered for a few minutes so ordinary page loads do not pay for the check.
    var UNIT_COL = '';
    var UNIT_CACHE_TTL = 300;

    function unitFieldName() {
        return /^custbody_[a-z0-9_]+$/i.test(UNIT_FIELD) ? UNIT_FIELD : '';
    }

    function probeUnitField(f) {
        try {
            query.runSuiteQL({ query: 'SELECT t.' + f + ' AS u FROM transaction t WHERE ROWNUM <= 1', params: [] });
            return true;
        } catch (e) {
            return false;
        }
    }

    function resolveUnitColumn() {
        var f = unitFieldName();
        if (!f) return '';
        try {
            var c = cache.getCache({ name: 'NTS_VENDOR_DOC_UNIT', scope: cache.Scope.PRIVATE });
            var v = c.get({ key: f, ttl: UNIT_CACHE_TTL, loader: function () { return probeUnitField(f) ? 'Y' : 'N'; } });
            return v === 'Y' ? f : '';
        } catch (e) {
            return probeUnitField(f) ? f : '';
        }
    }

    // ---------------------------------------------------------------------
    // BRAND ASSETS (Nussbaum design system)
    //
    // The logo (light and dark versions) and the tab icon are embedded at the
    // bottom of this file, so nothing needs uploading for them.
    //
    // The Univers fonts are optional. Upload the .ttf files to the File Cabinet and put
    // each file's PATH below, for example 'SuiteScripts/AP Invoice Lookup/fonts/UniversLTPro-BoldCond.ttf'.
    // The same path works in sandbox and production. An empty '' means "not set": the
    // page uses Arial Narrow / Helvetica Neue / Arial instead.
    //
    //   cond300   UniversLTPro-LightCond.ttf      Univers 47 Light Cond
    //   cond400   UniversLTPro-Condensed.ttf      Univers 57 Condensed
    //   cond700   UniversLTPro-BoldCond.ttf       Univers 67 Bold Cond
    //   body300   UniversLTPro-45Light.ttf        Univers 45 Light
    //   body400   UniversLTPro-55Roman.ttf        Univers 55 Roman
    //   body700   UniversLTPro-65Bold.ttf         Univers 65 Bold
    //
    // The fonts are licensed for internal use only, so they are served to
    // signed-in people only.
    // ---------------------------------------------------------------------
    var BRAND_FILES = {
        cond300: '', cond400: '', cond700: '',
        body300: '', body400: '', body700: ''
    };

    var BRAND_FONTS = [
        { key: 'cond300', family: 'Univers LT Pro Cond', weight: 300 },
        { key: 'cond400', family: 'Univers LT Pro Cond', weight: 400 },
        { key: 'cond700', family: 'Univers LT Pro Cond', weight: 700 },
        { key: 'body300', family: 'Univers LT Pro',      weight: 300 },
        { key: 'body400', family: 'Univers LT Pro',      weight: 400 },
        { key: 'body700', family: 'Univers LT Pro',      weight: 700 }
    ];

    // ---------------------------------------------------------------------
    // PDF VIEWER AND NOTES
    //
    // A PDF dropped on the Upload invoices tab, or on an invoice row of the Missing documents
    // tab, opens in a viewer so the person can read it and add notes on it: pen, highlight and
    // typed text, with eraser and undo. When the PDF is uploaded or attached the notes are
    // written into the PDF itself, so the file that lands on the bill is the marked-up one. A
    // PDF with no notes is sent exactly as it was dropped (byte for byte).
    //
    // The viewer uses two open-source libraries kept in the File Cabinet. Each is listed by its
    // File Cabinet PATH (the same in sandbox and production; never an internal ID) and is served
    // by this Suitelet to signed-in people only (&mode=lib&n=<key>):
    //   pdfjs      pdf.min.js         pdf.js 3.11.174 (Mozilla, Apache-2.0)  shows the pages
    //   pdfworker  pdf.worker.min.js  pdf.js 3.11.174, its worker file
    //   pdflib     pdf-lib.min.js     pdf-lib 1.17.1 (MIT)                   writes the notes into the PDF
    // Use exactly these versions (the viewer is written and tested against them). Set a path to
    // '' to switch that part off. Without pdfjs + pdfworker the PDF still shows, in the
    // browser's own PDF viewer, but no notes can be added; without pdflib the pages show but
    // the note tools are off.
    // ---------------------------------------------------------------------
    var PDF_TOOL_FILES = {
        pdfjs:     'SuiteScripts/AP Invoice Lookup/lib/pdf.min.js',
        pdfworker: 'SuiteScripts/AP Invoice Lookup/lib/pdf.worker.min.js',
        pdflib:    'SuiteScripts/AP Invoice Lookup/lib/pdf-lib.min.js'
    };

    // true  = the viewer opens by itself when PDFs are dropped or chosen
    // false = it opens only from a file's View button (Upload tab); a PDF dropped on an invoice
    //         row is then attached straight away, as before
    var PREVIEW_ON_DROP = true;

    // ---------------------------------------------------------------------
    // ACCESS CONTROL
    //
    // Managed on the EMPLOYEE record, not in this file:
    //   custentity_vendor_invoice_access    (Check Box)      -- tick to grant access
    //   custentity_vendor_invoice_passcode  (Free-Form Text) -- passcode hash
    //
    // If the passcode field is filled in, that person needs their email AND
    // the passcode. If it is blank, their email alone is enough.
    //
    // Revoking is immediate: untick the box and the next page load fails,
    // because every request re-checks the employee record.
    //
    // Set REQUIRE_LOGIN = false to turn the gate off entirely.
    // ---------------------------------------------------------------------
    var REQUIRE_LOGIN = true;

    var FLD_ACCESS = 'custentity_vendor_invoice_access';
    var FLD_CODE   = 'custentity_vendor_invoice_passcode';

    // WHAT EACH PERSON MAY SEE, also set on the employee record (re-read on every request, so a
    // change takes effect on the person's next click):
    //   custentity_vendor_invoice_subs    Multiple Select, List/Record = Subsidiary
    //       the subsidiaries whose vendor bills they see (the bill's own subsidiary)
    //   custentity_vendor_invoice_groups  Multiple Select, List/Record = Vendor Category
    //       which of the AP / TMT groups (VENDOR_GROUPS) they see. A custom list, or a text
    //       field such as "AP, TMT", also works: values are matched to each group's category,
    //       key, label or name.
    // A person limited to some subsidiaries or one group sees only those invoices everywhere:
    // search, type-ahead, vendor and invoice pages, both Missing tabs and their badges, document
    // links, uploads and attaches. To them, an invoice outside their access does not exist. Of the
    // PDFs waiting for an invoice they see the ones they uploaded, plus any whose order # matches
    // an invoice they can see.
    // The fields must exist in the account (like the two above): if they are missing, sign-in
    // says it is not available. Set a field ID to '' to switch that limit off for everyone.
    var FLD_SUBS   = 'custentity_vendor_invoice_subs';
    var FLD_GROUPS = 'custentity_vendor_invoice_groups';

    // What a blank field means:
    //   true  = no limit (everything), so people keep working until they are given a limit
    //   false = nothing; every person must be given subsidiaries and groups before they see invoices
    var SCOPE_BLANK_MEANS_ALL = true;

    // Any random string. Changing it signs everyone out immediately.
    var COOKIE_SECRET = 'CHANGE-ME-TO-ANYTHING-RANDOM';

    // Salt for stored passcode hashes. Set it once and DO NOT change it later --
    // changing it invalidates every passcode people have set for themselves.
    var PW_SALT = 'CHANGE-ME-ONCE-THEN-LEAVE-ALONE';

    var MIN_PW = 8;

    var COOKIE_NAME  = 'nts_doclookup_auth';
    var COOKIE_HOURS = 8;

    // Set once per request to the signed-in person's name, for the audit log.
    var AUTH_USER = '';
    var AUTH_LOOKUP_FAILED = false;   // the employee lookup itself failed (e.g. a required employee field is missing), as opposed to no match
    var LOGIN_UNAVAILABLE = 'Sign-in is not available right now. Please tell IT or Accounting.';
    var AUTH_CAN_UPLOAD = true;   // set per request from the employee record
    var AUTH_NS = false;          // this person can log in to NetSuite (employee Give Access)
    var AUTH_SCOPE = null;        // { subs: [ids] or null (all), subNames, groupTokens } for the signed-in person
    var ALLOWED_GROUPS = null;    // group keys this person may see, worked out once per request
    var VENDOR_SUB_SIMPLE = false; // set when NetSuite refuses the vendor-subsidiary table; then the vendor's primary subsidiary is used
    var TAB = 'search';           // which tab the page being built belongs to
    var HAS_DROP = false;         // this page has invoice rows that accept a dropped PDF
    var HAS_UNIT = false;         // this page has unit # cells that can be edited
    var HAS_PDFVIEW = false;      // this page uses the PDF viewer (Upload tab, or rows that accept a dropped PDF)
    var TOGGLE_IN_SEARCH = false; // the AP / TMT toggle was drawn in the search row, so not again in the tab bar

    // ---------- helpers ----------

    function esc(s) {
        if (s === null || typeof s === 'undefined') return '';
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * Relative link base that preserves the parameters a no-login request
     * arrives with. An external Suitelet URL carries compid and h; dropping
     * either produces "You are not allowed to navigate directly to this page".
     * Generating the URL from scratch (url.resolveScript) does not reproduce
     * them, so carry through whatever the caller actually used.
     */
    var LINK_BASE = '';

    function buildLinkBase(req) {
        var s = runtime.getCurrentScript();

        // Echo back exactly what the caller used. getCurrentScript() returns the
        // scriptid strings (customscript_/customdeploy_), while the External URL
        // uses numeric ids -- mixing the two alongside an ns-at token gets the
        // request rejected as direct navigation.
        var b = '?script=' + encodeURIComponent(req.parameters.script || s.id)
              + '&deploy=' + encodeURIComponent(req.parameters.deploy || s.deploymentId);

        ['compid', 'ns-at', 'h'].forEach(function (p) {
            var v = req.parameters[p];
            if (v) b += '&' + p + '=' + encodeURIComponent(v);
        });

        return b;
    }

    function self() {
        return LINK_BASE;
    }

    // Active date range for this request, as YYYY-MM-DD strings ('' = open ended).
    var DATE_FROM = '';
    var DATE_TO   = '';

    // Which page of results this request wants (1-based), MAX_BILLS invoices a page.
    var PAGE = 1;

    /** Which fields a search covers. Anything unrecognised means all. */
    function cleanBy(b) {
        return ['vendor', 'po', 'invoice', 'unit'].indexOf(b) >= 0 ? b : 'all';
    }

    function validIso(d) {
        return /^\d{4}-\d{2}-\d{2}$/.test(d || '');
    }

    /** YYYY-MM-DD -> the account's display date format, which is what search wants. */
    function toNsDate(iso) {
        var p = iso.split('-');
        // Build from parts rather than parsing the string, so the date does not
        // shift a day either way from timezone interpretation.
        var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
        return format.format({ value: d, type: format.Type.DATE });
    }

    /** Extra search filters for the given date field, honouring whichever bounds are set. */
    function dateFilters(fieldId) {
        var f = [];
        if (validIso(DATE_FROM)) {
            f.push('AND', [fieldId, 'onorafter', toNsDate(DATE_FROM)]);
        }
        if (validIso(DATE_TO)) {
            f.push('AND', [fieldId, 'onorbefore', toNsDate(DATE_TO)]);
        }
        return f;
    }

    // ---------- sorting ----------
    // A column header is a link that reloads the list with &sort=<column>&dir=<asc|desc>. The
    // sort covers the whole list (done by the database or the search), not just the page shown,
    // and a click goes back to page 1.
    var SORT_KEY = '';      // the column the person clicked; empty means the list's own order
    var SORT_DIR = 'desc';
    var SORT_KEYS = ['vendorid', 'vendor', 'date', 'order', 'invoice', 'unit', 'amount', 'file', 'by', 'uploaded', 'status'];
    // A first click on these starts at the biggest / newest; everything else starts A to Z.
    var SORT_FIRST_DESC = { date: true, amount: true, uploaded: true, status: true };

    // Columns each list can sort by (a vendor page has one vendor, so no vendor columns; the
    // Missing documents list comes from a NetSuite search that cannot sort by invoice #).
    var SORT_VENDOR, SORT_RESULTS, SORT_MISSING, SORT_WAITING;
    function initSortKeys() {
        SORT_VENDOR  = ['date', 'order', 'invoice'].concat(UNIT_COL ? ['unit'] : []).concat(['amount']);
        SORT_RESULTS = ['vendorid', 'vendor', 'date', 'order', 'invoice'].concat(UNIT_COL ? ['unit'] : []).concat(['amount']);
        SORT_MISSING = ['vendor', 'date', 'order'].concat(UNIT_COL ? ['unit'] : []).concat(['amount']);
        SORT_WAITING = ['order'].concat(UNIT_COL ? ['unit'] : []).concat(['file', 'by', 'uploaded', 'status']);
    }
    initSortKeys();

    /** The sort in effect for a list that supports `allowed` columns, or null. */
    function sortFor(allowed) {
        return (SORT_KEY && allowed.indexOf(SORT_KEY) >= 0) ? { key: SORT_KEY, dir: SORT_DIR } : null;
    }

    /** &sort=..&dir=.. to carry a valid sort through a list's own links (page numbers). */
    function sortQs(allowed) {
        var so = sortFor(allowed);
        return so ? '&sort=' + so.key + '&dir=' + so.dir : '';
    }

    /** The SuiteQL expression a column sorts by ('' if it cannot). */
    function sqlSortExpr(key) {
        var map = { vendorid: 'v.entityid', vendor: 'v.companyname', date: 't.trandate', order: 't.tranid',
                    invoice: 'NVL(t.externalid, t.otherrefnum)',
                    amount: 'ABS(t.foreigntotal)' };   // bills are stored as negatives; the page shows the positive amount
        if (key === 'unit' && UNIT_COL) return 't.' + UNIT_COL;
        return map.hasOwnProperty(key) ? map[key] : '';
    }

    /** ORDER BY text. Blanks go last both ways; ties fall back to newest first. */
    function sqlOrderBy(so) {
        var expr = so ? sqlSortExpr(so.key) : '';
        if (!expr) return 't.trandate DESC, t.id DESC';
        var dir = so.dir === 'asc' ? 'ASC' : 'DESC';
        if (so.key === 'date') return 't.trandate ' + dir + ', t.id ' + dir;
        return 'CASE WHEN ' + expr + ' IS NULL THEN 1 ELSE 0 END, ' + expr + ' ' + dir + ', t.trandate DESC, t.id DESC';
    }

    function rangeActive() {
        return validIso(DATE_FROM) || validIso(DATE_TO);
    }

    /** &from=..&to=.. for whichever bounds are set, to carry a date range through links. */
    function rangeQs() {
        var q = '';
        if (validIso(DATE_FROM)) q += '&from=' + encodeURIComponent(DATE_FROM);
        if (validIso(DATE_TO))   q += '&to=' + encodeURIComponent(DATE_TO);
        return q;
    }

    function dateRangeLabel() {
        if (validIso(DATE_FROM) && validIso(DATE_TO)) return DATE_FROM + ' to ' + DATE_TO;
        if (validIso(DATE_FROM)) return 'on or after ' + DATE_FROM;
        if (validIso(DATE_TO))   return 'on or before ' + DATE_TO;
        return '';
    }

    // ---------- links into NetSuite ----------

    var NS_HOST = null;

    function nsLinksOn() {
        if (NETSUITE_LINKS === 'all') return true;
        if (NETSUITE_LINKS !== 'access') return false;
        return !!AUTH_USER && AUTH_NS;
    }

    /** This account's NetSuite address, e.g. 3816459-sb1.app.netsuite.com (sandbox and production differ). */
    function nsHost() {
        if (NS_HOST !== null) return NS_HOST;
        NS_HOST = '';
        try {
            NS_HOST = url.resolveDomain({ hostType: url.HostType.APPLICATION }) || '';
        } catch (e) { /* fall through to the account id */ }
        if (!NS_HOST) {
            NS_HOST = String(runtime.accountId || '').toLowerCase().replace(/_/g, '-') + '.app.netsuite.com';
        }
        return NS_HOST;
    }

    /** Full address of a vendor bill in NetSuite. */
    function billUrl(billId) {
        var path;
        try {
            path = url.resolveRecord({ recordType: 'vendorbill', recordId: Number(billId) });
        } catch (e) {
            path = '/app/accounting/transactions/vendbill.nl?id=' + Number(billId);
        }
        return 'https://' + nsHost() + path;
    }

    // ---------- Nussbaum look: tokens + components ----------

    var LOGO_DARK = '', LOGO_LIGHT = '', FAVICON = '';   // set at the bottom of the file

    function brandUrl(key) {
        return self() + '&mode=brand&n=' + key;
    }

    /** @font-face rules for whichever Univers files are configured. Signed-in pages only. */
    function fontCss() {
        if (REQUIRE_LOGIN && !AUTH_USER) return '';
        var out = '';
        BRAND_FONTS.forEach(function (f) {
            if (!BRAND_FILES[f.key]) return;
            out += '@font-face{font-family:"' + f.family + '";font-weight:' + f.weight
                 + ';font-style:normal;font-display:swap;src:url("' + brandUrl(f.key)
                 + '") format("truetype")}';
        });
        return out;
    }

    // Colors, type and spacing come from the Nussbaum tokens, in a dark theme
    // (default) and a light theme. The person picks one in the settings menu and
    // the choice is remembered in the browser. Red is punctuation only. Internal
    // Blue appears once: the info band.
    var NB_CSS = `
:root{
--nb-white:#ffffff;--nb-black:#000008;--nb-red:#ee3124;--nb-red-hover:#c8271c;--nb-red-press:#a51e14;
--nb-gray-5:#e9e9ea;--nb-gray-10:#d8d9db;--nb-gray-20:#bbbfc1;--nb-gray-30:#a0a4a8;--nb-gray-40:#878d90;
--nb-gray-50:#6f767a;--nb-gray-70:#474f53;--nb-gray-80:#323a3e;--nb-gray-90:#1b2428;
--nb-blue:#1e5a78;--nb-blue-10:#e3ebee;
--accent-hover:var(--nb-red-hover);--accent-press:var(--nb-red-press);
--font-display:"Univers LT Pro Cond","Arial Narrow","Helvetica Neue",Arial,sans-serif;
--font-body:"Univers LT Pro","Helvetica Neue",Arial,sans-serif;
}
:root,:root[data-theme="dark"]{
color-scheme:dark;
--bg-1:var(--nb-black);--bg-2:var(--nb-gray-90);--bg-3:var(--nb-gray-80);--bg-inverse:var(--nb-gray-90);
--fg-1:var(--nb-white);--fg-2:var(--nb-gray-10);--fg-3:var(--nb-gray-30);--fg-accent:var(--nb-red);
--border-subtle:var(--nb-gray-70);--border-control:var(--nb-gray-40);--border-strong:var(--nb-white);
--accent-text:var(--nb-red);
--card-bg:var(--nb-gray-90);--card-border:var(--nb-gray-70);
--info-bg:var(--nb-blue);--info-fg:var(--nb-white);
}
:root[data-theme="light"]{
color-scheme:light;
--bg-1:var(--nb-white);--bg-2:var(--nb-gray-5);--bg-3:var(--nb-gray-10);--bg-inverse:var(--nb-black);
--fg-1:var(--nb-gray-90);--fg-2:var(--nb-gray-70);--fg-3:var(--nb-gray-50);--fg-accent:var(--nb-red);
--border-subtle:var(--nb-gray-20);--border-control:var(--nb-gray-50);--border-strong:var(--nb-black);
--accent-text:var(--nb-red-hover);
--card-bg:var(--nb-white);--card-border:var(--nb-gray-20);
--info-bg:var(--nb-blue-10);--info-fg:var(--nb-gray-90);
}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none !important}
html{-webkit-text-size-adjust:100%}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;font-family:var(--font-body);font-weight:300;
font-size:16px;line-height:1.6;color:var(--fg-1);background:var(--bg-1)}
a{color:var(--fg-1);text-decoration:underline;text-underline-offset:2px;transition:color 150ms cubic-bezier(0,0,.2,1)}
a:hover{color:var(--accent-text)}
a:focus-visible,button:focus-visible{outline:2px solid var(--nb-red);outline-offset:2px}

.nb-wrap{max-width:1440px;margin:0 auto;padding-left:24px;padding-right:24px}
.nb-topbar{position:relative;overflow:hidden;height:3px;background:var(--nb-red)}
/* NetSuite pages can take a moment: show that something is happening after a click. */
body.is-loading{cursor:progress}
body.is-loading main{opacity:.55;transition:opacity 150ms cubic-bezier(0,0,.2,1)}
body.is-loading .nb-topbar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:35%;background:var(--nb-white);opacity:.8;
animation:nb-load 1.1s cubic-bezier(.4,0,.2,1) infinite}
@keyframes nb-load{from{transform:translateX(-100%)}to{transform:translateX(290%)}}
@media (prefers-reduced-motion:reduce){body.is-loading .nb-topbar::after{animation:none;width:100%;opacity:.35}}
.nb-header{border-bottom:1px solid var(--border-subtle);padding:16px 0}
.nb-header .nb-wrap{--logo-h:48px;display:flex;align-items:center;gap:24px}
.nb-logo{display:none;height:var(--logo-h);width:auto;flex:none}
.nb-logo--dark{display:block}
:root[data-theme="light"] .nb-logo--dark{display:none}
:root[data-theme="light"] .nb-logo--light{display:block}
.nb-title{flex:1;min-width:0;font-family:var(--font-display);font-weight:700;font-size:32px;line-height:1;
letter-spacing:.06em;text-transform:uppercase;color:var(--fg-1)}
.nb-main{flex:1;width:100%;padding-top:40px;padding-bottom:64px}

.nb-settings{position:relative;flex:none}
/* The logo's swoosh fills the top of the image, so the "Nussbaum" lettering centres about 22% of the
   image height below the image's middle. Drop the title and gear by that much so they line up with
   the lettering rather than the image box. */
.nb-title,.nb-settings{position:relative;top:calc(var(--logo-h) * .225)}
.nb-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border:1px solid var(--border-control);
border-radius:4px;background:transparent;color:var(--fg-1);cursor:pointer;
transition:background-color 150ms cubic-bezier(0,0,.2,1)}
.nb-iconbtn:hover{background:var(--bg-3)}
.nb-iconbtn[aria-expanded="true"]{background:var(--bg-3)}
.nb-popover{position:absolute;right:0;top:calc(100% + 8px);width:264px;padding:16px;background:var(--card-bg);
border:1px solid var(--card-border);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,8,.18);z-index:30}
.nb-popover[hidden]{display:none}
.nb-seg{display:flex;gap:2px;margin-top:8px;padding:2px;border:1px solid var(--border-control);border-radius:4px}
.nb-seg button{flex:1;padding:8px 12px;border:0;border-radius:2px;background:transparent;color:var(--fg-1);cursor:pointer;
font-family:var(--font-display);font-weight:400;font-size:14px;letter-spacing:.06em;text-transform:uppercase}
.nb-seg button:hover{background:var(--bg-3)}
.nb-seg button[aria-pressed="true"]{background:var(--fg-1);color:var(--bg-1);font-weight:700}
.nb-accesshead{margin-top:16px}
.nb-access{margin-top:4px;color:var(--fg-2)}

.nb-overline{font-family:var(--font-display);font-weight:700;font-size:12px;line-height:1.3;letter-spacing:.18em;
text-transform:uppercase;color:var(--fg-accent)}
.nb-headline{font-family:var(--font-display);font-weight:700;text-transform:uppercase;line-height:1.05;color:var(--fg-1);margin:0}
.nb-overline+.nb-headline{margin-top:4px}
.nb-h1{font-size:44px}.nb-h2{font-size:32px}.nb-h5{font-size:18px}
.nb-keep{text-transform:none}
.nb-lead{font-size:18px;color:var(--fg-2);max-width:60ch;margin:8px 0 24px}
.nb-sechead{margin:40px 0 8px}
.nb-sechead--first{margin-top:0}

.nb-label{font-family:var(--font-display);font-weight:400;font-size:14px;line-height:1.3;letter-spacing:.06em;
text-transform:uppercase;color:var(--fg-2)}
.nb-field{display:flex;flex-direction:column;gap:8px}
.nb-input{font-family:var(--font-body);font-weight:400;font-size:16px;line-height:1.4;color:var(--fg-1);
background:var(--bg-1);padding:12px;border:1px solid var(--border-control);border-radius:2px}
.nb-input::placeholder{color:var(--fg-3)}
.nb-input:hover{border-color:var(--fg-2)}
.nb-input:focus{outline:2px solid var(--nb-red);outline-offset:2px}
.nb-input[aria-invalid="true"]{border-color:var(--accent-text);border-width:2px}
.nb-help{font-size:13px;line-height:1.45;font-weight:400;color:var(--fg-3);margin:8px 0 0}
.nb-help--error{color:var(--accent-text);font-weight:700}

.nb-fieldbox{position:relative;display:flex;flex-direction:column;gap:2px;padding:8px 12px;background:var(--bg-1);
border:1px solid var(--border-control);border-radius:4px}
.nb-fieldbox:hover{border-color:var(--fg-2)}
.nb-fieldbox:focus-within{outline:2px solid var(--nb-red);outline-offset:2px}
.nb-fl{font-weight:400;font-size:13px;line-height:1.2;color:var(--fg-2)}
.nb-bare{width:100%;min-width:0;padding:0;border:0;outline:0;background:transparent;color:var(--fg-1);
font-family:var(--font-body);font-weight:400;font-size:16px;line-height:1.4}
.nb-bare::placeholder{color:var(--fg-3)}

.nb-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:12px 24px;border:1px solid transparent;
border-radius:2px;font-family:var(--font-display);font-weight:700;font-size:14px;line-height:1;letter-spacing:.06em;
text-transform:uppercase;text-decoration:none;cursor:pointer;
transition:background-color 150ms cubic-bezier(0,0,.2,1),color 150ms cubic-bezier(0,0,.2,1),transform 150ms cubic-bezier(0,0,.2,1)}
.nb-btn:active{transform:scale(.98)}
/* A button that cannot be used yet must not look ready (e.g. Upload before any file is added). */
.nb-btn:disabled,.nb-btn[disabled]{opacity:.4;cursor:not-allowed;transform:none}
.nb-btn--primary:disabled:hover,.nb-btn--primary[disabled]:hover{background:var(--nb-red)}
.nb-btn--primary{background:var(--nb-red);color:var(--nb-white)}
.nb-btn--primary:hover{background:var(--accent-hover);color:var(--nb-white)}
.nb-btn--primary:active{background:var(--accent-press)}
.nb-btn--secondary{background:transparent;color:var(--fg-1);border:2px solid var(--border-strong);padding:11px 23px}
.nb-btn--secondary:hover{background:var(--bg-3);color:var(--fg-1)}
.nb-btn--ghost{background:transparent;color:var(--fg-1);padding-left:8px;padding-right:8px}
.nb-btn--ghost:hover{color:var(--accent-text)}

.nb-card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:4px;padding:32px}
.nb-authcard{max-width:460px}
.nb-authcard form{display:flex;flex-direction:column;gap:16px;align-items:flex-start;margin-top:16px}
.nb-authcard .nb-field{width:100%}
.nb-authcard .nb-lead{font-size:16px;margin-bottom:0}

.nb-info{background:var(--info-bg);color:var(--info-fg);padding:12px 16px;border-radius:2px;margin:8px 0 16px;
font-size:15px;font-weight:400;max-width:720px}

.nb-search{margin-bottom:32px}
.nb-searchrow{display:flex;flex-wrap:wrap;align-items:stretch;gap:8px}
#wrap{flex:1 1 360px;max-width:560px}
#sugg{position:absolute;left:0;top:100%;margin-top:4px;min-width:100%;max-width:92vw;max-height:360px;overflow-y:auto;
background:var(--card-bg);border:1px solid var(--border-control);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,8,.18);
z-index:20;display:none}
#sugg .grp{padding:6px 12px;font-family:var(--font-display);font-weight:400;font-size:12px;letter-spacing:.06em;
text-transform:uppercase;color:var(--fg-2);background:var(--bg-2);border-bottom:1px solid var(--border-subtle)}
#sugg .row{padding:8px 12px;cursor:pointer;font-size:15px;font-weight:400;border-bottom:1px solid var(--border-subtle);
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sugg .row:hover,#sugg .row.sel{background:var(--bg-3)}
#sugg .vid{font-weight:700;color:var(--fg-1)}
#sugg .vnm{color:var(--fg-2);margin-left:8px}

.nb-searchrow .nb-datebox{flex:none;width:168px}
.nb-pager{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:16px}
.nb-pager .nb-help{margin:0}
.nb-pagenum{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;padding:0 8px;border:1px solid var(--border-control);
border-radius:2px;color:var(--fg-1);text-decoration:none;font-weight:400;font-size:14px;transition:background-color 150ms cubic-bezier(0,0,.2,1)}
a.nb-pagenum:hover{background:var(--bg-3);color:var(--fg-1)}
.nb-pagenum.is-current{background:var(--fg-1);color:var(--bg-1);border-color:var(--fg-1);font-weight:700}
.nb-gap{padding:0 4px;color:var(--fg-3)}
.nb-pageof{margin-left:8px !important;display:inline-flex;align-items:center;gap:6px}
.nb-goto{width:64px;padding:6px 8px;text-align:center;font-family:var(--font-body);font-weight:400;font-size:14px;color:var(--fg-1);
background:var(--bg-1);border:1px solid var(--border-control);border-radius:2px;-moz-appearance:textfield}
.nb-goto::-webkit-outer-spin-button,.nb-goto::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.nb-goto:focus{outline:2px solid var(--nb-red);outline-offset:2px}
/* No overflow on the wrapper at desktop widths: an overflow value would make it its own scroll
   container and the sticky header would stop following the page. Narrow screens scroll sideways instead. */
.nb-scroll{overflow-x:visible}
@media (max-width:1100px){.nb-scroll{overflow-x:auto}}
.nb-table{width:100%;border-collapse:collapse;font-family:var(--font-body);font-size:15px;line-height:1.5;font-weight:400;color:var(--fg-2)}
.nb-table th{background:var(--bg-2);color:var(--fg-1);text-align:left;font-family:var(--font-display);font-weight:400;
font-size:13px;letter-spacing:.06em;text-transform:uppercase;padding:8px 12px;white-space:nowrap;
position:sticky;top:0;z-index:2;box-shadow:inset 0 -2px 0 var(--border-strong)}
.nb-table td{padding:12px;border-bottom:1px solid var(--border-subtle);vertical-align:top}
.nb-table tbody tr:hover td{background:var(--bg-3)}
.nb-table .nb-num{text-align:right;font-variant-numeric:tabular-nums}
.nb-table .nb-strong{color:var(--fg-1);font-weight:700}
.nb-sub{display:block;color:var(--fg-2);font-size:13px}
.nb-actions{margin-top:24px}
/* Invoice tables: order #, dates, amounts and the like stay on one line. Only the vendor name
   and the Document column may wrap. */
.nb-bills td{white-space:nowrap;vertical-align:middle;padding-top:9px;padding-bottom:9px}
.nb-tablebar{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;margin:4px 0 8px;font-size:13px;line-height:1.45;font-weight:400;color:var(--fg-3)}
.nb-tablebar .nb-count{color:var(--fg-2);font-weight:700}
/* Links repeat on every row, so their underline is quiet until hovered. */
.nb-table a{text-decoration-color:var(--border-control);text-decoration-thickness:1px}
.nb-table a:hover{text-decoration-color:currentColor}
.nb-unitedit{opacity:.55}
/* Sortable column headers: the label is a link with a small arrow that darkens on hover. */
.nb-sortlink{display:inline-flex;align-items:center;gap:4px;color:inherit;text-decoration:none}
.nb-sortlink:hover{color:var(--fg-1);text-decoration:underline;text-underline-offset:3px}
.nb-table th.nb-num .nb-sortlink{justify-content:flex-end}
.nb-sorticon{display:inline-flex;opacity:.35;transition:opacity 150ms cubic-bezier(0,0,.2,1)}
.nb-sortable:hover .nb-sorticon,.nb-sortlink:focus-visible .nb-sorticon{opacity:.85}
.nb-table th.is-sorted{font-weight:700}
.nb-table th.is-sorted .nb-sorticon{opacity:1}
.nb-table tr:hover .nb-unitedit,.nb-unitedit:hover,.nb-unitedit:focus-visible{opacity:1}
.nb-bills td.nb-vname,.nb-bills td.nb-doccell{white-space:normal}
.nb-bills td.nb-doccell{min-width:300px}
.nb-iconbtn-sm{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin-left:4px;padding:0;border:1px solid transparent;
border-radius:2px;background:transparent;color:var(--fg-2);cursor:pointer;vertical-align:middle;
transition:background-color 150ms cubic-bezier(0,0,.2,1),color 150ms cubic-bezier(0,0,.2,1)}
.nb-iconbtn-sm:hover{background:var(--bg-3);color:var(--fg-1);border-color:var(--border-control)}
.nb-unitedit-row{display:flex;align-items:center;gap:2px}
.nb-input.nb-unitin{width:104px;min-width:0;padding:6px 8px;font-size:14px}
.nb-unitnote{margin-top:4px;font-size:13px;font-weight:700;color:var(--accent-text);white-space:normal}
.nb-unitnote:empty{display:none}
.nb-droprow.is-over td{background:var(--bg-3);box-shadow:inset 0 2px 0 var(--nb-red),inset 0 -2px 0 var(--nb-red)}
.nb-droprow.is-over td:first-child{box-shadow:inset 0 2px 0 var(--nb-red),inset 0 -2px 0 var(--nb-red),inset 2px 0 0 var(--nb-red)}
.nb-droprow.is-over td:last-child{box-shadow:inset 0 2px 0 var(--nb-red),inset 0 -2px 0 var(--nb-red),inset -2px 0 0 var(--nb-red)}
/* The invoice rows' own file box, in the style of a native file field: a dashed box with a
   button and "No file chosen". A PDF can be dropped on the row or chosen with the button. */
.nb-dropbox{display:flex;align-items:center;gap:10px;padding:4px 8px;border:1px dashed var(--border-control);border-radius:4px;
background:var(--bg-1);transition:border-color 150ms cubic-bezier(0,0,.2,1),background-color 150ms cubic-bezier(0,0,.2,1)}
.nb-dropbox--row{display:inline-flex;max-width:100%}
.nb-dropbox .nb-btn{padding:5px 12px;font-size:13px;flex:none}
.nb-dropbox .nb-btn--secondary{padding:4px 11px}
.nb-dropbox-text{min-width:0;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-2);font-size:14px;font-weight:400}
.nb-droprow.is-over .nb-dropbox{border-color:var(--nb-red);background:var(--bg-2)}
.nb-attachnote{font-size:13px;color:var(--fg-2);min-height:0}
.nb-attachnote:empty{display:none}

.nb-tabs{border-bottom:1px solid var(--border-subtle)}
.nb-tabs .nb-wrap{display:flex;flex-wrap:wrap;align-items:center;gap:24px}
/* AP / TMT / Both choice: a field box labelled "Invoices" in the search row, before the Search
   button; a page without a search box shows the same small buttons at the right of the tab bar. */
.nb-groupsel{margin-left:auto;display:flex;align-items:center;gap:10px;padding:6px 0}
.nb-searchrow .nb-groupbox{flex:none}
.nb-chips{display:flex;gap:2px;margin-left:-6px}
.nb-groupsel .nb-chips{margin-left:0}
.nb-chip{display:inline-flex;align-items:center;height:22px;padding:0 8px;border-radius:2px;font-family:var(--font-body);font-weight:400;
font-size:15px;line-height:1;color:var(--fg-2);text-decoration:none;
transition:background-color 150ms cubic-bezier(0,0,.2,1),color 150ms cubic-bezier(0,0,.2,1)}
.nb-chip:hover{background:var(--bg-3);color:var(--fg-1);text-decoration:none}
.nb-chip.is-active{background:var(--fg-1);color:var(--bg-1);font-weight:700}
.nb-chip:focus-visible{outline:2px solid var(--nb-red);outline-offset:1px}
.nb-groupone{font-weight:400;font-size:16px;line-height:1.4;color:var(--fg-1)}
.nb-groupsel__label{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-3)}
.nb-groupbar{display:flex;justify-content:flex-end;padding-top:12px;padding-bottom:0}
.nb-groupbar .nb-groupsel{margin-left:0}
.nb-tab{display:inline-flex;align-items:center;gap:8px;padding:12px 2px;margin-bottom:-1px;border-bottom:2px solid transparent;
color:var(--fg-2);text-decoration:none;font-family:var(--font-display);font-weight:400;font-size:14px;letter-spacing:.06em;text-transform:uppercase}
.nb-tab:hover{color:var(--fg-1)}
.nb-tab.is-active{color:var(--fg-1);font-weight:700;border-bottom-color:var(--border-strong)}
.nb-badge{display:inline-block;min-width:20px;padding:2px 6px;border-radius:2px;background:var(--nb-red);color:var(--nb-white);
font-family:var(--font-body);font-weight:700;font-size:12px;line-height:1.2;text-align:center;letter-spacing:0}
.nb-drop{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:32px;cursor:pointer;border:1px dashed var(--border-control);
border-radius:4px;background:var(--bg-1);transition:border-color 150ms cubic-bezier(0,0,.2,1),background-color 150ms cubic-bezier(0,0,.2,1)}
.nb-drop.is-over{border-color:var(--nb-red);background:var(--bg-2)}
.nb-drop-title{font-family:var(--font-display);font-weight:700;font-size:22px;line-height:1.1;text-transform:uppercase;color:var(--fg-1)}
.nb-input--sm{padding:8px 10px;width:100%;min-width:200px}
.nb-uploadbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin-top:16px}
.nb-uploadbar .nb-help{margin:0}
.nb-state-error{color:var(--accent-text);font-weight:700}
.nb-table td .nb-btn--ghost{padding:4px 8px}
.nb-editrow{display:flex;gap:8px;align-items:center}
.nb-linkbtn{padding:0;border:0;background:none;color:var(--fg-1);font:inherit;font-weight:700;text-align:left;cursor:pointer;
text-decoration:underline;text-decoration-color:var(--border-control);text-underline-offset:2px}
.nb-linkbtn:hover{color:var(--accent-text);text-decoration-color:currentColor}
.nb-notecount{display:block;font-size:13px;font-weight:400;color:var(--fg-2)}

/* PDF viewer with notes (see PDF VIEWER AND NOTES). The page itself stays white in both themes. */
.nb-pdfdlg{width:min(1240px,calc(100vw - 32px));height:calc(100vh - 32px);max-width:none;max-height:none;margin:auto;padding:0;
border:1px solid var(--card-border);border-radius:4px;background:var(--card-bg);color:var(--fg-1);overflow:hidden;
box-shadow:0 8px 32px rgba(0,0,8,.45)}
.nb-pdfdlg[open]{display:flex;flex-direction:column}
.nb-pdfdlg::backdrop{background:rgba(0,0,8,.65)}
.nb-pdfhead{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:14px 20px;border-bottom:1px solid var(--border-subtle)}
.nb-pdftitles{flex:1 1 260px;min-width:0}
.nb-pdftitle{font-family:var(--font-display);font-weight:700;font-size:22px;line-height:1.15;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb-pdfsub{font-size:13px;font-weight:400;color:var(--fg-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nb-pdffields{display:flex;gap:8px}
.nb-pdffields .nb-fieldbox{width:170px;padding:6px 10px}
.nb-pdffields .nb-fieldbox[data-bad="1"]{border-color:var(--accent-text);border-width:2px}
.nb-pdfnav{display:flex;align-items:center;gap:4px;font-size:14px;color:var(--fg-2);white-space:nowrap}
.nb-pdfacts{display:flex;gap:8px}
.nb-pdftools{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:8px 20px;background:var(--bg-2);
border-bottom:1px solid var(--border-subtle)}
.nb-toolgrp{display:flex;align-items:center;gap:2px}
.nb-toolgrp--end{margin-left:auto}
.nb-tool{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 10px;border:1px solid transparent;border-radius:2px;
background:transparent;color:var(--fg-2);cursor:pointer;font-family:var(--font-display);font-weight:400;font-size:13px;
letter-spacing:.06em;text-transform:uppercase;transition:background-color 150ms cubic-bezier(0,0,.2,1),color 150ms cubic-bezier(0,0,.2,1)}
.nb-tool:hover{background:var(--bg-3);color:var(--fg-1)}
.nb-tool[aria-pressed="true"]{background:var(--fg-1);color:var(--bg-1);font-weight:700}
.nb-tool:disabled{opacity:.4;cursor:not-allowed;background:transparent;color:var(--fg-2)}
.nb-tool:focus-visible,.nb-swatch:focus-visible{outline:2px solid var(--nb-red);outline-offset:2px}
.nb-swatch{width:24px;height:24px;margin:0 3px;padding:0;border:2px solid var(--border-subtle);border-radius:50%;cursor:pointer}
.nb-swatch[aria-pressed="true"]{box-shadow:0 0 0 2px var(--card-bg),0 0 0 4px var(--fg-1)}
.nb-swatch:disabled{opacity:.4;cursor:not-allowed}
.nb-zoomval{min-width:52px;text-align:center;font-size:13px;color:var(--fg-2);font-variant-numeric:tabular-nums}
.nb-pdfmsg{padding:8px 20px;font-size:14px;font-weight:400;background:var(--info-bg);color:var(--info-fg)}
.nb-pdfmsg.is-error{background:transparent;color:var(--accent-text);font-weight:700;border-bottom:1px solid var(--border-subtle)}
.nb-pdfmsg:empty{display:none}
.nb-pdfscroll{position:relative;flex:1;min-height:0;overflow:auto;background:var(--bg-3);padding:24px}
.nb-pdfpages{display:flex;flex-direction:column;align-items:center;gap:20px;min-width:min-content}
.nb-pdfpage{position:relative;flex:none;background:#fff;box-shadow:0 2px 10px rgba(0,0,8,.4)}
.nb-pdfpage canvas{position:absolute;left:0;top:0}
.nb-pdfpages[data-tool="view"] .nb-pdfov{touch-action:pan-x pan-y}
.nb-pdfpages[data-tool="pen"] .nb-pdfov,.nb-pdfpages[data-tool="hl"] .nb-pdfov{cursor:crosshair;touch-action:none}
.nb-pdfpages[data-tool="text"] .nb-pdfov{cursor:text;touch-action:none}
.nb-pdfpages[data-tool="erase"] .nb-pdfov{cursor:cell;touch-action:none}
.nb-pdftext{position:absolute;z-index:3;margin:0;padding:0;border:1px dashed #1e5a78;outline:0;background:rgba(255,255,255,.9);
resize:none;overflow:hidden;white-space:pre;font-family:Helvetica,Arial,sans-serif;line-height:1.2;min-width:140px}
.nb-pdfnative{display:block;width:100%;height:100%;border:0;background:#fff}
.nb-pdfscroll.is-native{padding:0}
.nb-pdfscroll.is-native .nb-pdfpages{display:block;height:100%}
.nb-pdfloading{padding:24px;color:var(--fg-2)}
@media (max-width:640px){.nb-pdfdlg{width:100vw;height:100vh;border-radius:0}.nb-pdfhead,.nb-pdftools{padding-left:12px;padding-right:12px}
.nb-pdfscroll{padding:12px}.nb-pdffields .nb-fieldbox{width:130px}.nb-tool span{display:none}}
@media (max-width:640px){.nb-h1{font-size:32px}.nb-h2{font-size:26px}.nb-main{padding-top:32px}.nb-card{padding:24px}
.nb-title{font-size:20px}.nb-header .nb-wrap{--logo-h:36px;gap:12px}}
`;

    // Runs in <head>, before the page paints, so the saved theme never flashes.
    var THEME_BOOT = 'try{var t=localStorage.getItem("nts_doclookup_theme");'
                   + 'document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark");}'
                   + 'catch(e){document.documentElement.setAttribute("data-theme","dark");}';

    /**
     * Drop a PDF on an invoice row (or use its Attach PDF button) to attach it to that
     * invoice. ATTACH_BASE and ATTACH_MAXB are defined ahead of it.
     */
    var ATTACH_JS = `
(function(){
var input=document.getElementById("attachInput"),target=null,over=null;
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function fmt(n){return n<1024?n+" B":n<1048576?Math.round(n/1024)+" KB":(n/1048576).toFixed(1)+" MB";}
function isFiles(e){var t=e.dataTransfer&&e.dataTransfer.types;return !!t&&Array.prototype.indexOf.call(t,"Files")>=0;}
function rowOf(el){while(el&&el!==document){if(el.classList&&el.classList.contains("nb-droprow"))return el;el=el.parentNode;}return null;}
function clearOver(){if(over){over.classList.remove("is-over");over=null;}}
function say(row,html,bad){var n=row.querySelector(".nb-attachnote");if(!n)return;n.innerHTML=html;n.className="nb-attachnote"+(bad?" nb-state-error":"");}
function toB64(f){
  return new Promise(function(res,rej){
    var fr=new FileReader();
    fr.onload=function(){var s=String(fr.result);res(s.substring(s.indexOf(",")+1));};
    fr.onerror=function(){rej(new Error("We could not read that file."));};
    fr.readAsDataURL(f);
  });
}
function dropBadge(){
  var b=document.querySelector('a.nb-tab[href*="tab=missing"] .nb-badge');
  if(!b)return;
  var n=parseInt(String(b.textContent).replace(/,/g,""),10)-1;
  if(n>0)b.textContent=String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");else if(b.parentNode)b.parentNode.removeChild(b);
}
/** Why this file cannot be attached, or "" when it can. */
function problem(f){
  if(!(/[.]pdf$/i.test(f.name)||f.type==="application/pdf"))return f.name+" is not a PDF.";
  if(f.size>ATTACH_MAXB)return f.name+" is over "+fmt(ATTACH_MAXB)+".";
  return "";
}
/**
 * Shows the PDF so the person can check it and add notes before it is attached. Resolves to
 * { file, notes } (file has the notes written in) or null when they cancel. Without the viewer
 * (PREVIEW_ON_DROP off) the PDF is attached as it is, as before.
 */
function review(row,f,pos,count){
  if(!window.NbPdf||!window.PDFV_CFG||!PDFV_CFG.auto)return Promise.resolve({file:f,notes:0});
  var order=row.getAttribute("data-order")||"";
  return NbPdf.open({file:f,overline:"Attach to invoice",title:order?"Order # "+order:"Invoice",
    sub:f.name+(count>1?" ("+pos+" of "+count+")":""),okLabel:"Attach",cancelLabel:"Cancel",bake:true})
    .then(function(r){return r.action==="ok"?{file:r.file||f,notes:(r.marks||[]).length}:null;});
}
function sendOne(row,f,blob,notes){
  if(blob.size>ATTACH_MAXB)return Promise.reject(new Error("With the notes, "+f.name+" is over "+fmt(ATTACH_MAXB)+"."));
  return toB64(blob).then(function(b64){
    var body=new URLSearchParams();body.set("bill",row.getAttribute("data-bill"));body.set("name",f.name);body.set("data",b64);
    if(notes)body.set("notes","1");
    return fetch(ATTACH_BASE+"&mode=attach",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});
  }).then(function(r){return r.text();}).then(function(t){
    var j;try{j=JSON.parse(t);}catch(e){throw new Error("Your session may have ended. Reload the page and sign in again.");}
    if(!j.ok)throw new Error(j.error||"The upload did not go through.");
    return j;
  });
}
function attach(row,files){
  var list=Array.prototype.slice.call(files||[]);
  if(!list.length||row.getAttribute("data-busy"))return;
  row.setAttribute("data-busy","1");
  var cell=row.querySelector(".nb-doccell"),txt=cell.querySelector(".nb-dropbox-text"),done=0,errs=[],i=0;
  function setTxt(t){if(txt)txt.textContent=t;}
  function next(){
    if(i>=list.length){
      row.removeAttribute("data-busy");setTxt("No file chosen");
      say(row,errs.length?esc(errs.join(" ")):done?(done+(done===1?" document":" documents")+" attached."):"Nothing was attached.",errs.length>0);
      return;
    }
    var f=list[i++],bad=problem(f);
    if(bad){errs.push(bad);next();return;}
    setTxt(f.name);
    say(row,"Checking "+esc(f.name)+"...",false);
    review(row,f,i,list.length).then(function(r){
      if(!r){next();return;}
      say(row,"Uploading "+esc(f.name)+"...",false);
      return sendOne(row,f,r.file,r.notes).then(function(j){
      var a=document.createElement("div");
      a.innerHTML='<a target="_blank" rel="noopener" href="'+esc(ATTACH_BASE+"&mode=file&id="+j.fileId)+'">'+esc(j.name)+'</a>';
      cell.insertBefore(a,cell.querySelector(".nb-dropbox")||cell.querySelector(".nb-attachnote"));
      if(!row.getAttribute("data-done")){row.setAttribute("data-done","1");dropBadge();}
      done++;
      }).catch(function(e){errs.push(e.message);}).then(next);
    }).catch(function(e){errs.push(e.message);next();});
  }
  next();
}
document.addEventListener("dragover",function(e){
  if(!isFiles(e))return;
  e.preventDefault();
  var row=rowOf(e.target);
  if(row!==over){clearOver();if(row){row.classList.add("is-over");over=row;}}
  if(e.dataTransfer)e.dataTransfer.dropEffect=row?"copy":"none";
});
document.addEventListener("dragleave",function(e){
  if(over&&(!e.relatedTarget||!over.contains(e.relatedTarget)))clearOver();
});
document.addEventListener("drop",function(e){
  if(!isFiles(e))return;
  e.preventDefault();
  var row=rowOf(e.target);clearOver();
  if(row)attach(row,e.dataTransfer.files);
});
document.addEventListener("click",function(e){
  var b=e.target&&e.target.classList&&e.target.classList.contains("nb-attachbtn")?e.target:null;
  if(!b)return;
  target=rowOf(b);
  if(target&&input)input.click();
});
if(input)input.addEventListener("change",function(){
  if(target)attach(target,input.files);
  input.value="";
});
})();
`;

    /**
     * Shows the page is busy between a click and the next page arriving. Cleared when the
     * page is shown again (Back button) or after a few seconds if the person stayed put.
     */
    var LOADING_JS = `
(function(){
var timer=null;
function off(){if(timer){clearTimeout(timer);timer=null;}if(document.body)document.body.classList.remove("is-loading");}
window.addEventListener("beforeunload",function(){
  // The Upload tab asks "leave this page?" while files are uploading; the person may stay.
  if(!document.body||window.onbeforeunload)return;
  document.body.classList.add("is-loading");
  if(timer)clearTimeout(timer);
  timer=setTimeout(off,12000);
});
window.addEventListener("pageshow",off);
})();
`;

    /** Page box: type a page number and press Enter to go there. */
    var PAGER_JS = `
document.addEventListener("keydown",function(e){
  var t=e.target;
  if(e.key!=="Enter"||!t||!t.classList||!t.classList.contains("nb-goto"))return;
  e.preventDefault();
  var v=String(t.value).trim();
  if(!/^[0-9]+$/.test(v))return;
  var max=parseInt(t.getAttribute("max"),10),n=parseInt(v,10);
  if(n>=1&&n<=max)window.location=t.getAttribute("data-base")+"&p="+n;
});
`;

    /** Settings menu: gear button + Light / Dark choice. */
    var THEME_JS = `
(function(){
var root=document.documentElement,btn=document.getElementById("nbSettingsBtn"),panel=document.getElementById("nbSettingsPanel");
if(!btn||!panel)return;
var opts=panel.querySelectorAll("[data-theme]");
function mark(){
  var cur=root.getAttribute("data-theme")==="light"?"light":"dark";
  Array.prototype.forEach.call(opts,function(o){o.setAttribute("aria-pressed",o.getAttribute("data-theme")===cur?"true":"false");});
}
function setTheme(t){
  root.setAttribute("data-theme",t);
  try{localStorage.setItem("nts_doclookup_theme",t);}catch(e){}
  mark();
}
function toggle(show){panel.hidden=!show;btn.setAttribute("aria-expanded",show?"true":"false");}
btn.addEventListener("click",function(ev){ev.stopPropagation();toggle(panel.hidden);});
Array.prototype.forEach.call(opts,function(o){o.addEventListener("click",function(){setTheme(o.getAttribute("data-theme"));});});
document.addEventListener("click",function(ev){if(!panel.hidden&&!panel.contains(ev.target))toggle(false);});
document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&!panel.hidden){toggle(false);btn.focus();}});
mark();
})();
`;

    // Lucide pencil / check / x, 16px, for the unit # editor.
    function smallIcon(paths) {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
             + 'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    }
    function sortIcon(paths) {
        return '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
             + 'stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
    }
    var ICON_SORT_UP   = sortIcon('<path d="m18 15-6-6-6 6"/>');
    var ICON_SORT_DOWN = sortIcon('<path d="m6 9 6 6 6-6"/>');
    var ICON_SORT_BOTH = sortIcon('<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>');

    /**
     * A table header cell. For a column the list can sort by, the label is a link: the first
     * click sorts it (newest / largest first for dates and amounts, A to Z otherwise) and each
     * click after that flips the direction. ctx = { base, allowed, active }, where base is the
     * list's address without &p / &sort and active is the sort now in effect (or null).
     */
    function sortHeader(label, key, ctx, cls) {
        var classes = cls ? [cls] : [];
        if (!ctx || ctx.allowed.indexOf(key) < 0) {
            return '<th' + (classes.length ? ' class="' + classes.join(' ') + '"' : '') + '>' + label + '</th>';
        }
        var cur = ctx.active && ctx.active.key === key ? ctx.active : null;
        var next = cur ? (cur.dir === 'asc' ? 'desc' : 'asc') : (SORT_FIRST_DESC[key] ? 'desc' : 'asc');
        classes.push('nb-sortable');
        if (cur) classes.push('is-sorted');
        return '<th class="' + classes.join(' ') + '" aria-sort="'
             + (cur ? (cur.dir === 'asc' ? 'ascending' : 'descending') : 'none') + '">'
             + '<a class="nb-sortlink" href="' + esc(ctx.base + '&sort=' + key + '&dir=' + next) + '" title="Sort by ' + esc(label) + '">'
             + label + '<span class="nb-sorticon">' + (cur ? (cur.dir === 'asc' ? ICON_SORT_UP : ICON_SORT_DOWN) : ICON_SORT_BOTH) + '</span></a></th>';
    }

    var ICON_PENCIL = smallIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>');
    var ICON_CHECK  = smallIcon('<path d="M20 6 9 17l-5-5"/>');
    var ICON_X      = smallIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

    /** Change a unit # in place. UNIT_BASE and UNIT_ICONS are defined ahead of it. */
    var UNITEDIT_JS = `
(function(){
var RE=/^[A-Za-z0-9][A-Za-z0-9 _/.-]{0,19}$/;
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function cellOf(el){while(el&&el!==document){if(el.classList&&el.classList.contains("nb-unitcell"))return el;el=el.parentNode;}return null;}
function btnOf(el,attr){while(el&&el!==document){if(el.getAttribute&&el.getAttribute(attr)!==null)return el;el=el.parentNode;}return null;}
function btn(cls,label,icon,attr){return '<button type="button" class="nb-iconbtn-sm '+cls+'" '+attr+' aria-label="'+label+'" title="'+label+'">'+icon+'</button>';}
function show(cell,unit){
  cell.removeAttribute("data-editing");cell.setAttribute("data-unit",unit);
  cell.innerHTML='<span class="nb-unitval">'+(unit?esc(unit):"&mdash;")+'</span>'+btn("nb-unitedit","Edit unit #",UNIT_ICONS.edit,'data-unit-edit="1"');
}
function note(cell,t){var n=cell.querySelector(".nb-unitnote");if(n)n.textContent=t||"";}
function edit(cell){
  if(cell.getAttribute("data-editing"))return;
  cell.setAttribute("data-editing","1");
  cell.innerHTML='<div class="nb-unitedit-row"><input class="nb-input nb-input--sm nb-unitin" maxlength="20" aria-label="Unit #" value="'+esc(cell.getAttribute("data-unit")||"")+'">'
    +btn("","Save unit #",UNIT_ICONS.save,'data-unit-save="1"')+btn("","Cancel",UNIT_ICONS.cancel,'data-unit-cancel="1"')+'</div><div class="nb-unitnote" role="alert"></div>';
  var i=cell.querySelector(".nb-unitin");if(i){i.focus();i.select();}
}
function save(cell){
  var i=cell.querySelector(".nb-unitin");
  if(!i||cell.getAttribute("data-busy"))return;
  var v=String(i.value).replace(/ +/g," ").trim().toUpperCase();
  if(v&&!RE.test(v)){note(cell,"Use up to 20 letters, numbers, dashes or slashes.");return;}
  if(v===(cell.getAttribute("data-unit")||"")){show(cell,v);return;}
  cell.setAttribute("data-busy","1");note(cell,"");
  var body=new URLSearchParams();body.set("bill",cell.getAttribute("data-bill"));body.set("unit",v);
  fetch(UNIT_BASE+"&mode=unit",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()})
    .then(function(r){return r.text();})
    .then(function(t){
      var j;try{j=JSON.parse(t);}catch(e){throw new Error("Your session may have ended. Reload the page and sign in again.");}
      if(!j.ok)throw new Error(j.error||"That did not go through.");
      cell.removeAttribute("data-busy");show(cell,j.unit||"");
    })
    .catch(function(e){cell.removeAttribute("data-busy");note(cell,e.message);});
}
document.addEventListener("click",function(e){
  var t=e.target;
  var c=cellOf(t);if(!c)return;
  if(btnOf(t,"data-unit-save"))save(c);
  else if(btnOf(t,"data-unit-cancel"))show(c,c.getAttribute("data-unit")||"");
  else if(btnOf(t,"data-unit-edit")||(t.classList&&t.classList.contains("nb-unitedit")))edit(c);
});
document.addEventListener("keydown",function(e){
  var t=e.target;
  if(!t||!t.classList||!t.classList.contains("nb-unitin"))return;
  var c=cellOf(t);if(!c)return;
  if(e.key==="Enter"){e.preventDefault();save(c);}
  else if(e.key==="Escape"){e.preventDefault();show(c,c.getAttribute("data-unit")||"");}
});
})();
`;

    // Lucide icons for the PDF viewer's toolbar.
    var PDF_ICONS = {
        pointer: smallIcon('<path d="m3 3 7.07 16.97 2.51-7.39 7.39-2.51L3 3z"/><path d="m13 13 6 6"/>'),
        pen:     smallIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>'),
        hl:      smallIcon('<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>'),
        text:    smallIcon('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>'),
        erase:   smallIcon('<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>'),
        undo:    smallIcon('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>'),
        trash:   smallIcon('<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>'),
        minus:   smallIcon('<path d="M5 12h14"/>'),
        plus:    smallIcon('<path d="M5 12h14"/><path d="M12 5v14"/>'),
        prev:    smallIcon('<path d="m15 18-6-6 6-6"/>'),
        next:    smallIcon('<path d="m9 18 6-6-6-6"/>')
    };

    /** Settings for PDFVIEW_JS: where the libraries are served from and which of them are set up. */
    function pdfViewConfig() {
        return 'var PDFV_CFG=' + JSON.stringify({
            base: self(),
            libs: { pdfjs: !!PDF_TOOL_FILES.pdfjs, pdfworker: !!PDF_TOOL_FILES.pdfworker, pdflib: !!PDF_TOOL_FILES.pdflib },
            auto: !!PREVIEW_ON_DROP,
            icons: PDF_ICONS
        }) + ';';
    }

    /**
     * The PDF viewer with notes (see PDF VIEWER AND NOTES). Defines window.NbPdf:
     *   NbPdf.open(opts) -> Promise of { action: 'ok'|'cancel'|'prev'|'next', marks, order?, unit?, file? }
     *     opts: file, overline, title, sub, okLabel, cancelLabel, keepOnCancel, bake (write the notes
     *           into the PDF when OK is pressed and return it as file), fields {order, unit, units,
     *           okOrder}, nav {pos, count, prev, next}, marks (notes from an earlier open)
     *   NbPdf.bake(file, marks) -> Promise of a new PDF Blob with the notes written into it
     * Notes are kept in PDF page coordinates, so they stay in place at any zoom and on rotated pages.
     */
    var PDFVIEW_JS = `
(function(){
var C=window.PDFV_CFG||{};
var NL=String.fromCharCode(10);
var COLORS=[{c:"#ee3124",n:"Red"},{c:"#1d4ed8",n:"Blue"},{c:"#000008",n:"Black"}];
var HL="#ffd400",HL_ALPHA=0.35,PEN_W=2,TEXT_PT=12,BL=0.94,LH=1.2,MAX_PAGES=60;
var ZOOMS=[0.5,0.75,1,1.25,1.5,2,2.5,3];
// Characters the PDF's built-in Helvetica can write (WinAnsi) beyond plain Latin-1.
var WINANSI=[0x20AC,0x201A,0x0192,0x201E,0x2026,0x2020,0x2021,0x02C6,0x2030,0x0160,0x2039,0x0152,0x017D,0x2018,0x2019,0x201C,0x201D,0x2022,0x2013,0x2014,0x02DC,0x2122,0x0161,0x203A,0x0153,0x017E,0x0178];
var P={tool:"view",color:COLORS[0].c,zoom:1};   // the person's choices, kept between PDFs
var S=null,D=null,drag=null;
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function icon(k){return (C.icons&&C.icons[k])||"";}
function rnd(v){return Math.round(v*100)/100;}
function hex(h){return [parseInt(h.substr(1,2),16)/255,parseInt(h.substr(3,2),16)/255,parseInt(h.substr(5,2),16)/255];}
function isHl(m){return m.t==="hl";}
function notHl(m){return m.t!=="hl";}
function cleanLine(s){
  var out="";
  for(var i=0;i<s.length;i++){
    var c=s.charCodeAt(i);
    if(c===9)out+="    ";
    else if((c>=32&&c<=126)||(c>=160&&c<=255)||WINANSI.indexOf(c)>=0)out+=s.charAt(i);
    else if(c>=32)out+="?";
  }
  return out;
}

// ---- libraries, loaded the first time a PDF is opened ----
var libs={};
function lib(key,glob){
  if(libs[key])return libs[key];
  libs[key]=new Promise(function(res,rej){
    if(window[glob])return res(window[glob]);
    if(!C.libs||!C.libs[key])return rej(new Error("off"));
    var s=document.createElement("script");
    s.src=C.base+"&mode=lib&n="+key;s.async=true;
    s.onload=function(){if(window[glob])res(window[glob]);else rej(new Error("missing"));};
    s.onerror=function(){rej(new Error("missing"));};
    document.head.appendChild(s);
  });
  return libs[key];
}
function pdfjs(){
  if(!C.libs||!C.libs.pdfworker)return Promise.reject(new Error("off"));
  return lib("pdfjs","pdfjsLib").then(function(L){
    if(!L.GlobalWorkerOptions.workerSrc)L.GlobalWorkerOptions.workerSrc=C.base+"&mode=lib&n=pdfworker";
    return L;
  });
}
function pdflib(){return lib("pdflib","PDFLib");}

// ---- the dialog ----
function tool(k,label,ic,title){return '<button type="button" class="nb-tool" data-tool="'+k+'" aria-pressed="false" aria-label="'+label+'" title="'+title+'">'+icon(ic)+'<span>'+label+'</span></button>';}
function btn(a,label,ic,title){return '<button type="button" class="nb-tool" data-a="'+a+'" aria-label="'+title+'" title="'+title+'">'+icon(ic)+(label?'<span>'+label+'</span>':'')+'</button>';}
function build(){
  if(D)return D;
  var d=document.createElement("dialog");
  d.className="nb-pdfdlg";d.setAttribute("aria-labelledby","nbPdfTitle");
  var sw="";
  COLORS.forEach(function(o){sw+='<button type="button" class="nb-swatch" data-color="'+o.c+'" style="background:'+o.c+'" aria-pressed="false" aria-label="'+o.n+'" title="'+o.n+' (pen and text)"></button>';});
  d.innerHTML='<div class="nb-pdfhead">'
    +'<div class="nb-pdftitles"><div class="nb-overline" data-r="over"></div><div class="nb-pdftitle" id="nbPdfTitle" data-r="title"></div><div class="nb-pdfsub" data-r="sub"></div></div>'
    +'<div class="nb-pdffields" data-r="fields" hidden>'
    +'<div class="nb-fieldbox" data-r="ordbox"><label class="nb-fl" for="nbPdfOrder">Order #</label><input class="nb-bare" id="nbPdfOrder" data-r="order" autocomplete="off" spellcheck="false" maxlength="40" placeholder="Order #"></div>'
    +'<div class="nb-fieldbox" data-r="unitbox"><label class="nb-fl" for="nbPdfUnit">Unit #</label><input class="nb-bare" id="nbPdfUnit" data-r="unit" autocomplete="off" spellcheck="false" maxlength="20" placeholder="Optional"></div>'
    +'</div>'
    +'<div class="nb-pdfnav" data-r="nav" hidden>'+btn("prev","","prev","Previous file")+'<span data-r="pos"></span>'+btn("next","","next","Next file")+'</div>'
    +'<div class="nb-pdfacts"><button type="button" class="nb-btn nb-btn--secondary" data-a="cancel" data-r="cancel">Cancel</button>'
    +'<button type="button" class="nb-btn nb-btn--primary" data-a="ok" data-r="ok">Done</button></div>'
    +'</div>'
    +'<div class="nb-pdftools" role="toolbar" aria-label="Notes" data-r="tools">'
    +'<div class="nb-toolgrp">'+tool("view","Select","pointer","Scroll and read. Drag a note to move it; double-click a typed note to change it.")+tool("pen","Pen","pen","Draw on the page")
    +tool("hl","Highlight","hl","Drag across what to highlight")+tool("text","Text","text","Click where the note goes and type. Enter finishes, Shift+Enter starts a new line.")
    +tool("erase","Erase","erase","Click or drag over a note to remove it")+'</div>'
    +'<div class="nb-toolgrp" role="group" aria-label="Note color">'+sw+'</div>'
    +'<div class="nb-toolgrp">'+btn("undo","Undo","undo","Undo (Ctrl+Z)")+btn("clear","Clear notes","trash","Remove every note on this PDF")+'</div>'
    +'<div class="nb-toolgrp nb-toolgrp--end">'+btn("zout","","minus","Zoom out")+'<span class="nb-zoomval" data-r="zoom">100%</span>'+btn("zin","","plus","Zoom in")+'</div>'
    +'</div>'
    +'<div class="nb-pdfmsg" role="status" data-r="msg"></div>'
    +'<div class="nb-pdfscroll" data-r="scroll"><div class="nb-pdfpages" data-r="pages" data-tool="view"></div></div>';
  document.body.appendChild(d);
  D={dlg:d};
  Array.prototype.forEach.call(d.querySelectorAll("[data-r]"),function(el){D[el.getAttribute("data-r")]=el;});
  wire();
  return D;
}
function msg(t,bad){D.msg.textContent=t||"";D.msg.className="nb-pdfmsg"+(bad?" is-error":"");}
function markButtons(){
  Array.prototype.forEach.call(D.tools.querySelectorAll("[data-tool]"),function(b){b.setAttribute("aria-pressed",b.getAttribute("data-tool")===P.tool?"true":"false");});
  Array.prototype.forEach.call(D.tools.querySelectorAll("[data-color]"),function(b){b.setAttribute("aria-pressed",b.getAttribute("data-color")===P.color?"true":"false");});
  D.pages.setAttribute("data-tool",S&&S.canMark?P.tool:"view");
  var can=!!(S&&S.canMark);
  Array.prototype.forEach.call(D.tools.querySelectorAll("[data-tool],[data-color]"),function(b){b.disabled=!can;});
  D.tools.querySelector('[data-a="undo"]').disabled=!can||!S.hist.length;
  D.tools.querySelector('[data-a="clear"]').disabled=!can||!S.marks.length;
  var zoomable=!!(S&&S.doc);
  D.tools.querySelector('[data-a="zout"]').disabled=!zoomable||P.zoom<=ZOOMS[0];
  D.tools.querySelector('[data-a="zin"]').disabled=!zoomable||P.zoom>=ZOOMS[ZOOMS.length-1];
  D.zoom.textContent=Math.round(P.zoom*100)+"%";
}
function setTool(k){if(S&&S.edit)commitText();P.tool=k;markButtons();}
function setColor(c){P.color=c;if(S&&S.edit)S.edit.ta.style.color=c;markButtons();}

// ---- open / close ----
function open(o){
  build();
  if(S&&S.resolve)return Promise.reject(new Error("The PDF viewer is already open."));
  S={opts:o,marks:(o.marks||[]).slice(),hist:[],pages:[],doc:null,url:"",tok:0,edit:null,canMark:false,dirty:false,busy:false,resolve:null};
  var st=S;
  var done=new Promise(function(res){st.resolve=res;});
  D.over.textContent=o.overline||"";
  D.title.textContent=o.title||"";
  D.title.title=o.title||"";
  D.sub.textContent=o.sub||"";
  D.fields.hidden=!o.fields;
  if(o.fields){
    D.order.value=o.fields.order||"";D.unit.value=o.fields.unit||"";
    D.unitbox.hidden=!o.fields.units;checkOrder();
  }
  D.nav.hidden=!o.nav;
  if(o.nav){
    D.pos.textContent=o.nav.pos+" of "+o.nav.count;
    D.nav.querySelector('[data-a="prev"]').disabled=!o.nav.prev;
    D.nav.querySelector('[data-a="next"]').disabled=!o.nav.next;
  }
  D.ok.textContent=o.okLabel||"Done";D.ok.disabled=false;
  D.cancel.hidden=!o.cancelLabel;D.cancel.textContent=o.cancelLabel||"Cancel";
  msg("");
  D.scroll.classList.remove("is-native");
  D.pages.innerHTML='<div class="nb-pdfloading">Opening the PDF...</div>';
  markButtons();
  if(!D.dlg.open){if(D.dlg.showModal)D.dlg.showModal();else D.dlg.setAttribute("open","");}
  if(o.fields&&!o.fields.order)setTimeout(function(){if(S===st)D.order.focus();},0);
  o.file.arrayBuffer().then(function(buf){
    return pdfjs().then(function(L){
      return L.getDocument({data:new Uint8Array(buf),isEvalSupported:false,enableXfa:false}).promise;
    });
  }).then(function(doc){
    if(S!==st){doc.destroy();return;}
    st.doc=doc;
    st.canMark=!!(C.libs&&C.libs.pdflib);
    if(doc.numPages>MAX_PAGES)msg("Only the first "+MAX_PAGES+" of "+doc.numPages+" pages are shown. Notes can be added to those pages.");
    markButtons();
    if(st.canMark)pdflib().catch(function(){
      if(S!==st)return;
      st.canMark=false;markButtons();
      msg("Notes cannot be added right now. Please tell IT or Accounting.");
    });
    else msg("Notes cannot be added right now. Please tell IT or Accounting.");
    return renderAll();
  }).catch(function(e){
    if(S!==st)return;
    var why=String(e&&e.message||"");
    native(why==="off"||why==="missing"||/worker/i.test(why)
      ? "The note tools are not available right now, so the PDF is shown as it is. Please tell IT or Accounting."
      : "This PDF cannot be opened in the note tools (it may be protected or damaged), so it is shown as it is.");
  });
  return done;
}
/** Shows the PDF in the browser's own viewer (no notes). */
function native(why){
  S.canMark=false;S.doc=null;
  try{S.url=URL.createObjectURL(S.opts.file);}catch(e){S.url="";}
  D.scroll.classList.add("is-native");
  D.pages.innerHTML=S.url?'<iframe class="nb-pdfnative" title="PDF" src="'+esc(S.url)+'"></iframe>':"";
  msg(why+(S.marks.length?" Notes added earlier stay with the file.":""));
  markButtons();
}
function checkOrder(){
  var f=S&&S.opts.fields;if(!f)return;
  var bad=!!f.okOrder&&!f.okOrder(D.order.value);
  if(bad)D.ordbox.setAttribute("data-bad","1");else D.ordbox.removeAttribute("data-bad");
}
function finish(action){
  if(!S||S.busy)return;
  if(S.edit)commitText();
  var o=S.opts,st=S;
  if(action==="cancel"&&!o.keepOnCancel&&S.marks.length&&!window.confirm("Close without your notes? Nothing is attached."))return;
  var out={action:action,marks:S.marks.slice()};
  if(o.fields){out.order=D.order.value;out.unit=D.unit.value;}
  if(action==="ok"&&o.bake){
    st.busy=true;D.ok.disabled=true;
    if(st.marks.length)msg("Adding your notes to the PDF...");
    (st.marks.length?bake(o.file,st.marks):Promise.resolve(o.file)).then(function(blob){
      st.busy=false;out.file=blob;close(out);
    }).catch(function(e){
      st.busy=false;D.ok.disabled=false;msg(e.message,true);
    });
    return;
  }
  close(out);
}
function close(out){
  var st=S;if(!st)return;
  drag=null;
  if(st.doc)try{st.doc.destroy();}catch(e){}
  if(st.url)try{URL.revokeObjectURL(st.url);}catch(e){}
  S=null;
  D.pages.innerHTML="";
  var nav=out.action==="prev"||out.action==="next";
  // Moving to another file keeps the dialog up; if nothing opens next, close it.
  if(!nav&&D.dlg.open)D.dlg.close();
  st.resolve(out);
  if(nav)setTimeout(function(){if(!S&&D.dlg.open)D.dlg.close();},0);
}

// ---- pages ----
function renderAll(){
  var st=S;if(!st||!st.doc)return Promise.resolve();
  if(st.edit)commitText();
  var tok=++st.tok,doc=st.doc,n=Math.min(doc.numPages,MAX_PAGES);
  var where=D.scroll.scrollHeight>D.scroll.clientHeight?D.scroll.scrollTop/D.scroll.scrollHeight:0;
  return doc.getPage(1).then(function(p1){
    if(S!==st||tok!==st.tok)return;
    // 100% = the page fits the width (leaving room for a scrollbar), but never bigger than 1.5x
    // (a Letter page about 920px wide), so a whole invoice line is readable without scrolling.
    var w1=p1.getViewport({scale:1}).width;
    var avail=Math.max(240,D.scroll.clientWidth-48-18);
    var scale=Math.min(avail/w1,1.5)*P.zoom;
    D.pages.innerHTML="";st.pages=[];
    markButtons();
    var chain=Promise.resolve();
    for(var i=1;i<=n;i++)(function(i){
      chain=chain.then(function(){
        if(S!==st||tok!==st.tok)return;
        return doc.getPage(i).then(function(pg){
          if(S!==st||tok!==st.tok)return;
          var vp=pg.getViewport({scale:scale}),dpr=window.devicePixelRatio||1;
          var w=document.createElement("div");
          w.className="nb-pdfpage";w.style.width=vp.width+"px";w.style.height=vp.height+"px";
          w.setAttribute("data-page",String(i-1));w.setAttribute("role","img");w.setAttribute("aria-label","Page "+i+" of "+doc.numPages);
          var cv=document.createElement("canvas"),ov=document.createElement("canvas");
          ov.className="nb-pdfov";
          [cv,ov].forEach(function(c){c.width=Math.floor(vp.width*dpr);c.height=Math.floor(vp.height*dpr);c.style.width=vp.width+"px";c.style.height=vp.height+"px";});
          w.appendChild(cv);w.appendChild(ov);D.pages.appendChild(w);
          var pp={i:i-1,vp:vp,wrap:w,ov:ov,dpr:dpr};
          st.pages.push(pp);
          drawMarks(pp);
          return pg.render({canvasContext:cv.getContext("2d"),viewport:vp,transform:dpr!==1?[dpr,0,0,dpr,0,0]:null}).promise;
        });
      });
    })(i);
    return chain.then(function(){if(S===st&&tok===st.tok&&where)D.scroll.scrollTop=where*D.scroll.scrollHeight;});
  });
}
function pageOf(el){
  if(!S)return null;
  for(var i=0;i<S.pages.length;i++)if(S.pages[i].ov===el)return S.pages[i];
  return null;
}
function V(pp,pt){return pp.vp.convertToViewportPoint(pt[0],pt[1]);}
function Q(pp,x,y){var r=pp.vp.convertToPdfPoint(x,y);return [rnd(r[0]),rnd(r[1])];}
function drawOne(c,pp,m){
  var s=pp.vp.scale;
  c.save();
  if(m.t==="hl"){
    var a=V(pp,m.a),b=V(pp,m.b);
    c.globalAlpha=HL_ALPHA;c.fillStyle=m.c;
    c.fillRect(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(a[0]-b[0]),Math.abs(a[1]-b[1]));
  }else if(m.t==="pen"){
    c.strokeStyle=m.c;c.lineWidth=m.w*s;c.lineCap="round";c.lineJoin="round";c.beginPath();
    m.pts.forEach(function(pt,k){var v=V(pp,pt);if(k)c.lineTo(v[0],v[1]);else c.moveTo(v[0],v[1]);});
    if(m.pts.length===1){var v0=V(pp,m.pts[0]);c.lineTo(v0[0]+0.01,v0[1]);}
    c.stroke();
  }else if(m.t==="text"){
    c.fillStyle=m.c;c.font=(m.s*s)+"px Helvetica, Arial, sans-serif";c.textBaseline="alphabetic";
    m.lines.forEach(function(l){var v=V(pp,[l.x,l.y]);c.fillText(l.s,v[0],v[1]);});
  }
  c.restore();
}
function drawMarks(pp,extra){
  var c=pp.ov.getContext("2d");
  c.setTransform(pp.dpr,0,0,pp.dpr,0,0);
  c.clearRect(0,0,pp.vp.width,pp.vp.height);
  var list=S.marks.filter(function(m){return m.p===pp.i;});
  if(extra&&extra.p===pp.i)list=list.concat([extra]);
  // Highlights go under the pen and text, here and in the saved PDF.
  list.filter(isHl).concat(list.filter(notHl)).forEach(function(m){drawOne(c,pp,m);});
}
function redrawAll(){if(S)S.pages.forEach(function(pp){drawMarks(pp);});}
function changed(){if(S){S.dirty=true;markButtons();}}
function remember(){S.hist.push(S.marks.slice());if(S.hist.length>200)S.hist.shift();}
function segDist(px,py,a,b){
  var dx=b[0]-a[0],dy=b[1]-a[1],l=dx*dx+dy*dy,t=l?((px-a[0])*dx+(py-a[1])*dy)/l:0;
  t=Math.max(0,Math.min(1,t));
  var x=a[0]+t*dx-px,y=a[1]+t*dy-py;return Math.sqrt(x*x+y*y);
}
function hit(pp,m,x,y){
  var s=pp.vp.scale,tol=6;
  if(m.t==="hl"){
    var a=V(pp,m.a),b=V(pp,m.b);
    return x>=Math.min(a[0],b[0])-tol&&x<=Math.max(a[0],b[0])+tol&&y>=Math.min(a[1],b[1])-tol&&y<=Math.max(a[1],b[1])+tol;
  }
  if(m.t==="pen"){
    var r=m.w*s/2+tol,v=m.pts.map(function(pt){return V(pp,pt);});
    if(v.length===1)return segDist(x,y,v[0],v[0])<=r;
    for(var k=1;k<v.length;k++)if(segDist(x,y,v[k-1],v[k])<=r)return true;
    return false;
  }
  if(m.t==="text"){
    var c=pp.ov.getContext("2d"),fs=m.s*s;
    c.save();c.font=fs+"px Helvetica, Arial, sans-serif";
    var on=m.lines.some(function(l){
      var o=V(pp,[l.x,l.y]),w=c.measureText(l.s).width;
      return x>=o[0]-tol&&x<=o[0]+w+tol&&y>=o[1]-fs*0.8-tol&&y<=o[1]+fs*0.25+tol;
    });
    c.restore();return on;
  }
  return false;
}
/** Index of the top-most note under (x,y) on this page, or -1. Pen and text are drawn over highlights. */
function topHit(pp,x,y){
  var order=S.marks.map(function(m,i){return i;}).filter(function(i){return S.marks[i].p===pp.i;});
  order=order.filter(function(i){return notHl(S.marks[i]);}).reverse().concat(order.filter(function(i){return isHl(S.marks[i]);}).reverse());
  for(var k=0;k<order.length;k++)if(hit(pp,S.marks[order[k]],x,y))return order[k];
  return -1;
}
function eraseAt(pp,x,y){
  var i=topHit(pp,x,y);
  if(i<0)return false;
  S.marks.splice(i,1);drawMarks(pp);return true;
}
/** A copy of a note moved by (dx,dy) in page units. */
function shifted(m,dx,dy){
  var c=JSON.parse(JSON.stringify(m));
  if(c.t==="pen")c.pts=c.pts.map(function(p){return [rnd(p[0]+dx),rnd(p[1]+dy)];});
  else if(c.t==="hl"){c.a=[rnd(c.a[0]+dx),rnd(c.a[1]+dy)];c.b=[rnd(c.b[0]+dx),rnd(c.b[1]+dy)];}
  else if(c.t==="text")c.lines.forEach(function(l){l.x=rnd(l.x+dx);l.y=rnd(l.y+dy);});
  return c;
}
/** Double-click on a typed note: open it again for typing, where it is. Esc puts it back as it was. */
function editTextAt(pp,x,y){
  var i=topHit(pp,x,y);
  if(i<0||S.marks[i].t!=="text")return;
  var m=S.marks[i],fs=m.s*pp.vp.scale,v=V(pp,[m.lines[0].x,m.lines[0].y]);
  remember();
  S.marks.splice(i,1);drawMarks(pp);
  startText(pp,v[0],v[1]-BL*fs,{value:m.lines.map(function(l){return l.s;}).join(NL),color:m.c,orig:m,idx:i});
}
function pointAt(pp,e){var r=pp.ov.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}

// ---- typed notes ----
function startText(pp,x,y,again){
  if(S.edit)commitText();
  var fs=TEXT_PT*pp.vp.scale;
  var ta=document.createElement("textarea");
  ta.className="nb-pdftext";ta.rows=1;ta.setAttribute("aria-label","Note text");ta.spellcheck=true;
  ta.style.left=(x-1)+"px";ta.style.top=(y-1)+"px";ta.style.fontSize=fs+"px";ta.style.color=again?again.color:P.color;
  ta.style.height=Math.ceil(fs*LH+2)+"px";ta.style.width="140px";
  if(again)ta.value=again.value;
  pp.wrap.appendChild(ta);
  var ed={pp:pp,x:x,y:y,ta:ta,again:again||null};
  S.edit=ed;
  function grow(){ta.style.height="0px";ta.style.height=(ta.scrollHeight+2)+"px";ta.style.width="0px";ta.style.width=Math.max(140,ta.scrollWidth+fs)+"px";}
  ta.addEventListener("input",grow);
  ta.addEventListener("keydown",function(e){
    if(e.key==="Escape"){e.preventDefault();e.stopPropagation();S.textEsc=Date.now();cancelText();}
    else if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();commitText();}
  });
  ta.addEventListener("blur",function(){setTimeout(function(){if(S&&S.edit===ed)commitText();},0);});
  // Focus now, inside the click, so the first keys typed land in the note.
  ta.focus({preventScroll:true});
  if(again)grow();
}
function cancelText(){
  var e=S&&S.edit;if(!e)return;S.edit=null;
  if(e.ta.parentNode)e.ta.parentNode.removeChild(e.ta);
  // Changing a note and pressing Esc: put it back as it was.
  if(e.again){S.hist.pop();S.marks.splice(e.again.idx,0,e.again.orig);drawMarks(e.pp);markButtons();}
}
function commitText(){
  var e=S&&S.edit;if(!e)return;S.edit=null;
  var color=e.again?e.again.color:P.color,raw=e.ta.value;
  if(e.ta.parentNode)e.ta.parentNode.removeChild(e.ta);
  var lines=raw.split(NL).map(cleanLine);
  while(lines.length&&!lines[lines.length-1].trim())lines.pop();
  if(!lines.join("").trim()){if(e.again)changed();return;}
  var pp=e.pp,fs=TEXT_PT*pp.vp.scale;
  var a=pp.vp.convertToPdfPoint(e.x,e.y),b=pp.vp.convertToPdfPoint(e.x+100,e.y);
  var m={t:"text",p:pp.i,c:color,s:TEXT_PT,ang:Math.round(Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI),
    lines:lines.map(function(l,k){var q=Q(pp,e.x,e.y+(BL+k*LH)*fs);return {x:q[0],y:q[1],s:l};})};
  // A changed note keeps its place in the stack (its undo step was taken when it was opened).
  if(e.again)S.marks.splice(e.again.idx,0,m);else{remember();S.marks.push(m);}
  drawMarks(pp);changed();
}

// ---- writing the notes into the PDF ----
function bake(file,marks){
  function fail(t){var e=new Error(t);e.nb=1;return e;}
  return pdflib().catch(function(){throw fail("Notes cannot be added right now. Please tell IT or Accounting.");}).then(function(L){
    return file.arrayBuffer().then(function(buf){
      return L.PDFDocument.load(buf,{updateMetadata:false}).catch(function(e){
        throw fail(/encrypt/i.test(String(e&&e.message))
          ? "This PDF is protected, so notes cannot be added to it. Clear the notes to send it as it is."
          : "Notes cannot be added to this PDF. Clear the notes to send it as it is.");
      });
    }).then(function(doc){
      var needFont=marks.some(function(m){return m.t==="text";});
      return (needFont?doc.embedFont(L.StandardFonts.Helvetica):Promise.resolve(null)).then(function(font){
        var pages=doc.getPages();
        marks.filter(isHl).concat(marks.filter(notHl)).forEach(function(m){
          var pg=pages[m.p];if(!pg)return;
          var c=hex(m.c),col=L.rgb(c[0],c[1],c[2]);
          if(m.t==="hl"){
            pg.drawRectangle({x:Math.min(m.a[0],m.b[0]),y:Math.min(m.a[1],m.b[1]),width:Math.abs(m.a[0]-m.b[0]),height:Math.abs(m.a[1]-m.b[1]),color:col,opacity:HL_ALPHA,borderWidth:0});
          }else if(m.t==="pen"){
            var ops=[L.pushGraphicsState(),L.setStrokingRgbColor(c[0],c[1],c[2]),L.setLineWidth(m.w),
              L.setLineCap(L.LineCapStyle.Round),L.setLineJoin(L.LineJoinStyle.Round),L.moveTo(m.pts[0][0],m.pts[0][1])];
            if(m.pts.length===1)ops.push(L.lineTo(m.pts[0][0]+0.01,m.pts[0][1]));
            for(var k=1;k<m.pts.length;k++)ops.push(L.lineTo(m.pts[k][0],m.pts[k][1]));
            ops.push(L.stroke(),L.popGraphicsState());
            pg.pushOperators.apply(pg,ops);
          }else if(m.t==="text"){
            m.lines.forEach(function(l){if(l.s)pg.drawText(l.s,{x:l.x,y:l.y,size:m.s,font:font,color:col,rotate:L.degrees(m.ang)});});
          }
        });
        return doc.save({useObjectStreams:false});
      });
    }).then(function(bytes){return new Blob([bytes],{type:"application/pdf"});});
  }).catch(function(e){
    if(e&&e.nb)throw e;
    throw fail("We could not add the notes to this PDF. Clear the notes to send it as it is.");
  });
}

// ---- events ----
function wire(){
  D.dlg.addEventListener("click",function(e){
    var b=e.target&&e.target.closest?e.target.closest("button"):null;
    if(!b||b.disabled||!S)return;
    var a=b.getAttribute("data-a");
    if(b.hasAttribute("data-tool"))setTool(b.getAttribute("data-tool"));
    else if(b.hasAttribute("data-color"))setColor(b.getAttribute("data-color"));
    else if(a==="ok"||a==="cancel"||a==="prev"||a==="next")finish(a);
    else if(a==="undo")undo();
    else if(a==="clear"){
      if(S.edit)cancelText();
      if(!S.marks.length||!window.confirm("Remove every note on this PDF?"))return;
      remember();S.marks=[];redrawAll();changed();
    }
    else if(a==="zin"||a==="zout"){
      var i=ZOOMS.indexOf(P.zoom);if(i<0)i=2;
      i=Math.max(0,Math.min(ZOOMS.length-1,i+(a==="zin"?1:-1)));
      P.zoom=ZOOMS[i];renderAll();
    }
  });
  D.dlg.addEventListener("cancel",function(e){
    e.preventDefault();
    if(!S)return;
    if(S.edit){cancelText();return;}
    if(S.textEsc&&Date.now()-S.textEsc<400)return;
    finish(S.opts.cancelLabel?"cancel":"ok");
  });
  // The browser can close the dialog itself (a second Esc). Treat that as Cancel, without asking.
  D.dlg.addEventListener("close",function(){
    // (When this script closes it, S is already cleared, or a next PDF has reopened the dialog.)
    if(!S||D.dlg.open)return;
    if(S.edit)cancelText();
    var o=S.opts,out={action:o.cancelLabel?"cancel":"ok",marks:S.marks.slice()};
    if(o.fields){out.order=D.order.value;out.unit=D.unit.value;}
    close(out);
  });
  // On the document, not the dialog: after a typed note closes, focus is back on the page body.
  document.addEventListener("keydown",function(e){
    if(!S||!D.dlg.open)return;
    var t=e.target,typing=t&&(t.tagName==="INPUT"||t.tagName==="TEXTAREA");
    if((e.ctrlKey||e.metaKey)&&!e.shiftKey&&(e.key==="z"||e.key==="Z")&&!typing&&S.canMark){e.preventDefault();undo();}
  });
  D.order.addEventListener("input",checkOrder);
  D.pages.addEventListener("pointerdown",function(e){
    var t=e.target;
    if(!S||!S.canMark||e.button!==0||!t.classList||!t.classList.contains("nb-pdfov"))return;
    var pp=pageOf(t);if(!pp)return;
    var xy=pointAt(pp,e),x=xy[0],y=xy[1];
    if(P.tool==="view"){
      // Select: drag a note to move it. Anywhere else the page scrolls as usual.
      if(S.edit)commitText();
      var hi=topHit(pp,x,y);
      if(hi<0)return;
      e.preventDefault();
      if(t.setPointerCapture)try{t.setPointerCapture(e.pointerId);}catch(er){}
      drag={pp:pp,move:true,idx:hi,x0:x,y0:y,orig:S.marks[hi],before:S.marks.slice()};
      return;
    }
    e.preventDefault();
    if(P.tool==="text"){startText(pp,x,y);return;}
    if(S.edit)commitText();
    if(t.setPointerCapture)try{t.setPointerCapture(e.pointerId);}catch(er){}
    if(P.tool==="pen")drag={pp:pp,m:{t:"pen",p:pp.i,c:P.color,w:PEN_W,pts:[Q(pp,x,y)]}};
    else if(P.tool==="hl")drag={pp:pp,x0:x,y0:y,m:{t:"hl",p:pp.i,c:HL,a:Q(pp,x,y),b:Q(pp,x,y)}};
    else if(P.tool==="erase"){drag={pp:pp,erase:true,before:S.marks.slice()};eraseAt(pp,x,y);}
    if(drag&&drag.m)drawMarks(pp,drag.m);
  });
  D.pages.addEventListener("pointermove",function(e){
    if(!S)return;
    if(!drag){
      // Select: show a move cursor over a note.
      var t=e.target;
      if(P.tool==="view"&&S.canMark&&t.classList&&t.classList.contains("nb-pdfov")){
        var hp=pageOf(t);
        if(hp){var hxy=pointAt(hp,e);t.style.cursor=topHit(hp,hxy[0],hxy[1])>=0?"move":"";}
      }
      return;
    }
    var pp=drag.pp,xy=pointAt(pp,e),x=xy[0],y=xy[1];
    if(drag.move){
      var a=pp.vp.convertToPdfPoint(drag.x0,drag.y0),b=pp.vp.convertToPdfPoint(x,y);
      S.marks[drag.idx]=shifted(drag.orig,b[0]-a[0],b[1]-a[1]);
      drag.moved=drag.moved||Math.abs(x-drag.x0)+Math.abs(y-drag.y0)>2;
      drawMarks(pp);
      return;
    }
    if(drag.m&&drag.m.t==="pen"){
      var q=Q(pp,x,y),last=drag.m.pts[drag.m.pts.length-1];
      if(Math.abs(q[0]-last[0])+Math.abs(q[1]-last[1])>=0.5){drag.m.pts.push(q);drawMarks(pp,drag.m);}
    }else if(drag.m&&drag.m.t==="hl"){
      drag.x1=x;drag.y1=y;drag.m.b=Q(pp,x,y);drawMarks(pp,drag.m);
    }else if(drag.erase)eraseAt(pp,x,y);
  });
  function end(){
    if(!drag||!S){drag=null;return;}
    var d=drag;drag=null;
    if(d.move){
      if(d.moved){S.hist.push(d.before);changed();}
      else{S.marks[d.idx]=d.orig;drawMarks(d.pp);}
      return;
    }
    if(d.m){
      var keep=d.m.t==="pen"||(d.x1!==undefined&&Math.abs(d.x1-d.x0)>=4&&Math.abs(d.y1-d.y0)>=4);
      if(keep){remember();S.marks.push(d.m);changed();}
      drawMarks(d.pp);
    }else if(d.erase&&S.marks.length!==d.before.length){
      S.hist.push(d.before);changed();
    }
  }
  D.pages.addEventListener("pointerup",end);
  D.pages.addEventListener("dblclick",function(e){
    var t=e.target;
    if(!S||!S.canMark||P.tool!=="view"||!t.classList||!t.classList.contains("nb-pdfov"))return;
    var pp=pageOf(t);if(!pp)return;
    var xy=pointAt(pp,e);
    e.preventDefault();
    editTextAt(pp,xy[0],xy[1]);
  });
  D.pages.addEventListener("pointercancel",end);
}
function undo(){
  if(!S)return;
  if(S.edit){cancelText();return;}
  if(!S.hist.length)return;
  S.marks=S.hist.pop();redrawAll();changed();
}

window.NbPdf={open:open,bake:bake};
})();
`;

    // Lucide "settings" icon: 1.75 stroke, no fill, currentColor.
    var ICON_SETTINGS = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>'
        + '<circle cx="12" cy="12" r="3"/></svg>';

    function brandHeader() {
        return '<div class="nb-topbar"></div>'
             + '<header class="nb-header"><div class="nb-wrap">'
             + '<img class="nb-logo nb-logo--dark" src="' + LOGO_DARK + '" alt="Nussbaum Transportation">'
             + '<img class="nb-logo nb-logo--light" src="' + LOGO_LIGHT + '" alt="Nussbaum Transportation">'
             + '<div class="nb-title">Vendor invoice lookup</div>'
             + '<div class="nb-settings">'
             + '<button id="nbSettingsBtn" class="nb-iconbtn" type="button" aria-label="Settings" '
             + 'aria-haspopup="true" aria-expanded="false" aria-controls="nbSettingsPanel">' + ICON_SETTINGS + '</button>'
             + '<div id="nbSettingsPanel" class="nb-popover" role="dialog" aria-label="Settings" hidden>'
             + '<div class="nb-label">Appearance</div>'
             + '<div class="nb-seg" role="group" aria-label="Appearance">'
             + '<button type="button" data-theme="light" aria-pressed="false">Light</button>'
             + '<button type="button" data-theme="dark" aria-pressed="true">Dark</button>'
             + '</div>' + accessSummaryHtml() + '</div></div>'
             + '</div></header>';
    }

    // Tabs appear only for people who may upload; everyone else sees the plain search page.
    var PENDING_COUNT = null;

    function pendingCount() {
        if (PENDING_COUNT !== null) return PENDING_COUNT;
        PENDING_COUNT = 0;
        try {
            // Someone with limited access counts only the waiting PDFs they can see.
            if (scoped()) {
                PENDING_COUNT = filterDocs(docRows('PENDING', MAX_QUEUE, false)).length;
                return PENDING_COUNT;
            }
            var rows = query.runSuiteQL({
                query: 'SELECT COUNT(*) AS n FROM file WHERE description LIKE ?',
                params: [DOC_MARK + 'PENDING|%']
            }).asMappedResults();
            PENDING_COUNT = rows.length ? Number(rows[0].n) || 0 : 0;
        } catch (e) {
            log.error({ title: 'queue count failed', details: e.name + ': ' + e.message });
        }
        return PENDING_COUNT;
    }

    /** 12345 -> 12,345 */
    function commas(n) {
        return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** Switches to another group (a link led to a vendor or invoice of that group) and remembers it. */
    function followGroup(res, key) {
        if (!key || key === GROUP || allowedGroupKeys().indexOf(key) < 0) return;
        if (GROUP === ALL_GROUPS_KEY) return;   // "Both" already shows it
        log.audit({ title: 'vendor group followed', details: AUTH_USER + ' ' + GROUP + ' -> ' + key + ' (link to a record of that group)' });
        GROUP = key;
        MISSING_COUNT = null;
        setGroupCookie(res, key);
    }

    /** If this bill belongs to the other group, switch to it. Never blocks showing the bill. */
    function followBillGroup(res, billId) {
        try {
            var rows = query.runSuiteQL({
                query: 'SELECT v.category AS category FROM transaction t JOIN vendor v ON v.id = t.entity WHERE t.id = ?',
                params: [Number(billId)]
            }).asMappedResults();
            if (rows.length && rows[0].category) followGroup(res, groupKeyForCategory(rows[0].category));
        } catch (e) {
            log.debug({ title: 'bill group lookup skipped', details: e.name + ': ' + e.message });
        }
    }

    // ---------- access scope (FLD_SUBS / FLD_GROUPS) ----------

    /** A multi-select value from a search result ("3,5", [3,5] or text) as a list of trimmed strings. */
    function valueList(v) {
        if (v === null || v === undefined) return [];
        var list = Array.isArray(v) ? v : String(v).split(/[,\u0005]/);
        return list.map(function (x) { return String(x).trim(); }).filter(Boolean);
    }

    /** The scope stored on an employee search result. */
    function scopeFromRow(r) {
        var out = { subs: null, subNames: [], groupTokens: null };
        if (FLD_SUBS) {
            var ids = valueList(r.getValue(FLD_SUBS)).map(Number).filter(function (n) { return n > 0; });
            try { out.subNames = valueList(r.getText(FLD_SUBS)); } catch (e) { out.subNames = []; }
            out.subs = ids.length ? ids : (SCOPE_BLANK_MEANS_ALL ? null : []);
        }
        if (FLD_GROUPS) {
            var tokens = valueList(r.getValue(FLD_GROUPS));
            try { tokens = tokens.concat(valueList(r.getText(FLD_GROUPS))); } catch (e) { /* not a list field */ }
            out.groupTokens = tokens;
        }
        return out;
    }

    /** Subsidiary ids this person is limited to, or null for every subsidiary. */
    function scopeSubs() {
        return (REQUIRE_LOGIN && AUTH_SCOPE && AUTH_SCOPE.subs) ? AUTH_SCOPE.subs : null;
    }

    /** The group keys (VENDOR_GROUPS) this person may see, in VENDOR_GROUPS order. */
    function allowedGroupKeys() {
        if (ALLOWED_GROUPS !== null) return ALLOWED_GROUPS;
        var all = VENDOR_GROUPS.map(function (g) { return g.key; });
        var tokens = (REQUIRE_LOGIN && AUTH_SCOPE && FLD_GROUPS) ? AUTH_SCOPE.groupTokens : null;
        if (!tokens) { ALLOWED_GROUPS = all; return all; }
        if (!tokens.length) { ALLOWED_GROUPS = SCOPE_BLANK_MEANS_ALL ? all : []; return ALLOWED_GROUPS; }
        var up = tokens.map(function (t) { return t.toUpperCase(); });
        ALLOWED_GROUPS = VENDOR_GROUPS.filter(function (g) {
            if (up.indexOf(String(g.key).toUpperCase()) >= 0 || up.indexOf(String(g.label).toUpperCase()) >= 0
                    || up.indexOf(String(g.name).toUpperCase()) >= 0) return true;
            try { return up.indexOf(String(groupCategoryId(g.key))) >= 0; } catch (e) { return false; }
        }).map(function (g) { return g.key; });
        return ALLOWED_GROUPS;
    }

    function groupsLimited() { return allowedGroupKeys().length < VENDOR_GROUPS.length; }

    /** Is this person limited in any way? (Everyone else gets exactly the behaviour from before.) */
    function scoped() { return !!scopeSubs() || groupsLimited(); }

    /** True when the person's access covers nothing at all. */
    function scopeEmpty() {
        var s = scopeSubs();
        return (!!s && !s.length) || !allowedGroupKeys().length;
    }

    function qmarks(n) { var a = []; for (var i = 0; i < n; i++) a.push('?'); return a.join(', '); }

    /**
     * SuiteQL that keeps only vendor bills this person may see. billAlias is the transaction
     * alias; vendorAlias the joined vendor (for the group limit), or '' when the query already
     * limits the vendor category to the group in effect. Returns { sql, params }.
     */
    function scopeSql(billAlias, vendorAlias) {
        var sql = '', params = [];
        var subs = scopeSubs();
        if (subs) {
            if (!subs.length) return { sql: ' AND 1 = 0', params: [] };
            sql += ' AND EXISTS (SELECT 1 FROM transactionline stl WHERE stl.transaction = ' + billAlias + ".id AND stl.mainline = 'T'"
                 + ' AND stl.subsidiary IN (' + qmarks(subs.length) + '))';
            params = params.concat(subs);
        }
        if (vendorAlias && groupsLimited()) {
            var cats = allowedGroupKeys().map(groupCategoryId);
            if (!cats.length) return { sql: ' AND 1 = 0', params: [] };
            sql += ' AND ' + vendorAlias + '.category IN (' + qmarks(cats.length) + ')';
            params = params.concat(cats);
        }
        return { sql: sql, params: params };
    }

    /** Of these vendor bill ids, the ones this person may see: { id: true }. */
    function visibleBillIds(ids) {
        var out = {};
        ids = ids.map(Number).filter(function (n) { return n > 0; });
        if (!ids.length) return out;
        if (!scoped()) {
            ids.forEach(function (id) { out[id] = true; });
            return out;
        }
        var sc = scopeSql('t', 'v');
        query.runSuiteQL({
            query: 'SELECT t.id AS id FROM transaction t LEFT JOIN vendor v ON v.id = t.entity '
                 + "WHERE t.type = 'VendBill' AND t.id IN (" + qmarks(ids.length) + ')' + sc.sql,
            params: ids.concat(sc.params)
        }).asMappedResults().forEach(function (r) { out[Number(r.id)] = true; });
        return out;
    }

    function billVisible(id) {
        return /^\d+$/.test(String(id || '')) && !!visibleBillIds([Number(id)])[Number(id)];
    }

    /**
     * Vendor subsidiary limit for a query on the vendor table (alias a): the vendor's primary
     * subsidiary or any subsidiary it is shared with. Returns { sql, params }.
     */
    function vendorSubSql(a) {
        var subs = scopeSubs();
        if (!subs) return { sql: '', params: [] };
        if (!subs.length) return { sql: ' AND 1 = 0', params: [] };
        if (VENDOR_SUB_SIMPLE) return { sql: ' AND ' + a + '.subsidiary IN (' + qmarks(subs.length) + ')', params: subs.slice() };
        return {
            sql: ' AND (' + a + '.subsidiary IN (' + qmarks(subs.length) + ') OR EXISTS (SELECT 1 FROM vendorsubsidiaryrelationship vsr '
               + 'WHERE vsr.entity = ' + a + '.id AND vsr.subsidiary IN (' + qmarks(subs.length) + ')))',
            params: subs.concat(subs)
        };
    }

    /** Runs a vendor query built by fn(); if NetSuite refuses the vendor-subsidiary table, logs it and uses the primary subsidiary only. */
    function withVendorSubs(fn) {
        try {
            return fn();
        } catch (e) {
            if (VENDOR_SUB_SIMPLE || !scopeSubs()) throw e;
            log.error({ title: 'vendor subsidiary filter failed', details: e.name + ': ' + e.message });
            VENDOR_SUB_SIMPLE = true;
            return fn();
        }
    }

    /** Of these vendor ids, the ones inside this person's subsidiaries: { id: true }. */
    function visibleVendorIds(ids) {
        var out = {};
        ids = ids.map(Number).filter(function (n) { return n > 0; });
        if (!ids.length) return out;
        if (!scopeSubs()) { ids.forEach(function (id) { out[id] = true; }); return out; }
        withVendorSubs(function () {
            var vs = vendorSubSql('vnd');
            return query.runSuiteQL({
                query: 'SELECT vnd.id AS id FROM vendor vnd WHERE vnd.id IN (' + qmarks(ids.length) + ')' + vs.sql,
                params: ids.concat(vs.params)
            }).asMappedResults();
        }).forEach(function (r) { out[Number(r.id)] = true; });
        return out;
    }

    /**
     * Uploaded PDFs (rows with order, by, bill) this person may see: their own, ones attached
     * to an invoice they can see, and waiting ones whose order # matches an invoice they can see.
     */
    function filterDocs(rows) {
        if (!scoped()) return rows;
        var me = safeText(AUTH_USER);
        var others = rows.filter(function (r) { return r.by !== me; });
        var okBills = visibleBillIds(others.filter(function (r) { return r.bill; }).map(function (r) { return Number(r.bill); }));
        var seen = {}, orders = [];
        others.forEach(function (r) { if (!r.bill && r.order && !seen[r.order]) { seen[r.order] = 1; orders.push(r.order); } });
        var byOrder = billsByOrder(orders);
        return rows.filter(function (r) {
            if (r.by === me) return true;
            if (r.bill) return !!okBills[Number(r.bill)];
            return (byOrder[r.order] || []).length > 0;
        });
    }

    /** What the settings menu shows under "Your access". */
    function accessSummaryHtml() {
        if (!REQUIRE_LOGIN || !AUTH_USER || !AUTH_SCOPE) return '';
        var groups = allowedGroupKeys().map(function (k) { return groupDef(k).label; });
        var subs = scopeSubs();
        return '<div class="nb-label nb-accesshead">Your access</div>'
             + '<p class="nb-help nb-access">' + esc(groups.length ? groups.join(' and ') + ' invoices' : 'No invoices')
             + '<br>' + (subs ? (subs.length ? 'Subsidiaries: ' + esc((AUTH_SCOPE.subNames.length ? AUTH_SCOPE.subNames : subs).join(', ')) : 'No subsidiaries')
                              : 'All subsidiaries') + '</p>';
    }

    /**
     * The AP / TMT / Both choice. In the search row (inRow) it is a field box like From and To,
     * labelled "Invoices", with one small button per choice; elsewhere the same buttons sit in
     * the tab bar. Someone with a single group just sees which one it is.
     */
    function groupToggleHtml(inRow) {
        var choices = groupChoices();
        var body;
        if (choices.length === 1) {
            body = '<span class="nb-groupone" data-group="' + esc(choices[0]) + '">' + esc(groupLabel(choices[0])) + '</span>';
        } else {
            body = '<div class="nb-chips">' + choices.map(function (k) {
                var on = k === GROUP;
                var text = k === ALL_GROUPS_KEY ? (choices.length === 3 ? 'Both' : 'All') : groupLabel(k);
                return '<a class="nb-chip' + (on ? ' is-active' : '') + '" href="' + esc(GROUP_BASE + '&group=' + encodeURIComponent(k)) + '"'
                     + ' data-group="' + esc(k) + '"' + (on ? ' aria-current="true"' : '')
                     + ' title="Show ' + esc(groupLabel(k)) + ' invoices">' + esc(text) + '</a>';
            }).join('') + '</div>';
        }
        return inRow
            ? '<div class="nb-fieldbox nb-groupbox" data-groupsel="1" role="group" aria-labelledby="nbGroupLabel">'
              + '<span class="nb-fl" id="nbGroupLabel">Invoices</span>' + body + '</div>'
            : '<div class="nb-groupsel" data-groupsel="1" role="group" aria-labelledby="nbGroupLabel">'
              + '<span class="nb-groupsel__label" id="nbGroupLabel">Invoices</span>' + body + '</div>';
    }

    /** Shown when the lookup cannot find the vendor category for the group in effect. */
    function groupErrorPage(msg) {
        GROUP_UI = false;
        var others = VENDOR_GROUPS.filter(function (g) { return g.key !== GROUP && allowedGroupKeys().indexOf(g.key) >= 0; }).map(function (g) {
            return '<a class="nb-btn nb-btn--secondary" href="' + esc(self() + '&group=' + encodeURIComponent(g.key)) + '">Show ' + esc(g.label) + ' invoices</a>';
        }).join(' ');
        return page('<div class="nb-overline">Setup needed</div>'
                  + '<h1 class="nb-headline nb-h2">The ' + esc(groupLabel(GROUP)) + ' invoices cannot be shown right now.</h1>'
                  + '<p class="nb-lead">' + esc(msg) + '</p>'
                  + '<p class="nb-help">Please tell IT or Accounting.</p>'
                  + (others ? '<div class="nb-actions">' + others + '</div>' : ''));
    }

    function tabsHtml() {
        if (REQUIRE_LOGIN && !AUTH_USER) return '';
        if (!canUpload()) return '';

        var n = pendingCount();
        var mc = missingCount();
        function tab(key, label, href, extra) {
            return '<a class="nb-tab' + (TAB === key ? ' is-active' : '') + '" href="' + esc(href) + '"'
                 + (TAB === key ? ' aria-current="page"' : '') + '>' + label + (extra || '') + '</a>';
        }
        return '<nav class="nb-tabs" aria-label="Sections"><div class="nb-wrap">'
             + tab('search', 'Search', self())
             + tab('upload', 'Upload invoices', self() + '&tab=upload')
             + tab('queue', 'Missing Invoices', self() + '&tab=queue', n ? '<span class="nb-badge">' + n + '</span>' : '')
             + tab('missing', 'Missing documents', self() + '&tab=missing', mc ? '<span class="nb-badge">' + commas(mc) + '</span>' : '')
             + (GROUP_UI && !TOGGLE_IN_SEARCH ? groupToggleHtml() : '')
             + '</div></nav>';
    }

    function page(bodyHtml, extraScript) {
        return '<!DOCTYPE html><html lang="en" data-theme="dark"><head><meta charset="utf-8">'
             + '<meta name="viewport" content="width=device-width, initial-scale=1">'
             + '<title>Vendor Invoice Lookup | Nussbaum</title>'
             + '<link rel="icon" type="image/png" href="' + FAVICON + '">'
             + '<script>' + THEME_BOOT + '</script>'
             + '<style>' + fontCss() + NB_CSS + '</style></head><body>'
             + brandHeader()
             + (function () {
                   var tabs = tabsHtml();
                   // People without the tabs still get the toggle, in a row of its own, unless
                   // the page's search row already has it.
                   return tabs || (GROUP_UI && !TOGGLE_IN_SEARCH ? '<div class="nb-wrap nb-groupbar">' + groupToggleHtml() + '</div>' : '');
               })()
             + '<main class="nb-wrap nb-main">' + bodyHtml + '</main>'
             + (HAS_DROP ? '<input type="file" id="attachInput" accept="application/pdf,.pdf" multiple hidden>' : '')
             + '<script>' + THEME_JS + '</script>'
             + '<script>' + PAGER_JS + '</script>'
             + '<script>' + LOADING_JS + '</script>'
             + (HAS_UNIT ? '<script>var UNIT_BASE=' + JSON.stringify(self()) + ';var UNIT_ICONS=' + JSON.stringify({ edit: ICON_PENCIL, save: ICON_CHECK, cancel: ICON_X }) + ';' + UNITEDIT_JS + '</script>' : '')
             + (HAS_PDFVIEW || HAS_DROP ? '<script>' + pdfViewConfig() + PDFVIEW_JS + '</script>' : '')
             + (HAS_DROP ? '<script>var ATTACH_BASE=' + JSON.stringify(self()) + ';var ATTACH_MAXB=' + MAX_UPLOAD_BYTES + ';' + ATTACH_JS + '</script>' : '')
             + (extraScript ? '<script>' + extraScript + '</script>' : '')
             + '</body></html>';
    }

    function notFound() {
        return page('<div class="nb-overline">Not found</div>'
                  + '<h1 class="nb-headline nb-h2">We could not find that.</h1>'
                  + '<p class="nb-lead">That page or document is not available.</p>'
                  + '<a class="nb-btn nb-btn--secondary" href="' + esc(self()) + '">Search again</a>');
    }

    /** Client-side script for the search page. BASE is defined ahead of it. */
    var SEARCH_JS = `
var q=document.getElementById("vq"),s=document.getElementById("sugg"),df=document.getElementById("df"),dt=document.getElementById("dt");
var items=[],sel=-1,timer=null;
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function hide(){s.style.display="none";sel=-1;}
function dates(){
  var r="";
  if(df.value)r+="&from="+encodeURIComponent(df.value);
  if(dt.value)r+="&to="+encodeURIComponent(dt.value);
  return r;
}
function pick(it){
  if(!it)return;
  if(it.k==="w"){window.location=BASE+"&s="+encodeURIComponent(it.o)+dates();return;}
  window.location=BASE+(it.k==="b"?"&b="+encodeURIComponent(it.id):"&v="+encodeURIComponent(it.e)+dates());
}
function run(){
  var t=q.value.trim();
  if(!t&&!df.value&&!dt.value)return;
  window.location=BASE+"&s="+encodeURIComponent(t)+dates();
}
function draw(){
  if(!items.length){hide();return;}
  var html="",last="";
  items.forEach(function(it,i){
    var g=it.k==="b"?"Invoices":it.k==="w"?"PDFs waiting for an invoice":"Vendors";
    if(g!==last){html+='<div class="grp">'+g+'</div>';last=g;}
    var cls="row"+(i===sel?" sel":"");
    if(it.k==="w"){
      html+='<div class="'+cls+'" data-i="'+i+'"><span class="vid">'+esc(it.o)+'</span>'
        +(it.u?'<span class="vnm">Unit '+esc(it.u)+'</span>':'')
        +'<span class="vnm">PDF waiting - '+esc(it.n)+'</span></div>';
    }else if(it.k==="b"){
      html+='<div class="'+cls+'" data-i="'+i+'"><span class="vid">'+esc(it.t)+'</span>'
        +(it.r?'<span class="vnm">Inv '+esc(it.r)+'</span>':'')
        +(it.u?'<span class="vnm">Unit '+esc(it.u)+'</span>':'')
        +'<span class="vnm">'+esc(it.e)+(it.n?' - '+esc(it.n):'')+'</span></div>';
    }else{
      html+='<div class="'+cls+'" data-i="'+i+'"><span class="vid">'+esc(it.e)+'</span>'
        +'<span class="vnm">'+esc(it.n)+'</span></div>';
    }
  });
  s.innerHTML=html;
  s.style.display="block";
  Array.prototype.forEach.call(s.querySelectorAll(".row"),function(d){
    d.onclick=function(){pick(items[+d.getAttribute("data-i")]);};
  });
}
function fetchSugg(term){
  fetch(BASE+"&mode=suggest&q="+encodeURIComponent(term))
    .then(function(r){return r.json();})
    .then(function(d){
      if(q.value.trim()!==term)return;
      if(d&&d.error){console.log("suggest error",d.error);hide();return;}
      items=d||[];sel=-1;draw();
    })
    .catch(function(e){console.log("suggest failed",e);hide();});
}
function kick(){
  if(typeof SUGGEST!=="undefined"&&!SUGGEST)return;
  var t=q.value.trim();
  if(timer)clearTimeout(timer);
  if(t.length<2){items=[];hide();return;}
  timer=setTimeout(function(){fetchSugg(t);},180);
}
q.addEventListener("input",kick);
q.addEventListener("keydown",function(ev){
  if(ev.key==="ArrowDown"){sel=Math.min(sel+1,items.length-1);draw();ev.preventDefault();}
  else if(ev.key==="ArrowUp"){sel=Math.max(sel-1,0);draw();ev.preventDefault();}
  else if(ev.key==="Enter"){if(sel>=0&&items[sel])pick(items[sel]);else run();ev.preventDefault();}
  else if(ev.key==="Escape"){hide();}
});
document.getElementById("btn").onclick=run;
var cd=document.getElementById("cleardates");
if(cd)cd.onclick=function(){df.value="";dt.value="";if(q.value.trim())run();else window.location=BASE;};
document.addEventListener("click",function(ev){
  if(!s.contains(ev.target)&&ev.target!==q)hide();
});
// The AP / TMT toggle sits next to the search box. If the person typed a new search or changed
// the dates before switching, switch with what they typed rather than the page's last search.
document.addEventListener("click",function(ev){
  var a=ev.target&&ev.target.closest?ev.target.closest(".nb-searchrow a[data-group]"):null;
  if(!a||ev.button!==0||ev.ctrlKey||ev.metaKey||ev.shiftKey||ev.altKey)return;
  if(q.value===q.defaultValue&&df.value===df.defaultValue&&dt.value===dt.defaultValue)return;
  ev.preventDefault();
  var t=q.value.trim();
  window.location=BASE+"&group="+encodeURIComponent(a.getAttribute("data-group"))+(t||df.value||dt.value?"&s="+encodeURIComponent(t)+dates():"");
});
`;

    /**
     * The search controls. Shown on the search page AND on every results page so
     * the user can search again without going back. term prefills what they
     * last searched.
     */
    function searchBox(term, opts) {
        opts = opts || {};

        return '<div class="nb-search">'
             + '<div class="nb-searchrow">'
             + '<div id="wrap" class="nb-fieldbox">'
             + '<label class="nb-fl" for="vq">Vendor, invoice #, order # or unit #</label>'
             + '<input class="nb-bare" type="text" id="vq" autocomplete="off" spellcheck="false" '
             + 'placeholder="Start typing a name or number" '
             + 'value="' + esc(term || '') + '"' + (opts.focus ? ' autofocus' : '') + '>'
             + '<div id="sugg"></div></div>'
             + '<div class="nb-fieldbox nb-datebox"><label class="nb-fl" for="df">From</label>'
             + '<input class="nb-bare" type="date" id="df" value="' + esc(DATE_FROM) + '"></div>'
             + '<div class="nb-fieldbox nb-datebox"><label class="nb-fl" for="dt">To</label>'
             + '<input class="nb-bare" type="date" id="dt" value="' + esc(DATE_TO) + '"></div>'
             + (function () {
                   // The AP / TMT / Both choice sits with the other filters, before Search (and then not in the tab bar).
                   if (!GROUP_UI) return '';
                   TOGGLE_IN_SEARCH = true;
                   return groupToggleHtml(true);
               })()
             + '<button id="btn" class="nb-btn nb-btn--primary" type="button">Search</button>'
             + (rangeActive()
                 ? '<button id="cleardates" class="nb-btn nb-btn--ghost" type="button">Clear dates</button>'
                 : '')
             + '</div>'
             + (opts.note
                 ? '<div class="nb-help">Suggestions appear after two characters. '
                   + 'To see every invoice in a date range, pick the dates and leave the search blank.</div>'
                 : '')
             + '</div>';
    }

    /** Script that drives searchBox. Append to any page that includes the box. */
    function searchScript(base, suggestions) {
        return 'var BASE=' + JSON.stringify(base || self()) + ';'
             + (suggestions === false ? 'var SUGGEST=false;' : '') + SEARCH_JS;
    }

    function searchPage(msg, term) {
        var body = (msg ? '<div class="nb-info" role="status">' + esc(msg) + '</div>' : '')
                 + searchBox(term, { focus: true, note: true });

        return page(body, searchScript());
    }

    // ---------- access gate ----------

    function sha(text) {
        var h = crypto.createHash({ algorithm: crypto.HashAlg.SHA256 });
        h.update({ input: text });
        return h.digest({ outputEncoding: encode.Encoding.HEX }).toLowerCase();
    }

    function sign(empId, code) {
        return sha(empId + '|' + (code || '') + '|' + COOKIE_SECRET);
    }

    /**
     * Looks up an authorized employee by email. Returns null when the address
     * is unknown or the access box is not ticked -- the caller must not reveal
     * which, so both produce the same message.
     */
    function employeeColumns() {
        var cols = ['entityid', 'email', FLD_CODE, 'giveaccess'];
        if (REQUIRE_UPLOAD_FLAG) cols.push(FLD_UPLOAD);
        if (FLD_SUBS) cols.push(FLD_SUBS);
        if (FLD_GROUPS) cols.push(FLD_GROUPS);
        return cols;
    }

    function employeeFromRow(r) {
        var up = true;
        if (REQUIRE_UPLOAD_FLAG) {
            var v = r.getValue(FLD_UPLOAD);
            up = (v === true || v === 'T');
        }
        return {
            id: r.id,
            name: r.getValue('entityid'),
            email: r.getValue('email'),
            code: r.getValue(FLD_CODE) || '',
            canUpload: up,
            netsuite: (r.getValue('giveaccess') === true || r.getValue('giveaccess') === 'T'),
            scope: scopeFromRow(r)
        };
    }

    /** May this person use the Upload, Missing Invoices and Missing documents tabs? */
    function canUpload() {
        return !REQUIRE_LOGIN || (!!AUTH_USER && AUTH_CAN_UPLOAD);
    }

    function authorizedEmployee(email) {
        var found = null;
        try {
            search.create({
                type: 'employee',
                filters: [
                    ['email', 'is', email], 'AND',
                    [FLD_ACCESS, 'is', 'T']
                ],
                columns: employeeColumns()
            }).run().each(function (r) {
                found = employeeFromRow(r);
                return false;
            });
        } catch (e) {
            AUTH_LOOKUP_FAILED = true;
            log.error({ title: 'employee lookup failed', details: e.name + ': ' + e.message });
        }
        return found;
    }

    /** Same lookup by internal id, used to re-validate a cookie on every request. */
    function authorizedEmployeeById(empId) {
        var found = null;
        try {
            search.create({
                type: 'employee',
                filters: [
                    ['internalid', 'anyof', empId], 'AND',
                    [FLD_ACCESS, 'is', 'T']
                ],
                columns: employeeColumns()
            }).run().each(function (r) {
                found = employeeFromRow(r);
                return false;
            });
        } catch (e) {
            log.error({ title: 'employee recheck failed', details: e.name + ': ' + e.message });
        }
        return found;
    }

    /** Returns the person's name if the cookie is valid AND still authorized. */
    function userFromCookie(req) {
        var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || '';
        var mine = '';
        raw.split(';').forEach(function (c) {
            var bits = c.split('=');
            if (bits[0] && bits[0].trim() === COOKIE_NAME) mine = (bits[1] || '').trim();
        });
        if (!mine) return '';

        var dot = mine.lastIndexOf('.');
        if (dot < 1) return '';
        var empId = mine.substring(0, dot);
        var sig   = mine.substring(dot + 1);

        var emp = authorizedEmployeeById(empId);
        if (!emp) return '';
        // A temporary (hand-typed) passcode never keeps someone signed in: they must choose their own.
        if (!isHashedCode(emp.code)) return '';
        if (sign(emp.id, emp.code) !== sig) return '';
        AUTH_CAN_UPLOAD = emp.canUpload;
        AUTH_NS = emp.netsuite;
        AUTH_SCOPE = emp.scope;
        return emp.name || emp.email;
    }

    function setAuthCookie(res, emp) {
        res.setHeader({
            name: 'Set-Cookie',
            value: COOKIE_NAME + '=' + emp.id + '.' + sign(emp.id, emp.code)
                 + '; Path=/; Max-Age=' + (COOKIE_HOURS * 3600)
                 + '; Secure; HttpOnly; SameSite=Lax'
        });
    }

    function clearAuthCookie(res) {
        res.setHeader({
            name: 'Set-Cookie',
            value: COOKIE_NAME + '=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax'
        });
    }

    function hashCode(code) {
        return sha(code + '|' + PW_SALT);
    }

    /**
     * A stored passcode is a hash (exactly 64 lowercase hex characters) once the person has
     * chosen their own. Anything else that is in the field, such as a value an administrator
     * typed by hand, is a TEMPORARY passcode: it is never accepted as a normal passcode (see
     * tempCodeMatches and the sign-in below).
     */
    function isHashedCode(v) {
        return /^[0-9a-f]{64}$/.test(String(v || ''));
    }

    /** Compares two strings without stopping at the first difference. */
    function safeEqual(a, b) {
        a = String(a); b = String(b);
        var diff = a.length ^ b.length;
        for (var i = 0; i < Math.max(a.length, b.length); i++) {
            diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
        }
        return diff === 0;
    }

    /** The passcode the person chose: only a hashed value can match. */
    function codeMatches(stored, given) {
        if (!isHashedCode(stored)) return false;
        return safeEqual(hashCode(given), stored);
    }

    /** True when `stored` is a temporary (hand-typed, not hashed) passcode and `given` is it. */
    function tempCodeMatches(stored, given) {
        var t = String(stored || '').trim();
        return t !== '' && !isHashedCode(stored) && given !== '' && safeEqual(t, given);
    }

    /**
     * After a temporary passcode is accepted the person is not signed in; they get a page to
     * choose a new passcode. This token proves, without echoing the temporary passcode back to
     * the browser, that it was just accepted. It expires after TEMP_PASSCODE_MINUTES and is tied
     * to the stored value, so it stops working the moment the new hashed passcode replaces it.
     */
    function tempProof(empId, stored, expiry) {
        return expiry + '.' + sha('tmp|' + empId + '|' + expiry + '|' + stored + '|' + COOKIE_SECRET);
    }

    function tempProofValid(empId, stored, proof) {
        var bits = String(proof || '').split('.');
        if (bits.length !== 2 || !/^\d{10,16}$/.test(bits[0])) return false;
        var expiry = Number(bits[0]);
        var now = new Date().getTime();
        if (expiry < now || expiry > now + (TEMP_PASSCODE_MINUTES + 1) * 60000) return false;
        return safeEqual(tempProof(empId, stored, expiry), proof);
    }

    function authCard(headline, lead, msg, formHtml, note) {
        return '<div class="nb-card nb-authcard">'
             + '<div class="nb-overline">Nussbaum team</div>'
             + '<h1 class="nb-headline nb-h2">' + headline + '</h1>'
             + '<p class="nb-lead">' + lead + '</p>'
             + (msg ? '<p class="nb-help nb-help--error" role="alert">' + esc(msg) + '</p>' : '')
             + formHtml
             + (note ? '<p class="nb-help">' + note + '</p>' : '')
             + '</div>';
    }

    function authField(label, inputHtml) {
        return '<label class="nb-field"><span class="nb-label">' + label + '</span>' + inputHtml + '</label>';
    }

    function setPasswordPage(email, msg, proof) {
        var bad = msg ? ' aria-invalid="true"' : '';
        return page(authCard(
            proof ? 'Choose your new passcode.' : 'Choose your passcode.',
            proof ? 'Your temporary passcode worked. Pick a passcode of your own to use from now on.'
                  : 'You have access to vendor documents. Pick a passcode to use from now on.',
            msg,
            '<form method="POST" action="' + esc(self()) + '">'
          + '<input type="hidden" name="email" value="' + esc(email) + '">'
          + (proof ? '<input type="hidden" name="tmpproof" value="' + esc(proof) + '">' : '')
          + authField('New passcode', '<input class="nb-input" type="password" name="newcode" '
              + 'placeholder="At least ' + MIN_PW + ' characters" autofocus' + bad + '>')
          + authField('Confirm passcode', '<input class="nb-input" type="password" name="newcode2"' + bad + '>')
          + '<button class="nb-btn nb-btn--primary" type="submit">Save and continue</button>'
          + '</form>',
            'Only you will know this. Accounting can reset it but cannot see it.'
        ));
    }

    function savePasscode(empId, code) {
        record.submitFields({
            type: record.Type.EMPLOYEE,
            id: empId,
            values: (function () { var v = {}; v[FLD_CODE] = hashCode(code); return v; })(),
            options: { ignoreMandatoryFields: true }
        });
    }

    function loginPage(msg, email) {
        var bad = msg ? ' aria-invalid="true"' : '';
        return page(authCard(
            'Sign in.',
            'Use your work email address.',
            msg,
            '<form method="POST" action="' + esc(self()) + '">'
          + authField('Email', '<input class="nb-input" type="email" name="email" '
              + 'placeholder="you@nussbaum.com" value="' + esc(email || '') + '" autofocus' + bad + '>')
          + authField('Passcode', '<input class="nb-input" type="password" name="code"' + bad + '>')
          + '<button class="nb-btn nb-btn--primary" type="submit">Sign in</button>'
          + '</form>',
            'First time here? Leave the passcode blank and we will ask you to choose one.'
        ));
    }

    // ---------- attachment reads ----------

    /** Method A: record API sublist. Suspected not to work for mediaitem. */
    function attachViaRecord(billId) {
        var out = [];
        var rec = record.load({ type: record.Type.VENDOR_BILL, id: billId, isDynamic: false });
        var n = rec.getLineCount({ sublistId: 'mediaitem' });
        for (var i = 0; i < n; i++) {
            out.push({
                id: rec.getSublistValue({ sublistId: 'mediaitem', fieldId: 'id', line: i }),
                name: rec.getSublistValue({ sublistId: 'mediaitem', fieldId: 'name', line: i })
            });
        }
        return out;
    }

    /** Method B: transaction search with the file join. */
    function attachViaSearch(billId) {
        var out = [];
        search.create({
            type: 'transaction',
            filters: [['internalid', 'anyof', billId], 'AND', ['mainline', 'is', 'T']],
            columns: [
                search.createColumn({ name: 'internalid', join: 'file' }),
                search.createColumn({ name: 'name', join: 'file' })
            ]
        }).run().each(function (r) {
            var fid = r.getValue({ name: 'internalid', join: 'file' });
            if (fid) {
                out.push({ id: fid, name: r.getValue({ name: 'name', join: 'file' }) });
            }
            return true;
        });
        return out;
    }

    /** Method C: SuiteQL against the transaction/file link table. */
    function attachViaQuery(billId) {
        var out = [];
        var res = query.runSuiteQL({
            query: 'SELECT f.id, f.name FROM transactionfile tf '
                 + 'JOIN file f ON f.id = tf.file WHERE tf.transaction = ?',
            params: [billId]
        }).asMappedResults();
        res.forEach(function (r) { out.push({ id: r.id, name: r.name }); });
        return out;
    }

    /** Tries each method in order; returns the first that yields rows. */
    function billAttachments(billId) {
        var methods = [attachViaSearch, attachViaRecord, attachViaQuery];
        for (var i = 0; i < methods.length; i++) {
            try {
                var r = methods[i](billId);
                if (r && r.length) return r;
            } catch (e) {
                log.debug({ title: 'attach method ' + i + ' failed', details: e.message });
            }
        }
        return [];
    }

    // ---------- data ----------

    /**
     * Active vendors whose ID or name contains the term. Exact matches sort
     * first so a vendor typed in full is never pushed off the list.
     */
    function queryVendors(term, limit) {
        var up = term.toUpperCase();
        var like = '%' + up + '%';
        // Three levels on purpose: the inner ORDER BY decides which rows survive the
        // ROWNUM cut (exact matches first), and the outer one restores that order,
        // because a plain SELECT * around a subquery does not preserve it.
        var rank = 'CASE WHEN UPPER(entityid) = ? OR UPPER(companyname) = ? THEN 0 ELSE 1 END';
        // Limited to this person's subsidiaries when FLD_SUBS says so (nothing added otherwise).
        var cats = currentCategoryIds();
        return withVendorSubs(function () {
            var vs = vendorSubSql('vnd');
            return query.runSuiteQL({
                query: 'SELECT id, entityid, companyname FROM (SELECT * FROM ('
                     + 'SELECT id, entityid, companyname, ' + rank + ' AS rnk FROM vendor' + (vs.sql ? ' vnd' : '') + ' '
                     + 'WHERE NVL(isinactive, \'F\') = \'F\' '
                     + 'AND (UPPER(entityid) LIKE ? OR UPPER(companyname) LIKE ?) '
                     + 'AND category IN (' + qmarks(cats.length) + ')' + vs.sql + ' '
                     + 'ORDER BY rnk, entityid'
                     + ') WHERE ROWNUM <= ' + Number(limit) + ') ORDER BY rnk, entityid',
                params: [up, up, like, like].concat(cats, vs.params)
            }).asMappedResults();
        });
    }

    /** Legacy vendor-only suggestions ({e, n}). */
    function suggestVendors(term) {
        return queryVendors(term, 20).map(function (r) {
            return { e: r.entityid, n: r.companyname || '' };
        });
    }

    /** Vendors for the full results page. */
    function searchVendors(term) {
        return queryVendors(term, 25).map(function (r) {
            return { id: r.id, entityid: r.entityid, name: r.companyname || '' };
        });
    }

    function isExactVendor(v, term) {
        var t = term.toUpperCase();
        return String(v.entityid || '').toUpperCase() === t
            || String(v.name || '').toUpperCase() === t;
    }

    /** Date bounds as SuiteQL. Safe to inline: validIso() allows digits and dashes only. */
    function dateSql() {
        var s = '';
        if (validIso(DATE_FROM)) s += " AND t.trandate >= TO_DATE('" + DATE_FROM + "', 'YYYY-MM-DD')";
        if (validIso(DATE_TO))   s += " AND t.trandate <= TO_DATE('" + DATE_TO + "', 'YYYY-MM-DD')";
        return s;
    }

    /** Column comparisons for the chosen search field(s). op is LIKE or =. */
    function billMatch(by, op) {
        var cols = [];
        if (by === 'all' || by === 'po') cols.push('t.tranid');
        if (UNIT_COL && (by === 'all' || by === 'unit')) cols.push('t.' + UNIT_COL);
        if (by === 'all' || by === 'invoice') {
            REF_FIELDS.forEach(function (f) { cols.push('t.' + f); });
        }
        return cols.map(function (c) { return 'UPPER(' + c + ') ' + op + ' ?'; });
    }

    /**
     * Vendor bills whose Order # and/or Invoice # contain the term, newest
     * first, with exact matches ahead of partial ones. Returns raw SuiteQL rows.
     */
    function matchBills(term, by, limit, offset, opts) {
        offset = offset || 0;
        opts = opts || {};
        var cats = currentCategoryIds();
        var vendorSql = (opts.vendorId ? ' AND t.entity = ?' : '') + ' AND v.category IN (' + qmarks(cats.length) + ')';
        var scope = scopeSql('t', '');   // the groups in effect are already in v.category IN (...), all ones this person may see
        var cols = 't.id AS id, t.tranid AS tranid, t.externalid AS externalid, t.otherrefnum AS otherrefnum, '
                 + 't.trandate AS trandate, v.entityid AS vendorid, v.companyname AS vendorname'
                 + (UNIT_COL ? ', t.' + UNIT_COL + ' AS unit' : '');
        var from = 'FROM transaction t LEFT JOIN vendor v ON v.id = t.entity ';
        var params = [];
        var inner;

        if (term) {
            var up = term.toUpperCase();
            var like = '%' + up + '%';
            var likes = billMatch(by, 'LIKE');
            var eqs = billMatch(by, '=');
            if (!likes.length) return [];

            // Parameters appear in the order the placeholders do: rank (SELECT list)
            // first, then the LIKE tests (WHERE).
            eqs.forEach(function () { params.push(up); });
            likes.forEach(function () { params.push(like); });
            if (opts.vendorId) params.push(Number(opts.vendorId));
            params = params.concat(cats, scope.params);

            // Best matches first, unless the person chose a column to sort by.
            inner = 'SELECT ' + cols + ', CASE WHEN ' + eqs.join(' OR ') + ' THEN 0 ELSE 1 END AS rnk '
                  + from + "WHERE t.type = 'VendBill' AND (" + likes.join(' OR ') + ')' + vendorSql + scope.sql + dateSql()
                  + ' ORDER BY ' + (opts.sort ? sqlOrderBy(opts.sort) : 'rnk, t.trandate DESC, t.id DESC');
        } else {
            // No search text: every bill in the date range (or of one vendor), newest first unless sorted.
            if (opts.vendorId) params.push(Number(opts.vendorId));
            params = params.concat(cats, scope.params);
            inner = 'SELECT ' + cols + ' ' + from + "WHERE t.type = 'VendBill'" + vendorSql + scope.sql + dateSql()
                  + ' ORDER BY ' + sqlOrderBy(opts.sort);
        }

        // Paging: number the rows in the inner (sorted) order, keep one window.
        // Columns are named explicitly because SuiteQL rejects x.* here.
        var names = ['id', 'tranid', 'externalid', 'otherrefnum', 'trandate', 'vendorid', 'vendorname'];
        if (UNIT_COL) names.push('unit');
        var picked = names.map(function (n) { return 'x.' + n + ' AS ' + n; }).join(', ');
        return query.runSuiteQL({
            query: 'SELECT ' + names.join(', ') + ' FROM (SELECT ' + picked + ', ROWNUM AS rn FROM ('
                 + inner + ') x WHERE ROWNUM <= ' + (Number(offset) + Number(limit))
                 + ') WHERE rn > ' + Number(offset) + ' ORDER BY rn',
            params: params
        }).asMappedResults();
    }

    /** If the page asked for is past the end (an old link), show the last page instead. */
    function clampPage(total, size) {
        var pages = Math.max(1, Math.ceil(total / size));
        if (PAGE > pages) PAGE = pages;
    }

    /** How many bills match (same tests as matchBills), so the pager can show page numbers. */
    function countBills(term, by, opts) {
        opts = opts || {};
        var params = [];
        var where = "t.type = 'VendBill'";

        if (term) {
            var like = '%' + term.toUpperCase() + '%';
            var likes = billMatch(by, 'LIKE');
            if (!likes.length) return 0;
            likes.forEach(function () { params.push(like); });
            where += ' AND (' + likes.join(' OR ') + ')';
        }
        if (opts.vendorId) { where += ' AND t.entity = ?'; params.push(Number(opts.vendorId)); }
        var cats = currentCategoryIds();
        where += ' AND v.category IN (' + qmarks(cats.length) + ')';
        params = params.concat(cats);
        var scope = scopeSql('t', '');
        where += scope.sql;
        params = params.concat(scope.params);
        var rows = query.runSuiteQL({
            query: 'SELECT COUNT(*) AS n FROM transaction t LEFT JOIN vendor v ON v.id = t.entity WHERE ' + where + dateSql(),
            params: params
        }).asMappedResults();
        return rows.length ? Number(rows[0].n) || 0 : 0;
    }

    /** First non-empty of externalid / otherrefnum, for display. */
    function refOf(r) {
        return r.externalid || r.otherrefnum || '';
    }

    /** Mixed vendor + invoice suggestions for the type-ahead. */
    function suggestAll(term, by) {
        var out = [];

        if (by === 'all' || by === 'vendor') {
            queryVendors(term, MAX_SUGGEST).forEach(function (r) {
                out.push({ k: 'v', e: r.entityid, n: r.companyname || '' });
            });
        }
        if (by === 'all') {
            searchWaiting(term, MAX_SUGGEST).forEach(function (r) {
                out.push({ k: 'w', id: r.id, o: r.order, u: r.unit, n: r.name });
            });
        }
        if (by !== 'vendor') {
            matchBills(term, by, MAX_SUGGEST).forEach(function (r) {
                out.push({
                    k: 'b',
                    id: r.id,
                    t: r.tranid || '',
                    r: refOf(r),
                    u: r.unit || '',
                    e: r.vendorid || '',
                    n: r.vendorname || ''
                });
            });
        }
        return out;
    }

    function findVendors(input) {
        var out = [];
        search.create({
            type: 'vendor',
            filters: [['entityid', 'is', input], 'OR', ['externalidstring', 'is', input]],
            columns: ['entityid', 'companyname', 'category']
        }).run().each(function (r) {
            out.push({
                id: r.id,
                entityid: r.getValue('entityid'),
                name: r.getValue('companyname'),
                category: r.getValue('category')
            });
            return out.length < 10;
        });
        if (scopeSubs() && out.length) {
            var ok = visibleVendorIds(out.map(function (v) { return v.id; }));
            out = out.filter(function (v) { return ok[Number(v.id)]; });
        }
        return out;
    }

    function mapBill(r) {
        return {
            id: r.id,
            tranid: r.getValue('tranid'),
            date: r.getValue('trandate'),
            amount: r.getValue('amount'),
            status: r.getText('statusref'),
            files: [],
            ref: '',
            unit: '',
            vendorid: '',
            vendorname: ''
        };
    }

    /**
     * Columns for a bill search. With a sort, that column goes first (so it sorts first) and
     * newest-first stays as the tie-break; without one the list is newest first.
     */
    function billColumns(so) {
        var names = { vendor: 'entity', date: 'trandate', order: 'tranid', amount: 'amount' };
        if (UNIT_COL) names.unit = UNIT_COL;
        var name = (so && names.hasOwnProperty(so.key)) ? names[so.key] : '';
        var dir = (so && so.dir === 'asc') ? search.Sort.ASC : search.Sort.DESC;

        var cols = [];
        if (name) cols.push(search.createColumn({ name: name, sort: dir }));
        if (name !== 'trandate') cols.push(search.createColumn({ name: 'trandate', sort: search.Sort.DESC }));
        ['tranid', 'amount', 'statusref'].forEach(function (n) { if (n !== name) cols.push(n); });
        return cols;
    }

    /**
     * Adds the reference number, NetSuite transaction number and vendor to each
     * bill (one SuiteQL call for the whole set), then attaches documents.
     */
    function decorateBills(bills, skipFiles) {
        if (!bills.length) return bills;

        try {
            var ids = bills.map(function (b) { return Number(b.id); });
            var marks = ids.map(function () { return '?'; }).join(',');
            var rows = query.runSuiteQL({
                query: 'SELECT t.id, t.externalid, t.otherrefnum, '
                     + (UNIT_COL ? 't.' + UNIT_COL + ' AS unit, ' : '')
                     + 'v.entityid AS vendorid, v.companyname AS vendorname '
                     + 'FROM transaction t LEFT JOIN vendor v ON v.id = t.entity '
                     + 'WHERE t.id IN (' + marks + ')',
                params: ids
            }).asMappedResults();

            var byId = {};
            rows.forEach(function (r) { byId[String(r.id)] = r; });

            bills.forEach(function (b) {
                var r = byId[String(b.id)];
                if (!r) return;
                b.ref = refOf(r);
                b.unit = r.unit || '';
                b.vendorid = r.vendorid || '';
                b.vendorname = r.vendorname || '';
            });
        } catch (e) {
            // Reference/vendor columns are a convenience; never fail the page over them.
            log.error({ title: 'bill decorate failed', details: e.name + ': ' + e.message });
        }

        // skipFiles: the caller already knows these bills have no document
        if (!skipFiles) bills.forEach(function (b) { b.files = billAttachments(b.id); });
        return bills;
    }

    /** One page of a vendor's bills: { bills, total }. */
    function findBills(vendorId) {
        var opts = { vendorId: vendorId, sort: sortFor(SORT_VENDOR) };
        var total = countBills('', 'all', opts);
        clampPage(total, MAX_BILLS);
        var rows = total ? matchBills('', 'all', MAX_BILLS, (PAGE - 1) * MAX_BILLS, opts) : [];
        return { bills: loadBillsByIds(rows.map(function (r) { return Number(r.id); })), total: total };
    }

    /** Loads specific bills by internal id (ids come from matchBills or a validated &b=). */
    function loadBillsByIds(ids) {
        var out = [];
        if (!ids.length) return out;
        var filters = [['mainline', 'is', 'T'], 'AND', ['internalid', 'anyof', ids]];
        if (scopeSubs()) filters.push('AND', ['subsidiary', 'anyof', scopeSubs().length ? scopeSubs() : ['@NONE@']]);
        search.create({
            type: 'vendorbill',
            filters: filters,
            columns: billColumns()
        }).run().each(function (r) {
            out.push(mapBill(r));
            return true;
        });

        // The search returns newest first; keep the order the caller asked for (a sort, or
        // best match first) instead.
        var pos = {};
        ids.forEach(function (id, i) { pos[String(id)] = i; });
        out.sort(function (a, b) { return pos[String(a.id)] - pos[String(b.id)]; });

        return decorateBills(out);
    }

    function billIdFromTranId(tranId) {
        var found = null;
        search.create({
            type: 'vendorbill',
            filters: [['mainline', 'is', 'T'], 'AND', ['tranid', 'is', tranId]],
            columns: ['internalid']
        }).run().each(function (r) { found = r.id; return false; });
        return found;
    }

    // ---------- invoice uploads: data ----------

    function normOrder(s) {
        return String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
    }

    function validOrder(o) {
        return /^[A-Z0-9][A-Z0-9 _\/.-]{1,39}$/.test(o);
    }

    /** A unit # is optional; when given it is 1 to 20 letters, numbers, spaces, dashes or slashes. */
    function validUnit(u) {
        return /^[A-Z0-9][A-Z0-9 _\/.-]{0,19}$/.test(u);
    }

    /** Text that is safe to store inside the pipe-separated description. */
    function safeText(s) {
        return String(s || '').replace(/[|=\r\n]/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 60);
    }

    function today() {
        return new Date().toISOString().slice(0, 10);
    }

    /** NTSINV|STATE|KEY=value|... -> { state, order, by, bill, at } or null (not one of ours). */
    function parseDoc(desc) {
        if (!desc || String(desc).indexOf(DOC_MARK) !== 0) return null;
        var parts = String(desc).split('|');
        var out = { state: parts[1] || '' };
        parts.slice(2).forEach(function (p) {
            var i = p.indexOf('=');
            if (i > 0) out[p.substring(0, i).toLowerCase()] = p.substring(i + 1);
        });
        return out;
    }

    function docDesc(state, order, by, billId, unit) {
        return DOC_MARK + state + '|ORDER=' + order
             + (unit ? '|UNIT=' + unit : '')
             + '|BY=' + safeText(by)
             + (billId ? '|BILL=' + billId : '')
             + (state === 'MATCHED' ? '|AT=' + today() : '');
    }

    var FOLDER_ID = 0;

    /**
     * The folder waiting PDFs are saved in. Found by its External ID first, then by
     * PENDING_FOLDER_PATH (every folder on the path must match exactly one folder, otherwise a
     * readable error says which); created at that path on first use. The id is looked up once
     * per request.
     */
    function ensurePendingFolder() {
        if (FOLDER_ID) return FOLDER_ID;

        var parts = String(PENDING_FOLDER_PATH || '').split('/').map(function (x) { return x.trim(); }).filter(Boolean);
        if (!parts.length) throw new Error('PENDING_FOLDER_PATH is empty, so the Pending Vendor Invoices folder cannot be found.');
        var leaf = parts[parts.length - 1];

        // 1. By External ID.
        if (PENDING_FOLDER_EXTERNAL_ID) {
            var byExt = folderByExternalId(PENDING_FOLDER_EXTERNAL_ID);
            if (byExt) { FOLDER_ID = byExt; return FOLDER_ID; }
        }

        // 2. By exact path: each folder on the way must match exactly one folder.
        var parent = null;
        for (var i = 0; i < parts.length - 1; i++) {
            var here = parts.slice(0, i + 1).join('/');
            var ids = folderChildren(parts[i], parent);
            if (!ids.length) {
                throw new Error('Could not find the File Cabinet folder "' + here + '" (looking for "' + parts[i] + '"'
                    + (parent === null ? ' at the top level' : ' inside "' + parts.slice(0, i).join('/') + '"')
                    + ') which holds the Pending Vendor Invoices folder (PENDING_FOLDER_PATH = "' + PENDING_FOLDER_PATH + '").');
            }
            if (ids.length > 1) {
                throw new Error('More than one File Cabinet folder matches "' + here + '" (folder ids ' + ids.join(', ')
                    + '). Rename or remove the duplicates so PENDING_FOLDER_PATH = "' + PENDING_FOLDER_PATH + '" matches exactly one.');
            }
            parent = ids[0];
        }

        var found = folderChildren(leaf, parent);
        if (found.length > 1) {
            throw new Error('More than one File Cabinet folder matches "' + PENDING_FOLDER_PATH + '" (folder ids ' + found.join(', ')
                + '). Rename or remove the duplicates so it matches exactly one.');
        }
        if (found.length === 1) { FOLDER_ID = found[0]; return FOLDER_ID; }

        if (!PENDING_FOLDER_CREATE_IF_MISSING) {
            throw new Error('The File Cabinet folder "' + PENDING_FOLDER_PATH + '" does not exist (PENDING_FOLDER_CREATE_IF_MISSING is false).');
        }

        var rec = record.create({ type: record.Type.FOLDER });
        rec.setValue({ fieldId: 'name', value: leaf });
        if (parent !== null) rec.setValue({ fieldId: 'parent', value: parent });
        if (PENDING_FOLDER_EXTERNAL_ID) {
            try { rec.setValue({ fieldId: 'externalid', value: PENDING_FOLDER_EXTERNAL_ID }); }
            catch (e) { log.error({ title: 'pending folder external id not set', details: e.name + ': ' + e.message }); }
        }
        try {
            FOLDER_ID = Number(rec.save());
        } catch (e) {
            // Someone else may have created it a moment ago (an External ID is unique).
            var again = PENDING_FOLDER_EXTERNAL_ID ? folderByExternalId(PENDING_FOLDER_EXTERNAL_ID) : 0;
            if (!again) throw e;
            FOLDER_ID = again;
            return FOLDER_ID;
        }
        log.audit({ title: 'pending folder created', details: leaf + ' (' + FOLDER_ID + ') at ' + PENDING_FOLDER_PATH });
        return FOLDER_ID;
    }

    /** The folder with this External ID, or 0 when none has it. */
    function folderByExternalId(ext) {
        var rows = query.runSuiteQL({
            query: 'SELECT id FROM mediaitemfolder WHERE externalid = ? ORDER BY id',
            params: [ext]
        }).asMappedResults();
        if (rows.length > 1) {
            throw new Error('More than one File Cabinet folder has the External ID "' + ext + '" (folder ids '
                + rows.map(function (r) { return r.id; }).join(', ') + ').');
        }
        return rows.length ? Number(rows[0].id) : 0;
    }

    /** Ids of the folders with this exact name directly inside parentId (null = top level). */
    function folderChildren(name, parentId) {
        return query.runSuiteQL({
            query: 'SELECT id FROM mediaitemfolder WHERE name = ? AND ' + (parentId === null ? 'parent IS NULL' : 'parent = ?') + ' ORDER BY id',
            params: parentId === null ? [name] : [name, parentId]
        }).asMappedResults().map(function (r) { return Number(r.id); });
    }

    /** ORDER__original-name.pdf, with anything odd replaced so the name is safe in the File Cabinet. */
    function buildFileName(order, original) {
        var base = String(original || 'invoice.pdf').split(/[\\\/]/).pop();
        base = base.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._ ()-]/g, '_').substring(0, 60) || 'invoice';
        var ord = order.replace(/[^A-Z0-9._ -]/g, '-');
        return ord + '__' + base + '.pdf';
    }

    /** A File Cabinet folder cannot hold two files with one name, so add (2), (3) ... when needed. */
    function uniqueFileName(folderId, name) {
        var stem = name.replace(/\.pdf$/i, '');
        var candidate = name;
        for (var n = 2; n < 60; n++) {
            var hit = query.runSuiteQL({
                query: 'SELECT id FROM file WHERE folder = ? AND name = ?',
                params: [Number(folderId), candidate]
            }).asMappedResults();
            if (!hit.length) return candidate;
            candidate = stem + ' (' + n + ').pdf';
        }
        return stem + ' ' + new Date().getTime() + '.pdf';
    }

    /** Vendor bills by order # (their Reference No.): { 'EPO-1': [{id, tranid, vendorid}] }. */
    function billsByOrder(orders) {
        var map = {};
        if (!orders.length) return map;
        var marks = orders.map(function () { return '?'; }).join(',');
        // For a person with limited access, invoices outside it are left out (they do not exist for them).
        var scope = scopeSql('t', 'v');
        query.runSuiteQL({
            query: "SELECT t.id AS id, t.tranid AS tranid, v.entityid AS vendorid "
                 + "FROM transaction t LEFT JOIN vendor v ON v.id = t.entity "
                 + "WHERE t.type = 'VendBill' AND UPPER(t.tranid) IN (" + marks + ')' + scope.sql,
            params: orders.concat(scope.params)
        }).asMappedResults().forEach(function (r) {
            var k = normOrder(r.tranid);
            (map[k] = map[k] || []).push({ id: Number(r.id), tranid: r.tranid, vendorid: r.vendorid || '' });
        });
        return map;
    }

    /**
     * Attaches a waiting PDF to a bill, then marks it matched (which takes it out of
     * the queue). Attach comes first so a failure leaves the PDF waiting, not lost.
     */
    function attachDoc(fileId, billId, order, by, unit) {
        record.attach({
            record: { type: 'file', id: Number(fileId) },
            to: { type: record.Type.VENDOR_BILL, id: Number(billId) }
        });

        // The PDF is attached; a problem adding the unit # must not undo that.
        var unitState = 'none';
        try {
            unitState = applyUnit(billId, unit);
        } catch (e) {
            unitState = 'failed';
            log.error({ title: 'unit # not added', details: 'Bill ' + billId + ' :: ' + e.name + ': ' + e.message });
        }

        var f = file.load({ id: Number(fileId) });
        f.description = docDesc('MATCHED', order, by, billId, unit);
        f.save();

        forgetMissingCount();   // this bill now has a document
        return unitState;
    }

    /**
     * Puts the unit # entered at upload on the bill, but only if the bill has none.
     * Returns 'none' (nothing to add), 'added', 'same', 'kept:<its unit>' or throws.
     * Triggers are switched off for this one-field update so it cannot restart the
     * bill's approval workflow or other scripts.
     */
    function applyUnit(billId, unit) {
        if (!UNIT_COL || !unit) return 'none';

        var rows = query.runSuiteQL({
            query: 'SELECT ' + UNIT_COL + ' AS unit FROM transaction WHERE id = ?',
            params: [Number(billId)]
        }).asMappedResults();
        var current = rows.length ? normOrder(rows[0].unit) : '';

        if (current) return current === unit ? 'same' : 'kept:' + current;

        var values = {};
        values[UNIT_COL] = unit;
        record.submitFields({
            type: record.Type.VENDOR_BILL,
            id: Number(billId),
            values: values,
            options: { enableSourcing: false, ignoreMandatoryFields: true, disableTriggers: true }
        });
        return 'added';
    }

    /** What to tell the person about the unit #, after the PDF was attached. */
    function unitNote(unit, state) {
        if (!unit || !state || state === 'none' || state === 'same') return '';
        if (state === 'added') return ' Unit # ' + unit + ' added.';
        if (state.indexOf('kept:') === 0) {
            return ' The invoice already has unit # ' + state.substring(5) + ', so ' + unit + ' was not added.';
        }
        return ' We could not add the unit # to the invoice.';
    }

    /** Files in a state ('PENDING' / 'MATCHED'), parsed. Oldest first unless newestFirst. */
    function docRows(state, limit, newestFirst) {
        var dir = newestFirst ? 'DESC' : 'ASC';
        return query.runSuiteQL({
            query: 'SELECT id, name, description, createddate, TRUNC(SYSDATE) - TRUNC(createddate) AS age FROM ('
                 + 'SELECT id, name, description, createddate FROM file WHERE description LIKE ? ORDER BY id ' + dir
                 + ') WHERE ROWNUM <= ' + Number(limit) + ' ORDER BY id ' + dir,
            params: [DOC_MARK + state + '|%']
        }).asMappedResults().map(function (r) {
            var d = parseDoc(r.description) || {};
            return { id: Number(r.id), name: r.name, order: d.order || '', unit: d.unit || '', by: d.by || '',
                     bill: d.bill || '', at: d.at || '', created: r.createddate, age: r.age };
        }).filter(function (r) { return r.order; });
    }

    /**
     * PDFs still waiting for their invoice whose order #, unit # or file name contains the
     * term. Read-only, for the search page and its dropdown.
     */
    function searchWaiting(term, limit) {
        var up = String(term || '').toUpperCase();
        if (!up) return [];
        var like = '%' + up + '%';

        var rows = query.runSuiteQL({
            query: 'SELECT id, name, description, createddate FROM ('
                 + 'SELECT id, name, description, createddate FROM file WHERE description LIKE ? '
                 + 'AND (UPPER(description) LIKE ? OR UPPER(name) LIKE ?) ORDER BY id DESC'
                 + ') WHERE ROWNUM <= ' + Number(limit) + ' ORDER BY id DESC',
            params: [DOC_MARK + 'PENDING|%', like, like]
        }).asMappedResults().map(function (r) {
            var d = parseDoc(r.description) || {};
            return { id: Number(r.id), name: r.name || '', order: d.order || '', unit: d.unit || '',
                     by: d.by || '', created: r.createddate };
        }).filter(function (r) {
            // the description also holds labels like ORDER= and PENDING, so confirm the hit is real
            return r.order && (r.order.indexOf(up) >= 0 || r.unit.toUpperCase().indexOf(up) >= 0
                            || r.name.toUpperCase().indexOf(up) >= 0);
        });
        return filterDocs(rows);
    }

    /** One of our files by id, parsed; null for anything else (so nothing else can be touched). */
    function loadDoc(id) {
        if (!/^\d+$/.test(String(id || ''))) return null;
        var rows = query.runSuiteQL({
            query: 'SELECT id, description FROM file WHERE id = ?',
            params: [Number(id)]
        }).asMappedResults();
        if (!rows.length) return null;
        var d = parseDoc(rows[0].description);
        if (d) d.id = Number(rows[0].id);
        return d;
    }

    /**
     * The waiting list. Any PDF whose bill has already arrived (exactly one bill with
     * that order #) is attached on the spot, up to SWEEP_MAX per visit, so the queue
     * is right even if the bill-save script missed one.
     */
    function loadQueue() {
        var rows = filterDocs(docRows('PENDING', MAX_QUEUE, false));
        var seen = {}, orders = [];
        rows.forEach(function (r) { if (!seen[r.order]) { seen[r.order] = 1; orders.push(r.order); } });
        var bills = billsByOrder(orders);

        var swept = 0, left = [];
        rows.forEach(function (r) {
            var m = bills[r.order] || [];
            if (m.length === 1 && swept < SWEEP_MAX) {
                try {
                    attachDoc(r.id, m[0].id, r.order, r.by, r.unit);
                    swept++;
                    return;
                } catch (e) {
                    log.error({ title: 'queue attach failed', details: 'File ' + r.id + ' :: ' + e.name + ': ' + e.message });
                }
            }
            r.billCount = m.length;
            left.push(r);
        });
        return { pending: left, swept: swept };
    }

    // ---------- invoice uploads: requests ----------

    function jsonOut(res, obj) {
        res.setHeader({ name: 'Content-Type', value: 'application/json' });
        res.write(JSON.stringify(obj));
    }

    function stateMessage(order, bills, unit) {
        if (bills.length === 1) {
            return 'Attached to invoice ' + (bills[0].vendorid ? bills[0].vendorid + ' ' : '') + bills[0].tranid + '.';
        }
        if (bills.length > 1) {
            return 'More than one invoice uses this order #, so it is waiting for review in Missing Invoices.';
        }
        return 'Waiting for an invoice with this order #.'
             + (unit ? ' Unit # ' + unit + ' will be added when the invoice arrives, if it has none.' : '');
    }

    /** POST mode=upload: one PDF (base64) with its order #. */
    function handleUpload(req, res) {
        if (req.method !== 'POST') return jsonOut(res, { ok: false, error: 'Use the Upload tab to send files.' });
        if (!canUpload()) return jsonOut(res, { ok: false, error: 'You do not have access to upload invoices.' });

        try {
            var order = normOrder(req.parameters.order);
            if (!validOrder(order)) {
                return jsonOut(res, { ok: false, error: 'Enter an order # with 2 to 40 letters, numbers, dashes or slashes.' });
            }

            var unit = UNIT_COL ? normOrder(req.parameters.unit) : '';
            if (unit && !validUnit(unit)) {
                return jsonOut(res, { ok: false, error: 'Enter a unit # with up to 20 letters, numbers, dashes or slashes.' });
            }

            var data = String(req.parameters.data || '');
            if (data.indexOf('JVBERi') !== 0) {
                return jsonOut(res, { ok: false, error: 'That file is not a PDF.' });
            }
            if (data.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 8) {
                return jsonOut(res, { ok: false, error: 'That PDF is over ' + Math.round(MAX_UPLOAD_BYTES / 1048576) + ' MB.' });
            }

            var folderId = ensurePendingFolder();
            var name = uniqueFileName(folderId, buildFileName(order, req.parameters.name));
            var fileId = file.create({
                name: name,
                fileType: file.Type.PDF,
                contents: data,
                folder: folderId,
                description: docDesc('PENDING', order, AUTH_USER, null, unit),
                isOnline: false
            }).save();

            log.audit({
                title: 'invoice uploaded',
                details: AUTH_USER + ' uploaded file ' + fileId + ' for order # ' + order
                       + (unit ? ' (unit # ' + unit + ')' : '') + (req.parameters.notes === '1' ? ' with notes added' : '')
                       + ' from ' + req.clientIpAddress
            });

            var bills = billsByOrder([order])[order] || [];
            var out = { ok: true, fileId: fileId, state: 'queued', message: stateMessage(order, bills, unit) };

            if (bills.length === 1) {
                try {
                    out.message += unitNote(unit, attachDoc(fileId, bills[0].id, order, AUTH_USER, unit));
                    out.state = 'matched';
                    out.billId = bills[0].id;
                } catch (e) {
                    log.error({ title: 'upload attach failed', details: 'File ' + fileId + ' :: ' + e.name + ': ' + e.message });
                    out.message = 'Saved to Missing Invoices. We could not attach it yet, so it will try again.';
                }
            } else if (bills.length > 1) {
                out.state = 'review';
            }
            jsonOut(res, out);
        } catch (e) {
            log.error({ title: 'upload failed', details: e.name + ': ' + e.message });
            jsonOut(res, { ok: false, error: 'We could not save that file. Try again, and tell Accounting if it keeps happening.' });
        }
    }

    /**
     * POST mode=attach: a PDF dropped on one invoice row. The invoice is known, so nothing
     * is typed: the PDF is saved with the invoice's order # and attached straight away. If
     * the attach fails the PDF stays in the queue, where it attaches itself later.
     */
    function handleAttach(req, res) {
        if (req.method !== 'POST') return jsonOut(res, { ok: false, error: 'Drop the PDF on an invoice to attach it.' });
        if (!canUpload()) return jsonOut(res, { ok: false, error: 'You do not have access to attach documents.' });

        try {
            var billId = String(req.parameters.bill || '').trim();
            var bill = /^\d+$/.test(billId) ? query.runSuiteQL({
                query: "SELECT id, tranid FROM transaction WHERE id = ? AND type = 'VendBill'",
                params: [Number(billId)]
            }).asMappedResults()[0] : null;
            if (!bill || !billVisible(bill.id)) return jsonOut(res, { ok: false, error: 'We could not find that invoice.' });

            var data = String(req.parameters.data || '');
            if (data.indexOf('JVBERi') !== 0) {
                return jsonOut(res, { ok: false, error: 'That file is not a PDF.' });
            }
            if (data.length > Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 8) {
                return jsonOut(res, { ok: false, error: 'That PDF is over ' + Math.round(MAX_UPLOAD_BYTES / 1048576) + ' MB.' });
            }

            // The description is pipe-separated, so keep | and = out of the order #.
            var order = (normOrder(bill.tranid).replace(/[|=]/g, '-').substring(0, 40)) || ('BILL-' + billId);

            var folderId = ensurePendingFolder();
            var name = uniqueFileName(folderId, buildFileName(order, req.parameters.name));
            var fileId = file.create({
                name: name,
                fileType: file.Type.PDF,
                contents: data,
                folder: folderId,
                description: docDesc('PENDING', order, AUTH_USER),
                isOnline: false
            }).save();

            try {
                attachDoc(fileId, bill.id, order, AUTH_USER, '');
            } catch (e) {
                log.error({ title: 'drop attach failed', details: 'File ' + fileId + ' bill ' + bill.id + ' :: ' + e.name + ': ' + e.message });
                return jsonOut(res, { ok: false, error: 'We saved the PDF but could not attach it yet. It is in Missing Invoices and will attach on its own.' });
            }

            log.audit({
                title: 'invoice attached by drop',
                details: AUTH_USER + ' attached file ' + fileId + ' to bill ' + bill.id + ' (order # ' + order + ')'
                       + (req.parameters.notes === '1' ? ' with notes added' : '') + ' from ' + req.clientIpAddress
            });
            jsonOut(res, { ok: true, fileId: fileId, name: name });
        } catch (e) {
            log.error({ title: 'attach failed', details: e.name + ': ' + e.message });
            jsonOut(res, { ok: false, error: 'We could not save that file. Try again, and tell Accounting if it keeps happening.' });
        }
    }

    /**
     * POST mode=unit: change (or clear) the unit # on one vendor bill. This is a deliberate
     * edit, so it replaces whatever is there. Triggers are switched off for the one-field
     * update so it cannot restart the bill's approval workflow or other scripts.
     */
    function handleUnit(req, res) {
        if (req.method !== 'POST') return jsonOut(res, { ok: false, error: 'Use the unit # box on an invoice to change it.' });
        if (!canUpload()) return jsonOut(res, { ok: false, error: 'You do not have access to change unit #s.' });
        if (!UNIT_COL) return jsonOut(res, { ok: false, error: 'Unit #s are not turned on.' });

        try {
            var billId = String(req.parameters.bill || '').trim();
            var row = /^\d+$/.test(billId) ? query.runSuiteQL({
                query: 'SELECT id, tranid, ' + UNIT_COL + " AS unit FROM transaction WHERE id = ? AND type = 'VendBill'",
                params: [Number(billId)]
            }).asMappedResults()[0] : null;
            if (!row || !billVisible(row.id)) return jsonOut(res, { ok: false, error: 'We could not find that invoice.' });

            var unit = normOrder(req.parameters.unit);          // empty means clear it
            if (unit && !validUnit(unit)) {
                return jsonOut(res, { ok: false, error: 'Enter a unit # with up to 20 letters, numbers, dashes or slashes.' });
            }

            var current = normOrder(row.unit);
            if (unit === current) return jsonOut(res, { ok: true, unit: unit, changed: false });

            var values = {};
            values[UNIT_COL] = unit;
            record.submitFields({
                type: record.Type.VENDOR_BILL,
                id: Number(row.id),
                values: values,
                options: { enableSourcing: false, ignoreMandatoryFields: true, disableTriggers: true }
            });

            log.audit({
                title: 'unit # changed',
                details: AUTH_USER + ' changed unit # on bill ' + row.id + ' (order # ' + row.tranid + ') from "'
                       + current + '" to "' + unit + '" from ' + req.clientIpAddress
            });
            jsonOut(res, { ok: true, unit: unit, changed: true });
        } catch (e) {
            log.error({ title: 'unit change failed', details: e.name + ': ' + e.message });
            jsonOut(res, { ok: false, error: 'We could not change the unit #. Try again, and tell Accounting if it keeps happening.' });
        }
    }

    /** POST mode=queueedit: fix the order # on a waiting PDF. */
    function handleQueueEdit(req, res) {
        if (req.method !== 'POST') return jsonOut(res, { ok: false, error: 'Use the Missing Invoices tab to make changes.' });
        if (!canUpload()) return jsonOut(res, { ok: false, error: 'You do not have access to change this list.' });

        try {
            var d = loadDoc(req.parameters.id);
            if (!d || d.state !== 'PENDING' || !filterDocs([d]).length) {
                return jsonOut(res, { ok: false, error: 'That PDF is no longer waiting for an invoice.' });
            }
            var order = normOrder(req.parameters.order);
            if (!validOrder(order)) {
                return jsonOut(res, { ok: false, error: 'Enter an order # with 2 to 40 letters, numbers, dashes or slashes.' });
            }

            // Unit #: change it only when the request carries one (an empty value clears it).
            var unit = d.unit || '';
            if (UNIT_COL && req.parameters.unit !== undefined) {
                unit = normOrder(req.parameters.unit);
                if (unit && !validUnit(unit)) {
                    return jsonOut(res, { ok: false, error: 'Enter a unit # with up to 20 letters, numbers, dashes or slashes.' });
                }
            }

            var f = file.load({ id: d.id });
            var oldName = String(f.name || '');
            var orig = oldName.indexOf('__') > -1 ? oldName.substring(oldName.indexOf('__') + 2) : oldName;
            f.name = uniqueFileName(Number(f.folder), buildFileName(order, orig));
            f.description = docDesc('PENDING', order, d.by, null, unit);
            f.save();

            log.audit({
                title: 'queue order # changed',
                details: AUTH_USER + ' changed file ' + d.id + ' from ' + d.order + ' to ' + order
            });

            var bills = billsByOrder([order])[order] || [];
            var out = { ok: true, state: 'queued', message: stateMessage(order, bills, unit) };
            if (bills.length === 1) {
                try {
                    out.message += unitNote(unit, attachDoc(d.id, bills[0].id, order, d.by, unit));
                    out.state = 'matched';
                } catch (e) {
                    log.error({ title: 'edit attach failed', details: 'File ' + d.id + ' :: ' + e.name + ': ' + e.message });
                }
            }
            jsonOut(res, out);
        } catch (e) {
            log.error({ title: 'queue edit failed', details: e.name + ': ' + e.message });
            jsonOut(res, { ok: false, error: 'We could not change that order #. Try again.' });
        }
    }

    /** POST mode=queuedel: remove a waiting PDF. Only ever deletes a PDF still waiting in the queue. */
    function handleQueueDelete(req, res) {
        if (req.method !== 'POST') return jsonOut(res, { ok: false, error: 'Use the Missing Invoices tab to make changes.' });
        if (!canUpload()) return jsonOut(res, { ok: false, error: 'You do not have access to change this list.' });

        try {
            var d = loadDoc(req.parameters.id);
            if (!d || d.state !== 'PENDING' || !filterDocs([d]).length) {
                return jsonOut(res, { ok: false, error: 'That PDF is no longer waiting for an invoice.' });
            }
            file.delete({ id: d.id });
            log.audit({
                title: 'queue PDF removed',
                details: AUTH_USER + ' removed file ' + d.id + ' (order # ' + d.order + ')'
            });
            jsonOut(res, { ok: true });
        } catch (e) {
            log.error({ title: 'queue delete failed', details: e.name + ': ' + e.message });
            jsonOut(res, { ok: false, error: 'We could not remove that PDF. Try again.' });
        }
    }

    // ---------- render ----------

    function vendorHref(id) {
        return self() + '&v=' + encodeURIComponent(id) + rangeQs();
    }

    function rangeNote() {
        return rangeActive()
            ? '<div class="nb-info" role="status">Showing invoices dated ' + esc(dateRangeLabel()) + '.</div>'
            : '';
    }

    /** Page numbers to show: first, last and the pages around the current one, with gaps as '...'. */
    function pageNumbers(current, pages) {
        var keep = {};
        [1, pages].forEach(function (n) { keep[n] = true; });
        for (var i = current - 2; i <= current + 2; i++) { if (i >= 1 && i <= pages) keep[i] = true; }
        var nums = Object.keys(keep).map(Number).sort(function (a, b) { return a - b; });
        var out = [];
        nums.forEach(function (n, i) {
            // a gap of one page just shows that page; a longer gap shows ...
            if (i && n - nums[i - 1] === 2) out.push(n - 1);
            else if (i && n - nums[i - 1] > 2) out.push('...');
            out.push(n);
        });
        return out;
    }

    /**
     * Previous / page numbers / Next, a "Page [ ] of N" box and the range shown.
     * base = the URL for this list, without &p=. total = how many results there are.
     */
    function pager(base, total, size) {
        var pages = Math.ceil(total / size);
        if (pages <= 1) return '';

        function link(n, label, cls, current) {
            return current
                ? '<span class="nb-pagenum is-current" aria-current="page">' + label + '</span>'
                : '<a class="' + cls + '" href="' + esc(base + '&p=' + n) + '"'
                  + (cls === 'nb-pagenum' ? ' aria-label="Page ' + n + '"' : '') + '>' + label + '</a>';
        }

        var from = (PAGE - 1) * size + 1;
        var to = Math.min(PAGE * size, total);

        var h = '<nav class="nb-pager" aria-label="Pages">';
        if (PAGE > 1) h += link(PAGE - 1, 'Previous', 'nb-btn nb-btn--secondary');
        pageNumbers(PAGE, pages).forEach(function (n) {
            h += n === '...' ? '<span class="nb-gap" aria-hidden="true">&hellip;</span>' : link(n, n, 'nb-pagenum', n === PAGE);
        });
        if (PAGE < pages) h += link(PAGE + 1, 'Next', 'nb-btn nb-btn--secondary');
        h += '<span class="nb-help nb-pageof">Page <input class="nb-goto" type="number" min="1" max="' + pages
           + '" value="' + PAGE + '" data-base="' + esc(base) + '" aria-label="Go to page"> of ' + pages + '</span>'
           + '<span class="nb-help nb-pageof">Showing ' + from + '&ndash;' + to + ' of ' + total + '</span>'
           + '</nav>';
        return h;
    }

    /** Invoice table. showVendor adds the vendor name for lists that span vendors. */
    /** 1234.5 -> 1,234.50 (anything that is not a number is shown as it came). */
    function money(v) {
        var n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
        if (!isFinite(n)) return String(v == null ? '' : v);
        return (n < 0 ? '-' : '') + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    }

    /** "Showing 1-50 of 594" for a paged list, or "8 invoices" when it all fits on one page. */
    function countLine(total, size) {
        if (!(total > 0)) return '';
        if (total <= size) return total + (total === 1 ? ' invoice' : ' invoices');
        return 'Showing ' + ((PAGE - 1) * size + 1) + '&ndash;' + Math.min(PAGE * size, total) + ' of ' + commas(total);
    }

    /** The Unit # cell: plain text, or with a pencil to change it for people who can. */
    function unitCell(b, editable, markEditable) {
        if (!UNIT_COL) return '';
        var shown = b.unit ? esc(b.unit) : '&mdash;';
        if (!editable || !/^\d+$/.test(String(b.id))) return '<td>' + shown + '</td>';
        markEditable();
        return '<td class="nb-unitcell" data-bill="' + esc(b.id) + '" data-unit="' + esc(b.unit) + '">'
             + '<span class="nb-unitval">' + shown + '</span>'
             + '<button type="button" class="nb-iconbtn-sm nb-unitedit" data-unit-edit="1" aria-label="Edit unit #" title="Edit unit #">' + ICON_PENCIL + '</button></td>';
    }

    function billsTable(bills, showVendor, paging, sortCtx) {
        var links = nsLinksOn();   // Order # links into NetSuite only for people who can open it
        var drop = canUpload();    // people who can upload may drop a PDF on an invoice that has none
        var anyDrop = false;
        var canUnit = !!UNIT_COL && canUpload();   // ...and change an invoice's unit #
        var anyUnit = false;

        function th(label, key, cls) { return sortHeader(label, key, sortCtx, cls); }
        var h = '<div class="nb-scroll"><table class="nb-table nb-bills"><thead><tr>'
              + th('Vendor ID', 'vendorid') + (showVendor ? th('Vendor', 'vendor') : '')
              + th('Date', 'date') + th('Order #', 'order') + th('Invoice #', 'invoice') + (UNIT_COL ? th('Unit #', 'unit') : '')
              + th('Amount', 'amount', 'nb-num')
              + '<th>Status</th><th>Document</th></tr></thead><tbody>';

        bills.forEach(function (b) {
            var hasFiles = b.files.length > 0;
            var accepts = drop && !hasFiles && /^\d+$/.test(String(b.id));
            if (accepts) anyDrop = true;

            var cell = hasFiles
                ? b.files.map(function (f) {
                      return '<a target="_blank" rel="noopener" href="' + esc(self()) + '&mode=file&id='
                           + esc(f.id) + '&bill=' + esc(b.id) + '">'
                           + esc(f.name || 'View') + '</a>';
                  }).join('<br>')
                : accepts
                    ? '<div class="nb-dropbox nb-dropbox--row"><button type="button" class="nb-btn nb-btn--secondary nb-attachbtn">Attach invoice</button>'
                      + '<span class="nb-dropbox-text">No file chosen</span></div>'
                    : '<span class="nb-nodoc">Not attached</span>';
            if (accepts) cell += '<div class="nb-attachnote" role="status"></div>';

            // On a list that spans vendors the ID links to that vendor's invoices.
            var vid = !b.vendorid ? '&mdash;'
                    : showVendor ? '<a href="' + esc(vendorHref(b.vendorid)) + '">' + esc(b.vendorid) + '</a>'
                    : esc(b.vendorid);

            h += '<tr' + (accepts ? ' class="nb-droprow" data-bill="' + esc(b.id) + '" data-order="' + esc(b.tranid) + '"' : '') + '><td>' + vid + '</td>'
               + (showVendor ? '<td class="nb-vname">' + (b.vendorname ? esc(b.vendorname) : '&mdash;') + '</td>' : '')
               + '<td>' + esc(b.date) + '</td>'
               + '<td class="nb-strong">' + (links && /^\d+$/.test(String(b.id))
                    ? '<a href="' + esc(billUrl(b.id)) + '" target="_blank" rel="noopener noreferrer" title="Open in NetSuite">'
                      + esc(b.tranid) + '</a>'
                    : esc(b.tranid)) + '</td>'
               + '<td>' + (b.ref ? esc(b.ref) : '&mdash;') + '</td>'
               + unitCell(b, canUnit, function () { anyUnit = true; })
               + '<td class="nb-num">' + esc(money(b.amount)) + '</td>'
               + '<td>' + esc(b.status) + '</td>'
               + '<td class="nb-doccell">' + cell + '</td></tr>';
        });

        if (anyDrop) HAS_DROP = true;
        if (anyUnit) HAS_UNIT = true;
        // One quiet line above the table: how many there are, and (for people who can) how to attach.
        var count = paging ? countLine(paging.total, paging.size) : '';
        var bar = (count || anyDrop)
            ? '<div class="nb-tablebar">' + (count ? '<span class="nb-count">' + count + '</span>' : '')
              + (anyDrop ? '<span class="nb-drophint">' + (PREVIEW_ON_DROP ? 'Drop a PDF onto an invoice to check it, add notes and attach it.'
                                                                     : 'Drop a PDF onto an invoice to attach it.') + '</span>' : '') + '</div>'
            : '';
        return bar + h + '</tbody></table></div>';
    }

    /** PDFs that are in the lookup but whose invoice has not reached NetSuite yet. */
    function waitingTable(waiting) {
        var h = '<h2 class="nb-headline nb-h5 nb-sechead">Waiting for an invoice</h2>'
              + '<div class="nb-scroll"><table class="nb-table"><thead><tr>'
              + '<th>Order #</th>' + (UNIT_COL ? '<th>Unit #</th>' : '')
              + '<th>File</th><th>Uploaded date</th><th>Status</th></tr></thead><tbody>';
        waiting.forEach(function (r) {
            h += '<tr><td class="nb-strong">' + esc(r.order) + '</td>'
               + (UNIT_COL ? '<td>' + (r.unit ? esc(r.unit) : '&mdash;') + '</td>' : '')
               + '<td><a target="_blank" rel="noopener" href="' + esc(self()) + '&mode=file&id=' + r.id + '">' + esc(r.name) + '</a></td>'
               + '<td>' + esc(r.created) + '</td>'
               + '<td>Not in NetSuite yet</td></tr>';
        });
        return h + '</tbody></table></div>';
    }

    /** One vendor's invoices. data = { bills, total }; term prefills the search box. */
    function renderList(vendor, data, term) {
        var base = self() + '&v=' + encodeURIComponent(vendor.entityid) + rangeQs();
        var sortCtx = { base: base, allowed: SORT_VENDOR, active: sortFor(SORT_VENDOR) || { key: 'date', dir: 'desc' } };
        var pagerBase = base + sortQs(SORT_VENDOR);

        var h = searchBox(term || vendor.entityid)
              + (vendor.name
                  ? '<div class="nb-overline">' + esc(vendor.entityid) + '</div>'
                    + '<h1 class="nb-headline nb-h1">' + esc(vendor.name) + '</h1>'
                  : '<h1 class="nb-headline nb-h1">' + esc(vendor.entityid) + '</h1>')
              + rangeNote()
              + '<h2 class="nb-headline nb-h5 nb-sechead">Invoices</h2>'
              + (data.bills.length
                  ? billsTable(data.bills, false, { total: data.total, size: MAX_BILLS }, sortCtx) + pager(pagerBase, data.total, MAX_BILLS)
                  : '<p class="nb-lead">' + (rangeActive()
                        ? 'No invoices for this vendor in that date range.'
                        : 'No invoices on file for this vendor.') + '</p>');

        return page(h, searchScript());
    }

    /**
     * Search results: matching vendors and/or matching invoices. An empty term
     * means a date-only search: every invoice in the range, across vendors.
     */
    function renderResults(term, by, vendors, bills, total, waiting) {
        waiting = waiting || [];
        var dateOnly = !term;
        var base = self() + '&s=' + encodeURIComponent(term) + rangeQs();
        // A term search lists best matches first until a column is chosen; a date-only list is newest first.
        var sortCtx = { base: base, allowed: SORT_RESULTS, active: sortFor(SORT_RESULTS) || (dateOnly ? { key: 'date', dir: 'desc' } : null) };
        var pagerBase = base + sortQs(SORT_RESULTS);

        var h = searchBox(term);
        if (dateOnly) {
            h += '<div class="nb-overline">Invoices</div>'
               + '<h1 class="nb-headline nb-h2">Invoices dated <span class="nb-keep">'
               + esc(dateRangeLabel()) + '</span></h1>';
        } else {
            h += '<div class="nb-overline">Search results</div>'
               + '<h1 class="nb-headline nb-h2">Results for <span class="nb-keep">&ldquo;'
               + esc(term) + '&rdquo;</span></h1>'
               + rangeNote();
        }

        if (vendors.length && PAGE === 1) {
            h += '<h2 class="nb-headline nb-h5 nb-sechead">Vendors</h2>'
               + '<div class="nb-scroll"><table class="nb-table"><thead><tr>'
               + '<th>Vendor ID</th><th>Name</th></tr></thead><tbody>';
            vendors.forEach(function (v) {
                h += '<tr><td class="nb-strong"><a href="' + esc(vendorHref(v.entityid))
                   + '">' + esc(v.entityid) + '</a></td><td>' + esc(v.name) + '</td></tr>';
            });
            h += '</tbody></table></div>';
        }

        if (by !== 'vendor') {
            // With PDFs waiting but no invoice, an empty "Invoices" section would only confuse.
            if (!dateOnly && (bills.length || !waiting.length)) h += '<h2 class="nb-headline nb-h5 nb-sechead">Invoices</h2>';
            if (bills.length) {
                h += billsTable(bills, true, { total: total, size: MAX_BILLS }, sortCtx) + pager(pagerBase, total, MAX_BILLS);
            } else if (!waiting.length) {
                h += '<p class="nb-lead">' + (dateOnly
                    ? 'No invoices in that date range.'
                    : 'No invoices matched. Try fewer characters.') + '</p>';
            }
        }

        if (waiting.length && PAGE === 1) h += waitingTable(waiting);

        return page(h, searchScript());
    }

    /** A single bill, reached from a type-ahead suggestion. */
    function renderBill(bill) {
        var h = searchBox(bill.tranid)
              + (bill.vendorid ? '<div class="nb-overline">' + esc(bill.vendorid) + '</div>' : '')
              + '<h1 class="nb-headline nb-h2">Order # <span class="nb-keep">' + esc(bill.tranid) + '</span></h1>'
              + billsTable([bill], true)
              + (bill.vendorid
                  ? '<div class="nb-actions"><a class="nb-btn nb-btn--secondary" href="' + esc(self())
                    + '&v=' + encodeURIComponent(bill.vendorid) + '">All invoices for '
                    + esc(bill.vendorid) + '</a></div>'
                  : '');
        return page(h, searchScript());
    }

    // ---------- missing documents ----------

    var MISSING_CACHE = 'NTS_VENDOR_DOC_MISSING';
    var MISSING_KEY = 'count';
    var MISSING_COUNT = null;

    var MISSING_USE_IDS = false;   // set when NetSuite refuses the vendor-category join; then vendor ids are used instead
    var GROUP_VENDOR_IDS = null;

    /** Ids of the vendors in the group in effect (the fallback way to limit the Missing documents search). */
    function groupVendorIds() {
        if (GROUP_VENDOR_IDS !== null) return GROUP_VENDOR_IDS;
        GROUP_VENDOR_IDS = query.runSuiteQL({
            query: 'SELECT id FROM vendor WHERE category IN (' + qmarks(currentCategoryIds().length) + ') ORDER BY id',
            params: currentCategoryIds()
        }).asMappedResults().map(function (r) { return Number(r.id); });
        return GROUP_VENDOR_IDS;
    }

    /** Vendor bills with no document, of the vendors in the group in effect: the filters every view of this list starts from. */
    function missingBaseFilters() {
        var inGroup;
        if (MISSING_USE_IDS) {
            var ids = groupVendorIds();
            inGroup = ['entity', 'anyof', ids.length ? ids : [0]];
        } else {
            inGroup = ['vendor.category', 'anyof', currentCategoryIds()];
        }
        var out = [['mainline', 'is', 'T'], 'AND', ['type', 'anyof', 'VendBill'],
                   'AND', ['file.internalid', 'anyof', '@NONE@'], 'AND', inGroup];
        var subs = scopeSubs();
        if (subs) out.push('AND', ['subsidiary', 'anyof', subs.length ? subs : ['@NONE@']]);
        return out;
    }

    /**
     * Runs a Missing documents search. The first time NetSuite refuses the vendor-category filter
     * it is logged and the search is repeated limited to the group's vendor ids instead.
     */
    function withGroupFilter(fn) {
        try {
            return fn();
        } catch (e) {
            if (MISSING_USE_IDS) throw e;
            log.error({ title: 'missing list group filter failed', details: e.name + ': ' + e.message });
            MISSING_USE_IDS = true;
            return fn();
        }
    }

    /** Counts every bill with no document in the group, right now (a full search; use missingCount()). */
    function countMissingNow() {
        return withGroupFilter(function () {
            return search.create({
                type: 'transaction',
                filters: missingBaseFilters(),
                columns: ['internalid']
            }).runPaged({ pageSize: 5 }).count;
        });
    }

    /** The number shown on the Missing documents tab; remembered for MISSING_COUNT_TTL seconds. */
    function missingCount() {
        if (MISSING_COUNT !== null) return MISSING_COUNT;
        MISSING_COUNT = 0;
        try {
            var c = cache.getCache({ name: MISSING_CACHE, scope: cache.Scope.PRIVATE });
            var gen = c.get({ key: MISSING_KEY + ':gen', ttl: MISSING_COUNT_TTL * 12, loader: function () { return '0'; } });
            var subs = scopeSubs();
            MISSING_COUNT = Number(c.get({
                key: MISSING_KEY + ':' + gen + ':' + GROUP + ':' + (subs ? subs.slice().sort(function (a, b) { return a - b; }).join('-') : 'all'),
                ttl: MISSING_COUNT_TTL,
                loader: function () { return String(countMissingNow()); }
            })) || 0;
        } catch (e) {
            log.error({ title: 'missing count (cached) failed', details: e.name + ': ' + e.message });
            try { MISSING_COUNT = Number(countMissingNow()) || 0; }
            catch (e2) { log.error({ title: 'missing count failed', details: e2.name + ': ' + e2.message }); }
        }
        return MISSING_COUNT;
    }

    /** Forget the remembered number, after a PDF was attached through the lookup. */
    function forgetMissingCount() {
        try {
            // Each group and each set of subsidiaries has its own number, so start a new generation.
            var c = cache.getCache({ name: MISSING_CACHE, scope: cache.Scope.PRIVATE });
            c.put({ key: MISSING_KEY + ':gen', value: String(new Date().getTime()), ttl: MISSING_COUNT_TTL * 12 });
        } catch (e) { /* not worth failing an attach over */ }
    }

    /**
     * One page of vendor bills that have no document attached: { bills, total }.
     * NetSuite finds them with the transaction search's file join ("file internal id is
     * none"). The optional term narrows it to bills matching a vendor, order #, invoice # or
     * unit #; those matches come from SuiteQL, and the search then keeps the ones with no file.
     */
    function findMissing(term) {
        var termGroup = null;

        if (term) {
            var ids = matchBills(term, 'all', 500, 0).map(function (r) { return Number(r.id); });
            var vendorIds = queryVendors(term, 25).map(function (r) { return Number(r.id); });

            var group = [];
            if (ids.length) group.push(['internalid', 'anyof', ids]);
            if (vendorIds.length) {
                if (group.length) group.push('OR');
                group.push(['entity', 'anyof', vendorIds]);
            }
            if (!group.length) return { bills: [], total: 0 };
            termGroup = group;
        }

        var paged = withGroupFilter(function () {
            var filters = missingBaseFilters().concat(dateFilters('trandate'));
            if (termGroup) filters.push('AND', termGroup);
            return search.create({
                type: 'transaction',
                filters: filters,
                columns: billColumns(sortFor(SORT_MISSING))
            }).runPaged({ pageSize: MISSING_PAGE_SIZE });
        });

        var total = paged.count;
        clampPage(total, MISSING_PAGE_SIZE);
        var rows = total ? paged.fetch({ index: PAGE - 1 }).data : [];
        return { bills: decorateBills(rows.map(mapBill), true), total: total };
    }

    // ---------- invoice uploads: pages ----------

    /** The Missing documents tab: invoices in NetSuite that have no PDF attached. */
    function missingPage(term) {
        TAB = 'missing';

        var data = null;
        try {
            data = findMissing(term);
        } catch (e) {
            log.error({ title: 'missing documents list failed', details: e.name + ': ' + e.message });
        }
        if (!data) {
            return page(searchBox(term)
                      + '<div class="nb-info" role="alert">We could not load this list. Try again, and tell Accounting if it keeps happening.</div>',
                        searchScript(self() + '&tab=missing', false));
        }

        var base = self() + '&tab=missing&s=' + encodeURIComponent(term) + rangeQs();
        var sortCtx = { base: base, allowed: SORT_MISSING, active: sortFor(SORT_MISSING) || { key: 'date', dir: 'desc' } };
        var pagerBase = base + sortQs(SORT_MISSING);

        // Unfiltered, this list's total IS the number of bills missing a document, so the tab
        // badge can show it fresh. With a search or dates set, the badge keeps the overall count.
        if (!term && !rangeActive()) MISSING_COUNT = data.total;

        var h = searchBox(term)
              + rangeNote()
              + '<h2 class="nb-headline nb-h5 nb-sechead nb-sechead--first">Invoices missing a document</h2>';

        if (!data.bills.length) {
            h += '<p class="nb-lead">' + (PAGE > 1 ? 'There are no more invoices to show.'
                 : (term || rangeActive()) ? 'Every invoice that matches has a document attached.'
                 : 'Every invoice has a document attached.') + '</p>';
        } else {
            h += billsTable(data.bills, true, { total: data.total, size: MISSING_PAGE_SIZE }, sortCtx) + pager(pagerBase, data.total, MISSING_PAGE_SIZE);
        }

        // Stay on this tab when searching; the dropdown is for the Search tab.
        return page(h, searchScript(self() + '&tab=missing', false));
    }

    /** Browser script for the Upload tab. BASE and MAXB are defined ahead of it. */
    var UPLOAD_JS = `
var drop=document.getElementById("drop"),input=document.getElementById("files"),list=document.getElementById("list"),
go=document.getElementById("go"),clr=document.getElementById("clr"),sum=document.getElementById("sum"),pick=document.getElementById("pick");
var rows=[],busy=false,finished=false;
var UNIT_RE=/^[A-Za-z0-9][A-Za-z0-9 _/.-]{0,19}$/;
var ORDER_RE=/^[A-Za-z0-9][A-Za-z0-9 _/.-]{1,39}$/;
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function fmt(n){return n<1024?n+" B":n<1048576?Math.round(n/1024)+" KB":(n/1048576).toFixed(1)+" MB";}
function guess(name){var m=/([A-Za-z]{2,4})-?([0-9]{5,})/.exec(name);return m?(m[1]+"-"+m[2]).toUpperCase():"";}
function okOrder(v){return ORDER_RE.test(String(v||"").replace(/ +/g," ").trim());}
function okUnit(v){v=String(v||"").replace(/ +/g," ").trim();return v===""||UNIT_RE.test(v);}
function editable(r){return r.state==="ready"||r.state==="failed";}
function counts(){var c={ready:0,missing:0,badUnit:0};rows.forEach(function(r){if(editable(r)){c.ready++;if(!okOrder(r.order))c.missing++;if(UNITS&&!okUnit(r.unit))c.badUnit++;}});return c;}
function refresh(){
  var c=counts();
  go.disabled=busy||c.ready===0||c.missing>0||c.badUnit>0;
  go.textContent=c.ready?"Upload "+c.ready+(c.ready===1?" invoice":" invoices"):"Upload";
  clr.hidden=!rows.length||busy;
  if(finished||busy)return;
  var g=rows.some(function(r){return r.guessed&&editable(r);});
  sum.textContent=!c.ready?"":c.missing?"Add an order # to every file to continue.":c.badUnit?"Check the unit #. Use up to 20 letters, numbers, dashes or slashes.":g?"We guessed some order #s from the file names. Check each one before you upload.":"";
}
function stateHtml(r){
  if(r.state==="uploading")return "Uploading...";
  if(r.state==="done")return esc(r.msg)+(r.link?' <a href="'+esc(r.link)+'">View invoice</a>':"");
  if(r.state==="error"||r.state==="failed")return '<span class="nb-state-error">'+esc(r.msg)+'</span>';
  return "Ready";
}
function draw(){
  if(!rows.length){list.innerHTML="";refresh();return;}
  var h='<div class="nb-scroll"><table class="nb-table"><thead><tr><th>File</th><th>Size</th><th>Order #</th>'+(UNITS?'<th>Unit #</th>':'')+'<th>Status</th><th></th></tr></thead><tbody>';
  rows.forEach(function(r,i){
    var notes=r.marks.length?'<span class="nb-notecount">'+r.marks.length+(r.marks.length===1?" note":" notes")+' added</span>':"";
    var name=canView(r)?'<button type="button" class="nb-linkbtn vw" data-i="'+i+'" title="View and add notes">'+esc(r.file.name)+'</button>':esc(r.file.name);
    h+='<tr><td class="nb-strong">'+name+notes+'</td><td>'+fmt(r.file.size)+'</td><td>'
      +(editable(r)?'<input class="nb-input nb-input--sm ord" data-i="'+i+'" value="'+esc(r.order)+'" placeholder="Order #" aria-label="Order # for '+esc(r.file.name)+'">':esc(r.order))
      +'</td>'+(UNITS?'<td>'+(editable(r)?'<input class="nb-input nb-input--sm unit" data-i="'+i+'" value="'+esc(r.unit)+'" placeholder="Optional" aria-label="Unit # for '+esc(r.file.name)+'">':esc(r.unit))+'</td>':'')
      +'<td id="st'+i+'">'+stateHtml(r)+'</td><td>'
      +(busy||r.state==="uploading"?"":(canView(r)?'<button type="button" class="nb-btn nb-btn--ghost vw" data-i="'+i+'">View</button>':"")
        +'<button type="button" class="nb-btn nb-btn--ghost rm" data-i="'+i+'">Remove</button>')+'</td></tr>';
  });
  list.innerHTML=h+"</tbody></table></div>";
  refresh();
}
function add(files){
  finished=false;
  var first=-1;
  Array.prototype.forEach.call(files,function(f){
    var r={file:f,order:guess(f.name),unit:"",state:"ready",msg:"",link:"",result:"",marks:[]};
    r.guessed=!!r.order;
    if(!(/[.]pdf$/i.test(f.name)||f.type==="application/pdf")){r.state="error";r.msg="Only PDF files can be uploaded.";r.order="";r.guessed=false;}
    else if(f.size>MAXB){r.state="error";r.msg="This file is over "+fmt(MAXB)+".";}
    rows.push(r);
    if(first<0&&r.state==="ready")first=rows.length-1;
  });
  draw();
  // Show the first new PDF straight away (PREVIEW_ON_DROP), so it can be checked and marked up.
  if(first>=0&&window.PDFV_CFG&&PDFV_CFG.auto)openRow(first);
}
function canView(r){return !!window.NbPdf&&!busy&&editable(r);}
/** Opens a file in the viewer; Next file / Previous file move along the files still to upload. */
function openRow(i){
  if(!window.NbPdf||busy||!rows[i]||!editable(rows[i]))return;
  var list=[];rows.forEach(function(x,k){if(editable(x))list.push(k);});
  var pos=list.indexOf(i),r=rows[i],more=pos<list.length-1;
  NbPdf.open({file:r.file,overline:"Upload invoices",title:r.file.name,sub:fmt(r.file.size),
    fields:{order:r.order,unit:r.unit,units:UNITS,okOrder:okOrder},
    nav:list.length>1?{pos:pos+1,count:list.length,prev:pos>0,next:more}:null,
    okLabel:more?"Next file":"Done",cancelLabel:"Close",keepOnCancel:true,marks:r.marks}).then(function(res){
    r.marks=res.marks||[];
    if(res.order!==undefined){
      if(res.order!==r.order){r.order=res.order;r.guessed=false;}
      r.unit=res.unit||"";
    }
    draw();
    if(res.action==="prev"&&pos>0)openRow(list[pos-1]);
    else if((res.action==="next"||res.action==="ok")&&more)openRow(list[pos+1]);
  }).catch(function(){});
}
function toB64(f){
  return new Promise(function(res,rej){
    var fr=new FileReader();
    fr.onload=function(){var s=String(fr.result);res(s.substring(s.indexOf(",")+1));};
    fr.onerror=function(){rej(new Error("We could not read that file."));};
    fr.readAsDataURL(f);
  });
}
function setRow(i){var c=document.getElementById("st"+i);if(c)c.innerHTML=stateHtml(rows[i]);}
function sendOne(r,i){
  r.state="uploading";setRow(i);
  var notes=r.marks&&r.marks.length?r.marks.length:0;
  // A PDF with notes is sent with the notes written into it; one without is sent exactly as dropped.
  return (notes?NbPdf.bake(r.file,r.marks):Promise.resolve(r.file)).then(function(blob){
    if(blob.size>MAXB)throw new Error("With the notes, this PDF is over "+fmt(MAXB)+".");
    return toB64(blob);
  }).then(function(b64){
    var body=new URLSearchParams();body.set("order",r.order);if(UNITS)body.set("unit",String(r.unit||"").replace(/ +/g," ").trim().toUpperCase());body.set("name",r.file.name);body.set("data",b64);
    if(notes)body.set("notes","1");
    return fetch(BASE+"&mode=upload",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()});
  }).then(function(resp){return resp.text();}).then(function(txt){
    var j;try{j=JSON.parse(txt);}catch(e){throw new Error("Your session may have ended. Reload the page and sign in again.");}
    if(!j.ok)throw new Error(j.error||"The upload did not go through.");
    r.state="done";r.msg=j.message||"Uploaded.";r.result=j.state||"queued";r.link=j.billId?BASE+"&b="+encodeURIComponent(j.billId):"";
  }).catch(function(e){r.state="failed";r.msg=e.message||"The upload did not go through.";});
}
function finish(){
  var a=0,q=0,v=0,f=0;
  rows.forEach(function(r){if(r.state==="done"){if(r.result==="matched")a++;else if(r.result==="review")v++;else q++;}else if(r.state==="failed")f++;});
  var p=[];if(a)p.push(a+" attached");if(q)p.push(q+" waiting for an invoice");if(v)p.push(v+" need review");if(f)p.push(f+" did not upload");
  finished=true;
  sum.innerHTML=esc(p.join(", "))+(q||v?' <a href="'+esc(BASE+"&tab=queue")+'">View Missing Invoices</a>':"");
  draw();
}
list.addEventListener("input",function(e){
  var t=e.target;
  if(t.classList&&t.classList.contains("ord")){var r=rows[+t.getAttribute("data-i")];r.order=t.value;r.guessed=false;refresh();}
  else if(t.classList&&t.classList.contains("unit")){rows[+t.getAttribute("data-i")].unit=t.value;refresh();}
});
list.addEventListener("click",function(e){
  var t=e.target;
  if(t.classList&&t.classList.contains("rm")){rows.splice(+t.getAttribute("data-i"),1);draw();}
  else if(t.classList&&t.classList.contains("vw"))openRow(+t.getAttribute("data-i"));
});
go.addEventListener("click",function(){
  if(busy)return;
  var todo=[];rows.forEach(function(r,i){if(editable(r))todo.push(i);});
  if(!todo.length)return;
  busy=true;finished=false;go.disabled=true;
  window.onbeforeunload=function(){return "Uploads are still running.";};
  var n=0;
  function next(){
    if(n>=todo.length){busy=false;window.onbeforeunload=null;finish();return;}
    var i=todo[n++];
    rows[i].order=String(rows[i].order).replace(/ +/g," ").trim().toUpperCase();
    rows[i].unit=String(rows[i].unit||"").replace(/ +/g," ").trim().toUpperCase();
    sum.textContent="Uploading "+n+" of "+todo.length+"...";
    sendOne(rows[i],i).then(next);
  }
  next();
});
clr.addEventListener("click",function(){if(busy)return;rows=[];finished=false;sum.textContent="";draw();});
["dragenter","dragover"].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();e.stopPropagation();drop.classList.add("is-over");});});
["dragleave","drop"].forEach(function(t){drop.addEventListener(t,function(e){e.preventDefault();e.stopPropagation();drop.classList.remove("is-over");});});
drop.addEventListener("drop",function(e){if(e.dataTransfer&&e.dataTransfer.files)add(e.dataTransfer.files);});
window.addEventListener("dragover",function(e){e.preventDefault();});
window.addEventListener("drop",function(e){e.preventDefault();});
pick.addEventListener("click",function(e){if(e&&e.stopPropagation)e.stopPropagation();input.click();});
// The whole zone opens the file picker, not just the button.
drop.addEventListener("click",function(){input.click();});
input.addEventListener("change",function(){add(input.files);input.value="";});
draw();
`;

    /** Browser script for the Missing Invoices tab: change an order # or remove a waiting PDF. */
    var QUEUE_JS = `
var qmsg=document.getElementById("qmsg");
function esc(x){return String(x==null?"":x).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function say(t){qmsg.textContent=t||"";qmsg.hidden=!t;}
function post(mode,params){
  var body=new URLSearchParams();for(var k in params)body.set(k,params[k]);
  return fetch(BASE+"&mode="+mode,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:body.toString()})
    .then(function(r){return r.text();})
    .then(function(t){var j;try{j=JSON.parse(t);}catch(e){throw new Error("Your session may have ended. Reload the page and sign in again.");}
      if(!j.ok)throw new Error(j.error||"That did not go through.");return j;});
}
document.addEventListener("click",function(e){
  var b=e.target.closest?e.target.closest("[data-act]"):null;
  if(!b)return;
  var act=b.getAttribute("data-act"),id=b.getAttribute("data-id");
  say("");
  if(act==="del"){
    if(!window.confirm("Remove this PDF? The file is deleted."))return;
    b.disabled=true;
    post("queuedel",{id:id}).then(function(){location.reload();}).catch(function(err){b.disabled=false;say(err.message);});
  }else if(act==="edit"){
    var oc=document.getElementById("ord"+id),uc=document.getElementById("unit"+id),ac=document.getElementById("act"+id);
    if(!oc||!ac)return;
    oc.setAttribute("data-old",oc.innerHTML);ac.setAttribute("data-old",ac.innerHTML);
    oc.innerHTML='<input class="nb-input nb-input--sm" id="ordin'+id+'" value="'+esc(b.getAttribute("data-order"))+'" aria-label="New order #">';
    if(UNITS&&uc){uc.setAttribute("data-old",uc.innerHTML);uc.innerHTML='<input class="nb-input nb-input--sm" id="unitin'+id+'" value="'+esc(b.getAttribute("data-unit"))+'" placeholder="Optional" aria-label="New unit #">';}
    ac.innerHTML='<div class="nb-editrow"><button type="button" class="nb-btn nb-btn--secondary" data-act="save" data-id="'+id+'">Save</button>'
      +'<button type="button" class="nb-btn nb-btn--ghost" data-act="cancel" data-id="'+id+'">Cancel</button></div>';
    var inp=document.getElementById("ordin"+id);if(inp){inp.focus();inp.select();}
  }else if(act==="cancel"){
    ["ord","unit","act"].forEach(function(p){var c=document.getElementById(p+id);if(c&&c.getAttribute("data-old")!==null)c.innerHTML=c.getAttribute("data-old");});
  }else if(act==="save"){
    var v=document.getElementById("ordin"+id);if(!v)return;
    var params={id:id,order:v.value};
    var uv=document.getElementById("unitin"+id);if(UNITS&&uv)params.unit=uv.value;
    b.disabled=true;
    post("queueedit",params).then(function(){location.reload();}).catch(function(err){b.disabled=false;say(err.message);});
  }
});
`;

    function uploadPage() {
        TAB = 'upload';
        HAS_PDFVIEW = true;
        var h = '<div class="nb-drop" id="drop">'
              + '<div class="nb-drop-title">Drop PDF invoices here</div>'
              + (PREVIEW_ON_DROP ? '<div class="nb-help" style="margin:0">Each PDF opens so you can check it, fill in its order #, and add notes before you upload.</div>' : '')
              + '<div><button id="pick" class="nb-btn nb-btn--secondary" type="button">Choose files</button></div>'
              + '<input type="file" id="files" accept="application/pdf,.pdf" multiple hidden>'
              + '</div>'
              + '<div id="list"></div>'
              + '<div class="nb-uploadbar">'
              + '<button id="go" class="nb-btn nb-btn--primary" type="button" disabled>Upload</button>'
              + '<button id="clr" class="nb-btn nb-btn--ghost" type="button" hidden>Clear list</button>'
              + '<span id="sum" class="nb-help" role="status"></span>'
              + '</div>';
        return page(h, 'var BASE=' + JSON.stringify(self()) + ';var MAXB=' + MAX_UPLOAD_BYTES + ';var UNITS=' + (UNIT_COL ? 'true' : 'false') + ';' + UPLOAD_JS);
    }

    /** "Waiting 3 days" tells people which PDFs are getting old; without an age, the plain wording. */
    function waitingText(age) {
        var n = (age === null || age === undefined || age === '') ? NaN : Math.floor(Number(age));
        if (!isFinite(n) || n < 0) return 'Waiting for invoice';
        return n === 0 ? 'Waiting since today' : 'Waiting ' + n + (n === 1 ? ' day' : ' days');
    }

    /** Orders the waiting PDFs by the chosen column (blanks last, ties keep their upload order). */
    function sortWaiting(rows, so) {
        if (!so) return rows;
        var sign = so.dir === 'asc' ? 1 : -1;
        function val(r) {
            switch (so.key) {
                case 'order':    return String(r.order || '').toUpperCase();
                case 'unit':     return String(r.unit || '').toUpperCase();
                case 'file':     return String(r.name || '').toUpperCase();
                case 'by':       return String(r.by || '').toUpperCase();
                case 'uploaded': return Number(r.id);
                case 'status':   return (r.age === null || r.age === undefined || r.age === '' || !isFinite(Number(r.age))) ? null : Number(r.age);
            }
            return '';
        }
        return rows.map(function (r, i) { return { r: r, i: i, v: val(r) }; }).sort(function (a, b) {
            var an = a.v === null || a.v === '', bn = b.v === null || b.v === '';
            if (an !== bn) return an ? 1 : -1;                // blanks last, whichever way it is sorted
            if (a.v < b.v) return -sign;
            if (a.v > b.v) return sign;
            return a.i - b.i;
        }).map(function (x) { return x.r; });
    }

    function queuePage() {
        TAB = 'queue';
        var q = loadQueue();
        PENDING_COUNT = q.pending.length;   // the tab badge reflects what the sweep just attached

        var h = '<p id="qmsg" class="nb-help nb-state-error" role="alert" hidden></p>';

        if (q.swept) {
            h += '<div class="nb-info" role="status">' + q.swept + (q.swept === 1 ? ' PDF was' : ' PDFs were')
               + ' just attached to invoices that had already arrived.</div>';
        }

        h += '<h2 class="nb-headline nb-h5 nb-sechead nb-sechead--first">Waiting for an invoice</h2>';
        if (!q.pending.length) {
            h += '<p class="nb-lead">Nothing is waiting. Every uploaded PDF is attached.</p>';
        } else {
            // Oldest first until a column is chosen.
            var qCtx = { base: self() + '&tab=queue', allowed: SORT_WAITING, active: sortFor(SORT_WAITING) || { key: 'uploaded', dir: 'asc' } };
            function qth(label, key) { return sortHeader(label, key, qCtx); }
            h += '<div class="nb-scroll"><table class="nb-table"><thead><tr>'
               + qth('Order #', 'order') + (UNIT_COL ? qth('Unit #', 'unit') : '') + qth('File', 'file') + qth('Uploaded by', 'by')
               + qth('Uploaded date', 'uploaded') + qth('Status', 'status') + '<th></th>'
               + '</tr></thead><tbody>';
            sortWaiting(q.pending, sortFor(SORT_WAITING)).forEach(function (r) {
                var status = r.billCount > 1
                    ? 'Needs review. ' + r.billCount + ' invoices use this order #.'
                    : r.billCount === 1 ? 'Invoice found. Reload this page to attach it.'
                    : waitingText(r.age);
                h += '<tr><td class="nb-strong" id="ord' + r.id + '">' + esc(r.order) + '</td>'
                   + (UNIT_COL ? '<td id="unit' + r.id + '">' + (r.unit ? esc(r.unit) : '&mdash;') + '</td>' : '')
                   + '<td><a target="_blank" rel="noopener" href="' + esc(self()) + '&mode=file&id=' + r.id + '">' + esc(r.name) + '</a></td>'
                   + '<td>' + esc(r.by) + '</td><td>' + esc(r.created) + '</td><td>' + esc(status) + '</td>'
                   + '<td id="act' + r.id + '"><button type="button" class="nb-btn nb-btn--ghost" data-act="edit" data-id="' + r.id
                   + '" data-order="' + esc(r.order) + '" data-unit="' + esc(r.unit) + '">Edit</button>'
                   + '<button type="button" class="nb-btn nb-btn--ghost" data-act="del" data-id="' + r.id + '">Remove</button></td></tr>';
            });
            h += '</tbody></table></div>';
        }

        return page(h, 'var BASE=' + JSON.stringify(self()) + ';var UNITS=' + (UNIT_COL ? 'true' : 'false') + ';' + QUEUE_JS);
    }

    // ---------- entry ----------

    function onRequest(context) {
        var req = context.request;
        var res = context.response;

        LINK_BASE = buildLinkBase(req);

        // Start every request clean, so nothing from an earlier one (another person's
        // permissions, a stale queue count) can carry over.
        AUTH_CAN_UPLOAD = true;
        AUTH_NS = false;
        AUTH_SCOPE = null;
        ALLOWED_GROUPS = null;
        VENDOR_SUB_SIMPLE = false;
        NS_HOST = null;
        MISSING_COUNT = null;
        SCAN_FOLDER_IDS = null;
        GROUP_IDS = {};
        GROUP_VENDOR_IDS = null;
        MISSING_USE_IDS = false;
        GROUP_UI = false;
        GROUP_BASE = '';
        AUTH_LOOKUP_FAILED = false;
        HAS_DROP = false;
        HAS_UNIT = false;
        HAS_PDFVIEW = false;
        TOGGLE_IN_SEARCH = false;
        TAB = 'search';
        PENDING_COUNT = null;
        FOLDER_ID = 0;

        // Is the Unit # field in this account? (See UNIT_COL above.)
        UNIT_COL = resolveUnitColumn();
        initSortKeys();

        // --- brand fonts ---
        // Only the files named in BRAND_FILES can be served, never a path or id from the URL.
        // The fonts are licensed for internal use, so they require a signed-in person.
        // Not logged: one page load can request several of these.
        if (req.parameters.mode === 'brand') {
            var bKey = String(req.parameters.n || '');
            var bId = BRAND_FILES.hasOwnProperty(bKey) ? BRAND_FILES[bKey] : '';

            if (bId && REQUIRE_LOGIN && !userFromCookie(req)) bId = 0;
            if (!bId) { res.write(notFound()); return; }

            try {
                res.setHeader({ name: 'Cache-Control', value: 'private, max-age=86400' });
                res.writeFile({ file: file.load({ id: bId }), isInline: true });
            } catch (e) {
                log.error({ title: 'brand file failed', details: bKey + ' :: ' + e.message });
                res.write(notFound());
            }
            return;
        }

        // --- PDF viewer libraries ---
        // Only the files named in PDF_TOOL_FILES can be served, never a path or id from the URL,
        // and only to a signed-in person. Not logged: the viewer asks for these on first use.
        if (req.parameters.mode === 'lib') {
            var lKey = String(req.parameters.n || '');
            var lPath = PDF_TOOL_FILES.hasOwnProperty(lKey) ? PDF_TOOL_FILES[lKey] : '';

            if (lPath && REQUIRE_LOGIN && !userFromCookie(req)) lPath = '';
            if (!lPath) { res.write(notFound()); return; }

            try {
                var lFile = file.load({ id: lPath });
                res.setHeader({ name: 'Content-Type', value: 'text/javascript; charset=utf-8' });
                res.setHeader({ name: 'Cache-Control', value: 'private, max-age=86400' });
                res.write(lFile.getContents());
            } catch (e) {
                log.error({ title: 'pdf tool file failed', details: lKey + ' (' + lPath + ') :: ' + e.message });
                res.write(notFound());
            }
            return;
        }

        DATE_FROM = validIso(req.parameters.from) ? req.parameters.from : '';
        DATE_TO   = validIso(req.parameters.to)   ? req.parameters.to   : '';

        var pn = parseInt(req.parameters.p, 10);
        PAGE = (pn > 0 && pn < 1000) ? pn : 1;

        var sk = String(req.parameters.sort || '');
        SORT_KEY = SORT_KEYS.indexOf(sk) >= 0 ? sk : '';
        SORT_DIR = req.parameters.dir === 'asc' ? 'asc' : 'desc';

        // Which vendors' invoices (AP or TMT) this request is about: &group=, else the choice
        // this browser saved, else the default. A choice made in the address is saved.
        var picked = pickGroup(req);
        GROUP = picked.key;
        var groupChosen = picked.chosen;

        // Logged on EVERY request, including a bare page load. Without this, an
        // empty execution log is ambiguous: it could mean the request was
        // rejected before the script ran, or that it was served fine.
        log.audit({
            title: 'request',
            details: 'user=' + (AUTH_USER || '?')
                   + ' mode=' + (req.parameters.mode || 'page')
                   + ' v=' + (req.parameters.v || '')
                   + ' s=' + (req.parameters.s || '')
                   + ' b=' + (req.parameters.b || '')
                   + ' id=' + (req.parameters.id || '')
                   + ' range=' + (DATE_FROM || '*') + '..' + (DATE_TO || '*')
                   + ' group=' + GROUP
                   + ' ip=' + req.clientIpAddress
        });

        // --- sign out ---
        if (req.parameters.mode === 'logout') {
            clearAuthCookie(res);
            res.write(page('<h1 class="nb-headline nb-h2">You are signed out.</h1>'
                         + '<p class="nb-lead">Sign back in whenever you are ready.</p>'
                         + '<a class="nb-btn nb-btn--primary" href="' + esc(self()) + '">Sign in again</a>'));
            return;
        }

        // --- access gate ---
        if (REQUIRE_LOGIN) {
            AUTH_USER = userFromCookie(req);

            // Someone submitting a brand-new passcode for themselves.
            if (!AUTH_USER && req.parameters.newcode) {
                var pwEmail = (req.parameters.email || '').trim();
                var pw1 = req.parameters.newcode || '';
                var pw2 = req.parameters.newcode2 || '';
                var pwEmp = authorizedEmployee(pwEmail);

                if (!pwEmp) {
                    log.audit({ title: 'sign-in refused', details: pwEmail + ' from ' + req.clientIpAddress });
                    res.write(loginPage(AUTH_LOOKUP_FAILED ? LOGIN_UNAVAILABLE : 'We could not match those details. Check your email and passcode, then try again.', pwEmail));
                    return;
                }
                // Never let this path overwrite a passcode the person chose. The one exception is
                // replacing a TEMPORARY passcode, and only with proof it was just accepted.
                var tmpProof = '';
                var replacingTemp = false;
                if (pwEmp.code) {
                    if (isHashedCode(pwEmp.code)) {
                        res.write(loginPage('A passcode is already set for that address.', pwEmail));
                        return;
                    }
                    if (!tempProofValid(pwEmp.id, pwEmp.code, req.parameters.tmpproof)) {
                        res.write(loginPage('That temporary passcode has expired. Sign in again with it to choose your new passcode.', pwEmail));
                        return;
                    }
                    tmpProof = String(req.parameters.tmpproof);
                    replacingTemp = true;
                }
                if (pw1.length < MIN_PW) {
                    res.write(setPasswordPage(pwEmail, 'Passcode must be at least ' + MIN_PW + ' characters.', tmpProof));
                    return;
                }
                if (pw1 !== pw2) {
                    res.write(setPasswordPage(pwEmail, 'Those passcodes did not match.', tmpProof));
                    return;
                }
                if (replacingTemp && safeEqual(pw1, String(pwEmp.code).trim())) {
                    res.write(setPasswordPage(pwEmail, 'Choose a passcode that is different from the temporary one.', tmpProof));
                    return;
                }

                try {
                    savePasscode(pwEmp.id, pw1);
                } catch (e) {
                    log.error({ title: 'passcode save failed', details: e.name + ': ' + e.message });
                    res.write(setPasswordPage(pwEmail, 'Could not save that passcode. Contact Accounting.', tmpProof));
                    return;
                }

                pwEmp.code = hashCode(pw1);
                setAuthCookie(res, pwEmp);
                AUTH_USER = pwEmp.name || pwEmp.email;
                AUTH_CAN_UPLOAD = pwEmp.canUpload;
                AUTH_NS = pwEmp.netsuite;
                AUTH_SCOPE = pwEmp.scope;
                log.audit({ title: 'passcode set', details: AUTH_USER + ' from ' + req.clientIpAddress + (replacingTemp ? ' (replaced a temporary passcode)' : '') });
            }

            // Normal sign-in.
            if (!AUTH_USER && req.parameters.email) {
                var email = (req.parameters.email || '').trim();
                var given = (req.parameters.code || '').trim();
                var emp = authorizedEmployee(email);

                // Same message whether the address is unknown or unauthorized,
                // so this can't be used to probe who works here.
                if (!emp) {
                    log.audit({ title: 'sign-in refused', details: email + ' from ' + req.clientIpAddress });
                    res.write(loginPage(AUTH_LOOKUP_FAILED ? LOGIN_UNAVAILABLE : 'We could not match those details. Check your email and passcode, then try again.', email));
                    return;
                }

                // Authorized but no passcode yet -- let them choose one.
                if (!emp.code) {
                    res.write(setPasswordPage(email, ''));
                    return;
                }

                // A temporary passcode does not sign anyone in: it only unlocks choosing a new one.
                if (!isHashedCode(emp.code) && tempCodeMatches(emp.code, given)) {
                    log.audit({ title: 'temporary passcode accepted', details: email + ' from ' + req.clientIpAddress });
                    res.write(setPasswordPage(email, '', tempProof(emp.id, emp.code, new Date().getTime() + TEMP_PASSCODE_MINUTES * 60000)));
                    return;
                }

                if (!codeMatches(emp.code, given)) {
                    log.audit({ title: 'bad passcode', details: email + ' from ' + req.clientIpAddress });
                    res.write(loginPage('We could not match those details. Check your email and passcode, then try again.', email));
                    return;
                }

                setAuthCookie(res, emp);
                AUTH_USER = emp.name || emp.email;
                AUTH_CAN_UPLOAD = emp.canUpload;
                AUTH_NS = emp.netsuite;
                AUTH_SCOPE = emp.scope;
                log.audit({ title: 'signed in', details: AUTH_USER + ' from ' + req.clientIpAddress });
            }

            if (!AUTH_USER) {
                res.write(loginPage('', ''));
                return;
            }
        }

        // --- what this person may see (FLD_SUBS / FLD_GROUPS) ---
        if (scopeEmpty()) {
            log.audit({ title: 'no invoice access', details: AUTH_USER + ' signed in but has no subsidiaries or groups' });
            if (req.parameters.mode && req.parameters.mode !== 'page') {
                res.setHeader({ name: 'Content-Type', value: 'application/json' });
                res.write(JSON.stringify({ ok: false, error: 'Your access does not include any invoices yet.' }));
            } else {
                res.write(page('<div class="nb-overline">Access</div>'
                             + '<h1 class="nb-headline nb-h2">You do not have access to any invoices yet.</h1>'
                             + '<p class="nb-lead">Your sign-in works, but no subsidiaries or invoice groups (AP, TMT) are set for you. Please tell IT or Accounting.</p>'
                             + '<a class="nb-btn nb-btn--secondary" href="' + esc(self() + '&mode=logout') + '">Sign out</a>'));
            }
            return;
        }
        // A group this person may not see falls back to the first one they may; only their own choice is saved.
        if (groupChoices().indexOf(GROUP) < 0) {
            var dflt = String(DEFAULT_VENDOR_GROUP || '').toUpperCase();
            GROUP = groupChoices().indexOf(dflt) >= 0 ? dflt : allowedGroupKeys()[0];
            groupChosen = false;
        }
        if (groupChosen && cookieValue(req, GROUP_COOKIE_NAME).toUpperCase() !== GROUP) setGroupCookie(res, GROUP);

        // --- AP / TMT toggle ---
        // Pages and suggestion feeds that show invoices need the group's vendor category. If it
        // cannot be found the person gets a readable page (or JSON error) saying which one.
        var gMode = req.parameters.mode;
        var gTab = req.parameters.tab;
        if ((!gMode || gMode === 'suggest' || gMode === 'vendors') && gTab !== 'upload' && gTab !== 'queue') {
            try {
                currentCategoryIds();
            } catch (e) {
                log.error({ title: 'vendor group lookup failed', details: e.name + ': ' + e.message });
                if (gMode) {
                    res.setHeader({ name: 'Content-Type', value: 'application/json' });
                    res.write(JSON.stringify({ error: e.message }));
                } else {
                    res.write(groupErrorPage(e.message));
                }
                return;
            }
            if (!gMode) {
                GROUP_UI = true;
                // The toggle keeps the page you are on (search, dates, tab); a single vendor or
                // invoice goes back to the search page, since it belongs to one group.
                var gTerm = String(req.parameters.s || '').trim();
                GROUP_BASE = self() + ((req.parameters.v || req.parameters.b) ? '' :
                    ((gTab === 'missing' ? '&tab=missing' : '')
                   + (gTerm ? '&s=' + encodeURIComponent(gTerm) : '')
                   + (req.parameters.by ? '&by=' + encodeURIComponent(String(req.parameters.by)) : '')
                   + rangeQs()));
            }
        }

        // --- invoice upload + queue ---
        if (req.parameters.mode === 'upload')    { handleUpload(req, res);      return; }
        if (req.parameters.mode === 'attach')    { handleAttach(req, res);      return; }
        if (req.parameters.mode === 'unit')      { handleUnit(req, res);        return; }
        if (req.parameters.mode === 'queueedit') { handleQueueEdit(req, res);   return; }
        if (req.parameters.mode === 'queuedel')  { handleQueueDelete(req, res); return; }
        if (req.parameters.tab === 'upload' || req.parameters.tab === 'queue' || req.parameters.tab === 'missing') {
            if (!canUpload()) { res.write(notFound()); return; }
            if (req.parameters.tab === 'missing') {
                res.write(missingPage(String(req.parameters.s || '').trim()));
            } else {
                res.write(req.parameters.tab === 'upload' ? uploadPage() : queuePage());
            }
            return;
        }

        // --- type-ahead JSON ---
        if (req.parameters.mode === 'vendors') {
            var term = (req.parameters.q || '').trim();
            res.setHeader({ name: 'Content-Type', value: 'application/json' });
            if (term.length < 2) {
                res.write('[]');
                return;
            }
            try {
                res.write(JSON.stringify(suggestVendors(term)));
            } catch (e) {
                log.error({ title: 'vendor suggest failed', details: e.name + ': ' + e.message });
                res.write(JSON.stringify({ error: e.name + ': ' + e.message }));
            }
            return;
        }

        // --- type-ahead JSON: vendors + invoices ---
        if (req.parameters.mode === 'suggest') {
            var sterm = (req.parameters.q || '').trim();
            res.setHeader({ name: 'Content-Type', value: 'application/json' });
            if (sterm.length < 2) {
                res.write('[]');
                return;
            }
            try {
                res.write(JSON.stringify(suggestAll(sterm, cleanBy(req.parameters.by))));
            } catch (e) {
                log.error({ title: 'suggest failed', details: e.name + ': ' + e.message });
                res.write(JSON.stringify({ error: e.name + ': ' + e.message }));
            }
            return;
        }

        // --- diagnostic: which attachment read method works? ---
        if (req.parameters.mode === 'diag') {
            if (scoped()) {
                res.setHeader({ name: 'Content-Type', value: 'application/json' });
                res.write(JSON.stringify({ error: 'Not available with limited access.' }));
                return;
            }
            var bid = req.parameters.bill
                   || (req.parameters.tran ? billIdFromTranId(req.parameters.tran) : null);
            var out = { billId: bid, resolvedFrom: req.parameters.tran || 'bill param' };

            if (!bid) {
                out.error = 'could not resolve a bill';
            } else {
                [['A_recordApi', attachViaRecord],
                 ['B_searchJoin', attachViaSearch],
                 ['C_suiteQL', attachViaQuery]].forEach(function (m) {
                    try {
                        out[m[0]] = { rows: m[1](bid) };
                    } catch (e) {
                        out[m[0]] = { error: e.name + ': ' + e.message };
                    }
                });
            }

            res.setHeader({ name: 'Content-Type', value: 'application/json' });
            res.write(JSON.stringify(out, null, 2));
            return;
        }

        // --- serve a document ---
        if (req.parameters.mode === 'file') {
            var fileId = req.parameters.id;
            var billId = req.parameters.bill;
            if (!fileId) { res.write(notFound()); return; }

            try {
                var f = file.load({ id: fileId });
                var allowed = false;

                // PDFs uploaded through the Upload tab, whether still waiting for their invoice
                // or attached, open for everyone who can use the lookup. People never need to
                // open the File Cabinet folder; the lookup serves the file.
                // Someone with limited access opens only the ones they can see (see filterDocs).
                if (String(f.description || '').indexOf(DOC_MARK) === 0) allowed = filterDocs([parseDoc(f.description)]).length > 0;

                // Anything else (the Bill Capture scans) opens only when its folder is one of
                // the scan folders AND the file is attached to the vendor bill in the link.
                if (!allowed && billId && isVendorBill(billId) && billVisible(billId)
                        && scanFolderIds().indexOf(Number(f.folder)) >= 0) {
                    allowed = billAttachments(billId).some(function (a) {
                        return String(a.id) === String(fileId);
                    });
                }

                if (!allowed) {
                    log.audit({ title: 'blocked file request', details: fileId });
                    res.write(notFound());
                    return;
                }

                log.audit({
                    title: 'document viewed',
                    details: AUTH_USER + ' opened file ' + fileId + ' from ' + req.clientIpAddress
                });
                res.writeFile({ file: f, isInline: true });
            } catch (e) {
                log.error({ title: 'file load failed', details: fileId + ' :: ' + e.message });
                res.write(notFound());
            }
            return;
        }

        // --- one invoice (picked from the type-ahead) ---
        if (req.parameters.b) {
            var billParam = String(req.parameters.b).trim();
            if (!/^\d+$/.test(billParam)) { res.write(notFound()); return; }

            log.audit({
                title: 'invoice opened',
                details: AUTH_USER + ' opened bill ' + billParam + ' from ' + req.clientIpAddress
            });

            var one = billVisible(billParam) ? loadBillsByIds([Number(billParam)]) : [];
            if (!one.length) { res.write(searchPage('We could not find that invoice. Try searching again.')); return; }
            followBillGroup(res, billParam);
            res.write(renderBill(one[0]));
            return;
        }

        // --- search ---
        var by = cleanBy(req.parameters.by);
        var exactVendor = (req.parameters.v || '').trim();
        var term = (req.parameters.s || '').trim();

        if (!exactVendor && !term) {
            if (!rangeActive()) {
                res.write(searchPage());
                return;
            }

            // Dates only: every invoice in the range, across all vendors.
            log.audit({
                title: 'date searched',
                details: AUTH_USER + ' searched ' + (DATE_FROM || '*') + '..' + (DATE_TO || '*')
                       + ' from ' + req.clientIpAddress
            });
            var dTotal = countBills('', 'all');
            clampPage(dTotal, MAX_BILLS);
            var dRows = dTotal ? matchBills('', 'all', MAX_BILLS, (PAGE - 1) * MAX_BILLS, { sort: sortFor(SORT_RESULTS) }) : [];
            var dBills = loadBillsByIds(dRows.map(function (r) { return Number(r.id); }));
            res.write(renderResults('', 'all', [], dBills, dTotal));
            return;
        }

        log.audit({
            title: 'vendor searched',
            details: AUTH_USER + ' searched "' + (exactVendor || term) + '" by '
                   + (exactVendor ? 'vendor id' : by) + ' from ' + req.clientIpAddress
        });

        // &v= is an exact vendor ID (what the type-ahead and vendor links send).
        if (exactVendor) {
            var allHits = findVendors(exactVendor);
            var exactHits = allHits.filter(function (h) { return currentCategoryIds().indexOf(Number(h.category)) >= 0; });

            // A link to a vendor of the other group: follow it instead of dead-ending.
            if (!exactHits.length && allHits.length === 1) {
                var otherKey = '';
                try { otherKey = groupKeyForCategory(allHits[0].category); } catch (e) { otherKey = ''; }
                if (otherKey && allowedGroupKeys().indexOf(otherKey) >= 0) { followGroup(res, otherKey); exactHits = allHits; }
            }

            if (exactHits.length === 1) {
                res.write(renderList(exactHits[0], findBills(exactHits[0].id), exactVendor));
                return;
            }
            if (exactHits.length > 1) {
                res.write(renderResults(exactVendor, 'vendor', exactHits, [], false));
                return;
            }
            // Not an exact vendor ID -- treat what was typed as a general search.
            term = exactVendor;
            by = 'all';
        }

        var vendorHits = (by === 'all' || by === 'vendor') ? searchVendors(term) : [];

        // A vendor typed in full (ID or name) goes straight to its invoices.
        var exactMatches = vendorHits.filter(function (v) { return isExactVendor(v, term); });
        if (exactMatches.length === 1) {
            res.write(renderList(exactMatches[0], findBills(exactMatches[0].id), term));
            return;
        }

        var billHits = [];
        var billTotal = 0;
        if (by !== 'vendor') {
            billTotal = countBills(term, by);
            clampPage(billTotal, MAX_BILLS);
            var rows = billTotal ? matchBills(term, by, MAX_BILLS, (PAGE - 1) * MAX_BILLS, { sort: sortFor(SORT_RESULTS) }) : [];
            billHits = loadBillsByIds(rows.map(function (r) {
                return Number(r.id);
            }));
        }

        // PDFs waiting for their invoice have no invoice date, so they are left out when a
        // date range is set.
        var waitingHits = (by === 'all' && !rangeActive()) ? searchWaiting(term, 25) : [];

        if (!vendorHits.length && !billHits.length && !waitingHits.length) {
            var otherLabels = GROUP === ALL_GROUPS_KEY ? [] : VENDOR_GROUPS.filter(function (g) { return g.key !== GROUP && allowedGroupKeys().indexOf(g.key) >= 0; }).map(function (g) { return g.label; });
            res.write(searchPage('We could not find a vendor, invoice #, order # or unit # matching "'
                               + term + '" in ' + groupLabel(GROUP) + ' invoices. Try fewer characters'
                               + (otherLabels.length ? ', or switch to ' + otherLabels.join(' or ') : '') + '.', term));
            return;
        }

        // One vendor and no invoice hits: same as picking that vendor.
        if (vendorHits.length === 1 && !billHits.length && !waitingHits.length) {
            res.write(renderList(vendorHits[0], findBills(vendorHits[0].id), term));
            return;
        }

        res.write(renderResults(term, by, vendorHits, billHits, billTotal, waitingHits));
    }

    // ---------------------------------------------------------------------
    // EMBEDDED BRAND IMAGES (Nussbaum design system, Logos group)
    // Official logo files with the tagline line cropped off (at the client's request),
    // scaled down proportionally and unaltered otherwise.
    // LOGO_DARK = reversed logo for dark ground, LOGO_LIGHT = default logo for
    // white ground, FAVICON = the wave mark on its red square, wave filled white so it
    // stays solid on any tab color. Do not edit or recolor.
    // ---------------------------------------------------------------------
    LOGO_DARK  = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAX4AAABgCAMAAAAtr+mRAAABIFBMVEVeX1+dmJjdYFfUbGSYmJckJiampqauZ2fTl5HvqKfX2NZsa2vw8PCysrKobmroMyCk6ugK/f25Ly+zYlzXRztnmJXHx8fLdnBp7u/ShHj6ax7XjYfPhHr/q1cUoqf7Pj4HaGxuIiG6ej+nmmrJycmyhHuzNy+tQjfKRjd+ciX//3/fx7gAJnYNco94eHhtg3xwtM2hs9jObm7JfYLkgXT//wDFxrxeyba6OTGQfYLdeoIpKSkATz8Af/8Av991hHeMOTWUQzy0f4K5hXm3wbf/AP/PQj3gjoYAAADd3d3vMyXn5+f+///Hx8d/f3/vLBy+vr7wRTfwLSGXl5f/f3//AAC2traqqqrnVku5ubmnp6c3NzfExMTqS0P/VVXUWVF/8nX5AAAAYHRSTlMiXOCjKRqcCl0SFlH621z4EgQDk+Ycp24LmgOQbAMNBA4NCBtpV5yQtg0CTwMNjSYRFAVg5gEuDtg1qEoQAghiTEhShBkBbOkA/v7+AvMC/QT+/XACAbAD98+QFdL7A9D5+BeLAAAaGElEQVR42u1dB3viSrJVApGzjdN4POned+/dnHdf2Jdfg4RAIEC2wfz/f/GqWqmqBRjbY693x/19M7YlJDWnqyucqm5p4vW24OP76Bf3U6PUNU2z1+wZYRgazWZvY3S7DfsoOn93F4i/z6a90n7Nyx35s9IomRtjPfSHsk3H0/F4HP3uD9fGxjRLFRc/2PHe4P9aYh/M8Ue5YW5CH4CfQoP/h1kbw4HpVA6EHxrdfgtH7J37Bv+Tm2sj9ie6uUHkE1Hf3fATvmH0y6iFPr3B/6T26Q41Tt/s+ahohgc2HIL1poFzwHbf4H9k8xD7owszRLFPsW+iqhlTrKUuUhoc8kOzhFPAfYP/MRofwG+XzLU/JFhPEyNrGBvZDHB+fLTE05xeao6H/qZkCfH3YwReDfyo8St9A3VO4uSgUl/3TLNRssuVo6vLnxcuL68KV5WyXSqZJo4CIs7nQNM3LipCfHyD/yHmtgzgl0HpJFpFQh+CV1k+2XVNq1Lqm2S4MiVkmC44rm/wH4w+/GuY62EE/lS6MuZpOVIh83kQ2EHgzjO3NLgLzjrxuJmbNfdJYej8EGzA3HuD/5AGcnpSMhKNP26CAjcvWjKU6tjBfGdg9qPdOYOf7XLX8JWoYAw2QIjCG/z3G1wAUIewNmlrw5QKZ24f4sPPbVQyJyXTYAYbfl+b8NW8N/j3u5rvwdkx1pH+jlzHNvqOzHv3lu5y6e31mMSvSxu/OeUDUPo3Yb/Bv6eBAi+D5CfgGyXUOR2J2Two3727yyF9V3a3qKPlHU6Bjc9UUNPf/PK1W4C/JfygNywzAh/+GeafUe7BB5p7hMJsXxUmFWiW+HmqcTr50NaFMWs3Nj6NGMZDNMH2G/xb9c5ctM/DWF5947cu0pyu8OzYp6mUGqddiLZ6zV4IrdnsGZvvIAbQr6LJ8eOWAbgsGcwETNfmkQje4M83UBf6xh9LJhP8FLC2d5776Z2k2yoNE7nOJOodY0soTz80kGTGW/yoKhYYgCMzpAPQHBp65Ni+wU9F9YOo/GUN6AyRKGiAQHcCW2r6SimKZ6fj7YzbGD1TCAswtgXHJz+oP/3OpxdOw9PC650Afxv4Qes3pJqQko9yi8ZTnJS7m7U/HI4PIDn9cNOAEZgr1hn+PjlnE2CMCsh9g59qfcv0QYqnU3B22iDDkvApo/N+AMGfkgvD0NSjsaTtk5B3J/j7RkW8e4M/09CR6INncg6eZhkF2JKBEwwJx/ieIUBf9UQdABfu118TTno8NKxXSsK9PPyBaJlrwBlAMS0hfnOG+l5SZ00lgaJq/W2WAAfAFfPc9FJcoI0uym/wS44BRH86bI7Xhh3JbeUUBT8W1macWVn3eob5vZm078ABNfyYE1KtgFGSNpc/higgvHXYeJX6/4XhL4u2uZ6i6KOviXxPAzzFVFFMkeEPN12zX64U2uzK9pVll7ob9IqUmQE6zKwIxbuxxeU59YDGRkMdom8PfhBKVArNYXh6JD50RKuUCj4Ive/7G7Nvt65SL+bu/VlQDs7O7u4S9XKk91V6TQ5Av6VY1wAUUEgjgF5DnH3T8KNKDodS65fEfI5kWwwkKpzQOG1YMXTBXZB31QPbfi9HoSUJTpbvBe/mk8LvuGdgAEguZgr6p/wNww+Amkgsj0MT9QqCP42CWmQ6L6yoWsoO9pJkbllmAFoNs8cZ5nF42hY/KJrOMpqZqZiC/NvfLPxl8HjAGoKc/gSeSisGfxpjL0PWA2sU5piajFxVNgEgvCrndd2UMECl1xb/ai+HviY9nvC0FUn+cCqLQ3oRgTMvB79/CGmBxqDVN3zu3us5A2xRB3Qcvjb/U3sxzVPeNDENjhQDEsNjCf6mj9h3Pj6Clfc+QO8ZvzBFgvnM5YN+ZNAZAvGX/Q3CPxeNEFOw5q8iUnLabGLYpbeRa3tsRsQFUXcZwzlemwWeYbQRfxIqGNqrykC+CPxeIM798XgKvrc4OjWwOBbZHlT4TytMnncEuDd+xo1O190Tjm8gLqn+HxpHrwn/l4DfQ5dnOvZ/pwuhA1ggjZIqEGdPVwQwA7KkjVRAYFuYAXBR/xMFZVzNf/8twf8juDzD5tQ/r4gKqgrwdczGCaZXvo5NL8CYZvplPFT55R8U/LuvqALl+eF3Qfv6UdoViU4sAQEd9DXrMANkMsZEvo8+sJv/Rvx5TeyDf/p66J9nh1/aPhnnIgk2jgiy+dd1P5aSYMiII+NSfODj0wi5+2l/I/BD5LnBiKgVUcBr80vha4OP7b34ySD65fQkUOyvThMwRuW1mF/tudEHvTxe97GiBLydTUOI5wk8A/BnUwOM+oXTmx/FKeU/jX85+xbgt0UZ0DcukGobx4nFZ3rUJ3FC8Tc5vem+b5s0RWCKzj8+/IHQDPD2yyenawyyjp615skGA5xlWNbnnF7w5pcbEv2CI1D+R4ffFtoG7OCvkPcKzy3xzPkO76x9muKP9pVpuaWoGIT9NI5eRfkhhd9jTflu2w/vR7+1gWl+dAFex+aLOETcvEc8hmiY+Ukm/2Pjl3yu2eILcT+H5tXdP7T0e0hx+t1LkMiwf/kita7evJXp/xy9UEbmI/P++y+qftztKy4J/AXe2Meyw7cHo28ZU7/xVxgCwzrU3Xn4Y1T5/9cU/+nQ/BkX8KBtUPVfeUHyf36f9HuiOmJNB3WZBq7FQXK4epjLPJ+Dq7EuNnrD8MvVzqer8XF9sOXpDzP2fzQy+vOcqx8X5iP1PlsfXyr6xVTT1lSblvXtpuaQVitmoblbGKXHtYNwmQeAfqh311L07QPRvx0kTxk8lhf2CME/Dqsq+9wg5AQEBy8U/P5G/MowyvfAf+0MSHMWYpJp8VF8zhkVDiJM3HbXD3VTMgyH1pcthZ4+fPWUMDslGKaGq7LP3cw2jMPGi6gf9x1EP5tPW5+V6f7CiMN/neLsCd3JH93XziDO6nV7vmk9wOROyGMWj2fFgqzAZOx3+X3coEWTX5vLF/B+sLAsBDfA3qf7l8IacPhHhQyXmxSXm3RO7HU5S36vuzZO2w8RL1cs0sfMDnnMjnaXEQzjniLggdAJ+ea/QOkVqn3D/PkOcdLyopfAryUniV5y9AN0cgDz3wD0rYcuLUwe4wweaXmj7nZaKf8/Vtm1Mlc/1vyZ1U9HtAzUwK64B/4ihx+RXsbop3oJTeK9kQJav/D/QrP1MNECCzNILcztUyhJrG+IS0Gnw3Mu/vPghJAPQ/N5qX9XKh5b7ExnazssL9EzbqaXnNEBMLruxvgdpnUfJsDUwqyehgoEWImHk6stgeA3zMTf15+x8h9s7iUontYeDazlnJuBav4eaBJhehsGjvgDEaQWpvgE1Z94OMnOHEZrzmtPCqascsENsYZNw322DYDQ5m5Cc6/frWWip8J/ncJffJDlbRg44vbDJ+qCWJinwe9l6d3p+vxnZf6cIwPLeXHRpD8cXjyX83knjsw1Fn55eyRV22F5meuTmkTnXpOIkaVx/rjFhA+yMPdJ3m/Nf5LNNLs/m6t+Ga7Ms1qu/cXEVQbPIf7vcOEmrh/p7GUiUvgXOfgHlrR/HrG8o/uCUTS76/98zIZSzPIWngzJ3uvdUipZlnn6668v/sEc3M3QL7X3WJbbuWhUU99ypcKfqAASEUQm0U1a+m2yA7b7F0OT09mbxG3LdHGXyUmNqP4ZszCe+oHctRNOSyediA8G7+9ke//eVjsJ7UMZV8ovcQl3Qz5iueNxj1J94PGVQn+zd08PV7RNo6upopeDn1veyT0yZ51bgP6Ex5qsE55yMuOciIWhY8sxFnv+PHhqZHdffuBzxX0yL443t0w/vGjvY7Q/Yq3leUWLv3sGcb3upP6Hu8UkFm4Lt9gKt7GoRH/KFulW+WU0vVhcHC+KuiWoC+rhSa36GU8Wi7omEglxqYVx8fqbxUJ+wCWsELm2qFdvRSZf0K2Yqi4I1q9C1K2kl4Vb7IL2Ob27K29b1YvxgeXT0Ie5pplrXK28L6LDtX9hI9H9zOlbMVVD9ZJjISk8yrjnJSejcXQCnB+zxSgiL2vgT41uMlUOF2iz41HGbK6KSR9uqeXVF/FHBguNTBA4DtcmzOxgdK0nVxfSbtWlfQKhIf20hJ78MahD91bJ3YtSIArFFXmc9zTw3a4xRNE/2/upBsbCH0Qi/ceZhC+YoWV0J8iRlkEXh6ajlKi2AF7AqBjR04ksO84oC6C1xSg7J89eSwu/JJZ3JW4G8iPwz6nVtVhXuKLKro2ulnB5pFuxw6aNCHldydj0WhFmc9q52nUBZn52W6cWCdWjwW/rhqwj2mf7A4jGkBQ4Sz0fQisUPjuZ66PRiEBGApQUdhWHJdL+KycXQjizeCLhN815WPgQamHqxRr5UJx4gDEo5m4MZ0fR1dxuA4JV2k/KWv3iWrl7cRAPdXRgVXikQUETL8EvXe2jW9w5BCW+2ZaRkRbFXpRWmDHekZvECvlL2uElJ6M9+Nrp3w7l76RNKzpbTtZwVKmFUZjvQaJNADYnf3UdTnFO1s37USSmqCt3rztbPY6HejvgQ12VNlhCVNlrP8AgnPoQjUVEvKY6fddEvm8k/NdkOHKksEpG6wyh9JvVboTlZujjTzISOirgjHNyBkzHSDzg4lp2nl6NMRq1T3pskVg/NaaxFAWmHFg8HH7ck6JV2qzHMr/U2Sv6fzCRC74jpIPLaIVM10u5YXSny0LTpWI1hJtdOwA3Ql8wEi3TYqOipekj8swl9XxBf9fr2RRAD4yaBryzdTMg8CqRocbjGJ2KF36iXmcSjwdI1OMcPxD+ANN55T6WcW++XO6tm7cxIFiblykloylOH3Q27blT5yZxVFBIYVcoo0OGsShNyoDcSqQe7aCKJ2dMjelkNuC11Wx0jlF5U+8XWzbpPrNJV9+SHl0SNt051oSg7LpTRFu9oKP9APg9BPKkJJc4hd2TvSUdEAv/2lyv/6uQ1V9HjvctFZ5sLEboM1CUKmraccktb/al0Q54Swa/Tm2I5i0rDP4bZ0CjLmpyULtnj4E7L7XJpErgr6ianvoLK54vqksrns01GFzlwMG6fx4t85ZbHx9QRAk66SIcbizKBWsiZz5T0UAp5XRnRU07chMHfySX6i66TdlwrAS5raUt4cpq4uzJ+I5Y3oILvoCmE4Doc3VXea4OpxWylJPXFcKmO1j8oNHEti4sNlsG0vOc79nANUrbRG82sS42a1ycHOLuLPsu+YCxMEyQNvOKtBytUKEgCm7UeNpxwq0GqIxjAv9SDmvibS+olvLADUJbmpzUiU2JXRcqv8f43PjDtcQPSgcTAM06GacpVQ+hShSoq+im6GmWqlSRMu6Ut7EabmB3JIRtq7/p4Q4fvtEF8DvuXtt8VQpxiQ+PhTXF8upUDQMSXC+5TNN73GpUBRmcaxhVkP5Z0jQqgWhLAV89PUltSmTSJ+Iz/bjQP+uyfdYLnuZ5FY1qSIpmHCTTflLxKkYqM/uK8oDL5/+dyDbvnneCILB/CLzgBztwO2fzSMJdq2Fuos23ojWa99FPJWMoCz/y6RbuJlgECtCL+oDKiTZQpGa71cBpVFD4PgI/xvruckeisZ7L8Wwte2Diq1gkTfUQirt10yyaxFxZnQBW643Z1yet/JMtq9RI3mwyHq7l3q8/BvuDYcv0h6Getw1azk2gkNapL7NgvmMuuLzm+WJkGkBGrIQcpurWca5hqrgpc8wM7SLmWRck+AZTMalEbyjSJtWqPtNnLCeqpCmV8aD9shTdlDsA47EUVm8s91H3w41hft8v/fDBtu0PH0uNrmn0ZJIsWhiOmx637nlfxjsICboo+kdb6FRN5GgFqlA00i8Ui6JqeXka+IbFM0iIEb6M5vKdwcIi7O62Ep+sE4WIFIKZeLMajZTASVqkhWqR6HgsuW5ClVlYURpLdZ9t0febZEszFHT5wgw/2k9LHsWd/Ay5Fci7+d7MtzhpGMMh7te4vchwwsynyzJfFlGiquVdqmS0xbMGgNEq28OUhT4yaj0mdUCqTfGw3jMzI7IAtJgRpQ4JEqrMIsUsLE2PThTxYropr6ywRs/keyaO43dXJVuL4lai602/3EYPab4/GsbdQ8br0x27SWtCoRU8rnYzzz1n4qTlrVOXY0lInUzLuAnXvKgpXFtCJrs80Sg/XGVqbitZl3VLuZqPZoXNBVcozkXMEJHxmJ9s8jvGDdP3tsmXO8j3VN3zmiT0Q0vmeuobOxeXaGpnl6x3RYsZNSpGEWwjZuIsFX+45U1qXgv1mjI4I13inyPImAjomDy72Qp+zGbMuOXFwqRBJsw5zUZ1kx5dwIObihFJPX9BkhR9fx2ap7p8S1tnbzGHfB+KDtHw0Dhv7Sx30HKUMT1QW8yY6tfzwaValjJjUorsWV0kfL24UVKaTmIqFdeEQBZZXp2lCKjqX6hpyr10p8JTpe4zZ+xcfDNPb+37ZL8m31/3DBOkvhVFXcF91U7o7oRjuYfu7mAYH690lsr0dZ3hkqM7i/yLy4uLAy6p6UoB+KLVa87ZR6Ur/OtHgsKMY5UQnKt68bNeJx2pqCWoVNxRmHO6iXjLsV3ZUsvRrtilU7P7HbTvu12zb+tWO44Eyvf4+N5HuKlurjEga8BQuHvKrMAJrvEqKhJEjjjduWIiudVhQUu24DMgmuFJuvCajU6UCVBtisZyX+5tFjJcR4QbITDI6dQiccs7U6OCLMSN3Wed13KIZXl7vmR+9q78P/eyz2dyu651vJJ575Y5Wt6dYW4xZWK2VOLU85VRMpNdpAMQGYo0WV6tM//ohpEC0denM/JGMBUnS0Y8MjdcSikIlVJAbbOHp9rqPqfpKzt4J0tV3r9/F5Tt5SFZsAA9Iau/8VHy+yf3LWrTvJzTt63kDb94hdGIbq4y6lZLmhwAop/xvvEpWWdQpfQ6t531OCtJY95Cnetuj8+NLZQCPc3Fy1XN+pLVmD2tvHEuObdP+P6x8VAW8dxXwaXxKqptLnqmRJWgi37xY5ZbRoxnJH9SoY/EGXBMxubWZbGdyxMQIL9VhYpfMsdxa7eocrkd7TK06RKyr7KwQL7C5w/4Bpkxgv+HQ17fqVlK2iNO/W6pudoSXLIvXqgmDQycRkNggD89F1f2XDu0lHTFb8zjIkY2eyLvOF4TxirOCtPbMS+U81Srr7WwYC7f/XDyxYz2OA7xrVWHbBelcdGb7Ko2H6h0p6b6a6KefLiO38FbZiSPU9FG6UkUb4vMm9otz3Us1TicOAKRsHJWhFL1Oem2RE68qG5KqwWcnJV6SI1DZKjt6BWGEGXhtviH7dWlCRa4ejsqPkFOaGKrXlAyegONVNokiyPqmWGYpcT/TSTeVSrexNRYketLOTIqrJFdrjJPUuf0hGKRKnm6c7a7WuDBCwu8cmcepRs3hnzLJxjc1n7un8Of58q3LXVZsIyerIWZuHQ5CimQkHbAI/7gNdMWE37pjaBMHcK/dNlAKxW+hOmIukWykp6rlm3QuaBGBY6zNTfj2geuAnddCb347wv54khkhHwTX+dw+MoSbduSHlK+QDN6RZr+8zwOAzPDE29ZYelAUg5hTfDSIlUf5GmWW2E3hsGhXunS8yo0CONpygUmmPnVlS3itVITW6rrJzp35b1mM7CDCHnRKjXwdTPTcbQTtdwu6gHWQ2Nu22Sn64Pwrxy+8mJGWV/xC4evia5Se3ZcYxUQ2UjKkJgVldCzgJhHyLfRPwtWAxFZ3szEjHgNRGRJ9pTl5elOrIr4ZP0xtqd3QWDb9tITv/e8OVgz+KsTvE/mRqXcN+WLtZELnQ7XG6T+o/2lHwD/lsW0rur6ROFLRphB8GlhFSxhfYkCdxa6VS0OyBQn0j+40SuzheNsIyxlIgxu7BDxtaiw19ljo6snrFsV/ZjFGxM1r7hkFRd54ioQhm+Y5oVdae/CrH1pNQB5Y+1HW9/jbsiGiSzP3UNXamiFFU/8bHV9IiVK+EpHVqIxGCxaJ0XL0IqsjCS6lPAR1DVx2NmYkeA3dhwKP6Yn9nSrsD8Vk+M/UVm1jHHEsBnG9+bFvzfKOsyPoyP4Ty83/qNR6hqbXuinb5OP3hGPieH5IxbpaTk+SjDGK9OqarpqoESuhdFWPr7Ga9RyhKeb2RRnpCysj0kQUpMm6wtXRWaL6yrFPWCJRipeLudStzBEZaH50zSlFTHMzWaz14P/wrWf7tU6Td4jk7zgNnjUEiVttm27Blf5TignqkFwRkVehzbbQsk7MtmXT7XEdP8v5COvM361to2NvqkpirBI1MlEOV0b1Um3lrmyPBK9yKITJSq2xW/JlodRiit+SxgOSTN5x08TX7Tk98zzcvT2vEeuRdNuVMo4Kfp0+Cq7JXSclmY7o+qiRrVqLtVF8imeq13XVKofa/NZmWKtSHWeE3fIdTUq/nhV+tzPuAjsdlUjk22kJWY+Gj49Lea63mp5JenipOOhJBp3vLCt2fTx3ZHRsrBOMH80S6TV08URhG2aZDVQMlYaRWHW7SJLtR5rok7qpKSYzkZ0RyBnUC8KkmpRTsZ5YDDz6WNm8QKKKHjT0zQB4J9edoPjVUsvmODp6+z0opCtq6hJb7nGNiiCOVzLIkDlAKjYudzyZLod9lgh+T3DPP8iX7hx1gmetAZTq5JKKJes8pyRplfJ4p7RYDRaFWHcC/RSLz5/cyyLEeAzi6JOVnWhhzcrruqSfIDrZ8mqLrCd2W3AgtysRvJqPbsWPlZMjmJlRiEt0IrT8kI/ls9c3aAfNWPfqJp8Vo8/bOms1/wTmjjqGr2e0fS3vSYSzDEg37fjN/zcm3Y5iHR44GJZz7IKO5YARr25hU9YWm7loRtTfNBud64hRMRvLcsTfD0eOTrZ8Vhrd7ce2NrQyUap/79dc2MYxp/+1DN68Mv335uln/RWSi3bX2VrwP8HDbRiMLc5wuMAAAAASUVORK5CYII=';
    LOGO_LIGHT = 'data:image/png;base64,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';
    FAVICON    = 'data:image/png;base64,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';

    return { onRequest: onRequest };
});
