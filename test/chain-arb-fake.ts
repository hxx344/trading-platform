// Deterministic public endpoints for the monitor preview and the market-process integration check.
import type { GateDepositSource } from '../src/chain-arb/gate-deposit-proof.ts';
export const ARB_ADDRESS = '0x912ce59144191c1204e64559fe8253a0e49e6548';
export const testGateLedger = (now = Date.now): GateDepositSource => ({
  async gateDepositProof(symbol, chain) { return { symbol, chain, at: now(), expiresAt: now() + 60_000, minDeposit: '0.1' }; },
  gateDepositCurrent: proof => proof.expiresAt > now(),
});
export function verifiedBuy<T extends { rawQuantity: string }>(buy: T) {
  return { ...buy, evidence: { quotedRaw: buy.rawQuantity, transferRaw: buy.rawQuantity, impactBps: 0, blockNumber: '0x123' } };
}
export const chainArbFixture = (now = Date.now) => async (url: string, init: RequestInit) => {
  const target = new URL(url), p = target.searchParams;
  const flags = { deposit_disabled: false, withdraw_disabled: false, withdraw_delayed: false };
  const arb = { currency: 'ARB', ...flags, delisted: false, trade_disabled: false, chains: [{ name: 'ARBEVM', addr: ARB_ADDRESS, ...flags }] };
  const spot = { id: 'ARB_USDT', base: 'ARB', quote: 'USDT', type: 'normal', trade_status: 'tradable', amount_precision: 1, slippage: '0.05' };
  let body: unknown;
  if (target.hostname === 'aggregator-api.kyberswap.com' && target.pathname === '/arbitrum/api/v1/routes' && p.get('tokenOut') === ARB_ADDRESS) {
    const amountIn = p.get('amountIn')!;
    body = { code: 0, data: { routeSummary: { amountIn, amountOut: String(BigInt(amountIn) * 10n ** 13n),
      tokenIn: p.get('tokenIn'), tokenOut: ARB_ADDRESS, gas: '3', gasUsd: '0.3', amountInUsd: String(Number(amountIn) / 1e6), timestamp: Math.floor(now() / 1000) } } };
  } else if (target.hostname === 'aggregator-api.kyberswap.com' && target.pathname.endsWith('/route/build')) {
    const { routeSummary } = JSON.parse(String(init.body));
    body = { code: 0, data: { routerAddress: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', amountIn: routeSummary.amountIn,
      transactionValue: '0', data: '0x12345678' + BigInt(routeSummary.amountOut).toString(16).padStart(64, '0') } };
  } else if (target.hostname === 'arb1.arbitrum.io') {
    const req = JSON.parse(String(init.body));
    const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
    if (req.method === 'eth_simulateV1') {
      const calls = req.params[0].blockStateCalls[0].calls, paid = BigInt('0x' + calls[2].data.slice(-64)), bought = BigInt('0x' + calls[3].data.slice(-64));
      const values = [paid, 0n, 1n, 0n, 0n, bought, 0n, 1n, bought, 0n];
      body = { id: 1, jsonrpc: '2.0', result: [{ number: '0x124', parentHash: word(42n),
        calls: values.slice(0, calls.length).map(n => ({ status: '0x1', returnData: word(n), gasUsed: '0x1' })) }] };
    } else body = { id: 1, jsonrpc: '2.0', result: word(req.params[0].data === '0x0f28c97d' ? BigInt(Math.floor(now() / 1000)) : 18n) };
  } else if (target.pathname.endsWith('/spot/currencies')) {
    body = [arb];
  } else if (target.pathname.endsWith('/spot/currency_pairs')) {
    body = [spot];
  } else if (target.pathname.endsWith('/futures/usdt/tickers')) {
    body = [{ contract: 'ARB_USDT' }];
  } else if (target.pathname.endsWith('/currencies/ARB')) {
    body = arb;
  } else if (target.pathname.endsWith('/currency_pairs/ARB_USDT')) {
    body = spot;
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
