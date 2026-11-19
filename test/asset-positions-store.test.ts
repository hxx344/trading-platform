// A-5 through the store and the HTTP layer: the positions and fills of the saved connections (positions-service.ts,
// fills-service.ts) on an imported ledger, the cached positions in the daily snapshot (peek, never a read), the fill
// cache cleared on disconnect and dropped on a key change, a file imported before A-5 (no fill_cache table), and the
// GET /api/asset/positions and /api/asset/fills answers (400, 404, 503, no credential in any). Every external read is a
// fake; nothing connects to an exchange.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { ASSET_DB_FILE, openAssetDb, type AssetDb } from '../src/asset/db.ts';
import { CREDENTIAL_KEY_FILE } from '../src/asset/credentials.ts';
import { importLedger } from '../src/asset/import.ts';
import { createAssetStore, type AssetStore, type AssetStoreOptions } from '../src/asset/store.ts';
import type { AssetSources } from '../src/asset/sync.ts';
import { syncBinance } from '../src/asset/sources/exchanges.ts';
import { readFills } from '../src/asset/fills-readers.ts';
import { FILLS_PERMISSION } from '../src/asset/fills-types.ts';
import type { FxStatus } from '../src/asset/types.ts';
import { position } from '../src/asset/positions-values.ts';
import type { PositionsCapture } from '../src/asset/daily-positions.ts';
import type { HubPositions, Position, PositionCycle } from '../src/asset/positions-types.ts';
import type { HubFills, ReadFill } from '../src/asset/fills-types.ts';
import { bindAccounts, createHarness } from './harness.ts';
import { OWNER, writeWorkbenchLedger } from './asset-fixture.ts';

const NOW = Date.parse('2026-11-10T04:00:00Z');
const KEY = 'binance-key-B1N4', SECRET = 'binance-secret-0001';
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const held = (quantity = '1'): Position[] => [position('BTCUSDT', 'long', quantity, 'BTC')];
const oilFill = (id: string, time: number): ReadFill => ({ id, symbol: 'CLUSDT', base: 'CL', time: new Date(time).toISOString(), side: 'buy', positionSide: 'net',
  quantity: '1', quantityUnit: 'CL', price: '70', priceCurrency: 'USDT', fee: '-0.01', feeCurrency: 'USDT', realizedPnl: '0' });
const scopeOf = (report: HubPositions, exchange = 'binance', id = 'um') =>
  report.exchanges.find(item => item.id === exchange)!.accounts[0]!.scopes.find(item => item.id === id)!;
const fillScope = (report: HubFills, exchange = 'binance', id = 'um') =>
  report.exchanges.find(item => item.id === exchange)!.accounts[0]!.scopes.find(item => item.id === id)!;

const sources: Partial<AssetSources> = {
  async quotes() { return {}; },
  async yuanQuote(): Promise<{ rate: number; status: FxStatus }> { return { rate: 7.25, status: { source: 'Frankfurter', fetchedAt: new Date(NOW).toISOString(), rateDate: null, error: null } }; },
  async syncBinance() { return { total: 10, details: [] }; },
};

function world(t: TestContext, options: Omit<AssetStoreOptions, 'now'> = {}, { importIt = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tp-asset-positions-'));
  const from = join(root, 'ledger.sqlite'), dataDir = join(root, 'data'), file = join(dataDir, ASSET_DB_FILE);
  writeWorkbenchLedger(from, { now: NOW });
  if (importIt) {
    importLedger({ from, owner: OWNER, dataDir, now: () => NOW });
    // The ledger opens an existing key here. Creating a durable key is covered separately and needs directory fsync.
    writeFileSync(join(dataDir, CREDENTIAL_KEY_FILE), '1'.repeat(64) + '\n', { mode: 0o600, flag: 'wx' });
    // The fixture's Aster account has an id the workbench never writes (asset-sync.test.ts empties it the same way).
    const database = openAssetDb(file, { mode: 'service' });
    try { database.prepare("UPDATE settings SET value = '[]' WHERE key = 'aster-accounts'").run(); } finally { database.close(); }
  }
  const clock = { at: NOW };
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => { urls.push(String(input)); throw new Error('no network in tests'); }) as typeof fetch;
  const store = createAssetStore(file, { now: () => clock.at, fetch: fetcher, sources, ...options,
    positions: options.positions?.read ? { permission: async () => {}, ...options.positions } : options.positions,
    fills: options.fills?.read ? { permission: async () => {}, ...options.fills } : options.fills });
  const read = <T>(run: (database: AssetDb) => T): T => { const database = openAssetDb(file, { readOnly: true }); try { return run(database); } finally { database.close(); } };
  const fillRows = () => read(database => database.prepare('SELECT account, scope FROM fill_cache ORDER BY scope').rows<{ account: string; scope: string }>());
  const historyCount = () => read(database => database.prepare('SELECT COUNT(*) AS count FROM asset_history_windows').get<{ count: number }>()!.count);
  const seedHistory = () => {
    const db = openAssetDb(file, { mode: 'service' });
    try { db.prepare("INSERT INTO asset_history_windows VALUES('binance','old','pm-um','CLUSDT','trades',1,2,'[]')").run(); }
    finally { db.close(); }
  };
  const latestDaily = () => read(database => JSON.parse(database.prepare("SELECT data FROM snapshots WHERE date GLOB '[0-9]*' ORDER BY date DESC LIMIT 1").get<{ data: string }>()!.data) as Record<string, unknown>);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, file, dataDir, from, store, clock, urls, fillRows, historyCount, seedHistory, latestDaily };
}
async function idle(store: AssetStore, rounds = 20) { for (let i = 0; i < rounds; i++) await settle(); void store; }

test('余额同步的只读拒绝立即关闭已保存账户的历史，候选密钥试连失败保留原账户', async t => {
  let denied = false, hold = false, signal: AbortSignal | undefined;
  const started = deferred(), resume = deferred(), refused = deferred();
  const w = world(t, { sources: { ...sources,
    async quotes() { return { VIRTUAL: { at: new Date(NOW).toISOString(), price: 1, source: 'fixture' } }; }, syncBinance: async c => {
    if (c.apiKey === KEY && !denied) return { total: 10, details: [] };
    try {
      return await syncBinance(c, { USDT: { at: new Date().toISOString(), price: 1, source: 'fixture' } },
        async () => Response.json({ enableReading: true, enableWithdrawals: true }));
    } finally { if (c.apiKey === KEY) refused.resolve(); }
  } }, positions: { permission: async () => { throw new Error('unreachable'); }, read: async () => [] },
    fills: { permission: async (_c, _fetch, shared) => { if (hold) { signal = shared; started.resolve(); await resume.promise; } },
      read: async () => [], fills: async () => [oilFill('1', NOW - 60_000)] } });
  const view = async () => fillScope(await w.store.fills('oil'), 'binance', 'pm-um');
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  await view(); await idle(w.store); assert.equal((await view()).fills[0].price, '70');
  const db = openAssetDb(w.file, { mode: 'service' });
  try {
    db.prepare("INSERT INTO asset_history_windows SELECT account,revision,scope,'CLUSDT','trades',1,2,'[]' FROM fill_cache WHERE account='binance'").run();
  } finally { db.close(); }
  await assert.rejects(w.store.connect({ exchange: 'binance', apiKey: 'candidate-key', apiSecret: 'candidate-secret' }), /只读/);
  assert.equal((await view()).fills[0].price, '70'); assert.ok(w.fillRows().length > 0); assert.ok(w.historyCount() > 0);
  denied = true; hold = true; w.clock.at += 5 * 60_000;
  await view(); await started.promise;
  const syncing = w.store.sync({});
  try {
    await refused.promise; await settle();
    assert.equal(signal?.aborted, true); assert.equal((await view()).error, FILLS_PERMISSION);
  } finally { resume.resolve(); await syncing; }
  await idle(w.store);
  const result = await view();
  assert.equal(result.error, FILLS_PERMISSION); assert.deepEqual(result.fills, []);
  assert.deepEqual(w.fillRows(), []); assert.equal(w.historyCount(), 0);
});

test('成交价格冲突期间的在途权限答复仍属于发起请求的授权', async t => {
  for (const result of ['余额拒权', '持仓拒权', '更换凭据', '原凭据已重新获准'] as const) await t.test(result, async t => {
    const observer = result === '余额拒权' || result === '原凭据已重新获准' ? 'balance' : 'positions';
    const tradeStarted = deferred(), resumeTrade = deferred(), permissionStarted = deferred(), resumePermission = deferred();
    const key = 'test-okx-first', replacement = 'test-okx-second', time = NOW - 2 * 60_000;
    let conflict = false, holdPermission = false, denyNext = false;
    const venue = (reader: 'fills' | 'positions' | 'balance'): typeof fetch => async (input, init) => {
      const url = new URL(String(input)), savedKey = new Headers(init?.headers).get('ok-access-key');
      const answer = (data: unknown[]) => Response.json({ code: '0', data });
      if (url.pathname.endsWith('/config')) {
        if (holdPermission && reader === observer && savedKey === key) {
          holdPermission = false; permissionStarted.resolve(); await resumePermission.promise;
          return answer([{ perm: 'read_only,trade' }]);
        }
        return answer([{ perm: denyNext ? 'read_only,trade' : 'read_only' }]);
      }
      if (url.pathname.endsWith('/asset-valuation')) return answer([{ totalBal: '1', ts: String(Date.now()), details: { funding: '0', trading: '1', earn: '0' } }]);
      if (url.pathname.endsWith('/positions')) return answer([]);
      assert.ok(url.pathname.endsWith('/fills-history'));
      const symbol = url.searchParams.get('instId'), oil = symbol === 'CL-USDT-SWAP';
      if ((!oil && symbol !== 'SKHY-USDT-SWAP') || time < Number(url.searchParams.get('begin')) || time > Number(url.searchParams.get('end') ?? Infinity)) return answer([]);
      let price = savedKey === replacement ? '81' : '80';
      if (conflict && oil && savedKey === key) { tradeStarted.resolve(); await resumeTrade.promise; price = '999'; }
      return answer([{ instId: symbol, billId: oil ? '1' : '2', ts: String(time), side: 'buy', posSide: 'net', fillSz: '1',
        fillPx: price, fillPnl: '0', fee: '-0.1', feeCcy: 'USDT' }]);
    };
    const w = world(t, { fetch: venue('balance'), positions: { fetcher: venue('positions') },
      fills: { fetcher: venue('fills'), fills: (c, scope, request, opts) => readFills(c, scope, request, { ...opts, spacing: false }) },
      sources: { ...sources, async quotes() { return { VIRTUAL: { price: 1, at: new Date(NOW).toISOString(), source: 'fixture' } }; } } });
    const connect = (apiKey: string) => w.store.connect({ exchange: 'okx', apiKey, apiSecret: 'synthetic-secret', passphrase: 'synthetic' });
    const view = async (market: 'oil' | 'hynix') => fillScope(await w.store.fills(market), 'okx', 'SWAP');
    await connect(key);
    for (const market of ['oil', 'hynix'] as const) {
      await view(market); await idle(w.store);
      assert.equal((await view(market)).fills[0]?.price, '80');
    }
    conflict = true; w.clock.at += 5 * 60_000;
    await view('oil'); await tradeStarted.promise;
    holdPermission = true;
    const observation = observer === 'balance' ? w.store.sync({}) : w.store.positions();
    try {
      await permissionStarted.promise; resumeTrade.resolve(); await idle(w.store);
      assert.match((await view('oil')).error!, /冲突/);
      assert.deepEqual(w.fillRows().map(row => row.scope), ['hynix:SWAP']);
      if (result === '更换凭据') {
        await connect(replacement); await view('hynix'); await idle(w.store);
        assert.equal((await view('hynix')).fills[0]?.price, '81');
      } else if (result === '原凭据已重新获准') {
        denyNext = true; w.clock.at += 5_001;
        await w.store.positions(); await idle(w.store);
        assert.equal((await view('hynix')).error, FILLS_PERMISSION);
        denyNext = false; w.clock.at += 60_001;
        await view('hynix'); await idle(w.store);
        assert.equal((await view('hynix')).fills[0]?.price, '80');
      }
    } finally { resumeTrade.resolve(); resumePermission.resolve(); await observation; await idle(w.store); }
    if (result === '更换凭据' || result === '原凭据已重新获准') {
      assert.equal((await view('hynix')).fills[0]?.price, result === '更换凭据' ? '81' : '80');
      assert.ok(w.fillRows().length > 0 && w.historyCount() > 0);
    } else {
      for (const market of ['oil', 'hynix'] as const) {
        const denied = await view(market); assert.equal(denied.error, FILLS_PERMISSION); assert.deepEqual(denied.fills, []);
      }
      assert.deepEqual(w.fillRows(), []); assert.equal(w.historyCount(), 0);
    }
  });
});

test('导入前：持仓与成交全部为未配置，不读取任何连接', async t => {
  const w = world(t, { positions: { read: async () => assert.fail('未导入时不应读取') }, fills: { read: async () => assert.fail('未导入时不应读取') } }, { importIt: false });
  const positions = await w.store.positions();
  assert.ok(positions.exchanges.length > 0);
  for (const exchange of positions.exchanges) for (const account of exchange.accounts) assert.equal(account.configured, false);
  const fills = await w.store.fills('hynix');
  for (const exchange of fills.exchanges) for (const account of exchange.accounts) for (const scope of account.scopes) assert.equal(scope.status, 'unconfigured');
  assert.deepEqual(w.urls, []);
});

test('持仓：用资产已保存的连接只读读取，默认读取经过 store 的 fetch；本轮盈亏随持仓返回；快照经 peek 带上缓存持仓', async t => {
  // Default reader: the store's fetch (a fake) is the one the Binance reader calls; the failure is an error scope, never a live empty one.
  const plain = world(t);
  await plain.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  await plain.store.positions();
  for (let i = 0; i < 50 && plain.urls.length === 0; i++) await settle();
  await idle(plain.store);
  assert.ok(plain.urls.length > 0 && plain.urls.every(url => new URL(url).hostname.endsWith('binance.com')), '读取走注入的 fetch');
  const failed = scopeOf(await plain.store.positions());
  assert.equal(failed.status, 'error'); assert.deepEqual(failed.positions, []);

  const cycles: string[] = [];
  const cycle: PositionCycle = { status: 'complete', since: new Date(NOW - 3_600_000).toISOString(), closedQuantity: '0.5', closePrice: '100', realizedPnl: '2.5',
    fees: '-0.1', funding: '0.05', net: '2.45', currency: 'USDT', note: null, updatedAt: new Date(NOW).toISOString() };
  const w = world(t, { positions: { read: async (credentials, scope) => {
    assert.equal(credentials.exchange, 'binance');
    return scope === 'um' ? held() : [];
  }, cycle: async (_c, scope, request) => { cycles.push(scope + ':' + request.position.symbol); return cycle; } } });
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  const before = w.latestDaily();
  const cold = (before.positions as PositionsCapture).scopes;
  assert.ok(cold.length && cold.every(item => item.status === 'stale' && !item.positions.length), '冷缓存保留未读到的范围');
  const loading = scopeOf(await w.store.positions());
  assert.equal(loading.status, 'loading');
  await idle(w.store);
  let live = scopeOf(await w.store.positions());
  assert.equal(live.status, 'live'); assert.equal(live.positions.length, 1);
  for (let i = 0; i < 50 && !live.positions[0]!.cycle?.realizedPnl; i++) { await settle(); live = scopeOf(await w.store.positions()); }
  assert.deepEqual(cycles, ['um:BTCUSDT']);
  assert.equal(live.positions[0]!.cycle?.net, '2.45');
  // A ledger write takes the cached positions into today's snapshot without reading again.
  w.clock.at += 1000;
  await w.store.editFx({ fx: 7.1 });
  const snapshot = w.latestDaily().positions as { scopes: { exchange: string; scope: string; status: string; positions: { symbol: string; cycle: { net: string } | null }[] }[] };
  const um = snapshot.scopes.find(item => item.exchange === 'binance' && item.scope === 'um')!;
  assert.equal(um.status, 'live');
  assert.deepEqual(um.positions.map(item => [item.symbol, item.cycle?.net]), [['BTCUSDT', '2.45']]);
  assert.equal(JSON.stringify(snapshot).includes(SECRET) || JSON.stringify(snapshot).includes(KEY), false);
});

test('仅刷新资产即可积累套利仓位快照，缺失的一侧保留部分金额', async t => {
  let latest = false, failed = false;
  let sourceAt = NOW;
  const holding = (symbol: string, unrealizedPnl: string): Position => ({ ...position(symbol, 'long', '1', '标的'), unrealizedPnl, pnlCurrency: 'USDC' });
  const w = world(t, {
    sources: { ...sources,
      async quotes() { return { VIRTUAL: { price: 1, at: new Date(sourceAt).toISOString(), source: '替身' } }; },
      async syncBinance() { return { total: 10, details: [{ coin: 'USDC', account: 'USDⓈ-M', quantity: 10, price: 1, value: 10 }] }; },
      async syncHyperliquid() { return { total: 20, details: [], updatedAt: new Date(sourceAt).toISOString() }; },
    },
    positions: { read: async (credentials, scope) => {
      if (credentials.exchange === 'binance') return scope === 'um'
        ? [holding('CLUSDT', latest ? '9' : '4'), holding('ANTHROPICUSDT', latest ? '3' : '0')] : [];
      assert.equal(credentials.exchange, 'hyperliquid');
      if (failed) throw new Error('读仓失败');
      return scope === 'xyz' ? [holding('xyz:SKHY', latest ? '2' : '4'), holding('xyz:SKHX', '5'), holding('xyz:ANT', latest ? '1' : '3')]
        : [holding('io:ANTH', latest ? '7' : '2')];
    } },
  });
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  await w.store.connect({ exchange: 'hyperliquid', walletAddress: '0x00000000000000000000000000000000000000ab' });
  await w.store.sync({});
  w.clock.at += 86_400_000; sourceAt = w.clock.at; latest = true;
  await w.store.sync({});
  const day = (await w.store.dailyChanges()).days[0];
  assert.deepEqual(day.positions?.groups.map(({ id, change, legs }) => [id, change, legs]), [
    ['oil', 5, 1], ['hynix', -2, 2], ['anthropic', 6, 3], ['other', 0, 0],
  ]);
  assert.equal(day.change, 0, '持仓贡献与资产余额口径分开');
  w.clock.at += 86_400_000; sourceAt = w.clock.at; failed = true;
  await w.store.sync({});
  const incomplete = (await w.store.dailyChanges()).days[0];
  assert.deepEqual(incomplete.positions?.groups.map(({ id, change, complete }) => [id, change, complete]), [
    ['oil', 0, false], ['hynix', null, false], ['anthropic', 0, false], ['other', null, false],
  ]);
});

test('成交：读取写入 fill_cache；换密钥后旧成交作废，断开连接清掉该连接的缓存；海力士与原油各自一行', async t => {
  let reads = 0;
  const w = world(t, { positions: { read: async () => [] }, fills: { read: async () => [], fills: async (_c, scope, request) => {
    reads++;
    return scope === 'pm-um' ? [oilFill(request.market + '-' + reads, NOW - 60_000)] : [];
  } } });
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  await w.store.fills('oil'); await idle(w.store, 40);
  // Binance probes PM first; a healthy PM snapshot hides the classic mode (the workbench's account-mode rule).
  const oil = fillScope(await w.store.fills('oil'), 'binance', 'pm-um');
  assert.equal(oil.status, 'live'); assert.equal(oil.fills.length, 1);
  await w.store.fills('hynix'); await idle(w.store, 40);
  assert.deepEqual(w.fillRows().filter(row => row.account === 'binance').map(row => row.scope).sort(), ['hynix:pm-um', 'pm-um']);
  // A replaced key: the cached fills of the old key are not served, and their stored rows go on the next read.
  w.seedHistory();
  await w.store.connect({ exchange: 'binance', apiKey: 'binance-key-N3W1', apiSecret: 'binance-secret-0002' });
  assert.equal(w.historyCount(), 0);
  const replaced = fillScope(await w.store.fills('oil'), 'binance', 'pm-um');
  assert.equal(replaced.status, 'loading'); assert.deepEqual(replaced.fills, []);
  await idle(w.store, 40);
  w.seedHistory();
  await w.store.disconnect({ exchange: 'binance' });
  assert.equal(w.historyCount(), 0);
  assert.deepEqual(w.fillRows().filter(row => row.account === 'binance'), [], '断开连接在同一事务里清掉缓存');
  const gone = fillScope(await w.store.fills('oil'));
  assert.equal(gone.status, 'unconfigured');
});

test('A-5 之前导入的库没有 fill_cache：服务打开时补表，成交照常读取；重新导入时清空', async t => {
  const w = world(t, { positions: { read: async () => [] }, fills: { read: async () => [], fills: async () => [oilFill('a', NOW - 60_000)] } });
  const raw = new DatabaseSync(w.file);
  raw.exec('DROP TABLE fill_cache; DROP TABLE asset_history_windows'); raw.close();
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  await w.store.fills('oil'); await idle(w.store, 40);
  assert.ok(w.fillRows().length > 0);
  w.seedHistory();
  w.store.close();
  importLedger({ from: w.from, owner: OWNER, dataDir: w.dataDir, now: () => NOW });
  assert.deepEqual(w.fillRows(), []);
  assert.equal(w.historyCount(), 0);
  for (const name of readdirSync(w.dataDir)) chmodSync(join(w.dataDir, name), 0o644);
});

const TOKEN = 'asset-access-token-0005';
const SESSION = 'asset-session-value-0005';
test('接口：GET /api/asset/positions 与 /api/asset/fills 的参数校验、404、503，回应不含凭据', async t => {
  const w = world(t, { positions: { read: async () => held() }, fills: { read: async () => [], fills: async () => [] } });
  await w.store.connect({ exchange: 'binance', apiKey: KEY, apiSecret: SECRET });
  const h = createHarness();
  bindAccounts(h.ex);
  const failing = { ...w.store, positions: async () => { throw new Error('SQLITE_IOERR ' + SECRET); }, fills: async () => { throw new Error('PRIVATE ' + SECRET); } };
  const servers = [
    createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views: { asset: w.store } }),
    createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views: { asset: failing } }),
    createExecutorServer({ executor: h.ex, accessToken: TOKEN, session: SESSION, views: {} }),
  ];
  const bases: string[] = [];
  for (const server of servers) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  t.after(() => { for (const server of servers) server.close(); });
  const cookies = new Map<string, string>();
  for (const base of bases) cookies.set(base, ((await fetch(`${base}/login?token=${TOKEN}`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!);
  const texts: string[] = [];
  const get = async (base: string, path: string) => {
    const response = await fetch(base + path, { headers: { cookie: cookies.get(base)! } });
    const text = await response.text(); texts.push(text);
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  };
  const [ok, broken, none] = bases as [string, string, string];
  assert.equal((await fetch(ok + '/api/asset/positions')).status, 401, '未登录不可读');
  assert.equal((await get(ok, '/api/asset/positions')).status, 200);
  assert.equal((await get(ok, '/api/asset/positions?schemaVersion=1')).status, 200);
  assert.deepEqual(await get(ok, '/api/asset/positions?schemaVersion=2'), { status: 400, body: { code: 'invalid_version', message: '不支持的仓位版本' } });
  for (const query of ['', '?market=oil', '?market=hynix', '?schemaVersion=1&market=hynix']) assert.equal((await get(ok, '/api/asset/fills' + query)).status, 200, query);
  for (const query of ['?market=anthropic', '?market=oil&market=hynix', '?schemaVersion=2', '?market=oil&owner=x', '?limit=1']) {
    assert.deepEqual(await get(ok, '/api/asset/fills' + query), { status: 400, body: { code: 'invalid_query', message: '不支持的成交查询参数' } }, query);
  }
  const hynix = (await get(ok, '/api/asset/fills?market=hynix')).body as unknown as HubFills;
  assert.equal(hynix.schemaVersion, 1);
  assert.deepEqual(await get(broken, '/api/asset/positions'), { status: 503, body: { code: 'unavailable', message: '仓位服务暂不可用，请稍后重试' } });
  assert.deepEqual(await get(broken, '/api/asset/fills?market=oil'), { status: 503, body: { code: 'unavailable', message: '成交服务暂不可用，请稍后重试' } });
  assert.equal((await get(none, '/api/asset/positions')).status, 404);
  assert.equal((await get(none, '/api/asset/fills')).status, 404);
  for (const text of texts) for (const secret of [KEY, SECRET]) assert.equal(text.includes(secret), false);
});
