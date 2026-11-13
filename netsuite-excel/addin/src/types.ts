// Hand-copied mirror of api/src/lib/types.ts (client-visible parts only). Keep in sync.

export type ColumnType = 'text' | 'date' | 'money' | 'int';
export interface Column { key: string; label: string; type: ColumnType }
export interface ParamSpec { name: string; label: string; type: 'date' | 'text'; required: boolean; help?: string }
export interface ReportMeta { id: string; title: string; validated: boolean; params: ParamSpec[]; columns: Column[]; notes: string[] }

export interface PullInfo {
  report: string;
  title: string;
  params: Record<string, string>;
  user: string;
  pulledAt: string;
  rowCount: number;
  debits: string | null;
  credits: string | null;
  balanced: boolean | null;
  reconciliation: 'PASS';
  validated: boolean;
  notes: string[];
  mock: boolean;
}
export interface ReportResult { columns: Column[]; rows: string[][]; info: PullInfo }

export interface Me { email: string; allowed: boolean; role: string; mock: boolean }
export interface ReportsResponse { mock: boolean; maxRows: number; reports: ReportMeta[] }
