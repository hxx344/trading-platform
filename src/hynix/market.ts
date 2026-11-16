// SK hynix market display for the service page (docs/hynix.md): the ADR and ordinary-share books on each configured venue and
// the accounts' hynix positions, read the same way as oil's. Nothing here feeds a preview or a send.
import { sub } from '../decimal.ts';
import { HYNIX_ADR, HYNIX_ORDINARY, HYNIX_SYMBOLS } from '../contracts.ts';
import { createMarketReader, type BookSlot, type OilMarketOptions } from '../oil/market.ts';
import { midOf, premiumPercent } from './sizing.ts';

/**
 * Same venue: the ADR's premium over a tenth of the ordinary share, in percent. mid from both midpoints; sell = ADR bid
 * against the ordinary ask (sell the ADR, buy the share: what shorting the premium gets); buy = ADR ask against the
 * ordinary bid (what going long the premium costs). Across venues: one contract's Binance bid − Bybit ask and back, USDT.
 */
export function createHynixMarket(options: OilMarketOptions) {
  const reader = createMarketReader({ ...options, symbols: HYNIX_SYMBOLS });
  const { venues, slot, book, oldest } = reader;
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
  return { refreshQuotes: reader.refreshQuotes, refreshPositions: reader.refreshPositions, view, positionsView: reader.positionsView };
}
export type HynixMarket = ReturnType<typeof createHynixMarket>;
