// EQN 快讯（docs/news.md）：上游条目与推送帧的解析、推送连接的心跳与重连、推送后的 REST 核对、限流冷却、
// 异动行情的按需轮询，以及 config.json 的 news 开关。上游全部是替身，不连真实 eqn.news。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EQN_REST, EQN_WS, numberFromUrl, parsePushFrame, parseRestItem, parseRestPage } from '../src/news/eqn.ts';
import { createNewsFeed, MOVES_INTEREST_MS, MOVES_POLL_MS, PING_MS, SILENT_MS, type NewsSocket } from '../src/news/feed.ts';
import { newsLoop, newsViews } from '../src/service/news.ts';
import { parseServiceConfig } from '../src/service/config.ts';

const T0 = Date.parse('2026-11-19T12:00:00Z');
const restItem = (no: number, at: number, extra: Record<string, unknown> = {}) => ({
  no, time: new Date(at).toISOString(), channels: ['main'], source: 'Binance EN', zh: `中文标题 ${no}`, en: `Title ${no}`, coins: ['BTC'],
  url: `https://eqn.news/main/${no}`, source_url: 'https://www.binance.com/en/support/announcement/x', ai: null, ...extra,
});

class FakeSocket implements NewsSocket {
  listeners: Record<string, ((event: any) => void)[]> = {};
  sent: string[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) { this.url = url; }
  addEventListener(type: string, listener: (event: any) => void): void { (this.listeners[type] ??= []).push(listener); }
  emit(type: string, event: unknown = {}): void { for (const listener of this.listeners[type] ?? []) listener(event); }
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; }
}

function harness({ pages = {} as Record<string, unknown[]>, status = 200, retryAfter = null as string | null } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  const sockets: FakeSocket[] = [], requests: string[] = [], logs: string[] = [];
  const state = { pages, status, retryAfter };
  const fetchImpl = async (url: string) => {
    requests.push(url);
    const channel = new URL(url).searchParams.get('channel')!;
    if (state.status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status: state.status, headers: state.retryAfter ? { 'retry-after': state.retryAfter } : {} });
    return new Response(JSON.stringify({ items: state.pages[channel] ?? [], next_cursor: null }), { status: 200 });
  };
  const feed = createNewsFeed({ fetchImpl, connect: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; }, random: () => 0.5, log: line => logs.push(line) });
  return { feed, sockets, requests, logs, state };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
async function advance(ms: number) { mock.timers.tick(ms); await settle(); }

test('解析：REST 条目、链接只收 https、AI 摘要与总览、格式不对的条目跳过', () => {
  const item = parseRestItem(restItem(7, T0, { ai: { summary: { type: 'listing', points: [{ zh: '要点一', en: 'one' }, { en: 'two' }] }, overview: { status: 'ready', zh: { paragraphs: [{ text: '总览第一段', sources: [] }] } }, notice: 'x' } }));
  assert.deepEqual(item?.points, ['要点一', 'two']);
  assert.equal(item?.overview, '总览第一段');
  assert.equal(item?.time, T0);
  assert.equal(parseRestItem(restItem(8, T0, { ai: { overview: { status: 'pending', zh: { paragraphs: [{ text: '检索中' }] } } } }))?.overview, null);
  assert.equal(parseRestItem(restItem(9, T0, { url: 'javascript:alert(1)', source_url: 'http://x.example' }))?.url, null);
  assert.equal(parseRestItem(restItem(9, T0, { source_url: 'http://x.example' }))?.sourceUrl, null);
  assert.equal(parseRestItem({ ...restItem(10, T0), zh: null, en: null }), null);
  assert.equal(parseRestItem({ ...restItem(10, T0), no: '10' }), null);
  assert.equal(parseRestItem({ ...restItem(10, T0), time: 'bad' }), null);
  assert.equal(parseRestPage({ items: [restItem(1, T0), { no: -1 }] }).length, 1);
  assert.throws(() => parseRestPage({ error: 'x' }), /格式不正确/);
  assert.equal(numberFromUrl('https://eqn.news/main/15970'), 15970);
  assert.equal(numberFromUrl('https://eqn.news/'), null);
});

test('解析：推送帧按文档字段，时间是秒，没有编号与时间时退回', () => {
  const frame = parsePushFrame({ source_name: 'Upbit', news_title: '新增 KNTQ 韩元市场', coins_included: ['KNTQ'], url: 'https://eqn.news/main/15873', timestamp: T0 / 1_000 }, T0 + 500);
  assert.deepEqual({ no: frame?.no, time: frame?.time, zh: frame?.zh, en: frame?.en, pushed: frame?.pushed, coins: frame?.coins }, { no: 15873, time: T0, zh: '新增 KNTQ 韩元市场', en: null, pushed: true, coins: ['KNTQ'] });
  const english = parsePushFrame({ source_name: 'X', news_title: 'BINANCE WILL LIST ABC', coins_included: [], url: null, timestamp: 'x' }, T0);
  assert.deepEqual({ no: english?.no, time: english?.time, en: english?.en }, { no: null, time: T0, en: 'BINANCE WILL LIST ABC' });
  assert.equal(parsePushFrame({ source_name: 'X' }, T0), null);
  assert.equal(parsePushFrame('pong', T0), null);
});

test('快讯：启动即连推送并用 REST 补最新一页，推送条目先显示、REST 核对后换成完整记录', async t => {
  const { feed, sockets, requests } = harness({ pages: { main: [restItem(100, T0 - 60_000)] } });
  t.after(() => { feed.close(); mock.timers.reset(); });
  await settle();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.url, EQN_WS);
  assert.equal(requests[0], `${EQN_REST}/news?channel=main&limit=50`);
  assert.equal(feed.flash().connection.state, 'connecting');
  assert.deepEqual(feed.flash().items.map(item => item.no), [100]);

  sockets[0]!.emit('open');
  await settle();
  assert.equal(feed.flash().connection.state, 'open');
  // 连上后再补一页（推送没有回放）。
  assert.equal(requests.length, 2);

  sockets[0]!.emit('message', { data: JSON.stringify({ source_name: 'Binance EN', news_title: '币安将上线 ABC', coins_included: ['ABC'], url: 'https://eqn.news/main/101', timestamp: T0 / 1_000 }) });
  let items = feed.flash().items;
  assert.deepEqual(items.map(item => [item.no, item.pushed]), [[101, true], [100, false]]);
  assert.equal(feed.flash().connection.lastPushAt, T0);

  // 2 秒后用 REST 核对一次（替换见下一个测试）。
  const before = requests.length;
  await advance(2_000);
  assert.equal(requests.length, before + 1);
  items = feed.flash().items;
  assert.deepEqual(items.map(item => [item.no, item.pushed]), [[101, true], [100, false]], 'REST 还没有这条时保留推送条目');
});

test('快讯：REST 带上同编号记录后替换推送条目，没有编号的推送条目按标题对上', async t => {
  const h = harness({ pages: { main: [] } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  h.sockets[0]!.emit('message', { data: JSON.stringify({ source_name: 'A', news_title: '中文标题 201', url: 'https://eqn.news/main/201', timestamp: T0 / 1_000 }) });
  h.sockets[0]!.emit('message', { data: JSON.stringify({ source_name: 'B', news_title: 'Title 202', url: null, timestamp: T0 / 1_000 }) });
  assert.equal(h.feed.flash().items.length, 2);
  h.state.pages.main = [restItem(201, T0, { ai: { summary: { points: [{ zh: '摘要' }] } } }), restItem(202, T0)];
  await advance(2_000);
  const items = h.feed.flash().items;
  assert.deepEqual(items.map(item => [item.no, item.pushed]).sort(), [[201, false], [202, false]]);
  assert.deepEqual(items.find(item => item.no === 201)?.points, ['摘要']);
  // 之后再来同编号的推送帧不覆盖已核对的记录。
  h.sockets[0]!.emit('message', { data: JSON.stringify({ source_name: 'A', news_title: '中文标题 201', url: 'https://eqn.news/main/201', timestamp: T0 / 1_000 }) });
  assert.equal(h.feed.flash().items.find(item => item.no === 201)?.pushed, false);
});

test('推送：每 30 秒发 ping，pong 算作活着；75 秒没有任何消息就重连', async t => {
  const h = harness();
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await advance(PING_MS);
  assert.deepEqual(h.sockets[0]!.sent, ['ping']);
  h.sockets[0]!.emit('message', { data: 'pong' });
  await advance(PING_MS);
  assert.deepEqual(h.sockets[0]!.sent, ['ping', 'ping']);
  assert.equal(h.sockets.length, 1);
  // 不再回 pong：上次消息在 30 秒，到 30+75 秒之后的那次检查判定已死。
  await advance(PING_MS);
  await advance(PING_MS);
  assert.ok(h.sockets[0]!.closed, `${SILENT_MS} 毫秒没有消息应关闭`);
  assert.equal(h.feed.flash().connection.state, 'retrying');
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /断开/);
  // 第一次重连等 1 秒（抖动取中间值）。
  await advance(1_000);
  assert.equal(h.sockets.length, 2);
  h.sockets[1]!.emit('open');
  await settle();
  assert.equal(h.feed.flash().connection.state, 'open');
  assert.match(h.logs[1]!, /已恢复/);
});

test('推送：关闭码决定等待，1008 至少 15 秒，连续失败按倍数退避到 30 秒，断开期间每分钟 REST 补读', async t => {
  const h = harness();
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  h.sockets[0]!.emit('close', { code: 1008 });
  await advance(14_000);
  assert.equal(h.sockets.length, 1);
  await advance(1_000);
  assert.equal(h.sockets.length, 2);
  // 之后连不上：2、4、8、16、30、30 秒。
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const count = h.sockets.length;
    h.sockets.at(-1)!.emit('close', { code: 1006 });
    let waited = 0;
    while (h.sockets.length === count) { await advance(1_000); waited += 1_000; }
    waits.push(waited);
  }
  assert.deepEqual(waits, [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  // 断开期间只记一条日志。
  assert.equal(h.logs.length, 1);
  const rest = h.requests.length;
  await advance(60_000);
  assert.ok(h.requests.length > rest, '断开期间按分钟补读');
});

test('推送：10 秒内没连上算一次失败，停服后不再重连也不再读', async t => {
  const h = harness();
  t.after(() => mock.timers.reset());
  await settle();
  await advance(10_000);
  assert.ok(h.sockets[0]!.closed);
  await advance(1_000);
  assert.equal(h.sockets.length, 2);
  h.feed.close();
  assert.ok(h.sockets[1]!.closed);
  assert.equal(h.feed.flash().connection.state, 'closed');
  const requests = h.requests.length;
  await advance(10 * 60_000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.requests.length, requests);
});

test('REST 限流：429 按 Retry-After 暂停全部读取，错误文本不带上游内容', async t => {
  const h = harness({ status: 429, retryAfter: '30' });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  assert.equal(h.feed.flash().rest.error, 'EQN 接口限流（429），稍后重试');
  const moves = h.feed.moves();
  await settle();
  // 冷却期间异动行情的 4 个频道不发请求。
  assert.equal(h.requests.length, 1);
  assert.equal(moves.loading, true);
  assert.match(h.feed.moves().channels[0]!.error!, /限流，\d+ 秒后重试/);
  h.state.status = 500;
  await advance(31_000 + MOVES_POLL_MS);
  assert.ok(h.feed.moves().channels.every(channel => channel.error === 'EQN 快讯接口返回 500'));
});

test('异动行情：有人读才轮询 4 个频道，合并去重、新的在前，90 秒没人读就停', async t => {
  const move = (no: number, at: number, channels: string[]) => ({ ...restItem(no, at), channels, url: `https://eqn.news/monitor/${no}` });
  const h = harness({ pages: { pricechange: [move(1, T0 - 3_000, ['pricechange'])], oi: [move(2, T0 - 1_000, ['oi'])], major: [move(1, T0 - 3_000, ['pricechange', 'major'])], tfmoves: [move(3, T0 - 2_000, ['tfmoves'])] } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  const base = h.requests.length;
  assert.equal(h.feed.moves().loading, true);
  await settle();
  assert.deepEqual(h.requests.slice(base).map(url => new URL(url).searchParams.get('channel')), ['pricechange', 'oi', 'major', 'tfmoves']);
  const view = h.feed.moves();
  assert.equal(view.loading, false);
  assert.deepEqual(view.items.map(item => item.no), [2, 3, 1]);
  assert.deepEqual(view.channels.map(channel => [channel.key, channel.name]), [['pricechange', '价格异动'], ['oi', 'OI价格异动'], ['major', '大幅波动'], ['tfmoves', '美股重大行情']]);
  // 再读时只取 20 条。
  await advance(MOVES_POLL_MS);
  assert.match(h.requests.at(-1)!, /limit=20$/);
  // 不再读：兴趣过期后的那一轮结束即停。
  await advance(MOVES_INTEREST_MS + MOVES_POLL_MS);
  const after = h.requests.filter(url => !url.includes('channel=main')).length;
  await advance(5 * MOVES_POLL_MS);
  assert.equal(h.requests.filter(url => !url.includes('channel=main')).length, after);
});

test('服务接线：循环开始前视图为 null，停服时关闭连接；config.json 的 news 只收布尔值', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  try {
    const sockets: FakeSocket[] = [];
    const holder = { feed: null };
    const views = newsViews(holder);
    assert.equal(views.flash(), null);
    let stopped = false, wake = () => {};
    const loop = newsLoop(holder, { fetchImpl: async () => new Response('{"items":[]}'), connect: url => { const socket = new FakeSocket(url); sockets.push(socket); return socket; }, log: () => {} },
      { stopped: () => stopped, pause: () => new Promise<void>(resolve => { wake = resolve; }) });
    assert.notEqual(views.flash(), null);
    stopped = true; wake();
    await loop;
    assert.ok(sockets[0]!.closed);
  } finally { mock.timers.reset(); }
  const base = { secretsFile: '/etc/trading-platform/secrets.json', pairs: [] };
  assert.equal(parseServiceConfig(base).news, undefined);
  assert.equal(parseServiceConfig({ ...base, news: true }).news, undefined);
  assert.equal(parseServiceConfig({ ...base, news: false }).news, false);
  assert.throws(() => parseServiceConfig({ ...base, news: 'off' }), /news 须为 true 或 false/);
});

test('接口：没开快讯 404，循环开始前 503，之后返回快讯与异动行情，未登录 401', async () => {
  const { createExecutorServer } = await import('../src/http.ts');
  const { createHarness } = await import('./harness.ts');
  const h = createHarness();
  const holder: { feed: ReturnType<typeof createNewsFeed> | null } = { feed: null };
  const views: { news?: ReturnType<typeof newsViews> } = {};
  const { createReadTokens } = await import('../src/read-token.ts');
  const tokenDir = mkdtempSync(join(tmpdir(), 'tp-news-token-'));
  const server = createExecutorServer({ executor: h.ex, accessToken: 'news-token-0001', views, readTokens: createReadTokens({ dir: tokenDir, log: () => {} }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  try {
    const cookie = ((await fetch(`${base}/login?token=news-token-0001`, { redirect: 'manual' })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const get = (path: string, withCookie = true) => fetch(base + path, { headers: withCookie ? { cookie } : {} });
    assert.equal((await get('/api/news', false)).status, 401);
    assert.equal((await get('/api/news')).status, 404);
    views.news = newsViews(holder);
    const starting = await get('/api/news/moves');
    assert.equal(starting.status, 503);
    assert.equal((await starting.json() as { message: string }).message, 'EQN 快讯正在启动');
    holder.feed = createNewsFeed({ fetchImpl: async () => new Response(JSON.stringify({ items: [restItem(5, T0)] })), connect: url => new FakeSocket(url), log: () => {} });
    await settle();
    const flash = await (await get('/api/news')).json() as { items: { no: number }[]; connection: { state: string } };
    assert.deepEqual(flash.items.map((item: { no: number }) => item.no), [5]);
    assert.equal(flash.connection.state, 'connecting');
    // 只读令牌读到的链接改名 link：url 是脱敏的标识字段，原样给出会把每条快讯链接换成别名、挤掉账户别名（docs/mcp.md 8.3）。
    const { token } = await (await fetch(`${base}/api/read-token/generate`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: '{}' })).json() as { token: string };
    const tokenFlash = await (await fetch(`${base}/api/news`, { headers: { authorization: `Bearer ${token}` } })).json() as { items: Record<string, unknown>[] };
    assert.equal(tokenFlash.items[0]!.url, undefined);
    assert.equal(tokenFlash.items[0]!.link, 'https://eqn.news/main/5');
    const stored = JSON.parse(readFileSync(join(tokenDir, 'read-token.json'), 'utf8')) as { aliases: unknown[] };
    assert.deepEqual(stored.aliases, [], '快讯链接不进别名表');
    const moves = await (await get('/api/news/moves')).json() as { channels: unknown[] };
    assert.equal(moves.channels.length, 4);
    // 展示读取的版本协商：列表没变回 204，但视图每次都照常生成（异动行情靠这次读取判断“有人在看”）。
    let produced = 0;
    const real = views.news;
    views.news = { flash: () => { produced++; return real.flash(); }, moves: () => { produced++; return real.moves(); } };
    for (const path of ['/api/news', '/api/news/moves']) {
      const known = (path: string, version: string) => fetch(base + path, { headers: { cookie, 'x-pa-read-cache': version } });
      const first = await known(path, '1');
      assert.equal(first.status, 200);
      const version = first.headers.get('x-pa-read-version')!;
      assert.ok(version);
      const before = produced, same = await known(path, version);
      assert.equal(same.status, 204);
      assert.equal(await same.text(), '');
      assert.equal(produced, before + 1, '204 时也生成了视图');
    }
  } finally { holder.feed?.close(); await new Promise(resolve => server.close(resolve)); h.dispose(); rmSync(tokenDir, { recursive: true, force: true }); }
});

// ---- 审查补充（docs/reviews/2026-11-19-eqn-news.md）----

const frame = (no: number | null, title: string, host = 'eqn.news') => ({ data: JSON.stringify({ source_name: 'A', news_title: title, coins_included: [], url: no === null ? null : `https://${host}/main/${no}`, timestamp: T0 / 1_000 }) });

test('推送密集时 REST 核对有上限：2 秒那次排上就不再排，15 秒那次按最后一条推送重排', async t => {
  const h = harness({ pages: { main: [] } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  const base = h.requests.length;
  // 10 秒内每 0.5 秒一条推送。
  for (let i = 0; i < 20; i++) { h.sockets[0]!.emit('message', frame(300 + i, `推送 ${i}`)); await advance(500); }
  const during = h.requests.length - base;
  assert.ok(during >= 4 && during <= 5, `10 秒内核对 ${during} 次，应约每 2 秒一次`);
  // 最后一条推送 15 秒后还有一次核对，之后安静。
  await advance(14_000);
  const late = h.requests.length;
  await advance(1_000);
  assert.equal(h.requests.length, late + 1);
  await advance(60_000);
  assert.equal(h.requests.length, late + 1);
});

test('推送编号只认 eqn.news 的链接；别处链接按标题与 REST 记录对上', async t => {
  assert.equal(numberFromUrl('https://upbit.com/service_center/notice/5678'), null);
  const h = harness({ pages: { main: [] } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  h.sockets[0]!.emit('message', frame(5678, '中文标题 400', 'upbit.com'));
  assert.deepEqual(h.feed.flash().items.map(item => [item.no, item.pushed]), [[null, true]]);
  h.state.pages.main = [restItem(400, T0)];
  await advance(2_000);
  assert.deepEqual(h.feed.flash().items.map(item => [item.no, item.pushed]), [[400, false]]);
});

test('重连：error 与 close 连发、超时后旧连接的 close 迟到，都只重连一次', async t => {
  const h = harness();
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  h.sockets[0]!.emit('error');
  h.sockets[0]!.emit('close', { code: 1006 });
  h.sockets[0]!.emit('close', { code: 1006 });
  await advance(30_000);
  assert.equal(h.sockets.length, 2);
  // 第二条连接 10 秒没连上：超时重连，随后它的 close 迟到。
  await advance(10_000);
  assert.ok(h.sockets[1]!.closed);
  h.sockets[1]!.emit('close', { code: 1006 });
  await advance(30_000);
  assert.equal(h.sockets.length, 3, '迟到的 close 不再触发重连');
  h.sockets[2]!.emit('open');
  await settle();
  // 旧连接的消息不进列表。
  h.sockets[0]!.emit('message', frame(500, '旧连接'));
  assert.equal(h.feed.flash().items.some(item => item.no === 500), false);
});

test('关闭码 1012 先快速重连，连续出现时随退避增长', async t => {
  const h = harness();
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) {
    const count = h.sockets.length;
    h.sockets.at(-1)!.emit('close', { code: 1012 });
    let waited = 0;
    while (h.sockets.length === count) { await advance(500); waited += 500; }
    waits.push(waited);
  }
  // random = 0.5：1012 的下限 3 秒；退避 1、2、4、8、16、30 秒。
  assert.deepEqual(waits, [3_000, 3_000, 4_000, 8_000, 16_000, 30_000]);
});

test('停服时 REST 在途：请求被中止，之后不写入也不再排读取', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  t.after(() => mock.timers.reset());
  let calls = 0;
  const pending: (() => void)[] = [];
  const fetchImpl = (_url: string, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      pending.push(() => resolve(new Response(JSON.stringify({ items: [restItem(600, T0)], next_cursor: null }))));
    });
  };
  const feed = createNewsFeed({ fetchImpl: fetchImpl as typeof fetch, connect: url => new FakeSocket(url), random: () => 0.5, log: () => {} });
  await settle();
  assert.equal(calls, 1);
  feed.close();
  await settle();
  for (const resolve of pending) resolve();
  await settle();
  const view = feed.flash();
  assert.deepEqual(view.items, []);
  assert.equal(view.rest.error, null, '停服中止不算读取失败');
  await advance(10 * 60_000);
  assert.equal(calls, 1);
});

test('429 没有 Retry-After 或是日期格式时暂停 10 秒', async t => {
  for (const retryAfter of [null, 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    await t.test(`Retry-After: ${retryAfter ?? '无'}`, async t => {
      const h = harness({ status: 429, retryAfter });
      t.after(() => { h.feed.close(); mock.timers.reset(); });
      await settle();
      h.state.status = 200;
      const error = () => h.feed.moves().channels[0]!.error;
      h.feed.moves();
      await settle();
      assert.match(error()!, /限流，10 秒后重试/);
      await advance(10_000 + MOVES_POLL_MS);
      assert.equal(error(), null);
    });
  }
});

test('同标题的旧快讯不会顶掉新推送；标题对上且时间相近才算同一条', async t => {
  const h = harness({ pages: { main: [restItem(700, T0 - 3 * 3_600_000, { zh: '某所将上线 XYZ', en: null })] } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  h.sockets[0]!.emit('message', frame(701, '某所将上线 XYZ'));
  await advance(2_000);
  assert.deepEqual(h.feed.flash().items.map(item => [item.no, item.pushed]), [[701, true], [700, false]]);
  // REST 收录时编号不同（上游改号）但时间相近：按标题换掉推送条目。
  h.state.pages.main = [restItem(702, T0 + 1_000, { zh: '某所将上线 XYZ', en: null }), restItem(700, T0 - 3 * 3_600_000, { zh: '某所将上线 XYZ', en: null })];
  await advance(13_000);
  assert.deepEqual(h.feed.flash().items.map(item => [item.no, item.pushed]), [[702, false], [700, false]]);
});

test('连着时补读失败按 60 秒重试，不等 5 分钟', async t => {
  const h = harness({ status: 500 });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  h.sockets[0]!.emit('open');
  await settle();
  assert.equal(h.feed.flash().rest.error, 'EQN 快讯接口返回 500');
  const base = h.requests.length;
  h.state.status = 200;
  await advance(60_000);
  assert.equal(h.requests.length, base + 1);
  assert.equal(h.feed.flash().rest.error, null);
  // 成功后回到 5 分钟一次。
  await advance(60_000);
  assert.equal(h.requests.length, base + 1);
});

test('应答的 content-length 超过上限时不读正文直接报错', async t => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  t.after(() => mock.timers.reset());
  let read = false, cancelled = false;
  const fetchImpl = async () => ({ status: 200, ok: true, headers: new Headers({ 'content-length': '2000001' }), body: { cancel: async () => { cancelled = true; } }, text: async () => { read = true; return '{}'; } });
  const feed = createNewsFeed({ fetchImpl: fetchImpl as unknown as typeof fetch, connect: url => new FakeSocket(url), random: () => 0.5, log: () => {} });
  t.after(() => feed.close());
  await settle();
  assert.equal(feed.flash().rest.error, 'EQN 快讯应答过大');
  assert.equal(read, false);
  assert.equal(cancelled, true);
});

test('异动行情：停止后再读能重新开始，同一时刻只跑一轮；列表有上限', async t => {
  const many = Array.from({ length: 250 }, (_, i) => ({ ...restItem(1_000 + i, T0 - i * 1_000), channels: ['pricechange'], url: `https://eqn.news/monitor/${1_000 + i}` }));
  const h = harness({ pages: { pricechange: many } });
  t.after(() => { h.feed.close(); mock.timers.reset(); });
  await settle();
  const movesRequests = () => h.requests.filter(url => !url.includes('channel=main')).length;
  h.feed.moves();
  h.feed.moves();
  await settle();
  assert.equal(movesRequests(), 4, '连读两次只跑一轮');
  const view = h.feed.moves();
  assert.equal(view.items.length, 200);
  assert.equal(view.items[0]!.no, 1_000);
  await advance(MOVES_INTEREST_MS + 2 * MOVES_POLL_MS);
  const stopped = movesRequests();
  await advance(3 * MOVES_POLL_MS);
  assert.equal(movesRequests(), stopped);
  h.feed.moves();
  await settle();
  assert.equal(movesRequests(), stopped + 4, '停止后再读重新开始');
  // 快讯接口只返回最新 100 条。
  const socket = h.sockets.at(-1)!;
  socket.emit('open');
  for (let i = 0; i < 150; i++) socket.emit('message', frame(2_000 + i, `推送 ${i}`));
  assert.equal(h.feed.flash().items.length, 100);
});
