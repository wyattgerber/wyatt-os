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
  (opts.docs || []).forEach(d => { files[d.id] = { name: d.name, contents: 'JVBERi0=', description: d.description, folder: 777 }; });

  // Subsidiaries: 1 = Nussbaum Transportation, 2 = NTS Logistics, 3 = West. Categories: 1 = AP, 2 = TMT.
  const bills = opts.bills || [
    { id: 2508, tranid: 'EPO-00012345', date: '11/01/2026', amount: '-125.00', status: 'Open', vendorid: 'ACME', vendorname: 'Acme Parts', unit: '', category: 1, sub: 1, entity: 10 },
    { id: 2509, tranid: 'EPO-00012346', date: '11/02/2026', amount: '-80.00', status: 'Open', vendorid: 'ACME', vendorname: 'Acme Parts', unit: '2222', category: 1, sub: 1, entity: 10 }
  ].concat(opts.extraBills || []);
  const vendors = opts.vendors || [
    { id: 10, entityid: 'ACME', companyname: 'Acme Parts', category: 1, subsidiary: 1, shared: [2] },
    { id: 11, entityid: 'TMTCO', companyname: 'TMT Company', category: 2, subsidiary: 1, shared: [] },
    { id: 12, entityid: 'WESTCO', companyname: 'West Company', category: 1, subsidiary: 3, shared: [] },
    { id: 13, entityid: 'SHARED', companyname: 'Shared Supply', category: 1, subsidiary: 3, shared: [1] }
  ];
  /** The access limit at the end of the params (scopeSql always appends last). */
  function tail(q, params) {
    const nSub = (/stl\.subsidiary IN \(([?, ]*)\)/.exec(q) || [, ''])[1].split('?').length - 1;
    const nCat = (/v\.category IN \(([?, ]*)\)/.exec(q) || [, ''])[1].split('?').length - 1;
    const end = params.length, rest = params.slice(0, end - nSub - nCat);
    return { subs: nSub ? params.slice(end - nSub - nCat, end - nCat) : null, cats: nCat ? params.slice(end - nCat) : null, rest, none: /AND 1 = 0/.test(q) };
  }
  function inScope(b, t) {
    if (t.none) return false;
    if (t.subs && t.subs.indexOf(b.sub) < 0) return false;
    if (t.cats && t.cats.indexOf(b.category) < 0) return false;
    return true;
  }

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
        const t = tail(q, params);
        rows = bills.filter(b => t.rest.indexOf(b.tranid.toUpperCase()) >= 0 && inScope(b, t)).map(b => ({ id: b.id, tranid: b.tranid, vendorid: b.vendorid }));
      }
      else if (/^SELECT t\.id AS id FROM transaction t LEFT JOIN vendor v ON v\.id = t\.entity WHERE t\.type = 'VendBill' AND t\.id IN/.test(q)) {
        const t = tail(q, params);
        rows = bills.filter(b => t.rest.indexOf(b.id) >= 0 && inScope(b, t)).map(b => ({ id: b.id }));
      }
      else if (/^SELECT vnd\.id AS id FROM vendor vnd WHERE vnd\.id IN/.test(q)) {
        if (opts.noVsr && /vendorsubsidiaryrelationship/.test(q)) throw Object.assign(new Error('Search error: Unknown identifier vendorsubsidiaryrelationship'), { name: 'SSS_SEARCH_ERROR_OCCURRED' });
        const n = (/vnd\.id IN \(([?, ]*)\)/.exec(q)[1].split('?').length - 1);
        const ids = params.slice(0, n), subs = params.slice(n, n + (params.length - n) / (/vendorsubsidiaryrelationship/.test(q) ? 2 : 1));
        rows = vendors.filter(v => ids.indexOf(v.id) >= 0 && (subs.indexOf(v.subsidiary) >= 0 || (/vendorsubsidiaryrelationship/.test(q) && v.shared.some(x => subs.indexOf(x) >= 0)))).map(v => ({ id: v.id }));
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
      else if (/SELECT COUNT\(\*\) AS n FROM transaction t/.test(q)) {
        const t = tail(q, params), cat = t.rest[t.rest.length - 1];
        rows = [{ n: bills.filter(b => b.category === cat && inScope(b, t)).length }];
      }
      else if (/FROM \(SELECT x\.id AS id/.test(q)) {
        const t = tail(q, params), cat = t.rest[t.rest.length - 1];
        rows = bills.filter(b => b.category === cat && inScope(b, t)).map(b => ({ id: b.id, tranid: b.tranid, vendorid: b.vendorid, vendorname: b.vendorname, unit: b.unit }));
      }
      else if (/FROM vendor/.test(q) && /companyname/.test(q)) {
        const vsr = /vendorsubsidiaryrelationship/.test(q);
        if (opts.noVsr && vsr) throw Object.assign(new Error('Search error: Unknown identifier vendorsubsidiaryrelationship'), { name: 'SSS_SEARCH_ERROR_OCCURRED' });
        const like = String(params[2]).replace(/%/g, ''), cat = params[4], subs = params.length > 5 ? params.slice(5, vsr ? 5 + (params.length - 5) / 2 : params.length) : null;
        rows = vendors.filter(v => (v.entityid.indexOf(like) >= 0 || v.companyname.toUpperCase().indexOf(like) >= 0) && v.category === cat
          && (!subs || subs.indexOf(v.subsidiary) >= 0 || (vsr && v.shared.some(x => subs.indexOf(x) >= 0))));
      }
      else if (/SELECT id, description FROM file WHERE id = \?/.test(q)) {
        const f = files[params[0]]; rows = f ? [{ id: params[0], description: f.description }] : [];
      }
      else if (/^SELECT id, name, description, createddate, TRUNC\(SYSDATE\)/.test(q)) {
        const pre = String(params[0]).replace(/%$/, '');
        rows = (opts.docs || []).filter(d => d.description.indexOf(pre) === 0).map(d => Object.assign({ age: 1 }, d));
      }
      else if (/^SELECT id, name, description, createddate FROM \(SELECT id, name, description, createddate FROM file WHERE description LIKE \? AND/.test(q)) {
        const pre = String(params[0]).replace(/%$/, ''), like = String(params[1]).replace(/%/g, '');
        rows = (opts.docs || []).filter(d => d.description.indexOf(pre) === 0 && (d.description.toUpperCase().indexOf(like) >= 0 || d.name.toUpperCase().indexOf(like) >= 0));
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
  function subsIn(filters) {
    let out = null;
    (function walk(f) { if (!Array.isArray(f)) return; if (f[0] === 'subsidiary' && f[1] === 'anyof') out = [].concat(f[2]).map(x => x === '@NONE@' ? -1 : Number(x)); f.forEach(walk); })(filters);
    return out;
  }
  function catIn(filters) {
    let out = null;
    (function walk(f) { if (!Array.isArray(f)) return; if (f[0] === 'vendor.category' && f[1] === 'anyof') out = Number(f[2]); f.forEach(walk); })(filters);
    return out;
  }

  const search = {
    Sort: { ASC: 'ASC', DESC: 'DESC' },
    createColumn: (c) => c,
    create({ type, filters, columns }) {
      let rows = [];
      const fl = flat(filters);
      const subs = subsIn(filters);
      if (type === 'employee') {
        const emp = opts.employee === undefined ? defaultEmployee() : opts.employee;
        if (emp && opts.missingScopeFields && columns.some(c => /custentity_vendor_invoice_(subs|groups)/.test(c))) { const e = new Error('An nlobjSearchColumn contains an invalid column: custentity_vendor_invoice_subs'); e.name = 'SSS_INVALID_SRCH_COL'; throw e; }
        rows = emp ? [result(emp.id, emp.values, emp.texts)] : [];
      } else if (type === 'transaction' && fl.indexOf('@NONE@","') < 0 && fl.indexOf('"file.internalid","anyof","@NONE@"') >= 0) {
        const cat = catIn(filters);
        rows = bills.filter(b => !b.hasFile && (cat === null || b.category === cat) && (!subs || subs.indexOf(b.sub) >= 0)).map(billResult);
      } else if (type === 'vendorbill' && fl.indexOf('"internalid","anyof"') >= 0) {
        const ids = idsIn(filters) || [];
        rows = bills.filter(b => ids.indexOf(b.id) >= 0 && (!subs || subs.indexOf(b.sub) >= 0)).map(billResult);
      } else if (type === 'vendor') {
        const want = filters[0][2];
        rows = vendors.filter(v => v.entityid === want).map(v => result(v.id, { entityid: v.entityid, companyname: v.companyname, category: v.category }));
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
    const sc = opts.scope || {};
    return { id: 42,
      values: { entityid: 'Test Person', email: 'test@example.com', custentity_vendor_invoice_passcode: CODE, giveaccess: false,
                custentity_vendor_invoice_upload: opts.uploadFlag === undefined ? true : opts.uploadFlag,
                custentity_vendor_invoice_subs: sc.subs || '', custentity_vendor_invoice_groups: sc.groups || '' },
      texts: { custentity_vendor_invoice_subs: sc.subNames || '', custentity_vendor_invoice_groups: sc.groupNames || '' } };
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
        remove({ key }) { delete cacheStore[name + ':' + key]; },
        put({ key, value }) { cacheStore[name + ':' + key] = value; }
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

  return { modules, logs, queries, created, attached, submitted, files, loadedFiles, authCookie, bills, vendors, cacheStore };
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
