import { FriendlyError, getMe, getPeriods, getReports, runReport } from './api.js';
import { signIn } from './auth.js';
import { readSavedPull, writeReport } from './excelWriter.js';

const $ = (id) => document.getElementById(id);
let reports = [];
let busy = false;

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

// --- checkpoint the form so a reload / auth redirect does not wipe input ---
const CK = 'ns.form';
const saveForm = () => {
  try { sessionStorage.setItem(CK, JSON.stringify({ report: $('report').value, params: readParams() })); } catch { /* storage may be blocked */ }
};
const loadForm = () => {
  try { return JSON.parse(sessionStorage.getItem(CK) ?? '{}'); } catch { return {}; }
};

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PERIOD_PARAMS = new Set(['period', 'fromPeriod', 'toPeriod']);
/** Monthly periods from NetSuite that have started, newest first. Empty if they could not be loaded (falls back to typing). */
let periods = [];

function defaultFor(name) {
  const now = new Date();
  if (name === 'startDate') return iso(new Date(now.getFullYear(), now.getMonth(), 1));
  if (name === 'endDate' || name === 'asOfDate') return iso(now);
  // Periods: default to last month (the usual month being closed/reviewed), if NetSuite has it.
  if (PERIOD_PARAMS.has(name)) {
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const want = `${last.toLocaleString('en-US', { month: 'short' })} ${last.getFullYear()}`;
    if (periods.length === 0 || periods.some((p) => p.name === want)) return want;
    return periods[Math.min(1, periods.length - 1)].name;
  }
  return '';
}

function current() {
  return reports.find((r) => r.id === $('report').value) ?? reports[0];
}

function readParams() {
  const out = {};
  $('params').querySelectorAll('input, select').forEach((i) => { if (i.value.trim()) out[i.name] = i.value.trim(); });
  return out;
}

function renderParams(values = {}) {
  const r = current();
  const box = $('params');
  box.replaceChildren();
  for (const p of r.params) {
    const label = document.createElement('label');
    label.textContent = p.label;
    label.htmlFor = `p_${p.name}`;
    let input;
    const value = values[p.name] ?? defaultFor(p.name);
    if (PERIOD_PARAMS.has(p.name) && periods.length > 0) {
      // Pick from NetSuite's real periods: a typo can't produce an empty report.
      const sel = document.createElement('select');
      sel.append(...periods.map((x) => new Option(x.name, x.name)));
      sel.value = periods.some((x) => x.name === value) ? value : defaultFor(p.name);
      sel.addEventListener('change', saveForm);
      input = sel;
    } else {
      const inp = document.createElement('input');
      inp.type = p.type === 'date' ? 'date' : 'text';
      inp.value = value;
      inp.addEventListener('input', saveForm);
      input = inp;
    }
    input.id = `p_${p.name}`;
    input.name = p.name;
    input.required = p.required;
    box.append(label, input);
    if (p.help) { const h = document.createElement('div'); h.className = 'muted'; h.textContent = p.help; box.append(h); }
  }
  const notice = $('notice');
  notice.hidden = r.validated;
  notice.textContent = r.validated ? '' : `Not yet validated against NetSuite reports. ${r.notes[0] ?? ''}`;
}

function setBusy(b) {
  busy = b;
  ($('run')).disabled = b;
  ($('refresh')).disabled = b;
}

async function execute(reportId, params, refresh) {
  if (busy) return; // guard against double clicks
  setBusy(true);
  setStatus('Pulling from NetSuite... large reports can take up to a minute.');
  try {
    const result = await runReport(reportId, params);
    setStatus(`Writing ${result.rows.length.toLocaleString('en-US')} rows to Excel...`);
    const name = await writeReport(result, refresh);
    setStatus(`Done: ${result.rows.length.toLocaleString('en-US')} rows on sheet "${name}". Reconciled to NetSuite totals.`, 'ok');
  } catch (e) {
    if (e instanceof FriendlyError && e.status === 401) { showSignIn(); return; }
    setStatus(e instanceof FriendlyError ? e.message : 'Something went wrong while writing to Excel. Please try again.', 'err');
    if (!(e instanceof FriendlyError)) console.error(e);
  } finally {
    setBusy(false);
  }
}

function showSignIn() {
  $('main').hidden = true;
  $('signin').hidden = false;
  setStatus('');
}

async function boot() {
  try {
    const me = await getMe();
    if (!me.allowed) {
      $('main').hidden = true;
      setStatus(`${me.email} is not set up for NetSuite reports. Ask the report owner for access.`, 'err');
      return;
    }
    $('who').textContent = `Signed in as ${me.email}`;
    $('mock').hidden = !me.mock;
    const [list, per] = await Promise.all([getReports(), getPeriods().catch(() => ({ periods: [] }))]);
    const todayIso = new Date().toISOString().slice(0, 10);
    periods = per.periods.filter((p) => p.start <= todayIso).reverse(); // started periods, newest first
    reports = list.reports;
    const sel = $('report');
    sel.replaceChildren(...reports.map((r) => new Option(r.title, r.id)));
    const saved = loadForm();
    if (saved.report && reports.some((r) => r.id === saved.report)) sel.value = saved.report;
    renderParams(saved.params);
    $('signin').hidden = true;
    $('main').hidden = false;
    setStatus('');
  } catch (e) {
    if (e instanceof FriendlyError && e.status === 401) showSignIn();
    else setStatus(e instanceof FriendlyError ? e.message : 'Could not start. Please reload the pane.', 'err');
  }
}

Office.onReady(() => {
  $('report').addEventListener('change', () => { renderParams(); saveForm(); });
  $('run').addEventListener('click', () => {
    const params = readParams();
    const missing = current().params.find((p) => p.required && !params[p.name]);
    if (missing) { setStatus(`${missing.label} is required.`, 'err'); return; }
    saveForm();
    void execute(current().id, params, false);
  });
  $('refresh').addEventListener('click', async () => {
    try {
      const saved = await readSavedPull();
      if (!saved) { setStatus('This sheet was not created by a NetSuite pull, so there is nothing to refresh.', 'err'); return; }
      void execute(saved.report, saved.params, true);
    } catch {
      setStatus('Could not read this sheet. Please try again.', 'err');
    }
  });
  $('signinBtn').addEventListener('click', async () => {
    try { setStatus('Opening sign-in...'); await signIn(); await boot(); }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Sign-in failed.', 'err'); }
  });
  void boot();
});
