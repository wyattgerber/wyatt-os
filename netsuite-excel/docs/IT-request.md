# IT request: NetSuite Excel add-in (DRAFT, not sent)

**What:** Under 10 accounting users get a "NetSuite" ribbon button in Excel that pulls read-only NetSuite reports (Trial Balance, Journal Entries, GL Detail, AR/AP Aging) into a worksheet. No write-back. NetSuite is reached only through our own API (Azure Functions) using OAuth 2.0 M2M against a sandbox first.

**Please provide**

1. **Static Web App instance** (citizen-app platform) for this app, with managed Functions under `/api`.
2. **App settings** on that instance (values come from 1Password; we will hand them over securely, not by email/chat):
   | Setting | Notes |
   | --- | --- |
   | `NETSUITE_ACCOUNT_ID` | e.g. the sandbox account id |
   | `NETSUITE_CLIENT_ID` | integration record client id |
   | `NETSUITE_CERTIFICATE_ID` | OAuth 2.0 M2M certificate id |
   | `NETSUITE_PRIVATE_KEY` | EC P-256 PEM, secret |
   | `ALLOWED_USERS` | comma-separated emails of the accounting users |
   | `NETSUITE_MAX_ROWS` | optional, default 20000 |

   `NETSUITE_MOCK` must **not** be set. Note: SWA preview environments share production settings, so a preview deploy can reach NetSuite with the same credentials.
3. **Route config (`staticwebapp.config.json`, IT-owned):**
   - Static files (`/taskpane.html`, `/signin-complete.html`, `/assets/*`, `/manifest.xml`) open with no login redirect, so the Excel task pane can load them.
   - `/api/*` requires authentication and returns **401** (not a 302 login redirect) when unauthenticated; `/.auth/login/aad` stays available for the sign-in dialog.
   - Allow the site to be framed by Office (`Content-Security-Policy: frame-ancestors` for Office hosts) and remove `X-Frame-Options: DENY` if present.
4. **Deployment of the add-in** via the Microsoft 365 admin center (Integrated apps > upload custom app, XML manifest) to the allowlisted users. We supply `manifest.xml` after the SWA hostname is known.
5. **Telemetry:** App Insights is expected to receive one `AUDIT {...}` log line per report pull (who, report, parameters, row count, outcome).

**Security notes:** read-only NetSuite role (`API_User`, View permissions only); SQL is built server-side from validated parameters, never accepted from the client; identity is taken only from the Easy Auth principal header; no secrets in the repo.

**Open question for IT:** SWA managed Functions time out at roughly 45 seconds. Is there any way to extend this, or should we plan client-driven paging if pulls approach that?
