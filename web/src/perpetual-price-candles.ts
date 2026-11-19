import { candleKnown, mergeCandleBlocks, type CandleBlockCache } from '../../src/candle-blocks.ts';
import type { FundingHistoryPairRequest } from '../../src/vendor/perpetual-funding-history.ts';
import {
  PRICE_BLOCK_MS, PRICE_HISTORY_LOOKBACK_MS, PRICE_HOUR_MS, validatePerpetualPriceHistory,
  type PerpetualPriceBlockReport, type PerpetualPriceHistoryReport, type PerpetualPriceLeg, type PerpetualPricePoint,
} from '../../src/vendor/perpetual-price-history.ts';
import { createPublicCandleCache } from './public-candle-cache.ts';

// Only public closed prices and their original coverage are persisted. API errors and UI state stay in the feed.
type PriceBlocks = CandleBlockCache<PerpetualPricePoint>;
// A tag always covers the entire original block. Only (after, through] may still be displayed from this version.
type ArchivedPrices = { block: PriceBlocks[number]; after: number; through: number; fetchedAt: number };
type SavedLeg = Pick<PerpetualPriceLeg, 'key' | 'identity' | 'exchange' | 'symbol' | 'currency' | 'from' | 'to' | 'fetchedAt' | 'backfillComplete'>
  & { blocks: PriceBlocks; archived?: ArchivedPrices[] };
export const perpetualPriceCache = createPublicCandleCache<SavedLeg>('perpetual-hourly-price-v1', 100);
export type SavedPriceLegs = Map<string, SavedLeg>;
export interface ChartPriceHistory extends PerpetualPriceHistoryReport {
  // These rows may be separated from the authoritative legs by hours that have never been scanned.
  unscanned: Record<string, PerpetualPricePoint[]>;
}

function restoredPriceLeg(saved: SavedLeg): PerpetualPriceLeg {
  const { blocks, archived: _archived, ...metadata } = saved;
  return { ...metadata, points: blocks.flatMap(block => block.rows), status: saved.backfillComplete ? 'ready' : 'pending', error: '' };
}

export function unscannedPrices(saved: SavedLeg): PerpetualPricePoint[] {
  return saved.archived?.flatMap(({ block, after, through }) => block.rows.filter(row => row.time > after && row.time <= through)) ?? [];
}

export function restoredPriceReport(saved: SavedPriceLegs): ChartPriceHistory | null {
  if (!saved.size) return null;
  const legs = Object.fromEntries([...saved].map(([key, value]) => [key, restoredPriceLeg(value)]));
  const unscanned = Object.fromEntries([...saved].map(([key, value]) => [key, unscannedPrices(value)]));
  const sampledAt = [...saved.values()].flatMap(leg => [leg.fetchedAt!, ...(leg.archived ?? []).map(part => part.fetchedAt)]);
  return { schemaVersion: 1, generatedAt: Math.max(...sampledAt), intervalMs: PRICE_HOUR_MS, legs, unscanned };
}

export function readSavedPriceLeg(key: string, identity: string, saved: SavedLeg, now: number): SavedLeg {
  if (saved.key !== key || saved.identity !== identity || saved.fetchedAt === null) throw Error('Invalid cached price identity');
  const blocks = mergeCandleBlocks([], { blocks: saved.blocks }, PRICE_BLOCK_MS);
  const leg = restoredPriceLeg({ ...saved, blocks });
  const valid = (leg: PerpetualPriceLeg) => validatePerpetualPriceHistory({ schemaVersion: 1, generatedAt: leg.fetchedAt, intervalMs: PRICE_HOUR_MS, legs: { [key]: leg } }, now);
  if (!valid(leg)) throw Error('Invalid cached prices');
  if (saved.archived !== undefined) {
    if (!Array.isArray(saved.archived) || saved.archived.length > 720) throw Error('Invalid archived price blocks');
    let last = Math.max(leg.to!, ...saved.archived.map(part => part.through)) - PRICE_HISTORY_LOOKBACK_MS;
    for (const { block, after, through, fetchedAt } of saved.archived) {
      mergeCandleBlocks([], { blocks: [block] }, PRICE_BLOCK_MS);
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(through) || after >= through || after < last || (through > leg.from! && after < leg.to!)
        || !valid({ ...leg, from: block.rows[0].time - PRICE_HOUR_MS, to: block.rows.at(-1)!.time, points: block.rows, fetchedAt, backfillComplete: false })) throw Error('Invalid archived prices');
      last = through;
    }
  }
  return { ...saved, blocks };
}

/** An archived and a currently scanned part of the same UTC day can have different exact server versions. */
function knownBlocks(leg: SavedLeg): PriceBlocks {
  if (!leg.archived?.length) return leg.blocks;
  const byDay = new Map(leg.archived.map(({ block }) => [block.at, block]));
  for (const block of leg.blocks) byDay.set(block.at, block);
  return [...byDay.values()].sort((a, b) => a.at - b.at);
}

export function knownPriceBlocks(saved: SavedPriceLegs): Record<string, string> {
  return Object.fromEntries([...saved.values()].map(leg => [leg.identity, candleKnown(knownBlocks(leg))]));
}

/** Reconstruct against exactly the manifests sent on this read. Validate both legs before updating either cache. */
export function decodePriceHistory(input: unknown, pair: FundingHistoryPairRequest, identities: Record<string, string>, saved: SavedPriceLegs, now: number) {
  let value = input;
  const keys = [pair.longKey, pair.shortKey], updates: SavedPriceLegs = new Map();
  if (input && typeof input === 'object' && 'blockSpanMs' in input) {
    const compact = input as PerpetualPriceBlockReport;
    if (compact.blockSpanMs !== PRICE_BLOCK_MS || !compact.legs || Object.keys(compact.legs).length !== 2) throw Error('Invalid price history blocks');
    const legs = Object.fromEntries(keys.map(key => {
      const { blocks: manifest, ...metadata } = compact.legs[key];
      const previous = saved.get(key);
      const blocks = mergeCandleBlocks(previous?.identity === metadata.identity ? knownBlocks(previous) : [], { blocks: manifest }, PRICE_BLOCK_MS);
      const { identity, exchange, symbol, currency, from, to, fetchedAt, backfillComplete } = metadata;
      if (fetchedAt !== null) updates.set(key, { key, identity, exchange, symbol, currency, from, to, fetchedAt, backfillComplete, blocks });
      return [key, { ...metadata, points: blocks.flatMap(block => block.rows) }];
    }));
    value = { schemaVersion: compact.schemaVersion, intervalMs: compact.intervalMs, generatedAt: compact.generatedAt, legs, storageError: compact.storageError };
  }
  if (!validatePerpetualPriceHistory(value, now)) throw Error('Invalid price history');
  const report = value;
  if (Object.keys(report.legs).length !== 2 || keys.some(key => {
    const leg = report.legs[key];
    return !leg || JSON.parse(leg.identity)[2] !== pair.base || (identities[key] && identities[key] !== leg.identity);
  })) throw Error('Price history selection mismatch');
  return { report, updates };
}

/** Only rows outside the scanned (from,to] can survive a rebuild. Preserve original versions and source timestamps
 * alongside a row-level display interval so partial and disjoint days need no synthetic version or coverage. */
export function retainUnscannedPriceBlocks(previous: SavedLeg | undefined, latest: SavedLeg, status: PerpetualPriceLeg['status'], generatedAt: number): SavedLeg {
  if (!previous || previous.identity !== latest.identity || latest.backfillComplete || latest.from === null || latest.to === null
    || (status !== 'pending' && status !== 'error')) return latest;
  const ceiling = Math.floor(generatedAt / PRICE_HOUR_MS) * PRICE_HOUR_MS, floor = ceiling - PRICE_HISTORY_LOOKBACK_MS;
  const scannedFrom = latest.from, scannedTo = latest.to;
  const archived: ArchivedPrices[] = [];
  function retain(block: PriceBlocks[number], after: number, through: number, fetchedAt: number) {
    after = Math.max(after, floor, block.rows[0].time - PRICE_HOUR_MS);
    through = Math.min(through, ceiling, block.rows.at(-1)!.time);
    for (const [start, end] of [[after, Math.min(through, scannedFrom)], [Math.max(scannedTo, after), through]]) {
      if (start < end && block.rows.some(row => row.time > start && row.time <= end)) archived.push({ block, after: start, through: end, fetchedAt });
    }
  }
  for (const part of previous.archived ?? []) retain(part.block, part.after, part.through, part.fetchedAt);
  if (previous.from !== null && previous.to !== null && previous.fetchedAt !== null) {
    for (const block of previous.blocks) retain(block, previous.from, previous.to, previous.fetchedAt);
  }
  archived.sort((a, b) => a.after - b.after);
  return archived.length ? { ...latest, archived } : latest;
}

export function priceBlocksChanged(previous: SavedLeg | undefined, latest: SavedLeg) {
  return !previous || latest.identity !== previous.identity || latest.fetchedAt !== previous.fetchedAt
    || latest.from !== previous.from || latest.to !== previous.to || latest.backfillComplete !== previous.backfillComplete
    || candleKnown(latest.blocks) !== candleKnown(previous.blocks) || latest.archived?.length !== previous.archived?.length
    || Boolean(latest.archived?.some((part, i) => {
      const old = previous.archived![i];
      return part.block.tag !== old.block.tag || part.after !== old.after || part.through !== old.through || part.fetchedAt !== old.fetchedAt;
    }));
}
