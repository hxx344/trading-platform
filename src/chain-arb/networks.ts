export const networks = {
  ethereum: { usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6, rpc: 'https://ethereum-rpc.publicnode.com' },
  arbitrum: { usdt: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6, rpc: 'https://arb1.arbitrum.io/rpc' },
  bsc: { usdt: '0x55d398326f99059ff775485246999027b3197955', decimals: 18, rpc: 'https://bsc-dataseed.bnbchain.org' },
} as const;

export function isSettlementOrNative(chain: keyof typeof networks, address: string): boolean {
  return address.toLowerCase() === networks[chain].usdt || /^0x(?:0{40}|e{40})$/i.test(address);
}
