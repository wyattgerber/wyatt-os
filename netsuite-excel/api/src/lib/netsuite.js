// NetSuite REST client: OAuth 2.0 M2M (client credentials, ES256 client-assertion JWT) + SuiteQL.
// Read-only by construction: the only calls made are the token POST and the SuiteQL POST (Prefer: transient).

import { createPrivateKey, sign } from 'node:crypto';
import { ApiError } from './errors.js';

const b64url = (b) => Buffer.from(b).toString('base64url');

/** "3816459_SB1" or "3816459-sb1" -> "3816459-sb1" */
export function hostFor(accountId) {
  const id = accountId.trim().toLowerCase().replace(/_/g, '-');
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Bad NetSuite account id');
  return `https://${id}.suitetalk.api.netsuite.com`;
}

export function buildClientAssertion(c, nowSec = Math.floor(Date.now() / 1000)) {
  const header = { alg: 'ES256', typ: 'JWT', kid: c.certificateId };
  const claims = {
    iss: c.clientId,
    scope: ['rest_webservices'],
    aud: `${hostFor(c.accountId)}/services/rest/auth/oauth2/v1/token`,
    iat: nowSec,
    exp: nowSec + 3300, // NetSuite allows at most 60 minutes
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  // JWS ES256 needs raw r||s (IEEE P1363), not DER.
  const sig = sign('sha256', Buffer.from(input), { key: createPrivateKey(c.privateKeyPem), dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class NetSuiteClient {
          token;
  constructor(creds, log = () => {}, fetchImpl = fetch) {
    this.creds = creds;
    this.log = log;
    this.fetchImpl = fetchImpl;
  }

          async getToken(force = false) {
    if (!force && this.token && this.token.expiresAt - Date.now() > 60_000) return this.token.value;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: buildClientAssertion(this.creds),
    });
    const res = await this.fetchImpl(`${hostFor(this.creds.accountId)}/services/rest/auth/oauth2/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300);
      throw new ApiError(502, 'NS_AUTH', 'Could not sign in to NetSuite. Please try again later.', `token endpoint ${res.status}: ${text}`);
    }
    const j = (await res.json());
    this.token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  async query(q, offset, limit) {
    const url = `${hostFor(this.creds.accountId)}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.getToken()}`,
          'Content-Type': 'application/json',
          Prefer: 'transient',
        },
        body: JSON.stringify({ q: q.sql }),
      });
      if (res.ok) {
        const j = (await res.json());
        return { items: j.items ?? [], hasMore: Boolean(j.hasMore) };
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.getToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = (await res.text().catch(() => '')).slice(0, 500);
      this.log(`NetSuite query failed: ${q.report}/${q.kind} HTTP ${res.status} ${text}`);
      if (res.status === 403) {
        throw new ApiError(502, 'NS_PERMISSION', 'NetSuite refused this request (permissions on the integration role). Contact the report owner.', text);
      }
      throw new ApiError(502, 'NS_QUERY', 'NetSuite could not run this report. Please try again; if it keeps failing, contact the report owner.', `HTTP ${res.status}: ${text}`);
    }
    throw new ApiError(502, 'NS_QUERY', 'NetSuite is busy. Please try again in a minute.');
  }
}
