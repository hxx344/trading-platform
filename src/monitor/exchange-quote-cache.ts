import { EXCHANGE_REFRESH_MS, externalQuoteStale, validateExchangeQuote, type Exchange, type ExchangeQuote, type SpreadMarket } from '../vendor/exchange-comparison.mjs';
import type { MonitorStore } from './store.ts';

type Slot = {
  quote: ExchangeQuote | null; saved: string | null;
  checkedAt: number | null; scope: string | null; confirmed: boolean;
  pending?: { scope: string; done: Promise<ExchangeQuote> };
};
const retained = (quote: ExchangeQuote): ExchangeQuote => ({ ...quote, status: 'snapshot' });
const publicQuote = (quote: ExchangeQuote) => quote.exchange !== 'variational' || quote.timestampBasis === 'received';

/** One display observation per fixed market/venue, written only by the owner of monitor.sqlite. */
export function createStoredExchangeQuotes({ store, read, scope, epoch = () => 'local', signal, now, log }: {
  store: Pick<MonitorStore, 'readState' | 'writeState'>;
  read: (market: SpreadMarket, exchange: Exchange) => Promise<ExchangeQuote>;
  /** Changes on a monitor switch or Var session change. Null when the market is disabled. */
  scope: (market: SpreadMarket, exchange: Exchange) => string | null;
  epoch?: () => string | null; signal: AbortSignal; now: () => number; log: (line: string) => void;
}) {
  const slots = new Map<string, Slot>(), storageFailures = new Set<string>();
  const reportStorage = (key: string) => {
    if (!storageFailures.has(key)) log(`交易所对比 ${key} 无法保存或恢复展示报价，继续使用当前采集结果`);
    storageFailures.add(key);
  };
  const storageKey = (market: SpreadMarket, exchange: Exchange) => `comparison.v1.${market}.${exchange}`;
  function restore(market: SpreadMarket, exchange: Exchange): Slot {
    const key = storageKey(market, exchange), existing = slots.get(key);
    if (existing) return existing;
    const slot: Slot = { quote: null, saved: null, checkedAt: null, scope: null, confirmed: false };
    try {
      const stored = store.readState(key);
      if (stored) {
        const quote = validateExchangeQuote(stored.value, exchange, market);
        if (publicQuote(quote) && Date.parse(quote.fetchedAt) <= now() + 60_000) {
          slot.quote = quote; slot.saved = JSON.stringify(quote);
        }
      }
    } catch { reportStorage(key); }
    slots.set(key, slot);
    return slot;
  }

  function save(slot: Slot, quote: ExchangeQuote) {
    slot.quote = quote;
    const encoded = JSON.stringify(quote);
    if (encoded === slot.saved) return;
    const key = storageKey(quote.monitorId, quote.exchange);
    try { store.writeState(key, quote); slot.saved = encoded; storageFailures.delete(key); }
    catch { reportStorage(key); }
  }
  async function readQuote(market: SpreadMarket, exchange: Exchange): Promise<ExchangeQuote> {
    signal.throwIfAborted();
    const source = scope(market, exchange);
    if (source === null) throw new Error('展示报价来源已切换，请重新读取');
    const slot = restore(market, exchange);
    const connection = epoch(), identity = `${source}/${connection ?? 'offline'}`, previous = slot.quote;
    const at = now(), age = slot.checkedAt === null ? Infinity : at - slot.checkedAt;
    if (!connection && previous) return retained(previous);
    if (previous && slot.scope === identity && age >= 0 && age < (slot.confirmed ? EXCHANGE_REFRESH_MS : 5_000)) {
      if (!slot.confirmed) return retained(previous);
      if (!externalQuoteStale(previous, at)) return previous;
      if (externalQuoteStale(previous, slot.checkedAt!)) return retained(previous);
    }
    // A restored, interrupted or overdue source can be shown immediately as historical. Normal 15 s polls
    // await the new sample, so a continuously open page does not spend every poll one observation behind.
    const showFirst = previous && (!slot.confirmed || slot.scope !== identity || externalQuoteStale(previous, at));
    let request = slot.pending;
    if (request?.scope !== identity) {
      const current = () => !signal.aborted && scope(market, exchange) === source && slot.pending === request;
      const done = Promise.resolve().then(async () => {
        if (!current()) throw new Error('展示报价来源已切换，请重新读取');
        try {
          const quote = validateExchangeQuote(await read(market, exchange), exchange, market);
          const active = epoch();
          if (!current() || !active || (connection !== null && active !== connection) || !publicQuote(quote)) throw new Error('展示报价来源已切换，请重新读取');
          const received = now(), priceAt = Date.parse(quote.fetchedAt);
          if (priceAt > received + 60_000 || (previous && Date.parse(previous.fetchedAt) <= received + 60_000 && priceAt < Date.parse(previous.fetchedAt))) throw new Error('交易所返回了更早的展示报价');
          save(slot, quote);
          slot.scope = `${source}/${active}`; slot.checkedAt = at; slot.confirmed = true;
          return externalQuoteStale(quote, received) ? retained(quote) : quote;
        } catch (error) {
          if (!current()) throw error;
          slot.scope = identity; slot.checkedAt = now(); slot.confirmed = false;
          if (!previous) throw error;
          return retained(previous);
        }
      }).finally(() => { if (slot.pending === request) delete slot.pending; });
      request = { scope: identity, done };
      slot.pending = request;
    }
    if (showFirst) { void request.done.catch(() => undefined); return retained(previous); }
    return request.done;
  }
  return {
    read: readQuote,
    /** Authenticated indicative marks exist only in the session reader. Its public fallback may be archived. */
    async variational(sameRegistration: () => boolean) {
      signal.throwIfAborted();
      const slot = restore('oil', 'variational');
      try {
        const quote = await read('oil', 'variational');
        signal.throwIfAborted();
        // The session reader can finish with verified marks from a replacement token. Its caller
        // checks the producing revision at delivery. Only the public fallback belongs to this slot.
        if (!publicQuote(quote)) return quote;
        if (!sameRegistration()) throw new Error('展示报价来源已切换，请重新读取');
        if (!slot.quote || Date.parse(quote.fetchedAt) >= Date.parse(slot.quote.fetchedAt)) {
          save(slot, quote); slot.confirmed = false;
        }
        return quote;
      } catch (error) {
        // Rejection/expiry of this same credential can itself cause both live sources to fail. A public
        // observation remains eligible, while an intervening monitor run or registration invalidates this read.
        signal.throwIfAborted();
        if (!slot.quote || !sameRegistration()) throw error;
        return retained(slot.quote);
      }
    },
  };
}
