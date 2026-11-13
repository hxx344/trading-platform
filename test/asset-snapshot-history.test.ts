// Copied from project_aggregation modules/asset/tests/snapshot-history.test.ts at 0014655; the expectations are unchanged.
// Changes: imports point at src/asset; no owner column (one user), so the owner isolation case is left out and the two-owner case uses one database per case; batch() runs the statements in one transaction.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openAssetDb, type AssetDb } from '../src/asset/db.ts';
import { readSnapshotHistory } from '../src/asset/snapshot-history.ts';
import { assetTrend } from '../src/asset/withdrawals.ts';
import { calculateAnnualizedReturns, calculateMonthlyPerformance } from '../src/asset/performance-metrics.ts';
import type { Period } from '../src/asset/types.ts';

const batch = (database: AssetDb, statements: { run(): number }[]) => database.replace(() => { for (const statement of statements) statement.run(); });
const day = (index: number) => new Date(Date.UTC(2022, 0, 1 + index)).toISOString().slice(0, 10);
const period = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id, date, total: 1000, fx: 7, cny: 7000, future: false, difference: 0,
  assets: [{ project: '持仓', value: 1000 }], ...extra,
});

test('all daily history survives more than 730 days and a full archive window', async t => {
  const database = openAssetDb(':memory:');
  t.after(() => database.close());
  const insert = database.prepare('INSERT INTO snapshots(date,data) VALUES(?,?)');
  const daily = Array.from({ length: 800 }, (_, index) => period(`daily-${day(index)}`, day(index), { total: 1000 + index }));
  const archives = Array.from({ length: 760 }, (_, index) => period(`archive-${index}`, day(index + 800), { archived: true }));
  batch(database, [
    ...daily.map(row => insert.bind(row.date, JSON.stringify(row))),
    ...archives.map(row => insert.bind(row.id, JSON.stringify(row))),
  ]);

  const history = await readSnapshotHistory(database);
  assert.equal(history.length, 800 + 730);
  assert.deepEqual(history.filter(row => !row.archived).map(row => row.date), daily.map(row => row.date).reverse());
  assert.equal(history[0].date, archives.at(-1)?.date);
  assert.equal(history.at(-1)?.date, daily[0].date);
  assert.ok(history.every(row => !Object.hasOwn(row, 'assets')), 'history projection must omit asset detail payloads');

  const trend = assetTrend({ history, withdrawals: [], baselineDate: day(0) }, day(1600));
  assert.equal(trend.length, 800, 'archives must not displace valid performance points');
  assert.equal(trend[0].date, day(0));
  assert.equal(trend.at(-1)?.date, day(799));
  assert.equal(trend.at(-1)?.adjusted, 1799);
  const metrics = calculateAnnualizedReturns(trend, calculateMonthlyPerformance(trend), day(1600));
  assert.equal(metrics.daysSpan, 799, 'lifetime annualization must use the first stored day');
  // Two full ordinary years followed by 69 elapsed days of leap year 2024.
  assert.ok(Math.abs(metrics.overallAnnualized! - 0.799 / (2 + 69 / 366)) < 1e-10);
  const stored = await database.prepare('SELECT data FROM snapshots WHERE date=?').bind(day(0)).first<{ data: string }>();
  assert.deepEqual(JSON.parse(stored!.data).assets, daily[0].assets, 'reading must preserve stored asset detail');
});

test('legacy withdrawals are backfilled without asset payloads and explicit values take precedence', async t => {
  const database = openAssetDb(':memory:');
  t.after(() => database.close());
  const assets = [
    { project: ' 出金 ', value: 120.25 },
    { project: '出金', value: 30.5 },
    { project: '出金', value: null },
    { project: '出借', value: 900 },
  ];
  const rows = [
    period('daily-legacy', day(0), { assets, partial: true }),
    period('archive-legacy', day(1), { assets, archived: true }),
    period('daily-zero', day(2), { assets, withdrawn: 0 }),
    period('daily-explicit', day(3), { assets, withdrawn: 42 }),
    period('daily-no-assets', day(4), { assets: undefined }),
  ];
  const insert = database.prepare('INSERT INTO snapshots(date,data) VALUES(?,?)');
  batch(database, rows.map(row => insert.bind(row.id.startsWith('archive-') ? row.id : row.date, JSON.stringify(row))));

  const history = await readSnapshotHistory(database);
  const expectedWithdrawn = [150.75, 150.75, 0, 42, 0];
  assert.deepEqual(history, rows.map((row, index) => {
    const { assets: omitted, ...snapshot } = row;
    void omitted;
    return { ...snapshot, withdrawn: expectedWithdrawn[index], ...(index < 4 ? { partial: true, missingValues: 1 } : {}) } as Period;
  }).reverse());
});

test('legacy unknown valuations become partial on read without rewriting stored snapshots', async t => {
  const database = openAssetDb(':memory:');
  t.after(() => database.close());
  const rows = [
    period('daily-start', '2024-01-01', { total: 100 }),
    period('daily-end', '2024-01-31', { total: 50, partial: false, assets: [{ project: 'known', value: 50 }, { project: 'unknown', value: null }] }),
  ];
  const insert = database.prepare('INSERT INTO snapshots(date,data) VALUES(?,?)');
  batch(database, rows.map(row => insert.bind(row.date, JSON.stringify(row))));
  const history = await readSnapshotHistory(database);
  assert.equal(history[0].total, 50);
  assert.equal(history[0].partial, true);
  assert.equal(history[0].missingValues, 1);
  assert.ok(history.every(row => !Object.hasOwn(row, 'assets')));
  const trend = assetTrend({ history, withdrawals: [], baselineDate: '2024-01-01' }, '2024-02-15');
  const metrics = calculateAnnualizedReturns(trend, calculateMonthlyPerformance(trend), '2024-02-15');
  assert.equal(metrics.monthlyAnnualized, null);
  assert.equal(metrics.overallAnnualized, null);
  const stored = await database.prepare('SELECT data FROM snapshots WHERE date = ?').bind(rows[1].date).first<{ data: string }>();
  assert.equal(stored?.data, JSON.stringify(rows[1]));
});

test('legacy market zeros suppress endpoint returns despite complete metadata, while genuine zero quantities remain known', async t => {
  const legacy = { project: 'virtual', mode: 'market', quantity: null, price: 2.5, value: 0 };
  const known = { project: 'known', value: 100 };
  for (const quantity of [null, 0]) {
    const database = openAssetDb(':memory:');
    t.after(() => database.close());
    const rows = [
      period('daily-start', '2024-01-01', { total: 100, partial: false, missingValues: 0, assets: [known, { ...legacy, quantity }] }),
      period('daily-end', '2024-01-31', { total: 150, assets: [known, { ...legacy, quantity: 20, value: 50 }] }),
      period('archive-legacy', '2024-01-15', { total: 100, partial: false, missingValues: 0, archived: true, assets: [known, legacy] }),
    ];
    batch(database, rows.map(row => database.prepare('INSERT INTO snapshots VALUES(?,?)').bind(row.id.startsWith('archive-') ? row.id : row.date, JSON.stringify(row))));
    const history = await readSnapshotHistory(database);
    const start = history.find(row => row.id === 'daily-start')!;
    assert.equal(start.missingValues, quantity === null ? 1 : 0);
    assert.equal(start.partial, quantity === null);
    assert.equal(history.find(row => row.id === 'archive-legacy')?.missingValues, 1);
    assert.ok(history.every(row => !Object.hasOwn(row, 'assets')));
    const trend = assetTrend({ history, withdrawals: [], baselineDate: '2024-01-01' }, '2024-02-15');
    const monthly = calculateMonthlyPerformance(trend);
    assert.equal(monthly[0].gain, quantity === null ? null : 50);
    assert.equal(monthly[0].returnRate, quantity === null ? null : 0.5);
    const annualized = calculateAnnualizedReturns(trend, monthly, '2024-02-15');
    if (quantity === null) {
      assert.equal(annualized.monthlyAnnualized, null);
      assert.equal(annualized.overallAnnualized, null);
    } else {
      assert.ok(annualized.monthlyAnnualized! > 0);
      assert.ok(annualized.overallAnnualized! > 0);
    }
    const stored = await database.prepare('SELECT date,data FROM snapshots ORDER BY date').all<{ date: string; data: string }>();
    for (const row of stored.results) assert.equal(row.data, JSON.stringify(rows.find(snapshot => (snapshot.id.startsWith('archive-') ? snapshot.id : snapshot.date) === row.date)));
  }
});
