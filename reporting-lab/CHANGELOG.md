# Reporting Lab: handoff verification, 2026-11-17

Branch `claude/reporting-lab`. Files are in `SuiteScripts/Reporting/`. Nothing was run against NetSuite. No NetSuite file was edited.

## What changed (one commit each)

| Commit | What |
|---|---|
| baseline | The six files from the handoff, added unchanged. `nts_is_cpm_pdf_4.xml` was saved as `nts_is_cpm_pdf.xml`. |
| Task 1 | `tests/engine_sync.test.js` and `tests/helpers.js`: a check that the engine matches the page. |
| Task 3 | `tests/convert_ids.test.js`, `tests/sched.test.js` and `tests/drill.test.js`. |
| Task 6 | This file. |
| build_engine.py | Added unchanged to `tools/`. |
| Task 1 | `build_engine.py` fixed, and the engine regenerated. |
| Schedules | The Shared box on schedules (your decision on task 5, see below). The page, the Suitelet and the engine all changed. |
| Schedules | Recipients hidden from users who can't change the schedule. The page, the Suitelet and the engine changed. |
| Dashboard | New `nts_is_cpm_portlet.js`, plus a dashboard mode on the page (`?dash=1`). The engine was regenerated. |

Run the tests with Node 18 or later. They use mocked `N/*` modules and nothing in `tests/` goes to NetSuite. All 51 pass.

```
node --test reporting-lab/tests/*.test.js
```

Rebuild the engine after any page change. Both arguments are required:

```
python3 reporting-lab/tools/build_engine.py reporting-lab/SuiteScripts/Reporting/nts_is_cpm_page.html reporting-lab/SuiteScripts/Reporting/nts_is_cpm_engine.js
```

## Task 1: engine vs page. Done

- As handed off, `build_engine.py` did not produce the hand-patched engine. Two things were missing from its output:
  - the `@NApiVersion 2.1` / `@NModuleScope SameAccount` header lines
  - `dataRows` in the returned api
- I added both to the script. I also made the two paths required arguments; the old defaults pointed at chat-sandbox folders.
- With those fixes, the script's output differed from the hand-patched engine in only five places: changes the page had made that the old engine was missing. They are the Shared checkboxes on both builders, the "unless you share it" save note, and two comments. None of them touch calculation or export code.
- I regenerated the engine from the page, and again after the schedule change below. `engine_sync.test.js` passes.

## Task 2: syntax and consistency

- `node --check` passes on the engine, the Suitelet, the scheduler and both of the page's `<script>` blocks.
- `nts_is_cpm_sl.js` has 2151 lines and all 2151 end in CRLF. The last line (`});`) has no line ending, as it came. The schedule change below edits this file. Every line still ends in CRLF (2159 of 2159), and the last line has no line ending, as before.
- **Build marker:** the handoff page said `2026-11-16`. I changed the page today, so it now says `<!-- build 2026-11-17 -->`. Other stamps: PDF template `build 2026-11-02`, scheduler `BUILD = '2026-11-12a'`.

## Task 3: what the tests found

- **Empty report.** `dataRows() === 0` stops the **attachment**, not the email. The email still goes out with a link and the note "the report data came back empty". `lastSent` is recorded, so it will not retry that day. **Decided: keep this** (send the link with the note). No change.
- **Missing records on load.** A record that no longer exists is dropped from filter lists and becomes `-1` on a layout account line. A schedule filtered **only** to missing records loads with an empty filter. That gives zero figures, the empty-report guard catches it, and the email carries a link and the note.
- **Stale fixed quarter or year.** It loses `fx` and falls back to its relative offset (`o`).
- **Link rules** all match item 6:
  - Sales and Service/Repairs are matched case-insensitively.
  - "Service / Repair" with spaces and no "s" also goes to TMT.
  - An order id must be 1 to 12 digits, otherwise there is no link.
  - If the body fields don't exist, the entry still loads, with no link.
  - Only vendor bills get the Vendor Lookup link: script 1911, deploy 1, external URL.

## Task 4: script id mismatch (report only, nothing changed)

`customscript_nts_is_cpm_sl` / `customdeploy_nts_is_cpm_sl`:
- `nts_is_cpm_sched.js:26-27`: the setup comment's parameter defaults.
- `nts_is_cpm_sched.js:153-154`: the fallback used when the parameter is blank **and** the schedule has no saved `sl`.

`customscript_nts_reporting_lab`: **in none of the six files.** The ids the Suitelet records come from `runtime.getCurrentScript()` at run time:
- `nts_is_cpm_sl.js:1576`: `cleanSchedule` saves `sched.sl = {script, deploy}` on every schedule.
- `nts_is_cpm_sl.js:1595`: "Send me a test" passes its own ids as `custscript_nts_sched_script` and `custscript_nts_sched_deploy`.
- `nts_is_cpm_sl.js:267`: the page's own endpoint.

If saved schedules show `customscript_nts_reporting_lab`, that is most likely the real Script ID. `sendOne` uses the schedule's `sl` first (`nts_is_cpm_sched.js:132`), so only schedules without `sl` would fall back to the wrong default.

Other ids for reference:
- `nts_is_cpm_sl.js:146-150`: `customscript_nts_is_cpm_sched`, `customdeploy_nts_is_cpm_sched` and `customdeploy_nts_is_cpm_sched_test`.
- `nts_is_cpm_sched.js:23,30`: the same ids in the setup comment.

## Task 5: access. One part decided and changed, the rest still open

**Decided:** others can see who scheduled a report, but can change it only if it is a shared schedule.

- **Page:** the schedule form has a **Shared** checkbox.
  - Only the owner or an administrator can tick or untick it.
  - The list shows "by <owner>" and "· shared".
  - Edit and Pause appear when the user may change the schedule. Delete appears only for the owner or an administrator.
- **Suitelet:**
  - Schedules now store `pub`.
  - `listReports()` adds `canEdit`: the owner, an administrator, or any user when the schedule is shared.
  - `saveReport()` checks `canEdit`. When someone other than the owner or an administrator saves, the record stays a schedule and stays shared, and its owner does not change.
  - Deleting is unchanged: the owner or an administrator only.
- **Existing schedules** have no `pub`, so they start out not shared. Only their owner or an administrator can change them until the owner ticks Shared.
- I assumed **Pause/Resume counts as editing**, so anyone can pause a shared schedule. Tell me if it should be the owner only.
- **Tests:** `tests/schedule_sharing.test.js`. I did not test the page in a browser.

**Decided 2026-11-17, second round:**

1. **Recipients' emails are now hidden** from anyone who can't change the schedule.
   - `listReports()` sends them an empty `emails` list plus `emailCount`, and the page shows "To N recipients".
   - The owner, administrators and, for a shared schedule, everyone still see the addresses.
   - The stored record and the scheduled script are unchanged.
   - Tests are in `schedule_sharing.test.js`.
2. **"Send me a test"** on any schedule stays as it is.
3. **Visibility:** everyone with access to the builder may see all reports. No change.

## Dashboard portlet (2026-11-17)

**Files**
- **`nts_is_cpm_portlet.js`** (new): an Inline HTML portlet that shows the Reporting Lab page in a frame, in dashboard mode.
  - Script parameters: the Suitelet's Script ID and Deployment ID (`custscript_nts_dash_script` and `custscript_nts_dash_deploy`) and the height (`custscript_nts_dash_height`, default 640).
  - Setup steps are in the file's header.
- **Page, `?dash=1`:**
  - It shows only the statement, the Report and As of pickers, Collapse/Expand, and "Open the full Reporting Lab ↗".
  - It opens **as of the last closed month**: the latest period marked closed, or failing that the month before this one.
  - It opens **fully collapsed** (section totals only).
  - It shows the report this person last picked in the portlet. The choice is kept in their browser.
- **Full page:** the dashboard does not change its remembered View/Analyze mode or its "show accounts without activity" setting.

**Not tested in NetSuite**
- That an Inline HTML portlet shows a Suitelet frame.
- The portlet height on a real dashboard.
- How long the home page takes to load with a large report.

**Known limit**
- The report choice is per browser. On a new computer, or after clearing the browser's data, the portlet starts on the default report.

**Found while doing this (not changed)**
- The schedule form's "The latest closed month" option uses the page's default month, `defaultAsOf()`, which is the month we are **in**, not the last closed one.

## Not verifiable from the repo

- PDF output in NetSuite: graph page, CPM column, portrait/landscape, header centering, fit to page, KPI sub-rows.
- Scheduled email attachments in a real send. Permissions on comment storage.
- Production values: File Cabinet internal ids and folders, deployment ids, `custrecord1393/1394`, accounts 3470, 4080, 4130 and the debt accounts, and the two body fields (`custbody_url_reference_id`, `custbody_invoice_type`).
- The "By dimension" SuiteQL (`GROUP BY` with `BUILTIN.DF`), and whether the Integrity/TMT link targets open the right pages.
- The schedule form and list in a real browser: the Shared box, the buttons, and the messages.
