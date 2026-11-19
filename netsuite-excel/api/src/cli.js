// Dev-only runner: executes one report through the SAME service code the Azure Function uses
// (allowlist, validation, paging, reconciliation gate), but from a terminal.
// Usage: node src/cli.js <report> [key=value ...]
//        node src/cli.js formulas     (requests JSON array in env CLI_REQUESTS; prints one line per formula)
//        node src/cli.js detail       (drill-down for the FIRST request in CLI_REQUESTS; summary + CLI_OUT file)
// Env: CLI_USER_EMAIL (must also be in ALLOWED_USERS), CLI_OUT (optional file for the full JSON), plus the NETSUITE_* settings.
// Prints a summary only (no row data) so the output is safe to paste; the full result goes to CLI_OUT.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { detailService, formulasService, runService } from './lib/service.js';

async function main() {
  const [report, ...kv] = process.argv.slice(2);
  if (!report) {
    console.error('Usage: node src/cli.js <report> [key=value ...]');
    process.exit(2);
  }
  const params = {};
  for (const pair of kv) {
    const i = pair.indexOf('=');
    if (i < 1) {
      console.error(`Bad parameter "${pair}" (expected key=value)`);
      process.exit(2);
    }
    params[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const email = process.env.CLI_USER_EMAIL;
  if (!email) {
    console.error('Set CLI_USER_EMAIL.');
    process.exit(2);
  }
  const header = Buffer.from(JSON.stringify({ userDetails: email, userRoles: ['authenticated'] })).toString('base64');

  const started = Date.now();
  if (report === 'formulas') {
    const requests = JSON.parse(process.env.CLI_REQUESTS || '[]');
    const fr = await formulasService(header, JSON.stringify({ requests }), { log: (m) => console.error(m) });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (fr.status !== 200) {
      console.log(`FAILED (HTTP ${fr.status}) after ${secs}s:`, JSON.stringify(fr.body));
      process.exit(1);
    }
    console.log(`OK in ${secs}s (${requests.length} formulas):`);
    requests.forEach((r, i) => {
      const res = fr.body.results[i];
      const args = r.fn === 'activity' ? `${r.account}, ${r.from}, ${r.to ?? r.from}` : `${r.account}, ${r.period ?? r.date}`;
      const f = r.filters && Object.keys(r.filters).length ? ` ${JSON.stringify(r.filters)}` : '';
      console.log(`  NS.${String(r.fn).toUpperCase()}(${args})${f} = ${res.error ? 'ERROR: ' + res.error : res.value}`);
    });
    return;
  }
  const reply = report === 'detail'
    ? await detailService(header, JSON.stringify({ request: JSON.parse(process.env.CLI_REQUESTS || '[]')[0] }), { log: (m) => console.error(m) })
    : await runService(header, JSON.stringify({ report, params }), { log: (m) => console.error(m) });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (reply.status !== 200) {
    console.log(`FAILED (HTTP ${reply.status}) after ${seconds}s:`, JSON.stringify(reply.body));
    process.exit(1);
  }
  const body = reply.body;
  console.log(`OK in ${seconds}s. Summary (no row data):`);
  console.log(JSON.stringify({ ...body.info, rowsReturned: body.rows.length }, null, 2));
  console.log('First row:', JSON.stringify(Object.fromEntries(body.columns.map((c, i) => [c.label, body.rows[0]?.[i]]))));
  if (process.env.CLI_OUT) {
    mkdirSync(dirname(process.env.CLI_OUT), { recursive: true });
    writeFileSync(process.env.CLI_OUT, JSON.stringify(body, null, 2));
    console.log(`Full result written to ${process.env.CLI_OUT}`);
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
