import { ONDO_MARKET } from '../vendor/ondo/client.mjs';
import type { OndoBook } from '../vendor/ondo/stream.mjs';
import { validIdentity, validManualIdentity } from '../vendor/crossex/model.mjs';

export const fields = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error('公开行情字段无效');
  return value as Record<string, unknown>;
};
export function ondoName(value: unknown): string {
  if (typeof value !== 'string' || !ONDO_MARKET.test(value)) throw new Error('Ondo 市场代码无效');
  return value;
}
export function depthLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) throw new Error('盘口档数无效');
  return value;
}
export function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
export function fixedUnits(value: unknown): bigint {
  // decimal.mjs accepts 60 integer and 18 fractional digits before converting to fixed-point units.
  if (typeof value !== 'string' || !/^[1-9]\d{0,77}$/.test(value)) throw new Error('Ondo 行情数量或价格无效');
  return BigInt(value);
}
export function packBook(book: OndoBook, limit?: number) {
  const pack = (levels: OndoBook['bids']) => (limit === undefined ? levels : levels.slice(0, limit)).map(([price, size]) => [price.toString(), size.toString()]);
  return { time: book.time, bids: pack(book.bids), asks: pack(book.asks) };
}
export function unpackBook(value: unknown, limit: number): OndoBook {
  const book = fields(value, ['time', 'bids', 'asks']);
  if (!timestamp(book.time)) throw new Error('Ondo 盘口时间无效');
  const levels = (rows: unknown, ascending: boolean): [bigint, bigint][] => {
    if (!Array.isArray(rows) || rows.length > limit) throw new Error('Ondo 盘口档数无效');
    let previous: bigint | null = null;
    return rows.map(row => {
      if (!Array.isArray(row) || row.length !== 2) throw new Error('Ondo 盘口格式无效');
      const price = fixedUnits(row[0]), size = fixedUnits(row[1]);
      if (previous !== null && (ascending ? price <= previous : price >= previous)) throw new Error('Ondo 盘口顺序无效');
      previous = price;
      return [price, size];
    });
  };
  const bids = levels(book.bids, false), asks = levels(book.asks, true);
  if (bids.length && asks.length && bids[0]![0] >= asks[0]![0]) throw new Error('Ondo 盘口交叉');
  return { time: book.time, bids, asks };
}

const identityKeys = ['exchange', 'symbol', 'base', 'rawBase', 'quoteCurrency', 'counterCurrency', 'settlementCurrency',
  'collateralCurrency', 'contractKind', 'crossexSymbol', 'multiplier', 'assetClass', 'identityVerified', 'identitySource',
  'identityScope', 'nativeUnit', 'comparable', 'marketId'] as const;
/** Public instrument identity only. Monitor quotes can also contain prices, account-independent annotations and other data. */
export function publicIdentity(quote: Record<string, unknown>) {
  return Object.fromEntries(identityKeys.filter(key => quote[key] !== undefined).map(key => [key, quote[key]]));
}
export function checkIdentity(input: unknown, scope: 'manual' | 'comparable' | 'either') {
  const q = fields(input, identityKeys);
  if (Object.values(q).some(value => !['string', 'number', 'boolean'].includes(typeof value) || String(value).length > 128)
    || q.marketId !== undefined && (!Number.isSafeInteger(q.marketId) || Number(q.marketId) < 0 || Number(q.marketId) > 99_999_999)
    || !(scope !== 'comparable' && validManualIdentity(q) || scope !== 'manual' && validIdentity(q))) throw new Error('CrossEx 公开合约身份无效');
  return q;
}
