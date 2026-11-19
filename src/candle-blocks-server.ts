import { createHash } from 'node:crypto';
import { CANDLE_TAG, MAX_CANDLE_BLOCKS, type CandleBlockCache, type CandleBlocks } from './candle-blocks.ts';

type TimeRow = { time: number };
type Block<T> = CandleBlockCache<T>[number];

// A committed snapshot is immutable. Retaining a few older block versions lets a new or corrected bar travel on its own.
const bySource = new WeakMap<readonly TimeRow[], { spanMs: number; blocks: CandleBlockCache<TimeRow> }>();
const byTag = new Map<string, Block<TimeRow>>();
let retainedRows = 0;

const fingerprint = (rows: readonly TimeRow[]) => createHash('sha256').update(JSON.stringify(rows)).digest('base64url').slice(0, 22);

function remember<T extends TimeRow>(at: number, rows: T[]): Block<T> {
  const tag = fingerprint(rows);
  const block = { at, tag, rows };
  const existing = byTag.get(tag);
  if (existing) { byTag.delete(tag); retainedRows -= existing.rows.length; }
  byTag.set(tag, block); retainedRows += rows.length;
  while (retainedRows > 96_000 || byTag.size > 4_096) {
    const first = byTag.keys().next().value!;
    retainedRows -= byTag.get(first)!.rows.length;
    byTag.delete(first);
  }
  return block;
}

function partition<T extends TimeRow>(rows: readonly T[], spanMs: number): CandleBlockCache<T> {
  const cached = bySource.get(rows);
  if (cached?.spanMs === spanMs) return cached.blocks as CandleBlockCache<T>;
  const blocks: CandleBlockCache<T> = [];
  for (let begin = 0; begin < rows.length;) {
    const at = Math.floor(rows[begin]!.time / spanMs) * spanMs;
    let end = begin + 1;
    while (end < rows.length && rows[end]!.time < at + spanMs) end++;
    blocks.push(remember(at, rows.slice(begin, end)));
    begin = end;
  }
  bySource.set(rows, { spanMs, blocks });
  return blocks;
}

type Known = { tag: string; first: number; last: number };
function versions(known: string): Map<number, Known> {
  const tags = new Map<number, Known>();
  if (typeof known !== 'string' || !known || known.length > 12_000) return tags;
  const entries = known.split('.');
  if (entries.length > MAX_CANDLE_BLOCKS) return tags;
  for (const entry of entries) {
    const [start, tag, first, last] = entry.split(':');
    if (start && /^[0-9a-z]{1,11}$/.test(start) && tag && CANDLE_TAG.test(tag)) {
      const at = Number.parseInt(start, 36);
      tags.set(at, { tag, first: at + Number.parseInt(first ?? '', 36), last: at + Number.parseInt(last ?? '', 36) });
    }
  }
  return tags;
}

export function encodeCandleBlocks<T extends TimeRow>(rows: readonly T[], spanMs: number, known: string, fromAt = -Infinity): CandleBlocks<T> {
  if (!Number.isSafeInteger(spanMs) || spanMs <= 0) throw Error('历史 K 线分段无效');
  const client = versions(known);
  const blocks = partition(rows, spanMs).filter(block => block.at + spanMs > fromAt).map(block => {
    const { at, tag, rows } = block, before = client.get(at);
    if (before?.tag === tag) return { at, tag };
    const prior = before && byTag.get(before.tag);
    if (prior && prior.at === at) {
      const oldRows = new Map(prior.rows.map(row => [row.time, row]));
      const changed = rows.filter(row => {
        const old = oldRows.get(row.time);
        oldRows.delete(row.time);
        return old !== row && (!old || JSON.stringify(old) !== JSON.stringify(row));
      });
      const removed = [...oldRows.keys()];
      if (changed.length + removed.length < rows.length) return { at, tag, base: prior.tag, rows: changed, removed };
    } else if (before && before.first >= at && before.last < at + spanMs && before.first <= before.last) {
      // Even after a process restart, an unchanged old prefix/suffix proves that only the added hours are needed.
      const shared = rows.filter(row => row.time >= before.first && row.time <= before.last);
      if (shared.length && shared.length < rows.length && fingerprint(shared) === before.tag) {
        return { at, tag, base: before.tag, rows: rows.filter(row => row.time < before.first || row.time > before.last), removed: [] };
      }
    }
    // If the retained version is unavailable and its interior changed, send this block in full.
    return block;
  });
  return { blocks };
}
