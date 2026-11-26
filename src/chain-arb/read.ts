import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import Decimal from '../vendor/decimal.mjs';
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
import { createOkxReader } from './okx.ts';
import { assertOkxDirectory, type OkxDirectory } from './okx-network.ts';

// The single-token view and the scanner share the same public sources, metadata cache and request budget.
export function createChainArbMarket({ fetchImpl = fetch, now = Date.now, venueReaders }: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number; venueReaders?: Record<Exclude<ChainArbVenue, 'okx'>, VenueReader>;
} = {}) {
  const options = { fetchImpl, now };
  const readers = venueReaders ?? {
    gate: { read: createGateReader({ fetcher: fetchImpl, clock: now }), catalog: createScanCatalog(options) },
    binance: createBinanceReader(options), bitget: createBitgetReader(options),
  };
  const acquire = createQuoteBudget(now), closing = new AbortController();
  async function quote(raw: unknown, signal: AbortSignal, scanning: boolean, reader: VenueReader): Promise<ChainArbView> {
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
      const name = input.venue ?? 'gate';
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
  const context = (reader: VenueReader) => ({ reader, scan: createChainArbScanner({
    catalog: reader.catalog, quote: (raw, signal) => quote(raw, signal, true, reader), now,
  }) });
  const markets = { gate: context(readers.gate), binance: context(readers.binance), bitget: context(readers.bitget) };
  type OkxSession = ReturnType<typeof context> & { directory: OkxDirectory };
  let okx: OkxSession | undefined;
  function market(venue: ChainArbVenue = 'gate', proof?: OkxDirectory) {
    if (venue !== 'okx') return markets[venue];
    assertOkxDirectory(proof, now());
    if (!okx || okx.directory.connection !== proof.connection) {
      okx?.scan.close();
      const session: OkxSession = { ...context(createOkxReader(options, () => {
        if (okx !== session || now() < session.directory.at || now() >= session.directory.expiresAt) throw new Error('OKX 链目录需要重新核验');
        return session.directory;
      })), directory: proof };
      okx = session;
    } else if (okx.directory.at !== proof.at) {
      if (okx.directory.at > proof.at) throw new Error('OKX 链目录已经更新');
      const next = new Map(proof.rows.map(row => [row.chain + ':' + row.address, row]));
      const prior = new Map(okx.directory.rows.map(row => [row.chain + ':' + row.address, row]));
      okx.directory = proof;
      okx.scan.revalidateSamples((candidate, kind) => {
        const key = candidate.chain + ':' + candidate.address, row = next.get(key);
        if (row?.symbol !== candidate.symbol) return false;
        const old = prior.get(key);
        return kind === 'perp' || (!!old && row.depositEligible && new Decimal(row.minDeposit).eq(old.minDeposit));
      });
    }
    return okx;
  }
  return { async chainArb(raw: unknown, signal: AbortSignal, proof?: OkxDirectory) {
      const input = parseChainArb(raw);
      return quote(raw, signal, false, market(input.venue, proof).reader);
    },
    async scanChainArb(raw: unknown, scope: string, signal: AbortSignal, awaitBatch = false, proof?: OkxDirectory) {
      const input = parseChainArbScan(raw);
      return market(input.venue, proof).scan.read(input, scope, signal, awaitBatch);
    },
    closeChainArb() { closing.abort(); okx?.scan.close(); for (const entry of Object.values(markets)) entry.scan.close(); } };
}
