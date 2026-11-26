import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { exportPreferences, importPreferences, previewPreferences, workbenchPreferenceScript, preferenceBackupLimit } from '../../src/perpetual-preferences-transfer.ts';

const prefix = 'market-monitor:perpetual';
const json = JSON.stringify;
const saved = {
  [prefix + ':v1']: json({ version: 2, search: 'BTC', favoritesOnly: true, favorites: ['BTC'], favoritePairs: [json(['BTC', 'bybit:BTCUSDT', 'gate:BTCUSDT'])], blockedPairs: [json(['ETH', 'bybit:ETHUSDT', 'gate:ETHUSDT'])] }),
  [prefix + '-manual-pairs:v1']: json({ version: 1, pairs: [{ id: 'pair', first: 'bybit:1000PEPE', second: 'gate:PEPE', firstFactor: 1000, secondFactor: 1 }] }),
  [prefix + '-scanner:v1']: json({ version: 3, categories: ['crypto'], columns: ['pair'], groupByBase: false }),
  [prefix + '-scanner-ranges:v1']: json({ spread: { min: '0.20', max: '0.90' } }),
  [prefix + '-scanner-sort:v1']: 'null',
  [prefix + '-capital-assumptions:v1']: json({ longLeverage: 4, shortLeverage: 6, marginBufferPercent: 10, holdingHours: 12 }),
  [prefix + '-principal:v1']: json({ version: 1, principal: 22000 }),
  [prefix + '-quality-budget:v1']: json({ version: 2, takerOverrides: { bybit: 0.1 }, slippagePercent: 0 }),
};
function store(entries = {}) {
  const data = new Map(Object.entries(entries)), reads = [];
  return { data, reads, getItem(key) { reads.push(key); return data.get(key) ?? null; }, setItem(key, value) { data.set(key, value); }, removeItem(key) { data.delete(key); } };
}

test('旧工作台只读导出与本站导出兼容，八项偏好立即可按原有格式恢复', () => {
  const old = store({ ...saved, secret: 'outside' });
  let backup;
  runInNewContext(workbenchPreferenceScript, { localStorage: old, copy: text => { backup = text; } });
  assert.deepEqual(old.reads.sort(), Object.keys(saved).sort());
  assert.equal(backup, exportPreferences(old));
  assert.ok(!backup.includes('outside'));
  const target = store(), preview = previewPreferences(backup, target);
  assert.equal(preview.length, 8);
  assert.equal(importPreferences(preview, false, target).length, 8);
  const get = suffix => JSON.parse(target.data.get(prefix + suffix));
  assert.deepEqual(get(':v1').favoritePairs, JSON.parse(saved[prefix + ':v1']).favoritePairs);
  assert.deepEqual(get(':v1').blockedPairs, JSON.parse(saved[prefix + ':v1']).blockedPairs);
  assert.equal(get('-manual-pairs:v1').pairs[0].firstFactor, 1000);
  assert.equal(get('-scanner:v1').groupByBase, false); assert.equal(get('-scanner-ranges:v1').spread.min, '0.20');
  assert.equal(get('-capital-assumptions:v1').shortLeverage, 6); assert.equal(get('-principal:v1').principal, 22000);
  assert.equal(get('-quality-budget:v1').takerOverrides.bybit, 0.1);
  assert.equal(get('-scanner-sort:v1'), null);
  assert.ok(previewPreferences(backup, target).every(item => item.same));
});

test('保留本机偏好，明确覆盖、并发变更和部分写入失败均可区分', () => {
  const principal = prefix + '-principal:v1', sort = prefix + '-scanner-sort:v1';
  const target = store({ [principal]: json({ version: 1, principal: 17000 }) });
  const backup = exportPreferences(store({ [sort]: 'null', [principal]: saved[principal] }));
  const preview = previewPreferences(backup, target);
  assert.deepEqual(importPreferences(preview, false, target).map(x => x.key), [sort]);
  assert.equal(JSON.parse(target.data.get(principal)).principal, 17000);
  const conflict = previewPreferences(backup, target);
  target.setItem(principal, json({ version: 1, principal: 38000 }));
  assert.throws(() => importPreferences(conflict, true, target), /其他页面/);
  assert.equal(JSON.parse(target.data.get(principal)).principal, 38000);
  importPreferences(previewPreferences(backup, target), true, target);
  assert.equal(JSON.parse(target.data.get(principal)).principal, 22000);
  const full = store(), change = previewPreferences(backup, full), write = full.setItem;
  full.setItem = (k, v) => { if (k === principal) throw new Error('quota'); write(k, v); };
  assert.throws(() => importPreferences(change, true, full), /quota/);
  assert.equal(full.data.size, 0);
});

test('超限、未知键和损坏的规则集在写入前拒绝', () => {
  const dest = store();
  const pack = entries => json({ format: 'perpetual-browser-preferences/v1', entries });
  for (const text of ['{', pack({}), pack({ constructor: '{}' }), pack({ token: '"fake"' }), pack({ [prefix + ':v1']: '[]' }),
    pack({ [prefix + ':v1']: '{"version":4}' }), pack({ [prefix + '-manual-pairs:v1']: '{"version":1,"pairs":["bad"]}' }), 'x'.repeat(preferenceBackupLimit + 1)]) {
    assert.throws(() => previewPreferences(text, dest));
  }
  assert.equal(dest.data.size, 0);
});
