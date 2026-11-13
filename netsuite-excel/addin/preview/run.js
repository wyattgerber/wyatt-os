// DEV-ONLY preview: drives the REAL task pane (addin/dist) in Chromium, with the REAL API service code in
// mock mode behind /api/*, and office-stub.js in place of office.js. Writes screenshots + findings to preview/out/.
// Needs: `npm run build` in addin/ and `npm run build` in api/, plus Playwright (`npm i -D playwright` once,
// `npx playwright install chromium`). Run: `npm run preview` in addin/. Real Excel still needs the deployed site.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'addin/dist');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const svc = require(path.join(ROOT, 'api/dist/src/lib/service'));
const env = { NETSUITE_MOCK: 'true', ALLOWED_USERS: 'accountant@example.com' };
const principal = Buffer.from(JSON.stringify({ userDetails: 'accountant@example.com', userRoles: ['authenticated'] })).toString('base64');
const stub = fs.readFileSync(path.join(__dirname, 'office-stub.js'), 'utf8');

const findings = [];
const check = (ok, msg) => findings.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let signedIn = false;
  await page.exposeFunction('__markSignedIn', () => { signedIn = true; });

  await page.route('https://appsforoffice.microsoft.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.route('https://addin.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/api/')) {
      if (!signedIn) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"UNAUTHENTICATED","message":"Please sign in."}}' });
      let r;
      if (u.pathname === '/api/me') r = await svc.meService(principal, { env });
      else if (u.pathname === '/api/reports') r = await svc.reportsService(principal, { env });
      else if (u.pathname === '/api/periods') r = await svc.periodsService(principal, { env });
      else if (u.pathname === '/api/run') r = await svc.runService(principal, route.request().postData() || '', { env, log: () => {} });
      else r = { status: 404, body: {} };
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    const f = path.join(DIST, u.pathname);
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ path: f });
  });

  // 1) First open: not signed in
  await page.goto('https://addin.test/taskpane.html');
  await page.waitForSelector('#signin:not([hidden])');
  await page.screenshot({ path: path.join(OUT, '1-signin.png') });
  check(true, 'Not signed in -> pane shows the Sign in button (API answered 401)');

  // 2) Sign in via the dialog
  await page.click('#signinBtn');
  await page.waitForSelector('#main:not([hidden])');
  const dialogUrl = await page.evaluate(() => window.__dialogUrl);
  check(/\/\.auth\/login\/aad\?post_login_redirect_uri=%2Fsignin-complete\.html$/.test(new URL(dialogUrl).pathname + new URL(dialogUrl).search), `Sign-in dialog opens ${new URL(dialogUrl).pathname}${new URL(dialogUrl).search}`);
  check(await page.isVisible('#mock'), 'Red MOCK banner shown (API reports mock: true)');
  const opts = await page.$$eval('#report option', (o) => o.map((x) => x.textContent));
  check(opts.length === 5, `Report list: ${opts.join(', ')}`);

  // 3) Pick GL Detail; periods are dropdowns of real periods, defaulting to last month
  await page.selectOption('#report', 'gl_detail');
  const tag = await page.$eval('#p_fromPeriod', (e) => e.tagName);
  const choices = await page.$$eval('#p_fromPeriod option', (o) => o.map((x) => x.value));
  check(tag === 'SELECT' && choices.length > 12, `Periods are a dropdown (${choices.length} choices, newest first: ${choices.slice(0, 3).join(', ')} ...)`);
  const from = await page.inputValue('#p_fromPeriod');
  const to = await page.inputValue('#p_toPeriod');
  const now = new Date(); const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const want = `${last.toLocaleString('en-US', { month: 'short' })} ${last.getFullYear()}`;
  check(from === want && to === want, `Period dropdowns default to last month: ${from} .. ${to}`);
  // A typed/forged unknown period is rejected by the server (the dropdown prevents it in the UI).
  const bad = await page.evaluate(async () => (await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report: 'gl_detail', params: { fromPeriod: 'Okt 2026', toPeriod: 'Oct 2026' } }) })).json());
  check(bad.error && bad.error.code === 'UNKNOWN_PERIOD', `Server rejects an unknown period: "${bad.error && bad.error.message}"`);
  await page.screenshot({ path: path.join(OUT, '2-pane.png') });

  // 4) Run it
  await page.click('#run');
  await page.waitForSelector('#status.ok, #status.err', { timeout: 20000 });
  const status = await page.textContent('#status');
  check(await page.$('#status.ok') !== null, `Run: "${status}"`);
  await page.screenshot({ path: path.join(OUT, '3-done.png') });

  // 5) Inspect what was written to "Excel"
  const sheets = await page.evaluate(() => window.__sheets.map((s) => ({ ...s, tables: s.tables.length })));
  const sh = sheets.find((s) => s.name.startsWith('GL '));
  check(!!sh, `New sheet created: "${sh && sh.name}"`);
  check(sh.valueBeforeFormat === 0, `Number formats set before values (cells written before a format: ${sh.valueBeforeFormat})`);
  check(sh.cells['0,0'] === 'Period' && sh.frozenRows === 1, `Table starts at A1 and its header row is frozen (frozen rows: ${sh.frozenRows})`);
  const infoCol = Object.keys(sh.cells).map((k) => k.split(',').map(Number)).filter(([r, c]) => sh.cells[`${r},${c}`] === 'NetSuite pull').map(([, c]) => c)[0];
  check(infoCol === 12, `Pull Info block sits to the right of the table, after one empty column (column ${String.fromCharCode(65 + infoCol)})`);
  const pulledAt = Object.entries(sh.cells).find(([k, v]) => v === 'Pulled at (US Eastern)');
  const pulledVal = pulledAt && sh.cells[pulledAt[0].replace(/,(\d+)$/, (m, c) => ',' + (Number(c) + 1))];
  check(/E[SD]T/.test(String(pulledVal)), `Pulled at shown in US Eastern: "${pulledVal}"`);
  check(sh.tables === 1, 'Data written as one Excel table');
  check(sh.props['ns.report'] === 'gl_detail' && JSON.parse(sh.props['ns.params']).fromPeriod === 'Oct 2026', `Saved for Refresh: ns.report=${sh.props['ns.report']} ns.params=${sh.props['ns.params']}`);
  const textCols = Object.entries(sh.formats).filter(([k, f]) => f === '@').length;
  check(textCols > 0, `Text cells use "@" format (${textCols} cells): a memo like "=HYPERLINK(...)" stays plain text`);

  // 6) Refresh re-runs into the same sheet
  const before = sheets.length;
  await page.click('#refresh');
  await page.waitForFunction(() => /Done/.test(document.querySelector('#status').textContent) && !document.querySelector('#run').disabled, null, { timeout: 20000 });
  const after = await page.evaluate(() => window.__sheets.length);
  check(after === before, `Refresh rewrote the same sheet (sheets before ${before}, after ${after})`);

  // 7) Render the sheet like Excel would show it
  const grid = await page.evaluate(() => {
    const s = window.__sheets.find((x) => x.name.startsWith('GL '));
    return { name: s.name, cells: s.cells, formats: s.formats, bold: s.bold };
  });
  const fmt = (v, f) => {
    if (v === '' || v === undefined) return '';
    if (f === 'yyyy-mm-dd' && typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
    if (f && f.startsWith('#,##0.00') && typeof v === 'number') { const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); return v < 0 ? `(${s})` : s; }
    return String(v);
  };
  const rows = 22, cols = 14;
  let html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;font:12px Calibri,"Segoe UI",sans-serif;background:#fff}
  .bar{background:#217346;color:#fff;padding:6px 10px;font:600 13px "Segoe UI",sans-serif}
  table{border-collapse:collapse} td,th{border:1px solid #d4d4d4;padding:2px 6px;white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;height:18px}
  th{background:#f3f3f3;color:#555;font-weight:400;text-align:center} .rn{background:#f3f3f3;color:#555;text-align:center;width:28px}
  .num{text-align:right} .b{font-weight:700} .hdr{background:#dce6f1;font-weight:700} .band td:not(.rn){background:#f2f7fc} .frozen td{border-bottom:2px solid #9a9a9a}
  td:nth-child(13){background:#fff !important;border-color:#eee}</style>
  <div class="bar">Excel preview — sheet “${grid.name}” (first ${rows} rows, mock data)</div><table><tr><th></th>`;
  for (let c = 0; c < cols; c++) html += `<th>${String.fromCharCode(65 + c)}</th>`;
  html += '</tr>';
  const headerRow = 0;
  for (let r = 0; r < rows; r++) {
    const cls = r === headerRow ? 'hdr frozen' : r > headerRow && (r - headerRow) % 2 === 0 ? 'band' : '';
    html += `<tr class="${cls}"><td class="rn">${r + 1}</td>`;
    for (let c = 0; c < cols; c++) {
      const k = `${r},${c}`, v = grid.cells[k], f = grid.formats[k];
      const isNum = typeof v === 'number';
      html += `<td class="${isNum ? 'num' : ''} ${grid.bold[k] ? 'b' : ''}">${fmt(v, f).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>`;
    }
    html += '</tr>';
  }
  html += '</table>';
  const p2 = await browser.newPage({ viewport: { width: 1500, height: 600 }, deviceScaleFactor: 2 });
  await p2.setContent(html);
  await p2.screenshot({ path: path.join(OUT, '4-sheet.png'), fullPage: true });

  check(errors.length === 0, `No page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  fs.writeFileSync(path.join(OUT, 'findings.txt'), findings.join('\n') + '\n');
  console.log(findings.join('\n'));
  await browser.close();
})().catch((e) => { console.error('HARNESS ERROR:', e); console.log(findings.join('\n')); process.exit(1); });
