// The import panel's choices as the page request and the question before it (web/src/import-form.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsAvailable, assetAvailable, confirmText, defaultAssetOwner, importBody, monitorAvailable, restarts, type AssetItem, type ImportChoices, type MonitorAlertsItem, type MonitorItem } from '../web/src/import-form.ts';
import { parseImportBody } from '../src/service/import-channel.ts';

const NONE: ImportChoices = { pairs: [], oil: [], options: null, monitor: false, monitorAlerts: null, assetOwner: null };
const owner = (name: string, importable = true) => ({ owner: name, assets: 1, snapshots: 1, lastDaily: null, importable, detail: '' });
const asset = (owners: ReturnType<typeof owner>[], enabled = false): AssetItem => ({ status: 'skipped', enabled, owner: null, ledger: '/wb/modules/asset/ledger.sqlite', owners, more: 0, last: null, lastProblem: null, detail: '' });

test('导入面板：勾选项转成页面请求，服务端校验照单接受；什么都没勾时不发', () => {
  assert.equal(importBody(NONE), null);
  const all: ImportChoices = { pairs: ['p1'], oil: ['Binance ***1234'], options: 'Bybit ***9999', monitor: true, monitorAlerts: { tiers: 2, robot: true, robotChanges: true }, assetOwner: 'alice' };
  const body = importBody(all)!;
  assert.deepEqual(body, { action: 'import', pairs: ['p1'], oil: true, options: true, monitor: true, monitorAlerts: true, asset: true, assetOwner: 'alice' });
  assert.deepEqual(parseImportBody(body), body);
  for (const only of [{ monitor: true }, { assetOwner: 'bob' }, { monitorAlerts: { tiers: 1, robot: false, robotChanges: false } }] as Partial<ImportChoices>[]) {
    const single = importBody({ ...NONE, ...only })!;
    assert.deepEqual(parseImportBody(single), single, JSON.stringify(only));
  }
});

test('导入面板：只有一个可导入的用户时默认选中；行情监控只在可启用时可勾选', () => {
  assert.equal(defaultAssetOwner(asset([owner('alice')])), 'alice');
  assert.equal(defaultAssetOwner(asset([owner('alice'), owner('bob', false)])), 'alice');
  assert.equal(defaultAssetOwner(asset([owner('alice'), owner('bob')])), null);
  assert.equal(defaultAssetOwner(undefined), null);
  assert.equal(assetAvailable(asset([owner('alice', false)])), false);
  assert.equal(assetAvailable(asset([owner('alice')])), true);
  assert.equal(monitorAvailable({ status: 'skipped', enabled: true, shares: { outstanding: 12.7, diluted: 16.7 }, workbench: false, detail: '' }), false);
});

test('导入面板：只重新导入已启用的资产账本时不重启，确认文字说明替换与失败行为', () => {
  const ledgerOnly = { ...NONE, assetOwner: 'alice' };
  assert.equal(restarts(ledgerOnly, true), false);
  assert.match(confirmText(ledgerOnly, true), /^重新导入资产账本（用户 alice）？整体替换.*不重启服务/);
  assert.equal(restarts(ledgerOnly, false), true);
  assert.match(confirmText(ledgerOnly, false), /^导入 资产账本（用户 alice） 并重启本服务？.*已写入的账本保留/);
  const mixed = confirmText({ ...NONE, pairs: ['p1', 'p2'], oil: ['Binance ***1234'], monitor: true }, false);
  assert.match(mixed, /^导入 p1、p2 与 原油执行账户（Binance \*\*\*1234） 与 行情监控 并重启本服务？/);
  assert.match(mixed, /导入的配对登记为停用。.*名义金额上限.*公开行情（不需要密钥）/);
});

const monitorItem = (status: 'added' | 'skipped', enabled: boolean): MonitorItem => ({ status, enabled, shares: { outstanding: 12.7, diluted: 16.7 }, workbench: true, detail: '' });
const alertsItem = (status: 'added' | 'skipped'): MonitorAlertsItem => ({ status, markets: [], robot: { imported: true, problem: null, replaces: false, changes: true }, detail: '' });

test('导入面板：告警只在行情监控已启用或同时勾选启用时可勾，请求总带上 monitor', () => {
  assert.equal(alertsAvailable(alertsItem('added'), monitorItem('skipped', true), false), true, '已启用');
  assert.equal(alertsAvailable(alertsItem('added'), monitorItem('added', false), false), false, '未勾选启用');
  assert.equal(alertsAvailable(alertsItem('added'), monitorItem('added', false), true), true, '同时启用');
  assert.equal(alertsAvailable(alertsItem('added'), monitorItem('added', true), false), false, '已启用但这次会补上市场：须同时勾选，否则请求带 monitor 却说不重启');
  assert.equal(alertsAvailable(alertsItem('added'), monitorItem('added', true), true), true, '补上市场并同时勾选');
  assert.equal(alertsAvailable(alertsItem('skipped'), monitorItem('skipped', true), false), false, '没有可导入的');
  const body = importBody({ ...NONE, monitorAlerts: { tiers: 1, robot: true, robotChanges: false } })!;
  assert.deepEqual(body, { action: 'import', pairs: [], monitor: true, monitorAlerts: true });
  assert.throws(() => parseImportBody({ action: 'import', pairs: [], monitorAlerts: true }), /须和 monitor 一起使用/);
});

test('导入面板：只导入档位（机器人不变）时不重启；机器人要改时重启并说明', () => {
  const tiersOnly = { ...NONE, monitorAlerts: { tiers: 2, robot: true, robotChanges: false } };
  assert.equal(restarts(tiersOnly, false), false);
  assert.match(confirmText(tiersOnly, false), /^重新导入行情告警？导入的告警档位替换本服务现有.*10 秒内换上.*配置不变，不重启服务。$/);
  const withLedger = confirmText({ ...tiersOnly, assetOwner: 'alice' }, true);
  assert.match(withLedger, /^重新导入资产账本（用户 alice） 与 行情告警？整体替换本服务现有的资产账本；导入的告警档位/);
  const robot = { ...NONE, monitorAlerts: { tiers: 0, robot: true, robotChanges: true } };
  assert.equal(restarts(robot, false), true);
  const text = confirmText(robot, false);
  assert.match(text, /^导入 行情告警与机器人 并重启本服务？/);
  assert.match(text, /改发工作台行情监控的机器人（secrets\.json 的 feishuMonitor）/);
  assert.doesNotMatch(text, /替换本服务现有的原油/, '没有档位时不提档位');
});
