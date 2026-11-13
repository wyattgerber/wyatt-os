# NetSuite -> Excel add-in (read-only reporting)

Under 10 accounting users click **NetSuite** on the Excel ribbon, pick a report and parameters, and get a formatted table on a new sheet. v1: Trial Balance, Journal Entries, GL Detail, AR Aging, AP Aging. No write-back.

> **STATUS: rebuilt from the written spec** (the original bundle was lost). Treat everything as new, **unvalidated** code. API tests pass against mock data only; nothing has run against NetSuite, in real Excel, or via the PowerShell scripts yet.

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
- Test 2: **FAIL.** SuiteQL says `Record 'accountingperiod' was not found`, even after adding Period Closing Management / Accounting Management. Those were Full-only and were removed (least privilege). Trial balance by posting period is still blocked.
- NetSuite returns SUMs as doubles, sometimes in scientific notation (`4.221607343E7`). The API parses exponents exactly and rounds SUMs to cents in SQL (`ROUND(SUM(..), 2)`, unverified against real SuiteQL until the first API run).
- `op whoami` makes the next `op` call fail on this setup; scripts avoid it.

## Known problems (not done)

1. **Trial Balance is not a real TB.** Filters on `trandate`; P&L is cumulative since inception (not fiscal YTD); no retained-earnings line. Needs posting period + YTD + RE line, blocked on Test 2 (`accountingperiod` visible?).
2. **Every report is `validated: false`.** Reconcile each: TB vs NetSuite TB report, JE vs a saved search, GL vs TB, AR/AP aging vs control accounts.
3. **Unverified assumptions:** JE type code `'Journal'`; aging fields `amountunpaid` / `paymentamountunused` and which types count as open (CustInvc/CustCred/CustPymt, VendBill/VendCred/VendPymt); account/subsidiary/memo column names (`transactionline.subsidiary`, `BUILTIN.DF`); 1Password field labels and `op item create` stdin form; aging uses US Eastern time; that SuiteQL returns money as strings/numbers parseable to <=6 decimals.
4. **No subsidiary filter.** Aging covers current open items only.
5. **SWA managed Functions time out at ~45 s.** If pulls approach that, switch to client-driven paging.
6. **Sign-in dialog is unproven inside Excel** (open risk #1): dialog -> `/.auth/login/aad` -> `signin-complete.html` -> `messageParent`.
7. **Not run yet:** both PowerShell scripts, the add-in in real Excel, and `npm run validate` (needs internet to Microsoft's validator and real SWA host in the manifest).
8. **Stack note:** the shared citizen-dev guidance prefers no-build vanilla JS; TypeScript + webpack here is an explicit project decision.
