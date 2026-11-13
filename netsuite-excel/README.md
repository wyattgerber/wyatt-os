# NetSuite -> Excel add-in (read-only reporting)

Under 10 accounting users click **NetSuite** on the Excel ribbon, pick a report and parameters, and get a formatted table on a new sheet. v1: Trial Balance, Journal Entries, GL Detail, AR Aging, AP Aging. No write-back.

> **STATUS (2026-11-13):** rebuilt from the written spec (the original bundle was lost). **All five reports' SQL is validated against the NetSuite sandbox** via the PowerShell check scripts (see results below). Not yet run: the API end to end (needs Node on a PC), the add-in in real Excel (needs IT's SWA), and anything against production NetSuite.

```
Excel task pane (addin/, Office.js + TS, webpack, XML manifest)
  -> Azure Functions proxy (api/, same Azure Static Web App, /api/*)
    -> NetSuite SuiteQL REST, OAuth 2.0 M2M (ES256 client-assertion JWT)
```

## Map

| Path | What |
| --- | --- |
| `api/src/lib/catalog.ts` | **All SQL lives here.** Report definitions, parameter validation, SuiteQL builders |
| `api/src/lib/runReport.ts` | Totals check, row cap, paging, exact reconciliation gate |
| `api/src/lib/netsuite.ts` | OAuth M2M JWT + SuiteQL client (retries, token cache) |
| `api/src/lib/service.ts` | `/api/me`, `/api/reports`, `/api/run` logic + AUDIT log line |
| `api/src/lib/{auth,config,money,mock,errors,types}.ts` | principal header, app settings, BigInt money, mock data, errors, shared types |
| `api/src/functions/api.ts` | Azure Functions v4 HTTP bindings (thin) |
| `api/test/api.test.ts` | 12 tests (mock data) |
| `addin/manifest.xml` | Office add-in manifest (placeholders for the SWA host) |
| `addin/src/taskpane/` | `taskpane.ts` UI, `api.ts` fetch, `auth.ts` dialog sign-in, `excelWriter.ts` sheet writer, `signin-complete.html` |
| `scripts/New-NetSuiteCert.ps1` | Creates EC P-256 key + 730-day cert; private key goes straight to 1Password |
| `scripts/Test-NetSuite.ps1` | Totals check, `accountingperiod` visibility, write-rejection tests |
| `scripts/Test-TrialBalance.ps1`, `scripts/Test-GLDetail.ps1` | Run the report SQL against the sandbox from PowerShell (no Node) and check it: reconciliation gate, balance, GL-to-TB tie |
| `scripts/NsCommon.ps1` | Shared sign-in/SuiteQL helpers + **copies of the catalog SQL**; `npm test` fails if they drift from `catalog.ts` |
| `scripts/Invoke-LocalReport.ps1` | Runs one report through the real API code against the sandbox from your PC (secrets from 1Password, no Azure); `api/src/cli.ts` is its entry point |
| `docs/IT-request.md` | Draft IT request (not sent) |

## Design rules

- **SQL stays on the server.** The client sends `{report, params}` only; unknown fields/params are rejected. Every row query has a deterministic `ORDER BY`.
- **Reconciled or nothing.** `runReport` runs NetSuite COUNT/SUM first, enforces `NETSUITE_MAX_ROWS` (default 20,000), pages 1,000 rows x 3 concurrent, and returns data only if row count and every money sum match exactly (BigInt, no floats) and the totals did not change during the pull.
- **Identity** only from `x-ms-client-principal`; allowlist in `ALLOWED_USERS`. `/api/me` -> `{email, allowed, role, mock}`.
- **Audit:** one `AUDIT {...}` log line per pull (success and failure) to App Insights.
- **Excel:** number formats set before values; text columns `@` (blocks formula injection); 5,000-row batches; Pull Info block on top; Refresh re-runs from worksheet custom properties (ExcelApi 1.12).
- **Mock mode** (`NETSUITE_MOCK=true`): fake data + red banner. The API refuses to start in mock mode when it detects Azure (`WEBSITE_*` env vars). Never set it in Azure.
- **Secrets:** 1Password only (`op://NetSuite/NetSuite Sandbox M2M`: `private_key`, `client_id`, `certificate_id`, `account_id`, `cert_expires`). In Azure they arrive as injected app settings. `staticwebapp.config.json` is IT-owned: never edit it here.

## Run it

```powershell
# API tests (mock data)
cd api; npm install; npm test

# Add-in: typecheck + build (output in addin/dist)
cd ../addin; npm install; npm run typecheck; npm run build
```

Local API with mock data: copy `api/local.settings.json.sample` to `api/local.settings.json` (gitignored), then `npm start` (needs Azure Functions Core Tools; the SWA CLI supplies the principal header).

## NetSuite setup (sandbox `3816459-sb1`)

1. `./scripts/New-NetSuiteCert.ps1` in `pwsh` 7.3+ (signed in to `op`, vault `NetSuite` exists).
2. NetSuite: enable REST Web Services + OAuth 2.0; create the integration record (Client Credentials/M2M only, REST Web Services scope); save Client ID to `client_id`.
3. OAuth 2.0 Client Credentials (M2M) Setup: entity = the `API_User` holder, role `API_User`, upload the public `.pem`; save Certificate ID to `certificate_id`.
4. `./scripts/Test-NetSuite.ps1`. Reconciliation target: Oct 2026 posting lines = **2,230**, debits = credits = **42,216,073.43**.

## Sandbox test results (2026-11-13)

- Auth (OAuth 2.0 M2M, ES256 JWT): PASS.
- Test 1: PASS. Oct 2026 = 2,230 posting lines, debits = credits = 42,216,073.43. Types visible: CustInvc 142, CustPymt 26, Deposit 11, Journal 545, VendBill 1506. (Deposit View had to be added to `API_User`.)
- Tests 3a/3b: PASS. Customer and account writes are rejected (HTTP 403): the role is read-only.
- Test 2: PASS after adding **Manage Accounting Periods (View)** to `API_User` (Period Closing Management / Accounting Management were Full-only and were removed).
- **Trial Balance: VALIDATED.** By posting period, P&L fiscal YTD, prior-year P&L rolled into the retained-earnings account (`sspecacct = 'RetEarnings'`, 3400) like NetSuite. Footers match NetSuite's TB report (Parent Company Consolidated, book 1) to the cent for Oct 2026 (264,219,967.46) and Jan 2026 (57,483,969.65, across the fiscal-year boundary); three Oct 2026 accounts spot-checked. Jan first differed by exactly 3400's net until RE netting matched NetSuite's. Tested via `scripts/Test-TrialBalance.ps1` (SQL copy, verified identical to `catalog.ts`).
- SuiteQL facts learned: `BUILTIN.DF` on a derived id returns HTTP 500; `account.accountsearchdisplayname` and `account.sspecacct` exist.
- NetSuite omits null columns from SuiteQL rows (a credit-only account has no `debit`); the API renders those as 0.00.
- NetSuite returns SUMs as doubles, sometimes in scientific notation (`4.221607343E7`). The API parses exponents exactly and rounds SUMs to cents in SQL (`ROUND(SUM(..), 2)`, unverified against real SuiteQL until the first API run).
- `op whoami` makes the next `op` call fail on this setup; scripts avoid it.

## Known problems (not done)

1. **Trial Balance is validated** (see results above). Not supported: per-subsidiary TB, other accounting books. Re-validate if the chart of accounts' retained-earnings setup changes.
2. **GL Detail is validated** (Oct 2026: 2,230 lines; all accounts tie to TB(Oct) − TB(Sep); 1040, 1210, 1250, 1300, 1515, 1525 match NetSuite's General Ledger report). Account # filter checked on 1040 (6 lines, ties to TB).
   **Journal Entries is validated** (Oct 2026: 545 lines, 58 journals, 17,128,952.80 per side, identical to a NetSuite saved search; `Test-GLDetail.ps1 -JournalOnly`).
   **AP Aging is validated** (11/13/2026: total 3,646,064.99, every bucket and "- No Vendor -" 535,036.79 identical to NetSuite's A/P Aging Summary; ties to the AP control account on every pull).
   **AR Aging is validated** (11/13/2026: total 21,250,408.01, every bucket and every customer row identical to NetSuite's A/R Aging Summary once parents are rolled up; "- No Customer -" 1,328,221.63).
   **Permissions added during testing:** Deposit, Manage Accounting Periods, Pay Bills, Enter Vendor Credits (all View). Bill credits were invisible until "Enter Vendor Credits" was added: a hidden type silently drops lines, so re-check completeness with an all-dates saved search by type before go-live. GL Detail and Journal Entries now filter by **posting period range** (From/To period), the same basis as the Trial Balance.
3. **Unverified assumptions:** JE type code `'Journal'`; aging fields `amountunpaid` / `paymentamountunused` and which types count as open (CustInvc/CustCred/CustPymt, VendBill/VendCred/VendPymt); account/subsidiary/memo column names (`transactionline.subsidiary`, `BUILTIN.DF`); 1Password field labels and `op item create` stdin form; aging uses US Eastern time; that SuiteQL returns money as strings/numbers parseable to <=6 decimals.
4. **No subsidiary filter.** Aging covers current open items only.
5. **SWA managed Functions time out at ~45 s.** If pulls approach that, switch to client-driven paging.
6. **Sign-in dialog is unproven inside Excel** (open risk #1): dialog -> `/.auth/login/aad` -> `signin-complete.html` -> `messageParent`.
7. **Not run yet:** `Invoke-LocalReport.ps1` / the API against real NetSuite (needs Node 20+, admin install on the work PC), the add-in in real Excel, and `npm run validate` (needs internet to Microsoft's validator and real SWA host in the manifest).
8. **Stack note:** the shared citizen-dev guidance prefers no-build vanilla JS; TypeScript + webpack here is an explicit project decision.
