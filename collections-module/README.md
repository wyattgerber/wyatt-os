# NTS - Collections (consolidated Suitelet)

`nts_collections_sl.js` replaces two Suitelets with one script and one deployment:

| Old script | Old file | Now |
|---|---|---|
| NTS - Collections Portal | `nts_collections_notes_portal_sl.js` | **Notes upload** tab (`&tab=notes`) |
| NTS - CAT Collections | `nts_invoice_status_upload_sl.js` | **CAT status upload** (`&tab=cat`) and **ICG # import** (`&tab=icg`) tabs |

`NTS - Collections Emails` (`nts_ar_dunning_mr.js`) is a Map/Reduce, a different script type, so it stays separate.

## What stays the same
- Each tab keeps its old rules. The Notes tab covers any customer. The CAT tabs are limited to customers under the CAT parent, and the server checks that limit again on every search and write.
- The Notes tab **replaces** the invoice note. The CAT tab **appends** it. Both are set in `CFG.NOTE_MODE`.
- Attachments: 1 file per invoice on the Notes tab and 5 on the CAT tab (`CFG.ATTACH_MAX_FILES`).

## Small changes
- The Notes tab now also accepts `.zip` files.
- The Amount Billed column is hidden when the file has no amounts.
- Notes longer than 4,000 characters drop whole old lines instead of cutting one in half.

## Deploy (sandbox first)
1. Upload `nts_collections_sl.js` to the File Cabinet.
2. Either point the existing **NTS - Collections Portal** script record at the new file, which keeps its URL, or create a new script record.
3. Limit the deployment to the AR roles. If only some of them should see the CAT tabs, use two deployments of this script and set `CFG.TABS` for each, or ask for a script parameter.
4. Once it is verified, inactivate the **NTS - CAT Collections** deployment.

## Nussbaum theme
The page follows the Nussbaum design system: a black masthead, condensed all-caps headings, red for primary actions and focus, gray tables, and square corners. Internal Blue marks the "needs input" rows, which is allowed because this is an internal tool. One green appears only on rows that were updated.

To load the real brand files, put these File Cabinet URLs in `CFG`:
- `LOGO_URL`: `nussbaum-logo-reversed.png`
- `FONT_URLS`: the Univers LT Pro `.ttf` files. They are licensed for internal use only, so keep them in a folder that is not "Available Without Login".

If these are left blank, the page uses Arial Narrow / Arial and shows no logo.
