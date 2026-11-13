// Oil spread rules, observe mode (docs/oil.md section 7, O2a): settings, threshold direction, hit counting on fresh books,
// resets, restart and revision checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '../src/contracts.ts';
import { oilLoops, openOilRules, type OilRuntime } from '../src/service/oil.ts';
import { createOilRules, evaluateRule, parseRuleConfig, MAX_RULES, type BookRow, type RuleConfig } from '../src/oil/rules.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const settings = (overrides: Partial<Record<keyof RuleConfig, unknown>> = {}) => ({ name: '', venue: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '3', barrels: '1', confirmSamples: 2, maxOpensPerDay: 3, ...overrides });

interface Rig { now: number; books: BookRow[]; set(bz: [string, string], cl: [string, string], at?: number): void }
function rig(): Rig {
  const state: Rig = {
    now: 1_000_000, books: [],
    set(bz, cl, at = state.now) {
      state.books = [
        { venue: 'binance', symbol: 'BZUSDT', bid: bz[0], ask: bz[1], receivedAt: at, error: null },
        { venue: 'binance', symbol: 'CLUSDT', bid: cl[0], ask: cl[1], receivedAt: at, error: null },
      ];
    },
  };
  return state;
}
function withRules(run: (context: { r: Rig; rules: ReturnType<typeof createOilRules>; file: string; reopen(): ReturnType<typeof createOilRules> }) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-rules-'));
  const r = rig(), file = join(dir, 'oil-rules.sqlite');
  const open = () => createOilRules({ file, venues: ['binance'], books: () => r.books, now: () => r.now });
  let rules = open();
  try { run({ r, rules, file, reopen: () => { rules.close(); rules = open(); return rules; } }); }
  finally { rules.close(); rmSync(dir, { recursive: true, force: true }); }
}
type View = { rules: { id: string; revision: number; observing: boolean; title: string; problem: string | null; observation: { open: { value: string; met: boolean; hits: number; signaled: boolean } | null; close: { value: string; met: boolean; hits: number } | null; note: string | null } | null; observations: { kind: string; message: string; action?: string; value?: string; hits?: number }[]; events: { message: string }[] }[] };
const first = (view: unknown) => (view as View).rules[0]!;
const signals = (view: unknown) => first(view).observations.filter(item => item.kind === 'signal');

test('规则参数：方向决定阈值先后；交易所须已配置；名称、阈值范围、桶数、次数逐项校验', () => {
  assert.equal(parseRuleConfig(settings({ name: '  夜盘 ' }), ['binance']).name, '夜盘');
  assert.throws(() => parseRuleConfig(settings({ closeThreshold: '4' }), ['binance']), code('threshold_order'));
  assert.throws(() => parseRuleConfig(settings({ direction: 'long' }), ['binance']), code('threshold_order'));
  assert.equal(parseRuleConfig(settings({ direction: 'long', openThreshold: '2', closeThreshold: '3.5' }), ['binance']).closeThreshold, '3.5');
  assert.throws(() => parseRuleConfig(settings({ venue: 'bybit' }), ['binance']), code('venue_not_configured'));
  assert.throws(() => parseRuleConfig(settings({ venue: 'okx' }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(settings({ openThreshold: '1001' }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(settings({ openThreshold: 4 }), ['binance']), code('invalid_decimal'));
  assert.throws(() => parseRuleConfig(settings({ barrels: '0' }), ['binance']), code('invalid_decimal'));
  assert.throws(() => parseRuleConfig(settings({ confirmSamples: 0 }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(settings({ maxOpensPerDay: 51 }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(settings({ name: 'x'.repeat(41) }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig({ ...settings(), extra: 1 }, ['binance']), code('unknown_field'));
});

test('可成交价差：做空开仓/做多平仓看卖出价差（BZ 买一 − CL 卖一）≥ 阈值，做空平仓/做多开仓看买入价差（BZ 卖一 − CL 买一）≤ 阈值', () => {
  const r = rig();
  r.set(['74.10', '74.12'], ['70.00', '70.05']);
  const short = parseRuleConfig(settings(), ['binance']);
  const open = evaluateRule(short, 'open', r.books, r.now);
  assert.ok(!('error' in open));
  assert.deepEqual([open.value, open.side, open.met], ['4.05', 'sell', true]);
  const close = evaluateRule(short, 'close', r.books, r.now);
  assert.ok(!('error' in close));
  assert.deepEqual([close.value, close.side, close.met], ['4.12', 'buy', false]);
  const long = parseRuleConfig(settings({ direction: 'long', openThreshold: '4.12', closeThreshold: '5' }), ['binance']);
  const longOpen = evaluateRule(long, 'open', r.books, r.now);
  assert.ok(!('error' in longOpen));
  assert.deepEqual([longOpen.value, longOpen.side, longOpen.met], ['4.12', 'buy', true], '等于阈值算满足');
  // Unreadable, failed, stale and future books are not judged.
  assert.deepEqual(evaluateRule(short, 'open', r.books.slice(0, 1), r.now), { error: 'CLUSDT 未取得盘口' });
  assert.deepEqual(evaluateRule(short, 'open', [{ ...r.books[0]!, error: 'timeout' }, r.books[1]!], r.now), { error: 'BZUSDT 盘口读取失败' });
  assert.deepEqual(evaluateRule(short, 'open', r.books, r.now + 10_001), { error: 'BZUSDT 盘口已过期' });
  assert.deepEqual(evaluateRule(short, 'open', r.books, r.now - 1_001), { error: 'BZUSDT 盘口时间超前，请检查时钟' });
});

test('观察：每份新盘口满足才计一次，同一份盘口不重复计；达到次数只记一条信号，中断后重新计数；不满足清零', () => withRules(({ r, rules }) => {
  r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.create({ config: settings(), observing: true });
  // Books read before the rule started do not count.
  rules.tick();
  assert.equal(first(rules.view()).observation!.note, '等待开始或清零后的两腿新盘口');
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1);
  rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1, '同一份盘口不重复计');
  assert.equal(signals(rules.view()).length, 0);
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  let view = first(rules.view());
  assert.deepEqual([view.observation!.open!.hits, view.observation!.open!.signaled], [2, true]);
  assert.deepEqual(signals(rules.view()).map(item => [item.action, item.value, item.hits, item.message]), [['open', '4.05', 2, '开仓条件本会触发；仅记录信号，未下单']]);
  r.now += 3_000; r.set(['74.20', '74.22'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(signals(rules.view()).length, 1, '同一轮连续满足只记一次');
  // The streak breaks, then two fresh hits signal again.
  r.now += 3_000; r.set(['73.00', '73.02'], ['70.00', '70.05']);
  rules.tick();
  view = first(rules.view());
  assert.deepEqual([view.observation!.open!.hits, view.observation!.open!.met], [0, false]);
  for (let i = 0; i < 2; i++) { r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); rules.tick(); }
  assert.equal(signals(rules.view()).length, 2);
  // The close condition is counted on its own: buy spread 2.95 ≤ 3.
  for (let i = 0; i < 2; i++) { r.now += 3_000; r.set(['72.95', '73.00'], ['70.05', '70.10']); rules.tick(); }
  assert.deepEqual(signals(rules.view()).map(item => item.action), ['open', 'open', 'close']);
}));

test('观察：读取失败、盘口过期、两次读数间隔超过 10 秒都清零并等新盘口，同一原因连续只记一次', () => withRules(({ r, rules }) => {
  rules.create({ config: settings(), observing: true });
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1);
  r.books = [{ ...r.books[0]!, error: 'timeout' }, r.books[1]!];
  rules.tick(); rules.tick();
  const resets = first(rules.view()).observations.filter(item => item.message === 'BZUSDT 盘口读取失败；连续次数清零');
  assert.equal(resets.length, 1);
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1, '清零后重新从 1 计');
  // Books still fresh, but the gap since the last counted reading is longer than 10 s.
  r.now += 11_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(first(rules.view()).observation!.note, '盘口更新间隔超过 10 秒');
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1, '间隔清零后下一份新盘口从 1 计');
  // Books that stop updating: the stale reason is recorded once however many rounds see it.
  r.now += 11_000; rules.tick(); r.now += 3_000; rules.tick();
  assert.equal(first(rules.view()).observations.filter(item => item.message === 'BZUSDT 盘口已过期；连续次数清零').length, 1);
  assert.equal(signals(rules.view()).length, 0);
}));

test('观察：一条规则写库失败不影响同一轮的其它规则，失败汇总抛给循环记日志；写库恢复后补记信号', () => withRules(({ r, rules, file }) => {
  rules.create({ config: settings({ name: '甲', confirmSamples: 1 }), observing: true });
  rules.create({ config: settings({ name: '乙', confirmSamples: 1 }), observing: true });
  const [a, b] = (rules.view() as View).rules;
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON rules WHEN NEW.id = '${a!.id}' BEGIN SELECT RAISE(ABORT, '写入被拒'); END`);
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']);
  assert.throws(() => rules.tick(), /甲.*写入被拒/);
  const after = () => new Map((rules.view() as View).rules.map(rule => [rule.title, rule.observations.filter(item => item.kind === 'signal').length]));
  assert.deepEqual([...after()], [['甲', 0], ['乙', 1]]);
  db.exec('DROP TRIGGER refuse'); db.close();
  rules.tick();
  assert.deepEqual([...after()], [['甲', 1], ['乙', 1]], '没写进库的信号下一轮补记，已记的不重复');
}));

test('观察：清零原因写库失败时连续次数照样清零，恢复后从 1 重新计、不凭旧次数出信号', () => withRules(({ r, rules, file }) => {
  rules.create({ config: settings({ confirmSamples: 3 }), observing: true });
  const id = first(rules.view()).id;
  for (let i = 0; i < 2; i++) { r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); rules.tick(); }
  assert.equal(first(rules.view()).observation!.open!.hits, 2);
  const db = new DatabaseSync(file);
  db.exec(`CREATE TRIGGER refuse BEFORE UPDATE ON rules WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, '写入被拒'); END`);
  r.now += 3_000; r.books = [{ ...r.books[0]!, error: 'timeout' }, r.books[1]!];
  assert.throws(() => rules.tick(), /写入被拒/);
  db.exec('DROP TRIGGER refuse'); db.close();
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1);
  assert.equal(signals(rules.view()).length, 0);
}));

test('观察：重启、修改与停止都清零；修订号不一致返回 409；最多 12 条；停止后不再计数', () => withRules(({ r, rules: initial, reopen }) => {
  initial.create({ config: settings({ confirmSamples: 3 }), observing: true });
  for (let i = 0; i < 2; i++) { r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); initial.tick(); }
  assert.equal(first(initial.view()).observation!.open!.hits, 2);
  const rules = reopen();
  assert.ok(first(rules.view()).observations.some(item => item.message === '服务重启，连续次数已清零，等待新盘口'));
  rules.tick();
  assert.equal(first(rules.view()).observation!.note, '等待开始或清零后的两腿新盘口', '重启前的盘口不计');
  r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); rules.tick();
  assert.equal(first(rules.view()).observation!.open!.hits, 1);
  const { id, revision } = first(rules.view());
  assert.throws(() => rules.update(id, { revision: revision + 1, config: settings() }), code('stale_revision'));
  rules.update(id, { revision, config: settings({ openThreshold: '5', name: '改过' }) });
  let view = first(rules.view());
  assert.deepEqual([view.revision, view.title, view.observation!.note], [revision + 1, '改过', '等待读取盘口']);
  rules.act(id, 'stop', { revision: view.revision });
  view = first(rules.view());
  assert.deepEqual([view.observing, view.observation], [false, null]);
  r.now += 3_000; r.set(['80', '80.02'], ['70.00', '70.05']); rules.tick();
  assert.equal(signals(rules.view()).length, 0, '停止后不计数');
  assert.throws(() => rules.act(id, 'stop', { revision: view.revision }), code('not_observing'));
  assert.throws(() => rules.act(id, 'live', { revision: view.revision }), code('not_found'));
  for (let i = 1; i < MAX_RULES; i++) rules.create({ config: settings() });
  assert.throws(() => rules.create({ config: settings() }), code('too_many_rules'));
  rules.act(id, 'delete', { revision: view.revision });
  assert.equal((rules.view() as View).rules.length, MAX_RULES - 1);
}));

test('库：版本比本版本新时拒绝打开；参数读不了的规则保留显示、不判断、不能开始观察', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-rules-'));
  const file = join(dir, 'oil-rules.sqlite'), r = rig();
  try {
    const open = () => createOilRules({ file, venues: ['binance'], books: () => r.books, now: () => r.now });
    const rules = open();
    rules.create({ config: settings(), observing: true });
    rules.close();
    const db = new DatabaseSync(file);
    db.exec(`UPDATE rules SET config = '{"venue":"binance"}'`);
    db.close();
    const again = open();
    r.now += 3_000; r.set(['74.10', '74.12'], ['70.00', '70.05']); again.tick();
    const view = first(again.view());
    assert.match(view.problem!, /^规则参数无法读取/);
    assert.equal(signals(again.view()).length, 0);
    assert.throws(() => again.act(view.id, 'start', { revision: view.revision }), code('already_observing'));
    again.act(view.id, 'stop', { revision: view.revision });
    const stored = new DatabaseSync(file);
    assert.equal((stored.prepare('SELECT config FROM rules').get() as { config: string }).config, '{"venue":"binance"}', '停止不改写库里的原始参数');
    stored.close();
    assert.throws(() => again.act(view.id, 'start', { revision: view.revision + 1 }), code('invalid_rule'));
    again.update(view.id, { revision: view.revision + 1, config: settings() });
    assert.equal(first(again.view()).problem, null);
    // Settings that are valid JSON but not an object still show (with a complete stand-in) and can be deleted.
    const raw = new DatabaseSync(file);
    raw.exec(`UPDATE rules SET config = 'null', state = 'null'`);
    raw.close();
    const broken = first(again.view()) as View['rules'][number] & { config: RuleConfig };
    assert.equal(broken.title, 'Binance 原油做空价差');
    assert.deepEqual(broken.config, { name: '', venue: 'binance', direction: 'short', openThreshold: '', closeThreshold: '', barrels: '', confirmSamples: 0, maxOpensPerDay: 0 });
    assert.match(broken.problem!, /^规则参数无法读取/);
    assert.equal(broken.observing, false);
    assert.deepEqual([broken.events, broken.observations], [[], []]);
    // Records read back keep only well-formed items, at most 30; text that is not JSON reads as a stopped rule.
    const good = { at: 1, kind: 'reset', message: '好' }, signal = { at: 2, kind: 'signal', message: '信号', value: '4', threshold: '4', hits: 2, bzAt: 1, clAt: 1 };
    const mixed = [null, { at: 'x', kind: 'note', message: '坏' }, { at: 1, message: '缺类型' }, { ...signal, bzAt: undefined }, signal, ...Array.from({ length: 31 }, () => good)];
    const patch = new DatabaseSync(file);
    patch.prepare('UPDATE rules SET state = ?').run(JSON.stringify({ observing: false, events: mixed, observations: [signal, { ...signal, kind: 'other' }] }));
    const filtered = first(again.view());
    assert.equal(filtered.events.length, 30);
    assert.ok(filtered.events.every(item => item.message === '好'));
    assert.deepEqual(filtered.observations.map(item => item.message), ['信号']);
    patch.exec(`UPDATE rules SET state = '{not json'`);
    patch.close();
    assert.deepEqual([first(again.view()).observing, first(again.view()).events], [false, []]);
    again.act(broken.id, 'delete', { revision: broken.revision });
    again.close();
    const newer = new DatabaseSync(file);
    newer.exec('PRAGMA user_version = 2');
    newer.close();
    assert.throws(open, /库版本 2 比本版本能读的 1 新/);
    // A rules table of another shape is refused and the version is not stamped on it.
    const other = join(dir, 'other.sqlite'), foreign = new DatabaseSync(other);
    foreign.exec('CREATE TABLE rules (id TEXT)');
    foreign.close();
    assert.throws(() => createOilRules({ file: other, venues: ['binance'], books: () => r.books, now: () => r.now }), /rules 表结构不符/);
    const check = new DatabaseSync(other);
    assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
    check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('服务接线：规则库打不开时只读出原因、写入 503；每轮读完盘口判断规则，判断失败只记日志、循环继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-rules-'));
  try {
    const logs: string[] = [];
    const oil = { config: { notionalLimits: { perJob: '1', openPer24h: '1' }, accounts: [{ venue: 'binance' }] }, market: { view: () => ({ books: [] }), refreshQuotes: async () => {}, refreshPositions: async () => {} } } as unknown as OilRuntime;
    const stub = openOilRules(oil, join(dir, 'missing', 'deeper'), { log: line => logs.push(line) });
    assert.deepEqual(Object.keys(stub.view() as object), ['available', 'error', 'rules']);
    assert.equal((stub.view() as { available: boolean }).available, false);
    assert.throws(() => stub.create({}), code('rules_unavailable'));
    assert.throws(() => stub.act('x', 'start', {}), (error: unknown) => error instanceof ContractError && error.status === 503);
    assert.match(logs[0]!, /原油自动规则库无法打开/);
    let ticks = 0, rounds = 0;
    const rules = { ...stub, tick: () => { ticks++; throw new Error('坏了'); } };
    const context = { stopped: () => rounds >= 3, pause: async () => { rounds++; } };
    await Promise.all(oilLoops(oil, context, line => logs.push(line), rules));
    assert.ok(ticks >= 2, '判断失败后盘口循环继续下一轮');
    assert.ok(logs.includes('原油自动规则判断失败：坏了'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
