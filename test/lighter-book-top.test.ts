// Lighter 行情流的一档来源（docs/dexspread.md 第 20 节）：订阅了盘口的市场取已同步盘口的最优价，其余与盘口不可用时取 market_stats。
// 行情都是假的：WebSocket 由测试替换，不连任何外部服务。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOK_TOP_SILENT_MS, LighterStream, type SocketLike } from '../src/varlighter/feeds.ts';

const T0 = Date.parse('2026-11-23T15:00:00Z');

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.({}); }
  push(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

function harness(depth: number[] = [1]) {
  const state = { clock: T0 };
  const sockets: FakeSocket[] = [], tops: number[] = [];
  const stream = new LighterStream({ venue: 'lighter', connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, now: () => state.clock, onTop: id => tops.push(id) });
  stream.setDepthMarkets(new Map(depth.map(id => [id, String(id)])));
  stream.start();
  sockets[0].open();
  const socket = () => sockets.at(-1)!;
  const stats = (type: 'subscribed' | 'update', items: Record<number, Record<string, string>>) =>
    socket().push({ type: `${type}/market_stats`, channel: 'market_stats:all', market_stats: Object.fromEntries(Object.entries(items).map(([id, item]) => [id, { market_id: Number(id), ...item }])) });
  const book = (type: 'subscribed' | 'update', value: Record<string, unknown>, id = 1) => socket().push({ type: `${type}/order_book`, channel: `order_book:${id}`, order_book: value });
  const level = (price: string, size = '5') => ({ price, size });
  const top = (id = 1, at = state.clock) => { const point = stream.topAt(id, at); return point ? [point.bid, point.ask] : null; };
  return { state, sockets, tops, stream, socket, stats, book, level, top };
}

test('订阅了盘口的市场一档取盘口的最优价：比 market_stats 先变，market_stats 后到的旧价不覆盖，标记价与资金费仍取 market_stats', () => {
  const h = harness();
  try {
    h.stats('subscribed', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100', index_price: '100', current_funding_rate: '0.0012' }, 2: { best_bid_price: '49.9', best_ask_price: '50.1' } });
    assert.deepEqual(h.top(), [99.9, 100.1], '盘口快照到之前用 market_stats 的');
    h.tops.length = 0;
    h.state.clock += 200;
    h.book('subscribed', { code: 0, bids: [h.level('99.95'), h.level('99.9')], asks: [h.level('100.05'), h.level('100.1')], nonce: 1 });
    assert.deepEqual(h.top(), [99.95, 100.05], '盘口同步后取盘口的最优价');
    assert.deepEqual(h.tops, [1], '盘口的一档变了就通知');
    assert.deepEqual(h.top(1, T0 + 100), [99.9, 100.1], '之前的时刻仍是当时的一档');
    const point = h.stream.topAt(1, h.state.clock)!;
    assert.deepEqual([point.mark, point.index], [100, 100], '标记价与指数价沿用 market_stats 的');
    assert.ok(Math.abs(point.funding! - 0.000012) < 1e-12);

    // market_stats 晚到的旧买卖价不覆盖盘口的；它带的标记价照常更新，不算一档变化。
    h.state.clock += 500;
    h.stats('update', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100.2' } });
    assert.deepEqual(h.top(), [99.95, 100.05]);
    assert.equal(h.stream.topAt(1, h.state.clock)!.mark, 100.2);
    assert.deepEqual(h.tops, [1], '买卖价没变不通知');

    // 最优档被删掉：这一侧重扫出新的最优；另一侧来了更优的档。
    h.state.clock += 100;
    h.book('update', { bids: [h.level('99.95', '0')], asks: [h.level('100.02')], begin_nonce: 1, nonce: 2 });
    assert.deepEqual(h.top(), [99.9, 100.02]);
    assert.deepEqual(h.tops, [1, 1]);
    // 不在最优的档变化、最优档只改数量：一档不变，不通知也不多记。
    h.book('update', { bids: [h.level('99.5'), h.level('99.9', '9')], asks: [h.level('100.3')], begin_nonce: 2, nonce: 3 });
    assert.deepEqual(h.top(), [99.9, 100.02]);
    assert.deepEqual(h.tops, [1, 1]);

    // 没订阅盘口的市场照旧跟 market_stats。
    h.stats('update', { 2: { best_bid_price: '50.0' } });
    assert.deepEqual(h.top(2), [50, 50.1]);
    assert.deepEqual(h.tops, [1, 1, 2]);

    // 定期重订阅 market_stats 的快照：确认当前一档，仍是盘口的。
    h.state.clock += 60_000;
    h.book('update', { bids: [], asks: [], begin_nonce: 3, nonce: 4 });
    h.stats('subscribed', { 1: { best_bid_price: '99.8', best_ask_price: '100.2', mark_price: '100.2' } });
    assert.deepEqual(h.top(), [99.9, 100.02]);
    assert.equal(h.stream.topAt(1, h.state.clock)!.at, h.state.clock, '快照确认了这一刻的一档');
  } finally { h.stream.close(); }
});

test('盘口不可用时一档退回 market_stats：增量断档重订、快照倒挂、一侧为空、退订；恢复后再取盘口', () => {
  const h = harness();
  try {
    h.stats('subscribed', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100' } });
    h.state.clock += 6_000;
    h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
    assert.deepEqual(h.top(), [99.95, 100.05]);
    h.tops.length = 0;

    // 增量断档：盘口作废重订，一档马上退回 market_stats 最近报的。
    h.state.clock += 100;
    h.book('update', { bids: [h.level('99.97')], asks: [], begin_nonce: 5, nonce: 6 });
    assert.deepEqual(h.top(), [99.9, 100.1]);
    assert.deepEqual(h.tops, [1], '退回也是一次一档变化');
    assert.equal(h.stream.depth(1), null);
    // 期间 market_stats 的更新照常生效。
    h.stats('update', { 1: { best_bid_price: '99.92' } });
    assert.deepEqual(h.top(), [99.92, 100.1]);

    // 倒挂或一侧为空的快照不采用。
    h.book('subscribed', { code: 0, bids: [h.level('100.2')], asks: [h.level('100.1')], nonce: 10 });
    assert.deepEqual(h.top(), [99.92, 100.1], '倒挂的盘口不当一档');
    h.book('update', { bids: [h.level('100.2', '0')], asks: [], begin_nonce: 10, nonce: 11 });
    assert.deepEqual(h.top(), [99.92, 100.1], '买盘空了也不用');
    h.book('update', { bids: [h.level('99.96')], asks: [], begin_nonce: 11, nonce: 12 });
    assert.deepEqual(h.top(), [99.96, 100.1], '两侧都有、不倒挂了就取盘口的');

    // 盘口后来倒挂（漏了增量的迹象）：退回 market_stats。
    h.book('update', { bids: [h.level('100.4')], asks: [], begin_nonce: 12, nonce: 13 });
    assert.deepEqual(h.top(), [99.92, 100.1]);

    // 退订：退回 market_stats，之后的盘口消息不再影响一档。
    h.book('update', { bids: [h.level('100.4', '0')], asks: [], begin_nonce: 13, nonce: 14 });
    assert.deepEqual(h.top(), [99.96, 100.1]);
    h.stream.setDepthMarkets(new Map());
    assert.deepEqual(h.top(), [99.92, 100.1]);
    h.book('update', { bids: [h.level('99.99')], asks: [], begin_nonce: 14, nonce: 15 });
    assert.deepEqual(h.top(), [99.92, 100.1]);
  } finally { h.stream.close(); }
});

test('盘口快照先于 market_stats 快照到：区间开启时补记盘口的一档；断线后不沿用断线前的盘口', () => {
  const h = harness();
  try {
    h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
    assert.equal(h.top(), null, '还没有 market_stats 快照，区间没开');
    assert.deepEqual(h.tops, []);
    h.state.clock += 300;
    h.stats('subscribed', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100' } });
    assert.deepEqual(h.top(), [99.95, 100.05], '区间一开就用已同步的盘口');
    assert.equal(h.stream.topAt(1, h.state.clock)!.mark, 100);
    assert.equal(h.top(1, T0), null, '区间开启前的时刻没有一档');

    // 断线重连：新连接的 market_stats 快照先到，盘口快照还没到时用 market_stats 的。
    h.state.clock += 1_000;
    h.socket().onclose?.({});
    assert.equal(h.top(), null);
    (h.stream as unknown as { retry: ReturnType<typeof setTimeout> | null }).retry && clearTimeout((h.stream as unknown as { retry: ReturnType<typeof setTimeout> }).retry);
    (h.stream as unknown as { retry: null }).retry = null;
    h.stream.start();
    h.socket().open();
    h.state.clock += 500;
    h.stats('subscribed', { 1: { best_bid_price: '99.7', best_ask_price: '100.3', mark_price: '100' } });
    assert.deepEqual(h.top(), [99.7, 100.3], '不沿用断线前的盘口一档');
    h.book('subscribed', { code: 0, bids: [h.level('99.8')], asks: [h.level('100.2')], nonce: 1 });
    assert.deepEqual(h.top(), [99.8, 100.2]);
  } finally { h.stream.close(); }
});

test('盘口长时间没有消息而 market_stats 报了不同的买卖价：作废重订并退回 market_stats；没超时或两边一致时不动', () => {
  const h = harness();
  const resent = () => h.socket().sent.filter(item => String(item.channel).startsWith('order_book')).map(item => `${item.type} ${item.channel}`);
  try {
    h.stats('subscribed', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100' } });
    h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
    h.socket().sent.length = 0;

    // 盘口刚有过消息：market_stats 不同是它晚到，不动。
    h.state.clock += BOOK_TOP_SILENT_MS;
    h.stats('update', { 1: { best_bid_price: '99.8', best_ask_price: '100.2' } });
    assert.deepEqual([h.top(), resent()], [[99.95, 100.05], []]);

    // 超过时限、market_stats 与盘口一致：盘口只是没变化，不动。
    h.state.clock += 1;
    h.stats('update', { 1: { best_bid_price: '99.95', best_ask_price: '100.05' } });
    assert.deepEqual([h.top(), resent()], [[99.95, 100.05], []]);
    // 两边一致时，只带标记价的更新也不触发。
    h.stats('update', { 1: { mark_price: '100.1' } });
    assert.deepEqual(resent(), []);

    // 超过时限、market_stats 报了不同的买卖价：盘口订阅没跟上，重订并退回。
    h.tops.length = 0;
    h.stats('update', { 1: { best_bid_price: '99.6', best_ask_price: '99.8' } });
    assert.deepEqual(resent(), ['unsubscribe order_book/1', 'subscribe order_book/1']);
    assert.deepEqual(h.top(), [99.6, 99.8]);
    assert.deepEqual(h.tops, [1], '退回只通知一次');
    assert.equal(h.stream.depthError(1), '盘口没有跟上一档的变化，重新订阅');

    // 新快照到了恢复取盘口。
    h.book('subscribed', { code: 0, bids: [h.level('99.62')], asks: [h.level('99.78')], nonce: 9 });
    assert.deepEqual(h.top(), [99.62, 99.78]);

    // 新快照仍与同一组 stats 价不同：沉默时限内不反复重订，再次超过时限要继续核对，不能永久豁免。
    h.socket().sent.length = 0;
    h.stats('update', { 1: { best_bid_price: '99.6', best_ask_price: '99.8' } });
    assert.deepEqual([h.top(), resent()], [[99.62, 99.78], []]);
    h.state.clock += BOOK_TOP_SILENT_MS + 1;
    h.stats('update', { 1: { mark_price: '99.7' } });
    assert.deepEqual(resent(), ['unsubscribe order_book/1', 'subscribe order_book/1']);
    assert.deepEqual(h.top(), [99.6, 99.8]);

    // 两边恢复一致会清掉核对记录；之后再次错位、盘口又沉默时仍会重订。
    h.book('subscribed', { code: 0, bids: [h.level('99.6')], asks: [h.level('99.8')], nonce: 10 });
    h.socket().sent.length = 0;
    h.stats('update', { 1: { best_bid_price: '99.6', best_ask_price: '99.8' } });
    h.state.clock += 100;
    h.book('update', { bids: [h.level('99.62')], asks: [h.level('99.78')], begin_nonce: 10, nonce: 11 });
    h.state.clock += BOOK_TOP_SILENT_MS + 10_000;
    h.stats('update', { 1: { best_bid_price: '99.5', best_ask_price: '99.8' } });
    assert.deepEqual(resent(), ['unsubscribe order_book/1', 'subscribe order_book/1']);
    assert.deepEqual(h.top(), [99.5, 99.8]);
  } finally { h.stream.close(); }
});

test('盘口卡住而 market_stats 的买卖价只变过一次、之后只有标记价在动：过了时限照样作废重订，不把旧盘口当成新的', () => {
  const h = harness();
  const resent = () => h.socket().sent.filter(item => String(item.channel).startsWith('order_book')).map(item => `${item.type} ${item.channel}`);
  try {
    h.stats('subscribed', { 1: { best_bid_price: '99.9', best_ask_price: '100.1', mark_price: '100' } });
    h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
    h.socket().sent.length = 0;
    // 盘口最后一条消息之后 5 秒 market_stats 的买卖价变了：还在时限内，当它晚到，仍用盘口的。
    h.state.clock += 5_000;
    h.stats('update', { 1: { best_bid_price: '99.4', best_ask_price: '99.6' } });
    assert.deepEqual([h.top(), resent()], [[99.95, 100.05], []]);
    // 之后盘口一直没有消息，market_stats 只推标记价。
    h.state.clock += BOOK_TOP_SILENT_MS - 5_000;
    h.stats('update', { 1: { mark_price: '99.5' } });
    assert.deepEqual([h.top(), resent()], [[99.95, 100.05], []], '刚到时限还不动');
    h.state.clock += 1;
    h.stats('update', { 1: { mark_price: '99.51' } });
    assert.deepEqual(resent(), ['unsubscribe order_book/1', 'subscribe order_book/1']);
    assert.deepEqual(h.top(), [99.4, 99.6], '退回 market_stats 最近报的买卖价');
    assert.equal(h.stream.topAt(1, h.state.clock)!.mark, 99.51);
  } finally { h.stream.close(); }
});

test('market_stats 有条目但买卖价无效：盘口作废后退回无效价，立即清掉旧一档', () => {
  for (const [name, quoted] of [
    ['零价', { best_bid_price: '0', best_ask_price: '0' }],
    ['缺一侧', { best_bid_price: '99.9' }],
    ['倒挂', { best_bid_price: '100.2', best_ask_price: '100.1' }],
  ] as const) {
    const h = harness();
    try {
      h.stats('subscribed', { 1: quoted });
      h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
      assert.deepEqual(h.top(), [99.95, 100.05], name);
      h.state.clock += 100;
      h.book('update', { bids: [h.level('99.97')], asks: [], begin_nonce: 5, nonce: 6 });
      assert.equal(h.top(), null, `${name}：作废盘口后不能继续取旧价`);
    } finally { h.stream.close(); }
  }
});
test('market_stats 没报过的市场：盘口作废后没有一档可用，不留着盘口的旧价', () => {
  const h = harness();
  try {
    h.stats('subscribed', { 2: { best_bid_price: '49.9', best_ask_price: '50.1' } });
    h.book('subscribed', { code: 0, bids: [h.level('99.95')], asks: [h.level('100.05')], nonce: 1 });
    assert.deepEqual(h.top(), [99.95, 100.05], '只有盘口时用盘口的');
    h.state.clock += 100;
    h.book('update', { bids: [h.level('99.97')], asks: [], begin_nonce: 5, nonce: 6 });
    assert.equal(h.top(), null, '增量断档作废后，没有 market_stats 的价可退');
    assert.deepEqual(h.top(2), [49.9, 50.1]);
    h.book('subscribed', { code: 0, bids: [h.level('99.96')], asks: [h.level('100.04')], nonce: 9 });
    assert.deepEqual(h.top(), [99.96, 100.04], '新快照到了再用盘口的');
  } finally { h.stream.close(); }
});
