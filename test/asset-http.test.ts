// The /api/asset/* reads over HTTP: behind the login, absent without asset, the reader's answers passed through, and
// the service wiring that opens <data-dir>/asset.sqlite when config.json has `asset`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer, type ServiceViews } from '../src/http.ts';
import { ASSET_DB_FILE } from '../src/asset/db.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore } from '../src/asset/store.ts';
import { parseServiceConfig } from '../src/service/config.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { FakeAster } from './aster-fake.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const TOKEN = 'asset-access-token-0001';
const SESSION = 'asset-session-value-0001';
const NOW = Date.parse('2026-11-10T04:00:00Z');
const PATHS = ['/api/asset/state', '/api/asset/ledger', '/api/asset/history', '/api/asset/daily-changes', '/api/asset/withdrawals', '/api/asset/cash-flows', '/api/asset/period?id=P1'];

async function withServer(views: ServiceViews | undefined, run: (get: (path: string, cookie?: boolean) => Promise<Response>) => Promise<void>) {
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, ...(views ? { views } : {}) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    await run((path, withCookie = true) => fetch(base + path, withCookie ? { headers: { cookie } } : {}));
  } finally { await new Promise(resolve => server.close(resolve)); h.dispose(); }
}

function imported() {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-http-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data');
  writeWorkbenchLedger(from, { now: NOW });
  importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
  const reader = createAssetStore(join(dataDir, ASSET_DB_FILE), { now: () => NOW });
  return { reader, done: () => { reader.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('资产接口：须登录；服务没有 asset 时 404', () => withServer(undefined, async get => {
  for (const path of PATHS) assert.equal((await get(path, false)).status, 401, path);
  for (const path of PATHS) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(((await response.json()) as { message: string }).message, '本服务没有配置资产账本');
  }
}));

test('资产接口：未导入时 200 与空数据，导入后给出账本；期次编号无效 400、不存在 404', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-http-empty-'));
  const empty = createAssetStore(join(root, ASSET_DB_FILE), { now: () => NOW });
  try {
    await withServer({ asset: empty }, async get => {
      for (const path of PATHS) {
        const response = await get(path);
        assert.equal(response.status, 200, path);
        assert.equal(((await response.json()) as { imported: boolean }).imported, false, path);
      }
    });
  } finally { empty.close(); rmSync(root, { recursive: true, force: true }); }
  const w = imported();
  try {
    await withServer({ asset: w.reader }, async get => {
      const state = await (await get('/api/asset/state')).json() as { imported: boolean; assets: number; source: { owner: string } };
      assert.deepEqual([state.imported, state.assets, state.source.owner], [true, 6, OWNER]);
      const ledger = await (await get('/api/asset/ledger')).json() as { rows: unknown[]; summary: { valuation: { total: number } } };
      assert.equal(ledger.rows.length, 7);
      assert.equal(ledger.summary.valuation.total, 24_250);
      assert.equal(((await (await get('/api/asset/period?id=P1')).json()) as { rows: unknown[] }).rows.length, 6);
      for (const id of ['', '../x', 'a b', 'x'.repeat(81)]) assert.equal((await get(`/api/asset/period?id=${encodeURIComponent(id)}`)).status, 400, id);
      for (const id of ['P9', 'daily-2030-01-01']) assert.equal((await get(`/api/asset/period?id=${id}`)).status, 404, id);
      assert.equal((await get('/api/asset/other')).status, 404);
    });
  } finally { w.done(); }
});

test('资产接口：读取失败时 500 asset_unreadable 并带原因', async () => {
  const failing = { ...createAssetStore(join(tmpdir(), 'tp-asset-none', ASSET_DB_FILE)), ledger: async () => { throw new Error('database disk image is malformed'); } };
  await withServer({ asset: failing }, async get => {
    const response = await get('/api/asset/ledger');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { code: 'asset_unreadable', message: '资产账本读取失败：database disk image is malformed' });
    assert.equal((await get('/api/asset/state')).status, 200);
  });
});

// The service holds per-account process locks that exist on Linux only (live/setup.ts).
test('服务进程：配置了 asset 时读数据目录里的 asset.sqlite，导入后无需重启', { skip: process.platform !== 'linux' && '服务进程只在 Linux 上运行' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-asset-service-'));
  const fake = new FakeAster();
  const { createServer } = await import('node:net');
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const { startService } = await import('../src/service/main.ts');
  const app = { index: Buffer.from('<!doctype html><title>统一交易平台</title><script type="module" src="/assets/app-1.js"></script>'), assets: new Map([['app-1.js', { body: Buffer.from('void 0;'), type: 'text/javascript; charset=utf-8' }]]) };
  const data = join(dir, 'data');
  try {
    const run = await startService({ config: parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', asset: {} }), secrets: { accounts: new Map(), feishu: null }, dir: data, port, fetchImpl: fake.fetch, app });
    try {
      let link = '';
      for (let i = 0; i < 100 && !link; i++) { try { link = readFileSync(join(data, 'access-url'), 'utf8').trim().split('\n').at(-1)!; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
      const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
      const state = async () => await (await fetch(`http://127.0.0.1:${port}/api/asset/state`, { headers: { cookie } })).json() as { imported: boolean; assets: number };
      assert.equal((await state()).imported, false);
      const from = join(dir, 'ledger.sqlite');
      writeWorkbenchLedger(from, { now: NOW });
      importLedger({ from, owner: OWNER, dataDir: data, now: () => NOW });
      assert.deepEqual(await state(), { ...(await state()), imported: true, assets: 6 });
    } finally { await run.shutdown(); await run.done; }
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});
