import { decimal, fromUnits, units } from '../decimal.ts';
import Decimal from '../vendor/decimal.mjs';

export const BITGET_MAX_DEPTH = 1000;
export type BitgetDepth = {
  levels: Map<bigint, string>; limit: number; seq: bigint; firstUpdate: boolean; at: number; sourceAt: number;
};
const invalid = () => new Error('Bitget 盘口增量序号、时间或档位无效');

export function bitgetDecimal(value: unknown, error: string, sign: 'positive' | 'nonnegative' = 'positive'): string {
  let raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || raw.length > 80) throw new Error(error);
  if (/^\d+(?:\.\d+)?[eE][+-]?\d{1,2}$/.test(raw)) raw = new Decimal(raw).toFixed();
  try { return decimal(raw, sign); } catch { throw new Error(error); }
}

function sequence(value: unknown): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value);
  throw invalid();
}
function descending(a: bigint, b: bigint) { return a > b ? -1 : a < b ? 1 : 0; }

export function applyBitgetDepth(book: BitgetDepth | undefined, action: unknown, row: Record<string, unknown>, at: number, sourceAt: number): BitgetDepth {
  const seq = sequence(row.seq), prev = sequence(row.pseq);
  if (seq === 0n || seq < prev) throw invalid();
  // The live field is "maxdepth", the reference schema uses "maxDepth". An update may omit the unchanged limit.
  const limit = Number(sequence(row.maxdepth ?? row.maxDepth ?? book?.limit));
  if (limit < 1 || limit > BITGET_MAX_DEPTH || row.maxDepth !== undefined && sequence(row.maxDepth) !== BigInt(limit)) throw invalid();
  const snapshot = action === 'snapshot';
  if (snapshot) {
    if (book) throw invalid();
    book = { levels: new Map(), seq, firstUpdate: true, limit, at, sourceAt };
  } else {
    if (action !== 'update' || !book || limit !== book.limit || prev === 0n || seq <= prev || sourceAt < book.sourceAt || at < book.at) throw invalid();
    if (book.firstUpdate ? prev > book.seq || seq < book.seq : prev !== book.seq) throw invalid();
    book.firstUpdate = false;
    // The initial snapshot may already include this entire overlapping update. It cannot renew the source timestamp.
    if (seq === book.seq) return book;
  }
  if (!Array.isArray(row.b) || row.b.length > (snapshot ? limit : 2 * limit)) throw invalid();
  const changed = new Set<bigint>();
  let previous: bigint | undefined;
  for (const level of row.b) {
    if (!Array.isArray(level) || level.length !== 2) throw invalid();
    const price = units(bitgetDecimal(level[0], 'Bitget 买价无效'));
    const size = bitgetDecimal(level[1], 'Bitget 买量无效', snapshot ? 'positive' : 'nonnegative');
    if (price <= 0n || changed.has(price) || snapshot && previous !== undefined && price >= previous) throw invalid();
    changed.add(price); previous = price;
    if (size === '0') book.levels.delete(price);
    else book.levels.set(price, size); // Bitget sends the absolute remaining size, including zero for removal.
  }
  if (book.levels.size > limit) {
    for (const price of [...book.levels.keys()].sort(descending).slice(limit)) book.levels.delete(price);
  }
  book.seq = seq; book.at = at; book.sourceAt = sourceAt;
  return book;
}

export function bitgetBookBids(book: BitgetDepth): [string, string][] {
  return [...book.levels.keys()].sort(descending).map(price => [fromUnits(price), book.levels.get(price)!]);
}
