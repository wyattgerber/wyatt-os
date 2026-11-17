# Reporting Lab: handoff verification, 2026-11-17

Branch `claude/reporting-lab`. Files are in `SuiteScripts/Reporting/`. Nothing was run against NetSuite. No NetSuite file was edited.

## What changed (one commit each)

| Commit | What |
|---|---|
| baseline | The six files from the handoff, added unchanged. `nts_is_cpm_pdf_4.xml` was saved as `nts_is_cpm_pdf.xml`. |
| Task 1 | `tests/engine_sync.test.js` and `tests/helpers.js`. A check that the engine matches the page. It does **not** regenerate the engine. |
| Task 3 | `tests/convert_ids.test.js`, `tests/sched.test.js` and `tests/drill.test.js`: 34 tests, all passing. |
| Task 6 | This file. |

Run the tests with Node 18 or later. They use mocked `N/*` modules and nothing in `tests/` goes to NetSuite.

```
node --test reporting-lab/tests/*.test.js
```

## Task 1: engine vs page. NOT DONE: `build_engine.py` was not in the handoff

- I did not regenerate `nts_is_cpm_engine.js`, and `build_engine.py` is not in the repo.
- I diffed the page's scripts against the engine after undoing the generator's known edits: `async`/`await`, `ENDPOINT`, `status`/`download`/`init` and the `return {…}` api.
  - The .xlsx writer is identical.
  - The main code differs in 5 places. The engine was built from an **older page**:
    1. Save note: the page says "unless you share it", the engine says "unless you make it public".
    2. Advanced builder header: the **Shared** checkbox (`lbPub`) is missing from the engine.
    3. Pivot builder header: the **Shared** checkbox (`pvPub`) is missing from the engine.
    4. and 5. Two trailing comments (`NOTE_SC` and the "only this report's page" line).
  - None of these touch calculation or export code, so scheduled PDFs and workbooks should come out the same. The engine still needs regenerating before it is uploaded.
- `dataRows` **is** in the engine's returned api, next to `applySchedule`, `exportXlsx`, `exportPdf`, `isBS` and `isLayout`. The `@NApiVersion 2.1` header is present.
- `engine_sync.test.js` fails today because of the differences above. It should pass once the engine is regenerated with `build_engine.py`.

## Task 2: syntax and consistency

- `node --check` passes on the engine, the Suitelet, the scheduler and both of the page's `<script>` blocks.
- `nts_is_cpm_sl.js` has 2151 lines and all 2151 end in CRLF. The last line (`});`) has no line ending, as it came. I did not edit this file.
- **Build marker:** the page says `<!-- build 2026-11-16 -->` and today is 2026-11-17. **It does not match today.** I left it alone because I did not change the page. Other stamps: PDF template `build 2026-11-02`, scheduler `BUILD = '2026-11-12a'`.

## Task 3: what the tests found

- **Empty report.** `dataRows() === 0` stops the **attachment**, not the email. The email still goes out with a link and the note "the report data came back empty". `lastSent` is recorded, so it will not retry that day. The brief says it "stops the email". Tell me which behavior you want.
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

## Task 5: access findings (report only, NOT changed, waiting for your decision)

1. **Every user sees every schedule and its recipients' emails.**
   - `listReports()` treats `schedule` (and `flagcfg`) as shared: `nts_is_cpm_sl.js:1369`.
   - The full definitions, including `sched.emails`, `subject` and `message`, go to every user's browser in `meta` and `reports` (`:1277`, `:231`).
2. **"Send me a test" works on anyone's schedule.**
   - `sendScheduleTest` (`:1587`) only checks that the id is a schedule the caller can see, which is every schedule.
   - It sends only to the requester, and the requester is also set as the sender.
3. **Related, worth weighing with 1 and 2.**
   - The scheduled script is set up to run **as an administrator** (`nts_is_cpm_sched.js:31`).
   - It fetches the report data through the Suitelet *as that user*.
   - So a test, or any schedule, is built with administrator visibility, not the requester's. Any user can save a schedule (`saveReport` has no role check for `kind: "schedule"`) with any email addresses (`cleanSchedule` only checks the format).
   - That lets someone receive figures their role would normally hide (other subsidiaries, for example), and email them to outside addresses.

## Not verifiable from the repo

- PDF output in NetSuite: graph page, CPM column, portrait/landscape, header centering, fit to page, KPI sub-rows.
- Scheduled email attachments in a real send. Permissions on comment storage.
- Production values: File Cabinet internal ids and folders, deployment ids, `custrecord1393/1394`, accounts 3470, 4080, 4130 and the debt accounts, and the two body fields (`custbody_url_reference_id`, `custbody_invoice_type`).
- The "By dimension" SuiteQL (`GROUP BY` with `BUILTIN.DF`), and whether the Integrity/TMT link targets open the right pages.
- Whether the engine behaves the same after regeneration. That needs `build_engine.py`.
