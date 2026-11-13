// Written after project_aggregation modules/asset/lib/validation.ts at 0014655: editSchema, fxSchema, withdrawalSchema,
// withdrawalIdSchema and editValue. The rules are the zod 3 rules of those schemas, one by one, without zod (this
// service has no runtime dependencies):
// - .strict(): a key outside the schema refuses the input; the body must be a plain object (not null, not an array);
// - z.number(): a number only (no coercion from strings), not NaN; .finite() also refuses ±Infinity;
// - .min/.max are inclusive, .gt/.positive exclusive; .nullable() accepts null but the key must be present;
// - z.string().uuid(): zod 3's pattern (8-4-4-4-12 hex digits, any version);
// - note: .trim().max(200).default(''): a missing note is '', a string is trimmed and then at most 200 UTF-16 units.
// A refusal throws AssetInputError, which the HTTP layer answers with the workbench's ZodError text (api.ts failure).
// Since A-3/A-4 also connectionSchema, asterAccountSchema, asterAccountDeleteSchema and the DELETE /api/connections body
// (app/api/connections/route.ts), with these rules besides:
// - z.string(): a string only; .trim() trims before the length and pattern checks and the trimmed text is kept; .min/.max
//   count UTF-16 units; the Bybit key and secret are not trimmed (the workbench schema has no .trim() there);
// - z.discriminatedUnion('exchange'): the body must name one of the exchanges, then that branch's strict rules apply;
// - z.boolean().default(false) / z.enum().default('global'): applied to a missing key only; null is refused;
// - asterAccountId: 'default' or a zod 3 UUID.

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

const text = (value: unknown, field: string, { trim = true, min = 0, max = Infinity, pattern }: { trim?: boolean; min?: number; max?: number; pattern?: RegExp } = {}): string => {
  if (typeof value !== 'string') throw new AssetInputError(`${field} 须为文字`);
  const result = trim ? value.trim() : value;
  if (result.length < min) throw new AssetInputError(`${field} 过短`);
  if (result.length > max) throw new AssetInputError(`${field} 过长`);
  if (pattern && !pattern.test(result)) throw new AssetInputError(`${field} 格式不正确`);
  return result;
};
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^(0x)?[0-9a-fA-F]{64}$/;
const flag = (value: unknown, field: string): boolean => {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new AssetInputError(`${field} 须为 true 或 false`);
  return value;
};

export const CONNECTION_EXCHANGES = ['bybit', 'aster', 'binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'] as const;
export type ConnectionExchange = (typeof CONNECTION_EXCHANGES)[number];
export const BYBIT_REGIONS = ['global', 'nl', 'tr', 'kz', 'ge', 'ae', 'eu'] as const;
/** What connectionSchema parses to (the workbench's Credentials). */
export type Credentials =
  | { exchange: 'variational'; vrToken: string }
  | { exchange: 'okx'; apiKey: string; apiSecret: string; passphrase: string }
  | { exchange: 'gate'; apiKey: string; apiSecret: string }
  | { exchange: 'binance'; apiKey: string; apiSecret: string }
  | { exchange: 'bybit'; apiKey: string; apiSecret: string; region: (typeof BYBIT_REGIONS)[number] }
  | { exchange: 'hyperliquid'; walletAddress: string }
  | { exchange: 'rh-lighter'; walletAddress: string }
  | { exchange: 'aster'; walletAddress: string; privateKey: string; includeSpot: boolean };

/** connectionSchema, branch by branch. */
export function parseConnection(value: unknown): Credentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssetInputError('请求体须为对象');
  const exchange = (value as Body).exchange;
  switch (exchange) {
    case 'variational': {
      const body = strict(value, ['exchange', 'vrToken']);
      return { exchange, vrToken: text(body.vrToken, 'vrToken', { min: 5, max: 4096, pattern: /^[A-Za-z0-9._~-]+$/ }) };
    }
    case 'okx': {
      const body = strict(value, ['exchange', 'apiKey', 'apiSecret', 'passphrase']);
      return { exchange, apiKey: text(body.apiKey, 'apiKey', { min: 5, max: 256 }), apiSecret: text(body.apiSecret, 'apiSecret', { min: 5, max: 256 }), passphrase: text(body.passphrase, 'passphrase', { min: 1, max: 256 }) };
    }
    case 'gate': {
      const body = strict(value, ['exchange', 'apiKey', 'apiSecret']), pattern = /^[A-Za-z0-9_-]+$/;
      return { exchange, apiKey: text(body.apiKey, 'apiKey', { min: 5, max: 256, pattern }), apiSecret: text(body.apiSecret, 'apiSecret', { min: 5, max: 256, pattern }) };
    }
    case 'binance': {
      const body = strict(value, ['exchange', 'apiKey', 'apiSecret']);
      return { exchange, apiKey: text(body.apiKey, 'apiKey', { min: 5, max: 256 }), apiSecret: text(body.apiSecret, 'apiSecret', { min: 5, max: 256 }) };
    }
    case 'bybit': {
      const body = strict(value, ['exchange', 'apiKey', 'apiSecret', 'region'], ['exchange', 'apiKey', 'apiSecret']);
      const region = body.region === undefined ? 'global' : body.region;
      if (!(BYBIT_REGIONS as readonly unknown[]).includes(region)) throw new AssetInputError('region 无效');
      return { exchange, apiKey: text(body.apiKey, 'apiKey', { trim: false, min: 5, max: 256 }), apiSecret: text(body.apiSecret, 'apiSecret', { trim: false, min: 5, max: 256 }), region: region as (typeof BYBIT_REGIONS)[number] };
    }
    case 'hyperliquid':
    case 'rh-lighter': {
      const body = strict(value, ['exchange', 'walletAddress']);
      return { exchange, walletAddress: text(body.walletAddress, 'walletAddress', { pattern: ADDRESS }) };
    }
    case 'aster': {
      const body = strict(value, ['exchange', 'walletAddress', 'privateKey', 'includeSpot'], ['exchange', 'walletAddress', 'privateKey']);
      return { exchange, walletAddress: text(body.walletAddress, 'walletAddress', { pattern: ADDRESS }), privateKey: text(body.privateKey, 'privateKey', { pattern: PRIVATE_KEY }), includeSpot: flag(body.includeSpot, 'includeSpot') };
    }
    default: throw new AssetInputError('exchange 无效');
  }
}

const asterAccountId = (value: unknown): string => {
  if (value === 'default') return value;
  return uuid(value, 'id');
};
export type AsterAccountInput = { id: string; name: string; walletAddress: string; privateKey: string; includeSpot: boolean };
/** asterAccountSchema: {id:'default'|UUID, name: 1–40 after trim, walletAddress, privateKey, includeSpot default false}. */
export function parseAsterAccount(value: unknown): AsterAccountInput {
  const body = strict(value, ['id', 'name', 'walletAddress', 'privateKey', 'includeSpot'], ['id', 'name', 'walletAddress', 'privateKey']);
  return {
    id: asterAccountId(body.id), name: text(body.name, 'name', { min: 1, max: 40 }),
    walletAddress: text(body.walletAddress, 'walletAddress', { pattern: ADDRESS }), privateKey: text(body.privateKey, 'privateKey', { pattern: PRIVATE_KEY }),
    includeSpot: flag(body.includeSpot, 'includeSpot'),
  };
}

export type AsterAccountDelete = { id: string; action: 'disconnect' | 'remove' };
/** asterAccountDeleteSchema: {id, action:'disconnect'|'remove'}. */
export function parseAsterAccountDelete(value: unknown): AsterAccountDelete {
  const body = strict(value, ['id', 'action']);
  if (body.action !== 'disconnect' && body.action !== 'remove') throw new AssetInputError('action 无效');
  return { id: asterAccountId(body.id), action: body.action };
}

/** The DELETE /api/connections body: {exchange} of the eight. */
export function parseDisconnect(value: unknown): ConnectionExchange {
  const exchange = strict(value, ['exchange']).exchange;
  if (!(CONNECTION_EXCHANGES as readonly unknown[]).includes(exchange)) throw new AssetInputError('exchange 无效');
  return exchange as ConnectionExchange;
}

/**
 * The exchange a stored connection name belongs to ('aster:<UUID>' is an Aster account's), or null for a name the
 * workbench never writes; used when connections come over from the workbench.
 */
export function connectionExchange(name: unknown): ConnectionExchange | null {
  if (typeof name !== 'string') return null;
  if ((CONNECTION_EXCHANGES as readonly string[]).includes(name)) return name as ConnectionExchange;
  return name.startsWith('aster:') && ZOD_UUID.test(name.slice(6)) ? 'aster' : null;
}
