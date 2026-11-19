/**
 * Server-side regression checks for nts_vendor_doc_lookup_sl.js (and the UE script's shared constants).
 * Usage: node test_server.js <path to SL> <path to UE> <baseline SL> <baseline UE>
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const { makeEnv, load, request } = require('./mock');

const [SL, UE, BASE_SL, BASE_UE] = process.argv.slice(2);
let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) pass++; else { fail++; console.log('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const slText = fs.readFileSync(SL, 'utf8');
const ueText = fs.readFileSync(UE, 'utf8');
const secret = /var COOKIE_SECRET = '([^']*)';/.exec(slText)[1];

function env(o) { return makeEnv(Object.assign({ cookieSecret: secret }, o || {})); }
function between(s, a, b) { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i); return s.substring(i, j < 0 ? s.length : j); }
function count(s, sub) { return s.split(sub).length - 1; }
function scripts(html) { const out = []; html.replace(/<script>([\s\S]*?)<\/script>/g, (m, c) => { out.push(c); return m; }); return out; }
function compiles(code) { try { new vm.Script(code); return ''; } catch (e) { return e.message; } }

// ---- 1. protected lines ----
const protectedLines = [
  [SL, /^    var COOKIE_SECRET = '[^']*';$/m],
  [SL, /^    var PW_SALT = '[^']*';$/m],
  [SL, /^    var DOC_MARK = 'NTSINV\|';$/m],
  [SL, /^    var UNIT_FIELD = 'custbody_unit';$/m],
  [UE, /^    var DOC_MARK = 'NTSINV\|';$/m],
  [UE, /^    var UNIT_FIELD = 'custbody_unit';$/m]
];
protectedLines.forEach(([f, re]) => check('protected line ' + re + ' in ' + f.split('/').pop(), count(fs.readFileSync(f, 'utf8'), '\n') && (fs.readFileSync(f, 'utf8').match(new RegExp(re.source, 'gm')) || []).length === 1));
const baseSl = fs.readFileSync(BASE_SL, 'utf8');
['COOKIE_SECRET', 'PW_SALT'].forEach(k => {
  const re = new RegExp("^    var " + k + " = '[^']*';$", 'm');
  check(k + ' line byte-identical to baseline', re.exec(slText)[0] === re.exec(baseSl)[0]);
});
check('UE script unchanged', ueText === fs.readFileSync(BASE_UE, 'utf8'));

// ---- 2. log titles: only additions ----
function titles(t) { const s = new Set(); t.replace(/title: '([^']+)'/g, (m, x) => { s.add(x); return m; }); return s; }
const before = titles(baseSl), after = titles(slText);
const removed = [...before].filter(x => !after.has(x)), added = [...after].filter(x => !before.has(x));
check('no log title removed', removed.length === 0, removed.join(', '));
check('only expected log title added', JSON.stringify(added.sort()) === JSON.stringify(['no invoice access', 'pdf tool file failed', 'vendor subsidiary filter failed']), added.join(', '));

// ---- 3. toggle placement ----
function load1(o, patch) { const e = env(o); return { e, m: load(SL, e, patch) }; }
function togglePlacement(html) {
  const nav = between(html, '<nav class="nb-tabs"', '</nav>');
  const row = between(html, '<div class="nb-searchrow">', '<div class="nb-help">');
  const G = 'class="nb-groupsel"';
  return { total: count(html, G), inNav: count(nav, G), inRow: count(row, G), groupbar: count(html, 'class="nb-wrap nb-groupbar"') };
}
{
  const { e, m } = load1();
  const html = request(m, e, {}).body;
  const p = togglePlacement(html);
  check('search page: one toggle', p.total === 1, JSON.stringify(p));
  check('search page: toggle in search row', p.inRow === 1, JSON.stringify(p));
  check('search page: toggle not in tab bar', p.inNav === 0, JSON.stringify(p));
  check('search page: toggle right after Search button', html.indexOf('>Search</button><div class="nb-groupsel">') > 0);
  check('search page: tabs still there', count(html, 'class="nb-tab') >= 4);
  check('search page: AP active', /class="nb-grp__opt is-active"[^>]*data-group="AP"/.test(html));
  check('search page: TMT link', html.indexOf('&amp;group=TMT" data-group="TMT"') > 0);
  check('search page: no viewer script', html.indexOf('PDFV_CFG') < 0);
  scripts(html).forEach((s, i) => check('search page script ' + i + ' compiles', !compiles(s), compiles(s)));
}
{
  const { e, m } = load1();
  const html = request(m, e, { s: 'EPO', from: '2026-11-01' }).body;
  const p = togglePlacement(html);
  check('results: toggle in row once', p.total === 1 && p.inRow === 1, JSON.stringify(p));
  check('results: toggle keeps search + dates', html.indexOf('&amp;s=EPO&amp;from=2026-11-01&amp;group=TMT') > 0);
  check('results: clear dates after toggle', html.indexOf('</div></div><button id="cleardates"') > 0);
}
{
  const { e, m } = load1();
  const html = request(m, e, { tab: 'missing' }).body;
  const p = togglePlacement(html);
  check('missing tab: toggle in row once', p.total === 1 && p.inRow === 1 && p.inNav === 0, JSON.stringify(p));
  check('missing tab: toggle stays on tab', html.indexOf('&amp;tab=missing&amp;group=TMT') > 0);
  check('missing tab: rows carry order #', html.indexOf('class="nb-droprow" data-bill="2508" data-order="EPO-00012345"') > 0);
  check('missing tab: new drop hint', html.indexOf('Drop a PDF onto an invoice to check it, add notes and attach it.') > 0);
  check('missing tab: viewer script before attach script', html.indexOf('window.NbPdf=') > 0 && html.indexOf('window.NbPdf=') < html.indexOf('var ATTACH_BASE='));
  const cfg = /var PDFV_CFG=(\{.*?\});/.exec(html);
  check('missing tab: config present', !!cfg);
  if (cfg) {
    const c = JSON.parse(cfg[1]);
    check('config libs all on', c.libs.pdfjs && c.libs.pdfworker && c.libs.pdflib);
    check('config auto on', c.auto === true);
    check('config base is self()', c.base === '?script=101&deploy=1');
    check('config icons', Object.keys(c.icons).length === 11);
  }
  scripts(html).forEach((s, i) => check('missing tab script ' + i + ' compiles', !compiles(s), compiles(s)));
}
{
  const { e, m } = load1();
  const html = request(m, e, { tab: 'upload' }).body;
  const p = togglePlacement(html);
  check('upload tab: no toggle (as before)', p.total === 0, JSON.stringify(p));
  check('upload tab: viewer script', html.indexOf('window.NbPdf=') > 0 && html.indexOf('window.NbPdf=') < html.indexOf('var BASE='));
  check('upload tab: help line', html.indexOf('Each PDF opens so you can check it') > 0);
  check('upload tab: no attach script', html.indexOf('ATTACH_BASE') < 0);
  scripts(html).forEach((s, i) => check('upload tab script ' + i + ' compiles', !compiles(s), compiles(s)));
}
{
  const { e, m } = load1();
  const html = request(m, e, { tab: 'queue' }).body;
  check('queue tab: no toggle, no viewer', count(html, 'class="nb-groupsel"') === 0 && html.indexOf('PDFV_CFG') < 0);
}
{
  const { e, m } = load1();
  const html = request(m, e, { b: '2508' }).body;
  const p = togglePlacement(html);
  check('bill page: toggle in row once', p.total === 1 && p.inRow === 1, JSON.stringify(p));
  check('bill page: toggle goes back to search (no &b=)', /href="\?script=101&amp;deploy=1&amp;group=TMT"/.test(html));
  check('bill page: has drop row + viewer', html.indexOf('nb-droprow') > 0 && html.indexOf('window.NbPdf=') > 0);
}
{
  // A page with the toggle on but no search box: it falls back to the tab bar.
  const { e, m } = load1();
  const html = request(m, e, { b: 'abc' }).body;
  const p = togglePlacement(html);
  check('no-search-box page: toggle in tab bar once', p.total === 1 && p.inNav === 1 && p.inRow === 0, JSON.stringify(p));
}
{
  // Someone without upload rights: no tabs, toggle in the search row, no extra group bar.
  const { e, m } = load1({ uploadFlag: false }, s => s.replace('var REQUIRE_UPLOAD_FLAG = false;', 'var REQUIRE_UPLOAD_FLAG = true;'));
  const html = request(m, e, {}).body;
  const p = togglePlacement(html);
  check('no-upload person: no tabs', count(html, 'class="nb-tabs"') === 0);
  check('no-upload person: toggle in row only', p.total === 1 && p.inRow === 1 && p.groupbar === 0, JSON.stringify(p));
  const nf = request(m, e, { b: 'abc' }).body;
  const p2 = togglePlacement(nf);
  check('no-upload person, no search box: group bar fallback', p2.total === 1 && p2.groupbar === 1, JSON.stringify(p2));
}
{
  // Group error page: no toggle anywhere (unchanged).
  const { e, m } = load1();
  const html = request(m, e, { group: 'TMT' }, {}).body;
  check('TMT search page renders', html.indexOf('data-group="TMT"') > 0 && /is-active"[^>]*data-group="TMT"/.test(html));
}
{
  // Request state does not leak: a search page after an upload page.
  const { e, m } = load1();
  request(m, e, { tab: 'upload' });
  const html = request(m, e, { b: 'abc' }).body;
  check('state reset: no viewer on not-found after upload page', html.indexOf('PDFV_CFG') < 0);
  const p = togglePlacement(html);
  check('state reset: toggle placement recomputed', p.inNav === 1, JSON.stringify(p));
}

// ---- 4. mode=lib ----
{
  const files = { 'SuiteScripts/AP Invoice Lookup/lib/pdf.min.js': { name: 'pdf.min.js', contents: '/*pdfjs*/window.pdfjsLib={};' } };
  const { e, m } = load1({ files });
  const r = request(m, e, { mode: 'lib', n: 'pdfjs' });
  check('lib: serves file', r.body === '/*pdfjs*/window.pdfjsLib={};');
  check('lib: js content type', r.headers.some(h => h.name === 'Content-Type' && /^text\/javascript/.test(h.value)));
  check('lib: cache header', r.headers.some(h => h.name === 'Cache-Control' && /private, max-age=86400/.test(h.value)));
  check('lib: loaded by path', e.loadedFiles.indexOf('SuiteScripts/AP Invoice Lookup/lib/pdf.min.js') >= 0);
  check('lib: not logged as request', !e.logs.some(l => l.title === 'request'));

  const before2 = e.loadedFiles.length;
  const r2 = request(m, e, { mode: 'lib', n: 'pdfjs' }, { signedIn: false });
  check('lib: signed out gets not found', r2.body.indexOf('We could not find that.') > 0 && e.loadedFiles.length === before2);

  const r3 = request(m, e, { mode: 'lib', n: '../../etc' });
  check('lib: unknown key not found', r3.body.indexOf('We could not find that.') > 0 && e.loadedFiles.length === before2);

  const r4 = request(m, e, { mode: 'lib', n: 'pdflib' });   // not in the fake File Cabinet
  check('lib: missing file -> not found + logged', r4.body.indexOf('We could not find that.') > 0
        && e.logs.some(l => l.title === 'pdf tool file failed' && /pdflib/.test(l.details)));

  const r5 = request(m, e, { mode: 'lib', n: 'hasOwnProperty' });
  check('lib: prototype key not served', r5.body.indexOf('We could not find that.') > 0);
}
{
  const { e, m } = load1({}, s => s.replace("pdfjs:     'SuiteScripts/AP Invoice Lookup/lib/pdf.min.js',", "pdfjs:     '',"));
  const r = request(m, e, { mode: 'lib', n: 'pdfjs' });
  check('lib: blank path -> not found, no load', r.body.indexOf('We could not find that.') > 0 && e.loadedFiles.length === 0);
  const html = request(m, e, { tab: 'upload' }).body;
  const c = JSON.parse(/var PDFV_CFG=(\{.*?\});/.exec(html)[1]);
  check('config: blank path switches that lib off', c.libs.pdfjs === false && c.libs.pdflib === true);
}
{
  const { e, m } = load1({}, s => s.replace('var PREVIEW_ON_DROP = true;', 'var PREVIEW_ON_DROP = false;'));
  const html = request(m, e, { tab: 'missing' }).body;
  check('preview off: old drop hint', html.indexOf('Drop a PDF onto an invoice to attach it.') > 0);
  check('preview off: auto false', /"auto":false/.test(html));
  const up = request(m, e, { tab: 'upload' }).body;
  check('preview off: no upload help line', up.indexOf('Each PDF opens') < 0);
}

// ---- 5. uploads: notes flag reaches the audit log; nothing else changes ----
const PDF64 = Buffer.from('%PDF-1.4\n%test\n').toString('base64');
{
  const { e, m } = load1();
  const r = request(m, e, { mode: 'upload', order: 'EPO-00012345', name: 'a.pdf', data: PDF64, notes: '1' }, { method: 'POST' });
  const j = JSON.parse(r.body);
  check('upload with notes ok + attached', j.ok && j.state === 'matched', r.body);
  check('upload with notes logged', e.logs.some(l => l.title === 'invoice uploaded' && / with notes added from /.test(l.details)));
  check('upload stores bytes as sent', e.created[0].contents === PDF64);
  const r2 = request(m, e, { mode: 'upload', order: 'EPO-99999', name: 'b.pdf', data: PDF64 }, { method: 'POST' });
  check('upload without notes: no note text', JSON.parse(r2.body).ok && !e.logs.some(l => l.title === 'invoice uploaded' && /EPO-99999/.test(l.details) && /notes/.test(l.details)));
}
{
  const { e, m } = load1();
  const r = request(m, e, { mode: 'attach', bill: '2508', name: 'a.pdf', data: PDF64, notes: '1' }, { method: 'POST' });
  check('attach with notes ok', JSON.parse(r.body).ok, r.body);
  check('attach with notes logged', e.logs.some(l => l.title === 'invoice attached by drop' && /\(order # EPO-00012345\) with notes added from /.test(l.details)));
  check('attach attached to bill', e.attached.some(a => a.bill === 2508));
  const r2 = request(m, e, { mode: 'attach', bill: '2508', name: 'b.pdf', data: PDF64 }, { method: 'POST' });
  check('attach without notes: unchanged log text', JSON.parse(r2.body).ok && e.logs.filter(l => l.title === 'invoice attached by drop').pop().details.indexOf('notes') < 0);
  const r3 = request(m, e, { mode: 'attach', bill: '2508', name: 'c.pdf', data: 'aGVsbG8=' }, { method: 'POST' });
  check('attach still rejects non-PDF', JSON.parse(r3.body).error === 'That file is not a PDF.');
}

// ---- 6. hard-coded IDs: none added ----
{
  const addedLines = slText.split('\n').filter(l => baseSl.indexOf(l) < 0);
  const suspicious = addedLines.filter(l => /\b(id|Id|ID)\s*[:=]\s*\d{2,}/.test(l) || /internalid'\s*,\s*'anyof'\s*,\s*\d/.test(l));
  check('no hard-coded internal ids in new lines', suspicious.length === 0, suspicious.join(' | '));
  check('no template-literal breakers in browser code', !/\$\{/.test(between(slText, 'var PDFVIEW_JS = `', '`;')));
}

// ---- 7. access scope: subsidiaries and AP / TMT per person ----
{
  const extraBills = [
    { id: 2510, tranid: 'EPO-00012347', date: '11/03/2026', amount: '-50.00', status: 'Open', vendorid: 'WESTCO', vendorname: 'West Company', unit: '', category: 1, sub: 3, entity: 12 },
    { id: 2511, tranid: 'EPO-00012348', date: '11/04/2026', amount: '-60.00', status: 'Open', vendorid: 'TMTCO', vendorname: 'TMT Company', unit: '', category: 2, sub: 1, entity: 11 },
    { id: 2512, tranid: 'EPO-00012349', date: '11/05/2026', amount: '-70.00', status: 'Open', vendorid: 'SHARED', vendorname: 'Shared Supply', unit: '', category: 1, sub: 1, entity: 13 }
  ];
  const docs = [
    { id: 801, name: 'EPO-00012347__w.pdf', createddate: '11/10/2026', description: 'NTSINV|MATCHED|ORDER=EPO-00012347|BY=Other Person|BILL=2510|AT=2026-11-10' },
    { id: 802, name: 'EPO-00012345__a.pdf', createddate: '11/10/2026', description: 'NTSINV|MATCHED|ORDER=EPO-00012345|BY=Other Person|BILL=2508|AT=2026-11-10' },
    { id: 803, name: 'EPO-55555__mine.pdf', createddate: '11/10/2026', description: 'NTSINV|PENDING|ORDER=EPO-55555|BY=Test Person' },
    { id: 804, name: 'EPO-66666__other.pdf', createddate: '11/10/2026', description: 'NTSINV|PENDING|ORDER=EPO-66666|BY=Other Person' },
    { id: 805, name: 'EPO-00012347__dup.pdf', createddate: '11/10/2026', description: 'NTSINV|PENDING|ORDER=EPO-00012347|BY=Other Person' }
  ];
  function scopedEnv(scope, more) {
    const e = makeEnv(Object.assign({ cookieSecret: secret, extraBills, docs, scope }, more || {}));
    return { e, m: load(SL, e, more && more.patch) };
  }
  const ids = html => (html.match(/data-bill="(\d+)"/g) || []).map(x => Number(x.replace(/\D/g, ''))).filter((v, i, a) => a.indexOf(v) === i).sort();
  const billRows = html => (between(html, 'nb-bills', '</table>').match(/<td class="nb-strong">(?:<a [^>]*>)?(EPO-\d+)/g) || []).map(x => /EPO-\d+/.exec(x)[0]).sort();

  // Unlimited person (blank fields): everything in the group, as before.
  {
    const { e, m } = scopedEnv({});
    const r = request(m, e, { s: 'EPO' }).body;
    check('blank scope: all AP bills', JSON.stringify(billRows(r)) === JSON.stringify(['EPO-00012345', 'EPO-00012346', 'EPO-00012347', 'EPO-00012349']), billRows(r));
    check('blank scope: no subsidiary clause in SQL', !e.queries.some(q => /stl\.subsidiary|vendorsubsidiaryrelationship/.test(q.q)));
    check('blank scope: settings say all', /AP and TMT invoices<br>All subsidiaries/.test(r));
    const qb = request(m, e, { tab: 'queue' }).body;
    check('blank scope: queue sweeps the one whose invoice exists, shows the other two', count(qb, '&mode=file&id=80') === 2 && /1 PDF was just attached/.test(qb) && e.attached.some(a => a.file === 805 && a.bill === 2510));
  }

  // Limited to subsidiary 1.
  {
    const sc = { subs: '1', subNames: 'Nussbaum Transportation' };
    const { e, m } = scopedEnv(sc);
    const r = request(m, e, { s: 'EPO' }).body;
    check('sub 1: only sub-1 AP bills', JSON.stringify(billRows(r)) === JSON.stringify(['EPO-00012345', 'EPO-00012346', 'EPO-00012349']), billRows(r));
    check('sub 1: SQL carries the subsidiary', e.queries.some(q => /stl\.subsidiary IN \(\?\)/.test(q.q)));
    check('sub 1: settings list the subsidiary', /AP and TMT invoices<br>Subsidiaries: Nussbaum Transportation/.test(r));
    const d = request(m, e, { s: '', from: '2026-11-01' }).body;
    check('sub 1: date list scoped', billRows(d).indexOf('EPO-00012347') < 0 && billRows(d).length === 3, billRows(d));
    const vsug = q => JSON.parse(request(m, e, { mode: 'suggest', q }).body).filter(x => x.k === 'v').map(x => x.e);
    check('sub 1: vendor in own subsidiary suggested', JSON.stringify(vsug('ACME')) === '["ACME"]');
    check('sub 1: vendor shared into own subsidiary suggested', JSON.stringify(vsug('SHARED')) === '["SHARED"]');
    check('sub 1: vendor of another subsidiary not suggested', JSON.stringify(vsug('WESTCO')) === '[]');
    const sg = JSON.parse(request(m, e, { mode: 'suggest', q: 'EPO' }).body);
    check('sub 1: bill suggestions scoped', !sg.some(x => x.k === 'b' && x.t === 'EPO-00012347'));
    check('sub 1: other-sub invoice not found', /could not find that invoice/.test(request(m, e, { b: '2510' }).body));
    check('sub 1: own-sub invoice shown', request(m, e, { b: '2508' }).body.indexOf('Order # <span class="nb-keep">EPO-00012345') > 0);
    check('sub 1: other-sub vendor page not shown', request(m, e, { v: 'WESTCO' }).body.indexOf('<h1 class="nb-headline nb-h1">West Company</h1>') < 0);
    check('sub 1: own vendor page shown', request(m, e, { v: 'ACME' }).body.indexOf('<h1 class="nb-headline nb-h1">Acme Parts</h1>') > 0);
    const miss = request(m, e, { tab: 'missing' }).body;
    check('sub 1: missing list scoped', JSON.stringify(ids(miss)) === JSON.stringify([2508, 2509, 2512]), ids(miss));
    check('sub 1: missing badge counts own subs', /Missing documents<span class="nb-badge">3</.test(miss));
    check('sub 1: missing count cached per subsidiaries', Object.keys(e.cacheStore).some(k => /count:0:AP:1$/.test(k)));
    const at = JSON.parse(request(m, e, { mode: 'attach', bill: '2510', name: 'a.pdf', data: PDF64 }, { method: 'POST' }).body);
    check('sub 1: attach to other-sub bill refused', !at.ok && at.error === 'We could not find that invoice.' && e.created.length === 0);
    check('sub 1: attach to own bill works', JSON.parse(request(m, e, { mode: 'attach', bill: '2508', name: 'a.pdf', data: PDF64 }, { method: 'POST' }).body).ok);
    check('sub 1: attach bumps the count generation', e.cacheStore['NTS_VENDOR_DOC_MISSING:count:gen'] !== '0');
    const un = JSON.parse(request(m, e, { mode: 'unit', bill: '2510', unit: '9' }, { method: 'POST' }).body);
    check('sub 1: unit change on other-sub bill refused', !un.ok && e.submitted.length === 0);
    const up = JSON.parse(request(m, e, { mode: 'upload', order: 'EPO-00012347', name: 'x.pdf', data: PDF64 }, { method: 'POST' }).body);
    check('sub 1: upload for other-sub order waits, not attached, nothing revealed', up.ok && up.state === 'queued' && !/WESTCO/.test(up.message) && !e.attached.some(a => a.bill === 2510));
    const fileOk = id => request(m, e, { mode: 'file', id: String(id) }).body.indexOf('We could not find that.') < 0;
    check('sub 1: PDF on other-sub bill blocked', !fileOk(801));
    check('sub 1: PDF on own bill opens', fileOk(802));
    check('sub 1: own waiting PDF opens', fileOk(803));
    check('sub 1: someone else\'s waiting PDF with no visible invoice blocked', !fileOk(804) && !fileOk(805));
    const qp = request(m, e, { tab: 'queue' }).body;
    check('sub 1: queue shows only own waiting PDFs', qp.indexOf('EPO-55555__mine.pdf') > 0 && qp.indexOf('EPO-66666__other.pdf') < 0 && qp.indexOf('EPO-00012347__dup.pdf') < 0);
    check('sub 1: queue badge counts only those', /Missing Invoices<span class="nb-badge">1</.test(qp), (/Missing Invoices(<span class="nb-badge">\d+<\/span>)?/.exec(qp) || [''])[0]);
    const del = JSON.parse(request(m, e, { mode: 'queuedel', id: '804' }, { method: 'POST' }).body);
    check('sub 1: cannot remove someone else\'s hidden PDF', !del.ok && e.files[804]);
    check('sub 1: diag refused', /Not available with limited access/.test(request(m, e, { mode: 'diag', bill: '2508' }).body));
    const sw = JSON.parse(request(m, e, { mode: 'suggest', q: 'EPO-6' }).body);
    check('sub 1: waiting-PDF suggestions scoped', !sw.some(x => x.k === 'w' && x.o === 'EPO-66666'));
  }

  // The vendor-subsidiary table refused: falls back to the primary subsidiary, logged once.
  {
    const { e, m } = scopedEnv({ subs: '1' }, { noVsr: true });
    const vsug = q => JSON.parse(request(m, e, { mode: 'suggest', q }).body).filter(x => x.k === 'v').map(x => x.e);
    check('no vendor-subsidiary table: shared vendor dropped', JSON.stringify(vsug('SHARED')) === '[]');
    check('no vendor-subsidiary table: primary still works', JSON.stringify(vsug('ACME')) === '["ACME"]');
    check('no vendor-subsidiary table: logged (once per request)', e.logs.filter(l => l.title === 'vendor subsidiary filter failed').length === 2);
  }

  // Limited to AP (by name), to TMT (by category id), and both by a text field.
  {
    const { e, m } = scopedEnv({ groups: '', groupNames: 'AP' });
    const r = request(m, e, { group: 'TMT' });
    check('AP only: &group=TMT ignored', /class="nb-grp__opt is-active"[^>]*data-group="AP"/.test(r.body) && r.body.indexOf('data-group="TMT"') < 0);
    check('AP only: no TMT cookie written', !r.headers.some(h => h.name === 'Set-Cookie' && /nts_doclookup_group=TMT/.test(h.value)));
    check('AP only: settings', /AP invoices<br>All subsidiaries/.test(r.body));
    check('AP only: TMT bill not found', /could not find that invoice/.test(request(m, e, { b: '2511' }).body));
    check('AP only: TMT vendor link does not switch group', request(m, e, { v: 'TMTCO' }).body.indexOf('<h1 class="nb-headline nb-h1">TMT Company</h1>') < 0);
    const up = JSON.parse(request(m, e, { mode: 'upload', order: 'EPO-00012348', name: 'x.pdf', data: PDF64 }, { method: 'POST' }).body);
    check('AP only: upload for TMT order waits', up.state === 'queued');
    check('AP only: bill SQL limits categories', e.queries.some(q => /v\.category IN \(\?\)/.test(q.q)));
  }
  {
    const { e, m } = scopedEnv({ groups: '2', groupNames: 'TMT' });
    const r = request(m, e, {}, {});
    check('TMT only (list value): lands on TMT', /class="nb-grp__opt is-active"[^>]*data-group="TMT"/.test(r.body) && r.body.indexOf('data-group="AP"') < 0);
    const s2 = request(m, e, { s: 'EPO' }).body;
    check('TMT only: TMT bills only', JSON.stringify(billRows(s2)) === JSON.stringify(['EPO-00012348']), billRows(s2));
  }
  {
    const { e, m } = scopedEnv({ groups: 'AP, TMT' });
    check('text field "AP, TMT": both, not limited', request(m, e, {}).body.indexOf('data-group="TMT"') > 0 && !e.queries.some(q => /v\.category IN/.test(q.q)));
  }
  {
    const { e, m } = scopedEnv({ groups: 'XYZ' });
    const r = request(m, e, {}).body;
    check('groups set to nothing usable: no-access page', /You do not have access to any invoices yet/.test(r) && e.logs.some(l => l.title === 'no invoice access'));
    check('no-access: JSON modes answer with an error', JSON.parse(request(m, e, { mode: 'suggest', q: 'EP' }).body).ok === false);
  }
  {
    const { e, m } = scopedEnv({}, { patch: s => s.replace('var SCOPE_BLANK_MEANS_ALL = true;', 'var SCOPE_BLANK_MEANS_ALL = false;') });
    check('blank means nothing: no-access page', /You do not have access to any invoices yet/.test(request(m, e, {}).body));
  }
  {
    const { e, m } = scopedEnv({ subs: '1' }, { patch: s => s.replace("var FLD_SUBS   = 'custentity_vendor_invoice_subs';", "var FLD_SUBS   = '';") });
    const r = request(m, e, { s: 'EPO' }).body;
    check('FLD_SUBS off: subsidiary limit ignored', billRows(r).indexOf('EPO-00012347') >= 0);
  }
  {
    // Fields not created in this account: sign-in is not available (fails closed).
    const { e, m } = scopedEnv({}, { missingScopeFields: true });
    const r = request(m, e, { email: 'test@example.com', code: 'x' }, { method: 'POST', signedIn: false }).body;
    check('scope fields missing: sign-in unavailable', r.indexOf('Sign-in is not available right now') > 0);
    check('scope fields missing: cookie no longer signs in', /Sign in\./.test(request(m, e, {}).body));
  }
}

console.log('server checks: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
