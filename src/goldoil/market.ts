// Gold-oil market display for the service page (docs/goldoil.md): the XAUUSDT, CLUSDT and BZUSDT books on each configured
// venue and the accounts' positions in them, read the same way as oil's and hynix's. Reads only: a preview and a send read
// their own books, and no rule judges on these. The oil books are read here apart from the oil market's.
import { GOLD_SYMBOL, GOLDOIL_SYMBOLS, OIL_SYMBOLS } from '../contracts.ts';
import { createMarketReader, type BookSlot, type OilMarketOptions } from '../oil/market.ts';
import { midOf } from '../hynix/sizing.ts';
import { goldOilRatio } from './ratio.ts';

/**
 * Same venue, one row per oil contract: ratio = gold mid ÷ oil mid; sell = gold bid ÷ oil ask (short gold, long oil: what
 * shorting the ratio gets); buy = gold ask ÷ oil bid (long gold, short oil: what going long the ratio costs). Across venues
 * only gold: its first bid − second ask and back for every two venues, USDT (oil across venues is the oil page's).
 */
export function createGoldOilMarket(options: OilMarketOptions) {
  const reader = createMarketReader({ ...options, symbols: GOLDOIL_SYMBOLS });
  const { venues, slot, book, oldest } = reader;
  const mid = (item: BookSlot): string | null => item.bid !== null && item.ask !== null ? midOf(item.bid, item.ask) : null;
  function view() {
    return {
      ...reader.header(),
      books: venues.flatMap(venue => GOLDOIL_SYMBOLS.map(symbol => book(venue, symbol))),
      sameExchange: venues.flatMap(venue => OIL_SYMBOLS.map(oilSymbol => {
        const gold = slot(venue, GOLD_SYMBOL), oil = slot(venue, oilSymbol);
        const goldMid = mid(gold), oilMid = mid(oil);
        return {
          venue, oilSymbol,
          ratio: goldMid !== null && oilMid !== null ? goldOilRatio(goldMid, oilMid) : null,
          sell: gold.bid !== null && oil.ask !== null ? goldOilRatio(gold.bid, oil.ask) : null,
          buy: gold.ask !== null && oil.bid !== null ? goldOilRatio(gold.ask, oil.bid) : null,
          receivedAt: oldest(gold, oil),
        };
      })),
      crossExchange: reader.crossExchange().filter(row => row.symbol === GOLD_SYMBOL),
    };
  }
  return { refreshQuotes: reader.refreshQuotes, refreshPositions: reader.refreshPositions, view, positionsView: reader.positionsView };
}
export type GoldOilMarket = ReturnType<typeof createGoldOilMarket>;
