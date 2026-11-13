import { ApiError } from './errors';

export interface Principal {
  email: string;
}

/**
 * Identity comes ONLY from the Easy Auth header. Never from the body, query or any other header.
 * Returns 401 when absent/garbled.
 */
export function principalFromHeader(header: string | null | undefined): Principal {
  if (!header) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
  try {
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { userDetails?: unknown };
    const email = typeof p.userDetails === 'string' ? p.userDetails.trim().toLowerCase() : '';
    if (!email) throw new Error('no userDetails');
    return { email };
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
  }
}

export function isAllowed(p: Principal, allowed: Set<string>): boolean {
  return allowed.has(p.email);
}

/** Authenticated AND on the allowlist, or throws (401/403). */
export function requireAllowed(header: string | null | undefined, allowed: Set<string>): Principal {
  const p = principalFromHeader(header);
  if (!isAllowed(p, allowed)) {
    throw new ApiError(403, 'NOT_ALLOWED', 'Your account is not set up for NetSuite reports. Ask the report owner for access.', `denied ${p.email}`);
  }
  return p;
}
