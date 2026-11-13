import { ApiError } from './errors';

export interface Config {
  mock: boolean;
  allowedUsers: Set<string>;
  maxRows: number;
  netsuite?: { accountId: string; clientId: string; certificateId: string; privateKeyPem: string };
}

/** True when running on Azure (SWA managed Functions run on App Service infrastructure). */
function onAzure(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.WEBSITE_INSTANCE_ID || env.WEBSITE_SITE_NAME);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mock = (env.NETSUITE_MOCK ?? '').toLowerCase() === 'true';
  if (mock && onAzure(env)) {
    // Fake data must never be served from a deployed environment.
    throw new ApiError(500, 'MOCK_IN_AZURE', 'The service is misconfigured. Please contact the report owner.', 'NETSUITE_MOCK=true on Azure');
  }
  const allowedUsers = new Set(
    (env.ALLOWED_USERS ?? '')
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const parsed = Number.parseInt(env.NETSUITE_MAX_ROWS ?? '', 10);
  const maxRows = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100_000) : 20_000;

  let netsuite: Config['netsuite'];
  if (!mock) {
    const { NETSUITE_ACCOUNT_ID, NETSUITE_CLIENT_ID, NETSUITE_CERTIFICATE_ID, NETSUITE_PRIVATE_KEY } = env;
    if (!NETSUITE_ACCOUNT_ID || !NETSUITE_CLIENT_ID || !NETSUITE_CERTIFICATE_ID || !NETSUITE_PRIVATE_KEY) {
      throw new ApiError(503, 'NOT_CONFIGURED', 'NetSuite is not configured for this environment yet.', 'missing NETSUITE_* app settings');
    }
    netsuite = {
      accountId: NETSUITE_ACCOUNT_ID,
      clientId: NETSUITE_CLIENT_ID,
      certificateId: NETSUITE_CERTIFICATE_ID,
      // App settings often flatten newlines to a literal backslash-n.
      privateKeyPem: NETSUITE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return { mock, allowedUsers, maxRows, netsuite };
}
