// The import panel's choices as the page request and the question before it (web/src/import-form.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetAvailable, confirmText, defaultAssetOwner, importBody, monitorAvailable, restarts, type AssetItem, type ImportChoices } from '../web/src/import-form.ts';
import { parseImportBody } from '../src/service/import-channel.ts';

const NONE: ImportChoices = { pairs: [], oil: [], options: null, monitor: false, assetOwner: null };
const owner = (name: string, importable = true) => ({ owner: name, assets: 1, snapshots: 1, lastDaily: null, importable, detail: '' });
const asset = (owners: ReturnType<typeof owner>[], enabled = false): AssetItem => ({ status: 'skipped', enabled, owner: null, ledger: '/wb/modules/asset/ledger.sqlite', owners, more: 0, last: null, lastProblem: null, detail: '' });

test('导入面板：勾选项转成页面请求，服务端校验照单接受；什么都没勾时不发', () => {
  assert.equal(importBody(NONE), null);
  const all: ImportChoices = { pairs: ['p1'], oil: ['Binance ***1234'], options: 'Bybit ***9999', monitor: true, assetOwner: 'alice' };
  const body = importBody(all)!;
  assert.deepEqual(body, { action: 'import', pairs: ['p1'], oil: true, options: true, monitor: true, asset: true, assetOwner: 'alice' });
  assert.deepEqual(parseImportBody(body), body);
  for (const only of [{ monitor: true }, { assetOwner: 'bob' }] as Partial<ImportChoices>[]) {
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
