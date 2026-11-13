// The ledger lock (src/asset/sync-lock.ts). The first five cases are project_aggregation modules/asset/tests/sync-lock.test.ts
// at 0014655 with their expectations unchanged; the fixture differs only where the lock does: no owner (one row), and
// an imported ledger (import-info) is needed before the lock can be taken. The last cases cover what this service adds:
// a ledger imported again while the lock is held, and taking the lock before any import.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { openAssetDb } from '../src/asset/db.ts';
import { acquireSyncLock, LEDGER_REIMPORTED, LOCK_BUSY, LOCK_LOST, NOT_IMPORTED } from '../src/asset/sync-lock.ts';

function fixture(t: TestContext, { imported = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const database = openAssetDb(':memory:');
  t.after(() => database.close());
  const setImport = (value: string) => database.prepare("INSERT INTO settings(key,value) VALUES('import-info',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value).run();
  if (imported) setImport('{"importedAt":"2026-11-10T04:00:00.000Z"}');
  const clock = { at: 1_000_000 };
  const acquire = () => acquireSyncLock(database, { now: () => clock.at });
  const lockToken = () => database.prepare('SELECT token FROM sync_locks WHERE id = 1').get<{ token: string }>()?.token ?? null;
  const writes = () => database.prepare("SELECT value FROM settings WHERE key = 'probe'").all<{ value: string }>().then(rows => rows.results.map(row => row.value));
  const probe = (value: string) => () => { database.prepare("INSERT INTO settings(key,value) VALUES('probe',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(value).run(); };
  return { database, clock, acquire, lockToken, writes, probe, setImport };
}

test('a stalled task past its TTL cannot release the next lock or write over it', async t => {
  const f = fixture(t);
  const stale = await f.acquire();
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  // The stale task's renewals never run (stalled), so its lease lapses.
  f.clock.at += 120_001;
  const next = await f.acquire();
  assert.equal(f.lockToken(), next.token);
  assert.throws(() => stale.write(f.probe('stale')), { message: LOCK_LOST });
  await stale.release();
  assert.equal(f.lockToken(), next.token, 'The old finally must not delete the newer lock');
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  next.write(f.probe('next'));
  assert.deepEqual(await f.writes(), ['next']);
  await next.release();
  assert.equal(f.lockToken(), null);
});

test('an expired lease cannot write even when nobody took the lock over', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  f.clock.at += 120_001;
  assert.throws(() => lease.write(f.probe('late')), { message: LOCK_LOST });
  assert.deepEqual(await f.writes(), []);
});

test('a failing write rolls back and keeps the lease usable', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  assert.throws(() => lease.write(() => { f.probe('partial')(); throw new Error('boom'); }), { message: 'boom' });
  assert.deepEqual(await f.writes(), []);
  lease.write(f.probe('ok'));
  assert.deepEqual(await f.writes(), ['ok']);
});

test('a live task renews its lease, but only until the overall hold limit', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  for (let elapsed = 0; elapsed < 570_000; elapsed += 30_000) { f.clock.at += 30_000; t.mock.timers.tick(30_000); }
  await assert.rejects(f.acquire(), { message: LOCK_BUSY });
  lease.write(f.probe('renewed'));
  // Renewal never extends past ten minutes from acquisition, so a stuck task is bounded.
  f.clock.at += 30_000; t.mock.timers.tick(30_000);
  f.clock.at += 1;
  assert.throws(() => lease.write(f.probe('overdue')), { message: LOCK_LOST });
  const next = await f.acquire();
  await lease.release();
  assert.equal(f.lockToken(), next.token);
  assert.deepEqual(await f.writes(), ['renewed']);
});

test('a renewal that throws stops renewing instead of escaping the timer', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  const prepare = f.database.prepare.bind(f.database);
  t.mock.method(f.database, 'prepare', (sql: string) => {
    if (sql.startsWith('UPDATE sync_locks')) throw new Error('SQLITE_BUSY');
    return prepare(sql);
  });
  f.clock.at += 30_000;
  assert.doesNotThrow(() => t.mock.timers.tick(30_000));
  // Renewal stopped, so the lease lapses at its original TTL and later writes are refused.
  f.clock.at += 90_001;
  assert.throws(() => lease.write(f.probe('late')), { message: LOCK_LOST });
  assert.deepEqual(await f.writes(), []);
  await lease.release();
});

test('同步锁：持锁期间账本被重新导入，之后的写入作废且不落库', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  // The import replaces the ledger in its own transaction without taking the lock; its import-info changes.
  f.setImport('{"importedAt":"2026-11-10T05:00:00.000Z"}');
  assert.throws(() => lease.write(f.probe('after-import')), { name: 'AssetConflict', code: 'reimported', message: LEDGER_REIMPORTED });
  assert.deepEqual(await f.writes(), []);
  await lease.release();
  assert.equal(f.lockToken(), null, '释放仍删掉自己的锁');
  // A lock taken after the import writes again.
  const next = await f.acquire();
  next.write(f.probe('next'));
  assert.deepEqual(await f.writes(), ['next']);
  await next.release();
});

test('同步锁：未导入时取锁报“尚未导入资产账本”且不留下锁', async t => {
  const f = fixture(t, { imported: false });
  await assert.rejects(f.acquire(), { name: 'AssetConflict', code: 'not_imported', message: NOT_IMPORTED });
  assert.equal(f.lockToken(), null);
});

test('同步锁：忙与被接替都是 409 的冲突错误，带各自的代码', async t => {
  const f = fixture(t);
  const lease = await f.acquire();
  await assert.rejects(f.acquire(), { name: 'AssetConflict', code: 'busy' });
  f.clock.at += 120_001;
  assert.throws(() => lease.write(f.probe('late')), { name: 'AssetConflict', code: 'lease_lost' });
  await lease.release();
});
