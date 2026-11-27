// Copied from project_aggregation modules/asset/tests/hub-positions.test.ts at 7745181. Changes follow the service
// (src/asset/positions-service.ts): no owner (the cross-owner read is left out, connections and settings have no owner
// column), the database is passed as a getter, and the credential opener is synchronous (vault.unseal). Every read is
// a fake reader; nothing connects to an exchange.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAssetDb } from '../src/asset/db.ts';
import { createPositionsService as positionsService, type PositionsServiceOptions } from '../src/asset/positions-service.ts';
import { createFillsService } from '../src/asset/fills-service.ts';
import { position, POSITIONS_FAILED, PositionsPermissionError } from '../src/asset/positions-values.ts';
import { HISTORY_OVERLAP } from '../src/asset/history-cache.ts';
import type { HubPositions, Position } from '../src/asset/positions-types.ts';
import type { Credentials } from '../src/asset/validation.ts';
import { CycleRetry } from '../src/asset/positions-cycle-readers.ts';

const credential: Credentials = { exchange: 'binance', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret' };
const createPositionsService = (options: PositionsServiceOptions) => positionsService(options.read ? { permission: async () => {}, ...options } : options);
const at = Date.parse('2026-10-01T00:00:00.000Z');
const sample = [position('BTCUSDT', 'long', '1.000000000000000001', 'BTC')];
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const scope = (report: HubPositions, exchange = 'binance', account = 'default', id = 'um') => report.exchanges.find(item => item.id === exchange)!.accounts.find(item => item.id === account)!.scopes.find(item => item.id === id)!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  const database = openAssetDb(':memory:'); const credentials = new Map<string, unknown>(); let revision = 0;
  const save = async (_owner = 'owner', key = 'binance', value: unknown = credential) => {
    const encrypted = 'synthetic-encrypted-' + ++revision; credentials.set(encrypted, value);
    database.prepare('INSERT INTO connections(exchange,encrypted,updated_at) VALUES(?,?,?) ON CONFLICT(exchange) DO UPDATE SET encrypted=excluded.encrypted')
      .bind(key, encrypted, new Date(at).toISOString()).run();
  };
  const unseal = (value: string) => credentials.get(value);
  return { database, save, unseal };
}

test('the default position reader rechecks account permissions and positions on a warm ledger and a denied fill refresh invalidates its in-flight cycle', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save('owner', 'okx', { exchange: 'okx', apiKey: 'synthetic', apiSecret: 'synthetic', passphrase: 'synthetic' });
  let clock = at, heldRead = false;
  const waiting = deferred<void>(), arrived = deferred<void>(), calls: URL[] = [], symbol = 'CL-USDT-SWAP';
  const fetcher: typeof fetch = async input => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith('/config')) return Response.json({ code: '0', data: [{ perm: 'read_only' }] });
    if (url.pathname.endsWith('/positions')) return Response.json({ code: '0', data: url.searchParams.get('instType') === 'SWAP'
      ? (heldRead ? ['CL', 'BZ'] : ['CL']).map(base => ({ instType: 'SWAP', instId: base + '-USDT-SWAP', posId: base, pos: '1', posSide: 'net', mgnMode: 'cross' })) : [] });
    if (url.pathname.endsWith('/instruments')) {
      const instId = url.searchParams.get('instId')!;
      return Response.json({ code: '0', data: [{ instId, instType: 'SWAP', uly: instId.slice(0, -5), settleCcy: 'USDT', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0] }] });
    }
    if (url.pathname.endsWith('/bills-archive')) return Response.json({ code: '0', data: [] });
    assert.ok(url.pathname.endsWith('/fills-history'));
    if (heldRead) { arrived.resolve(); await waiting.promise; }
    const time = at - 2 * 86_400_000;
    return Response.json({ code: '0', data: time >= Number(url.searchParams.get('begin')) && time <= Number(url.searchParams.get('end') ?? Infinity)
      ? [{ instId: symbol, billId: '1', ts: String(time), side: 'buy', posSide: 'net', fillSz: '1', fillPx: '80', fillPnl: '0', fee: '-0.1', feeCcy: 'USDT' }] : [] });
  };
  const service = () => createPositionsService({ now: () => clock, fetcher });
  let positions = service(); t.after(() => positions.close());
  const read = () => positions.read(() => f.database, f.unseal);
  await read(); await positions.idle();
  assert.equal(scope(await read(), 'okx', 'default', 'SWAP').positions[0].cycle?.net, '-0.1');
  assert.ok(f.database.prepare('DELETE FROM asset_history_windows WHERE start=?').bind(at - 2 * 86_400_000).run());
  positions.close(); positions = service(); clock += 360_000; calls.length = 0;
  await read(); await positions.idle();
  assert.equal(scope(await read(), 'okx', 'default', 'SWAP').positions[0].cycle?.net, '-0.1');
  for (const path of ['/config', '/positions', '/fills-history', '/bills-archive']) assert.ok(calls.some(url => url.pathname.endsWith(path)), path);
  assert.deepEqual([...new Set(calls.filter(url => url.searchParams.has('begin')).map(url => Number(url.searchParams.get('begin'))))].sort(),
    [at - HISTORY_OVERLAP, at - 2 * 86_400_000].sort());
  const count = () => f.database.prepare('SELECT COUNT(*) AS count FROM asset_history_windows').get<{ count: number }>()!.count;
  assert.ok(count() > 0);
  clock += 360_000; heldRead = true;
  await read(); await arrived.promise;
  const fills = createFillsService({ now: () => clock, permission: async () => { throw new PositionsPermissionError(); } });
  try { await fills.read(() => f.database, f.unseal); await fills.idle(); assert.equal(count(), 0); }
  finally { fills.close(); waiting.resolve(); }
  await positions.idle();
  assert.equal(count(), 0, 'the old cycle cannot restore the revoked history after its HTTP response arrives');
  assert.equal(scope(await read(), 'okx', 'default', 'SWAP').positions[0].cycle?.net, null);
  assert.ok(!calls.some(url => url.pathname.endsWith('/fills-history') && url.searchParams.get('instId') === 'BZ-USDT-SWAP'),
    'the second held position belongs to the same pre-denial snapshot');
});

test('permission loss while an OKX snapshot is pending cancels its historical work and earlier queued reads', async t => {
  for (const pending of ['fills', 'positions'] as const) await t.test(pending, async () => {
    const f = fixture(); await f.save('owner', 'okx', { exchange: 'okx', apiKey: 'synthetic', apiSecret: 'synthetic', passphrase: 'synthetic' });
    const ready = deferred<void>(), release = deferred<void>(), paths: string[] = [];
    const fetcher: typeof fetch = async input => {
      const url = new URL(String(input)); paths.push(url.pathname);
      if (url.pathname.endsWith('/config')) return Response.json({ code: '0', data: [{ perm: 'read_only' }] });
      if (url.pathname.endsWith('/positions')) {
        const swap = url.searchParams.get('instType') === 'SWAP';
        if (swap) { ready.resolve(); await release.promise; }
        return Response.json({ code: '0', data: swap ? ['CL', 'BZ'].map(base => ({ instType: 'SWAP', instId: base + '-USDT-SWAP',
          posId: base, pos: '1', posSide: 'net', mgnMode: 'cross' })) : [] });
      }
      if (url.pathname.endsWith('/instruments')) {
        const instId = url.searchParams.get('instId')!;
        return Response.json({ code: '0', data: [{ instId, instType: 'SWAP', uly: instId.slice(0, -5), settleCcy: 'USDT', ctVal: '1', ctMult: '1', ctValCcy: instId.split('-')[0] }] });
      }
      return Response.json({ code: '0', data: [] });
    };
    const revoked: typeof fetch = async () => Response.json({ code: '0', data: [{ perm: 'trade,read_only' }] });
    const positions = createPositionsService({ now: () => at, fetcher: pending === 'positions' ? fetcher : revoked });
    const fills = createFillsService({ now: () => at, fetcher: pending === 'fills' ? fetcher : revoked });
    const db = () => f.database;
    try {
      if (pending === 'positions') await positions.read(db, f.unseal); else await fills.read(db, f.unseal, 'oil');
      await ready.promise;
      if (pending === 'positions') { await fills.read(db, f.unseal); await fills.idle(); }
      else {
        await fills.read(db, f.unseal, 'hynix'); // Shares an exchange queue with the pending oil snapshot.
        await positions.read(db, f.unseal); await positions.idle();
      }
      const permissions = paths.filter(path => path.endsWith('/config')).length;
      release.resolve(); await Promise.all([positions.idle(), fills.idle()]);
      assert.equal(paths.filter(path => path.endsWith('/config')).length, permissions, 'work queued before the denial cannot acquire a new generation');
      assert.ok(!paths.some(path => path.endsWith('/fills-history') || path.endsWith('/bills-archive')));
      for (const table of ['asset_history_windows', 'fill_cache']) assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM ' + table).get<{ n: number }>()!.n, 0);
    } finally { release.resolve(); positions.close(); fills.close(); f.database.close(); }
  });
});

test('Asset catalog includes every positions exchange before setup and never exposes credentials', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save('owner', 'gate', { exchange: 'gate', apiKey: 'gate-asset-key', apiSecret: 'gate-asset-secret' });
  const service = createPositionsService({ read: async () => assert.fail('unconfigured must not read') });
  const report = await service.read(() => f.database, () => assert.fail('asset-only Gate and unconfigured accounts must not decrypt'));
  assert.deepEqual(report.exchanges.map(item => item.id), ['binance', 'bybit', 'okx', 'aster', 'variational', 'rh-lighter', 'hyperliquid']);
  for (const exchange of report.exchanges) for (const account of exchange.accounts) {
    assert.equal(account.configured, false); assert.equal(account.revision, null);
    for (const item of account.scopes) { assert.equal(item.status, 'unconfigured'); assert.equal(item.fetchedAt, null); assert.deepEqual(item.positions, []); }
  }
});

test('资产库无法写入时两个只读入口仍共用五秒内的持仓，写锁失败只试一次', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save('owner', 'okx', { exchange: 'okx', apiKey: 'fixture', apiSecret: 'fixture', passphrase: 'fixture' });
  const prepare = f.database.prepare; let writes = 0, extraReads = 0, clock = at;
  f.database.prepare = sql => {
    if (sql.startsWith('INSERT INTO asset_position_snapshots')) { writes++; throw new Error('SQLite busy'); }
    return prepare(sql);
  };
  const db = () => f.database;
  const positions = createPositionsService({ now: () => clock, read: async () => sample });
  const fills = createFillsService({ now: () => clock, permission: async () => {}, read: async () => { extraReads++; return []; }, fills: async () => [] });
  try {
    await positions.read(db, f.unseal); await positions.idle();
    assert.equal(writes, 1);
    await fills.read(db, f.unseal, 'oil'); await fills.idle();
    assert.equal(extraReads, 0);
    const swap = (await fills.read(db, f.unseal, 'oil')).exchanges.find(e => e.id === 'okx')!.accounts[0].scopes.find(item => item.id === 'SWAP')!;
    assert.equal(swap.status, 'live'); assert.equal(swap.fetchedAt, new Date(at).toISOString());
    clock += 5_000;
    await fills.read(db, f.unseal, 'hynix'); await fills.idle();
    assert.equal(extraReads, 1); assert.equal(writes, 2);
  } finally { positions.close(); fills.close(); }
});

test('Hyperliquid cache preserves an observation when the venue repeats or rolls back its time', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save('owner', 'hyperliquid', { exchange: 'hyperliquid', walletAddress: '0x00000000000000000000000000000000000000ab' });
  let clock = at, sourceAt = at - 10_000, held = true;
  const service = createPositionsService({ now: () => clock, fetcher: async (_url, init) => {
    const { type, dex } = JSON.parse(String(init?.body));
    if (type === 'perpDexs') return Response.json([null, { name: 'xyz' }, { name: 'io' }]);
    if (type === 'meta') return Response.json({ collateralToken: 0 });
    const assetPositions = held && dex === 'xyz' ? [{ type: 'oneWay', position: { coin: 'xyz:ANT', szi: '-1', unrealizedPnl: '8' } }] : [];
    return Response.json({ time: sourceAt, assetPositions });
  } });
  t.after(() => service.close());
  const refresh = async () => {
    await service.refreshForSnapshot(() => f.database, f.unseal);
    return service.peek(f.database).find(item => item.scope === 'xyz')!;
  };
  const first = await refresh();
  assert.deepEqual([first.status, first.fetchedAt, first.positions[0].symbol], ['live', new Date(sourceAt).toISOString(), 'xyz:ANT']);
  clock += 30_000; held = false;
  assert.deepEqual(await refresh(), first, 'same venue timestamp must be idempotent');
  clock += 30_000; sourceAt -= 1000;
  assert.deepEqual(await refresh(), { ...first, status: 'stale' }, 'older empty response cannot replace a newer held position');
  clock += 30_000; sourceAt = clock;
  const fresh = await refresh();
  assert.deepEqual([fresh.status, fresh.fetchedAt, fresh.positions], ['live', new Date(sourceAt).toISOString(), []]);
});

test('GET returns loading promptly, single-flights within TTL and marks only successful empty results live', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const pending = deferred<Position[]>(); let reads = 0; let clock = at;
  const service = createPositionsService({ now: () => clock, read: async () => { reads++; return pending.promise; } });
  const initial = await service.read(() => f.database, f.unseal);
  assert.equal(scope(initial).status, 'loading'); assert.equal(scope(initial).refreshing, true); assert.equal(scope(initial).fetchedAt, null);
  assert.equal(scope(initial, 'binance', 'default', 'options').status, 'unsupported');
  await flush(); await service.read(() => f.database, f.unseal); assert.equal(reads, 3, 'global cap includes queued fourth Binance scope');
  pending.resolve([]); await service.idle(); assert.equal(reads, 4);
  const result = await service.read(() => f.database, f.unseal);
  assert.equal(scope(result).status, 'live'); assert.deepEqual(scope(result).positions, []); assert.equal(scope(result).fetchedAt, new Date(at).toISOString());
  clock += 4_999; await service.read(() => f.database, f.unseal); assert.equal(reads, 4);
  assert.equal(JSON.stringify(result).includes('synthetic-secret'), false);
});

test('OKX 持仓读取超时后再收到权限拒绝仍撤销缓存世代且无未捕获拒绝', async t => {
  const f = fixture(); t.after(() => f.database.close());
  await f.save('owner', 'okx', { exchange: 'okx', apiKey: 'synthetic', apiSecret: 'synthetic', passphrase: 'synthetic' });
  let clock = at;
  const fills = createFillsService({ now: () => clock, permission: async () => {}, read: async () => [], fills: async () => [] });
  await fills.read(() => f.database, f.unseal); await fills.idle(); fills.close();
  const cacheCount = () => f.database.prepare("SELECT COUNT(*) AS count FROM fill_cache WHERE account = 'okx'").get<{ count: number }>()!.count;
  assert.equal(cacheCount(), 1);

  let unhandled = 0;
  const onUnhandled = () => { unhandled++; };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const entered = deferred<void>(), waiting = deferred<void>();
  const service = createPositionsService({
    now: () => clock,
    deadline: 15,
    read: async () => { entered.resolve(); await waiting.promise; throw new PositionsPermissionError(); },
  });
  t.after(() => service.close());
  await service.read(() => f.database, f.unseal);
  await entered.promise;
  await service.idle();
  waiting.resolve();
  await flush();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cacheCount(), 0);
  assert.equal(unhandled, 0);
});

test('TTL refresh keeps a full snapshot, 90s aging marks stale, and failed refresh preserves data and original fetch time', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at; let fail = false;
  const wait = deferred<Position[]>(); let mode = 'success';
  const service = createPositionsService({ now: () => clock, read: async () => {
    if (fail) throw new Error('PRIVATE provider signature and synthetic-secret');
    if (mode === 'wait') return wait.promise;
    return sample;
  } });
  await service.read(() => f.database, f.unseal); await service.idle();
  clock += 30_000; mode = 'wait';
  const refreshing = await service.read(() => f.database, f.unseal);
  assert.equal(scope(refreshing).status, 'live'); assert.equal(scope(refreshing).refreshing, true); assert.deepEqual(scope(refreshing).positions, sample);
  clock += 60_000; const stale = await service.read(() => f.database, f.unseal); assert.equal(scope(stale).status, 'stale');
  wait.resolve(sample); await service.idle();
  const fetchedAt = scope(await service.read(() => f.database, f.unseal)).fetchedAt;
  fail = true; clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
  const failure = await service.read(() => f.database, f.unseal);
  assert.equal(scope(failure).status, 'error'); assert.equal(scope(failure).fetchedAt, fetchedAt); assert.deepEqual(scope(failure).positions, sample);
  assert.equal(JSON.stringify(failure).includes('PRIVATE'), false); assert.equal(JSON.stringify(failure).includes('synthetic-secret'), false);
});

test('credential replacement clears cached holdings immediately and rejects earlier in-flight completion', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const old = deferred<Position[]>(); const replacement = deferred<Position[]>(); const started: string[] = [];
  const service = createPositionsService({ read: async credentials => {
    assert.ok('apiKey' in credentials); started.push(credentials.apiKey);
    return credentials.apiKey === 'synthetic-key' ? old.promise : replacement.promise;
  } });
  const initial = await service.read(() => f.database, f.unseal); await flush();
  await f.save('owner', 'binance', { ...credential, apiKey: 'replacement-key' });
  const changed = await service.read(() => f.database, f.unseal);
  assert.notEqual(changed.exchanges[0].accounts[0].revision, initial.exchanges[0].accounts[0].revision);
  assert.equal(scope(changed).status, 'loading'); assert.deepEqual(scope(changed).positions, []);
  old.resolve(sample); await flush(); assert.ok(started.includes('replacement-key'));
  const stillLoading = await service.read(() => f.database, f.unseal); assert.deepEqual(scope(stillLoading).positions, []);
  replacement.resolve([]); await service.idle(); assert.equal(scope(await service.read(() => f.database, f.unseal)).status, 'live');
  assert.deepEqual(scope(await service.read(() => f.database, f.unseal)).positions, []);
});

test('disconnect cannot expose old holdings, including late refresh results', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); const pending = deferred<Position[]>();
  const service = createPositionsService({ read: async () => pending.promise });
  await service.read(() => f.database, f.unseal); await flush();
  f.database.prepare('DELETE FROM connections').run();
  const disconnected = await service.read(() => f.database, f.unseal);
  for (const item of disconnected.exchanges[0].accounts[0].scopes) { assert.equal(item.status, 'unconfigured'); assert.deepEqual(item.positions, []); }
  pending.resolve(sample); await flush();
  assert.deepEqual(scope(await service.read(() => f.database, f.unseal)).positions, []);
});

test('Aster account directory comes from Asset saved accounts, including disconnected names and legacy default', async t => {
  const f = fixture(); t.after(() => f.database.close());
  const aster: Credentials = { exchange: 'aster', privateKey: '0'.repeat(63) + '1', walletAddress: '0x' + '1'.repeat(40), includeSpot: false };
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const disconnected = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await f.save('owner', 'aster', aster); await f.save('owner', 'aster:' + id, aster);
  await f.database.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind('aster-accounts', JSON.stringify([{ id, name: '策略二' }, { id: disconnected, name: '已断开策略' }])).run();
  const service = createPositionsService({ read: async () => sample });
  const result = await service.read(() => f.database, f.unseal);
  const accounts = result.exchanges.find(item => item.id === 'aster')!.accounts;
  assert.deepEqual(accounts.map(item => item.name), ['策略二', '已断开策略', '默认账号']);
  assert.equal(accounts[1].configured, false); assert.equal(accounts[0].configured, true); assert.equal(accounts[2].configured, true);
  await service.idle();
});

test('global refresh concurrency is bounded and a timed-out provider cannot overwrite a later snapshot', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  let active = 0, maximum = 0, clock = at; const pending = deferred<Position[]>(); let phase = 0;
  const service = createPositionsService({ now: () => clock, deadline: 15, concurrency: 2, read: async (_c, _scope, signal) => {
    active++; maximum = Math.max(maximum, active); signal.addEventListener('abort', () => { active--; }, { once: true });
    if (phase === 0) return pending.promise;
    active--; return [];
  } });
  await service.read(() => f.database, f.unseal); await service.idle(); assert.equal(maximum, 2);
  const failed = await service.read(() => f.database, f.unseal); assert.equal(scope(failed).status, 'error'); assert.equal(scope(failed).fetchedAt, null);
  phase = 1; clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
  pending.resolve(sample); await flush();
  assert.deepEqual(scope(await service.read(() => f.database, f.unseal)).positions, []);
});

test('vault decryption failures are sanitized and never become successful empty positions', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save();
  const service = createPositionsService({ read: async () => assert.fail('cannot read after failed decrypt') });
  await service.read(() => f.database, () => { throw new Error('PRIVATE encrypted content'); }); await service.idle();
  const result = await service.read(() => f.database, f.unseal);
  assert.equal(scope(result).status, 'error'); assert.equal(scope(result).fetchedAt, null); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('Binance hides and stops polling the account mode that fails while the other mode reads, and restores it on failure', async t => {
  const ids = (report: HubPositions) => report.exchanges.find(item => item.id === 'binance')!.accounts[0].scopes.map(item => item.id);
  for (const [working, restricted] of [[['pm-um', 'pm-cm'], ['um', 'cm']], [['um', 'cm'], ['pm-um', 'pm-cm']]]) {
    const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at; let broken = false; const reads: string[] = [];
    const service = createPositionsService({ now: () => clock, read: async (_c, id) => {
      reads.push(id);
      if (restricted.includes(id) || broken) throw new Error(POSITIONS_FAILED);
      return id === working[0] ? sample : [];
    } });
    const first = await service.read(() => f.database, f.unseal); await service.idle();
    assert.deepEqual(ids(first), ['um', 'pm-um', 'cm', 'pm-cm', 'options']);
    const settled = await service.read(() => f.database, f.unseal);
    assert.deepEqual(ids(settled), ids(first).filter(id => !restricted.includes(id)));
    assert.equal(scope(settled, 'binance', 'default', working[0]).positions.length, 1);
    clock += 30_000; reads.length = 0; await service.read(() => f.database, f.unseal); await service.idle();
    assert.deepEqual(reads.sort(), [...working].sort(), 'hidden mode is not polled');
    broken = true; clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
    const failed = await service.read(() => f.database, f.unseal);
    assert.deepEqual(ids(failed), ['um', 'pm-um', 'cm', 'pm-cm', 'options']);
    for (const id of working) assert.equal(scope(failed, 'binance', 'default', id).status, 'error');
    await service.idle(); assert.ok(restricted.every(id => reads.includes(id)), 'restored mode is polled again');
  }
});

test('exchange scopes refresh every 5 s, Variational and Lighter RH every 30 s', async t => {
  const f = fixture(); t.after(() => f.database.close()); let clock = at; const reads: string[] = [];
  await f.save('owner', 'variational', { exchange: 'variational', vrToken: 'synthetic-token' });
  await f.save('owner', 'rh-lighter', { exchange: 'rh-lighter', walletAddress: '0x' + '1'.repeat(40) });
  await f.save('owner', 'okx', { exchange: 'okx', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret', passphrase: 'synthetic' });
  const service = createPositionsService({ now: () => clock, read: async (c, id) => { reads.push(c.exchange + ':' + id); return []; } });
  const cycle = async (ms: number) => { clock += ms; reads.length = 0; await service.read(() => f.database, f.unseal); await service.idle(); return [...new Set(reads.map(item => item.split(':')[0]))].sort(); };
  assert.deepEqual(await cycle(0), ['okx', 'rh-lighter', 'variational']);
  assert.deepEqual(await cycle(4_999), []);
  assert.deepEqual(await cycle(1), ['okx']);
  assert.deepEqual(await cycle(25_000), ['okx', 'rh-lighter', 'variational']);
});

test('cycle summaries load in the background, stay cached by side and quantity, and retry after failures', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at;
  let held = [{ ...position('BTCUSDT', 'long', '2', 'BTC'), pnlCurrency: 'USDT' }];
  const requests: { scope: string; quantity: string; snapshotAt: number }[] = []; let outcome: 'ok' | 'retry' | 'throw' = 'ok';
  const done = (quantity: string) => ({ status: 'complete' as const, since: new Date(at - 3_600_000).toISOString(), closedQuantity: quantity, closePrice: '100',
    realizedPnl: '1', fees: '-0.1', funding: '0', net: '0.9', currency: 'USDT', note: null, updatedAt: new Date(clock).toISOString() });
  const service = createPositionsService({ now: () => clock, read: async () => held, cycle: async (_c, scope, request) => {
    requests.push({ scope, quantity: request.position.quantity, snapshotAt: request.snapshotAt });
    if (outcome === 'retry') throw new CycleRetry();
    if (outcome === 'throw') throw new Error('PRIVATE timeout');
    return done(request.position.quantity);
  } });
  const cycleOf = (report: HubPositions, id = 'um') => scope(report, 'binance', 'default', id).positions[0]?.cycle;
  await service.read(() => f.database, f.unseal); await service.idle();
  assert.deepEqual(requests.map(item => item.scope).sort(), ['pm-um', 'um'], 'only linear scopes with fill history are summarized');
  assert.equal(requests[0].snapshotAt, at);
  const first = await service.read(() => f.database, f.unseal);
  assert.equal(cycleOf(first)?.status, 'complete'); assert.equal(cycleOf(first)?.net, '0.9');
  assert.equal(cycleOf(first, 'cm'), undefined, 'unsupported scopes carry no cycle field');
  clock += 10_000; requests.length = 0; await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(requests.length, 0, 'unchanged positions reuse the summary');
  held = [{ ...held[0], quantity: '1' }]; clock += 10_000; await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(requests.length, 0, 'a quantity change waits for the minimum age');
  assert.equal(cycleOf(await service.read(() => f.database, f.unseal))?.closedQuantity, '2', 'the older same-side summary stays visible');
  clock += 10_000; await service.read(() => f.database, f.unseal); await service.idle();
  assert.deepEqual(requests.map(item => item.quantity), ['1', '1']);
  held = [{ ...held[0], entryPrice: '101' }]; requests.length = 0; clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(requests.length, 2, 'a same-size reopen at a new entry price is summarized again');
  held = [{ ...held[0], id: 'flipped', side: 'short' }]; outcome = 'retry'; requests.length = 0; clock += 5_000;
  await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(requests.length, 2); assert.equal(cycleOf(await service.read(() => f.database, f.unseal))?.status, 'loading');
  outcome = 'throw'; clock += 5_000; await service.read(() => f.database, f.unseal); await service.idle();
  const failed = cycleOf(await service.read(() => f.database, f.unseal));
  assert.equal(failed?.status, 'unavailable'); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  outcome = 'ok'; requests.length = 0; clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(requests.length, 0, 'failures retry after a minute');
  clock += 30_000; await service.read(() => f.database, f.unseal); await service.idle();
  assert.equal(cycleOf(await service.read(() => f.database, f.unseal))?.status, 'complete');
});

test('peek returns cached holdings for snapshots without reading, and drops replaced credentials', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at; let reads = 0;
  const service = createPositionsService({ now: () => clock, read: async () => { reads++; return sample; } });
  const cold = service.peek(f.database);
  assert.ok(cold.length && cold.every(item => item.status === 'stale' && item.positions.length === 0), 'unread configured scopes remain unknown');
  await service.read(() => f.database, f.unseal); await service.idle();
  const before = reads, live = await service.peek(f.database);
  const um = live.find(item => item.scope === 'um')!;
  assert.equal(um.status, 'live'); assert.equal(um.exchange, 'binance'); assert.equal(um.fetchedAt, new Date(at).toISOString());
  assert.deepEqual(um.positions.map(item => [item.symbol, item.quantity, item.cycle]), [['BTCUSDT', '1.000000000000000001', null]]);
  assert.equal(live.some(item => item.scope === 'options'), false, 'unsupported scopes are not captured');
  clock += 90_000; assert.equal((await service.peek(f.database)).find(item => item.scope === 'um')!.status, 'stale');
  assert.equal(reads, before, 'peek never starts a read');
  await f.save();
  assert.ok(service.peek(f.database).every(item => item.status === 'stale' && item.positions.length === 0 && item.generation !== um.generation), 'replaced credentials invalidate cached holdings');
  assert.equal(JSON.stringify(live).includes('synthetic'), false);
});

test('peek keeps a cycle summary only while it matches the held size and entry, and digests the credential', async t => {
  const f = fixture(); t.after(() => f.database.close()); await f.save(); let clock = at;
  let held = [{ ...position('CLUSDT', 'long', '2', 'CL'), pnlCurrency: 'USDT' }];
  const service = createPositionsService({ now: () => clock, read: async () => held, cycle: async (_c, _scope, request) => ({ status: 'complete' as const,
    since: new Date(at - 3_600_000).toISOString(), closedQuantity: '0', closePrice: null, realizedPnl: '0', fees: '0', funding: '0', net: '0', currency: 'USDT', note: null,
    updatedAt: new Date(clock).toISOString(), ...(request.position.quantity === '1' ? { net: '50' } : {}) }) });
  const um = async () => (await service.peek(f.database)).find(item => item.scope === 'um')!;
  await service.read(() => f.database, f.unseal); await service.idle();
  const first = await um();
  assert.equal(first.positions[0].cycle?.net, '0');
  assert.match(first.generation, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(first).includes('synthetic-encrypted'), false, 'the credential blob is not stored');
  held = [{ ...held[0], quantity: '1' }]; clock += 10_000; await service.read(() => f.database, f.unseal); await service.idle();
  const reduced = await um();
  assert.equal(reduced.positions[0].quantity, '1');
  assert.equal(reduced.positions[0].cycle?.status, 'loading', 'the old summary does not describe the reduced position');
  assert.equal(reduced.positions[0].cycle?.net, null);
  assert.equal(scope(await service.read(() => f.database, f.unseal)).positions[0].cycle?.net, '0', 'the live view still shows the older summary');
  await f.save(); await service.read(() => f.database, f.unseal); await service.idle();
  assert.notEqual((await um()).generation, first.generation, 'a replaced credential changes the generation');
});
