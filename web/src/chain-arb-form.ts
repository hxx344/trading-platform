import { parseChainArb, type Chain, type ChainArbView } from '../../src/chain-arb/model.ts';

export const chainNames: Record<Chain, string> = {
  ethereum: 'Ethereum', arbitrum: 'Arbitrum One', bsc: 'BNB Smart Chain',
};

export const initialChainArbForm = {
  chain: 'arbitrum', symbol: 'ARB',
  // Arbitrum DAO's Arb One deployment: https://docs.arbitrum.foundation/deployment-addresses
  address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '', perpCosts: '',
};
export type ChainArbForm = typeof initialChainArbForm;

export function chainArbQuery(form: ChainArbForm) {
  const fields = Object.fromEntries(Object.entries(form).map(([name, value]) => [name, value.trim()]));
  fields.symbol = form.symbol.trim().toUpperCase();
  const input = parseChainArb(fields);
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(input)) {
    if (value !== null) params.set(name, String(value));
  }
  return { input, path: '/api/monitor/perpetual/chain-arb?' + params };
}

/** Charge the whole round trip against the server's remaining lifetime, on the browser's monotonic clock. */
export async function readTimedChainArb(read: () => Promise<ChainArbView>, now = () => performance.now()) {
  const startedAt = now();
  const view = await read();
  return { view, deadline: startedAt + (view.expiresAt - view.asOf) };
}
