import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectPerpetualImport, stagePerpetualImport } from '../src/service/import-perpetual-settings.ts';
import { parseImportBody } from '../src/service/import-channel.ts';

function fixture(t: { after(callback: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'tp-perpetual-import-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, 'service'), source = join(root, 'modules', 'monitor', 'perpetual');
  mkdirSync(data); mkdirSync(source, { recursive: true });
  const alerts = { version: 1, revision: 3, config: { enabled: false, rules: [] }, ruleStates: {}, history: [] };
  const filter = { version: 1, revision: 4, config: { requireSpotTransfer: true, blockedBases: ['ETH'] } };
  writeFileSync(join(source, 'opportunity-alerts.json'), JSON.stringify(alerts));
  writeFileSync(join(source, 'crossex-settings.json'), JSON.stringify(filter));
  return { root, data, source, alerts, filter };
}

test('合约价差导入预览只读，两类设置均可交接；载入中和正式设置优先', t => {
  const { root, data, alerts, filter } = fixture(t);
  const pending = join(data, 'perpetual-alerts.import.json'), filterPending = join(data, 'perpetual-crossex-settings.import.json');
  const { preview, states } = inspectPerpetualImport(root, data);
  assert.equal(preview.available, true);
  assert.equal(existsSync(pending) || existsSync(filterPending), false);
  assert.equal(stagePerpetualImport(data, states).length, 2);
  assert.deepEqual(JSON.parse(readFileSync(pending, 'utf8')), alerts);
  assert.deepEqual(JSON.parse(readFileSync(filterPending, 'utf8')), filter);
  if (process.platform !== 'win32') assert.equal(statSync(pending).mode & 0o777, 0o600);
  renameSync(pending, join(data, 'perpetual-alerts.import.loading.json'));
  renameSync(filterPending, join(data, 'perpetual-crossex-settings.json'));
  assert.equal(inspectPerpetualImport(root, data).preview.available, false);
  assert.ok(stagePerpetualImport(data, states).every(line => line.includes('保留现有设置')));
  assert.equal(existsSync(pending) || existsSync(filterPending), false);
});

test('无效或过大的来源只跳过相应设置，导入必须明确选择行情监控', t => {
  const { root, data, source } = fixture(t);
  writeFileSync(join(source, 'crossex-settings.json'), 'x'.repeat(16_385));
  const partial = inspectPerpetualImport(root, data);
  assert.deepEqual(Object.keys(partial.states), ['alerts']);
  assert.match(partial.preview.details.join(' '), /格式无效/);
  assert.equal(parseImportBody({ action: 'import', pairs: [], monitor: true, monitorSettings: true }).monitorSettings, true);
  assert.throws(() => parseImportBody({ action: 'import', pairs: [], monitorSettings: true }));
});

test('来源的中间目录须为普通目录，迁移不跟随目录链接', t => {
  const { root, data } = fixture(t);
  const modules = join(root, 'modules'), moved = join(root, 'saved-modules');
  renameSync(modules, moved);
  symlinkSync(moved, modules, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inspectPerpetualImport(root, data), /符号链接或非目录/);
});
