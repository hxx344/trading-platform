/** Closed public bars grouped on fixed UTC boundaries. The manifest describes the entire requested window. */
export type CandleBlockCache<T> = { at: number; tag: string; rows: T[] }[];
export type CandleBlocks<T> = { blocks: { at: number; tag: string; rows?: T[]; base?: string; removed?: number[] }[] };

export const CANDLE_TAG = /^[a-zA-Z0-9_-]{22}$/;
export const MAX_CANDLE_BLOCKS = 256;

/** The browser advertises only versions it has, including when expanding a smaller window. */
export function candleKnown<T extends { time: number }>(cache: CandleBlockCache<T>): string {
  return cache.map(block => {
    const key = block.at.toString(36) + ':' + block.tag;
    const first = block.rows[0]?.time, last = block.rows.at(-1)?.time;
    return first === undefined || last === undefined ? key : key + ':' + (first - block.at).toString(36) + ':' + (last - block.at).toString(36);
  }).join('.');
}

const validated = new WeakMap<object, { at: number; spanMs: number }>();

function checkRows<T extends { time: number }>(rows: T[], at: number, spanMs: number): void {
  if (!Array.isArray(rows)) throw Error('缺少历史 K 线缓存');
  const checked = validated.get(rows);
  if (checked?.at === at && checked.spanMs === spanMs) return;
  let last = -1;
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.time) || row.time < at || row.time >= at + spanMs || row.time <= last) throw Error('历史 K 线区间无效');
    last = row.time;
  }
  validated.set(rows, { at, spanMs });
}

/** Missing blocks have left the window. A patch is usable only with its exact advertised base. */
export function mergeCandleBlocks<T extends { time: number }>(previous: CandleBlockCache<T>, update: CandleBlocks<T>, spanMs: number): CandleBlockCache<T> {
  if (!Number.isSafeInteger(spanMs) || spanMs <= 0 || !Array.isArray(update?.blocks) || update.blocks.length > MAX_CANDLE_BLOCKS) throw Error('历史 K 线版本无效');
  const base = new Map(previous.map(block => [block.at, block]));
  let last = -1;
  const merged = update.blocks.map(block => {
    if (!block || !Number.isSafeInteger(block.at) || block.at <= last || block.at % spanMs || !CANDLE_TAG.test(block.tag)) throw Error('历史 K 线版本无效');
    const { at, tag } = block, old = base.get(at);
    last = at;
    if (block.rows === undefined) {
      if (!old || old.tag !== tag || block.base !== undefined || block.removed !== undefined) throw Error('缺少历史 K 线版本');
      checkRows(old.rows, at, spanMs);
      return old;
    }
    checkRows(block.rows, at, spanMs);
    let rows = block.rows;
    if (block.base !== undefined) {
      if (!old || old.tag !== block.base || !Array.isArray(block.removed)) throw Error('缺少历史 K 线基准');
      checkRows(old.rows, at, spanMs);
      const points = new Map(old.rows.map(row => [row.time, row]));
      for (const time of block.removed) if (!points.delete(time)) throw Error('历史 K 线删除时间无效');
      for (const row of rows) points.set(row.time, row);
      rows = [...points.values()].sort((a, b) => a.time - b.time);
      validated.set(rows, { at, spanMs });
    } else if (block.removed !== undefined) throw Error('历史 K 线增量无效');
    if (!rows.length) throw Error('历史 K 线区块为空');
    return { at, tag, rows };
  });
  return merged.length === previous.length && merged.every((block, i) => block === previous[i]) ? previous : merged;
}
