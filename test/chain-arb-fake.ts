// Deterministic public endpoints for the monitor preview and the market-process integration check.
export const ARB_ADDRESS = '0x912ce59144191c1204e64559fe8253a0e49e6548';
export const chainArbFixture = (now = Date.now) => async (url: string, _init: RequestInit) => {
  const target = new URL(url), p = target.searchParams;
  const flags = { deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false };
  let body: unknown;
  if (target.hostname === 'aggregator-api.kyberswap.com' && target.pathname === '/arbitrum/api/v1/routes' && p.get('tokenOut') === ARB_ADDRESS) {
    const amountIn = p.get('amountIn')!;
    body = { code: 0, data: { routeSummary: { amountIn, amountOut: String(BigInt(amountIn) * 10n ** 13n),
      tokenIn: p.get('tokenIn'), tokenOut: ARB_ADDRESS, timestamp: Math.floor(now() / 1000) } } };
  } else if (target.hostname === 'arb1.arbitrum.io') {
    body = { id: 1, jsonrpc: '2.0', result: '0x' + '12'.padStart(64, '0') };
  } else if (target.pathname.endsWith('/currencies/ARB')) {
    body = { currency: 'ARB', ...flags, delisted: false, trade_disabled: false, chains: [{ name: 'ARBEVM', addr: ARB_ADDRESS, ...flags }] };
  } else if (target.pathname.endsWith('/currency_pairs/ARB_USDT')) {
    body = { id: 'ARB_USDT', base: 'ARB', quote: 'USDT', type: 'normal', trade_status: 'tradable', amount_precision: 1, slippage: '0.05' };
  } else if (target.pathname.endsWith('/contracts/ARB_USDT')) {
    body = { name: 'ARB_USDT', type: 'direct', contract_type: '', status: 'trading', in_delisting: false, is_pre_market: false,
      quanto_multiplier: '10', order_size_min: '1', order_size_max: '100000', order_price_deviate: '0.2',
      market_order_slip_ratio: '0.05', mark_price: '0.104' };
  } else if (p.get('currency_pair') === 'ARB_USDT') {
    body = { current: now(), update: now() - 100, bids: [['0.103', '25000']] };
  } else if (p.get('contract') === 'ARB_USDT') {
    body = { current: now() / 1000, update: (now() - 100) / 1000, bids: [{ p: '0.104', s: '2500' }] };
  } else return Response.json({}, { status: 404 });
  return Response.json(body, { headers: { date: new Date(now()).toUTCString() } });
};
