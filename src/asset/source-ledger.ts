// Copied from project_aggregation modules/asset/lib/source-ledger.ts at 0014655: only the project-name rules and the
// example marker that seed.ts uses. Changes:
// - no zod: SourceLedger is written out by hand with the fields of the workbench schema (parseSource belongs to the
//   workbook import, A-6, and is not copied);
// - IMPORT_MAX_BYTES and parseSource are left out.
export const EXAMPLE_SOURCE = '示例数据（非真实资产）';
export const isVariationalProject = (project: string) => ['var', 'variational'].includes(project.trim().toLowerCase());
export const isGateProject = (project: string) => ['gate', 'gate.io'].includes(project.trim().toLowerCase());
export const isHyperliquidProject = (project: string) => ['hyperliquid', 'hl'].includes(project.trim().toLowerCase());

export type SourceRow = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string; formula?: string | number | null };
export type SourcePeriod = { id: string; date: string; total: number; fx: number; cny: number; rows: SourceRow[]; future: boolean; rowSum: number; difference: number };
export type SourceLedger = { source: string; sheet: string; startedAt: string; baselineId: string; baselineDate: string; fx: number; periods: SourcePeriod[] };
