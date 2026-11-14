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

export type NavEntry = 'asset' | 'monitor' | 'oil' | 'crossex' | 'pairs' | 'options' | 'status' | 'logs' | 'settings';

/** Every entry of the side navigation, in its order inside the workspace. A new page is registered here. */
export const navEntries: Record<NavEntry, { workspace: WorkspaceId; text: string; href: string }> = {
  asset: { workspace: 'overview', text: '资产', href: '#/asset' },
  monitor: { workspace: 'market', text: '行情监控', href: '#/monitor' },
  oil: { workspace: 'trading', text: '原油', href: '#/oil' },
  crossex: { workspace: 'trading', text: 'CrossEx', href: '#/crossex' },
  pairs: { workspace: 'strategy', text: '配对组', href: '#/' },
  options: { workspace: 'options', text: '期权', href: '#/options' },
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
