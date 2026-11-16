// SK hynix market display for the service page (docs/hynix.md): the ADR and ordinary-share books on each configured venue and
// the accounts' hynix positions, read the same way as oil's, and the two legs' notional balance per venue (section 7.4).
// Nothing here feeds a preview or a send.
import { sub } from '../decimal.ts';
import { HYNIX_ADR, HYNIX_ORDINARY, HYNIX_SYMBOLS, VENUE_NAMES, parseInstrument, type Instrument, type Venue } from '../contracts.ts';
import { MARKET_READ_MS, MARKET_TIMEOUT_MS, POSITIONS_READ_MS, POSITIONS_TIMEOUT_MS, bounded, createMarketReader, type BookSlot, type OilMarketOptions } from '../oil/market.ts';
import { balanceLevel, pairBalance, rebalanceOrder, type BalanceLevel, type BalanceSettings, type PairBalance, type RebalanceOrder } from './balance.ts';
import { midOf, premiumPercent } from './sizing.ts';

/** Contract rules change rarely: a good read is kept this long before it is read again (a failed one is retried next round). */
export const RULES_READ_MS = 10 * 60_000;

type Rules = Pick<Instrument, 'contractSize' | 'quantityStep' | 'minQuantity'>;
interface RulesSlot { rules: Rules | null; readAt: number | null; failedAt: number | null; error: string | null }

/** One venue's balance row. Amounts stay exact decimal strings; the page rounds them for display. */
export type BalanceRow = { venue: Venue; positionsAt: number | null; quotesAt: number | null } & (
  | { status: 'unavailable'; reason: string }
  | (PairBalance & { level: BalanceLevel; suggest?: { reduce: RebalanceOrder | { error: string }; add: RebalanceOrder | { error: string } } })
);

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160);

/**
 * Same venue: the ADR's premium over a tenth of the ordinary share, in percent. mid from both midpoints; sell = ADR bid
 * against the ordinary ask (sell the ADR, buy the share: what shorting the premium gets); buy = ADR ask against the
 * ordinary bid (what going long the premium costs). Across venues: one contract's Binance bid − Bybit ask and back, USDT.
 */
export function createHynixMarket(options: OilMarketOptions) {
  const reader = createMarketReader({ ...options, symbols: HYNIX_SYMBOLS });
  const { venues, slot, book, oldest } = reader;
  const now = options.now ?? Date.now;
  const quoteTimeoutMs = options.quoteTimeoutMs ?? MARKET_TIMEOUT_MS, positionsTimeoutMs = options.positionsTimeoutMs ?? POSITIONS_TIMEOUT_MS;
  const spread = (high: BookSlot, low: BookSlot) => high.bid !== null && low.ask !== null ? sub(high.bid, low.ask) : null;
  const mid = (item: BookSlot): string | null => item.bid !== null && item.ask !== null ? midOf(item.bid, item.ask) : null;
  function view() {
    return {
      ...reader.header(),
      books: venues.flatMap(venue => HYNIX_SYMBOLS.map(symbol => book(venue, symbol))),
      sameExchange: venues.map(venue => {
        const adr = slot(venue, HYNIX_ADR), ordinary = slot(venue, HYNIX_ORDINARY);
        const adrMid = mid(adr), ordinaryMid = mid(ordinary);
        return {
          venue,
          premium: adrMid !== null && ordinaryMid !== null ? premiumPercent(adrMid, ordinaryMid) : null,
          sell: adr.bid !== null && ordinary.ask !== null ? premiumPercent(adr.bid, ordinary.ask) : null,
          buy: adr.ask !== null && ordinary.bid !== null ? premiumPercent(adr.ask, ordinary.bid) : null,
          receivedAt: oldest(adr, ordinary),
        };
      }),
      crossExchange: venues.includes('binance') && venues.includes('bybit') ? HYNIX_SYMBOLS.map(symbol => {
        const binance = slot('binance', symbol), bybit = slot('bybit', symbol);
        return { symbol, binanceOverBybit: spread(binance, bybit), bybitOverBinance: spread(bybit, binance), receivedAt: oldest(binance, bybit) };
      }) : [],
    };
  }

  const rules = new Map<string, RulesSlot>(options.connectors.flatMap(connector => HYNIX_SYMBOLS.map(symbol => [`${connector.venue}:${symbol}`, { rules: null, readAt: null, failedAt: null, error: null }] as const)));
  async function refreshRules(): Promise<void> {
    await Promise.all(options.connectors.flatMap(connector => HYNIX_SYMBOLS.map(async symbol => {
      const target = rules.get(`${connector.venue}:${symbol}`)!;
      if (target.readAt !== null && target.error === null && now() - target.readAt < RULES_READ_MS) return;
      try {
        const { contractSize, quantityStep, minQuantity } = parseInstrument(await bounded(signal => connector.instrument(symbol, { signal }), positionsTimeoutMs), connector.venue, symbol);
        Object.assign(target, { rules: { contractSize, quantityStep, minQuantity }, readAt: now(), error: null });
      } catch (error) { Object.assign(target, { failedAt: now(), error: message(error) }); }
    })));
  }
  /** The accounts' positions and, in the same round, the contract rules the balance needs (not on the 3 s book loop). */
  async function refreshPositions(): Promise<void> {
    await Promise.all([reader.refreshPositions(), refreshRules()]);
  }

  /**
   * One row per configured account (one per venue). A row with positions or either book missing, failed or older than two
   * read spacings plus a timeout, or without both contracts' rules, is unavailable: no reading and no suggestion.
   */
  function balanceView(settings: BalanceSettings): BalanceRow[] {
    const time = now();
    const quoteMaxAge = 2 * MARKET_READ_MS + quoteTimeoutMs, positionsMaxAge = 2 * POSITIONS_READ_MS + positionsTimeoutMs;
    return reader.positionsView().accounts.map((account): BalanceRow => {
      const venue = account.venue, adr = slot(venue, HYNIX_ADR), ordinary = slot(venue, HYNIX_ORDINARY);
      const base = { venue, positionsAt: account.receivedAt, quotesAt: oldest(adr, ordinary) };
      const unavailable = (reason: string): BalanceRow => ({ ...base, status: 'unavailable', reason });
      if (account.receivedAt === null || account.long === null || account.short === null) return unavailable(account.error ? `持仓尚未读到（${account.error}）` : '持仓尚未读到');
      if (account.error !== null) return unavailable(`持仓最近一次读取失败：${account.error}`);
      if (time - account.receivedAt > positionsMaxAge) return unavailable('持仓读数已过期');
      for (const [symbol, item] of [[HYNIX_ADR, adr], [HYNIX_ORDINARY, ordinary]] as const) {
        if (item.bid === null || item.ask === null || item.receivedAt === null) return unavailable(item.error ? `${symbol} 盘口未取得（${item.error}）` : `${symbol} 盘口未取得`);
        if (item.error !== null) return unavailable(`${symbol} 盘口最近一次读取失败：${item.error}`);
        if (time - item.receivedAt > quoteMaxAge) return unavailable(`${symbol} 盘口已过期`);
      }
      const adrRules = rules.get(`${venue}:${HYNIX_ADR}`)?.rules, ordinaryRules = rules.get(`${venue}:${HYNIX_ORDINARY}`)?.rules;
      for (const [symbol, item] of [[HYNIX_ADR, adrRules], [HYNIX_ORDINARY, ordinaryRules]] as const) {
        if (!item) { const error = rules.get(`${venue}:${symbol}`)?.error; return unavailable(`${VENUE_NAMES[venue]} ${symbol} 合约规则未读到${error ? `（${error}）` : ''}`); }
      }
      const held = (symbol: string, item: BookSlot, contract: Rules) => ({ symbol, long: account.long![symbol] ?? '0', short: account.short![symbol] ?? '0', price: mid(item)!, contractSize: contract.contractSize });
      const balance = pairBalance(held(HYNIX_ADR, adr, adrRules!), held(HYNIX_ORDINARY, ordinary, ordinaryRules!));
      const level = balanceLevel(balance, settings);
      if (balance.status !== 'paired') return { ...base, ...balance, level };
      const instruments = { [HYNIX_ADR]: adrRules!, [HYNIX_ORDINARY]: ordinaryRules! };
      return { ...base, ...balance, level, suggest: { reduce: rebalanceOrder(balance, 'reduce', instruments), add: rebalanceOrder(balance, 'add', instruments) } };
    });
  }
  return { refreshQuotes: reader.refreshQuotes, refreshPositions, view, positionsView: reader.positionsView, balanceView };
}
export type HynixMarket = ReturnType<typeof createHynixMarket>;
