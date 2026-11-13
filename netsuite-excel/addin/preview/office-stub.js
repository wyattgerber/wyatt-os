// Dev-only stand-in for office.js in a plain browser: records what the add-in writes to "Excel".
// Used by preview/run.js. Not part of the add-in build.
(function () {
  const sheets = [];
  window.__sheets = sheets;
  let active = null;
  const mk = (name) => { const s = { name, cells: {}, formats: {}, bold: {}, tables: [], props: {}, valueBeforeFormat: 0, frozenRows: 0 }; sheets.push(s); return s; };
  class Range {
    constructor(s, r, c, rows, cols) {
      Object.assign(this, { s, r, c, rows, cols });
      const self = this;
      this.format = {
        font: { set bold(v) { for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) s.bold[`${r + i},${c + j}`] = v; } },
        autofitColumns() {},
      };
    }
    set numberFormat(m) { m.forEach((row, i) => row.forEach((f, j) => { this.s.formats[`${this.r + i},${this.c + j}`] = f; })); }
    set values(m) {
      if (m.length !== this.rows || m.some((row) => row.length !== this.cols)) throw new Error(`values ${m.length}x${m[0] && m[0].length} != range ${this.rows}x${this.cols}`);
      m.forEach((row, i) => row.forEach((v, j) => {
        const k = `${this.r + i},${this.c + j}`;
        if (!(k in this.s.formats)) this.s.valueBeforeFormat++;
        this.s.cells[k] = v;
      }));
    }
    clear() { this.s.cells = {}; this.s.formats = {}; this.s.bold = {}; }
  }
  const wrap = (s) => ({
    get name() { return s.name; },
    load() {},
    tables: {
      load() {},
      get items() { return s.tables.map((t) => ({ delete() { s.tables.splice(s.tables.indexOf(t), 1); } })); },
      add(range) { const t = { range, name: '', style: '' }; s.tables.push(t); return t; },
    },
    getRange() { return new Range(s, 0, 0, 1, 1); },
    getRangeByIndexes(r, c, rows, cols) { return new Range(s, r, c, rows, cols); },
    customProperties: {
      getItemOrNullObject(k) {
        return { load() {}, get isNullObject() { return !(k in s.props); }, get value() { return s.props[k]; }, set value(v) { s.props[k] = v; } };
      },
      add(k, v) { if (String(v).length > 255) throw new Error('custom property value > 255 chars'); s.props[k] = v; },
    },
    activate() { active = s; },
    freezePanes: { freezeRows(n) { s.frozenRows = n; }, unfreeze() { s.frozenRows = 0; } },
  });
  const worksheets = {
    load() {},
    get items() { return sheets.map(wrap); },
    add(name) {
      if (name.length > 31) throw new Error(`sheet name too long: ${name}`);
      if (/[\\/?*[\]:]/.test(name)) throw new Error(`bad sheet name: ${name}`);
      if (sheets.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new Error(`duplicate sheet: ${name}`);
      return wrap(mk(name));
    },
    getActiveWorksheet() { if (!active) active = mk('Sheet1'); return wrap(active); },
  };
  window.Excel = { run: async (cb) => cb({ workbook: { worksheets }, sync: async () => {} }) };
  window.Office = {
    onReady(cb) { setTimeout(() => cb && cb({ host: 'Excel' }), 0); return Promise.resolve({ host: 'Excel' }); },
    AsyncResultStatus: { Succeeded: 'succeeded' },
    EventType: { DialogMessageReceived: 'dialogMessageReceived', DialogEventReceived: 'dialogEventReceived' },
    context: {
      ui: {
        displayDialogAsync(url, opts, cb) {
          window.__dialogUrl = url;
          cb({ status: 'succeeded', value: {
            addEventHandler(ev, h) {
              if (ev === 'dialogMessageReceived') setTimeout(async () => { if (window.__markSignedIn) await window.__markSignedIn(); h({ message: 'signed-in' }); }, 20);
            },
            close() {},
          } });
        },
      },
    },
  };
})();
