// Writes a ReportResult to a worksheet. Rules:
//  - number formats are set BEFORE values (text columns use "@", so a memo like "=HYPERLINK(...)" stays inert text);
//  - 5,000-row batches, one sync per batch;
//  - the table starts at A1 with its header frozen; a Pull Info block sits to the right of it;
//  - report id + parameters are saved as worksheet custom properties (ExcelApi 1.12) so Refresh can re-run.

const BATCH = 5000;
const FORMATS = {
  text: '@',
  date: 'yyyy-mm-dd',
  money: '#,##0.00;(#,##0.00)',
  int: '0',
};
const SHORT = { trial_balance: 'TB', journal_entries: 'JE', gl_detail: 'GL', ar_aging: 'AR', ap_aging: 'AP' };
export const PROP_REPORT = 'ns.report';
export const PROP_PARAMS = 'ns.params';

function isoToSerial(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s; // show whatever came back rather than hide it
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 + 25569;
}

function toCell(c, v) {
  if (v === '') return '';
  switch (c.type) {
    case 'date': return isoToSerial(v);
    case 'money': // exact decimal string from the server; Excel stores doubles, fine at 2 decimals
    case 'int': return Number(v);
    default: return v;
  }
}

const pad = (n) => String(n).padStart(2, '0');

function sheetNameFor(result, existing) {
  const d = new Date();
  const base = `${SHORT[result.info.report] ?? 'NS'} ${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  let name = base;
  for (let i = 2; existing.has(name.toLowerCase()); i++) name = `${base} (${i})`;
  return name;
}

function easternTime(isoUtc) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).format(new Date(isoUtc));
  } catch {
    return `${isoUtc} (UTC)`;
  }
}

function infoRows(r) {
  const i = r.info;
  const rows = [
    ['NetSuite pull', i.title, 'text'],
    ['Parameters', Object.entries(i.params).map(([k, v]) => `${k}=${v}`).join('; ') || '(none)', 'text'],
    ['Pulled by', i.user, 'text'],
    ['Pulled at (US Eastern)', easternTime(i.pulledAt), 'text'],
    ['Rows', i.rowCount, 'int'],
  ];
  if (i.debits !== null) rows.push(['Debits', Number(i.debits), 'money']);
  if (i.credits !== null) rows.push(['Credits', Number(i.credits), 'money']);
  if (i.balanced !== null) rows.push(['Balanced', i.balanced ? 'YES' : 'NO - debits do not equal credits', 'text']);
  rows.push(['Reconciliation', `${i.reconciliation} (rows and totals match NetSuite)`, 'text']);
  rows.push(['Validated report', i.validated ? 'yes' : 'NO - not yet reconciled to NetSuite reports', 'text']);
  if (i.mock) rows.push(['MOCK DATA', 'FAKE DATA - development only', 'text']);
  for (const n of i.notes) rows.push(['Note', n, 'text']);
  return rows;
}

async function setProp(context, sheet, key, value) {
  const p = sheet.customProperties.getItemOrNullObject(key);
  p.load('isNullObject');
  await context.sync();
  if (p.isNullObject) sheet.customProperties.add(key, value);
  else p.value = value;
}

/** Writes the result to a NEW sheet, or over the active sheet when `refresh` is true. Returns the sheet name. */
export async function writeReport(result, refresh = false) {
  return Excel.run(async (context) => {
    const sheets = context.workbook.worksheets;
    let sheet;
    if (refresh) {
      sheet = sheets.getActiveWorksheet();
      sheet.tables.load('items');
      await context.sync();
      sheet.tables.items.forEach((t) => t.delete());
      sheet.getRange().clear();
      await context.sync();
    } else {
      sheets.load('items/name');
      await context.sync();
      sheet = sheets.add(sheetNameFor(result, new Set(sheets.items.map((s) => s.name.toLowerCase()))));
    }

    // Layout: the table starts at A1 with its header row frozen; the Pull Info block sits to the right of it
    // (one empty column between), so it never pushes the data down or eats frozen screen space.
    const cols = result.columns;
    const header = sheet.getRangeByIndexes(0, 0, 1, cols.length);
    header.numberFormat = [cols.map(() => '@')];
    header.values = [cols.map((c) => c.label)];
    await context.sync();

    // Data in batches (formats first, then values).
    const rowFormats = cols.map((c) => FORMATS[c.type]);
    for (let off = 0; off < result.rows.length; off += BATCH) {
      const slice = result.rows.slice(off, off + BATCH);
      const range = sheet.getRangeByIndexes(1 + off, 0, slice.length, cols.length);
      range.numberFormat = slice.map(() => rowFormats);
      range.values = slice.map((r) => cols.map((c, i) => toCell(c, r[i] ?? '')));
      await context.sync();
    }

    if (result.rows.length > 0) {
      const tableRange = sheet.getRangeByIndexes(0, 0, result.rows.length + 1, cols.length);
      const table = sheet.tables.add(tableRange, true);
      table.name = `NS_${result.info.report}_${Date.now()}`;
      table.style = 'TableStyleLight9';
      tableRange.format.autofitColumns();
      await context.sync();
    }

    // Pull Info block to the right (formats first, then values).
    const info = infoRows(result);
    const infoCol = cols.length + 1;
    const infoRange = sheet.getRangeByIndexes(0, infoCol, info.length, 2);
    infoRange.numberFormat = info.map(([, , t]) => ['@', FORMATS[t]]);
    infoRange.values = info.map(([label, value]) => [label, value]);
    sheet.getRangeByIndexes(0, infoCol, info.length, 1).format.font.bold = true;
    infoRange.format.autofitColumns();
    sheet.freezePanes.freezeRows(1);
    await context.sync();

    await setProp(context, sheet, PROP_REPORT, result.info.report);
    await setProp(context, sheet, PROP_PARAMS, JSON.stringify(result.info.params));
    sheet.activate();
    sheet.load('name');
    await context.sync();
    return sheet.name;
  });
}

/** Report + parameters saved on the active sheet by a previous pull, or null. */
export async function readSavedPull() {
  return Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    const r = sheet.customProperties.getItemOrNullObject(PROP_REPORT);
    const p = sheet.customProperties.getItemOrNullObject(PROP_PARAMS);
    r.load(['isNullObject', 'value']);
    p.load(['isNullObject', 'value']);
    await context.sync();
    if (r.isNullObject || p.isNullObject) return null;
    try {
      const params = JSON.parse(p.value);
      return { report: r.value, params };
    } catch {
      return null;
    }
  });
}
