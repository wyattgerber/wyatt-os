// DEV-ONLY. Captures the demo scenario's API answers from the REAL NetSuite sandbox (run via
// scripts/Export-DemoData.ps1, which provides the NETSUITE_* settings from 1Password).
// Output: one JSON file the demo recorder replays, so the video shows real sandbox data.
// The file contains real (sandbox) financial data: keep it out of the repo (it is written under api/out/).
// Usage: node capture.mjs <output.json>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { detailService, formulasService, meService, periodsService, reportsService, runService } from '../../../api/src/lib/service.js';

/** Stable key for a request object (sorted keys at every level). Must match record.js. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The requests the demo's cells make, shaped exactly like addin/functions.js builds them. */
export function scenarioRequests(sc) {
  const f = (sub) => (sub ? { subsidiary: sub } : {});
  const cells = [];
  sc.rows.forEach((row) => sc.columns.forEach((col) => cells.push({ fn: 'activity', account: row.account, from: sc.period, to: sc.period, filters: f(col.subsidiary) })));
  sc.balances.forEach((b) => cells.push({ fn: 'balance', account: b.account, period: sc.period, filters: {} }));
  cells.push({ fn: 'balance', account: sc.typo.account, period: sc.typo.period, filters: {} });
  const drill = { fn: 'activity', account: sc.rows[sc.drill.row].account, from: sc.period, to: sc.period, filters: f(sc.columns[sc.drill.column].subsidiary) };
  return { cells, drill };
}

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: node capture.mjs <output.json>');
  const email = process.env.CLI_USER_EMAIL;
  if (!email) throw new Error('Set CLI_USER_EMAIL.');
  const principal = Buffer.from(JSON.stringify({ userDetails: email, userRoles: ['authenticated'] })).toString('base64');
  const sc = JSON.parse(readFileSync(process.env.DEMO_SCENARIO || new URL('./scenario.json', import.meta.url), 'utf8')); // DEMO_SCENARIO: test with mock names
  const { cells, drill } = scenarioRequests(sc);
  const ok = (r, what) => { if (r.status !== 200) throw new Error(`${what} failed (HTTP ${r.status}): ${JSON.stringify(r.body)}`); return r.body; };

  const data = { capturedAt: new Date().toISOString(), source: 'netsuite-sandbox', formulas: {}, details: {}, runs: {} };
  data.me = ok(await meService(principal), 'me');
  data.reports = ok(await reportsService(principal), 'reports');
  data.periods = ok(await periodsService(principal), 'periods');
  const fr = ok(await formulasService(principal, JSON.stringify({ requests: cells }), { log: (m) => console.error(m) }), 'formulas');
  cells.forEach((c, i) => { data.formulas[canonical(c)] = fr.results[i]; });
  data.details[canonical(drill)] = ok(await detailService(principal, JSON.stringify({ request: drill }), { log: (m) => console.error(m) }), 'detail');
  const runKey = canonical({ report: sc.report.id, params: sc.report.params });
  data.runs[runKey] = ok(await runService(principal, JSON.stringify({ report: sc.report.id, params: sc.report.params }), { log: (m) => console.error(m) }), 'report');

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(data));
  const errors = Object.values(data.formulas).filter((r) => r.error).length;
  console.log(`Captured ${cells.length} formula cells (${errors} with an error, expected 1: the typo), 1 drill-down (${data.details[canonical(drill)].rows.length} rows), 1 ${sc.report.id} (${data.runs[runKey].rows.length} rows).`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((e) => { console.error('Capture failed:', e.message); process.exit(1); });
}
