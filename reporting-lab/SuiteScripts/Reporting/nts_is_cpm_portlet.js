/**
 * Nussbaum Reporting Lab — dashboard portlet
 *
 * @NApiVersion 2.1
 * @NScriptType Portlet
 * @NModuleScope SameAccount
 *
 * Shows the Reporting Lab statement on a NetSuite dashboard. The portlet is a frame around the Reporting Lab page in its
 * dashboard mode (?dash=1): the statement only, as of the last closed month, fully collapsed, with a report picker. Each
 * person's report choice is remembered in their browser. "Open the full Reporting Lab" opens the whole page in a new tab.
 * The page runs as the person looking at the dashboard, so they see only what their role allows.
 *
 * Setup (once):
 *   1. Upload this file to the File Cabinet (any folder; the same folder as the Suitelet is tidy).
 *   2. Create a Script record from it. Portlet Type: Inline HTML. Script id in production: customscript_report_dashboard
 *      Parameters (Free-Form Text unless noted):
 *        custscript_nts_dash_script   The Reporting Lab Suitelet (its Script ID, or a List/Record parameter pointing at it).
 *                                     Blank: customscript_nts_reporting_lab (the Reporting Lab Suitelet's Script ID)
 *        custscript_nts_dash_deploy   Its Deployment ID. Blank: customdeploy_nts_reporting_lab
 *        custscript_nts_dash_height   Integer: the portlet's height in pixels. Default 640.
 *   3. Deploy it (Status Released, audience the roles that use the Reporting Lab). Sandbox deployment id: customdeploy_report_lab_dashboard
 *   4. Each person adds it on their Home dashboard: Personalize > Custom Portlet, then pick this script in the portlet's Set Up.
 */
define(['N/url', 'N/runtime'], (url, runtime) => {

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function render(params) {
        const portlet = params.portlet;
        portlet.title = 'Reporting Lab';
        const script = runtime.getCurrentScript();
        const scriptId = script.getParameter({ name: 'custscript_nts_dash_script' }) || 'customscript_nts_reporting_lab';
        const deploymentId = script.getParameter({ name: 'custscript_nts_dash_deploy' }) || 'customdeploy_nts_reporting_lab';
        const h = Number(script.getParameter({ name: 'custscript_nts_dash_height' }));
        const height = Number.isInteger(h) && h >= 200 && h <= 2000 ? h : 640;
        let src;
        try {
            src = url.resolveScript({ scriptId, deploymentId, params: { dash: '1' } });
        } catch (e) {
            portlet.html = '<p style="font-family:sans-serif;font-size:13px;padding:8px">The Reporting Lab could not be found (' + esc(scriptId) + ' / ' + esc(deploymentId)
                + '). Set the Suitelet\'s Script ID and Deployment ID on this portlet\'s script parameters.</p>';
            return;
        }
        portlet.html = '<iframe src="' + esc(src) + '" title="Income statement" loading="lazy" style="display:block;width:100%;height:' + height + 'px;border:0"></iframe>';
    }

    return { render };
});
