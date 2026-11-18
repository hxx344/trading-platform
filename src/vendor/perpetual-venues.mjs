// Stable public venue identities shared by the execution-side Monitor and the independent collector.
export const KRAKEN_EXCHANGE = Object.freeze({ id: 'kraken', name: 'Kraken', type: 'cex', website: 'https://www.kraken.com', docsUrl: 'https://docs.kraken.com/exchange/api-reference/futures-websocket/ticker' });
export const ADDITIONAL_EXCHANGES = [
  { id: 'rh-lighter', name: 'rh-Lighter', type: 'dex', website: 'https://robinhoodchain.lighter.xyz', docsUrl: 'https://apidocs.rh.lighter.xyz/docs/websocket', description: 'Robinhood Chain 独立盘口 · USDG · WS 买卖一档' },
  { id: 'entropy', name: 'Entropy', type: 'dex', website: 'https://entropy.io', docsUrl: 'https://docs.entropy.io', description: 'Hyperliquid HIP-3 io · USDC · WS 买卖一档；非标准合约独立展示' },
];

export const EXCHANGES = Object.freeze([
  { id: 'binance', name: 'Binance', type: 'cex', website: 'https://www.binance.com', docsUrl: 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/public' },
  { id: 'bybit', name: 'Bybit', type: 'cex', website: 'https://www.bybit.com', docsUrl: 'https://bybit-exchange.github.io/docs/v5/websocket/public/ticker' },
  { id: 'okx', name: 'OKX', type: 'cex', website: 'https://www.okx.com', docsUrl: 'https://www.okx.com/docs-v5/en/' },
  { id: 'bitget', name: 'Bitget', type: 'cex', website: 'https://www.bitget.com', docsUrl: 'https://www.bitget.com/api-doc/classic/contract/websocket/public/Tickers-Channel' },
  { id: 'gate', name: 'Gate', type: 'cex', website: 'https://www.gate.com', docsUrl: 'https://www.gate.com/docs/developers/futures/ws/en/' },
  KRAKEN_EXCHANGE,
  { id: 'hyperliquid', name: 'Hyperliquid', type: 'dex', website: 'https://app.hyperliquid.xyz', docsUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions' },
  { id: 'lighter', name: 'Lighter', type: 'dex', website: 'https://app.lighter.xyz', docsUrl: 'https://apidocs.lighter.xyz/docs/websocket-reference' },
  { id: 'aster', name: 'Aster', type: 'dex', website: 'https://www.asterdex.com', docsUrl: 'https://asterdex.github.io/aster-api-website/futures/websocket-market-streams/' },
  ...ADDITIONAL_EXCHANGES,
].map(row => ({ ...row, kind: row.type })));
