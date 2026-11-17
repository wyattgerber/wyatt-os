// The dashboard portlet (nts_is_cpm_portlet.js) and the page's dashboard mode (?dash=1).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { read, loadAmd, sliceDecl } = require('./helpers');

const PAGE = read('nts_is_cpm_page.html');

// lastClosedAsOf() with a fixed "today" and a stand-in defaultAsOf()
function lastClosed(periods, todayIso) {
    return vm.runInNewContext(sliceDecl(PAGE, 'function lastClosedAsOf(') + '\nlastClosedAsOf();',
        { META: { periods }, today: () => todayIso, defaultAsOf: () => 'DEFAULT' });
}
const P = (id, start, end, closed) => ({ id, start, end, closed });

test('dashboard month: the latest period marked closed', () => {
    const periods = [P(9, '2026-09-01', '2026-09-30', true), P(10, '2026-10-01', '2026-10-31', true), P(11, '2026-11-01', '2026-11-30', false)];
    assert.equal(lastClosed(periods, '2026-11-17'), 10);
});

test('dashboard month: October not closed yet on 17 November shows September', () => {
    const periods = [P(9, '2026-09-01', '2026-09-30', true), P(10, '2026-10-01', '2026-10-31', false), P(11, '2026-11-01', '2026-11-30', false)];
    assert.equal(lastClosed(periods, '2026-11-17'), 9);
});

test('dashboard month: nothing closed falls back to the month before this one, then to the page default', () => {
    const periods = [P(10, '2026-10-01', '2026-10-31', false), P(11, '2026-11-01', '2026-11-30', false)];
    assert.equal(lastClosed(periods, '2026-11-17'), 10);
    assert.equal(lastClosed([P(11, '2026-11-01', '2026-11-30', false)], '2026-11-17'), 'DEFAULT');
});

test('dashboard mode: collapsed by default, remembers the report, leaves the full page settings alone', () => {
    assert.match(PAGE, /const DASH = new URLSearchParams\(location\.search\)\.get\('dash'\)==='1';/);
    assert.match(PAGE, /if\(DASH\)\{ state\.nLevel=0; state\.levels=\{view:0, analyze:0\}; \}/);
    assert.match(PAGE, /if\(DASH\)\{ try\{ localStorage\.setItem\(DASH_KEY, value\); \}catch\(e\)\{\} \}/);
    assert.match(PAGE, /if\(!DASH\)\{ try\{ localStorage\.setItem\('nts_is_mode', state\.mode\); \}catch\(e\)\{\} \}/);
    assert.match(PAGE, /state\.asOf = DASH \? lastClosedAsOf\(\) : defaultAsOf\(\);/);
});

test('the engine (no ?dash=1) is not in dashboard mode', () => {
    const ENG = read('nts_is_cpm_engine.js');
    assert.match(ENG, /var location = \{search: ''/);
    assert.match(ENG, /const DASH = new URLSearchParams\(location\.search\)\.get\('dash'\)==='1';/);
});

// ---- the portlet ----
function renderPortlet(params, resolveThrows) {
    const seen = [];
    const portletMod = loadAmd('nts_is_cpm_portlet.js', {
        'N/url': { resolveScript: o => { seen.push(o); if (resolveThrows) throw new Error('SSS_INVALID_SCRIPTLET_ID'); return '/app/site/hosting/scriptlet.nl?script=1&deploy=1&dash=1'; } },
        'N/runtime': { getCurrentScript: () => ({ getParameter: ({ name }) => (params || {})[name] || null }) }
    });
    const portlet = {};
    portletMod.render({ portlet });
    return { portlet, seen };
}

test('portlet: frames the Suitelet in dashboard mode, using the script parameters', () => {
    const { portlet, seen } = renderPortlet({ custscript_nts_dash_script: 'customscript_nts_reporting_lab', custscript_nts_dash_deploy: 'customdeploy_x', custscript_nts_dash_height: '800' });
    assert.equal(portlet.title, 'Income Statement');
    assert.deepEqual(JSON.parse(JSON.stringify(seen[0])), { scriptId: 'customscript_nts_reporting_lab', deploymentId: 'customdeploy_x', params: { dash: '1' } });
    assert.match(portlet.html, /^<iframe src="\/app\/site\/hosting\/scriptlet\.nl\?script=1&amp;deploy=1&amp;dash=1"/);
    assert.match(portlet.html, /height:800px/);
});

test('portlet: default height, and a plain message when the Suitelet ids are wrong', () => {
    assert.match(renderPortlet({ custscript_nts_dash_height: '5' }).portlet.html, /height:640px/);
    const bad = renderPortlet({}, true).portlet.html;
    assert.match(bad, /could not be found \(customscript_nts_is_cpm_sl \/ customdeploy_nts_is_cpm_sl\)/);
    assert.doesNotMatch(bad, /<iframe/);
});
