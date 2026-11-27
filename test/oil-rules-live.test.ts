// Oil spread rules, live mode (docs/oil.md 7.3, O2b): trigger through the executor's preview and confirm, recheck on the
// plan's books, pending confirm replay, job outcomes, failures, the daily open limit and the page actions' limits. The last
// test runs a whole open and close against the real executor over the simulated venues.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError } from '../src/contracts.ts';
import { cmp } from '../src/decimal.ts';
import { createOilRules, type BookRow, type RuleConfig } from '../src/oil/rules.ts';
import { BLOCKED_NOTIFY_MS, RETRY_MS, beijingDay, type RuleExecutor, type RulePlan } from '../src/oil/rule-live.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import { handOver, oilLoops, type OilRulesRuntime, type OilRuntime } from '../src/service/oil.ts';
import { SIM_BINDINGS } from '../src/simulation.ts';
import { createOilMarket } from '../src/oil/market.ts';
import { createHynixMarket } from '../src/hynix/market.ts';
import { createGoldOilMarket } from '../src/goldoil/market.ts';
import { ruleActions, type OilRule } from '../web/src/oil-rules-form.ts';
import { bindAccounts, createHarness, settle } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const settings = (overrides: Partial<Record<keyof RuleConfig, unknown>> = {}) => ({ name: '', venue: 'binance', direction: 'short', openThreshold: '4', closeThreshold: '3', barrels: '1', confirmSamples: 2, maxOpensPerDay: 3, ...overrides });
const OPEN: [[string, string], [string, string]] = [['74.10', '74.12'], ['70.00', '70.05']];
const CLOSE: [[string, string], [string, string]] = [['72.95', '73.00'], ['70.05', '70.10']];
const ACCOUNT = { accountKey: 'binance:sim-1', credentialVersion: 1 };

interface Rig { now: number; books: BookRow[]; set(bz: [string, string], cl: [string, string]): void }
function rig(): Rig {
  const state: Rig = {
    now: Date.UTC(2026, 10, 13, 2, 0, 0), books: [],
    set(bz, cl) {
      state.books = [
        { venue: 'binance', symbol: 'BZUSDT', bid: bz[0], ask: bz[1], receivedAt: state.now, error: null },
        { venue: 'binance', symbol: 'CLUSDT', bid: cl[0], ask: cl[1], receivedAt: state.now, error: null },
      ];
    },
  };
  return state;
}

type Intent = { action: 'open' | 'close'; legs: { symbol: string; side: string; barrels?: string; quantity?: string }[] };
/** Stands in for the executor: previews price on the rig's books, confirm is idempotent on the request id like the real one. */
class FakeExecutor implements RuleExecutor {
  previews: { intent: Intent; session: string }[] = [];
  confirms: { body: { previewId: string; requestId: string; confirmLive: boolean }; session: string }[] = [];
  jobs = new Map<string, { status: string; legs: { symbol: string; filledQuantity: string; filledBarrels: string }[] }>();
  byRequest = new Map<string, string>();
  previewError: Error | null = null;
  /** Books the plan is priced on, when they differ from the rig's. */
  planBooks: BookRow[] | null = null;
  account = ACCOUNT;
  confirmError: Error | null = null;
  /** The job is written, then the answer is lost. */
  loseAnswer = false;
  gate: Promise<void> | null = null;
  private readonly r: Rig;
  constructor(r: Rig) { this.r = r; }
  async preview(intent: unknown, session: string): Promise<RulePlan> {
    this.previews.push({ intent: intent as Intent, session });
    if (this.gate) await this.gate;
    if (this.previewError) throw this.previewError;
    const books = this.planBooks ?? this.r.books;
    const legs = (intent as Intent).legs.map(leg => {
      const book = books.find(row => row.symbol === leg.symbol)!;
      return { symbol: leg.symbol, quantity: leg.barrels ?? leg.quantity!, ...this.account, quote: { bid: book.bid!, ask: book.ask!, receivedAt: book.receivedAt! } };
    });
    return { id: randomUUID(), legs, notional: '144', barrels: legs[0]!.quantity };
  }
  confirm(body: unknown, session: string) {
    const value = body as FakeExecutor['confirms'][number]['body'];
    this.confirms.push({ body: value, session });
    const existing = this.byRequest.get(value.requestId);
    if (existing) return { duplicate: true, job: { id: existing } };
    if (this.confirmError) throw this.confirmError;
    const id = randomUUID();
    this.jobs.set(id, { status: 'running', legs: [] });
    this.byRequest.set(value.requestId, id);
    if (this.loseAnswer) { this.loseAnswer = false; throw new Error('应答丢失'); }
    return { duplicate: false, job: { id } };
  }
  confirmedJob(requestId: string, previewId: string, session: string) {
    const id = this.byRequest.get(requestId) ?? null;
    if (id && !this.confirms.some(item => item.body.requestId === requestId && item.body.previewId === previewId && item.session === session)) throw new ContractError(409, 'request_reused', '请求编号已用于其他内容');
    return id;
  }
  jobView(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new ContractError(404, 'not_found', '任务不存在');
    return job;
  }
  /** Ends the latest job with these fills on CL and BZ (contract size 1). */
  finish(status: string, [cl, bz]: [string, string]) {
    const id = [...this.jobs.keys()].at(-1)!;
    this.jobs.set(id, { status, legs: [{ symbol: 'CLUSDT', filledQuantity: cl, filledBarrels: cl }, { symbol: 'BZUSDT', filledQuantity: bz, filledBarrels: bz }] });
    return id;
  }
}

type Rules = ReturnType<typeof createOilRules>;
type LiveView = { enabled: boolean; phase: string; held: { symbol: string; side: string; quantity: string; barrels: string }[] | null; pending: { action: string } | null; job: { id: string; action: string } | null; opensToday: number; failures: number; retryAt: number | null; reason: string | null };
type RuleView = { id: string; revision: number; mode: string; observing: boolean; live: LiveView | null; observation: { note: string | null } | null; events: { message: string }[] };
const first = (rules: Rules) => (rules.view() as { rules: RuleView[] }).rules[0]!;
const live = (rules: Rules) => first(rules).live!;
const lastEvent = (rules: Rules) => first(rules).events.at(-1)!.message;

async function withLive(run: (context: { r: Rig; ex: FakeExecutor; rules: Rules; file: string; reopen(): Rules }) => Promise<void>, venues: Parameters<typeof createOilRules>[0]['venues'] = ['binance']) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-live-'));
  const r = rig(), ex = new FakeExecutor(r), file = join(dir, 'oil-rules.sqlite');
  const open = () => createOilRules({ file, venues, books: () => r.books, now: () => r.now, executor: ex });
  let rules = open();
  try { await run({ r, ex, rules, file, reopen: () => { rules.close(); rules = open(); return rules; } }); }
  finally { rules.close(); rmSync(dir, { recursive: true, force: true }); }
}
function goLive(rules: Rules, overrides: Partial<Record<keyof RuleConfig, unknown>> = {}): string {
  rules.create({ config: settings(overrides) });
  const view = first(rules);
  rules.act(view.id, 'live', { revision: view.revision, confirmLive: true });
  return view.id;
}
async function feed(r: Rig, rules: Rules, [bz, cl]: [[string, string], [string, string]], times = 1): Promise<void> {
  for (let i = 0; i < times; i++) { r.now += 3_000; r.set(bz, cl); await rules.tick(); }
}
/** Feeds open books until the rule confirms an open, then ends the job with these fills. */
async function openWith(r: Rig, ex: FakeExecutor, rules: Rules, status: string, fills: [string, string]) {
  const before = ex.confirms.length;
  await feed(r, rules, OPEN, 2);
  assert.equal(ex.confirms.length, before + 1, '两份新盘口后确认开仓');
  ex.finish(status, fills);
  await rules.tick();
}

test('实盘：开仓 → 持仓 → 平仓 → 等待开仓；意图、会话、复核与每日次数', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  assert.deepEqual([first(rules).mode, live(rules).enabled, live(rules).phase], ['live', true, 'idle']);
  await feed(r, rules, OPEN);
  assert.equal(ex.previews.length, 0, '一次满足不触发');
  await feed(r, rules, OPEN);
  assert.equal(ex.previews.length, 1);
  assert.deepEqual(ex.previews[0], {
    session: `oil-rule:${id}`,
    intent: { market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 60_000, legs: [
      // Threshold bounds (docs/hynix.md 8.2): BZ bid 74.10 against the 74.05 at which CL ask 70.05 meets 4, half the slack each.
      { venue: 'binance', symbol: 'CLUSDT', side: 'long', orderType: 'market', barrels: '1', priceBound: '70.075' },
      { venue: 'binance', symbol: 'BZUSDT', side: 'short', orderType: 'market', barrels: '1', priceBound: '74.075' },
    ] },
  });
  assert.equal(ex.confirms.length, 1);
  assert.deepEqual([ex.confirms[0]!.session, ex.confirms[0]!.body.confirmLive], [`oil-rule:${id}`, true]);
  let state = live(rules);
  assert.deepEqual([state.phase, state.pending, state.job?.action, state.opensToday], ['opening', null, 'open', 1]);
  // A running job is followed; nothing else is judged meanwhile.
  await feed(r, rules, OPEN, 3);
  assert.deepEqual([ex.previews.length, live(rules).phase, first(rules).observation!.note], [1, 'opening', '开仓任务执行中']);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  state = live(rules);
  assert.equal(state.phase, 'holding');
  assert.deepEqual(state.held, [{ symbol: 'CLUSDT', side: 'long', quantity: '1', barrels: '1' }, { symbol: 'BZUSDT', side: 'short', quantity: '1', barrels: '1' }]);
  // Holding: the open condition no longer counts, the close condition does.
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 1);
  await feed(r, rules, CLOSE, 2);
  assert.equal(ex.previews.length, 2);
  assert.deepEqual(ex.previews[1]!.intent.legs.map(leg => [leg.symbol, leg.side, leg.quantity, leg.barrels]), [['CLUSDT', 'long', '1', undefined], ['BZUSDT', 'short', '1', undefined]]);
  assert.equal(ex.previews[1]!.intent.action, 'close');
  assert.equal(live(rules).phase, 'closing');
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  state = live(rules);
  assert.deepEqual([state.phase, state.held, state.job, state.opensToday, state.failures], ['idle', null, null, 1, 0]);
  assert.match(lastEvent(rules), /^平仓完成/);
}));

test('实盘：下单前按预览的两腿盘口复核阈值，不满足不确认、不计失败、重新计数', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules);
  ex.planBooks = [
    { venue: 'binance', symbol: 'BZUSDT', bid: '73.90', ask: '73.95', receivedAt: r.now + 6_000, error: null },
    { venue: 'binance', symbol: 'CLUSDT', bid: '70.00', ask: '70.05', receivedAt: r.now + 6_000, error: null },
  ];
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([ex.previews.length, ex.confirms.length], [1, 0]);
  assert.match(lastEvent(rules), /下单前复核未通过（预览盘口价差 3\.85，阈值 4）/);
  assert.deepEqual([live(rules).phase, live(rules).failures, live(rules).opensToday], ['idle', 0, 0]);
  await feed(r, rules, OPEN);
  assert.equal(ex.previews.length, 1, '复核失败后重新计数');
}));

test('实盘：预览拒绝——合约被占、执行器失去写入权或同合约有反向仓位（隐式减仓）等 60 秒不计失败，盘口过期重新计数，其它拒绝连续 3 次停用', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules);
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([live(rules).failures, live(rules).retryAt !== null], [0, true]);
  await feed(r, rules, OPEN, 5);
  assert.equal(ex.previews.length, 1, '等待期间不再预览');
  assert.match(first(rules).observation!.note!, /^等待重试/);
  r.now += RETRY_MS;
  // An executor that lost its writer (stopping or replaced) waits the same way.
  ex.previewError = new ContractError(503, 'writer_lost', '执行器写入权已失去');
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([ex.previews.length, live(rules).failures, live(rules).retryAt !== null], [2, 0, true]);
  r.now += RETRY_MS;
  // The other side of the contract held on a one-way account (e.g. a gold-oil job's oil leg): waits, never disables, and
  // the same note is written once however long it lasts.
  ex.previewError = new ContractError(409, 'implicit_reduce', 'Binance CLUSDT 单向模式已有反向仓位，开仓会变成隐式减仓');
  const notes = first(rules).events.length;
  for (let i = 0; i < 4; i++) {
    await feed(r, rules, OPEN, 2);
    assert.deepEqual([live(rules).failures, live(rules).enabled, live(rules).retryAt !== null], [0, true, true]);
    r.now += RETRY_MS;
  }
  assert.equal(ex.previews.length, 6);
  assert.match(lastEvent(rules), /隐式减仓；同合约有其他仓位（可能是金油任务），等待 60 秒，不计失败$/);
  assert.equal(first(rules).events.length, notes + 1, '原因不变时只记一条');
  ex.previewError = new ContractError(409, 'quote_stale', '盘口已过期');
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([ex.previews.length, live(rules).failures, live(rules).retryAt], [7, 0, null]);
  assert.match(lastEvent(rules), /重新计数，不计失败/);
  ex.previewError = new ContractError(409, 'account_missing', 'Binance 尚未绑定已核验的账户');
  for (let i = 1; i <= 3; i++) {
    await feed(r, rules, OPEN, 2);
    assert.equal(live(rules).failures, i);
    r.now += RETRY_MS;
  }
  const state = live(rules);
  assert.deepEqual([state.enabled, state.phase], [false, 'idle']);
  assert.match(state.reason!, /^连续 3 次失败，规则已停用：Binance 尚未绑定已核验的账户/);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 10, '停用后不再预览');
}));

test('实盘：被同合约反向仓位阻塞满 30 分钟发一次持久通知（重启不丢、交给通知队列后不重发），页面显示阻塞；预览通过后恢复并只记一条恢复', () => withLive(async ({ r, ex, rules: initial, reopen }) => {
  let rules = initial;
  goLive(rules);
  ex.previewError = new ContractError(409, 'implicit_reduce', 'Binance CLUSDT 单向模式已有反向仓位，开仓会变成隐式减仓');
  await feed(r, rules, OPEN, 2);
  const since = (live(rules) as unknown as { blocked: { since: number; notified: boolean } }).blocked;
  assert.deepEqual(since, { since: r.now, lastAt: r.now, notified: false });
  while (r.now - since.since < BLOCKED_NOTIFY_MS - RETRY_MS) {
    r.now += RETRY_MS;
    await feed(r, rules, OPEN, 2);
    assert.deepEqual(rules.notices(), [], '不满 30 分钟不通知');
  }
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([live(rules).enabled, live(rules).failures], [true, 0]);
  const [notice, ...more] = rules.notices();
  assert.equal(more.length, 0);
  assert.equal(notice!.key, `oil-rule-blocked:${first(rules).id}:${since.since}`);
  assert.match(notice!.text, /^【原油自动规则受阻】.*开仓已连续 3\d 分钟被同合约反向仓位阻塞（同合约有其他仓位（可能是金油任务））；规则不停用/);
  assert.match(lastEvent(rules), /已生成通知交给通知队列；规则继续等待，不停用$/);
  // Written with the rule: a restart before the notifier took it still hands it over.
  rules = reopen();
  assert.deepEqual(rules.notices(), [notice]);
  // A failed hand-over keeps it; a taken one is marked and not offered again.
  const lines: string[] = [], sent: string[] = [];
  handOver(rules, () => { throw new Error('outbox locked'); }, line => lines.push(line));
  assert.deepEqual([rules.notices().length, lines.length], [1, 1]);
  handOver(rules, (key, text) => sent.push(`${key} ${text}`), line => lines.push(line));
  assert.deepEqual([sent.length, rules.notices().length], [1, 0]);
  assert.equal((live(rules) as unknown as { blocked: { notified: boolean } }).blocked.notified, true);
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual(rules.notices(), [], '同一次阻塞只通知一次');
  // The position is gone: the next preview passes, one recovery record, and the rule goes on to confirm.
  const events = first(rules).events.length;
  ex.previewError = null;
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  const added = first(rules).events.slice(events).map(item => item.message);
  assert.equal(added.filter(text => /同合约反向仓位阻塞已解除/.test(text)).length, 1);
  assert.equal((live(rules) as unknown as { blocked: unknown }).blocked, null);
  assert.equal(ex.confirms.length, 1);
  // Blocked again after that open ended unfilled: a new wait with its own key, notified once more after 30 minutes.
  ex.finish('failed', ['0', '0']);
  await rules.tick();
  ex.previewError = new ContractError(409, 'implicit_reduce', 'Binance CLUSDT 单向模式已有反向仓位，开仓会变成隐式减仓');
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  const again = blockedOf(rules)!;
  assert.ok(again.since > since.since);
  for (let i = 0; i < 31; i++) { r.now += RETRY_MS; await feed(r, rules, OPEN, 2); }
  assert.deepEqual(rules.notices().map(item => item.key), [`oil-rule-blocked:${first(rules).id}:${again.since}`]);
}));

const blockedOf = (rules: Rules) => (live(rules) as unknown as { blocked: { since: number; lastAt: number; notified: boolean } | null }).blocked;
test('实盘：受阻间隔超过两个重试周期按新的一次阻塞重新计时；因其他原因被拒清除阻塞', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules);
  ex.previewError = new ContractError(409, 'implicit_reduce', 'Binance CLUSDT 单向模式已有反向仓位，开仓会变成隐式减仓');
  await feed(r, rules, OPEN, 2);
  const start = r.now;
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual(blockedOf(rules), { since: start, lastAt: r.now, notified: false }, '间隔一个重试周期仍是同一次');
  // Nothing refused for three retry periods (the spread fell back, say): the next refusal is a new wait.
  r.now += 3 * RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual(blockedOf(rules), { since: r.now, lastAt: r.now, notified: false });
  // 29 minutes on, then a gap: no notice for the two waits added together.
  for (let i = 0; i < 26; i++) { r.now += RETRY_MS; await feed(r, rules, OPEN, 2); }
  r.now += 3 * RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual(rules.notices(), []);
  // Refused for another reason: no longer blocked.
  r.now += RETRY_MS;
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  await feed(r, rules, OPEN, 2);
  assert.equal(blockedOf(rules), null);
}));

// ---- blocked notices outliving their wait (issue #70) ----------------------------------------------------------------
const implicitReduce = () => new ContractError(409, 'implicit_reduce', 'Binance CLUSDT 单向模式已有反向仓位，开仓会变成隐式减仓');
/** Stands in for the notifier's outbox (feishu notifyOnce): a key is queued once; while `failing` the write throws and nothing is queued. */
function outbox() {
  const keys = new Set<string>();
  const box = {
    queued: [] as string[], failing: false, logs: [] as string[],
    notifyOnce(key: string, _text: string): boolean {
      if (box.failing) throw new Error('outbox locked');
      if (keys.has(key)) return false;
      keys.add(key); box.queued.push(key);
      return true;
    },
    /** One hand-over as the service runs it, with a fresh log limiter so every failure is seen. */
    handOver(rules: Pick<Rules, 'notices' | 'noticeSent'>) { handOver(rules, box.notifyOnce, line => box.logs.push(line)); },
  };
  return box;
}
/** Refuses the rule's opens for another position until a new blocked notice is generated; returns it. */
async function blockUntilNotice(r: Rig, ex: FakeExecutor, rules: Rules): Promise<{ key: string; text: string }> {
  const before = rules.notices().length;
  ex.previewError = implicitReduce();
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  for (let i = 0; i < 40 && rules.notices().length === before; i++) { r.now += RETRY_MS; await feed(r, rules, OPEN, 2); }
  const all = rules.notices();
  assert.equal(all.length, before + 1, '满 30 分钟生成一条新通知');
  return all.at(-1)!;
}

test('实盘：阻塞通知首次入队失败后预览通过解除阻塞，通知仍待交接，队列恢复后只入队一次', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  const notice = await blockUntilNotice(r, ex, rules);
  assert.equal(notice.key, `oil-rule-blocked:${id}:${blockedOf(rules)!.since}`);
  const box = outbox();
  box.failing = true;
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices(), box.logs.length], [[], [notice], 1]);
  // The position is gone before the outbox recovers: the wait ends, the notice does not.
  ex.previewError = null;
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([blockedOf(rules), ex.confirms.length], [null, 1], '预览通过、照常确认一次开仓');
  assert.deepEqual(rules.notices(), [notice]);
  box.failing = false;
  box.handOver(rules);
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], []]);
  assert.equal(ex.confirms.length, 1, '交接通知不额外下单');
}));

test('实盘：阻塞通知连续入队失败后换成其他拒绝码清除阻塞，通知仍待交接、只入队一次；规则判断照常', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules);
  const notice = await blockUntilNotice(r, ex, rules);
  const box = outbox();
  box.failing = true;
  for (let i = 0; i < 3; i++) { box.handOver(rules); r.now += RETRY_MS; await feed(r, rules, OPEN, 2); }
  assert.deepEqual([box.queued, rules.notices()], [[], [notice]]);
  // Refused for another reason: the wait is cleared, the rule waits for the locked contract as before.
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([blockedOf(rules), live(rules).failures, live(rules).enabled], [null, 0, true]);
  assert.match(lastEvent(rules), /symbol_locked|所选合约已有未结束任务/);
  box.handOver(rules);
  assert.deepEqual(rules.notices(), [notice], '队列仍失败时保留');
  box.failing = false;
  box.handOver(rules);
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], []]);
}));

test('实盘：阻塞通知入队失败后间隔超过两个重试周期重新受阻，新阻塞用新键；两条各只入队一次', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  const older = await blockUntilNotice(r, ex, rules);
  const box = outbox();
  box.failing = true;
  box.handOver(rules);
  // No refusal for three retry periods: the next one starts a new wait, which keeps the old notice unsent.
  r.now += 3 * RETRY_MS;
  await feed(r, rules, OPEN, 2);
  const again = blockedOf(rules)!;
  assert.deepEqual(rules.notices(), [older]);
  assert.equal(again.notified, false);
  box.handOver(rules);
  const second = await blockUntilNotice(r, ex, rules);
  assert.equal(second.key, `oil-rule-blocked:${id}:${again.since}`);
  assert.notEqual(second.key, older.key);
  assert.deepEqual(rules.notices(), [older, second]);
  box.failing = false;
  box.handOver(rules);
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[older.key, second.key], []]);
  assert.equal(blockedOf(rules)!.notified, true, '当前阻塞显示已交出');
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.deepEqual(rules.notices(), [], '同一次阻塞不再生成');
}));

test('实盘：阻塞通知入队失败、阻塞清除并停用改回观察后重启，通知仍在、只入队一次', () => withLive(async ({ r, ex, rules: initial, reopen }) => {
  let rules = initial;
  goLive(rules);
  const notice = await blockUntilNotice(r, ex, rules);
  const box = outbox();
  box.failing = true;
  box.handOver(rules);
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.equal(blockedOf(rules), null);
  // A person stops the rule and turns it back to observe: the live state is replaced, the unsent notice stays.
  rules.act(first(rules).id, 'disable', { revision: first(rules).revision });
  rules.act(first(rules).id, 'observe', { revision: first(rules).revision });
  assert.deepEqual([first(rules).mode, rules.notices()], ['observe', [notice]]);
  rules = reopen();
  assert.deepEqual(rules.notices(), [notice], '重启后仍待交接');
  box.handOver(rules);
  box.failing = false;
  box.handOver(rules);
  rules = reopen();
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], []]);
}));

test('实盘：阻塞通知已入队但标记交出失败，阻塞清除与重启后再次交接由队列按键去重，只入队一次', () => withLive(async ({ r, ex, rules: initial, reopen }) => {
  let rules = initial;
  goLive(rules);
  const notice = await blockUntilNotice(r, ex, rules);
  const box = outbox();
  box.handOver({ notices: () => rules.notices(), noticeSent: () => { throw new Error('rules store locked'); } });
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], [notice]]);
  assert.match(box.logs[0]!, /已写入发送队列，但未能标记已交出.*rules store locked/);
  ex.previewError = null;
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  assert.equal(blockedOf(rules), null);
  rules = reopen();
  assert.deepEqual(rules.notices(), [notice]);
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], []]);
}));

test('实盘：旧版本只存在阻塞状态里的未交出通知迁入待交接，阻塞清除后仍能交出；已交出的不再交', () => withLive(async ({ r, ex, rules: initial, file, reopen }) => {
  const id = goLive(initial);
  initial.create({ config: settings({ name: '已交出' }) });
  const other = (initial.view() as { rules: RuleView[] }).rules[1]!, sentId = other.id;
  initial.act(sentId, 'live', { revision: other.revision, confirmLive: true });
  const since = r.now - BLOCKED_NOTIFY_MS;
  const db = new DatabaseSync(file);
  const old = (notified: boolean) => JSON.stringify({ since, lastAt: r.now, notice: '【原油自动规则受阻】旧通知', notified });
  db.prepare("UPDATE rules SET state = json_remove(json_set(state, '$.live.blocked', json(?)), '$.unsent') WHERE id = ?").run(old(false), id);
  db.prepare("UPDATE rules SET state = json_remove(json_set(state, '$.live.blocked', json(?)), '$.unsent') WHERE id = ?").run(old(true), sentId);
  db.close();
  let rules = reopen();
  const notice = { key: `oil-rule-blocked:${id}:${since}`, text: '【原油自动规则受阻】旧通知' };
  assert.deepEqual(rules.notices(), [notice]);
  assert.deepEqual(blockedOf(rules), { since, lastAt: r.now, notified: false }, '页面阻塞字段不变');
  // The wait ends before the hand-over, written in the new form; the notice survives it and another restart.
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  await feed(r, rules, OPEN, 2);
  assert.equal(blockedOf(rules), null);
  rules = reopen();
  const box = outbox();
  box.handOver(rules);
  box.handOver(rules);
  assert.deepEqual([box.queued, rules.notices()], [[notice.key], []]);
}));

test('删除规则时未交出的阻塞通知随规则一起删除', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules);
  await blockUntilNotice(r, ex, rules);
  ex.previewError = new ContractError(409, 'symbol_locked', '所选合约已有未结束任务');
  r.now += RETRY_MS;
  await feed(r, rules, OPEN, 2);
  rules.act(first(rules).id, 'disable', { revision: first(rules).revision });
  rules.act(first(rules).id, 'delete', { revision: first(rules).revision });
  assert.deepEqual(rules.notices(), []);
}));

test('服务循环交接规则通知：读通知抛错只记日志（限频）、循环照常、无未处理拒绝；带 notifyOnce 时交给队列后标记', async () => {
  const h = createHarness();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  try {
    bindAccounts(h.ex);
    const options = { connectors: [h.binance, h.bybit] as never, accounts: SIM_BINDINGS as never, now: () => h.clock.now };
    const oil = { config: { accounts: SIM_BINDINGS }, market: createOilMarket(options), hynix: createHynixMarket(options), goldoil: createGoldOilMarket(options) } as unknown as OilRuntime;
    const run = async (rules: OilRulesRuntime, notifyOnce: (key: string, text: string) => unknown) => {
      const logs: string[] = [];
      let rounds = 0;
      await Promise.all(oilLoops(oil, { stopped: () => rounds >= 12, pause: async () => { rounds++; await new Promise(resolve => setImmediate(resolve)); } }, line => logs.push(line), rules, undefined, undefined, notifyOnce));
      return { logs, rounds };
    };
    let ticks = 0;
    const broken = { tick: async () => { ticks++; }, notices: () => { throw new Error('rules store locked'); }, noticeSent: () => {} } as unknown as OilRulesRuntime;
    const failed = await run(broken, () => true);
    assert.ok(ticks >= 2, '读通知抛错后仍继续判断');
    assert.equal(failed.logs.filter(line => /通知读取失败：rules store locked/.test(line)).length, 1, '一分钟内只记一次');
    // The service's wiring: notices go to notifyOnce, then are marked; a marked one is not offered again.
    const queue: string[] = [], sent: string[] = [];
    let waiting = [{ key: 'oil-rule-blocked:r1:1', text: '【原油自动规则受阻】…' }];
    const rules = { tick: async () => {}, notices: () => waiting, noticeSent: (key: string) => { sent.push(key); waiting = waiting.filter(item => item.key !== key); } } as unknown as OilRulesRuntime;
    await run(rules, (key, text) => { queue.push(`${key} ${text}`); return true; });
    assert.deepEqual([queue, sent], [['oil-rule-blocked:r1:1 【原油自动规则受阻】…'], ['oil-rule-blocked:r1:1']]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(rejections, []);
  } finally { process.off('unhandledRejection', onRejection); h.dispose(); }
});

test('实盘：确认结果未知时保留待确认，下一轮与重启后用同一请求编号核对，不另发任务；确认已失效则退回', () => withLive(async ({ r, ex, rules: initial, reopen }) => {
  goLive(initial);
  ex.loseAnswer = true;
  r.now += 3_000; r.set(...OPEN); await initial.tick();
  r.now += 3_000; r.set(...OPEN);
  await assert.rejects(initial.tick(), /应答丢失/);
  assert.deepEqual([live(initial).phase, live(initial).pending?.action, live(initial).job], ['opening', 'open', null]);
  assert.match(lastEvent(initial), /确认结果未知：应答丢失；下一轮用同一请求编号核对/);
  // Restart between the lost answer and the replay: the same request id finds the job already written.
  const rules = reopen();
  assert.match(lastEvent(rules), /服务重启：有待确认的下单/);
  await rules.tick();
  assert.equal(ex.confirms.length, 2);
  assert.equal(ex.confirms[1]!.body.requestId, ex.confirms[0]!.body.requestId);
  assert.deepEqual([ex.jobs.size, ex.previews.length, live(rules).phase, live(rules).pending, live(rules).job?.id], [1, 1, 'opening', null, [...ex.jobs.keys()][0]]);
  assert.match(lastEvent(rules), /^核对到开仓任务/);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  // A confirm that cannot tell whether it wrote, then a replay the executor refuses because the preview aged: no job.
  ex.confirmError = new Error('写库失败');
  await feed(r, rules, CLOSE, 1);
  r.now += 3_000; r.set(...CLOSE);
  await assert.rejects(rules.tick(), /写库失败/);
  assert.equal(live(rules).phase, 'closing');
  ex.confirmError = new ContractError(409, 'preview_invalid', '预览已过期');
  await rules.tick();
  const state = live(rules);
  assert.deepEqual([state.phase, state.pending, state.failures, state.held?.length], ['holding', null, 0, 2]);
  assert.equal(ex.jobs.size, 1);
}));

test('实盘：任务结局——没成交退回计一次失败、转人工待核对、部分平仓留在持仓、平仓账户变了转待核对', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules, { barrels: '2' });
  await openWith(r, ex, rules, 'failed', ['0', '0']);
  let state = live(rules);
  assert.deepEqual([state.phase, state.opensToday, state.failures, state.enabled, state.retryAt !== null], ['idle', 0, 1, true, true]);
  assert.match(lastEvent(rules), /两腿都没有成交/);
  r.now += RETRY_MS;
  await openWith(r, ex, rules, 'attention', ['1', '0']);
  state = live(rules);
  assert.deepEqual([state.phase, state.enabled, state.job], ['review', false, null]);
  assert.match(state.reason!, /转人工，已成交 CL 1、BZ 0；规则已停用/);
  assert.throws(() => rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true }), code('rule_review'));
  rules.act(id, 'reset', { revision: first(rules).revision });
  state = live(rules);
  assert.deepEqual([state.phase, state.enabled, state.held, state.reason], ['idle', false, null, null]);
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  await openWith(r, ex, rules, 'completed', ['2', '2']);
  assert.equal(live(rules).phase, 'holding');
  // A partly filled close keeps the equal remainder and waits for the close condition again.
  await feed(r, rules, CLOSE, 2);
  ex.finish('completed', ['0.5', '0.5']);
  await rules.tick();
  state = live(rules);
  assert.equal(state.phase, 'holding');
  assert.deepEqual(state.held!.map(leg => leg.quantity), ['1.5', '1.5']);
  assert.match(lastEvent(rules), /部分平仓：.*剩余每腿 1\.5 桶/);
  // The account was rebound since the open: no close on the new account.
  ex.account = { accountKey: 'binance:other', credentialVersion: 1 };
  const confirms = ex.confirms.length;
  await feed(r, rules, CLOSE, 2);
  assert.equal(ex.confirms.length, confirms);
  assert.deepEqual([live(rules).phase, live(rules).enabled], ['review', false]);
  assert.match(live(rules).reason!, /执行账户或凭据版本与开仓时不同/);
  // A job the executor no longer has goes to review too.
  ex.account = ACCOUNT;
  rules.act(id, 'reset', { revision: first(rules).revision });
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  await feed(r, rules, OPEN, 2);
  ex.jobs.clear();
  await rules.tick();
  assert.match(live(rules).reason!, /记录读不到/);
}));

test('实盘：每日开仓次数按北京时间计，满额当天不再预览，次日恢复', () => withLive(async ({ r, ex, rules }) => {
  goLive(rules, { maxOpensPerDay: 1 });
  await openWith(r, ex, rules, 'completed', ['1', '1']);
  await feed(r, rules, CLOSE, 2);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).opensToday], ['idle', 1]);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 2);
  assert.equal(first(rules).observation!.note, '今日已开仓 1 次，达到每日上限');
  // 02:00 UTC is 10:00 in Beijing; 16 hours later is the next Beijing day.
  const day = beijingDay(r.now);
  r.now += 16 * 3_600_000;
  assert.notEqual(beijingDay(r.now), day);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 3);
  assert.equal(live(rules).opensToday, 1);
}));

test('实盘：页面操作——启用中不能修改，执行中不能改与删，持仓时不能改方向，停用后任务照常跟到结束；预览期间改规则则本次不下单', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  const revision = () => first(rules).revision;
  assert.throws(() => rules.act(id, 'live', { revision: revision(), confirmLive: true }), code('already_live'));
  assert.throws(() => rules.act(id, 'start', { revision: revision() }), code('live_rule'));
  assert.throws(() => rules.act(id, 'enable', { revision: revision() }), code('confirm_required'));
  assert.throws(() => rules.act(id, 'observe', { revision: revision() }), code('rule_holding'));
  assert.throws(() => rules.update(id, { revision: revision(), config: settings({ barrels: '1000' }) }), code('rule_enabled'));
  await feed(r, rules, OPEN, 2);
  assert.equal(live(rules).phase, 'opening');
  assert.throws(() => rules.update(id, { revision: revision(), config: settings({ openThreshold: '5' }) }), code('rule_busy'));
  assert.throws(() => rules.act(id, 'delete', { revision: revision() }), code('rule_holding'));
  assert.throws(() => rules.act(id, 'reset', { revision: revision() }), code('not_resettable'));
  rules.act(id, 'disable', { revision: revision() });
  assert.match(lastEvent(rules), /执行中的任务继续/);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).enabled], ['holding', false]);
  assert.throws(() => rules.update(id, { revision: revision(), config: settings({ direction: 'long', openThreshold: '3', closeThreshold: '4' }) }), code('rule_holding'));
  rules.update(id, { revision: revision(), config: settings({ closeThreshold: '2.9' }) });
  assert.throws(() => rules.act(id, 'delete', { revision: revision() }), code('rule_holding'));
  assert.throws(() => rules.act(id, 'observe', { revision: revision() }), code('rule_holding'));
  // Disabled while holding: nothing is judged.
  await feed(r, rules, [['72', '72.01'], ['70.05', '70.10']], 3);
  assert.equal(ex.previews.length, 1);
  rules.act(id, 'reset', { revision: revision() });
  assert.deepEqual([live(rules).phase, live(rules).held, live(rules).opensToday], ['idle', null, 1]);
  // The page disables the rule while the preview reads the venue: the plan is dropped, nothing is confirmed.
  rules.act(id, 'enable', { revision: revision(), confirmLive: true });
  let release!: () => void;
  ex.gate = new Promise(resolve => { release = resolve; });
  r.now += 3_000; r.set(...OPEN); await rules.tick();
  r.now += 3_000; r.set(...OPEN);
  const pending = rules.tick();
  await new Promise(resolve => setImmediate(resolve));
  rules.act(id, 'disable', { revision: revision() });
  release();
  await pending;
  ex.gate = null;
  assert.deepEqual([ex.previews.length, ex.confirms.length, live(rules).phase, live(rules).enabled], [2, 1, 'idle', false]);
  rules.act(id, 'observe', { revision: revision() });
  assert.deepEqual([first(rules).mode, first(rules).live, first(rules).observing], ['observe', null, false]);
  rules.act(id, 'delete', { revision: revision() });
}));

test('实盘：一条规则预览期间页面停用另一条，后台不会用旧状态写回启用', () => withLive(async ({ r, ex, rules }) => {
  const a = goLive(rules, { name: 'A' });
  const byId = (id: string) => (rules.view() as { rules: RuleView[] }).rules.find(rule => rule.id === id)!;
  // B is on Bybit, whose books the rig never has: each round B records the read error, a write that is not held back by
  // the fresh-books wait the page's disable starts.
  rules.create({ config: settings({ name: 'B', venue: 'bybit' }) });
  const b = (rules.view() as { rules: RuleView[] }).rules.at(-1)!.id;
  rules.act(b, 'live', { revision: byId(b).revision, confirmLive: true });
  // Both count one hit; next round A triggers first and waits in its preview.
  await feed(r, rules, OPEN, 1);
  let release!: () => void;
  ex.gate = new Promise(resolve => { release = resolve; });
  r.now += 3_000; r.set(...OPEN);
  const round = rules.tick();
  await new Promise(resolve => setImmediate(resolve));
  rules.act(b, 'disable', { revision: byId(b).revision });
  release();
  await round;
  ex.gate = null;
  assert.deepEqual([byId(a).live!.phase, byId(b).live!.enabled, byId(b).live!.phase], ['opening', false, 'idle']);
  assert.match(byId(b).events.at(-1)!.message, /实盘规则已停用/);
  assert.deepEqual(ex.previews.map(item => item.session), [`oil-rule:${a}`]);
}, ['binance', 'bybit']));

test('实盘：停服时若已在预览中等待则中止不再确认下单，后面的规则也不再预览', () => withLive(async ({ r, ex, rules }) => {
  const a = goLive(rules, { name: 'A' });
  rules.create({ config: settings({ name: 'B' }) });
  const b = (rules.view() as { rules: RuleView[] }).rules.at(-1)!;
  rules.act(b.id, 'live', { revision: b.revision, confirmLive: true });
  await feed(r, rules, OPEN, 1);
  let stopped = false, release!: () => void;
  ex.gate = new Promise<void>(resolve => { release = resolve; });
  r.now += 3_000; r.set(...OPEN);
  const ticking = rules.tick(() => stopped);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ex.previews.length, 1);
  stopped = true;
  release();
  await ticking;
  ex.gate = null;
  assert.deepEqual([ex.previews.length, ex.confirms.length], [1, 0]);
  const aView = (rules.view() as { rules: RuleView[] }).rules.find(item => item.id === a)!;
  assert.deepEqual([aView.live!.phase, aView.live!.pending, aView.live!.failures], ['idle', null, 0]);
  await feed(r, rules, OPEN, 2);
  assert.deepEqual([ex.previews.length, ex.confirms.length], [3, 2], '下次启动后两规则均照常判断确认');
}));

test('实盘：任务被手动停止则规则停用；交易所连续拒单 3 次（没成交）规则停用，不再每分钟重试', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  await openWith(r, ex, rules, 'stopped', ['0', '0']);
  let state = live(rules);
  assert.deepEqual([state.phase, state.enabled, state.opensToday, state.reason], ['idle', false, 0, '任务被手动停止，规则已停用']);
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  for (let i = 1; i <= 3; i++) {
    await openWith(r, ex, rules, 'failed', ['0', '0']);
    assert.equal(live(rules).failures, i);
    r.now += RETRY_MS;
  }
  state = live(rules);
  assert.deepEqual([state.enabled, state.phase], [false, 'idle']);
  assert.match(state.reason!, /连续 3 次失败/);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.confirms.length, 4);
  // A completed job clears the count again.
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  await openWith(r, ex, rules, 'failed', ['0', '0']);
  r.now += RETRY_MS;
  await openWith(r, ex, rules, 'completed', ['1', '1']);
  assert.deepEqual([live(rules).phase, live(rules).failures], ['holding', 0]);
}));

test('实盘：停用时还有待确认的下单——执行器没建任务就放弃不再确认，已建任务就跟踪到结束；结果未知只记一次', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules);
  ex.confirmError = new Error('写库失败');
  await feed(r, rules, OPEN, 1);
  r.now += 3_000; r.set(...OPEN);
  await assert.rejects(rules.tick(), /写库失败/);
  await assert.rejects(rules.tick(), /写库失败/);
  await assert.rejects(rules.tick(), /写库失败/);
  assert.equal(first(rules).events.filter(item => /确认结果未知/.test(item.message)).length, 1);
  assert.deepEqual([live(rules).phase, live(rules).opensToday, ex.confirms.length], ['opening', 1, 3]);
  rules.act(id, 'disable', { revision: first(rules).revision });
  ex.confirmError = null;
  await rules.tick();
  let state = live(rules);
  assert.deepEqual([state.phase, state.pending, state.job, state.opensToday, ex.confirms.length, ex.jobs.size], ['idle', null, null, 0, 3, 0]);
  assert.match(lastEvent(rules), /没有任务，已放弃/);
  // The job was written but the answer lost, then the rule is disabled: the job is found without another confirm.
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  ex.loseAnswer = true;
  await feed(r, rules, OPEN, 1);
  r.now += 3_000; r.set(...OPEN);
  await assert.rejects(rules.tick(), /应答丢失/);
  rules.act(id, 'disable', { revision: first(rules).revision });
  await rules.tick();
  state = live(rules);
  assert.deepEqual([state.phase, state.pending, state.job?.action, ex.confirms.length, ex.jobs.size], ['opening', null, 'open', 4, 1]);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).enabled], ['holding', false]);
  // The request id turns out to belong to something else: review, no confirm.
  rules.act(id, 'enable', { revision: first(rules).revision, confirmLive: true });
  ex.loseAnswer = true;
  await feed(r, rules, CLOSE, 1);
  r.now += 3_000; r.set(...CLOSE);
  await assert.rejects(rules.tick(), /应答丢失/);
  rules.act(id, 'disable', { revision: first(rules).revision });
  ex.confirms.at(-1)!.session = 'other-session';
  await rules.tick();
  state = live(rules);
  assert.deepEqual([state.phase, state.enabled, state.pending, ex.confirms.length], ['review', false, null, 5]);
  assert.match(state.reason!, /请求编号被占用/);
}));

test('实盘：改回观察再转实盘不清零当日开仓次数', () => withLive(async ({ r, ex, rules }) => {
  const id = goLive(rules, { maxOpensPerDay: 1 });
  await openWith(r, ex, rules, 'completed', ['1', '1']);
  await feed(r, rules, CLOSE, 2);
  ex.finish('completed', ['1', '1']);
  await rules.tick();
  assert.deepEqual([live(rules).phase, live(rules).opensToday], ['idle', 1]);
  rules.act(id, 'disable', { revision: first(rules).revision });
  rules.act(id, 'observe', { revision: first(rules).revision });
  rules.act(id, 'live', { revision: first(rules).revision, confirmLive: true });
  assert.equal(live(rules).opensToday, 1);
  await feed(r, rules, OPEN, 3);
  assert.equal(ex.previews.length, 2);
}));

test('实盘：整份状态读不了或等待开仓却有持有记录，都转待核对、不能直接删除', () => withLive(async ({ rules: initial, file, reopen }) => {
  goLive(initial);
  initial.create({ config: settings({ name: '坏' }) });
  const db = new DatabaseSync(file);
  db.prepare("UPDATE rules SET state = json_set(state, '$.live.held', json('[{\"symbol\":\"CLUSDT\",\"side\":\"long\",\"quantity\":\"1\",\"barrels\":\"1\",\"accountKey\":\"binance:sim-1\",\"credentialVersion\":1},{\"symbol\":\"BZUSDT\",\"side\":\"short\",\"quantity\":\"1\",\"barrels\":\"1\",\"accountKey\":\"binance:sim-1\",\"credentialVersion\":1}]')) WHERE json_extract(state, '$.mode') = 'live'").run();
  db.prepare("UPDATE rules SET state = '{broken' WHERE json_extract(config, '$.name') = '坏'").run();
  db.close();
  const rules = reopen();
  const [held, broken] = (rules.view() as { rules: RuleView[] }).rules;
  assert.deepEqual([held!.live!.phase, held!.live!.enabled], ['review', false]);
  assert.match(held!.live!.reason!, /持有记录无法读取/);
  assert.deepEqual([broken!.mode, broken!.live!.phase, broken!.live!.enabled], ['live', 'review', false]);
  assert.match(broken!.live!.reason!, /规则状态无法读取/);
  for (const rule of [held!, broken!]) assert.throws(() => rules.act(rule.id, 'delete', { revision: rule.revision }), code('rule_holding'));
}));

test('实盘之前的旧规则（状态没有 mode 与 live 字段）仍读成观察规则，可直接删除', () => withLive(async ({ rules: initial, file, reopen }) => {
  initial.create({ config: settings({ name: '旧' }), observing: true });
  const db = new DatabaseSync(file);
  db.prepare("UPDATE rules SET state = json_remove(state, '$.mode', '$.live')").run();
  db.close();
  const rules = reopen();
  const old = first(rules);
  assert.deepEqual([old.mode, old.live, old.observing], ['observe', null, true]);
  rules.act(old.id, 'delete', { revision: old.revision });
}));

test('实盘：状态读不了的规则转待核对并停用；版本 1 的库打开后升到 2', () => withLive(async ({ rules: initial, file, reopen }) => {
  goLive(initial);
  initial.create({ config: settings({ name: '旧' }) });
  const db = new DatabaseSync(file);
  db.prepare("UPDATE rules SET state = json_set(state, '$.live.phase', 'opening') WHERE json_extract(state, '$.mode') = 'live'").run();
  db.exec('PRAGMA user_version = 1');
  db.close();
  const rules = reopen();
  const check = new DatabaseSync(file);
  assert.equal((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 2);
  check.close();
  const [broken, old] = (rules.view() as { rules: RuleView[] }).rules;
  assert.deepEqual([broken!.live!.phase, broken!.live!.enabled], ['review', false]);
  assert.match(broken!.live!.reason!, /下单记录无法读取/);
  assert.deepEqual([old!.mode, old!.live], ['observe', null]);
}));

test('实盘端到端：真实执行器与模拟交易所上开平一轮，规则持有量与交易所仓位一致', async () => {
  const h = createHarness();
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-live-'));
  try {
    bindAccounts(h.ex);
    const books = (): BookRow[] => ['BZUSDT', 'CLUSDT'].map(symbol => {
      const book = h.binance.books.get(symbol)!;
      return { venue: 'binance', symbol, bid: book.bid, ask: book.ask, receivedAt: h.clock.now, error: null };
    });
    // h.ex is replaced on restart, so the rules always call the current instance.
    const executor: RuleExecutor = { preview: (intent, session) => h.ex.preview(intent, session), confirm: (body, session) => h.ex.confirm(body, session), jobView: id => h.ex.jobView(id), confirmedJob: (requestId, previewId, session) => h.ex.confirmedJob(requestId, previewId, session) };
    const rules = createOilRules({ file: join(dir, 'oil-rules.sqlite'), venues: ['binance'], books, now: () => h.clock.now, executor });
    try {
      // Binance BZ 74.10/74.12, CL 70.00/70.02: selling the spread gets 4.08.
      const id = goLive(rules, { barrels: '1.5', closeThreshold: '3.05' });
      for (let i = 0; i < 2; i++) { h.advance(3_000); await rules.tick(); }
      const opening = live(rules);
      assert.equal(opening.phase, 'opening', lastEvent(rules));
      const opened = await settle(h, opening.job!.id);
      assert.equal(opened.status, 'completed', opened.reason ?? '');
      await rules.tick();
      assert.deepEqual(live(rules).held!.map(leg => [leg.symbol, leg.side, leg.quantity]), [['CLUSDT', 'long', '1.5'], ['BZUSDT', 'short', '1.5']]);
      assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '1.5');
      assert.equal(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '1.5');
      // Buying the spread back costs BZ ask − CL bid: 73.02 − 70.00 = 3.02 ≤ 3.05.
      h.binance.setBook('BZUSDT', { bid: '73.00', ask: '73.02' });
      for (let i = 0; i < 2; i++) { h.advance(3_000); await rules.tick(); }
      const closing = live(rules);
      assert.equal(closing.phase, 'closing', lastEvent(rules));
      const closed = await settle(h, closing.job!.id);
      assert.equal(closed.status, 'completed', closed.reason ?? '');
      await rules.tick();
      assert.deepEqual([live(rules).phase, live(rules).held, live(rules).opensToday], ['idle', null, 1]);
      assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'BZUSDT', 'short'), '0'), 0);
      assert.equal(cmp(h.binance.position(SIM_ACCOUNTS.binance, 'CLUSDT', 'long'), '0'), 0);
      assert.equal(h.ex.recentJobs(5).length, 2);
      assert.ok(id);
    } finally { rules.close(); }
  } finally { h.dispose(); rmSync(dir, { recursive: true, force: true }); }
});

test('页面按钮与服务端一致：每个阶段页面给出的操作服务端都接受，没给出的都拒绝', () => withLive(async ({ r, ex, rules, file }) => {
  const ACTIONS = ['start', 'stop', 'live', 'enable', 'disable', 'observe', 'reset', 'delete'] as const;
  const dir = mkdtempSync(join(tmpdir(), 'tp-oil-agree-'));
  let copies = 0;
  /** Each action is tried on a copy of the store, so the rule under test stays where it is. */
  const accepted = (action: string | 'update') => {
    const copy = join(dir, `copy-${copies++}.sqlite`), source = new DatabaseSync(file);
    source.exec(`VACUUM INTO '${copy}'`); source.close();
    const other = createOilRules({ file: copy, venues: ['binance'], books: () => r.books, now: () => r.now, executor: ex });
    try {
      const rule = first(other) as RuleView & { config: Record<string, unknown> };
      const body = action === 'live' || action === 'enable' ? { revision: rule.revision, confirmLive: true } : { revision: rule.revision };
      if (action === 'update') other.update(rule.id, { revision: rule.revision, config: rule.config });
      else other.act(rule.id, action, body);
      return true;
    } catch (error) { if (error instanceof ContractError) return false; throw error; } finally { other.close(); }
  };
  const agree = (label: string) => {
    const rule = first(rules) as unknown as OilRule;
    const offered = ruleActions(rule, true);
    for (const action of ACTIONS) assert.equal(accepted(action), offered.actions.includes(action), `${label}：${action}`);
    assert.equal(accepted('update'), offered.edit, `${label}：修改`);
  };
  try {
    rules.create({ config: settings() });
    agree('观察已停止');
    const id = first(rules).id, revision = () => first(rules).revision;
    rules.act(id, 'start', { revision: revision() });
    agree('只观察中');
    rules.act(id, 'live', { revision: revision(), confirmLive: true });
    agree('实盘等待开仓');
    await feed(r, rules, OPEN, 2);
    agree('开仓中');
    ex.finish('completed', ['1', '1']);
    await rules.tick();
    agree('持仓中');
    rules.act(id, 'disable', { revision: revision() });
    agree('持仓中已停用');
    rules.act(id, 'enable', { revision: revision(), confirmLive: true });
    await feed(r, rules, CLOSE, 2);
    ex.finish('attention', ['1', '0']);
    await rules.tick();
    agree('待核对');
    rules.act(id, 'reset', { revision: revision() });
    agree('重置后未启用');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}));
