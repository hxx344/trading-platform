// SK hynix spread rules and rule batches (docs/hynix.md 8.2, 8.3): the hynix rule's settings and stored form, the premium
// judged exactly on the hynix books, the live state machine over the same store as oil (open, hold, close, pending replay,
// the daily limit, failures), batches on hynix and oil rules, and one whole round against the real executor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { createOilRules, evaluateRule, parseRuleConfig, type BookRow } from '../src/oil/rules.ts';
import { RETRY_MS, beijingDay, type RuleExecutor, type RulePlan } from '../src/oil/rule-live.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import { bindAccounts, createHarness, settle } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const hynix = (overrides: Record<string, unknown> = {}) => ({ market: 'hynix', name: '', venue: 'binance', direction: 'short', openThreshold: '2.5', closeThreshold: '0.5', notional: '100', confirmSamples: 2, maxOpensPerDay: 3, ...overrides });
const oil = (overrides: Record<string, unknown> = {}) => ({ name: '', venue: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '3', barrels: '1', confirmSamples: 2, maxOpensPerDay: 3, ...overrides });
type Pair = [[string, string], [string, string]];
/** ADR then ordinary share, [bid, ask]. Selling the premium: 41.20 × 10 ÷ 400.40 − 1 ≈ 2.897 % ≥ 2.5. */
const OPEN: Pair = [['41.20', '41.24'], ['400.00', '400.40']];
/** Buying it back: 40.14 × 10 ÷ 400.00 − 1 = 0.35 % ≤ 0.5. */
const CLOSE: Pair = [['40.10', '40.14'], ['400.00', '400.40']];
/** Oil books on the same venue that would meet an oil rule; a hynix rule ignores them. */
const OIL_BOOKS = (at: number): BookRow[] => [
  { venue: 'binance', symbol: 'BZUSDT', bid: '74.10', ask: '74.12', receivedAt: at, error: null },
  { venue: 'binance', symbol: 'CLUSDT', bid: '70.00', ask: '70.05', receivedAt: at, error: null },
];
const ACCOUNT = { accountKey: 'binance:sim-1', credentialVersion: 1 };

interface Rig { now: number; books: BookRow[]; set(pair: Pair): void }
function rig(): Rig {
  const state: Rig = {
    now: Date.UTC(2026, 10, 13, 2, 0, 0), books: [],
    set([adr, ordinary]) {
      state.books = [
        ...OIL_BOOKS(state.now),
        { venue: 'binance', symbol: 'SKHYUSDT', bid: adr[0], ask: adr[1], receivedAt: state.now, error: null },
        { venue: 'binance', symbol: 'SKHYNIXUSDT', bid: ordinary[0], ask: ordinary[1], receivedAt: state.now, error: null },
      ];
    },
  };
  return state;
}

type Intent = { market: string; action: 'open' | 'close'; timeoutMs: number; batches?: { count: number; intervalMs: number }; legs: { symbol: string; side: string; notional?: string; barrels?: string; quantity?: string }[] };
/** Equal 100 USDT at the sim's binance mids: 2.42 ADR and 0.249 ordinary share. */
const SIZES: Record<string, string> = { SKHYUSDT: '2.42', SKHYNIXUSDT: '0.249' };
/** Stands in for the executor as in oil-rules-live.test.ts: plans on the rig's books, confirm idempotent on the request id. */
class FakeExecutor implements RuleExecutor {
  previews: { intent: Intent; session: string }[] = [];
  confirms: { body: { previewId: string; requestId: string; confirmLive: boolean }; session: string }[] = [];
  jobs = new Map<string, { status: string; legs: { symbol: string; filledQuantity: string; filledBarrels: string }[] }>();
  byRequest = new Map<string, string>();
  previewError: Error | null = null;
  loseAnswer = false;
  private readonly r: Rig;
  constructor(r: Rig) { this.r = r; }
  async preview(intent: unknown, session: string): Promise<RulePlan> {
    const value = intent as Intent;
    this.previews.push({ intent: value, session });
    if (this.previewError) throw this.previewError;
    const legs = value.legs.map(leg => {
      const book = this.r.books.find(row => row.symbol === leg.symbol)!;
      return { symbol: leg.symbol, quantity: leg.quantity ?? (leg.notional ? SIZES[leg.symbol]! : leg.barrels!), ...ACCOUNT, quote: { bid: book.bid!, ask: book.ask!, receivedAt: book.receivedAt! } };
    });
    return { id: randomUUID(), legs, notional: '200', ...(value.batches ? { batches: Array.from({ length: value.batches.count }, () => '1') } : {}) };
  }
  confirm(body: unknown, session: string) {
    const value = body as FakeExecutor['confirms'][number]['body'];
    this.confirms.push({ body: value, session });
    const existing = this.byRequest.get(value.requestId);
    if (existing) return { duplicate: true, job: { id: existing } };
    const id = randomUUID();
    this.jobs.set(id, { status: 'running', legs: [] });
    this.byRequest.set(value.requestId, id);
    if (this.loseAnswer) { this.loseAnswer = false; throw new Error('应答丢失'); }
    return { duplicate: false, job: { id } };
  }
  confirmedJob(requestId: string) { return this.byRequest.get(requestId) ?? null; }
  jobView(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ContractError(404, 'not_found', '任务不存在');
    return job;
  }
  /** Ends the latest job with these fills on the ADR and the ordinary share. */
  finish(status: string, [adr, ordinary]: [string, string]) {
    const id = [...this.jobs.keys()].at(-1)!;
    this.jobs.set(id, { status, legs: [{ symbol: 'SKHYUSDT', filledQuantity: adr, filledBarrels: adr }, { symbol: 'SKHYNIXUSDT', filledQuantity: ordinary, filledBarrels: ordinary }] });
  }
}

type Rules = ReturnType<typeof createOilRules>;
type LiveView = { enabled: boolean; phase: string; held: { symbol: string; side: string; quantity: string }[] | null; pending: { action: string } | null; job: { id: string } | null; opensToday: number; failures: number; reason: string | null };
type RuleView = { id: string; revision: number; title: string; config: Record<string, unknown>; live: LiveView | null; observation: { note: string | null; open: { value: string; hits: number } | null } | null; events: { message: string }[] };
const first = (rules: Rules) => (rules.view() as { rules: RuleView[] }).rules[0]!;
const live = (rules: Rules) => first(rules).live!;
const lastEvent = (rules: Rules) => first(rules).events.at(-1)!.message;

async function withLive(run: (context: { r: Rig; ex: FakeExecutor; rules: Rules; file: string; reopen(): Rules }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-hynix-rules-'));
  const r = rig(), ex = new FakeExecutor(r), file = join(dir, 'oil-rules.sqlite');
  const open = () => createOilRules({ file, venues: ['binance'], books: () => r.books, now: () => r.now, executor: ex });
  let rules = open();
  try { await run({ r, ex, rules, file, reopen: () => { rules.close(); rules = open(); return rules; } }); }
  finally { rules.close(); rmSync(dir, { recursive: true, force: true }); }
}
function goLive(rules: Rules, config: Record<string, unknown> = hynix()): string {
  rules.create({ config });
  const view = (rules.view() as { rules: RuleView[] }).rules.at(-1)!;
  rules.act(view.id, 'live', { revision: view.revision, confirmLive: true });
  return view.id;
}
async function feed(r: Rig, rules: Rules, pair: Pair, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) { r.now += 3_000; r.set(pair); await rules.tick(); }
}
async function openWith(r: Rig, ex: FakeExecutor, rules: Rules, status: string, fills: [string, string]) {
  const before = ex.confirms.length;
  await feed(r, rules, OPEN, 2);
  assert.equal(ex.confirms.length, before + 1, '两份新盘口后确认开仓');
  ex.finish(status, fills);
  await rules.tick();
}

test('海力士规则参数：按每腿名义金额，不收桶数；阈值 -99 至 1000 %；分批 1–20 批且间隔合计加 60 秒不超过 1 小时，1 批视为不分批', () => {
  const config = parseRuleConfig(hynix({ batches: { count: 3, intervalMs: 10_000 } }), ['binance']);
  assert.deepEqual(config, { market: 'hynix', name: '', venue: 'binance', direction: 'short', openThreshold: '2.5', closeThreshold: '0.5', notional: '100', confirmSamples: 2, maxOpensPerDay: 3, batches: { count: 3, intervalMs: 10_000 } });
  assert.equal(parseRuleConfig(hynix({ openThreshold: '-98', closeThreshold: '-99', direction: 'short' }), ['binance']).closeThreshold, '-99');
  assert.throws(() => parseRuleConfig(hynix({ closeThreshold: '-99.01' }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(hynix({ closeThreshold: '3' }), ['binance']), (error: unknown) => code('threshold_order')(error) && (error as Error).message.includes('做空溢价'));
  assert.throws(() => parseRuleConfig(hynix({ barrels: '1' }), ['binance']), code('unknown_field'));
  assert.throws(() => parseRuleConfig({ ...hynix(), notional: undefined }, ['binance']), code('missing_field'));
  assert.throws(() => parseRuleConfig(hynix({ notional: '1000000.1' }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(hynix({ market: 'gold' }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(oil({ notional: '1' }), ['binance']), code('unknown_field'));
  assert.throws(() => parseRuleConfig({ ...oil(), barrels: undefined }, ['binance']), code('missing_field'));
  assert.throws(() => parseRuleConfig(hynix({ batches: { count: 21, intervalMs: 0 } }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(hynix({ batches: { count: 2, intervalMs: 600_001 } }), ['binance']), code('invalid_value'));
  assert.throws(() => parseRuleConfig(hynix({ batches: { count: 2 } }), ['binance']), code('missing_field'));
  // 60 s + 6 × 590 s = 3600 s is the most; one second more is refused.
  assert.equal(parseRuleConfig(oil({ batches: { count: 7, intervalMs: 590_000 } }), ['binance']).batches?.count, 7);
  assert.throws(() => parseRuleConfig(oil({ batches: { count: 7, intervalMs: 590_001 } }), ['binance']), code('batch_timeout'));
  assert.equal('batches' in parseRuleConfig(oil({ batches: { count: 1, intervalMs: 5_000 } }), ['binance']), false);
  // An oil rule as written before hynix rules reads unchanged, with its market filled in.
  assert.deepEqual(parseRuleConfig(oil(), ['binance']), { market: 'oil', ...oil() });
});

test('库：原油规则照旧不写品种与分批，海力士规则写 market；品种不能改；同一库两种规则并存、标题与单位按品种', () => withLive(async ({ rules, file }) => {
  rules.create({ config: oil() });
  rules.create({ config: hynix({ batches: { count: 2, intervalMs: 0 } }) });
  const stored = new DatabaseSync(file);
  const configs = (stored.prepare('SELECT config FROM rules ORDER BY created_at, rowid').all() as { config: string }[]).map(row => row.config);
  assert.equal((stored.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  stored.close();
  assert.equal(configs[0], JSON.stringify(oil()));
  assert.equal(configs[1], JSON.stringify(hynix({ batches: { count: 2, intervalMs: 0 } })));
  const views = (rules.view() as { rules: RuleView[] }).rules;
  assert.deepEqual(views.map(view => [view.title, view.config.market]), [['Binance 原油做空价差', 'oil'], ['Binance 海力士做空溢价', 'hynix']]);
  assert.throws(() => rules.update(views[1]!.id, { revision: views[1]!.revision, config: oil() }), code('rule_market'));
  assert.throws(() => rules.update(views[0]!.id, { revision: views[0]!.revision, config: hynix() }), code('rule_market'));
  rules.update(views[1]!.id, { revision: views[1]!.revision, config: hynix({ notional: '200' }) });
  assert.equal((rules.view() as { rules: RuleView[] }).rules[1]!.config.notional, '200');
}));

test('海力士判断：做空溢价卖出取 ADR 买一对正股卖一、须达到阈值，买回取 ADR 卖一对正股买一、不超过阈值；做多相反；按精确比较，只看海力士盘口', () => {
  const at = Date.UTC(2026, 10, 13, 2, 0, 0);
  const books = (adr: [string, string], ordinary: [string, string]): BookRow[] => [
    ...OIL_BOOKS(at),
    { venue: 'binance', symbol: 'SKHYUSDT', bid: adr[0], ask: adr[1], receivedAt: at, error: null },
    { venue: 'binance', symbol: 'SKHYNIXUSDT', bid: ordinary[0], ask: ordinary[1], receivedAt: at - 500, error: null },
  ];
  const short = parseRuleConfig(hynix({ openThreshold: '3', closeThreshold: '0.35' }), ['binance']);
  // 41.2 × 10 ÷ 400 − 1 is exactly 3 %: met at 3, not at a hair above.
  const exact = books(['41.2', '41.3'], ['399', '400']);
  assert.deepEqual(evaluateRule(short, 'open', exact, at), { value: '3', met: true, side: 'sell', sample: `${at}|${at - 500}`, at: at - 500, bzAt: at, clAt: at - 500 });
  const above = parseRuleConfig(hynix({ openThreshold: '3.000000000000000001', closeThreshold: '0.35' }), ['binance']);
  assert.equal((evaluateRule(above, 'open', exact, at) as { met: boolean }).met, false);
  const close = evaluateRule(short, 'close', books(['40.10', '40.14'], ['400.00', '400.40']), at) as { value: string; met: boolean; side: string };
  assert.deepEqual([close.value, close.met, close.side], ['0.35', true, 'buy']);
  // 41.2 × 10 ÷ 400.4 − 1 = 2.897102897102…: the shown value is cut at 18 places, the comparison is not. Buying at that
  // truncated threshold is not met, since the real premium is above it.
  const long = parseRuleConfig(hynix({ direction: 'long', openThreshold: '2.897102897102897102', closeThreshold: '5' }), ['binance']);
  const buy = evaluateRule(long, 'open', books(['41.1', '41.2'], ['400.4', '400.5']), at) as { value: string; met: boolean; side: string };
  assert.deepEqual([buy.value, buy.met, buy.side], ['2.897102897102897102', false, 'buy']);
  const longClose = evaluateRule(long, 'close', books(['41.3', '41.4'], ['399', '400']), at) as { met: boolean; side: string };
  assert.deepEqual([longClose.met, longClose.side], [false, 'sell']);
  assert.deepEqual(evaluateRule(short, 'open', OIL_BOOKS(at), at), { error: 'SKHYUSDT 未取得盘口' });
  assert.deepEqual(evaluateRule(short, 'open', books(['41.2', '41.3'], ['0', '0']), at), { error: 'SKHYNIXUSDT 盘口价格无效' });
  assert.deepEqual(evaluateRule(short, 'open', exact, at + 9_800), { error: 'SKHYNIXUSDT 盘口已过期' });
});

test('海力士实盘：连续两份新盘口才开仓，同一份盘口不重复计数；等金额意图、首腿 ADR；持仓两腿数量不等；部分平仓后再平完', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  await feed(r, rules, OPEN);
  // The same books judged again (no new read) do not count a second time.
  await rules.tick();
  await rules.tick();
  assert.equal(ex.previews.length, 0, '同一份盘口只计一次');
  assert.equal(first(rules).observation!.open?.hits, 1);
  await feed(r, rules, OPEN);
  assert.equal(ex.previews.length, 1);
  assert.deepEqual(ex.previews[0], {
    session: `oil-rule:${id}`,
    intent: { market: 'hynix', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [
      { venue: 'binance', symbol: 'SKHYUSDT', side: 'short', orderType: 'market', notional: '100' },
      { venue: 'binance', symbol: 'SKHYNIXUSDT', side: 'long', orderType: 'market', notional: '100' },
    ] },
  });
  const events = (rules: Rules) => first(rules).events.map(item => item.message);
  assert.ok(events(rules).includes('开仓预览通过：溢价 2.8971%，ADR 2.42、正股 0.249，名义 200 USDT；确认下单'), events(rules).join('\n'));
  assert.equal(live(rules).phase, 'opening');
  ex.finish('completed', ['2.42', '0.249']);
  await rules.tick();
  assert.deepEqual(live(rules).held, [{ symbol: 'SKHYUSDT', side: 'short', quantity: '2.42', barrels: '2.42' }, { symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.249', barrels: '0.249' }]);
  assert.equal(lastEvent(rules), `开仓完成：ADR 2.42、正股 0.249，进入持仓中`);
  // Holding: the open condition no longer counts; the close condition does, and closes by the held quantities.
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 1);
  await feed(r, rules, CLOSE, 2);
  assert.deepEqual(ex.previews[1]!.intent.legs.map(leg => [leg.symbol, leg.side, leg.quantity, leg.notional]), [['SKHYUSDT', 'short', '2.42', undefined], ['SKHYNIXUSDT', 'long', '0.249', undefined]]);
  ex.finish('completed', ['1.21', '0.124']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).held!.map(leg => leg.quantity)], ['holding', ['1.21', '0.125']]);
  assert.match(lastEvent(rules), /^部分平仓：ADR 1\.21、正股 0\.124，剩余 ADR 1\.21、正股 0\.125/);
  await feed(r, rules, CLOSE, 2);
  assert.deepEqual(ex.previews[2]!.intent.legs.map(leg => leg.quantity), ['1.21', '0.125']);
  ex.finish('completed', ['1.21', '0.125']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).held, live(rules).opensToday], ['idle', null, 1]);
  // One leg filled, the other not: review, not a held record the next close would trust.
  await openWith(r, ex, rules, 'completed', ['2.42', '0']);
  assert.deepEqual([live(rules).phase, live(rules).enabled], ['review', false]);
  assert.match(live(rules).reason!, /一腿没有成交（ADR 2\.42、正股 0）/);
}));

test('海力士实盘：确认结果未知时保留待确认，重启后用同一请求编号核对、不另发任务', () => withLive(async ({ r, ex, rules: initial, reopen }) => {
  goLive(initial);
  ex.loseAnswer = true;
  await feed(r, initial, OPEN);
  r.now += 3_000; r.set(OPEN);
  await assert.rejects(initial.tick(), /应答丢失/);
  assert.deepEqual([live(initial).phase, live(initial).pending?.action, live(initial).job], ['opening', 'open', null]);
  const rules = reopen();
  await rules.tick();
  assert.equal(ex.confirms.length, 2);
  assert.equal(ex.confirms[1]!.body.requestId, ex.confirms[0]!.body.requestId);
  assert.deepEqual([ex.jobs.size, ex.previews.length, live(rules).phase, live(rules).pending], [1, 1, 'opening', null]);
  ex.finish('completed', ['2.42', '0.249']);
  await rules.tick();
  assert.equal(live(rules).phase, 'holding');
  // The held legs survive a restart against the hynix contracts.
  assert.deepEqual(live(reopen()).held?.map(leg => leg.symbol), ['SKHYUSDT', 'SKHYNIXUSDT']);
}));

test('海力士实盘：每日开仓次数按北京时间计；连续 3 次没成交停用', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules, hynix({ maxOpensPerDay: 1 }));
  await openWith(r, ex, rules, 'completed', ['2.42', '0.249']);
  await feed(r, rules, CLOSE, 2);
  ex.finish('completed', ['2.42', '0.249']);
  await rules.tick();
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 2);
  assert.equal(first(rules).observation!.note, '今日已开仓 1 次，达到每日上限');
  const day = beijingDay(r.now);
  r.now += 16 * 3_600_000;
  assert.notEqual(beijingDay(r.now), day);
  for (let i = 1; i <= 3; i++) {
    await openWith(r, ex, rules, 'failed', ['0', '0']);
    assert.equal(live(rules).failures, i);
    r.now += RETRY_MS;
  }
  assert.deepEqual([live(rules).enabled, live(rules).phase], [false, 'idle']);
  assert.match(live(rules).reason!, /连续 3 次失败/);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.confirms.length, 5, '停用后不再下单');
  assert.ok(id);
}));

test('规则分批：海力士与原油规则的意图带上批次，最长执行 60 秒加间隔合计；不分批的原油意图与以前相同', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules, hynix({ batches: { count: 3, intervalMs: 10_000 } }));
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([ex.previews[0]!.intent.batches, ex.previews[0]!.intent.timeoutMs], [{ count: 3, intervalMs: 10_000 }, 80_000]);
  assert.ok(first(rules).events.some(item => item.message.endsWith('，分 3 批，名义 200 USDT；确认下单')), lastEvent(rules));
  ex.finish('completed', ['2.42', '0.249']);
  await rules.tick();
  // The close splits the same way.
  await feed(r, rules, CLOSE, 2);
  assert.deepEqual([ex.previews[1]!.intent.action, ex.previews[1]!.intent.batches], ['close', { count: 3, intervalMs: 10_000 }]);
  const oilId = goLive(rules, oil({ batches: { count: 2, intervalMs: 5_000 } }));
  const plain = goLive(rules, oil({ name: '不分批', openThreshold: '4.04' }));
  await feed(r, rules, OPEN, 2);
  const oilIntents = ex.previews.filter(item => item.intent.market === 'oil');
  assert.deepEqual(oilIntents.map(item => [item.session, item.intent.batches, item.intent.timeoutMs]), [[`oil-rule:${oilId}`, { count: 2, intervalMs: 5_000 }, 65_000], [`oil-rule:${plain}`, undefined, 60_000]]);
  assert.equal('batches' in oilIntents[1]!.intent, false);
}));

test('品种读不一致的持有记录转待核对：海力士规则的持仓记在原油合约上不当作本规则持仓', () => withLive(async ({ r, ex, rules: initial, file, reopen }) => {
  const id = goLive(initial);
  await openWith(r, ex, initial, 'completed', ['2.42', '0.249']);
  const raw = new DatabaseSync(file);
  const state = JSON.parse((raw.prepare('SELECT state FROM rules WHERE id = ?').get(id) as { state: string }).state);
  state.live.held = state.live.held.map((leg: { symbol: string }, index: number) => ({ ...leg, symbol: ['CLUSDT', 'BZUSDT'][index] }));
  raw.prepare('UPDATE rules SET state = ? WHERE id = ?').run(JSON.stringify(state), id);
  raw.close();
  const rules = reopen();
  assert.deepEqual([live(rules).phase, live(rules).enabled, live(rules).held], ['review', false, null]);
  assert.match(live(rules).reason!, /持有记录无法读取/);
}));

test('海力士实盘端到端：真实执行器与模拟交易所上分 2 批开仓、按持有量平仓，规则持有量与交易所仓位一致', async () => {
  const h = createHarness();
  const dir = mkdtempSync(join(tmpdir(), 'tp-hynix-rules-'));
  try {
    bindAccounts(h.ex);
    const books = (): BookRow[] => ['SKHYUSDT', 'SKHYNIXUSDT', 'BZUSDT', 'CLUSDT'].map(symbol => {
      const book = h.binance.books.get(symbol)!;
      return { venue: 'binance', symbol, bid: book.bid, ask: book.ask, receivedAt: h.clock.now, error: null };
    });
    const executor: RuleExecutor = { preview: (intent, session) => h.ex.preview(intent, session), confirm: (body, session) => h.ex.confirm(body, session), jobView: id => h.ex.jobView(id), confirmedJob: (requestId, previewId, session) => h.ex.confirmedJob(requestId, previewId, session) };
    const rules = createOilRules({ file: join(dir, 'oil-rules.sqlite'), venues: ['binance'], books, now: () => h.clock.now, executor });
    try {
      // Binance ADR 41.20/41.24, ordinary 400.00/400.40: selling the premium gets ≈ 2.897 %.
      goLive(rules, hynix({ closeThreshold: '1', batches: { count: 2, intervalMs: 0 } }));
      for (let i = 0; i < 2; i++) { h.advance(3_000); await rules.tick(); }
      const opening = live(rules);
      assert.equal(opening.phase, 'opening', lastEvent(rules));
      const opened = await settle(h, opening.job!.id);
      assert.equal(opened.status, 'completed', opened.reason ?? '');
      assert.equal(opened.batches?.count, 2);
      await rules.tick();
      assert.deepEqual(live(rules).held!.map(leg => [leg.symbol, leg.side, leg.quantity]), [['SKHYUSDT', 'short', '2.42'], ['SKHYNIXUSDT', 'long', '0.249']]);
      assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short'), '2.42');
      assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long'), '0.249');
      // Buying back: ADR ask 40.02 × 10 ÷ ordinary bid 400.00 − 1 = 0.05 % ≤ 1.
      h.binance.setBook('SKHYUSDT', { bid: '40.00', ask: '40.02' });
      for (let i = 0; i < 2; i++) { h.advance(3_000); await rules.tick(); }
      const closing = live(rules);
      assert.equal(closing.phase, 'closing', lastEvent(rules));
      const closed = await settle(h, closing.job!.id);
      assert.equal(closed.status, 'completed', closed.reason ?? '');
      await rules.tick();
      assert.deepEqual([live(rules).phase, live(rules).held, live(rules).opensToday], ['idle', null, 1]);
      assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYUSDT', 'short'), '0'), 0);
      assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'SKHYNIXUSDT', 'long'), '0'), 0);
    } finally { rules.close(); }
  } finally { h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
