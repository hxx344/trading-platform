// The page's views live in the address hash (#/pair/<pair>, #/status, #/logs, #/settings, #/oil, #/hynix, #/goldoil, #/options[/positions|/orders|/performance|/rfq], #/monitor, #/asset, #/positions, #/crossex[/trade|/hedge|/orders|/settings], #/ondo, #/news, #/varlighter[/detail[/<场所:代码|场所:代码[@乘数]>]|/accounts|/ready], #/mev[/opportunities|/transactions|/pools|/settings], #/fundingbook[/plan|/paper|/settings]), so a reload or a shared
// link opens the same view. Kept free of the DOM so the server-side tests can import it.
export type Route = { page: 'overview' } | { page: 'pair'; pairId: string | null } | { page: 'status' } | { page: 'logs' } | { page: 'settings' } | { page: 'oil' } | { page: 'hynix' } | { page: 'goldoil' } | { page: 'options'; tab: 'desk' | 'positions' | 'orders' | 'performance' | 'rfq' } | { page: 'monitor' } | { page: 'asset' } | { page: 'positions' } | { page: 'crossex'; tab: CrossexTab } | { page: 'ondo' } | { page: 'news' } | { page: 'varlighter'; tab: VarLighterTab; symbol: string | null } | { page: 'mev'; tab: MevTab } | { page: 'chain-arb' } | { page: 'fundingbook'; tab: FundingBookTab };
export type FundingBookTab = 'overview' | 'plan' | 'paper' | 'settings';
const FUNDINGBOOK_TABS: readonly FundingBookTab[] = ['plan', 'paper', 'settings'];
export type MevTab = 'overview' | 'opportunities' | 'transactions' | 'pools' | 'settings';
const MEV_TABS: readonly MevTab[] = ['opportunities', 'transactions', 'pools', 'settings'];
export type VarLighterTab = 'overview' | 'detail' | 'accounts' | 'ready';
export type CrossexTab = 'positions' | 'trade' | 'hedge' | 'orders' | 'settings';
const CROSSEX_TABS: readonly CrossexTab[] = ['trade', 'hedge', 'orders', 'settings'];
const PAIR_ID = /^[0-9A-Za-z_-]{1,64}$/;

export function parseRoute(hash: string): Route {
  if (hash === '#/status') return { page: 'status' };
  if (hash === '#/logs') return { page: 'logs' };
  if (hash === '#/settings') return { page: 'settings' };
  if (hash === '#/oil') return { page: 'oil' };
  if (hash === '#/hynix') return { page: 'hynix' };
  if (hash === '#/goldoil') return { page: 'goldoil' };
  if (hash === '#/monitor') return { page: 'monitor' };
  if (hash === '#/asset') return { page: 'asset' };
  if (hash === '#/positions') return { page: 'positions' };
  if (hash === '#/options') return { page: 'options', tab: 'desk' };
  if (hash === '#/options/positions') return { page: 'options', tab: 'positions' };
  if (hash === '#/options/orders') return { page: 'options', tab: 'orders' };
  if (hash === '#/options/performance') return { page: 'options', tab: 'performance' };
  if (hash === '#/options/rfq') return { page: 'options', tab: 'rfq' };
  if (hash === '#/crossex') return { page: 'crossex', tab: 'positions' };
  if (hash === '#/ondo') return { page: 'ondo' };
  if (hash === '#/news') return { page: 'news' };
  if (hash === '#/varlighter') return { page: 'varlighter', tab: 'overview', symbol: null };
  // v0.112.0 去掉了模拟盘页签，旧链接回到总览。
  if (hash === '#/varlighter/paper') return { page: 'varlighter', tab: 'overview', symbol: null };
  if (hash === '#/varlighter/accounts') return { page: 'varlighter', tab: 'accounts', symbol: null };
  if (hash === '#/varlighter/ready') return { page: 'varlighter', tab: 'ready', symbol: null };
  if (hash === '#/varlighter/detail') return { page: 'varlighter', tab: 'detail', symbol: null };
  if (hash.startsWith('#/varlighter/detail/')) {
    let symbol = hash.slice('#/varlighter/detail/'.length);
    try { symbol = decodeURIComponent(symbol); } catch { symbol = ''; }
    // v0.88.0 以前的链接是「rh:AAPL」，即 Var 对该场所的配对。
    const legacy = /^(rh|lighter):([A-Z0-9]{1,20})$/.exec(symbol);
    if (legacy) symbol = `var:${legacy[2]}|${legacy[1]}:${legacy[2]}`;
    return { page: 'varlighter', tab: 'detail', symbol: /^(var|rh|lighter|entropy):[A-Za-z0-9._-]{1,24}\|(var|rh|lighter|entropy):[A-Za-z0-9._-]{1,24}(@\d{1,7}(\.\d{1,10})?)?$/.test(symbol) ? symbol : null };
  }
  if (hash === '#/mev') return { page: 'mev', tab: 'overview' };
  if (hash === '#/chain-arb') return { page: 'chain-arb' };
  if (hash === '#/fundingbook') return { page: 'fundingbook', tab: 'overview' };
  if (hash.startsWith('#/fundingbook/')) { const tab = FUNDINGBOOK_TABS.find(item => hash === `#/fundingbook/${item}`); if (tab) return { page: 'fundingbook', tab }; }
  if (hash.startsWith('#/mev/')) { const tab = MEV_TABS.find(item => hash === `#/mev/${item}`); if (tab) return { page: 'mev', tab }; }
  if (hash.startsWith('#/crossex/')) { const tab = CROSSEX_TABS.find(item => hash === `#/crossex/${item}`); if (tab) return { page: 'crossex', tab }; }
  if (hash === '#/pair' || hash === '#/pair/') return { page: 'pair', pairId: null };
  if (hash.startsWith('#/pair/')) {
    let id: string;
    try { id = decodeURIComponent(hash.slice(7)); } catch { return { page: 'pair', pairId: null }; }
    return { page: 'pair', pairId: PAIR_ID.test(id) ? id : null };
  }
  return { page: 'overview' };
}
export const pairHref = (pairId: string): string => `#/pair/${encodeURIComponent(pairId)}`;
