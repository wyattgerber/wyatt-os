// Task 1: is nts_is_cpm_engine.js in step with nts_is_cpm_page.html?
// This does NOT generate the engine (build_engine.py does). It compares the page's two scripts with the engine after
// undoing only the edits the generator is known to make (async/await removed, the browser edges swapped for HOST calls,
// init returned as an api object). Anything else that differs means the engine is stale: re-run build_engine.py.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('./helpers');

const PAGE = read('nts_is_cpm_page.html').split('\n');
const ENG = read('nts_is_cpm_engine.js').split('\n');
const between = (lines, from, to) => {
    const a = lines.findIndex(from), b = lines.findIndex((l, i) => i > a && to(l));
    if (a < 0 || b < 0) throw new Error('marker not found');
    return lines.slice(a, b + 1);
};
// trailing "// note" comments do not change behaviour; quotes in the comment are left alone to keep this safe
const noComment = l => l.replace(/\s+\/\/ [^'"`]*$/, '').replace(/\s+$/, '');

function pageMain() {
    return between(PAGE, l => l === '(function(){', l => l === '})();')
        .map(l => l.replace(/\basync /g, '').replace(/\bawait /g, ''))
        .join('\n')
        .replace('const ENDPOINT = "__ENDPOINT__";', 'const ENDPOINT = "NTS";')
        .replace(/  function download\(blob,name\)\{\n.*\n.*\n  \}/, '  function download(blob,name){ HOST.download(blob,name); }')
        .replace('  (function init(){', '  function init(){')
        .replace(/    \} catch\(e\)\{ status\(e\.message,true\); \$\('subtitle'\)\.textContent='Could not load'; \}\n  \}\)\(\);/,
                 '    } catch(e){ status(e.message,true); if(HOST.error) HOST.error(e); }\n  }')
        .split('\n').slice(1, -1).map(noComment);
}
function engineMain() {
    return between(ENG, l => l === 'var __api=(function(){', l => l === '})();')
        .join('\n')
        .replace('const status = (msg, err) => { if(HOST.status) HOST.status(msg, err);', 'const status = (msg, err) => {')
        .replace(/\n  return \{init:init, [^\n]*\};/, '')
        .split('\n').slice(1, -1).map(noComment);
}

test('engine api returns dataRows and applySchedule (the scheduled script calls both)', () => {
    const ret = ENG.find(l => l.startsWith('  return {init:init,'));
    assert.ok(ret, 'api return line found');
    for (const k of ['dataRows:dataRows', 'applySchedule:applySchedule', 'exportXlsx:exportXlsx', 'exportPdf:exportPdf', 'isBS:isBS', 'isLayout:isLayout']) assert.ok(ret.includes(k), k);
    assert.ok(PAGE.some(l => l.trim().startsWith('function dataRows(')), 'the page defines dataRows()');
});

test('engine has the @NApiVersion 2.1 header', () => {
    assert.ok(ENG.slice(0, 12).some(l => /@NApiVersion 2\.1/.test(l)));
});

test('the .xlsx writer in the engine is the page\'s, unchanged', () => {
    const p = between(PAGE, l => l.startsWith('// Minimal, dependency-free .xlsx writer'), l => l === '})();');
    const e = between(ENG, l => l.startsWith('// Minimal, dependency-free .xlsx writer'), l => l === '})();');
    assert.deepEqual(e, p);
});

test('the engine\'s main code matches the page (apart from the generator\'s own edits)', () => {
    const p = pageMain(), e = engineMain(), diffs = [];
    let i = 0, j = 0;
    while (i < p.length || j < e.length) {
        if (p[i] === e[j]) { i++; j++; continue; }
        // resync: find the next line both share within a small window
        let found = false;
        for (let k = 1; k < 12 && !found; k++) {
            if (p[i + k] !== undefined && p[i + k] === e[j]) { diffs.push('page only: ' + p.slice(i, i + k).join(' / ').slice(0, 220)); i += k; found = true; }
            else if (e[j + k] !== undefined && e[j + k] === p[i]) { diffs.push('engine only: ' + e.slice(j, j + k).join(' / ').slice(0, 220)); j += k; found = true; }
        }
        if (!found) { diffs.push('page:   ' + String(p[i]).trim().slice(0, 220) + '\n    engine: ' + String(e[j]).trim().slice(0, 220)); i++; j++; }
    }
    assert.equal(diffs.length, 0, 'The engine is out of date with the page. Re-run build_engine.py. Differences:\n  ' + diffs.join('\n  '));
});
