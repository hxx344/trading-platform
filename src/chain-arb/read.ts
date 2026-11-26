import { anySignal } from '../any-signal.mjs';
import { readDex } from './dex.ts';
import { createGateReader } from './gate.ts';
import { compareChainArb } from './estimate.ts';
import { parseChainArb, type ChainArbView } from './model.ts';

// No public requests run until a user submits a token. The installed service runs this reader in the market process.
export function createChainArbReader({ fetchImpl = fetch, now = Date.now }: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>; now?: () => number;
} = {}) {
  const gate = createGateReader({ fetcher: fetchImpl, clock: now });
  let active = 0;
  return async (raw: unknown, signal: AbortSignal): Promise<ChainArbView> => {
    const input = parseChainArb(raw);
    if (active >= 4) throw Object.assign(new Error('同时查询的币种较多，请稍后重试'), { status: 429 });
    const stop = new AbortController();
    const life = anySignal([stop.signal, signal], 12_000);
    life.throwIfAborted();
    active++;
    try {
      const [buy, venue] = await Promise.all([readDex(input, life, fetchImpl), gate(input, life)]);
      life.throwIfAborted();
      return compareChainArb(input, buy, venue, now());
    } finally {
      stop.abort();
      active--;
    }
  };
}
