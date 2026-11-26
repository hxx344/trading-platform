import { anySignal } from '../any-signal.mjs';
import { readDex } from './dex.ts';
import { createGateReader } from './gate.ts';
import { compareChainArb } from './estimate.ts';
import { parseChainArb, type ChainArbView } from './model.ts';
import { createScanCatalog } from './catalog.ts';
import { createChainArbScanner } from './scan.ts';

// The single-token view and the scanner share the same public sources, metadata cache and request budget.
export function createChainArbMarket({ fetchImpl = fetch, now = Date.now }: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number;
} = {}) {
  const gate = createGateReader({ fetcher: fetchImpl, clock: now });
  const catalog = createScanCatalog({ fetchImpl, now });
  let active = 0;
  let starts: number[] = [];
  async function quote(raw: unknown, signal: AbortSignal, scanning: boolean): Promise<ChainArbView> {
    const input = parseChainArb(raw);
    signal.throwIfAborted();
    const at = now();
    starts = starts.filter(start => start <= at && start > at - 1000);
    if (active >= 4 || starts.length >= 3) throw Object.assign(new Error('同时查询的币种较多，请稍后重试'), { status: 429 });
    starts.push(at);
    const stop = new AbortController();
    const life = anySignal([stop.signal, signal], 12_000);
    life.throwIfAborted();
    active++;
    try {
      const [buy, venue] = await Promise.all([readDex(input, life, fetchImpl), gate(input, life, scanning)]);
      life.throwIfAborted();
      if (input.source === 'scan') {
        const directory = await catalog(life);
        life.throwIfAborted();
        const allowed = directory.find(c => c.chain === input.chain && c.symbol === input.symbol && c.address === input.address);
        if (!allowed?.spot && !('error' in venue.spot)) venue.spot = { error: '当前 Gate 目录未开放该网络的充值卖出路线' };
        if (!allowed?.perp && !('error' in venue.perp)) venue.perp = { error: '当前 Gate 目录未开放该币种的永续路线' };
      }
      return compareChainArb(input, buy, venue, now());
    } finally {
      stop.abort();
      active--;
    }
  }
  const scan = createChainArbScanner({ catalog, quote: (raw, signal) => quote(raw, signal, true), now });
  return { chainArb: (raw: unknown, signal: AbortSignal) => quote(raw, signal, false),
    scanChainArb: scan.read, closeChainArb: scan.close };
}
