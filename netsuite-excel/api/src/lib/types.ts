// Shared shapes. The add-in has a hand-copied mirror in addin/src/types.ts -- keep in sync.

export type ColumnType = 'text' | 'date' | 'money' | 'int';

export interface Column {
  key: string;
  label: string;
  type: ColumnType;
}

export interface ParamSpec {
  name: string;
  label: string;
  type: 'date' | 'text';
  required: boolean;
  help?: string;
}

/** What the client is allowed to see about a report (never any SQL). */
export interface ReportMeta {
  id: string;
  title: string;
  validated: boolean;
  params: ParamSpec[];
  columns: Column[];
  notes: string[];
}

/** One query the server wants run. Real client sends `sql`; mock uses report+kind+params. */
export interface BuiltQuery {
  report: string;
  kind: 'totals' | 'rows';
  params: Record<string, string>;
  sql: string;
}

export interface QueryProvider {
  /** Run one page. `offset`/`limit` are ignored for kind === 'totals'. */
  query(q: BuiltQuery, offset: number, limit: number): Promise<{ items: Record<string, unknown>[]; hasMore: boolean }>;
}

export interface PullInfo {
  report: string;
  title: string;
  params: Record<string, string>;
  user: string;
  pulledAt: string; // ISO 8601 UTC
  rowCount: number;
  /** Decimal strings, or null when the report has no debit/credit columns. */
  debits: string | null;
  credits: string | null;
  balanced: boolean | null;
  reconciliation: 'PASS';
  validated: boolean;
  notes: string[];
  mock: boolean;
}

export interface ReportResult {
  columns: Column[];
  /** Cells aligned to `columns`. Money = exact decimal string, date = YYYY-MM-DD, int = digits. */
  rows: string[][];
  info: PullInfo;
}
