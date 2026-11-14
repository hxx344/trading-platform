// The side navigation's grouping (web/src/workspace-nav.ts): every address lands on one entry, the groups follow the
// unified platform plan's order and leave out workspaces with no entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute } from '../web/src/route-parse.ts';
import { breadcrumbOf, entryOf, navEntries, workspaceGroups, workspaceOrder, type NavEntry } from '../web/src/workspace-nav.ts';

test('every address keeps its entry and gets the workspace of the plan', () => {
  const cases: [string, NavEntry, string][] = [
    ['', 'pairs', '策略与风险'], ['#/', 'pairs', '策略与风险'], ['#/pair/xau', 'pairs', '策略与风险'], ['#/pair/', 'pairs', '策略与风险'],
    ['#/asset', 'asset', '总览与资产'], ['#/monitor', 'monitor', '市场与机会'], ['#/oil', 'oil', '交易中心'],
    ['#/options', 'options', '期权'], ['#/options/rfq', 'options', '期权'], ['#/options/performance', 'options', '期权'],
    ['#/status', 'status', '系统'], ['#/logs', 'logs', '系统'], ['#/settings', 'settings', '系统'], ['#/unknown', 'pairs', '策略与风险'],
  ];
  for (const [hash, entry, workspace] of cases) {
    const route = parseRoute(hash);
    assert.equal(entryOf(route), entry, hash);
    assert.deepEqual(breadcrumbOf(route), { workspace, page: navEntries[entry].text }, hash);
  }
});

test('entries keep the addresses the pages had before the regrouping', () => {
  for (const [entry, { href }] of Object.entries(navEntries)) assert.equal(entryOf(parseRoute(href)), entry, href);
});

test('groups follow the plan order and leave out workspaces without an entry', () => {
  const all = workspaceGroups(new Set(Object.keys(navEntries) as NavEntry[]));
  assert.deepEqual(all.map(group => group.label), ['总览与资产', '市场与机会', '交易中心', '策略与风险', '期权', '系统']);
  assert.deepEqual(all.at(-1)!.entries, ['status', 'logs', 'settings']);
  assert.deepEqual(all.map(group => group.id), workspaceOrder.filter(id => all.some(group => group.id === id)));
  // A service with only the ASTER pairs (no oil, options, monitor or asset configured).
  const bare = workspaceGroups(new Set<NavEntry>(['pairs', 'status', 'logs', 'settings']));
  assert.deepEqual(bare.map(group => [group.label, group.entries]), [['策略与风险', ['pairs']], ['系统', ['status', 'logs', 'settings']]]);
});
