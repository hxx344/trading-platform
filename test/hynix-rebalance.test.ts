// SK hynix single-leg rebalance (docs/hynix.md 7.3): the intent, the preview worked out from the two legs held, the one
// IOC order, the locks on both contracts, the guards before sending, settlement, recovery and the Feishu text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContractError, parseIntent } from '../src/contracts.ts';
import { add, cmp, mul, sub } from '../src/decimal.ts';
import type { OrderRequest } from '../src/connector.ts';
import { SIM_ACCOUNTS } from '../src/simulation.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { SESSION, bindAccounts, createHarness, previewAndConfirm, settle, type Harness } from './harness.ts';

const code = (expected: string) => (error: unknown) => error instanceof ContractError && error.code === expected;
const rebalance = (method: string, extra: Record<string, unknown> = {}) => ({ market: 'hynix', preset: 'rebalance', venue: 'binance', method, timeoutMs: 60_000, ...extra });
const BN = SIM_ACCOUNTS.binance;
/** Short ADR 5 (mid 41.22 → 206.1 USDT) against long ordinary 0.25 (mid 400.2 → 100.05 USDT): 106.05 more short. */
function holdUneven(h: Harness, { adr = '5', ordinary = '0.25' }: { adr?: string; ordinary?: string } = {}): void {
  h.binance.setPosition(BN, 'SKHYUSDT', 'short', adr);
  h.binance.setPosition(BN, 'SKHYNIXUSDT', 'long', ordinary);
}
const lockedSymbols = (h: Harness, jobId: string): string[] =>
  (h.store.db.prepare('SELECT resource FROM locks WHERE job_id = ? ORDER BY resource').all(jobId) as { resource: string }[]).map(row => row.resource.split(':').at(-1) as string).sort();
const lastOrder = (h: Harness): OrderRequest => [...h.binance.orders.values()].at(-1)!.request;
async function withHarness(run: (h: Harness) => Promise<void>) {
  const h = createHarness();
  try { bindAccounts(h.ex); await run(h); } finally { h.dispose(); }
}

test('意图：调平只收交易所、方式与最长时间（可选价格保护）；不收腿、合约、方向与数量；只用于海力士', () => {
  assert.deepEqual(parseIntent(rebalance('reduce')), { market: 'hynix', preset: 'rebalance', venue: 'binance', method: 'reduce', timeoutMs: 60_000, maxSlippageBps: null });
  assert.equal(parseIntent(rebalance('add', { venue: 'bybit', maxSlippageBps: 30 })).maxSlippageBps, 30);
  for (const extra of [{ legs: [] }, { symbol: 'SKHYUSDT' }, { action: 'close' }, { quantity: '1' }, { notional: '10' }, { batches: { count: 2, intervalMs: 0 } }, { batches: { count: 2, intervalMs: 0, fit: true } }, { priceBound: '1' }]) {
    assert.throws(() => parseIntent(rebalance('reduce', extra)), code('unknown_field'), JSON.stringify(extra));
  }
  assert.throws(() => parseIntent(rebalance('reduce', { market: 'oil' })), code('rebalance_market'));
  assert.throws(() => parseIntent(rebalance('flip')), code('invalid_value'));
  assert.throws(() => parseIntent(rebalance('reduce', { maxSlippageBps: 0 })), code('invalid_value'));
  const { method: _method, ...noMethod } = rebalance('reduce');
  assert.throws(() => parseIntent(noMethod), code('missing_field'));
});

test('减仓调平：平多出的一腿到不越平衡点，只减仓 IOC 限价，两个合约都锁定，完成后释放；任务归入海力士列表', () => withHarness(async h => {
  holdUneven(h);
  const preview = await h.ex.preview(rebalance('reduce'), SESSION);
  assert.equal(preview.legs.length, 1);
  const leg = preview.legs[0];
  // 106.05 ÷ 41.22 = 2.5727…, floored to the 0.01 step.
  assert.deepEqual([leg.symbol, leg.side, leg.orderSide, leg.quantity, leg.reduceOnly, leg.orderType], ['SKHYUSDT', 'short', 'buy', '2.57', true, 'market']);
  assert.ok(preview.rebalance);
  const plan = preview.rebalance;
  assert.deepEqual(plan.counter, { symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.25', positionMode: 'one-way' });
  assert.equal(plan.method, 'reduce');
  assert.equal(cmp(plan.before.gap, '106.05'), 0);
  assert.equal(cmp(plan.before.longNotional, '100.05'), 0);
  assert.equal(cmp(plan.before.shortNotional, '206.1'), 0);
  assert.equal(plan.before.netSide, 'short');
  // After a full fill: short 2.43 × 41.22 = 100.1646 against 100.05, still short by a little: the balance point is not crossed.
  assert.equal(cmp(plan.after.gap, '0.1146'), 0);
  assert.equal(plan.after.netSide, 'short');
  assert.ok(preview.notes.some(note => note.includes('减仓调平')), preview.notes.join('\n'));
  const published = h.ex.publicPreview(preview);
  assert.equal(Object.hasOwn(published.legs[0]!, 'accountKey'), false);
  assert.equal(published.rebalance?.method, 'reduce');

  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  assert.deepEqual(lockedSymbols(h, jobId), ['SKHYNIXUSDT', 'SKHYUSDT']);
  const accepted = h.ex.jobView(jobId);
  assert.deepEqual([accepted.preset, accepted.rebalance, accepted.action, accepted.legs.length, accepted.batches], ['rebalance', { method: 'reduce' }, 'close', 1, null]);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.equal(done.reason, null);
  assert.equal(done.legs[0]!.filledQuantity, '2.57');
  const request = lastOrder(h);
  assert.deepEqual([request.symbol, request.side, request.positionSide, request.quantity, request.reduceOnly, request.type, request.timeInForce, request.limitPrice], ['SKHYUSDT', 'buy', 'short', '2.57', true, 'limit', 'ioc', leg.priceBound]);
  assert.equal(h.binance.calls.place, 1);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '2.43');
  assert.equal(h.binance.position(BN, 'SKHYNIXUSDT', 'long'), '0.25');
  assert.equal(done.locked, false);
  assert.deepEqual(lockedSymbols(h, jobId), []);
  assert.deepEqual(h.ex.recentJobs(20, 'hynix').map(job => job.id), [jobId]);
  assert.deepEqual(h.ex.recentJobs(20, 'oil').map(job => job.id), []);
}));

test('加仓调平：加少的一腿到不越平衡点，开仓不带只减仓；完成后两腿名义仍是原来多出的一方略多', () => withHarness(async h => {
  holdUneven(h);
  const preview = await h.ex.preview(rebalance('add'), SESSION);
  const leg = preview.legs[0];
  // 106.05 ÷ 400.2 = 0.26499…, floored to the 0.001 step.
  assert.deepEqual([leg.symbol, leg.side, leg.orderSide, leg.quantity, leg.reduceOnly], ['SKHYNIXUSDT', 'long', 'buy', '0.264', false]);
  assert.deepEqual(preview.rebalance?.counter, { symbol: 'SKHYUSDT', side: 'short', quantity: '5', positionMode: 'one-way' });
  assert.equal(preview.rebalance?.after.netSide, 'short');
  const { jobId } = await previewAndConfirm(h, rebalance('add'));
  assert.deepEqual(lockedSymbols(h, jobId), ['SKHYNIXUSDT', 'SKHYUSDT']);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.deepEqual([done.action, done.preset, done.rebalance], ['open', 'rebalance', { method: 'add' }]);
  assert.equal(lastOrder(h).reduceOnly, false);
  assert.equal(h.binance.position(BN, 'SKHYNIXUSDT', 'long'), '0.514');
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '5');
  const long = mul('0.514', '400.2'), short = mul('5', '41.22');
  assert.ok(cmp(short, long) > 0 && cmp(sub(short, long), '106.05') < 0);
  assert.equal(done.locked, false);
}));

test('不成对或差额过小不能调平：无持仓、单腿、同向、差额不足最小下单量', () => withHarness(async h => {
  await assert.rejects(h.ex.preview(rebalance('reduce'), SESSION), code('rebalance_unpaired'));
  h.binance.setPosition(BN, 'SKHYUSDT', 'short', '5');
  await assert.rejects(h.ex.preview(rebalance('reduce'), SESSION), (error: unknown) => code('rebalance_unpaired')(error) && (error as Error).message.includes('只有单腿'));
  h.binance.setPosition(BN, 'SKHYNIXUSDT', 'short', '0.25');
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), (error: unknown) => code('rebalance_unpaired')(error) && (error as Error).message.includes('方向相同'));
  // 2.42 × 41.22 = 99.7524 against 0.249 × 400.2 = 99.6498: 0.1026 USDT is under either leg's minimum quantity.
  h.binance.setPosition(BN, 'SKHYNIXUSDT', 'short', '0');
  holdUneven(h, { adr: '2.42', ordinary: '0.249' });
  await assert.rejects(h.ex.preview(rebalance('reduce'), SESSION), code('rebalance_too_small'));
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), code('rebalance_too_small'));
  assert.equal(h.binance.calls.place, 0);
}));

test('合约被占用或有外部挂单：预览拒绝；确认时另一腿已被别的任务锁定也拒绝', () => withHarness(async h => {
  holdUneven(h);
  // A cross-venue job on the ADR holds Binance SKHYUSDT.
  const cross = (symbol: string, binanceSide: 'long' | 'short') => ({ market: 'hynix', preset: 'cross-exchange', symbol, action: 'open', timeoutMs: 60_000, legs: [{ venue: 'binance', side: binanceSide, orderType: 'market', notional: '50' }, { venue: 'bybit', side: binanceSide === 'long' ? 'short' : 'long', orderType: 'market', notional: '50' }] });
  const pending = await previewAndConfirm(h, cross('SKHYUSDT', 'short'));
  await assert.rejects(h.ex.preview(rebalance('reduce'), SESSION), code('symbol_locked'));
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), code('symbol_locked'));
  h.store.db.prepare('DELETE FROM locks WHERE job_id = ?').run(pending.jobId);
  h.store.db.prepare("UPDATE jobs SET status = 'failed', final = 1 WHERE id = ?").run(pending.jobId);

  // Previewed while free; then a job takes the ordinary share, which only the rebalance's other leg names.
  const preview = await h.ex.preview(rebalance('reduce'), SESSION);
  assert.equal(preview.legs[0].symbol, 'SKHYUSDT');
  const other = await previewAndConfirm(h, cross('SKHYNIXUSDT', 'long'));
  assert.throws(() => h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('symbol_locked'));
  h.store.db.prepare('DELETE FROM locks WHERE job_id = ?').run(other.jobId);
  h.store.db.prepare("UPDATE jobs SET status = 'failed', final = 1 WHERE id = ?").run(other.jobId);

  // An order of someone else's on either contract: on the other leg (reduce trades the ADR), or on the leg traded (add).
  h.binance.addForeignOrder(BN, 'SKHYNIXUSDT');
  await assert.rejects(h.ex.preview(rebalance('reduce'), SESSION), (error: unknown) => code('external_orders')(error) && (error as Error).message.includes('SKHYNIXUSDT'));
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), (error: unknown) => code('external_orders')(error) && (error as Error).message.includes('SKHYNIXUSDT'));
  assert.equal(h.binance.calls.place, 0);
}));

test('发送前另一腿持仓变化或盘口越过保护界限：不发送，任务失败并释放锁', () => withHarness(async h => {
  holdUneven(h);
  const moved = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.setPosition(BN, 'SKHYNIXUSDT', 'long', '0.3');
  const changed = await settle(h, moved.jobId);
  assert.equal(changed.status, 'failed');
  assert.match(changed.reason ?? '', /SKHYNIXUSDT（另一腿）持仓已变化/);
  assert.equal(changed.locked, false);
  assert.equal(h.binance.calls.place, 0);

  h.binance.setPosition(BN, 'SKHYNIXUSDT', 'long', '0.25');
  const { jobId, preview } = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.setBook('SKHYUSDT', { ask: add(preview.legs[0].priceBound as string, '0.5') });
  const priced = await settle(h, jobId);
  assert.equal(priced.status, 'failed');
  assert.match(priced.reason ?? '', /价格保护界限/);
  assert.equal(h.binance.calls.place, 0);
}));

test('账户读取暂时失败：截止前保留任务稍后再发', () => withHarness(async h => {
  holdUneven(h);
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.inject({ operation: 'account', mode: 'read-fail' });
  await h.ex.tick();
  const waiting = h.ex.jobView(jobId);
  assert.equal(waiting.status, 'accepted');
  assert.match(waiting.reason ?? '', /读取失败/);
  assert.equal(h.binance.calls.place, 0);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.equal(h.binance.calls.place, 1);
}));

test('IOC 部分成交记为完成并写明数量；零成交记为失败；都不补发', () => withHarness(async h => {
  holdUneven(h);
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '1.2' });
  const partial = await settle(h, (await previewAndConfirm(h, rebalance('reduce'))).jobId);
  assert.equal(partial.status, 'completed');
  assert.match(partial.reason ?? '', /调平委托成交 1\.2，计划 2\.57；未成交部分已由交易所撤销/);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '3.8');
  assert.equal(partial.locked, false);
  assert.equal(h.binance.calls.place, 1);

  h.binance.inject({ operation: 'place', mode: 'partial', filled: '0' });
  const none = await settle(h, (await previewAndConfirm(h, rebalance('reduce'))).jobId);
  assert.equal(none.status, 'failed');
  assert.match(none.reason ?? '', /调平委托未成交/);
  // The spread rules' recount codes (docs/hynix.md 8.2) belong to two-leg jobs; a rebalance's zero fill never carries one.
  assert.equal(none.endCode, null);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '3.8');
  assert.equal(none.locked, false);
  assert.equal(h.binance.calls.place, 2);
}));

test('结果未知的调平委托：观察窗加宽限后转人工，两个合约仍锁定，不重发', () => withHarness(async h => {
  holdUneven(h);
  h.binance.inject({ operation: 'place', mode: 'lost-request' });
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  await h.ex.tick();
  // A position nobody can explain keeps the order from being judged never created.
  h.binance.setPosition(BN, 'SKHYUSDT', 'short', '2.43');
  for (let i = 0; i < 16; i++) { h.advance(10_000); await h.ex.tick(); }
  assert.equal(h.ex.jobView(jobId).status, 'running');
  for (let i = 0; i < 3; i++) { h.advance(10_000); await h.ex.tick(); }
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'attention');
  assert.equal(view.legs[0]!.operation?.state, 'unknown');
  assert.deepEqual(lockedSymbols(h, jobId), ['SKHYNIXUSDT', 'SKHYUSDT']);
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), code('symbol_locked'));
  assert.equal(h.binance.calls.place, 1);
}));

test('重启接管：未发送的调平任务失败且不发送；发送中断的委托按原客户订单号核对，不重发', () => withHarness(async h => {
  holdUneven(h);
  const unsent = await previewAndConfirm(h, rebalance('reduce'));
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const failed = h.ex.jobView(unsent.jobId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.locked, false);
  for (let i = 0; i < 3; i++) { await h.ex.tick(); h.advance(1_000); }
  assert.equal(h.binance.calls.place, 0);

  bindAccounts(h.ex);
  h.binance.inject({ operation: 'place', mode: 'lost-response' });
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).legs[0]!.operation?.state, 'unknown');
  h.clock.now += 61_000;
  h.restart();
  assert.equal(h.ex.acquire(), true);
  const held = h.ex.jobView(jobId);
  assert.equal(held.holdNewSends, true);
  assert.match(held.reason ?? '', /调平委托/);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.equal(h.binance.calls.place, 1);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '2.43');
}));

test('飞书：调平消息写交易所、合约、减仓或加仓、数量与成交均价，不提对冲腿', () => withHarness(async h => {
  holdUneven(h);
  const file = join(h.dir, 'notify.sqlite');
  const events = (after: number, limit: number) => h.store.db.prepare('SELECT seq, type, at, json, job_id AS jobId FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(after, limit) as never;
  const latestSeq = () => (h.store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as { seq: number }).seq;
  const notifier = createNotifier({ file, events, latestSeq, pairs: () => [], incidentPair: () => null, job: id => h.ex.jobView(id), feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 'sec' }, fetchImpl: async () => { throw new Error('不发送'); }, now: () => h.clock.now, log: () => undefined });
  const texts = () => { const db = new DatabaseSync(file); try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); } };
  try {
    notifier.poll();
    const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
    notifier.poll();
    assert.equal((await settle(h, jobId)).status, 'completed');
    notifier.poll();
    const sent = texts();
    assert.equal(sent.length, 2, sent.join('\n'));
    assert.match(sent[0]!, /^【海力士调平任务已确认】Binance 减仓调平 ADR（SKHYUSDT）空头，计划 2\.57，可成交价 41\.24（任务 /);
    assert.match(sent[1]!, /^【海力士调平任务完成】Binance 减仓调平 ADR（SKHYUSDT）空头，计划 2\.57，成交 2\.57 均价 41\.24（任务 /);
    assert.ok(sent.every(line => !line.includes('对冲')), sent.join('\n'));
  } finally { notifier.close(); }
}));

test('确认后、发送前请求停止：任务已停止，未发出委托', () => withHarness(async h => {
  holdUneven(h);
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'stopped');
  assert.match(view.reason ?? '', /已停止，未发送任何委托/);
  assert.equal(view.locked, false);
  assert.equal(h.binance.calls.place, 0);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '5');
}));

test('委托已发出后请求停止且零成交：任务记为已停止而不是失败，不补发', () => withHarness(async h => {
  holdUneven(h);
  h.binance.inject({ operation: 'place', mode: 'partial', filled: '0' });
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  await h.ex.tick();
  assert.equal(h.binance.calls.place, 1);
  assert.ok(!['completed', 'failed', 'stopped', 'attention'].includes(h.ex.jobView(jobId).status), h.ex.jobView(jobId).status);
  h.ex.requestStop(jobId, randomUUID(), SESSION);
  const view = await settle(h, jobId);
  assert.equal(view.status, 'stopped', view.reason ?? '');
  assert.match(view.reason ?? '', /调平委托未成交（价格保护界限内没有成交，已由交易所撤销/);
  assert.equal(view.locked, false);
  assert.equal(h.binance.calls.place, 1);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '5');
}));

test('发送前调平腿自身持仓数量变化：不发送，任务失败', () => withHarness(async h => {
  holdUneven(h);
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.setPosition(BN, 'SKHYUSDT', 'short', '4.5');
  const view = await settle(h, jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /Binance SKHYUSDT 持仓已变化，调平委托未发送/);
  assert.equal(view.locked, false);
  assert.equal(h.binance.calls.place, 0);
}));

test('发送前调平腿或另一腿持仓模式变化：不发送，任务失败', () => withHarness(async h => {
  holdUneven(h);
  const modes = h.binance.accounts.get(BN)!.positionModes;
  const target = await previewAndConfirm(h, rebalance('reduce'));
  modes.SKHYUSDT = 'hedge';
  const own = await settle(h, target.jobId);
  assert.equal(own.status, 'failed');
  assert.match(own.reason ?? '', /Binance SKHYUSDT 持仓已变化，调平委托未发送/);
  assert.equal(own.locked, false);
  assert.equal(h.binance.calls.place, 0);

  modes.SKHYUSDT = 'one-way';
  const counter = await previewAndConfirm(h, rebalance('reduce'));
  modes.SKHYNIXUSDT = 'hedge';
  const other = await settle(h, counter.jobId);
  assert.equal(other.status, 'failed');
  assert.match(other.reason ?? '', /Binance SKHYNIXUSDT（另一腿）持仓已变化，调平委托未发送/);
  assert.equal(other.locked, false);
  assert.equal(h.binance.calls.place, 0);
}));

test('发送时调平腿盘口过期：不发送，不等待重试，当轮即失败', () => withHarness(async h => {
  holdUneven(h);
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.setBook('SKHYUSDT', { ageMs: 10_001 });
  await h.ex.tick();
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /Binance SKHYUSDT 盘口已过期（10001 毫秒，上限 10000 毫秒）/);
  assert.equal(view.locked, false);
  assert.equal(h.binance.calls.place, 0);
}));

test('读取失败一直持续到截止：任务以超过最长执行时间结束，没有委托', () => withHarness(async h => {
  holdUneven(h);
  const { jobId } = await previewAndConfirm(h, rebalance('reduce'));
  h.binance.inject({ operation: 'account', mode: 'read-fail', times: 1_000 });
  await h.ex.tick();
  assert.equal(h.ex.jobView(jobId).status, 'accepted');
  h.advance(61_000);
  await h.ex.tick();
  const view = h.ex.jobView(jobId);
  assert.equal(view.status, 'failed');
  assert.match(view.reason ?? '', /任务已超过最长执行时间，未发送/);
  assert.equal(view.locked, false);
  assert.equal(h.binance.calls.place, 0);
}));

test('同一请求编号重复确认返回同一任务；先确认减仓调平后，之前的加仓调平预览确认时被锁拒绝', () => withHarness(async h => {
  holdUneven(h);
  const addPreview = await h.ex.preview(rebalance('add'), SESSION);
  assert.equal(addPreview.legs[0].symbol, 'SKHYNIXUSDT');
  const { jobId, preview, requestId, result } = await previewAndConfirm(h, rebalance('reduce'));
  assert.equal(result.duplicate, false);
  const again = h.ex.confirm({ previewId: preview.id, requestId, confirmLive: true }, SESSION);
  assert.deepEqual([again.duplicate, again.job.id], [true, jobId]);
  assert.throws(() => h.ex.confirm({ previewId: addPreview.id, requestId: randomUUID(), confirmLive: true }, SESSION), code('symbol_locked'));
  assert.deepEqual(h.ex.recentJobs(20, 'hynix').map(job => job.id), [jobId]);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  assert.equal(h.binance.calls.place, 1);
}));

test('加仓调平数量低于最小名义金额：预览拒绝；同样差额的减仓调平不受此限', () => withHarness(async h => {
  // Long ordinary 0.25 (100.05) against short ADR 2.36 (97.2792): adding 2.7708 USDT to the ADR is 0.06, 0.06 × 41.20 = 2.472 < 5.
  holdUneven(h, { adr: '2.36' });
  await assert.rejects(h.ex.preview(rebalance('add'), SESSION), (error: unknown) => code('min_notional')(error) && (error as Error).message.includes('Binance SKHYUSDT 名义金额低于 5 USDT'));
  const reduce = await h.ex.preview(rebalance('reduce'), SESSION);
  assert.deepEqual([reduce.legs[0].symbol, reduce.legs[0].quantity, reduce.legs[0].reduceOnly], ['SKHYNIXUSDT', '0.006', true]);
  assert.equal(h.binance.calls.place, 0);
}));

test('Bybit 账户上的减仓调平：按 Bybit 盘口与步长计算并完成', () => withHarness(async h => {
  const BY = SIM_ACCOUNTS.bybit;
  h.bybit.setPosition(BY, 'SKHYUSDT', 'short', '5');
  h.bybit.setPosition(BY, 'SKHYNIXUSDT', 'long', '0.25');
  const intent = rebalance('reduce', { venue: 'bybit' });
  const { jobId, preview } = await previewAndConfirm(h, intent);
  // Mid 41.24 × 5 = 206.2 against 400.3 × 0.25 = 100.075: 106.125 ÷ 41.24 = 2.573…, floored to the 0.1 step.
  assert.deepEqual([preview.legs[0].venue, preview.legs[0].symbol, preview.legs[0].quantity, preview.legs[0].reduceOnly], ['bybit', 'SKHYUSDT', '2.5', true]);
  assert.deepEqual(lockedSymbols(h, jobId), ['SKHYNIXUSDT', 'SKHYUSDT']);
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  const request = [...h.bybit.orders.values()].at(-1)!.request;
  assert.deepEqual([request.symbol, request.side, request.quantity, request.reduceOnly, request.type, request.timeInForce, request.limitPrice], ['SKHYUSDT', 'buy', '2.5', true, 'limit', 'ioc', preview.legs[0].priceBound]);
  assert.equal(h.bybit.calls.place, 1);
  assert.equal(h.binance.calls.place, 0);
  assert.equal(h.bybit.position(BY, 'SKHYUSDT', 'short'), '2.5');
  assert.equal(h.bybit.position(BY, 'SKHYNIXUSDT', 'long'), '0.25');
  assert.equal(done.locked, false);
}));

test('双向持仓模式账户上的减仓调平：预览记下双向模式，发送前核对通过并完成', () => withHarness(async h => {
  const modes = h.binance.accounts.get(BN)!.positionModes;
  modes.SKHYUSDT = 'hedge';
  modes.SKHYNIXUSDT = 'hedge';
  holdUneven(h);
  const { jobId, preview } = await previewAndConfirm(h, rebalance('reduce'));
  assert.equal(preview.legs[0].positionMode, 'hedge');
  assert.deepEqual(preview.rebalance?.counter, { symbol: 'SKHYNIXUSDT', side: 'long', quantity: '0.25', positionMode: 'hedge' });
  const done = await settle(h, jobId);
  assert.equal(done.status, 'completed', done.reason ?? '');
  const request = lastOrder(h);
  assert.deepEqual([request.symbol, request.side, request.positionSide, request.quantity, request.reduceOnly], ['SKHYUSDT', 'buy', 'short', '2.57', true]);
  assert.equal(h.binance.calls.place, 1);
  assert.equal(h.binance.position(BN, 'SKHYUSDT', 'short'), '2.43');
}));
test('手动调平在另一合约行情已过期或新价格使原方向越过平衡点时不下单', async () => {
  for (const book of [{ ageMs: 60_000 }, { bid: '999', ask: '1000' }]) {
    await withHarness(async h => {
      holdUneven(h);
      const preview = await h.ex.preview(rebalance('reduce'), SESSION);
      const { job } = h.ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, SESSION);
      h.binance.setBook('SKHYNIXUSDT', book);
      await h.ex.tickJobs();
      assert.equal(h.binance.arrived.place, 0);
      assert.match(h.ex.jobView(job.id).reason ?? '', /过期|调平方向或数量/);
    });
  }
});
