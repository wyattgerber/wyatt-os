// DEV-ONLY demo recorder: a simulated Excel window with the REAL task pane, formulas and drill-down inside it.
// Data: live mock API (default), or a capture from the real sandbox (--data, made by scripts/Export-DemoData.ps1).
// Narration: optional WAV clips (--narration <dir> with narration-01.wav ...); each scene lasts as long as its clip.
// Usage: node record.js [--data demo-data.json] [--narration <dir>] [--scenario scenario.json] [--out <dir>]
// Needs Playwright (+ chromium) and ffmpeg. Output: <out>/netsuite-addin-demo.mp4
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADDIN = path.join(ROOT, 'addin');
const OUT = path.resolve(arg('out') || path.join(__dirname, 'out'));
fs.mkdirSync(OUT, { recursive: true });
const sc = JSON.parse(fs.readFileSync(arg('scenario') || path.join(__dirname, 'scenario.json'), 'utf8'));
const data = arg('data') ? JSON.parse(fs.readFileSync(arg('data'), 'utf8')) : null;
const narrDir = arg('narration');
const stub = fs.readFileSync(path.join(ADDIN, 'preview', 'office-stub.js'), 'utf8');
const shell = fs.readFileSync(path.join(__dirname, 'shell.html'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const COLS = 'ABCDEFGHIJKLMN';

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const clipSeconds = (i) => {
  if (!narrDir) return 0;
  const f = path.join(narrDir, `narration-${String(i + 1).padStart(2, '0')}.wav`);
  if (!fs.existsSync(f)) return 0;
  return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
};

(async () => {
  const svc = data ? null : await import(pathToFileURL(path.join(ROOT, 'api', 'src', 'lib', 'service.js')).href);
  const env = { NETSUITE_MOCK: 'true', ALLOWED_USERS: 'demo.user@nussbaum.com' };
  const principal = Buffer.from(JSON.stringify({ userDetails: 'demo.user@nussbaum.com', userRoles: ['authenticated'] })).toString('base64');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: OUT, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  const t0 = Date.now();
  let signedIn = false;
  await page.exposeFunction('__markSignedIn', () => { signedIn = true; });
  await page.route('https://appsforoffice.microsoft.com/**', (r) => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.route('https://excel.demo/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/shell.html') return route.fulfill({ contentType: 'text/html', body: shell });
    if (u.pathname.startsWith('/api/')) {
      if (!signedIn) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":{"code":"UNAUTHENTICATED","message":"Please sign in."}}' });
      const body = route.request().postData() || '';
      let r;
      if (data) {
        // Replay the sandbox capture (real data), request by request.
        const b = body ? JSON.parse(body) : {};
        const replay = {
          '/api/me': () => data.me,
          '/api/reports': () => data.reports,
          '/api/periods': () => data.periods,
          '/api/balances': () => ({ results: b.requests.map((q) => data.formulas[canonical(q)] ?? { error: 'Not in the demo capture.' }), mock: false }),
          '/api/detail': () => data.details[canonical(b.request)],
          '/api/run': () => data.runs[canonical({ report: b.report, params: b.params })],
        };
        const out = replay[u.pathname] && replay[u.pathname]();
        r = out ? { status: 200, body: out } : { status: 404, body: { error: { message: 'Not in the demo capture.' } } };
      } else {
        const live = {
          '/api/me': () => svc.meService(principal, { env }), '/api/reports': () => svc.reportsService(principal, { env }),
          '/api/periods': () => svc.periodsService(principal, { env }), '/api/run': () => svc.runService(principal, body, { env }),
          '/api/balances': () => svc.formulasService(principal, body, { env }), '/api/detail': () => svc.detailService(principal, body, { env }),
        };
        r = live[u.pathname] ? await live[u.pathname]() : { status: 404, body: {} };
      }
      return route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    const f = path.join(ADDIN, u.pathname);
    return fs.existsSync(f) ? route.fulfill({ path: f }) : route.fulfill({ status: 404, body: '' });
  });

  await page.goto('https://excel.demo/shell.html');
  await page.evaluate(({ real, sc }) => {
    document.querySelector('.title span:last-child').textContent = real ? 'Simulated Excel window · real add-in code · REAL NetSuite sandbox data · INTERNAL' : 'Simulated Excel window · real add-in code · MOCK data';
    document.querySelector('.wm').textContent = real
      ? 'Simulation for illustration: real add-in code, real NetSuite SANDBOX data (internal use only)'
      : 'Simulation for illustration: the task pane and the numbers come from the real add-in and API in mock mode';
    window.demo.layout(sc);
  }, { real: !!data, sc });

  // ---- scene timing: each scene lasts at least its narration clip ----
  const starts = [];
  let sceneStart = 0, sceneMin = 0;
  const scene = async (i, minMs) => {
    starts[i] = (Date.now() - t0) / 1000;
    sceneStart = Date.now();
    sceneMin = Math.max(minMs, clipSeconds(i) * 1000 + 600);
    // Captions show the real syntax; the narration spells it out so the voice says it right.
    await page.evaluate((t) => window.demo.caption(t), sc.narration[i].replace(/N S dot /g, 'NS.'));
  };
  const endScene = async () => { const left = sceneMin - (Date.now() - sceneStart); if (left > 0) await wait(left); };
  const frame = () => page.frames().find((f) => /taskpane\.html/.test(f.url()));
  const calc = (fn, args, addr) => frame().evaluate(({ fn, args, addr }) => window.__cf[fn](...args, { address: `Sheet1!${addr}` }).catch((e) => ({ error: e.message })), { fn, args, addr });
  const actArgs = (acct, sub) => [acct, sc.period, null, sub, null, null, null, null, null];
  const actText = (acct, sub) => `=NS.ACTIVITY("${acct}","${sc.period}"${sub ? `,,"${sub}"` : ''})`;
  const cell = (r, c) => `${COLS[c + 1]}${r + 3}`;
  const balRow0 = 3 + sc.rows.length + 2;

  await wait(800);
  await scene(0, 2600);
  await endScene();

  await scene(1, 2600);
  await page.evaluate(() => window.demo.openPane());
  await page.waitForFunction(() => !!document.getElementById('tp').contentWindow.document.querySelector('#signinBtn'));
  await frame().waitForSelector('#signin:not([hidden])');
  await wait(1200);
  await frame().click('#signinBtn');
  await frame().waitForSelector('#main:not([hidden])');
  await endScene();

  // First formula, typed
  await scene(2, 3000);
  const firstAddr = cell(0, 0);
  const firstSub = sc.columns[0].subsidiary;
  await page.evaluate(({ a, t }) => window.demo.type(a, t), { a: firstAddr, t: actText(sc.rows[0].account, firstSub) });
  await page.evaluate(({ a, t }) => window.demo.commitFormula(a, t), { a: firstAddr, t: actText(sc.rows[0].account, firstSub) });
  const first = await calc('ACTIVITY', actArgs(sc.rows[0].account, firstSub), firstAddr);
  await page.evaluate(({ a, x }) => window.demo.result(a, x), { a: firstAddr, x: first });
  await endScene();

  // The rest of the statement, in one batch
  await scene(3, 3000);
  const jobs = [];
  sc.rows.forEach((row, r) => sc.columns.forEach((col, c) => { if (r || c) jobs.push({ a: cell(r, c), args: actArgs(row.account, col.subsidiary), t: actText(row.account, col.subsidiary) }); }));
  for (const j of jobs) await page.evaluate(({ a, t }) => window.demo.commitFormula(a, t), j);
  await wait(500);
  const vals = await Promise.all(jobs.map((j) => calc('ACTIVITY', j.args, j.a)));
  const got = { [firstAddr]: first };
  for (let i = 0; i < jobs.length; i++) { got[jobs[i].a] = vals[i]; await page.evaluate(({ a, x }) => (typeof x === 'number' ? window.demo.result(a, x) : window.demo.error(a, '#VALUE!')), { a: jobs[i].a, x: vals[i] }); await wait(70); }
  await page.evaluate(({ got, n, cols, rowOfNet }) => {
    for (let c = 0; c < cols; c++) {
      let s = 0;
      for (let r = 0; r < n; r++) { const v = got[`${'BCDEFG'[c]}${r + 3}`]; s += typeof v === 'number' ? v : 0; }
      window.demo.set(`${'BCDEFG'[c]}${rowOfNet}`, Math.round(s * 100) / 100, 'b num');
    }
  }, { got, n: sc.rows.length, cols: sc.columns.length, rowOfNet: 3 + sc.rows.length });
  await endScene();

  // Balances
  await scene(4, 2600);
  const lastCol = sc.columns.length - 1;
  const balJobs = sc.balances.map((b, i) => ({ a: `${COLS[lastCol + 1]}${balRow0 + i}`, acct: b.account }));
  for (const j of balJobs) await page.evaluate(({ a, t }) => window.demo.type(a, t), { a: j.a, t: `=NS.BALANCE("${j.acct}","${sc.period}")` }).then(() => page.evaluate(({ a, t }) => window.demo.commitFormula(a, t), { a: j.a, t: `=NS.BALANCE("${j.acct}","${sc.period}")` }));
  const bvals = await Promise.all(balJobs.map((j) => calc('BALANCE', [j.acct, sc.period, null, null, null, null, null, null], j.a)));
  for (let i = 0; i < balJobs.length; i++) await page.evaluate(({ a, x }) => window.demo.result(a, x), { a: balJobs[i].a, x: bvals[i] });
  await endScene();

  // Typo
  await scene(5, 3000);
  const typoRow = balRow0 + sc.balances.length + 1;
  const typoText = `=NS.BALANCE("${sc.typo.account}","${sc.typo.period}")`;
  await page.evaluate(({ r }) => window.demo.set(`A${r}`, 'Typo check'), { r: typoRow });
  await page.evaluate(({ a, t }) => window.demo.type(a, t), { a: `B${typoRow}`, t: typoText });
  await page.evaluate(({ a, t }) => window.demo.commitFormula(a, t), { a: `B${typoRow}`, t: typoText });
  const typo = await calc('BALANCE', [sc.typo.account, sc.typo.period, null, null, null, null, null, null], `B${typoRow}`);
  await page.evaluate(({ r, m }) => { window.demo.error(`B${r}`, '#VALUE!'); window.demo.set(`E${r}`, `← ${m}`); }, { r: typoRow, m: typo && typo.error ? typo.error : '' });
  await endScene();

  // Drill-down
  const drillAddr = cell(sc.drill.row, sc.drill.column);
  await scene(6, 2400);
  await page.evaluate((a) => window.demo.select(a), drillAddr);
  await endScene();
  await scene(7, 3600);
  await frame().evaluate((a) => { window.__activeCell = `Sheet1!${a}`; }, drillAddr);
  await frame().click('#detail');
  await frame().waitForFunction(() => /Done:/.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
  const dt = await frame().evaluate(() => window.__sheets.find((s) => s.name.startsWith('DT ')).name);
  await page.evaluate((n) => window.demo.showAddinSheet(n), dt);
  await endScene();

  // Full report
  await scene(8, 3400);
  await frame().selectOption('#report', sc.report.id);
  await wait(300);
  for (const [k, v] of Object.entries(sc.report.params)) await frame().selectOption(`#p_${k}`, v);
  await wait(500);
  await frame().click('#run');
  await frame().waitForFunction(() => /Done:/.test(document.querySelector('#status').textContent) && /on sheet "TB /.test(document.querySelector('#status').textContent), null, { timeout: 30000 });
  const tb = await frame().evaluate(() => window.__sheets.find((s) => s.name.startsWith('TB ')).name);
  await page.evaluate((n) => window.demo.showAddinSheet(n), tb);
  await endScene();

  await scene(9, 3400);
  await endScene();
  await wait(600);

  const video = page.video();
  await context.close();
  await browser.close();
  const webm = await video.path();

  // ---- mux: video + narration clips at their scene start times ----
  const mp4 = path.join(OUT, 'netsuite-addin-demo.mp4');
  const clips = narrDir ? sc.narration.map((_, i) => path.join(narrDir, `narration-${String(i + 1).padStart(2, '0')}.wav`)).filter((f) => fs.existsSync(f)) : [];
  const ff = ['-v', 'error', '-y', '-i', webm];
  if (clips.length) {
    clips.forEach((c) => ff.push('-i', c));
    const delays = clips.map((_, i) => `[${i + 1}:a]aresample=48000,adelay=${Math.round(starts[i] * 1000 + 250)}:all=1[a${i}]`).join(';');
    ff.push('-filter_complex', `${delays};${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0[aout]`, '-map', '0:v', '-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
  }
  ff.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-movflags', '+faststart', mp4);
  execFileSync('ffmpeg', ff);
  console.log(`Wrote ${mp4} (${clips.length} narration clips; scene starts: ${starts.map((s) => s.toFixed(1)).join(', ')} s)`);
})().catch((e) => { console.error('DEMO ERROR', e); process.exit(1); });
