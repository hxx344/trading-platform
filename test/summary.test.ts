import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIRST_SUMMARY_MS, createSummary, summaryCard, type SummaryInput, type SummaryPair } from '../src/service/summary.ts';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const pair = (id: string, extra: Partial<SummaryPair> = {}): SummaryPair => ({
  id, enabled: true, blocked: null, note: null, noteIdle: true, cooldownUntil: 0, checkIntervalMs: 5_000, names: { long: `${id}01`, short: `${id}02` },
  balances: { long: { available: '9367.28', equity: '76000', receivedAt: NOW - 2_000 }, short: { available: '9297.05', equity: '73900', receivedAt: NOW - 2_000 } }, balancesFresh: true,
  current: null,
  positions: { long: { state: 'fresh', positions: [{ unrealizedProfit: '-300.5' }] }, short: { state: 'fresh', positions: [{ unrealizedProfit: '7.17' }] }, totals: [{ symbol: 'XAUUSD1', long: '11719.81', short: '11703.2', balanced: true, gapPercent: '0.14' }] },
  adl: { incident: null, shared: null }, ...extra,
});
const input = (pairs: SummaryPair[]): SummaryInput => ({ pairs, streams: [{ connected: true, lastError: null }, { connected: false, lastError: '连接出错（代码 1006）' }], budget: { usedLastMinute: 120, limitPerMinute: 600, coolingUntil: null }, intervalMinutes: 60 });
const texts = (card: Record<string, unknown>): string[] => {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') { const value = node as Record<string, unknown>; if (value.tag === 'plain_text') out.push(String(value.content)); Object.values(value).forEach(walk); }
  };
  walk(card);
  return out;
};

test('定时摘要卡片：照工作台版式，合计浮盈亏、两侧可用保证金与占用率、持仓，异常配对排在前面', () => {
  const quiet = pair('xau');
  const stuck = pair('xag', { blocked: '划转受阻：交易所拒绝', enabled: true, positions: { ...pair('x').positions!, long: { state: 'retained', positions: [{ unrealizedProfit: '0' }] } } });
  const off = pair('btc', { enabled: false, balances: { long: { available: '1', equity: '2', receivedAt: NOW - 59_071_000 }, short: { available: '1', equity: '2', receivedAt: NOW - 59_071_000 } } });
  const card = summaryCard(input([quiet, stuck, off]), NOW);
  assert.equal(card.schema, '2.0');
  const all = texts(card);
  assert.equal(all[0], 'ASTER 运行摘要');
  assert.equal(all[1], '11-13 20:00:00 UTC+8');
  assert.ok(all.includes('-579.49'), '两个配对各 -293.33，保留快照的配对 7.17');
  assert.ok(all.includes('浮盈亏含未刷新快照'));
  const headings = all.filter(line => / \| {2}/.test(line));
  assert.deepEqual(headings, ['xag · XAUUSD1  |  划转受阻', 'xau · XAUUSD1  |  运行中', 'btc · XAUUSD1  |  已停用']);
  assert.ok(all.includes('A 多 · xau01（实盘）') && all.includes('B 空 · xau02（实盘）'));
  assert.ok(all.includes('9,367.28') && all.includes('87.67%'));
  assert.ok(all.includes('持仓  多 11,719.81 / 空 11,703.2'));
  assert.ok(all.includes('资金余额 59071 秒前 · 已停用'));
  assert.ok(all.includes('划转受阻：交易所拒绝'));
  assert.ok(all.includes('推送：连接出错（代码 1006）'));
  assert.ok(all.includes('推送 已连接 1 / 2 · API 近一分钟 120 / 600'));
  assert.ok(all.includes('金额 USD1 · UTC 日期 2026-11-13 · 每 60 分钟'));
});

test('定时摘要卡片：超过飞书大小上限时只展开放得下的配对并注明', () => {
  const many = Array.from({ length: 40 }, (_, index) => pair(`p${index}`));
  const card = summaryCard(input(many), NOW);
  assert.ok(Buffer.byteLength(JSON.stringify(card)) <= 18_000);
  assert.ok(texts(card).some(line => /^另有 \d+ 个配对未展开/.test(line)));
  // A side not yet read leaves the total open.
  const pending = pair('x', { positions: { ...pair('x').positions!, short: { state: 'pending', positions: [] } } });
  assert.ok(texts(summaryCard(input([pending]), NOW)).includes('待同步'));
});

test('定时摘要排程：启动后约 2 分钟第一张，之后按间隔；停机错过的周期不补发；发送失败重试 3 次后放弃本期', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-summary-'));
  let clock = NOW, fail = false;
  const posts: { url: string; body: Record<string, unknown> }[] = [], lines: string[] = [];
  const fetchImpl = async (url: string, init: RequestInit) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(fail ? { code: 9499, msg: 'bad' } : { code: 0 }), { status: 200 });
  };
  const robot = { secret: { webhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/timed1234', secret: 'sig' }, kind: 'scheduled' as const };
  const open = (minutes = 60) => createSummary({ file: join(dir, 'notify.sqlite'), intervalMinutes: minutes, robot, collect: () => input([pair('xau')]), now: () => clock, fetchImpl, log: line => lines.push(line) });
  try {
    let summary = open();
    await summary.tick();
    assert.equal(posts.length, 0);
    clock += FIRST_SUMMARY_MS;
    await summary.tick();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.body.msg_type, 'interactive');
    assert.equal(typeof posts[0]!.body.sign, 'string', '带签名');
    assert.equal((posts[0]!.body.card as { schema: string }).schema, '2.0');
    await summary.tick();
    assert.equal(posts.length, 1, '本期只发一次');
    assert.equal(summary.status().nextDueAt, NOW + FIRST_SUMMARY_MS + 3_600_000);
    // Down for three hours: one card on the way back (after the same start delay as a fresh schedule, so the numbers
    // are read by then), the next on the period grid.
    summary.close();
    clock += 3 * 3_600_000 + 10_000;
    summary = open();
    await summary.tick();
    assert.equal(posts.length, 1, '刚启动不发');
    clock += FIRST_SUMMARY_MS;
    await summary.tick();
    assert.equal(posts.length, 2);
    assert.equal(summary.status().nextDueAt, NOW + FIRST_SUMMARY_MS + 4 * 3_600_000);
    // Failures: retried a minute apart, then the period is given up.
    clock = NOW + FIRST_SUMMARY_MS + 4 * 3_600_000; fail = true;
    for (let i = 0; i < 3; i++) { await summary.tick(); clock += 60_000; }
    assert.equal(posts.length, 5);
    assert.match(summary.status().lastError!, /code 9499/);
    assert.equal(summary.status().nextDueAt, NOW + FIRST_SUMMARY_MS + 5 * 3_600_000);
    assert.ok(lines.some(line => /本期不再重试/.test(line)));
    // A changed interval starts over one interval from now; 0 turns it off.
    summary.close();
    summary = open(30);
    assert.equal(summary.status().nextDueAt, clock + 30 * 60_000);
    // Without pairs (oil only) a period passes without a post.
    summary.close();
    clock += 30 * 60_000;
    summary = createSummary({ file: join(dir, 'notify.sqlite'), intervalMinutes: 30, robot, collect: () => input([]), now: () => clock, fetchImpl });
    clock += FIRST_SUMMARY_MS;
    await summary.tick();
    assert.equal(posts.length, 5);
    assert.equal(summary.status().nextDueAt, clock + 28 * 60_000);
    // A clock that jumped ahead and came back starts the grid over instead of waiting out the jump.
    clock -= 5 * 3_600_000;
    await summary.tick();
    assert.equal(posts.length, 5);
    assert.equal(summary.status().nextDueAt, clock + 30 * 60_000);
    summary.close();
    summary = open(0);
    clock += 10 * 3_600_000;
    await summary.tick();
    assert.equal(posts.length, 5);
    assert.deepEqual([summary.status().enabled, summary.status().nextDueAt], [false, null]);
    summary.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('定时摘要排程：页面设置的间隔优先于 config.json 并在重启后保留；立即发送一张；换机器人后约 2 分钟先发一张；v0.10.0 的表照常升级', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-summary-page-'));
  const file = join(dir, 'notify.sqlite');
  let clock = NOW;
  const posts: string[] = [], lines: string[] = [];
  const fetchImpl = async (url: string) => { posts.push(url); return new Response(JSON.stringify({ code: 0 }), { status: 200 }); };
  const robotOf = (kind: 'scheduled' | 'event') => ({ secret: { webhook: `https://open.feishu.cn/open-apis/bot/v2/hook/${kind}1234`, secret: null }, kind });
  const open = (minutes: number, kind: 'scheduled' | 'event' | null) => createSummary({ file, intervalMinutes: minutes, robot: kind ? robotOf(kind) : null, collect: () => input([pair('xau')]), now: () => clock, fetchImpl, log: line => lines.push(line) });
  try {
    // A v0.10.0 table (without the new columns) with a card sent through the alert robot.
    const { DatabaseSync } = await import('node:sqlite');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE summary_schedule (id INTEGER PRIMARY KEY CHECK (id = 1), next_due_at INTEGER NOT NULL, interval_ms INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER, last_sent_at INTEGER, last_error TEXT, last_error_at INTEGER);
      INSERT INTO summary_schedule (id, next_due_at, interval_ms, last_sent_at) VALUES (1, ${NOW + 3_000_000}, 3600000, ${NOW - 600_000});`);
    old.close();
    // The scheduled robot is new to this schedule: a card about 2 minutes after the start rather than at the old due time.
    let summary = open(60, 'scheduled');
    assert.equal(summary.status().nextDueAt, NOW + FIRST_SUMMARY_MS);
    clock += FIRST_SUMMARY_MS;
    await summary.tick();
    assert.deepEqual(posts, ['https://open.feishu.cn/open-apis/bot/v2/hook/scheduled1234']);
    assert.equal(summary.status().lastSentRobot, 'scheduled');
    // The page's interval: next card one interval from now, kept over config.json after a restart.
    assert.throws(() => summary.setInterval(1441), /0–1440/);
    assert.throws(() => summary.setInterval(1.5), /整数/);
    let status = summary.setInterval(15);
    assert.deepEqual([status.intervalMinutes, status.fromPage, status.configIntervalMinutes, status.nextDueAt], [15, true, 60, clock + 15 * 60_000]);
    assert.ok(lines.some(line => line.includes('页面改为 15 分钟')));
    summary.close();
    clock += 60_000;
    summary = open(60, 'scheduled');
    status = summary.status();
    assert.deepEqual([status.intervalMinutes, status.fromPage, status.nextDueAt], [15, true, clock + 14 * 60_000]);
    // A card now: sent on the next look once the start-up minutes are over; the periods count from it.
    clock += FIRST_SUMMARY_MS;
    summary.sendNow();
    await summary.tick();
    assert.equal(posts.length, 2);
    assert.equal(summary.status().nextDueAt, clock + 15 * 60_000);
    // Off from the page: nothing is sent, and a card on demand is refused.
    summary.setInterval(0);
    assert.equal(summary.status().enabled, false);
    assert.throws(() => summary.sendNow(), /已关闭/);
    clock += 24 * 3_600_000;
    await summary.tick();
    assert.equal(posts.length, 2);
    summary.close();
    // Without a robot a card on demand is refused too.
    summary = open(60, null);
    assert.throws(() => summary.sendNow(), /未配置飞书机器人/);
    summary.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('定时摘要排程：发送途中页面改间隔不被覆盖、再点立即发送不重复；卡片写实际间隔；从关闭或换机器人启用时约 2 分钟先发一张', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-summary-race-'));
  const file = join(dir, 'notify.sqlite');
  let clock = NOW;
  const bodies: string[] = [];
  let release: (() => void) | null = null;
  const fetchImpl = async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) await new Promise<void>(resolve => { release = resolve; });
    return new Response(JSON.stringify({ code: 0 }), { status: 200 });
  };
  const robot = (kind: 'scheduled' | 'event') => ({ secret: { webhook: `https://open.feishu.cn/open-apis/bot/v2/hook/${kind}1234`, secret: null }, kind });
  const open = (minutes: number, kind: 'scheduled' | 'event' = 'scheduled') => createSummary({ file, intervalMinutes: minutes, robot: robot(kind), collect: () => input([pair('xau')]), now: () => clock, fetchImpl, log: () => undefined });
  try {
    let summary = open(60);
    clock += FIRST_SUMMARY_MS;
    const sending = summary.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bodies.length, 1);
    // While the first card is on its way: the page's interval and a second "send now" that is the same card.
    summary.setInterval(20);
    const asked = summary.sendNow();
    assert.equal(asked.nextDueAt, clock + 20 * 60_000, '发送途中再点立即发送不另排一张');
    release!();
    await sending;
    let status = summary.status();
    assert.deepEqual([status.intervalMinutes, status.nextDueAt, status.lastSentAt, status.lastSentRobot], [20, clock + 20 * 60_000, clock, 'scheduled'], '发送结束不覆盖页面改的排期');
    // The card names the interval in effect.
    summary.sendNow();
    summary.sendNow();
    await summary.tick();
    await summary.tick();
    assert.equal(bodies.length, 2, '连点两次只发一张');
    assert.match(bodies[1]!, /每 20 分钟/);
    // Off, then on again through config.json with a new robot after a restart: like a fresh schedule.
    summary.setInterval(0);
    summary.close();
    summary = createSummary({ file, intervalMinutes: 60, robot: robot('event'), collect: () => input([pair('xau')]), now: () => clock, fetchImpl });
    status = summary.status();
    assert.deepEqual([status.enabled, status.fromPage], [false, true], '页面关闭后以页面为准');
    summary.close();
    // A schedule stored as off (config 0 before) that config.json now turns on starts about 2 minutes after the start.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    db.exec('UPDATE summary_schedule SET page_interval_ms = NULL, interval_ms = 0');
    db.close();
    summary = open(60, 'event');
    assert.equal(summary.status().nextDueAt, clock + FIRST_SUMMARY_MS);
    summary.close();
    // A new robot together with a new interval also starts about 2 minutes after the start.
    summary = open(30, 'scheduled');
    assert.equal(summary.status().nextDueAt, clock + FIRST_SUMMARY_MS);
    summary.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
