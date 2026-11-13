// The status page's sources: balance samples for the trend chart, the user-stream and outbox status, the request budget's view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BALANCE_RANGES, SAMPLE_EVERY_MS, SAMPLE_RETENTION_MS, createBalanceSamples, type SampledPair } from '../src/service/balance-samples.ts';
import { createStreamStatus } from '../src/service/stream.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { RequestBudget } from '../src/aster/client.ts';
import { pageCursor, parsePage } from '../src/contracts.ts';

const START = Date.UTC(2026, 10, 12, 0, 0, 0);
const pair = (id: string, at: number, long = '100', short = '90', fresh = true): SampledPair => ({
  id, balancesFresh: fresh, balances: { long: { available: long, equity: `${long}.5`, receivedAt: at }, short: { available: short, equity: `${short}.5`, receivedAt: at + 300 } },
});

function withSamples(run: (samples: ReturnType<typeof createBalanceSamples>, clock: { now: number }, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'tp-samples-'));
  const clock = { now: START };
  const file = join(dir, 'samples.sqlite');
  const samples = createBalanceSamples({ file, now: () => clock.now });
  try { run(samples, clock, file); } finally { samples.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('余额采样：每个配对至多每分钟一条，按两侧较早的接收时刻记；未读取、超前、格式不对的不记；重开后接着节流', () => withSamples((samples, clock, file) => {
  assert.equal(samples.record([pair('p1', clock.now), { id: 'p2', balances: null, balancesFresh: false }]), 1);
  assert.equal(samples.record([pair('p1', clock.now + 30_000)]), 0, '一分钟内不再记');
  assert.equal(samples.record([pair('p1', clock.now + SAMPLE_EVERY_MS)]), 1);
  assert.equal(samples.record([pair('p1', clock.now + 10 * SAMPLE_EVERY_MS)]), 0, '超前本机时钟一分钟以上不记');
  assert.equal(samples.record([pair('p3', clock.now, 'NaN')]), 0, '不是十进制数不记');
  assert.equal(samples.record([pair('p3', clock.now, '1'.repeat(41))]), 0, '过长不记');
  clock.now += 3 * SAMPLE_EVERY_MS;
  const history = samples.history('p1', '6h')!;
  assert.deepEqual(history.points.map(point => point.at), [START, START + SAMPLE_EVERY_MS]);
  assert.deepEqual(history.points[0], { at: START, long: { available: '100', equity: '100.5' }, short: { available: '90', equity: '90.5' }, fresh: true });
  // A second handle on the same file, as after a restart: the throttle starts from the newest stored sample.
  const again = createBalanceSamples({ file, now: () => clock.now });
  try {
    assert.equal(again.record([pair('p1', START + SAMPLE_EVERY_MS + 1_000)]), 0, '重开后从库里最新一条接着节流');
    assert.equal(again.record([pair('p1', START + 2 * SAMPLE_EVERY_MS)]), 1);
  } finally { again.close(); }
}));

test('余额走势：范围决定分段，每段取最后一条，最多约 720 个点；范围外与其他配对的不返回；未知范围为 null', () => withSamples((samples, clock) => {
  // Two days at one sample a minute.
  for (let at = START; at < START + 2 * 86_400_000; at += SAMPLE_EVERY_MS) { clock.now = at; samples.record([pair('p1', at, String(at - START))]); }
  samples.record([pair('p2', clock.now)]);
  clock.now = START + 2 * 86_400_000;
  const day = samples.history('p1', '24h')!;
  assert.equal(day.bucketMs, Math.ceil(BALANCE_RANGES['24h']! / 720));
  assert.ok(day.points.length <= 721 && day.points.length >= 700, String(day.points.length));
  assert.ok(day.points.every(point => point.at >= clock.now - 86_400_000));
  // The last sample of each stretch: every point's long value is its own time.
  assert.ok(day.points.every(point => point.long.available === String(point.at - START)));
  assert.ok(day.points.every((point, index) => index === 0 || point.at > day.points[index - 1]!.at));
  const short = samples.history('p1', '6h')!;
  assert.equal(short.bucketMs, SAMPLE_EVERY_MS, '短范围每分钟一点');
  assert.equal(short.points.length, 360);
  assert.equal(samples.history('p1', '1y'), null);
  assert.equal(samples.history('p1', 'constructor'), null);
  assert.deepEqual(samples.history('p3', '24h')!.points, []);
}));

test('余额采样：保留 30 天，每小时清理一次', () => withSamples((samples, clock) => {
  samples.record([pair('p1', START)]);
  clock.now = START + 1_800_000;
  samples.record([pair('p1', clock.now)]);
  clock.now = START + 2 * 86_400_000;
  samples.record([pair('p1', clock.now)]);
  clock.now = START + SAMPLE_RETENTION_MS + 1_000;
  assert.equal(samples.prune(), 1, '只清过期的');
  clock.now += 2_400_000;
  assert.equal(samples.prune(), 0, '第二条已过期，但距上次清理不到一小时');
  clock.now += 1_800_000;
  assert.equal(samples.prune(), 1);
  assert.deepEqual(samples.history('p1', '30d')!.points.map(point => point.at), [START + 2 * 86_400_000]);
}));

test('翻页参数：游标是创建时刻与编号，条数 1 到上限；其他写法拒绝', () => {
  const id = '0f8e2b44-1c1a-4c35-9a40-2b1f6c0e9d11';
  assert.deepEqual(parsePage(null, null, 50, 20), { before: null, limit: 20 });
  assert.deepEqual(parsePage(pageCursor(1_700_000_000_000, id), '50', 50, 20), { before: { at: 1_700_000_000_000, id }, limit: 50 });
  for (const before of ['', 'x', `1.${id}x`, `-1.${id}`, `1e3.${id}`, `1.${id.toUpperCase()}`]) assert.throws(() => parsePage(before, null, 50, 20), /翻页位置无效/, before);
  for (const limit of ['0', '51', '1.5', '', ' 5', '-1']) assert.throws(() => parsePage(null, limit, 50, 20), /每页条数须为 1–50/, limit);
});

test('推送连接状态：连上、断开（次数与原因）、最近消息；账户脱敏，未登记的账户忽略', () => {
  const clock = { now: START };
  const status = createStreamStatus(['0xaaaa1111', '0xbbbb2222'], () => clock.now);
  status.onState('0xaaaa1111', false, '连接超时');
  clock.now += 1_000;
  status.onState('0xaaaa1111', true);
  clock.now += 1_000;
  status.onMessage('0xaaaa1111');
  status.onMessage('0xcccc3333');
  clock.now += 1_000;
  status.onState('0xaaaa1111', false, null);
  const [first, second] = status.view();
  assert.deepEqual(first, { account: '***1111', connected: false, since: START + 3_000, lastMessageAt: START + 2_000, disconnects: 1, lastError: '连接超时', lastErrorAt: START });
  assert.deepEqual(second, { account: '***2222', connected: false, since: null, lastMessageAt: null, disconnects: 0, lastError: null, lastErrorAt: null });
  assert.equal(status.view().length, 2);
});

test('飞书发件箱状态：待发、重试中、最近成功与错误、最近消息；未配置时为空', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-outbox-'));
  const clock = { now: START };
  let fail = true;
  const options = { events: () => [], latestSeq: () => 0, pairs: () => [], incidentPair: () => null, now: () => clock.now, log: () => undefined };
  const notifier = createNotifier({ ...options, file: join(dir, 'notify.sqlite'), feishu: { webhook: 'https://open.feishu.cn/hook/x', secret: null },
    fetchImpl: async () => fail ? new Response('{}', { status: 500 }) : Response.json({ code: 0 }) });
  const off = createNotifier({ ...options, file: join(dir, 'off.sqlite'), feishu: null });
  try {
    notifier.notify('【测试】一');
    await notifier.flush();
    let status = notifier.status();
    assert.equal(status.configured, true);
    assert.equal(status.pending, 1);
    assert.equal(status.retrying, 1);
    assert.match(status.lastError!, /HTTP 500/);
    assert.equal(status.nextRetryAt, START + 5_000);
    assert.equal(status.lastSentAt, null);
    fail = false; clock.now += 5_000;
    notifier.notify('【测试】二');
    await notifier.flush();
    status = notifier.status();
    assert.deepEqual([status.pending, status.retrying, status.lastError, status.lastSentAt], [0, 0, null, START + 5_000]);
    assert.deepEqual(status.recent.map(row => [row.text, row.attempts, row.sentAt]), [['【测试】二', 0, START + 5_000], ['【测试】一', 1, START + 5_000]]);
    off.notify('【测试】未配置');
    assert.deepEqual([off.status().configured, off.status().recent], [false, []]);
  } finally { notifier.close(); off.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('请求权重状态：本进程用量、ADL 保留、交易所报告的出口 IP 本分钟用量（跨分钟清空）', () => {
  const clock = { now: START };
  const budget = new RequestBudget({ limitPerMinute: 1200, adlReserve: 200, now: () => clock.now });
  assert.equal(budget.take(5, 'normal'), null);
  budget.observe(700);
  assert.deepEqual(budget.state(), { usedLastMinute: 5, limitPerMinute: 1200, adlReserve: 200, ipUsedThisMinute: 700, ipCeiling: 2100, ipCeilingAdl: 2350, coolingUntil: null, reason: null });
  clock.now += 60_000;
  assert.deepEqual([budget.state().usedLastMinute, budget.state().ipUsedThisMinute], [0, null]);
});

test('余额采样：本机时钟回拨后，已记下的超前时刻不挡住后续采样', () => withSamples((samples, clock) => {
  assert.equal(samples.record([pair('p1', START + 30_000)]), 1, '超前不到一分钟仍记');
  // Balances are stamped with the local clock, so after the clock is set back every stamp is behind the stored one.
  clock.now = START - 10 * SAMPLE_EVERY_MS;
  assert.equal(samples.record([pair('p1', clock.now - 1_000)]), 1, '回拨后下一次读取就能记上');
  clock.now += 30_000;
  assert.equal(samples.record([pair('p1', clock.now - 1_000)]), 0, '之后照常每分钟至多一条');
  clock.now += 30_000;
  assert.equal(samples.record([pair('p1', clock.now - 1_000)]), 1);
  const points = samples.history('p1', '6h')!.points.map(point => point.at);
  assert.deepEqual(points, [START - 10 * SAMPLE_EVERY_MS - 1_000, START - 9 * SAMPLE_EVERY_MS - 1_000], '超前的那条在时钟追上前不显示');
}));
