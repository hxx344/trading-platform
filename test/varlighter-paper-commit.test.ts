import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { COOLDOWN_KEY, SETTINGS_KEY, createVarLighterEngine, type VarLighterEngine } from '../src/varlighter/engine.ts';
import type { SocketLike } from '../src/varlighter/feeds.ts';
import { openVarLighterStore, type VarLighterStore } from '../src/varlighter/store.ts';
import { DEFAULT_GLOBAL, DEFAULT_SYMBOL } from '../src/varlighter/strategy.ts';

const key = 'var:BTC|rh:BTC', other = 'var:ETH|rh:ETH';
const market = { symbol: 'BTC', market_id: 1, market_type: 'perp', status: 'active', size_decimals: 4, price_decimals: 2, taker_fee: '0', mark_price: '100' };

test('DEX 模拟盘在 SQLite 提交后发布持仓、成交、冷却和参数，事务各处失败后保持可重试', async t => {
  let time = Date.UTC(2026, 10, 23, 15), mid = 100;
  const now = () => time, signal = new AbortController().signal, otherUntil = time + 86_400_000;
  const dir = mkdtempSync(join(tmpdir(), 'tp-paper-commit-')), file = join(dir, 'varlighter.sqlite');
  let store = openVarLighterStore(file);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE fault_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE fault_child(id INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);`);
  const settings = { revision: 1, global: { ...DEFAULT_GLOBAL, minSamples: 10, varFeeBps: 0, rhFeeBps: 0 },
    symbols: { [key]: { ...DEFAULT_SYMBOL, enabled: true } }, confirmed: [], combos: ['var|rh'], pairs: [], auto: [] };
  store.setState(SETTINGS_KEY, settings, time);
  store.setState(COOLDOWN_KEY, { [other]: otherUntil }, time);
  const fetcher = (withQuote: boolean) => async (url: string) => {
    if (url.includes('orderBookDetails')) return Response.json({ code: 200, order_book_details: [market] });
    const prices = { bid: String(mid - 0.01), ask: String(mid + 0.01) };
    return Response.json({ listings: [{ ticker: 'BTC', name: 'Bitcoin', mark_price: String(mid),
      ...(withQuote ? { quotes: { updated_at: new Date(time).toISOString(), base: prices, size_1k: prices, size_100k: prices } } : {}) }] });
  };
  const socket: SocketLike = { readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send() {}, close() {} };
  const start = (s: VarLighterStore, withQuote: boolean) => createVarLighterEngine({ store: s, now, fetchImpl: fetcher(withQuote), connect: () => socket });
  let engine = start(store, true);
  async function poll(price: number) {
    time += 60_000; mid = price;
    const send = (value: unknown) => socket.onmessage?.({ data: JSON.stringify(value) });
    send({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: { 1: { market_id: 1, best_bid_price: '99.99', best_ask_price: '100.01', mark_price: '100' } } });
    send({ type: 'subscribed/order_book', channel: 'order_book:1', order_book: { code: 0, bids: [{ price: '99.99', size: '5000' }], asks: [{ price: '100.01', size: '5000' }] } });
    await engine.pollVar(signal);
  }
  const saved = () => ({ positions: store.positions(), trades: store.trades(30), events: store.events(30),
    cooldown: store.state<Record<string, number>>(COOLDOWN_KEY)!, settings: store.state(SETTINGS_KEY) });
  function checkView(e: VarLighterEngine, expected: ReturnType<typeof saved>) {
    const paper = e.views.paper(), state = e.views.state();
    assert.deepEqual(paper.positions.map(({ mark, sampleAt, maxHoldMinutes, ...position }) => position), expected.positions);
    assert.deepEqual(paper.trades, expected.trades);
    assert.deepEqual(paper.events, expected.events);
    assert.deepEqual(state.settings, expected.settings);
    assert.equal(state.rows.find(row => row.key === key)!.cooldownUntil, expected.cooldown[key] > time ? expected.cooldown[key] : null);
  }
  async function checkRestart(expected: ReturnType<typeof saved>) {
    const reopened = start(openVarLighterStore(file), false);
    try {
      await reopened.refreshCatalog(signal);
      await reopened.pollVar(signal); // 只取目录，恢复后看见同一个配对与冷却，不产生新样本或交易。
      checkView(reopened, expected);
    } finally { reopened.close(); }
  }
  type Mutation = 'openPosition' | 'closePosition' | 'resetPaper' | 'saveSettings';
  async function fails(method: Mutation, stateWrite: string, action: () => unknown, checkCooldown = false) {
    const expected = saved();
    const phases = ['BEGIN', stateWrite, ...(checkCooldown ? ["BEFORE INSERT ON state WHEN NEW.key='cooldown2'"] : []), 'BEFORE INSERT ON events', 'COMMIT'];
    for (const phase of phases) {
      let fault: RegExp;
      let restore = () => {};
      if (phase === 'BEGIN') {
        // 只在目标事务开始时持有另一写锁，避免开仓前独立写入的行情样本先撞锁。
        const original = store[method];
        const lock = t.mock.method(store, method, (...args: unknown[]) => {
          db.exec('BEGIN IMMEDIATE');
          try { return Reflect.apply(original, store, args); } finally { db.exec('ROLLBACK'); }
        });
        restore = () => lock.mock.restore();
        fault = /database is locked/;
      } else {
        // 延迟外键直到 COMMIT 才拒绝；其余故障由 SQLite 在指定表写入时触发。
        const spec = phase === 'COMMIT' ? 'AFTER INSERT ON events' : phase;
        const statement = phase === 'COMMIT' ? 'INSERT INTO fault_child VALUES (1)' : "SELECT RAISE(ROLLBACK, 'injected paper failure')";
        db.exec(`CREATE TRIGGER paper_fault ${spec} BEGIN ${statement}; END`);
        restore = () => db.exec('DROP TRIGGER paper_fault');
        fault = phase === 'COMMIT' ? /FOREIGN KEY/ : /injected paper failure/;
      }
      try { await assert.rejects(async () => action(), fault, `${method} ${phase}`); } finally { restore(); }
      assert.deepEqual(saved(), expected, `${method} ${phase} 写失败后存储完全一致`);
      checkView(engine, expected);
      await checkRestart(expected);
    }
  }
  try {
    engine.startStreams();
    socket.onopen?.({});
    await engine.refreshCatalog(signal);
    for (let i = 0; i < 15; i++) await poll(100);
    assert.ok(engine.views.state().rows.find(row => row.key === key)?.baseline);

    await fails('openPosition', 'BEFORE INSERT ON leg_positions', () => poll(100.5));
    await poll(100.5);
    const opened = store.positions()[0]!;
    assert.equal(opened.symbol, key);
    assert.deepEqual(store.events(10).map(event => event.kind), ['open']);

    const close = () => engine.views.close({ symbol: key });
    await fails('closePosition', 'BEFORE INSERT ON leg_trades', close, true);
    assert.equal(close().id, opened.id);
    assert.equal(store.positions().length, 0);
    assert.deepEqual(store.trades(30).map(trade => trade.id), [opened.id]);
    assert.deepEqual(store.state(COOLDOWN_KEY), { [other]: otherUntil, [key]: time + DEFAULT_SYMBOL.cooldownMinutes * 60_000 });
    assert.deepEqual(store.events(10).map(event => event.kind), ['close', 'open']);
    assert.throws(close, /没有模拟持仓/);

    // 同时留有持仓、成交和两个冷却，才能查出 RESET 只清掉其中一部分。
    store.savePosition({ ...opened, id: 'another-open-position', symbol: other });
    engine.close(); store = openVarLighterStore(file); engine = start(store, false);
    await engine.refreshCatalog(signal); await engine.pollVar(signal);
    const reset = () => engine.views.reset({ confirm: 'RESET' });
    await fails('resetPaper', 'BEFORE DELETE ON leg_trades', reset, true);
    reset();
    assert.deepEqual([store.positions(), store.trades(30), store.state(COOLDOWN_KEY)], [[], [], {}]);
    assert.deepEqual(store.events(10).map(event => event.kind), ['reset', 'close', 'open']);

    const change = () => engine.views.settings({ revision: 1, global: { paused: true } });
    await fails('saveSettings', "BEFORE INSERT ON state WHEN NEW.key='settings2'", change);
    assert.equal(change().revision, 2);
    assert.equal(engine.views.state().settings.global.paused, true);
    assert.deepEqual(store.events(10).map(event => event.kind), ['settings', 'reset', 'close', 'open']);
    await checkRestart(saved());
  } finally {
    engine.close(); db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
