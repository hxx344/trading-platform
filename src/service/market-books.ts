import { VenueError, type VenueConnector } from '../connector.ts';
import { parseQuote } from '../contracts.ts';
import type { MarketClient } from '../market/ipc.ts';

/** Binds each normalized quote to the local lifetime of the private connection that supplied it. */
export function useMarketBooks(connector: VenueConnector, client: MarketClient): void {
  let lastEpoch: string | null = null, generation = 0;
  connector.quote = async (symbol, { signal }) => {
    const quote = parseQuote(await client.call('books.quote', { venue: connector.venue, symbol }, signal), connector.venue, symbol);
    const epoch = client.epoch();
    if (epoch === null || quote.sourceTime === null) throw new VenueError('read-failed', '缺少可核验的交易所盘口');
    if (epoch !== lastEpoch) { lastEpoch = epoch; generation++; }
    return { ...quote, connectionGeneration: generation };
  };
  connector.quoteCurrent = quote => lastEpoch !== null && lastEpoch === client.epoch() && quote.connectionGeneration === generation;
}
