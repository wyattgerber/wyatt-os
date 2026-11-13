# IT request: NetSuite Excel add-in

**What:** Under 10 accounting users get a **NetSuite** button in Excel. It (a) pulls read-only NetSuite reports (Trial Balance, GL Detail, Journal Entries, AR/AP Aging) into a sheet, and (b) adds F9-style **Excel formulas** (`=NS.BALANCE(...)`, `=NS.ACTIVITY(...)`) for building financial statements. Read-only: nothing is ever written back to NetSuite. All five reports have been validated against NetSuite's own reports in the sandbox.

**Architecture:** Excel add-in (task pane + custom functions, XML manifest) → Azure Static Web App with managed Functions under `/api` → NetSuite REST/SuiteQL using OAuth 2.0 machine-to-machine (certificate, read-only role).

## Please provide

### 1. Azure Static Web App (citizen-app platform)
- One SWA instance with managed Functions (Node 20) under `/api`, deployed from the GitHub repo (see 5).
- **Sign-in restricted to the Nussbaum Entra tenant** (Easy Auth with Microsoft Entra ID). If that needs the Standard plan or a custom auth config, please use it.
- **App settings** (values are in 1Password; see 4 for handover):

  | Setting | Notes |
  | --- | --- |
  | `NETSUITE_ACCOUNT_ID` | NetSuite account id (sandbox first, production later) |
  | `NETSUITE_CLIENT_ID` | integration record client id |
  | `NETSUITE_CERTIFICATE_ID` | OAuth 2.0 M2M certificate id |
  | `NETSUITE_PRIVATE_KEY` | EC P-256 private key (PEM). **Secret** |
  | `ALLOWED_USERS` | comma-separated emails of the accounting users |
  | `NETSUITE_MAX_ROWS` | optional, default 20000 |

  `NETSUITE_MOCK` must **not** be set (the API refuses to start in mock mode on Azure). Note: SWA preview environments share production settings, so a preview deploy reaches NetSuite with the same credentials.
- **Application Insights** (platform-injected): the API writes one `AUDIT {...}` line per pull (who, what, parameters, row count, outcome).

### 2. Route config (`staticwebapp.config.json`, IT-owned)
- Static files (`/taskpane.html`, `/signin-complete.html`, `/functions.*`, `/assets/*`, `/manifest.xml`) load **without** a login redirect, so Excel can open the task pane and functions.
- `/api/*` requires authentication and returns **401** (not a 302 redirect) when not signed in; `/.auth/login/aad` stays reachable for the sign-in dialog.
- Allow framing by Office (`Content-Security-Policy: frame-ancestors` for the Office hosts; no `X-Frame-Options: DENY`), and allow the Office.js script from `appsforoffice.microsoft.com`.

### 3. Microsoft 365: add-in deployment
- **Centralized deployment** (M365 admin center → Integrated apps → upload custom app, XML manifest) to the allowlisted users. The manifest includes **custom functions with a shared runtime**; this is supported by centralized deployment.
- **For testing before that:** allow me to **sideload** ("Upload My Add-in" in Excel), or deploy to me alone first.

### 4. Secret handover
- The NetSuite key and ids live in 1Password (`NetSuite` vault). Please tell me the approved way to hand them to you for the app settings (e.g. share the 1Password item with an IT admin). **Not by email or chat.**

### 5. Source repository
- The code is in my **personal private GitHub repo** (`wyattgerber/wyatt-os`), and I'd like the SWA to deploy from it (SWA's standard GitHub Actions integration; `main` = production). Please confirm that is allowed. If production must deploy from the **Nussbaum-Transportation** organization instead, tell me the process.

### 6. Node.js on my PC (developer only)
Node.js is a JavaScript runtime used to build and test the add-in and API.
- **Production needs nothing on any PC:** Azure runs the API; the accounting users only need Excel.
- **On my PC only:** Node.js LTS (20 or newer, includes npm) to build the add-in, run the automated tests, and run the API code against the NetSuite **sandbox** before deploying. Admin rights only for the install.
- **Network:** `registry.npmjs.org` (build packages) and the NetSuite sandbox API (`3816459-sb1.suitetalk.api.netsuite.com`).
- **Security:** no service or listening port is left running; the NetSuite key is read from 1Password into memory for a single command and cleared; nothing secret is written to disk or to the repo.

## Already in place (for context)
- NetSuite sandbox integration: OAuth 2.0 M2M, ES256 certificate (expires 2028-11-12), key only in 1Password.
- `API_User` role is read-only (create attempts are rejected, verified). View permissions added during testing: Deposit, Manage Accounting Periods, Pay Bills, Enter Vendor Credits.
- Every report pull is checked against NetSuite's own totals; aging reports must tie to the AR/AP control accounts, or no data is returned.

## Later (NetSuite admin, not Azure)
- **Production NetSuite:** a separate integration record, role and certificate for the production account, then the same validation as the sandbox before go-live.

## Open questions for IT
1. SWA managed Functions time out at roughly 45 seconds. Can that be extended, or should we plan client-driven paging if real pulls approach it?
2. Which SWA plan does the citizen platform use, and does it support tenant-restricted sign-in as above?
