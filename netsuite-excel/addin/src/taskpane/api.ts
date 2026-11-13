import { Me, Period, ReportResult, ReportsResponse } from '../types';

/** Thrown with a message that is already safe/friendly to show. */
export class FriendlyError extends Error {
  constructor(message: string, public status = 0, public code = '') {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(path, { credentials: 'include', redirect: 'manual', ...init });
    } catch {
      if (attempt < retries) { await new Promise((r) => setTimeout(r, 400 * 2 ** attempt)); continue; }
      throw new FriendlyError("Couldn't reach the server. Check your connection and try again.");
    }
    // An opaque redirect means the platform tried to send us to a login page.
    if (res.type === 'opaqueredirect' || res.status === 401) throw new FriendlyError('Please sign in.', 401, 'UNAUTHENTICATED');
    if (res.ok) return (await res.json()) as T;
    // Only retry transient server errors on safe (idempotent) read calls.
    if (res.status >= 500 && attempt < retries && (init?.method ?? 'GET') === 'GET') {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    let msg = 'Something went wrong. Please try again.';
    let code = '';
    try {
      const j = await res.json();
      if (j?.error?.message) { msg = String(j.error.message); code = String(j.error.code ?? ''); }
    } catch { /* keep generic message */ }
    throw new FriendlyError(msg, res.status, code);
  }
}

export const getMe = () => call<Me>('/api/me');
export const getReports = () => call<ReportsResponse>('/api/reports');
export const getPeriods = () => call<{ periods: Period[] }>('/api/periods');
/** POST is not auto-retried: a pull is read-only but slow, so the user decides whether to run it again. */
export const runReport = (report: string, params: Record<string, string>) =>
  call<ReportResult>('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ report, params }) }, 0);
