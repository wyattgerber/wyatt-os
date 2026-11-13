import { FriendlyError, getMe, getReports, runReport } from './api';
import { signIn } from './auth';
import { readSavedPull, writeReport } from './excelWriter';
import { ReportMeta } from '../types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let reports: ReportMeta[] = [];
let busy = false;

function setStatus(msg: string, kind: '' | 'err' | 'ok' = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind;
}

// --- checkpoint the form so a reload / auth redirect does not wipe input ---
const CK = 'ns.form';
const saveForm = () => {
  try { sessionStorage.setItem(CK, JSON.stringify({ report: $<HTMLSelectElement>('report').value, params: readParams() })); } catch { /* storage may be blocked */ }
};
const loadForm = (): { report?: string; params?: Record<string, string> } => {
  try { return JSON.parse(sessionStorage.getItem(CK) ?? '{}'); } catch { return {}; }
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function defaultFor(name: string): string {
  const now = new Date();
  if (name === 'startDate') return iso(new Date(now.getFullYear(), now.getMonth(), 1));
  if (name === 'endDate' || name === 'asOfDate') return iso(now);
  return '';
}

function current(): ReportMeta {
  return reports.find((r) => r.id === $<HTMLSelectElement>('report').value) ?? reports[0];
}

function readParams(): Record<string, string> {
  const out: Record<string, string> = {};
  $('params').querySelectorAll('input').forEach((i) => { if (i.value.trim()) out[i.name] = i.value.trim(); });
  return out;
}

function renderParams(values: Record<string, string> = {}) {
  const r = current();
  const box = $('params');
  box.replaceChildren();
  for (const p of r.params) {
    const label = document.createElement('label');
    label.textContent = p.label;
    label.htmlFor = `p_${p.name}`;
    const input = document.createElement('input');
    input.id = `p_${p.name}`;
    input.name = p.name;
    input.type = p.type === 'date' ? 'date' : 'text';
    input.value = values[p.name] ?? defaultFor(p.name);
    input.required = p.required;
    input.addEventListener('input', saveForm);
    box.append(label, input);
    if (p.help) { const h = document.createElement('div'); h.className = 'muted'; h.textContent = p.help; box.append(h); }
  }
  const notice = $('notice');
  notice.hidden = r.validated;
  notice.textContent = r.validated ? '' : `Not yet validated against NetSuite reports. ${r.notes[0] ?? ''}`;
}

function setBusy(b: boolean) {
  busy = b;
  ($('run') as HTMLButtonElement).disabled = b;
  ($('refresh') as HTMLButtonElement).disabled = b;
}

async function execute(reportId: string, params: Record<string, string>, refresh: boolean) {
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
    const list = await getReports();
    reports = list.reports;
    const sel = $<HTMLSelectElement>('report');
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
