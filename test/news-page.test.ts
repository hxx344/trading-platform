// 快讯页与异动行情页签的数据层（web/src/news.ts，docs/news.md）：应答校验、筛选、频道归属、时间与连接文案，以及路由与侧栏登记。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelName, connectionText, inChannel, matchesQuery, movesProblem, newsTime, parseFlash, parseMoves, restProblem, type NewsItem } from '../web/src/news.ts';
import { parseRoute } from '../web/src/route-parse.ts';
import { breadcrumbOf, workspaceGroups } from '../web/src/workspace-nav.ts';

const T0 = new Date(2026, 10, 19, 20, 5, 9).getTime();
const item = (extra: Partial<NewsItem> = {}): NewsItem => ({ no: 1, time: T0, channels: ['main'], source: 'Binance EN', zh: '币安将上线 ABC', en: 'Binance Will List ABC', coins: ['ABC'], url: 'https://eqn.news/main/1', sourceUrl: null, points: [], overview: null, pushed: false, ...extra });
const flash = (connection: Record<string, unknown>, rest: Record<string, unknown> = { at: T0, error: null }, items: unknown[] = [item()]) => ({ connection: { since: T0, lastPushAt: null, closeCode: null, reconnects: 0, ...connection }, rest, items });

test('快讯应答：校验结构，丢掉格式不对的条目和非 https 链接', () => {
  const view = parseFlash(flash({ state: 'open' }, undefined, [item(), { time: 'x' }, item({ no: 2, url: 'javascript:alert(1)' as never, zh: null, en: null }), item({ no: 3, url: 'http://x' as never })]));
  assert.deepEqual(view.items.map(entry => [entry.no, entry.url]), [[1, 'https://eqn.news/main/1'], [3, null]]);
  assert.throws(() => parseFlash({ ...flash({ state: 'weird' }) }), /格式不正确/);
  assert.throws(() => parseFlash({ items: [] }), /格式不正确/);
  const moves = parseMoves({ channels: [{ key: 'oi', name: 'OI价格异动', at: null, error: '读取失败' }, { key: '' }], loading: false, items: [item({ channels: ['oi'] })] });
  assert.equal(moves.channels.length, 1);
  assert.equal(movesProblem(moves), 'OI价格异动读取失败：读取失败');
  assert.throws(() => parseMoves({ items: [] }), /格式不正确/);
});

test('筛选：币种精确匹配，其余在标题与来源里找，多个词都要命中', () => {
  assert.ok(matchesQuery(item(), ''));
  assert.ok(matchesQuery(item(), 'abc'));
  assert.ok(matchesQuery(item(), 'ABC 上线'));
  assert.ok(matchesQuery(item(), 'binance'));
  assert.ok(!matchesQuery(item(), 'abc 下架'));
  assert.ok(!matchesQuery(item({ coins: ['BTCDOM'], zh: '指数', en: null }), 'btc'));
  assert.ok(inChannel(item({ channels: ['pricechange', 'major'] }), 'major'));
  assert.ok(!inChannel(item({ channels: ['oi'] }), 'major'));
  const channels = [{ key: 'pricechange', name: '价格异动', at: null, error: null }, { key: 'major', name: '大幅波动', at: null, error: null }];
  assert.equal(channelName(item({ channels: ['major', 'pricechange'] }), channels), '价格异动');
});

test('时间与连接文案：今天只显示时分秒；断开时说明关闭码与补读', () => {
  assert.equal(newsTime(T0, T0 + 60_000), '20:05:09');
  assert.equal(newsTime(T0, T0 + 86_400_000), '11-19 20:05');
  assert.deepEqual(connectionText(parseFlash(flash({ state: 'open' })), T0 + 5 * 60_000), { text: '推送已连接 5 分钟', tone: 'ok' });
  assert.deepEqual(connectionText(parseFlash(flash({ state: 'retrying', closeCode: 1008 })), T0 + 20_000), { text: '推送断开 20 秒，自动重连中（关闭码 1008），期间每分钟用 REST 补读', tone: 'warn' });
  assert.equal(connectionText(parseFlash(flash({ state: 'connecting' })), T0).tone, 'muted');
  assert.equal(restProblem(parseFlash(flash({ state: 'open' }))), null);
  assert.equal(restProblem(parseFlash(flash({ state: 'open' }, { at: T0, error: 'EQN 快讯接口返回 503' }))), '补读失败：EQN 快讯接口返回 503（显示的是此前读到的内容）');
});

test('路由与侧栏：#/news 在「市场与机会」行情监控之后', () => {
  assert.deepEqual(parseRoute('#/news'), { page: 'news' });
  assert.deepEqual(breadcrumbOf({ page: 'news' }), { workspace: '市场与机会', page: '快讯' });
  const market = workspaceGroups(new Set(['monitor', 'news', 'pairs'])).find(group => group.id === 'market');
  assert.deepEqual(market?.entries, ['monitor', 'news']);
});
