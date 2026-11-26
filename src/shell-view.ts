/** Browser navigation and the public collectors whose display data can outlive a page. */
export const shellMarkets = ['anthropic', 'oil', 'goldoil', 'hynix', 'perpetual'] as const;
export type ShellMarket = typeof shellMarkets[number];
export type MarketScope = { enabled: boolean; revision: number | null };
export type MonitorScopes = Partial<Record<ShellMarket, MarketScope>>;

export interface ShellView {
  generation: number;
  retired: boolean;
  transport: 'simulated' | 'live';
  modules: Record<'oil' | 'options' | 'asset' | 'crossex' | 'ondo' | 'news' | 'varlighter' | 'mev' | 'fundingbook', boolean>;
  monitor: MonitorScopes | null;
}

export function monitorScopes(state: { markets: readonly string[]; controls?: Partial<Record<ShellMarket, { enabled: boolean; revision: number }>> } | undefined): MonitorScopes | null {
  if (!state) return null;
  const scopes: MonitorScopes = {};
  for (const market of shellMarkets) {
    if (state.markets.includes(market)) {
      const control = state.controls?.[market];
      scopes[market] = { enabled: control?.enabled ?? true, revision: control?.revision ?? null };
    }
  }
  return scopes;
}
