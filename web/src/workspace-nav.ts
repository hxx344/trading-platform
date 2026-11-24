// The side navigation groups the pages by the workspaces of the workbench's unified platform plan (section 2,
// docs/unified-platform-plan.md 2f1fc93), in its order, the way the workbench's src/workspace-nav.ts (4f65366) does.
// It only decides where an entry sits: the addresses and the data each page reads stay as they were.
// Kept free of the DOM so the server-side tests can import it.
import type { Route } from './route-parse.ts';

export type WorkspaceId = 'overview' | 'market' | 'trading' | 'strategy' | 'options' | 'onchain' | 'research' | 'system';

export const workspaceOrder: readonly WorkspaceId[] = ['overview', 'market', 'trading', 'strategy', 'options', 'onchain', 'research', 'system'];

export const workspaceLabels: Record<WorkspaceId, string> = {
  overview: '总览与资产', market: '市场与机会', trading: '交易中心', strategy: '策略与风险',
  options: '期权', onchain: '链上', research: '研究室', system: '系统',
};

export type NavEntry = 'asset' | 'positions' | 'monitor' | 'news' | 'oil' | 'hynix' | 'goldoil' | 'crossex' | 'ondo' | 'varlighter' | 'pairs' | 'mev' | 'options' | 'status' | 'logs' | 'settings';

/** Every entry of the side navigation, in its order inside the workspace. A new page is registered here. */
export const navEntries: Record<NavEntry, { workspace: WorkspaceId; text: string; href: string }> = {
  asset: { workspace: 'overview', text: '资产', href: '#/asset' },
  // 持仓页（A-5）：资产账本已连接账户的持仓，只读；与资产页同条件显示。
  positions: { workspace: 'overview', text: '持仓', href: '#/positions' },
  monitor: { workspace: 'market', text: '行情监控', href: '#/monitor' },
  // EQN 快讯（docs/news.md）：/api/news 有应答时显示（config.json 写了 "news": false 时没有）。
  news: { workspace: 'market', text: '快讯', href: '#/news' },
  oil: { workspace: 'trading', text: '原油', href: '#/oil' },
  hynix: { workspace: 'trading', text: '海力士', href: '#/hynix' },
  // 金油（docs/goldoil.md）：与原油共用执行账户，与海力士同条件显示。
  goldoil: { workspace: 'trading', text: '金油', href: '#/goldoil' },
  crossex: { workspace: 'trading', text: 'CrossEx', href: '#/crossex' },
  ondo: { workspace: 'trading', text: 'Ondo 挂单奖励', href: '#/ondo' },
  // Var/Lighter 价差回归（docs/varlighter.md）：config.json 写了 "varLighter": false 时没有。
  varlighter: { workspace: 'trading', text: 'Var/Lighter 价差', href: '#/varlighter' },
  pairs: { workspace: 'strategy', text: '配对组', href: '#/' },
  options: { workspace: 'options', text: '期权', href: '#/options' },
  // MEV 套利（docs/mev.md）：config.json 有 mev 时显示。
  mev: { workspace: 'onchain', text: 'MEV 套利', href: '#/mev' },
  status: { workspace: 'system', text: '运行状态', href: '#/status' },
  logs: { workspace: 'system', text: '日志', href: '#/logs' },
  settings: { workspace: 'system', text: '设置', href: '#/settings' },
};

/** The entry a route belongs to: the pair views sit under 配对组, every options tab under 期权, every CrossEx tab under CrossEx. */
export function entryOf(route: Route): NavEntry {
  switch (route.page) {
    case 'overview': case 'pair': return 'pairs';
    default: return route.page;
  }
}

export type WorkspaceGroup = { id: WorkspaceId; label: string; entries: NavEntry[] };

/** The groups to show for the entries this service has; a workspace with no entry is left out, as in the workbench. */
export function workspaceGroups(available: ReadonlySet<NavEntry>): WorkspaceGroup[] {
  const entries = (Object.keys(navEntries) as NavEntry[]).filter(entry => available.has(entry));
  return workspaceOrder
    .map(id => ({ id, label: workspaceLabels[id], entries: entries.filter(entry => navEntries[entry].workspace === id) }))
    .filter(group => group.entries.length > 0);
}

/** The breadcrumb of the topbar: the workspace, then the page. */
export function breadcrumbOf(route: Route): { workspace: string; page: string } {
  const entry = navEntries[entryOf(route)];
  return { workspace: workspaceLabels[entry.workspace], page: entry.text };
}
