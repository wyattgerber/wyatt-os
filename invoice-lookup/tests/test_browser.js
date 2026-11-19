/**
 * Browser checks: drives the real page (from the mocked Suitelet) in Chromium with the real
 * pdf.js 3.11.174 and pdf-lib 1.17.1, then inspects the PDFs the page uploaded.
 * Usage: node test_browser.js <path to SL> <libs node_modules dir> <out dir>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { makeEnv, load, request } = require('./mock');

const [SL, NM, OUT] = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const PDFLib = require(path.join(NM, 'pdf-lib'));
const pdfjs = require(path.join(NM, 'pdfjs-dist/legacy/build/pdf.js'));

let pass = 0, fail = 0;
function check(name, ok, extra) { if (ok) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' :: ' + extra : '')); } }

const slText = fs.readFileSync(SL, 'utf8');
const secret = /var COOKIE_SECRET = '([^']*)';/.exec(slText)[1];
const LIBDIR = 'SuiteScripts/AP Invoice Lookup/lib/';
const libFiles = {};
libFiles[LIBDIR + 'pdf.min.js'] = { name: 'pdf.min.js', contents: fs.readFileSync(path.join(NM, 'pdfjs-dist/build/pdf.min.js'), 'utf8') };
libFiles[LIBDIR + 'pdf.worker.min.js'] = { name: 'pdf.worker.min.js', contents: fs.readFileSync(path.join(NM, 'pdfjs-dist/build/pdf.worker.min.js'), 'utf8') };
libFiles[LIBDIR + 'pdf-lib.min.js'] = { name: 'pdf-lib.min.js', contents: fs.readFileSync(path.join(NM, 'pdf-lib/dist/pdf-lib.min.js'), 'utf8') };

function startServer(patch) {
  const env = makeEnv({ cookieSecret: secret, files: Object.assign({}, libFiles) });
  const mod = load(SL, env, patch);
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const params = {};
      u.searchParams.forEach((v, k) => { params[k] = v; });
      if (req.method === 'POST') new URLSearchParams(body).forEach((v, k) => { params[k] = v; });
      const fake = { method: req.method, parameters: params, headers: { cookie: req.headers.cookie || '' }, clientIpAddress: '127.0.0.1' };
      const out = { headers: [], body: '', setHeader(h) { this.headers.push(h); }, write(s) { this.body += s; }, writeFile() {} };
      try { mod.onRequest({ request: fake, response: out }); } catch (e) { out.body = 'ERR ' + e.stack; }
      const ct = (out.headers.find(h => h.name === 'Content-Type') || {}).value || 'text/html; charset=utf-8';
      res.writeHead(200, { 'Content-Type': ct });
      res.end(out.body);
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ env, srv, port: srv.address().port })));
}

async function makePdfs() {
  const { PDFDocument, StandardFonts, degrees, rgb } = PDFLib;
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p1 = d.addPage([612, 792]);
  p1.drawText('ACME PARTS - INVOICE', { x: 50, y: 740, size: 20, font: f });
  p1.drawText('Order EPO-00012345   Unit 2222   Total $125.00', { x: 50, y: 700, size: 12, font: f });
  for (let i = 0; i < 12; i++) p1.drawText('Line item ' + (i + 1) + ' ........................ $10.00', { x: 50, y: 650 - i * 20, size: 11, font: f, color: rgb(0.2, 0.2, 0.2) });
  const p2 = d.addPage([612, 792]);
  p2.setRotation(degrees(90));
  p2.drawText('PAGE TWO (ROTATED 90)', { x: 50, y: 740, size: 20, font: f });
  fs.writeFileSync(path.join(OUT, 'EPO-00012345.pdf'), await d.save());
  const d2 = await PDFDocument.create();
  const f2 = await d2.embedFont(StandardFonts.Helvetica);
  d2.addPage([612, 792]).drawText('PLAIN INVOICE', { x: 50, y: 740, size: 20, font: f2 });
  fs.writeFileSync(path.join(OUT, 'plain.pdf'), await d2.save());
  fs.writeFileSync(path.join(OUT, 'broken.pdf'), Buffer.from('%PDF-1.4\nthis is not really a pdf\n'));
}

async function textOf(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    pages.push(tc.items.map(it => ({ s: it.str, t: it.transform })));
  }
  return pages;
}

async function cookieFor(ctx, port, env) {
  const [name, value] = env.authCookie.split('=');
  await ctx.addCookies([{ name, value, domain: '127.0.0.1', path: '/' }]);
}

async function ovBox(page, idx) {
  return page.locator('.nb-pdfov').nth(idx).boundingBox();
}
async function drag(page, box, pts) {
  await page.mouse.move(box.x + pts[0][0], box.y + pts[0][1]);
  await page.mouse.down();
  for (let i = 1; i < pts.length; i++) await page.mouse.move(box.x + pts[i][0], box.y + pts[i][1], { steps: 6 });
  await page.mouse.up();
}
async function inkPixels(page, idx) {
  return page.evaluate((i) => {
    const c = document.querySelectorAll('.nb-pdfov')[i];
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++; return n;
  }, idx);
}

(async () => {
  await makePdfs();
  const A = await startServer();
  const base = 'http://127.0.0.1:' + A.port + '/?script=101&deploy=1';
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  await cookieFor(ctx, A.port, A.env);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  // ---- toggle next to search ----
  await page.goto(base);
  await page.screenshot({ path: path.join(OUT, '1-search-toggle.png'), clip: { x: 0, y: 0, width: 1500, height: 300 } });
  const rowBox = await page.locator('.nb-searchrow').boundingBox();
  const grpBox = await page.locator('.nb-searchrow .nb-grp').boundingBox();
  const btnBox = await page.locator('#btn').boundingBox();
  check('toggle sits in the search row, right of Search', grpBox.x > btnBox.x + btnBox.width && Math.abs(grpBox.y - btnBox.y) < 2 && grpBox.y >= rowBox.y);
  check('toggle as tall as the Search button', Math.abs(grpBox.height - btnBox.height) < 2, grpBox.height + ' vs ' + btnBox.height);
  await page.fill('#vq', 'abc');
  await Promise.all([page.waitForNavigation(), page.click('.nb-searchrow .nb-grp__opt[data-group="TMT"]')]);
  check('switching with typed text keeps it', /&group=TMT&s=abc$/.test(page.url()), page.url());
  await Promise.all([page.waitForNavigation(), page.click('.nb-searchrow .nb-grp__opt[data-group="AP"]')]);
  check('switching without typing follows the link', /&s=abc&group=AP$/.test(page.url()), page.url());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  check('phone width: no sideways scroll on search page', wide <= 390, wide);
  await page.screenshot({ path: path.join(OUT, '1b-search-phone.png'), clip: { x: 0, y: 0, width: 390, height: 520 } });
  await page.setViewportSize({ width: 1500, height: 950 });

  // ---- Upload tab: drop two PDFs, mark up the first, type the second's order # ----
  await page.goto(base + '&tab=upload');
  await page.setInputFiles('#files', [path.join(OUT, 'EPO-00012345.pdf'), path.join(OUT, 'plain.pdf')]);
  await page.waitForSelector('dialog.nb-pdfdlg[open] .nb-pdfov', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.nb-pdfov').length === 2);
  check('viewer opened by itself on drop', true);
  check('title is file name', (await page.textContent('#nbPdfTitle')) === 'EPO-00012345.pdf');
  check('order # guessed into the viewer', (await page.inputValue('#nbPdfOrder')) === 'EPO-00012345');
  check('nav 1 of 2', (await page.textContent('[data-r="pos"]')) === '1 of 2');
  check('ok says Next file', (await page.textContent('[data-r="ok"]')) === 'Next file');
  check('tools enabled', !(await page.isDisabled('[data-tool="pen"]')));

  const b1 = await ovBox(page, 0);
  await page.click('[data-tool="hl"]');
  await drag(page, b1, [[60, 95], [420, 112]]);
  await page.click('[data-tool="pen"]');
  await drag(page, b1, [[60, 140], [160, 170], [260, 140], [360, 170]]);
  await page.click('[data-color="#1d4ed8"]');
  await page.click('[data-tool="text"]');
  await page.mouse.click(b1.x + 420, b1.y + 200);
  await page.keyboard.type('Approved JD');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('GL 5100');
  await page.keyboard.press('Enter');
  // A stray stroke, erased, undone (comes back), erased again.
  await page.click('[data-tool="pen"]');
  await drag(page, b1, [[300, 420], [380, 440]]);
  const withStray = await inkPixels(page, 0);
  await page.click('[data-tool="erase"]');
  await page.mouse.click(b1.x + 340, b1.y + 430);
  const erased = await inkPixels(page, 0);
  check('erase removes the stroke', erased < withStray, erased + ' vs ' + withStray);
  await page.keyboard.press('Control+z');
  check('undo brings it back', (await inkPixels(page, 0)) === withStray);
  await page.mouse.click(b1.x + 340, b1.y + 430);
  check('erased again', (await inkPixels(page, 0)) === erased);
  // A note on the rotated page 2.
  await page.evaluate(() => { const sc = document.querySelector('.nb-pdfscroll'); sc.scrollTop = document.querySelectorAll('.nb-pdfpage')[1].offsetTop - 24; });
  const b2 = await ovBox(page, 1);
  const head = await page.locator('.nb-pdftools').boundingBox();
  check('page 2 overlay below the toolbar for the clicks', b2.y > head.y + head.height, JSON.stringify([b2, head]));
  await page.click('[data-tool="text"]');
  await page.mouse.click(b2.x + 80, b2.y + 80);
  await page.keyboard.type('Rot note');
  await page.keyboard.press('Enter');
  await page.click('[data-tool="pen"]');
  await drag(page, b2, [[80, 120], [300, 120]]);
  await page.evaluate(() => { document.querySelector('.nb-pdfscroll').scrollTop = 0; });
  await page.screenshot({ path: path.join(OUT, '2-viewer-marked.png') });
  const pgBox = await page.locator('.nb-pdfpage').first().boundingBox(), scBox = await page.locator('.nb-pdfscroll').boundingBox();
  check('page fits inside the viewer, centered', pgBox.x >= scBox.x && pgBox.x + pgBox.width <= scBox.x + scBox.width && Math.abs((pgBox.x - scBox.x) - (scBox.x + scBox.width - pgBox.x - pgBox.width)) < 24, JSON.stringify([pgBox, scBox]));
  // Zoom keeps notes in place
  const before = await inkPixels(page, 0);
  await page.click('[data-a="zin"]');
  await page.waitForFunction(() => document.querySelectorAll('.nb-pdfov').length === 2);
  await page.waitForTimeout(300);
  const after = await inkPixels(page, 0);
  check('zoom in redraws notes larger', after > before, before + ' -> ' + after);
  check('zoom label', (await page.textContent('[data-r="zoom"]')) === '125%');
  await page.click('[data-a="zout"]');
  await page.waitForTimeout(300);

  await page.click('[data-r="ok"]');    // Next file
  await page.waitForFunction(() => document.querySelector('#nbPdfTitle').textContent === 'plain.pdf');
  await page.waitForSelector('.nb-pdfov');
  check('second file: order # empty, focused', (await page.inputValue('#nbPdfOrder')) === '' && await page.evaluate(() => document.activeElement.id === 'nbPdfOrder'));
  check('ok says Done on last', (await page.textContent('[data-r="ok"]')) === 'Done');
  await page.fill('#nbPdfOrder', 'x');
  check('bad order # flagged', (await page.getAttribute('[data-r="ordbox"]', 'data-bad')) === '1');
  await page.fill('#nbPdfOrder', 'EPO-00012346');
  check('good order # ok', (await page.getAttribute('[data-r="ordbox"]', 'data-bad')) === null);
  await page.click('[data-a="prev"]');
  await page.waitForFunction(() => document.querySelector('#nbPdfTitle').textContent === 'EPO-00012345.pdf');
  await page.waitForFunction(() => document.querySelectorAll('.nb-pdfov').length === 2);
  await page.waitForTimeout(300);
  check('notes still there after going back', (await inkPixels(page, 0)) === erased);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('dialog.nb-pdfdlg').open);
  const listText = await page.textContent('#list');
  check('Esc closes, notes kept on the row', /5 notes added/.test(listText), listText);
  check('order # typed in viewer reached the row', (await page.inputValue('input.ord[data-i="1"]')) === 'EPO-00012346');
  await page.screenshot({ path: path.join(OUT, '3-upload-list.png') });

  await page.click('#go');
  await page.waitForFunction(() => /attached/.test(document.getElementById('sum').textContent), null, { timeout: 15000 });
  const created = A.env.created;
  check('two files uploaded', created.length === 2, created.length);
  const marked = Buffer.from(created[0].contents, 'base64');
  const plainSent = Buffer.from(created[1].contents, 'base64');
  check('PDF without notes sent byte for byte', plainSent.equals(fs.readFileSync(path.join(OUT, 'plain.pdf'))));
  check('PDF with notes changed', !marked.equals(fs.readFileSync(path.join(OUT, 'EPO-00012345.pdf'))));
  fs.writeFileSync(path.join(OUT, 'uploaded-with-notes.pdf'), marked);
  const t = await textOf(marked);
  const p1 = t[0].map(x => x.s), p2 = t[1];
  check('original text kept', p1.indexOf('ACME PARTS - INVOICE') >= 0);
  check('typed note in PDF (2 lines)', p1.indexOf('Approved JD') >= 0 && p1.indexOf('GL 5100') >= 0, JSON.stringify(p1));
  const appr = t[0].find(x => x.s === 'Approved JD'), gl = t[0].find(x => x.s === 'GL 5100');
  check('second line below first, same x', gl && appr && Math.abs(gl.t[4] - appr.t[4]) < 0.5 && appr.t[5] - gl.t[5] > 13 && appr.t[5] - gl.t[5] < 16, JSON.stringify([appr && appr.t, gl && gl.t]));
  check('note text not rotated on page 1', appr && Math.abs(appr.t[1]) < 1e-6 && appr.t[0] > 0);
  const rot = p2.find(x => x.s === 'Rot note');
  check('rotated page note present and turned to read upright', rot && Math.abs(rot.t[0]) < 1e-6 && Math.abs(rot.t[1]) > 1, JSON.stringify(rot));
  check('upload logged with notes', A.env.logs.some(l => l.title === 'invoice uploaded' && /EPO-00012345/.test(l.details) && /with notes added/.test(l.details)));
  check('plain upload logged without', A.env.logs.some(l => l.title === 'invoice uploaded' && /EPO-00012346/.test(l.details) && !/notes/.test(l.details)));

  // What the saved PDF looks like: open it in the viewer (no overlay notes, all baked in).
  await page.goto(base + '&tab=upload');
  await page.setInputFiles('#files', [path.join(OUT, 'uploaded-with-notes.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('.nb-pdfov').length === 2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, '4-saved-pdf-page1.png') });
  await page.locator('.nb-pdfpage').nth(1).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, '5-saved-pdf-page2.png') });
  check('saved PDF opens with no overlay notes', (await inkPixels(page, 0)) === 0);
  await page.click('[data-r="cancel"]');

  // ---- Missing documents: attach with notes, cancel, cancel with notes ----
  await page.goto(base + '&tab=missing');
  check('drop hint shown', /check it, add notes and attach it/.test(await page.textContent('.nb-tablebar')));
  const n0 = A.env.created.length;
  let fc = page.waitForEvent('filechooser');
  await page.click('tr[data-bill="2508"] .nb-attachbtn');
  await (await fc).setFiles(path.join(OUT, 'plain.pdf'));
  await page.waitForSelector('dialog.nb-pdfdlg[open] .nb-pdfov');
  check('attach viewer title', (await page.textContent('#nbPdfTitle')) === 'Order # EPO-00012345');
  check('attach viewer ok/cancel', (await page.textContent('[data-r="ok"]')) === 'Attach' && await page.isVisible('[data-r="cancel"]'));
  check('attach viewer has no order fields or nav', await page.isHidden('[data-r="fields"]') && await page.isHidden('[data-r="nav"]'));
  await page.click('[data-tool="pen"]');
  const b3 = await ovBox(page, 0);
  await drag(page, b3, [[100, 200], [300, 260]]);
  await page.screenshot({ path: path.join(OUT, '6-attach-viewer.png') });
  await page.click('[data-r="ok"]');
  await page.waitForFunction(() => /attached\./.test(document.querySelector('tr[data-bill="2508"] .nb-attachnote').textContent), null, { timeout: 15000 });
  check('attach created a file', A.env.created.length === n0 + 1);
  const att = Buffer.from(A.env.created[n0].contents, 'base64');
  check('attached PDF has the notes (differs, still valid)', !att.equals(fs.readFileSync(path.join(OUT, 'plain.pdf'))) && (await textOf(att))[0].some(x => x.s === 'PLAIN INVOICE'));
  check('attach logged with notes', A.env.logs.some(l => l.title === 'invoice attached by drop' && /with notes added/.test(l.details)));
  check('row link added', await page.isVisible('tr[data-bill="2508"] .nb-doccell a'));

  fc = page.waitForEvent('filechooser');
  await page.click('tr[data-bill="2509"] .nb-attachbtn');
  await (await fc).setFiles(path.join(OUT, 'plain.pdf'));
  await page.waitForSelector('dialog.nb-pdfdlg[open] .nb-pdfov');
  await page.click('[data-r="cancel"]');
  await page.waitForFunction(() => /Nothing was attached/.test(document.querySelector('tr[data-bill="2509"] .nb-attachnote').textContent));
  check('cancel attaches nothing', A.env.created.length === n0 + 1);

  fc = page.waitForEvent('filechooser');
  await page.click('tr[data-bill="2509"] .nb-attachbtn');
  await (await fc).setFiles(path.join(OUT, 'plain.pdf'));
  await page.waitForSelector('dialog.nb-pdfdlg[open] .nb-pdfov');
  await page.click('[data-tool="pen"]');
  const b4 = await ovBox(page, 0);
  await drag(page, b4, [[100, 200], [300, 260]]);
  let asked = '';
  page.once('dialog', d => { asked = d.message(); d.dismiss(); });
  await page.click('[data-r="cancel"]');
  await page.waitForTimeout(200);
  check('cancel with notes asks first; dismiss keeps viewer open', /Close without your notes/.test(asked) && await page.evaluate(() => document.querySelector('dialog.nb-pdfdlg').open));
  page.once('dialog', d => d.accept());
  await page.click('[data-r="cancel"]');
  await page.waitForFunction(() => !document.querySelector('dialog.nb-pdfdlg').open);
  check('then nothing attached', A.env.created.length === n0 + 1);

  // Dropping a file onto a row (real drag and drop event)
  const dropOk = await page.evaluate(async () => {
    const bytes = new TextEncoder().encode('%PDF-1.4\nnot real\n');
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'dropped.pdf', { type: 'application/pdf' }));
    const td = document.querySelector('tr[data-bill="2509"] td');
    td.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    td.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  });
  await page.waitForSelector('dialog.nb-pdfdlg[open] iframe.nb-pdfnative', { timeout: 15000 });
  const m1 = await page.textContent('[data-r="msg"]');
  check('row drop opens viewer; damaged PDF falls back to browser viewer', dropOk && /cannot be opened in the note tools/.test(m1), m1);
  check('fallback: tools off', await page.isDisabled('[data-tool="pen"]'));
  await page.click('[data-r="ok"]');
  await page.waitForFunction(() => /attached\./.test(document.querySelector('tr[data-bill="2509"] .nb-attachnote').textContent), null, { timeout: 15000 });
  check('fallback still attaches the PDF as is', A.env.created.length === n0 + 2 && Buffer.from(A.env.created[n0 + 1].contents, 'base64').toString().indexOf('not real') > 0);

  check('no page errors (main run)', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ---- PDF tools not set up: browser viewer, tools off, upload unchanged ----
  const B = await startServer(s => s.replace("pdfjs:     'SuiteScripts/AP Invoice Lookup/lib/pdf.min.js',", "pdfjs:     '',"));
  const ctx2 = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await cookieFor(ctx2, B.port, B.env);
  const pg2 = await ctx2.newPage();
  const errs2 = [];
  pg2.on('pageerror', e => errs2.push(e.message));
  await pg2.goto('http://127.0.0.1:' + B.port + '/?script=101&deploy=1&tab=upload');
  await pg2.setInputFiles('#files', [path.join(OUT, 'plain.pdf')]);
  await pg2.waitForSelector('dialog.nb-pdfdlg[open] iframe.nb-pdfnative', { timeout: 15000 });
  check('no pdf.js: browser viewer + message', /not available right now/.test(await pg2.textContent('[data-r="msg"]')));
  check('no pdf.js: tools off', await pg2.isDisabled('[data-tool="hl"]') && await pg2.isDisabled('[data-a="undo"]'));
  await pg2.fill('#nbPdfOrder', 'EPO-00012345');
  await pg2.click('[data-r="ok"]');
  await pg2.click('#go');
  await pg2.waitForFunction(() => /attached/.test(document.getElementById('sum').textContent), null, { timeout: 15000 });
  check('no pdf.js: upload works, bytes unchanged', Buffer.from(B.env.created[0].contents, 'base64').equals(fs.readFileSync(path.join(OUT, 'plain.pdf'))));
  check('no page errors (no pdf.js run)', errs2.length === 0, errs2.join(' | '));
  await ctx2.close();

  // ---- Preview off: rows attach straight away as before; Upload tab opens only from View ----
  const Cc = await startServer(s => s.replace('var PREVIEW_ON_DROP = true;', 'var PREVIEW_ON_DROP = false;'));
  const ctx3 = await browser.newContext({ viewport: { width: 1300, height: 900 } });
  await cookieFor(ctx3, Cc.port, Cc.env);
  const pg3 = await ctx3.newPage();
  await pg3.goto('http://127.0.0.1:' + Cc.port + '/?script=101&deploy=1&tab=upload');
  await pg3.setInputFiles('#files', [path.join(OUT, 'EPO-00012345.pdf')]);
  await pg3.waitForTimeout(500);
  check('preview off: no auto open', !(await pg3.evaluate(() => { const d = document.querySelector('dialog.nb-pdfdlg'); return !!(d && d.open); })));
  await pg3.click('button.vw.nb-btn');
  await pg3.waitForSelector('dialog.nb-pdfdlg[open] .nb-pdfov', { timeout: 15000 });
  check('preview off: View button opens it', true);
  await pg3.click('[data-r="cancel"]');
  await pg3.goto('http://127.0.0.1:' + Cc.port + '/?script=101&deploy=1&tab=missing');
  const fc3 = pg3.waitForEvent('filechooser');
  await pg3.click('tr[data-bill="2508"] .nb-attachbtn');
  await (await fc3).setFiles(path.join(OUT, 'plain.pdf'));
  await pg3.waitForFunction(() => /attached\./.test(document.querySelector('tr[data-bill="2508"] .nb-attachnote').textContent), null, { timeout: 15000 });
  check('preview off: row attaches straight away', Cc.env.created.length === 1);
  await ctx3.close();

  await browser.close();
  [A, B, Cc].forEach(x => x.srv.close());
  console.log('browser checks: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('CRASH ' + e.stack); process.exit(2); });
