/**
 * Minimal fake of the N/ modules the vendor-invoice Suitelet uses, so the AMD file can be loaded
 * in Node and onRequest() called with fake requests. Data comes from a small fixture set.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const nodeCrypto = require('crypto');

function makeEnv(opts) {
  opts = opts || {};
  const logs = [];
  const queries = [];
  const created = [];      // files created { id, name, contents, description, folder }
  const attached = [];     // { file, bill }
  const submitted = [];    // record.submitFields calls
  const loadedFiles = [];  // ids/paths passed to file.load
  let nextId = 9000;

  const files = Object.assign({}, opts.files || {});   // id or path -> { name, contents, description, folder }

  const bills = opts.bills || [
    { id: 2508, tranid: 'EPO-00012345', date: '11/01/2026', amount: '-125.00', status: 'Open', vendorid: 'ACME', vendorname: 'Acme Parts', unit: '', category: 1 },
    { id: 2509, tranid: 'EPO-00012346', date: '11/02/2026', amount: '-80.00', status: 'Open', vendorid: 'ACME', vendorname: 'Acme Parts', unit: '2222', category: 1 }
  ];

  function rowObj(o) { return Object.assign({}, o); }

  const query = {
    runSuiteQL({ query: q, params }) {
      queries.push({ q, params });
      let rows = [];
      if (/FROM vendorcategory WHERE externalid = \?/.test(q)) rows = ({ AP: [{ id: 1 }], TMT: [{ id: 2 }] })[params[0]] || [];
      else if (/FROM vendorcategory WHERE name = \?/.test(q)) rows = [];
      else if (/SELECT t\.custbody_unit AS u FROM transaction t WHERE ROWNUM/.test(q)) rows = [];
      else if (/SELECT COUNT\(\*\) AS n FROM file WHERE description LIKE/.test(q)) rows = [{ n: opts.pending || 2 }];
      else if (/FROM mediaitemfolder WHERE externalid = \?/.test(q)) rows = [{ id: 777 }];
      else if (/SELECT id FROM file WHERE folder = \? AND name = \?/.test(q)) rows = [];
      else if (/FROM transaction t LEFT JOIN vendor v ON v.id = t.entity WHERE t.type = 'VendBill' AND UPPER\(t.tranid\) IN/.test(q)) {
        rows = bills.filter(b => params.indexOf(b.tranid.toUpperCase()) >= 0).map(b => ({ id: b.id, tranid: b.tranid, vendorid: b.vendorid }));
      }
      else if (/SELECT id, tranid FROM transaction WHERE id = \? AND type = 'VendBill'/.test(q)) {
        rows = bills.filter(b => b.id === params[0]).map(b => ({ id: b.id, tranid: b.tranid }));
      }
      else if (/SELECT custbody_unit AS unit FROM transaction WHERE id = \?/.test(q)) {
        rows = bills.filter(b => b.id === params[0]).map(b => ({ unit: b.unit }));
      }
      else if (/SELECT t.id, t.externalid, t.otherrefnum/.test(q)) {
        rows = bills.filter(b => params.indexOf(b.id) >= 0).map(b => ({ id: b.id, externalid: '', otherrefnum: 'INV-' + b.id, unit: b.unit, vendorid: b.vendorid, vendorname: b.vendorname }));
      }
      else if (/SELECT COUNT\(\*\) AS n FROM transaction t/.test(q)) rows = [{ n: bills.length }];
      else if (/FROM \(SELECT x\.id AS id/.test(q)) rows = bills.map(b => ({ id: b.id, tranid: b.tranid, vendorid: b.vendorid, vendorname: b.vendorname, unit: b.unit }));
      else if (/FROM vendor/.test(q) && /companyname/.test(q)) rows = [];
      else if (/SELECT id, description FROM file WHERE id = \?/.test(q)) {
        const f = files[params[0]]; rows = f ? [{ id: params[0], description: f.description }] : [];
      }
      else if (opts.query) rows = opts.query(q, params) || [];
      return { asMappedResults: () => rows.map(rowObj) };
    }
  };

  function result(id, values, texts) {
    return {
      id: String(id),
      getValue(n) { const k = typeof n === 'string' ? n : (n.join ? n.join + '.' + n.name : n.name); return values[k]; },
      getText(n) { const k = typeof n === 'string' ? n : n.name; return (texts || {})[k] || ''; }
    };
  }
  function idsIn(filters) {
    let out = null;
    (function walk(f) {
      if (!Array.isArray(f)) return;
      if (f[0] === 'internalid' && f[1] === 'anyof') out = [].concat(f[2]).map(Number);
      f.forEach(walk);
    })(filters);
    return out;
  }
  function flat(filters) { return JSON.stringify(filters); }

  const search = {
    Sort: { ASC: 'ASC', DESC: 'DESC' },
    createColumn: (c) => c,
    create({ type, filters, columns }) {
      let rows = [];
      const fl = flat(filters);
      if (type === 'employee') {
        const emp = opts.employee === undefined ? defaultEmployee() : opts.employee;
        rows = emp ? [result(emp.id, emp.values)] : [];
      } else if (type === 'transaction' && fl.indexOf('@NONE@') >= 0) {
        rows = bills.filter(b => !b.hasFile).map(billResult);
      } else if (type === 'vendorbill' && fl.indexOf('"internalid","anyof"') >= 0) {
        const ids = idsIn(filters) || [];
        rows = bills.filter(b => ids.indexOf(b.id) >= 0).map(billResult);
      }
      return {
        run: () => ({ each(cb) { for (const r of rows) { if (cb(r) === false) break; } } }),
        runPaged: ({ pageSize }) => ({
          count: rows.length,
          fetch: ({ index }) => ({ data: rows.slice(index * pageSize, index * pageSize + pageSize) })
        })
      };
    }
  };
  function billResult(b) {
    return result(b.id, { tranid: b.tranid, trandate: b.date, amount: b.amount }, { statusref: b.status });
  }

  const SECRET = opts.cookieSecret;
  function sha(t) { return nodeCrypto.createHash('sha256').update(t).digest('hex'); }
  const CODE = sha('passcode|salt');
  function defaultEmployee() {
    return { id: 42, values: { entityid: 'Test Person', email: 'test@example.com', custentity_vendor_invoice_passcode: CODE, giveaccess: false, custentity_vendor_invoice_upload: opts.uploadFlag === undefined ? true : opts.uploadFlag } };
  }
  const authCookie = 'nts_doclookup_auth=42.' + sha('42|' + CODE + '|' + SECRET);

  const file = {
    Type: { PDF: 'PDF' },
    load({ id }) {
      loadedFiles.push(id);
      const f = files[id];
      if (!f) { const e = new Error('That record does not exist. path: ' + id); e.name = 'RCRD_DSNT_EXIST'; throw e; }
      return Object.assign({ id, save() { return id; }, getContents() { return f.contents; } }, f);
    },
    create(o) {
      const id = nextId++;
      const rec = { id, name: o.name, contents: o.contents, description: o.description, folder: o.folder };
      return { save() { created.push(rec); files[id] = rec; return id; } };
    },
    delete({ id }) { delete files[id]; }
  };

  const record = {
    Type: { VENDOR_BILL: 'vendorbill', FOLDER: 'folder', EMPLOYEE: 'employee' },
    attach(o) { attached.push({ file: o.record.id, bill: o.to.id }); },
    submitFields(o) { submitted.push(o); },
    create() { return { setValue() {}, save() { return 555; } }; },
    load() { throw new Error('not in mock'); }
  };

  const log = {};
  ['debug', 'audit', 'error', 'emergency'].forEach(l => { log[l] = (o) => logs.push({ level: l, title: o.title, details: o.details }); });

  const cacheStore = {};
  const cache = {
    Scope: { PRIVATE: 'PRIVATE' },
    getCache({ name }) {
      return {
        get({ key, loader }) { const k = name + ':' + key; if (!(k in cacheStore)) cacheStore[k] = loader(); return cacheStore[k]; },
        remove({ key }) { delete cacheStore[name + ':' + key]; }
      };
    }
  };

  const modules = {
    'N/search': search, 'N/file': file, 'N/record': record, 'N/query': query,
    'N/runtime': { accountId: '3816459_SB1', getCurrentScript: () => ({ id: 'customscript_vendor_invoice_lookup', deploymentId: 'customdeploy_vendor_invoice_lookup' }) },
    'N/format': { Type: { DATE: 'date' }, format: ({ value }) => (value.getMonth() + 1) + '/' + value.getDate() + '/' + value.getFullYear() },
    'N/crypto': { HashAlg: { SHA256: 'sha256' }, createHash: () => { let s = ''; return { update({ input }) { s += input; }, digest() { return sha(s); } }; } },
    'N/encode': { Encoding: { HEX: 'HEX' } },
    'N/log': log,
    'N/url': { HostType: { APPLICATION: 'APP' }, resolveDomain: () => '3816459-sb1.app.netsuite.com', resolveRecord: ({ recordId }) => '/app/accounting/transactions/vendbill.nl?id=' + recordId },
    'N/cache': cache
  };

  return { modules, logs, queries, created, attached, submitted, files, loadedFiles, authCookie, bills };
}

/** Loads the AMD script text with the env's fake modules. `patch` can rewrite the source first. */
function load(path, env, patch) {
  let src = fs.readFileSync(path, 'utf8');
  if (patch) src = patch(src);
  let mod = null;
  const sandbox = {
    define(deps, factory) { mod = factory.apply(null, deps.map(d => { if (!env.modules[d]) throw new Error('no mock for ' + d); return env.modules[d]; })); },
    console, Date, Math, JSON, String, Number, Array, Object, RegExp, Error, encodeURIComponent, decodeURIComponent, parseInt, isFinite, isNaN
  };
  vm.runInNewContext(src, sandbox, { filename: path });
  return mod;
}

function request(mod, env, params, o) {
  o = o || {};
  const headers = {};
  if (o.signedIn !== false) headers.cookie = env.authCookie;
  const req = {
    method: o.method || 'GET',
    parameters: Object.assign({ script: '101', deploy: '1' }, params || {}),
    headers, clientIpAddress: '10.1.2.3'
  };
  const res = {
    headers: [], body: '', file: null,
    setHeader(h) { this.headers.push(h); },
    write(s) { this.body += s; },
    writeFile(o2) { this.file = o2.file; }
  };
  mod.onRequest({ request: req, response: res });
  return res;
}

module.exports = { makeEnv, load, request };
