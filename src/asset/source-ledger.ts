// Copied from project_aggregation modules/asset/lib/source-ledger.ts at 0014655 (same at 7745181). Changes:
// - no zod: SourceLedger is written out by hand with the fields of the workbench schema, and parseSource (since A-6, the
//   workbook import) checks the zod 3 rules of that schema one by one:
//   - z.object() (not strict): the input must be a plain object; keys outside the schema are dropped, and the result is
//     built in the schema's key order, so JSON.stringify of it (the import fingerprint) is what zod's output gives;
//   - z.string(): a string only; .trim() trims before the length and pattern checks and keeps the trimmed text; .min/.max
//     count UTF-16 units; the date rule is the workbench's (YYYY-MM-DD that is a real calendar day);
//   - z.number().finite(): a finite number only (no coercion), .positive() exclusive of 0; .nullable() accepts null but the
//     key must be present; `formula` is optional (left out of the result when missing) and may be a string, number or null;
//   - a schema failure throws AssetInputError (answered with the workbench's ZodError text); the ledger rules after it
//     throw plain Errors with the workbench's messages.
import { AssetInputError } from './validation.ts';
import { sumKnownValues } from './asset-values.ts';

export const EXAMPLE_SOURCE = '示例数据（非真实资产）';
export const isVariationalProject = (project: string) => ['var', 'variational'].includes(project.trim().toLowerCase());
export const isGateProject = (project: string) => ['gate', 'gate.io'].includes(project.trim().toLowerCase());
export const isHyperliquidProject = (project: string) => ['hyperliquid', 'hl'].includes(project.trim().toLowerCase());
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export type SourceRow = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string; formula?: string | number | null };
export type SourcePeriod = { id: string; date: string; total: number; fx: number; cny: number; rows: SourceRow[]; future: boolean; rowSum: number; difference: number };
export type SourceLedger = { source: string; sheet: string; startedAt: string; baselineId: string; baselineDate: string; fx: number; periods: SourcePeriod[] };

type Raw = Record<string, unknown>;
function object(value: unknown, field: string): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetInputError(`${field} 须为对象`);
  return value as Raw;
}
function text(value: unknown, field: string, min: number, max: number, { trim = false, pattern }: { trim?: boolean; pattern?: RegExp } = {}): string {
  if (typeof value !== 'string') throw new AssetInputError(`${field} 须为字符串`);
  const result = trim ? value.trim() : value;
  if (result.length < min || result.length > max || (pattern && !pattern.test(result))) throw new AssetInputError(`${field} 格式不正确`);
  return result;
}
function date(value: unknown, field: string): string {
  const result = text(value, field, 0, Infinity, { pattern: /^\d{4}-\d{2}-\d{2}$/ });
  const parsed = new Date(result + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new AssetInputError(`${field} 不是有效日期`);
  return result;
}
function finite(value: unknown, field: string, { positive = false, nullable = false } = {}): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) throw new AssetInputError(`${field} 须为有限数`);
  return value;
}
const number = (value: unknown, field: string, positive = false) => finite(value, field, { positive }) as number;
function list(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new AssetInputError(`${field} 条数不正确`);
  return value;
}
function sourceRow(value: unknown): SourceRow {
  const raw = object(value, 'rows[]');
  const row: SourceRow = {
    id: text(raw.id, 'id', 0, Infinity, { pattern: /^row-\d{1,6}$/ }),
    project: text(raw.project, 'project', 1, 200, { trim: true }), kind: text(raw.kind, 'kind', 1, 100, { trim: true }),
    quantity: finite(raw.quantity, 'quantity', { nullable: true }), price: finite(raw.price, 'price', { nullable: true }),
    value: finite(raw.value, 'value', { nullable: true }), cell: text(raw.cell, 'cell', 0, Infinity, { pattern: /^[A-Z]{1,3}\d{1,6}$/ }),
  };
  if (raw.formula !== undefined) {
    const formula = raw.formula;
    if (formula !== null && !(typeof formula === 'string' && formula.length <= 4096) && !(typeof formula === 'number' && Number.isFinite(formula))) throw new AssetInputError('formula 格式不正确');
    row.formula = formula as SourceRow['formula'];
  }
  return row;
}
function sourcePeriod(value: unknown): SourcePeriod {
  const raw = object(value, 'periods[]');
  const id = text(raw.id, 'id', 0, Infinity, { pattern: /^[A-Z]{1,3}1$/ }), day = date(raw.date, 'date');
  const total = number(raw.total, 'total'), fx = number(raw.fx, 'fx', true), cny = number(raw.cny, 'cny');
  const rows = list(raw.rows, 'rows', 1, 1000).map(sourceRow);
  if (typeof raw.future !== 'boolean') throw new AssetInputError('future 须为布尔值');
  return { id, date: day, total, fx, cny, rows, future: raw.future, rowSum: number(raw.rowSum, 'rowSum'), difference: number(raw.difference, 'difference') };
}

/** The workbench's parseSource: the schema, then the ledger rules; future, rowSum and difference are recomputed. */
export function parseSource(input: unknown): SourceLedger {
  const raw = object(input, '导入文件');
  const source: SourceLedger = {
    source: text(raw.source, 'source', 1, 255), sheet: text(raw.sheet, 'sheet', 1, 100), startedAt: date(raw.startedAt, 'startedAt'),
    baselineId: text(raw.baselineId, 'baselineId', 0, Infinity), baselineDate: date(raw.baselineDate, 'baselineDate'), fx: number(raw.fx, 'fx', true),
    periods: list(raw.periods, 'periods', 1, 1000).map(sourcePeriod),
  };
  if (new Set(source.periods.map(p => p.id)).size !== source.periods.length) throw new Error('原表快照编号重复');
  for (const period of source.periods) {
    if (new Set(period.rows.map(r => r.id)).size !== period.rows.length) throw new Error('原表资产编号重复');
    period.future = period.date > source.startedAt;
    period.rowSum = sumKnownValues(period.rows).total;
    period.difference = Math.round((period.rowSum - period.total) * 1e8) / 1e8;
    if (!Number.isFinite(period.rowSum)) throw new Error('原表资产合计超出范围');
  }
  const baseline = source.periods.filter(p => !p.future).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!baseline || baseline.id !== source.baselineId || baseline.date !== source.baselineDate || baseline.fx !== source.fx) throw new Error('原表起始快照与日期或汇率不一致');
  if (Math.abs(baseline.difference) > 0.01) throw new Error('原表起始快照的行合计与总额不一致');
  for (const name of ['virtual', 'bybit', 'aster']) {
    if (baseline.rows.filter(r => r.project === name).length !== 1) throw new Error('原表必须各有一条 virtual、bybit 和 aster 资产');
  }
  if (baseline.rows.filter(r => r.project.trim().toLowerCase() === 'binance').length > 1) throw new Error('原表最多包含一条 Binance 资产，避免重复计入');
  if (baseline.rows.filter(r => r.project.trim().toLowerCase() === 'okx').length > 1) throw new Error('原表最多包含一条 OKX 资产，避免重复计入');
  if (baseline.rows.filter(r => isGateProject(r.project)).length > 1) throw new Error('原表最多包含一条 Gate / Gate.io 资产，避免重复计入');
  if (baseline.rows.filter(r => isHyperliquidProject(r.project)).length > 1) throw new Error('原表最多包含一条 Hyperliquid / HL 资产，避免重复计入');
  if (baseline.rows.filter(r => isVariationalProject(r.project)).length > 1) throw new Error('原表最多包含一条 Var / Variational 资产，避免重复计入');
  return source;
}
