// Written after project_aggregation modules/asset/lib/validation.ts at 0014655: editSchema, fxSchema, withdrawalSchema,
// withdrawalIdSchema and editValue. The rules are the zod 3 rules of those schemas, one by one, without zod (this
// service has no runtime dependencies):
// - .strict(): a key outside the schema refuses the input; the body must be a plain object (not null, not an array);
// - z.number(): a number only (no coercion from strings), not NaN; .finite() also refuses ±Infinity;
// - .min/.max are inclusive, .gt/.positive exclusive; .nullable() accepts null but the key must be present;
// - z.string().uuid(): zod 3's pattern (8-4-4-4-12 hex digits, any version);
// - note: .trim().max(200).default(''): a missing note is '', a string is trimmed and then at most 200 UTF-16 units.
// A refusal throws AssetInputError, which the HTTP layer answers with the workbench's ZodError text (api.ts failure).
// connectionSchema and the Aster account schemas belong to A-3/A-4 and are not here.

export class AssetInputError extends Error {
  constructor(detail: string) { super(detail); this.name = 'AssetInputError'; }
}
/** What the workbench answers for a ZodError (lib/api.ts failure), whatever field failed. */
export const INPUT_INVALID = '输入格式不正确，请检查数值和连接信息';

type Body = Record<string, unknown>;
function strict(value: unknown, keys: readonly string[], required: readonly string[] = keys): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetInputError('请求体须为对象');
  const body = value as Body;
  const extra = Object.keys(body).find(key => !keys.includes(key));
  if (extra !== undefined) throw new AssetInputError(`不认识的字段 ${extra.slice(0, 40)}`);
  const missing = required.find(key => !Object.hasOwn(body, key));
  if (missing !== undefined) throw new AssetInputError(`缺少字段 ${missing}`);
  return body;
}
const finite = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new AssetInputError(`${field} 须为有限数`);
  return value;
};
function between(value: unknown, field: string, min: number, max: number, { exclusiveMin = false } = {}): number {
  const number = finite(value, field);
  if (exclusiveMin ? number <= min : number < min) throw new AssetInputError(`${field} 过小`);
  if (number > max) throw new AssetInputError(`${field} 过大`);
  return number;
}
const ZOD_UUID = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
const uuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !ZOD_UUID.test(value)) throw new AssetInputError(`${field} 须为 UUID`);
  return value;
};

export type EditInput = { id: string; quantity: number; price: number | null };
/** editSchema: {id:/^row-\d+$/, quantity:0–1e15, price:0–1e9 or null}. */
export function parseEdit(value: unknown): EditInput {
  const body = strict(value, ['id', 'quantity', 'price']);
  if (typeof body.id !== 'string' || !/^row-\d+$/.test(body.id)) throw new AssetInputError('id 无效');
  return { id: body.id, quantity: between(body.quantity, 'quantity', 0, 1e15), price: body.price === null ? null : between(body.price, 'price', 0, 1e9) };
}

/** fxSchema: {fx: 0 < fx ≤ 1000}. */
export function parseFx(value: unknown): number {
  return between(strict(value, ['fx']).fx, 'fx', 0, 1000, { exclusiveMin: true });
}

export type WithdrawalInput = { id: string; date: string; amount: number; note: string };
/** withdrawalSchema: a UUID, a real calendar day, an amount above 0 up to 1e12 with at most two decimals, a note of up to 200. */
export function parseWithdrawal(value: unknown): WithdrawalInput {
  const body = strict(value, ['id', 'date', 'amount', 'note'], ['id', 'date', 'amount']);
  const id = uuid(body.id, 'id');
  const date = body.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AssetInputError('date 须为 YYYY-MM-DD');
  const parsed = new Date(date + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new AssetInputError('date 不是有效日期');
  const amount = between(body.amount, 'amount', 0, 1e12, { exclusiveMin: true });
  if (Number(amount.toFixed(2)) !== amount) throw new AssetInputError('金额最多两位小数');
  // zod's .default('') applies to a missing key (undefined) only; null or a number is refused.
  if (body.note !== undefined && typeof body.note !== 'string') throw new AssetInputError('note 须为文字');
  const note = (body.note ?? '').trim();
  if (note.length > 200) throw new AssetInputError('note 过长');
  return { id, date, amount, note };
}

/** withdrawalIdSchema: {id: UUID}. */
export function parseWithdrawalId(value: unknown): string {
  return uuid(strict(value, ['id']).id, 'id');
}

/** Copied from editValue in validation.ts, unchanged. */
export function editValue(quantity: number, price: number | null) {
  if (quantity === 0) return 0;
  if (price === null) throw new Error('数量大于零时，请填写单价');
  return quantity * price;
}
