import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import { readDex } from './dex.ts';
import { createGateReader } from './gate.ts';
import { createBinanceReader } from './binance.ts';
import { createBitgetReader } from './bitget.ts';
import type { VenueReader } from './venue.ts';
import { compareChainArb } from './estimate.ts';
import { parseChainArb, VENUE_NAMES, type ChainArbVenue, type ChainArbView } from './model.ts';
import { parseChainArbScan } from './scan-model.ts';
import { createScanCatalog } from './catalog.ts';
import { createChainArbScanner } from './scan.ts';
import { createQuoteBudget } from './quote-budget.ts';

// The single-token view and the scanner share the same public sources, metadata cache and request budget.
export function createChainArbMarket({ fetchImpl = fetch, now = Date.now, venueReaders }: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; venueReaders?: Record<ChainArbVenue, VenueReader>;
} = {}) {
  const options = { fetchImpl, now };
  const readers: Record<ChainArbVenue, VenueReader> = venueReaders ?? {
    gate: { read: createGateReader({ fetcher: fetchImpl, clock: now }), catalog: createScanCatalog(options) },
    binance: createBinanceReader(options), bitget: createBitgetReader(options),
  };
  const acquire = createQuoteBudget(now), closing = new AbortController();
  async function quote(raw: unknown, signal: AbortSignal, scanning: boolean): Promise<ChainArbView> {
    const input = parseChainArb(raw);
    signal.throwIfAborted();
    const stop = new AbortController();
    // A scan's batch bounds its wait. A page request keeps its original 12-second end-to-end deadline.
    const waiting = anySignal([stop.signal, signal, closing.signal], scanning ? undefined : 12_000);
    let release: (() => void) | undefined;
    try {
      release = await acquire(waiting, scanning);
      const life = scanning ? anySignal([waiting, stop.signal], 12_000) : waiting;
      life.throwIfAborted();
      const name = input.venue ?? 'gate', reader = readers[name];
      const [buy, venue] = await untilAborted(Promise.all([readDex(input, life, fetchImpl), reader.read(input, life, scanning)]), life);
      life.throwIfAborted();
      if (input.source === 'scan') {
        const directory = await reader.catalog(life);
        life.throwIfAborted();
        const allowed = directory.find(c => c.chain === input.chain && c.symbol === input.symbol && c.address === input.address);
        if (!allowed?.spot && !('error' in venue.spot)) venue.spot = { error: '当前 ' + VENUE_NAMES[name] + ' 目录未开放该网络的充值卖出路线' };
        if (!allowed?.perp && !('error' in venue.perp)) venue.perp = { error: '当前 ' + VENUE_NAMES[name] + ' 目录未开放该币种的永续路线' };
      }
      return compareChainArb(input, buy, venue, now());
    } finally {
      stop.abort();
      release?.();
    }
  }
  const scanner = (reader: VenueReader) => createChainArbScanner({ catalog: reader.catalog, quote: (raw, signal) => quote(raw, signal, true), now });
  const scans = { gate: scanner(readers.gate), binance: scanner(readers.binance), bitget: scanner(readers.bitget) };
  return { chainArb: (raw: unknown, signal: AbortSignal) => quote(raw, signal, false),
    async scanChainArb(raw: unknown, scope: string, signal: AbortSignal, awaitBatch = false) {
      const input = parseChainArbScan(raw);
      return scans[input.venue ?? 'gate'].read(input, scope, signal, awaitBatch);
    },
    closeChainArb() { closing.abort(); for (const scan of Object.values(scans)) scan.close(); } };
}
