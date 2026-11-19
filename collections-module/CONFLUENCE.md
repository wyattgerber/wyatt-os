# NTS - Collections

| | |
|---|---|
| **Script** | NTS - Collections Portal (`customscript_nts_collections_portal`) |
| **Type** | Suitelet |
| **File** | `nts_collections_sl.js` |
| **Replaces** | NTS - CAT Collections (`customscript_nts_cat_collections`, `nts_invoice_status_upload_sl.js`) and the old `nts_collections_notes_portal_sl.js`. Both were retired when the scripts were consolidated. |
| **Related** | NTS - Collections Emails (`customscript_nts_collections_emails`, `nts_ar_dunning_mr.js`). It is a separate Map/Reduce and was not changed. NTS AR Balance Due Suitelet (`customscript_nts_ar_balance_due_sl`) sends the emails. |
| **Audience** | AR roles that the deployment is restricted to |

## What it does
One page with three tabs, used to bulk-update collections notes, statuses and promised-to-pay dates on invoices from a file. Open a tab directly by adding `&tab=notes`, `&tab=cat` or `&tab=icg` to the deployment URL.

| Tab | Customers | What it takes | What it changes |
|---|---|---|---|
| **Notes upload** | Any customer | .xlsx/.csv/.tsv/.zip. The first column is Invoice # (external ID) or Reference # (the user picks which), then Collections Notes, Collections Status, Promised to Pay Date | Collections status, collections notes, promised-to-pay date. Can also send a balance due notice or resend the invoice, with an attachment. |
| **CAT status upload** | Only customers under the CAT parent customer | The raw CASS export (.zip/.tsv/.xlsx) or the formatted notes file (Invoice/Pro Number, Notes, Status) | Same as Notes upload. Up to 5 attachments per invoice. |
| **ICG # import** | Only customers under the CAT parent customer | The raw ICG export (Freight Bill ID + Load Description) or a file with Invoice # and ICG # columns | Overwrites the CASS # (`custbody_cat_reference_number`) |

## How it works
1. The user drops a file. It is read in the browser, with no external libraries.
2. Rows are matched to open invoices. Rows that need attention are highlighted:
   - **Red:** several invoices match, so the user must pick one, or the same invoice was picked twice.
   - **Blue:** the row needs a status or a note.
   - **Gray:** no invoice was found.
3. **Apply** stays disabled until every highlighted row is fixed or skipped. Updates are sent in small batches. If one invoice fails, the rest of the batch still goes through, and nothing is retried automatically.
4. Exceptions and results can be downloaded as a CSV.

**Notes are appended on both tabs.** A new note goes on its own line under the invoice's existing note. A line that is already there is not added twice, so uploading the same file again changes nothing. Each email that goes out adds a line such as "Balance due sent on 11/19/26". Past 4,000 characters, the oldest lines are dropped. Every change still appears in the invoice's System Notes.

## Fields used
- `custbody_collections_status`: collections status, from the Note Type list. "System Logged Note" is hidden.
- `custbody_collections_notes`: collections notes (text area).
- `custbody_promised_to_pay_date`: set only when the status is Approved for Pay.
- `custbody_cat_reference_number`: reference / CASS / ICG #.

## Configuration (the `CFG` block at the top of the script)
- `TABS`: which tabs are shown. The server also refuses requests for a tab that is switched off.
- `CAT_PARENT_ID` / `CAT_PARENT_NAME`: sets which customers the CAT tabs can see. If the parent can't be found, the CAT tabs stop with a message instead of matching anything.
- `CASS_STATUS_MAP`: maps CASS results to NetSuite statuses.
- `NOTE_MODE`: `append` on both tabs.
- `ATTACH_FOLDER_ID` (2126, "Balance Due Invoices"): must match the Balance Due Suitelet's upload folder.
- `ATTACH_MAX_FILES`: 1 on the Notes tab, 5 on the CAT tab. More than one file per email needs the Balance Due Suitelet to read the `fileids` field. Until it does, only the first file is attached.
- `LOGO_URL` / `FONT_URLS`: File Cabinet URLs for the Nussbaum logo and Univers fonts. The fonts are licensed for internal use only, so they must not be in a folder that is "Available Without Login".

## Look
The page follows the Nussbaum design system: black header, condensed all-caps headings, red primary buttons and focus outlines, gray tables and square corners. Internal Blue marks rows that need input.

## Change history
| Date | Change |
|---|---|
| 11/19/2026 | Combined the Collections Portal and CAT Collections Suitelets into one script with three tabs. Notes are now appended on both tabs. Applied the Nussbaum theme. |
