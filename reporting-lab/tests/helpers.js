// Test helpers: load the SuiteScript AMD files with mocked N/* modules, and lift single functions out of the page.
// Node only. Nothing here is uploaded to NetSuite.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'SuiteScripts', 'Reporting');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8');

// Runs an AMD file and calls its factory with mocks[dep] for each dependency it names.
function loadAmd(name, mocks) {
    let captured = null;
    const define = (deps, factory) => { captured = { deps, factory }; };
    vm.runInNewContext(read(name), { define, console }, { filename: name });
    if (!captured) throw new Error(name + ' did not call define()');
    return captured.factory(...captured.deps.map(d => {
        if (!(d in mocks)) throw new Error('no mock for ' + d);
        return mocks[d];
    }));
}

// The source of one declaration, from its first line to the matching closing brace (or the end of a one-line arrow).
// `start` is the exact text the declaration begins with, e.g. 'function convertIds('.
function sliceDecl(src, start) {
    const at = src.indexOf(start);
    if (at < 0) throw new Error('not found: ' + start);
    const open = src.indexOf('{', at);
    let depth = 0, i = open, q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) break;
    }
    let end = i + 1;
    if (src[end] === ';') end++;
    return src.slice(at, end);
}

// Silent log; records errors and audits so tests can look at them.
function mockLog() {
    const L = { lines: [] };
    ['debug', 'audit', 'error', 'emergency'].forEach(k => { L[k] = (t, d) => L.lines.push({ level: k, title: typeof t === 'object' ? t.title : t, details: d }); });
    return L;
}

module.exports = { DIR, read, loadAmd, sliceDecl, mockLog };
