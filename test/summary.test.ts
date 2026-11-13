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
