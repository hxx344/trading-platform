// The ASTER service: operator files, the takeover checks, fixed reserves, the Feishu outbox, the user stream and the
// wired executor on the ASTER stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractError, DEFAULT_TRANSFER_CONFIG, parseTransferConfig } from '../src/contracts.ts';
import { planTransfer } from '../src/transfer.ts';
import { openStore } from '../src/store.ts';
import { AsterClient, RequestBudget } from '../src/aster/client.ts';
import { assertDistinctSigners, pairWeightPerMinute, parseServiceConfig, parseServiceSecrets, type ServiceConfig, type ServiceSecrets } from '../src/service/config.ts';
import { createTakeoverGuard, TAKEOVER_WINDOW_MS } from '../src/service/takeover.ts';
import { FAULT_AFTER_MS, FAULT_REPEAT_MS, createNotifier, marginProblem, describeEvent, feishuSign, type EventRow, type PairState } from '../src/service/feishu.ts';
import { runUserStream, STREAM_BASE, type SocketLike } from '../src/service/stream.ts';
import { wireService } from '../src/service/main.ts';
import { FakeAster, LONG, MAIN, SHORT, json } from './aster-fake.ts';

/** A switched-on pair with fresh balances read at `at`, threshold 1000, nothing blocked. */
const margin = (long: string, short: string, at: number): PairState => ({
  id: 'p', enabled: true, blocked: null, note: null, noteIdle: false,
  balances: { long: { available: long, receivedAt: at }, short: { available: short, receivedAt: at } }, balancesFresh: true, threshold: '1000',
});
const APP = { index: Buffer.from('<!doctype html><title>统一交易平台 · ASTER</title><script type="module" src="/assets/app-1.js"></script>'), assets: new Map([['app-1.js', { body: Buffer.from('void 0;'), type: 'text/javascript; charset=utf-8' }]]) };

const tempDir = () => mkdtempSync(join(tmpdir(), 'tp-service-'));
const secretsRaw = { accounts: { main: MAIN, a: LONG, b: SHORT } };
const configRaw = (pairs: unknown[] = [{ id: 'p1', main: 'main', long: 'a', short: 'b' }]) => ({ secretsFile: '/etc/tp/secrets.json', pairs });
const refusedWith = (pattern: RegExp) => (error: unknown) => error instanceof ContractError && error.code === 'takeover_refused' && pattern.test(error.message);

test('服务配置：默认值、预留额度与配对校验；密钥文件须覆盖用到的账户', () => {
  const config = parseServiceConfig(configRaw());
  assert.equal(config.port, 4720);
  assert.deepEqual(config.budget, { limitPerMinute: 600, adlReserve: 100 });
  assert.deepEqual(config.pairs[0]!.transfer, { ...DEFAULT_TRANSFER_CONFIG });
  assert.throws(() => parseServiceConfig({ ...configRaw(), secretsFile: 'relative.json' }), /绝对路径/);
  assert.throws(() => parseServiceConfig(configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'a' }])), /三个不同/);
  assert.throws(() => parseServiceConfig(configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'b' }, { id: 'p2', main: 'main', long: 'b', short: 'c' }])), /同一子账户/);
  assert.throws(() => parseServiceConfig(configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'b' }, { id: 'p1', main: 'main', long: 'c', short: 'd' }])), /重复/);
  assert.throws(() => parseServiceConfig({ ...configRaw(), budget: { limitPerMinute: 600, adlReserve: 580 } }), /ADL 预留权重/);
  assert.throws(() => parseServiceConfig({ ...configRaw(), extra: 1 }), /不支持的字段/);
  // A first setup starts with no pair (the page imports them); past the limit is refused.
  assert.deepEqual(parseServiceConfig(configRaw([])).pairs, []);
  assert.throws(() => parseServiceConfig({ ...configRaw(), pairs: {} }), /pairs 须为列表/);
  // The budget follows the pairs: idle use (balances, display, ADL scans) must fit under the limit less the ADL reserve.
  const many = (count: number, transfer?: unknown) => configRaw(Array.from({ length: count }, (_, i) => ({ id: `p${i}`, main: 'main', long: `l${i}`, short: `s${i}`, ...(transfer ? { transfer } : {}) })));
  assert.equal(pairWeightPerMinute(config.pairs[0]!), 260);
  const three = parseServiceConfig(many(3));
  assert.ok(three.budget.limitPerMinute - three.budget.adlReserve >= 3 * 260 + 100, JSON.stringify(three.budget));
  assert.throws(() => parseServiceConfig({ ...many(3), budget: { limitPerMinute: 600 } }), /约需请求权重 880/);
  assert.throws(() => parseServiceConfig(many(8)), /超过本服务可用的 2100/);
  assert.equal(parseServiceConfig(many(8, { checkIntervalMs: 30_000 })).pairs.length, 8);

  const secrets = parseServiceSecrets({ ...secretsRaw, feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef12-3456', secret: 's3cret' } }, ['main', 'a', 'b']);
  assert.equal(secrets.accounts.get('a')!.user, LONG.user);
  assert.deepEqual(secrets.feishu, { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef12-3456', secret: 's3cret' });
  assert.throws(() => parseServiceSecrets(secretsRaw, ['main', 'a', 'c']), /缺少账户 c/);
  assert.throws(() => parseServiceSecrets({ accounts: { main: MAIN, a: MAIN } }, []), /同一个钱包/);
  assert.throws(() => parseServiceSecrets({ ...secretsRaw, feishu: { webhook: 'http://example.com/hook' } }, []), /飞书/);
  // A key that does not derive the signer is named by account, never quoted.
  const wrong = { ...LONG, signer: SHORT.signer };
  assert.throws(() => parseServiceSecrets({ accounts: { a: wrong } }, []), (error: unknown) => error instanceof Error && /账户 a/.test(error.message) && !error.message.includes(LONG.privateKey.slice(2, 12)));
  // A transfer carries no user, so the main account's API wallet must not also sign for a sub-account.
  const sharedWallet = parseServiceSecrets({ accounts: { main: { user: MAIN.user, signer: LONG.signer, privateKey: LONG.privateKey }, a: LONG, b: SHORT } }, ['main', 'a', 'b']);
  assert.throws(() => assertDistinctSigners(config, sharedWallet), /主账户 main 与子账户 a 使用同一个 API 钱包/);
  assertDistinctSigners(config, secrets);
});

test('固定保留额：取比例保留与该侧固定额中较大者', () => {
  const balance = (available: string, equity: string) => ({ accountId: 'x', asset: 'USD1' as const, available, maxWithdraw: available, equity, receivedAt: 0 });
  const balances = { long: balance('300', '400'), short: balance('100', '200') };
  // Half the gap is 100; 5% of 400 = 20 leaves 280 to take.
  assert.deepEqual(planTransfer(balances, parseTransferConfig({})), { source: 'long', destination: 'short', amount: '100' });
  // A fixed 250 on the long side leaves only 50.
  assert.deepEqual(planTransfer(balances, parseTransferConfig({ longReserve: '250' })), { source: 'long', destination: 'short', amount: '50' });
  // The short side's reserve does not limit a transfer out of the long side.
  assert.deepEqual(planTransfer(balances, parseTransferConfig({ shortReserve: '1000' })), { source: 'long', destination: 'short', amount: '100' });
  const blocked = planTransfer(balances, parseTransferConfig({ longReserve: '299.5' }));
  assert.ok('reason' in blocked && /现金保留 299.5 USD1/.test(blocked.reason));
  assert.throws(() => parseTransferConfig({ longReserve: '-1' }), /多侧固定保留额/);
  // Records stored before the field existed plan as before.
  const { longReserve: _l, shortReserve: _s, ...legacy } = parseTransferConfig({});
  assert.deepEqual(planTransfer(balances, legacy as never), { source: 'long', destination: 'short', amount: '100' });
});

function setup() {
  const fake = new FakeAster();
  const client = new AsterClient({ budget: new RequestBudget({ limitPerMinute: 2_400, adlReserve: 100 }), fetchImpl: fake.fetch });
  return { fake, client };
}

test('接管检查：近 10 分钟有非本平台划转、流水不完整、有 ADL 挂单或两侧持仓不对冲时拒绝启用', async () => {
  const { fake, client } = setup();
  const { AsterTransferConnector } = await import('../src/aster/transfer.ts');
  const { AsterTradingConnector } = await import('../src/aster/trading.ts');
  const lookup = (id: string) => [MAIN, LONG, SHORT].find(item => item.user === id)!;
  const transfers = new AsterTransferConnector({ client, credentials: lookup, knownAccounts: () => [LONG.user, SHORT.user] });
  const trading = new AsterTradingConnector({ client, credentials: lookup });
  const now = Date.now();
  const guard = createTakeoverGuard({ transfers, trading, now: () => now });
  const pair = { id: 'p1', mainAccountId: MAIN.user, long: LONG.user, short: SHORT.user, usedReceipts: [{ tranId: '77', at: now - 60_000 }] } as never;

  await guard(pair);
  assert.equal(fake.calls.filter(call => call.path === '/fapi/v3/openOrders' && !('symbol' in call.params)).length, 2, '挂单按全部合约读取');

  fake.income.set(LONG.user, [{ asset: 'USD1', incomeType: 'TRANSFER', income: '-5', tranId: 77, time: now - 60_000 }]);
  await guard(pair);
  fake.income.set(SHORT.user, [{ asset: 'USD1', incomeType: 'TRANSFER', income: '5', tranId: 12_345_678, time: now - 60_000 }]);
  await assert.rejects(guard(pair), refusedWith(/空侧近 10 分钟有 1 笔.*\*\*\*5678/));
  // Older than the window: no longer counted.
  fake.income.set(SHORT.user, [{ asset: 'USD1', incomeType: 'TRANSFER', income: '5', tranId: 12_345_678, time: now - TAKEOVER_WINDOW_MS - 1 }]);
  await guard(pair);

  fake.income.set(SHORT.user, [{ asset: 'USD1', incomeType: 'TRANSFER', income: 'oops', tranId: 3, time: now - 1_000 }]);
  await assert.rejects(guard(pair), refusedWith(/读取不完整/));
  fake.income.delete(SHORT.user);

  fake.openOrders.set(LONG.user, [{ symbol: 'BTCUSDT', clientOrderId: 'adl_0123456789abcdef', orderId: 1 }, { symbol: 'ETHUSDT', clientOrderId: 'manual-1', orderId: 2 }]);
  await assert.rejects(guard(pair), refusedWith(/多侧有未结束的 ADL 减仓挂单（BTCUSDT）/));
  fake.openOrders.set(LONG.user, [{ symbol: 'ETHUSDT', clientOrderId: 'manual-1', orderId: 2 }]);
  await guard(pair);

  // Both sides together must be hedged within 0.5 % of the larger total in every symbol.
  const risk = (user: string, positionSide: 'LONG' | 'SHORT', positionAmt: string) => fake.risk.set(user, [{ symbol: 'BTCUSDT', positionSide, positionAmt, entryPrice: '50000', markPrice: '50000', unRealizedProfit: '0', updateTime: now - 1_000 }]);
  risk(LONG.user, 'LONG', '0.004');
  await assert.rejects(guard(pair), refusedWith(/两侧持仓偏差超过 0.5%：BTCUSDT 多 0.004 \/ 空 0，差 100.000%/));
  risk(SHORT.user, 'SHORT', '-0.004');
  await guard(pair);
  risk(LONG.user, 'LONG', '1');
  risk(SHORT.user, 'SHORT', '-0.995');
  await guard(pair);
  risk(SHORT.user, 'SHORT', '-0.994');
  await assert.rejects(guard(pair), refusedWith(/BTCUSDT 多 1 \/ 空 0.994，差 0.600%/));
  risk(SHORT.user, 'SHORT', '-1.004');
  await guard(pair);
  risk(LONG.user, 'LONG', '0.004');
  risk(SHORT.user, 'SHORT', '-0.004');

  fake.script('GET /fapi/v3/income', () => json({ code: -1001, msg: 'disconnected' }, 500));
  await assert.rejects(guard(pair), refusedWith(/无法读取多侧划转流水/));
});

test('飞书告警：事件转消息，同一持续问题 30 分钟内只发一次，未送达的按退避重发，签名按飞书规则', async () => {
  const dir = tempDir();
  try {
    let clock = 1_800_000_000_000, seq = 0;
    const log: EventRow[] = [];
    const add = (type: string, detail: Record<string, unknown>) => log.push({ seq: ++seq, type, at: clock, json: JSON.stringify(detail) });
    add('transfer-settled', { pair: 'p1', transfer: 'old', basis: 'nonce_expired_unreadable' });
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    let failing = true;
    let pairs: PairState[] = [{ ...margin('0', '0', clock), id: 'p1' }];
    const lines: string[] = [];
    const notifier = createNotifier({
      file: join(dir, 'notify.sqlite'), events: (after, limit) => log.filter(row => row.seq > after).slice(0, limit), latestSeq: () => seq,
      pairs: () => pairs, incidentPair: id => id === 'inc-1' ? 'p1' : null, now: () => clock, log: line => lines.push(line),
      feishu: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdefgh', secret: 'sec' },
      fetchImpl: async (url, init) => {
        posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return failing ? json({ code: 19021, msg: 'sign match fail' }) : json({ code: 0, msg: 'success' });
      },
    });
    // The event from before the notifier existed is not replayed.
    notifier.poll();
    assert.equal(notifier.pending(), 0);

    add('transfer-sent', { pair: 'p1', transfer: 'abcdef1234', state: 'unknown' });
    add('transfer-sent', { pair: 'p1', transfer: 'routine', state: 'acknowledged' });
    add('adl-incident-blocked', { incident: 'inc-1', reason: '挂单未结束' });
    add('adl-incident-blocked', { incident: 'inc-1', reason: '挂单未结束（第二次）' });
    notifier.poll();
    assert.equal(notifier.pending(), 2);
    await notifier.flush();
    assert.equal(posts.length, 1);
    const sent = posts[0]!.body as { timestamp: string; sign: string; msg_type: string; content: { text: string } };
    assert.equal(sent.msg_type, 'text');
    assert.equal(sent.sign, feishuSign(Number(sent.timestamp), 'sec'));
    assert.match(sent.content.text, /【划转结果未知】配对 p1 划转 abcdef12[\s\S]*【ADL 受阻】配对 p1：挂单未结束/);
    assert.ok(lines.some(line => /飞书发送失败：.*19021/.test(line)));
    // Backed off: not due again at once.
    await notifier.flush();
    assert.equal(posts.length, 1);
    failing = false;
    clock += 5_000;
    await notifier.flush();
    assert.equal(posts.length, 2);
    assert.equal(notifier.pending(), 0);

    // The same ongoing problem again after 30 minutes is posted again.
    clock += 30 * 60_000;
    add('adl-incident-blocked', { incident: 'inc-1', reason: '仍未结束' });
    notifier.poll();
    assert.equal(notifier.pending(), 1);

    // An idle note with the gap within the threshold is normal: nothing, however long it lasts (the false alarm of v0.4.3).
    const texts = () => (db => { try { return (db.prepare('SELECT text FROM outbox ORDER BY id').all() as { text: string }[]).map(row => row.text); } finally { db.close(); } })(new DatabaseSync(join(dir, 'notify.sqlite')));
    const pair = (long: string, short: string, over: Partial<PairState> = {}): PairState[] => [{ ...margin(long, short, clock), id: 'p1', ...over }];
    const before = notifier.pending();
    pairs = pair('2000', '1284.3', { note: '两侧可用余额差 715.7 USD1 未超过划转门槛 1000 USD1（须严格大于）', noteIdle: true });
    notifier.poll();
    clock += 30 * 60_000;
    notifier.poll();
    assert.equal(notifier.pending(), before, '差额未超过门槛不告警');

    // Gap above the threshold: reported after 60 s with both balances, the gap and the threshold; repeated every 2 minutes.
    pairs = pair('3000', '1000');
    notifier.poll();
    clock += FAULT_AFTER_MS - 1;
    notifier.poll();
    assert.equal(notifier.pending(), before, '未满 60 秒不告警');
    clock += 1;
    notifier.poll(); notifier.poll();
    assert.equal(notifier.pending(), before + 1);
    assert.match(texts().at(-1)!, /【保证金平衡异常】配对 p1 已持续 60 秒：两侧可用余额差 2000 USD1 超过划转门槛 1000 USD1。两侧可用余额 多 3000 \/ 空 1000 USD1，差额 2000 USD1，划转门槛 1000 USD1（\d\d:\d\d:\d\d 读取）/);
    clock += FAULT_REPEAT_MS - 1;
    notifier.poll();
    assert.equal(notifier.pending(), before + 1);
    clock += 1;
    notifier.poll();
    assert.equal(notifier.pending(), before + 2);
    assert.match(texts().at(-1)!, /【保证金平衡仍异常】配对 p1 已持续 3 分钟/);
    // Balances from before the last settlement, or none at all, neither end nor restart the report.
    pairs = pair('2000', '1500', { balancesFresh: false });
    notifier.poll();
    pairs = pair('2000', '1500', { balances: null, balancesFresh: false });
    notifier.poll();
    assert.equal(notifier.pending(), before + 2, '余额未知不算恢复');
    // Recovery once, with the whole duration.
    pairs = pair('2000', '1500');
    notifier.poll(); notifier.poll();
    assert.equal(notifier.pending(), before + 3);
    assert.match(texts().at(-1)!, /【保证金平衡恢复】配对 p1，异常共约 3 分钟：两侧可用余额 多 2000 \/ 空 1500 USD1，差额 500 USD1/);

    // A confirmed transfer is progress: the 60 s wait restarts, so a pair balancing in steps is not reported; a transfer
    // that did not go through (expired, rejected) is no progress.
    pairs = pair('9000', '1000', { blocked: '本配对有未结清的划转' });
    notifier.poll();
    clock += 50_000;
    add('transfer-settled', { pair: 'p1', transfer: 'step1', state: 'confirmed', basis: 'acknowledged' });
    notifier.poll();
    clock += 50_000;
    add('transfer-settled', { pair: 'p1', transfer: 'step2', state: 'expired-unverified', basis: 'nonce_expired_unreadable' });
    notifier.poll();
    assert.equal(notifier.pending(), before + 3 + 1, '有划转成功，重新计时（另有结清依据的事件通知）');
    clock += 10_000;
    notifier.poll();
    assert.equal(notifier.pending(), before + 5);
    assert.match(texts().at(-1)!, /【保证金平衡异常】配对 p1 已持续 110 秒：本配对有未结清的划转/);
    // An idle note does not hide a gap above the threshold; a switched-off pair is dropped without a recovery notice.
    pairs = pair('9000', '1000', { note: 'ADL 减仓单正在发送或挂单，本轮不划转', noteIdle: true });
    clock += FAULT_REPEAT_MS;
    notifier.poll();
    assert.equal(notifier.pending(), before + 6);
    assert.match(texts().at(-1)!, /仍异常[\s\S]*超过划转门槛 1000 USD1；ADL 减仓单/);
    pairs = [{ ...pairs[0]!, enabled: false }];
    notifier.poll();
    assert.equal(notifier.pending(), before + 6);
    await notifier.flush();
    notifier.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('保证金告警判定：受阻、非空闲说明、差额超过门槛（严格大于）才算异常；余额缺失、过期或读不出时不判定', () => {
  const base = (long: string, short: string, over: Partial<PairState> = {}) => ({ ...margin(long, short, 1), threshold: '10', ...over });
  assert.equal(marginProblem(base('15', '5')), null, '差额等于门槛不算');
  assert.match(String(marginProblem(base('5', '15.01'))), /差 10\.01 USD1 超过划转门槛 10 USD1/);
  assert.equal(marginProblem(base('1', '2', { note: '低于最小划转额', noteIdle: true })), null);
  assert.equal(marginProblem(base('1', '2', { note: '余额读取失败' })), '余额读取失败');
  assert.equal(marginProblem(base('1', '1', { blocked: '本配对有未结清的划转' })), '本配对有未结清的划转');
  assert.equal(marginProblem(base('x', '1')), 'unknown');
  assert.equal(marginProblem(base('100', '1', { balancesFresh: false })), 'unknown', '早于最近一笔结算的余额不判定');
  assert.equal(marginProblem(base('1', '1', { balances: null, balancesFresh: false })), 'unknown');
});

test('飞书告警：未配置机器人时只写日志；事件说明覆盖结算依据与 ADL 结束', () => {
  const dir = tempDir();
  try {
    const lines: string[] = [];
    const notifier = createNotifier({ file: join(dir, 'n.sqlite'), events: () => [], latestSeq: () => 0, pairs: () => [], incidentPair: () => null, feishu: null, log: line => lines.push(line) });
    notifier.notify('【服务启动】测试');
    assert.equal(notifier.pending(), 0);
    assert.deepEqual(lines, ['告警：【服务启动】测试']);
    notifier.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const row = (type: string, detail: unknown): EventRow => ({ seq: 1, type, at: 0, json: JSON.stringify(detail) });
  assert.equal(describeEvent(row('transfer-settled', { pair: 'p', transfer: 't', basis: 'acknowledged' }), () => null), null);
  assert.match(describeEvent(row('transfer-settled', { pair: 'p', transfer: 't', basis: 'nonce_expired_partial_receipt' }), () => null)!.text, /人工核对/);
  assert.match(describeEvent(row('adl-incident-completed', { incident: 'i', unknown: 1 }), () => 'p9')!.text, /配对 p9.*1 笔减仓单结果未知/);
  assert.match(describeEvent(row('adl-incident-completed', { incident: 'i', unknown: 0, residuals: [{ symbol: 'XAGUSD1', quantity: '16.61', direction: 'long' }] }), () => 'p9')!.text, /容差内或不足一手，记为完成）：XAGUSD1 多出多仓 16.61/);
  assert.equal(describeEvent(row('history-pruned', {}), () => null), null);
  // A transfer that was on the wire at the last stop is announced at start, not only when it settles.
  assert.match(describeEvent(row('transfer-recovered', { pair: 'p', transfer: 't', state: 'unknown' }), () => null)!.text, /划转结果未知.*上次停止时正在发送/);
  assert.equal(describeEvent(row('transfer-recovered', { pair: 'p', transfer: 't', state: 'acknowledged' }), () => null), null);
  // Invalid pushes are not called a backlog.
  const invalidOnly = describeEvent(row('adl-push-dropped', { invalid: 2, overflow: 0 }), () => null)!.text;
  assert.match(invalidOnly, /2 条 ADL 成交推送格式无效/);
  assert.doesNotMatch(invalidOnly, /积压/);
  assert.match(describeEvent(row('adl-push-dropped', { invalid: 0, overflow: 5 }), () => null)!.text, /积压，丢弃 5 条；改由历史扫描补齐/);
});

class FakeSocket implements SocketLike {
  listeners: Record<string, ((event: { data: unknown }) => void)[]> = {};
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, data?: unknown): void { for (const listener of this.listeners[type] ?? []) listener({ data }); }
  close(): void { if (!this.closed) { this.closed = true; this.emit('close'); } }
}

test('用户推送：签名创建推送密钥，消息转给连接器，密钥过期即重连，停止后退出', async () => {
  const { fake, client } = setup();
  const sockets: FakeSocket[] = [], pushed: unknown[] = [];
  let stop = false;
  const waiters: (() => void)[] = [];
  const done = runUserStream({
    client, credentials: LONG, accountId: LONG.user, push: (id, event) => { assert.equal(id, LONG.user); pushed.push(event); },
    stopped: () => stop, pause: async () => { await new Promise(resolve => setImmediate(resolve)); },
    connect: url => { const socket = new FakeSocket(url); sockets.push(socket); queueMicrotask(() => { socket.emit('open'); waiters.shift()?.(); }); return socket; },
    log: () => undefined,
  });
  const opened = () => new Promise<void>(resolve => waiters.push(resolve));
  await opened();
  assert.equal(sockets[0]!.url, `${STREAM_BASE}key1`);
  const create = fake.calls.find(call => call.method === 'POST' && call.path === '/fapi/v3/listenKey')!;
  assert.equal(create.params.user, LONG.user);
  sockets[0]!.emit('message', JSON.stringify({ e: 'ORDER_TRADE_UPDATE', o: { c: 'adl_autoclose' } }));
  assert.equal(pushed.length, 1);
  const next = opened();
  sockets[0]!.emit('message', JSON.stringify({ e: 'listenKeyExpired' }));
  await next;
  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.closed, true);
  assert.equal(sockets[1]!.url, `${STREAM_BASE}key2`);
  // Malformed messages end the connection instead of reaching the connector.
  const third = opened();
  sockets[1]!.emit('message', '{"e": 5}');
  await third;
  assert.equal(pushed.length, 1);
  stop = true;
  sockets[2]!.close();
  await done;
});

async function wired(fake: FakeAster, store: ReturnType<typeof openStore>, config: ServiceConfig, lines: string[] = []) {
  const secrets: ServiceSecrets = { accounts: new Map([['main', MAIN], ['a', LONG], ['b', SHORT]]), feishu: null };
  return wireService(config, secrets, store, { fetchImpl: fake.fetch, log: line => lines.push(line) });
}

test('服务装配：配对登记为停用，启用前做接管检查（含两侧对冲）；停用的配对不做 ADL；配置删掉的配对启动时停用', async () => {
  const dir = tempDir();
  const store = openStore(join(dir, 'executor-live.sqlite'));
  const fake = new FakeAster();
  try {
    // Four takeover checks in a row (each reads open orders, income and positions of both sides) need more than the default.
    const config = parseServiceConfig({ ...configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'b', transfer: { longReserve: '5' } }]), budget: { limitPerMinute: 1200 } });
    let { executor, trading } = await wired(fake, store, config);
    assert.equal(executor.environment, 'mainnet');
    const [pair] = executor.transferPairs();
    assert.equal(pair!.enabled, false);
    assert.equal(pair!.config.longReserve, '5');

    // An ADL on a pair not yet taken over is left to the workbench: its pushes are not recorded and nothing is sent.
    const risk = (amount: string, side: 'LONG' | 'SHORT', at: number) => [{ symbol: 'BTCUSDT', positionSide: side, positionAmt: amount, entryPrice: '50000', markPrice: '50000', unRealizedProfit: '0', updateTime: at }];
    const adlPush = (at: number) => ({ e: 'ORDER_TRADE_UPDATE', E: at, T: at, o: { s: 'BTCUSDT', c: 'adl_autoclose', S: 'BUY', ps: 'SHORT', q: '0.004', z: '0.004', X: 'FILLED', ap: '50000', i: 1, T: at } });
    const now = Date.now();
    fake.risk.set(LONG.user, risk('0.004', 'LONG', now - 1_000));
    fake.accounts.get(LONG.user)!.positions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.004' }];
    fake.risk.set(SHORT.user, risk('0', 'SHORT', now - 1_000));
    trading.push(SHORT.user, adlPush(now - 500));
    for (let i = 0; i < 3; i++) await executor.tickAdl();
    assert.equal(fake.count('/fapi/v3/order'), 0);
    assert.equal(executor.recentAdlIncidents(10).length, 0);

    // A foreign transfer within the window refuses the takeover, and so does a hedge that is already off.
    fake.income.set(LONG.user, [{ asset: 'USD1', incomeType: 'TRANSFER', income: '-3', tranId: 991, time: now - 30_000 }]);
    await assert.rejects(executor.setTransferEnabled({ pairId: 'p1', enabled: true, requestId: randomUUID() }, 's'), refusedWith(/多侧近 10 分钟/));
    fake.income.delete(LONG.user);
    await assert.rejects(executor.setTransferEnabled({ pairId: 'p1', enabled: true, requestId: randomUUID() }, 's'), refusedWith(/两侧持仓偏差超过 0.5%：BTCUSDT 多 0.004 \/ 空 0/));
    assert.equal(executor.transferPairs()[0]!.enabled, false);
    fake.risk.set(SHORT.user, risk('-0.004', 'SHORT', now - 1_000));
    fake.accounts.get(SHORT.user)!.positions = [{ symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '-0.004' }];
    await executor.setTransferEnabled({ pairId: 'p1', enabled: true, requestId: randomUUID() }, 's');
    assert.equal(executor.transferPairs()[0]!.enabled, true);

    // Switched off and on again: the ADL watch starts afresh at the second switch, not from the first one.
    await executor.tickAdl();
    const firstWatch = executor.adlPairs()[0]!.scans!.long!.coveredUntil;
    await executor.setTransferEnabled({ pairId: 'p1', enabled: false, requestId: randomUUID() }, 's');
    assert.equal(executor.adlPairs().length, 0);
    await new Promise(resolve => setTimeout(resolve, 30));
    const checksFrom = Date.now();
    await executor.setTransferEnabled({ pairId: 'p1', enabled: true, requestId: randomUUID() }, 's');
    const rewatch = executor.adlPairs()[0]!.scans!;
    assert.ok(rewatch.long!.coveredUntil >= firstWatch + 30 && rewatch.short!.coveredUntil === rewatch.long!.coveredUntil, JSON.stringify(rewatch));
    // The watch starts a margin before the enable checks read anything, so an ADL during the checks is still found.
    // (50 ms for the moment between this clock read and the executor's own, far below the guard's reads.)
    assert.ok(rewatch.long!.coveredUntil <= checksFrom - 10_000 + 50, JSON.stringify(rewatch));
    assert.equal(rewatch.long!.pendingWindows, 0);
    // Enabling a pair that is already on (a repeated click) leaves its watch alone.
    await executor.setTransferEnabled({ pairId: 'p1', enabled: true, requestId: randomUUID() }, 's');
    assert.equal(executor.adlPairs()[0]!.scans!.long!.coveredUntil, rewatch.long!.coveredUntil);

    // Taken over: the transfer pass balances USD1 (long 120.5 vs short 80) with the main account's signature.
    await executor.tickTransfers();
    const sent = fake.calls.filter(call => call.path === '/fapi/v3/subAccountTransfer');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.params.fromAccountAddress, LONG.user);
    assert.equal(sent[0]!.params.toAccountAddress, SHORT.user);
    assert.equal(sent[0]!.params.amount, '20.25');

    // An ADL after the takeover closes the short leg; the push is handled at once with a reduce-only batch on the long side.
    await executor.tickAdl();
    assert.equal(fake.count('/fapi/v3/order'), 0);
    const at = Date.now();
    fake.risk.set(SHORT.user, risk('0', 'SHORT', at));
    fake.accounts.get(SHORT.user)!.positions = [];
    trading.push(SHORT.user, adlPush(at));
    for (let i = 0; i < 5 && fake.count('/fapi/v3/order') === 0; i++) await executor.tickAdl();
    assert.equal(executor.recentAdlIncidents(10).length, 1);
    const order = fake.calls.find(call => call.method === 'POST' && call.path === '/fapi/v3/order');
    assert.ok(order, '接管后应发出减仓单');
    assert.deepEqual([order.params.symbol, order.params.side, order.params.positionSide, order.params.quantity], ['BTCUSDT', 'SELL', 'LONG', '0.004']);

    // Dropped from the config: switched off at the next start.
    executor.close();
    const lines: string[] = [];
    const again = await wired(fake, store, parseServiceConfig(configRaw([{ id: 'p2', main: 'main', long: 'a', short: 'b' }])), lines);
    executor = again.executor;
    assert.equal(executor.transferPairs().find(item => item.id === 'p1')!.enabled, false);
    assert.ok(lines.some(line => /p1 已不在配置中，已停用/.test(line)));
    // p2 reuses p1's sub-accounts, which the executor refuses; the old record stays, and the operator is told by alert.
    assert.ok(lines.some(line => /p2 登记失败/.test(line)));
    assert.ok(again.warnings.some(line => /p2 登记失败/.test(line)));
    // The left-over p1 (its ADL incident still open) keeps its accounts locked by this process.
    assert.deepEqual(new Set(again.writable), new Set([MAIN.user, LONG.user, SHORT.user]));

    // A second instance waits for the lease, then gives up while the first one still holds it.
    const secrets: ServiceSecrets = { accounts: new Map([['main', MAIN], ['a', LONG], ['b', SHORT]]), feishu: null };
    const waited: string[] = [];
    const started = Date.now();
    await assert.rejects(wireService(config, secrets, store, { fetchImpl: fake.fetch, log: line => waited.push(line), leaseWaitMs: 300 }), /等待后仍未释放/);
    assert.ok(Date.now() - started >= 300);
    assert.ok(waited.some(line => /租约尚未过期，等待中/.test(line)));
    executor.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('服务进程：本机页面只含 ASTER 部分，状态接口可读，用户推送按子账户建立，停止后全部收尾', async () => {
  const dir = tempDir();
  const fake = new FakeAster();
  const { createServer } = await import('node:net');
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const sockets: FakeSocket[] = [];
  const { startService } = await import('../src/service/main.ts');
  const { readFileSync } = await import('node:fs');
  try {
    const run = await startService({
      config: parseServiceConfig(configRaw()), secrets: { accounts: new Map([['main', MAIN], ['a', LONG], ['b', SHORT]]), feishu: null },
      dir: join(dir, 'data'), port, fetchImpl: fake.fetch, app: APP,
      connect: url => { const socket = new FakeSocket(url); sockets.push(socket); queueMicrotask(() => socket.emit('open')); return socket; },
    });
    let link = '';
    for (let i = 0; i < 100 && !link; i++) { try { link = readFileSync(join(dir, 'data', 'access-url'), 'utf8').trim(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${port}/login\\?token=`));
    const login = await fetch(link, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`http://127.0.0.1:${port}/`, { headers: { cookie } })).text();
    assert.equal(page, APP.index.toString('utf8'), '服务托管构建出的页面');
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } })).json() as { transport: string; transfers: { pairs: { id: string; enabled: boolean }[] } };
    assert.equal(state.transport, 'live');
    assert.deepEqual(state.transfers.pairs.map(pair => [pair.id, pair.enabled]), [['p1', false]]);
    for (let i = 0; i < 100 && sockets.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sockets.length, 2, '每个子账户一条用户推送');
    await run.shutdown();
    await run.done;
    assert.ok(sockets.every(socket => socket.closed));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('服务进程：没有配对也启动，页面导入接口可用；重启后沿用同一页面会话', async () => {
  const dir = tempDir();
  const fake = new FakeAster();
  const { createServer } = await import('node:net');
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const { startService } = await import('../src/service/main.ts');
  const { mkdirSync, readFileSync, rmSync: remove } = await import('node:fs');
  const importDir = join(dir, 'import');
  mkdirSync(importDir);
  const start = () => startService({ config: parseServiceConfig(configRaw([])), secrets: { accounts: new Map(), feishu: null }, dir: join(dir, 'data'), port, fetchImpl: fake.fetch, importDir, app: APP });
  const link = async () => {
    let value = '';
    for (let i = 0; i < 100 && !value; i++) { try { value = readFileSync(join(dir, 'data', 'access-url'), 'utf8').trim(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    return value;
  };
  try {
    let run = await start();
    const cookie = (await fetch(await link(), { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } })).json() as { transfers: { pairs: unknown[] } };
    assert.deepEqual(state.transfers.pairs, []);
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/import`, { headers: { cookie } })).json(), { result: null });
    const submitted = await fetch(`http://127.0.0.1:${port}/api/import`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify({ action: 'preview' }) });
    assert.equal(submitted.status, 200);
    const request = JSON.parse(readFileSync(join(importDir, 'request.json'), 'utf8')) as { id: string; action: string };
    assert.deepEqual(request, { ...request, id: ((await submitted.json()) as { id: string }).id, action: 'preview' });
    await run.shutdown(); await run.done;
    remove(join(dir, 'data', 'access-url'));
    run = await start();
    await link();
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie } })).status, 200, '重启后原 cookie 仍有效');
    await run.shutdown(); await run.done;
  } finally {
    process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('服务装配：配置里的 ADL 设置只在配对首次登记时作为初始值，之后以页面为准', async () => {
  const dir = tempDir();
  const store = openStore(join(dir, 'executor-live.sqlite'));
  const fake = new FakeAster();
  const adlConfig = (id: string) => (JSON.parse((store.db.prepare('SELECT json FROM adl_pairs WHERE pair_id = ?').get(id) as { json: string }).json) as { config: unknown }).config;
  try {
    const config = parseServiceConfig(configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'b', adl: { autoReduce: false, batchNotional: '500' } }]));
    let { executor } = await wired(fake, store, config);
    assert.equal(executor.transferPairs()[0]!.enabled, false);
    assert.deepEqual(adlConfig('p1'), { autoReduce: false, batchNotional: '500' });
    executor.setAdlConfig({ pairId: 'p1', requestId: randomUUID(), autoReduce: true, batchNotional: '800' }, 's');
    executor.close();
    const lines: string[] = [];
    let warnings: string[];
    ({ executor, warnings } = await wired(fake, store, config, lines));
    assert.deepEqual(adlConfig('p1'), { autoReduce: true, batchNotional: '800' }, '重启后保留页面上的修改');
    // The operator is told the config line no longer applies, in the log only (it would repeat at every start).
    assert.ok(lines.some(line => /p1 配置里的 adl 只在首次登记时作为初始值，页面当前为自动减仓开、单批 800/.test(line)), lines.join('\n'));
    assert.deepEqual(warnings, []);
    executor.close();
    assert.throws(() => parseServiceConfig(configRaw([{ id: 'p1', main: 'main', long: 'a', short: 'b', adl: { autoReduce: 'yes', batchNotional: '1' } }])), /配对 p1 的 adl 无效/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
