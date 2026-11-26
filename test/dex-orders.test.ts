// DEX 价差实盘的下单连接器（src/varlighter/orders.ts，docs/dexspread.md 第 13 节）：Entropy 与 Lighter 各自的成交、未成交、拒绝、
// 结果未知与查单。交易所应答全是替身，签名器也是替身，不连任何外部服务；私钥是固定的假值。
// 贯穿的要求（L039、L093、L212）：发出去了但没有确定应答的单只能是 unknown，绝不能当成没成交；「查不到」（absent）与「没查成」（unknown）要分开，
// 连接器自己不凭时间把「查不到」判成没成交，那要由 live.ts 结合账户持仓与订单过期时限决定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENTROPY_ENDPOINTS, LIGHTER_ENDPOINTS } from '../src/varlighter/feeds.ts';
import { signL1Action, type PackValue } from '../src/varlighter/hyperliquid.ts';
import type { LighterOrderInput, LighterSigner } from '../src/varlighter/lighter-signer.ts';
import type { MarketSpec } from '../src/varlighter/model.ts';
import { ORDER_EXPIRY_MS, cloidOf, createEntropyTrader, createLighterTrader, scrub, type ResolveOutcome, type VenueOrder } from '../src/varlighter/orders.ts';

const T0 = Date.parse('2026-11-27T15:00:00Z');
const ENTROPY_KEY = '0x' + '11'.repeat(32), LIGHTER_KEY = 'ab'.repeat(40);
const ADDRESS = '0x00000000000000000000000000000000000000ab', ACCOUNT = 987654;
const EXCHANGE = 'https://api.hyperliquid.xyz/exchange';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const text = (value: string, status: number) => new Response(value, { status });
const market = (venue: MarketSpec['venue'], id: number, extra: Partial<MarketSpec> = {}): MarketSpec => ({ venue, symbol: 'NVDA', name: '', id, mark: 100, index: null, fundingHourly: null, sizeDecimals: 2, priceDecimals: 3, minBase: 0.01, minQuote: 10, takerFeeBps: 0, ...extra });
const order = (spec: MarketSpec, clientId: number, extra: Partial<VenueOrder> = {}): VenueOrder => ({ market: spec, side: 'buy', qty: 0.5, limit: 100.5, reduceOnly: false, clientId, ...extra });
const signalFor = () => new AbortController().signal;
/** 备注与原因里不带私钥、地址、账户编号，也没有长的十六进制串。 */
function clean(outcome: ResolveOutcome, label: string): void {
  const said = outcome.kind === 'done' ? outcome.note : outcome.reason;
  assert.ok(said.length > 0 && said.length <= 200, `${label}：要有说明`);
  assert.ok(!/[0-9a-fA-F]{24,}/.test(said) && !said.includes(String(ACCOUNT)) && !said.toLowerCase().includes(ADDRESS.slice(2, 14)), `${label}：说明里带了标识：${said}`);
}
const unknownOnly = (outcome: ResolveOutcome, label: string) => { assert.equal(outcome.kind, 'unknown', `${label}：结果不明的单不能当成有了结论（${JSON.stringify(outcome)}）`); clean(outcome, label); };
const absentOnly = (outcome: ResolveOutcome, label: string) => { assert.equal(outcome.kind, 'absent', `${label}：读成功但没有最终结果，只能报查不到（${JSON.stringify(outcome)}）`); clean(outcome, label); };

test('报错文本清洗：地址、长十六进制与长数字都去掉，并限制长度', () => {
  assert.equal(scrub(`User or API Wallet ${ADDRESS} does not exist.`), 'User or API Wallet 0x… does not exist.');
  assert.equal(scrub(`key ${LIGHTER_KEY} account ${ACCOUNT} nonce 42`), 'key … account … nonce 42');
  assert.equal(scrub(`sig ${'AB'.repeat(12)} ok`), 'sig … ok');
  assert.equal(scrub(ENTROPY_KEY), '0x…');
  assert.equal(scrub('x'.repeat(500)).length, 160);
  // 截断发生在清洗之后：被截断处不会留下半截私钥。
  assert.ok(!/[0-9a-f]{16,}/.test(scrub('y'.repeat(150) + LIGHTER_KEY)));
});

// ---- Entropy ----
interface Call { url: string; body: any; raw: string }
function entropyHarness(start = T0) {
  const calls: Call[] = [];
  let clock = start;
  let dexes: (status?: number) => Response = () => json([null, { name: 'xyz' }, { name: ENTROPY_ENDPOINTS.dex }]);
  let exchange: () => Response | Promise<Response> = () => json({});
  let status: () => Response | Promise<Response> = () => json({ status: 'unknownOid' });
  const fetchImpl = async (url: string, init: RequestInit) => {
    const raw = String(init.body ?? ''), body = raw ? JSON.parse(raw) : null;
    calls.push({ url, body, raw });
    assert.equal(init.method, 'POST');
    assert.ok(init.signal instanceof AbortSignal, '每个请求都带时限信号');
    if (url === EXCHANGE) return exchange();
    assert.equal(url, ENTROPY_ENDPOINTS.info);
    return body.type === 'perpDexs' ? dexes() : status();
  };
  const trader = createEntropyTrader({ key: { address: ADDRESS, privateKey: ENTROPY_KEY }, fetchImpl, now: () => clock });
  return {
    trader, calls, sent: () => calls.filter(call => call.url === EXCHANGE),
    set clock(value: number) { clock = value; }, get clock() { return clock; },
    set exchange(value: () => Response | Promise<Response>) { exchange = value; },
    set status(value: () => Response | Promise<Response>) { status = value; },
    set dexes(value: () => Response) { dexes = value; },
  };
}
const filled = (size: string, price: string) => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: size, avgPx: price, oid: 77 } }] } } });
const IO = market('entropy', 3, { coin: 'io:NVDA' });

test('Entropy 下单：成交回报给出数量与均价；请求体带自编号与对得上的签名，不带私钥', async () => {
  const h = entropyHarness();
  h.exchange = () => filled('0.5', '100.2');
  const outcome = await h.trader.place(order(IO, 1_800_000_000_001), signalFor);
  assert.deepEqual(outcome, { kind: 'done', filledQty: 0.5, avgPrice: 100.2, note: '已成交' });
  assert.deepEqual(h.calls.map(call => call.url), [ENTROPY_ENDPOINTS.info, EXCHANGE]);
  assert.deepEqual(h.calls[0]!.body, { type: 'perpDexs' });
  const body = h.sent()[0]!.body;
  // 资产编号 = 100000 + 盘序号（io 在第 2 项）× 10000 + 盘内序号 3。
  assert.deepEqual(body.action, { type: 'order', orders: [{ a: 120003, b: true, p: '100.5', s: '0.5', r: false, t: { limit: { tif: 'Ioc' } }, c: cloidOf(1_800_000_000_001) }], grouping: 'na' });
  assert.match(body.action.orders[0].c, /^0x[0-9a-f]{32}$/);
  assert.deepEqual([body.nonce, body.vaultAddress], [T0, null]);
  assert.deepEqual(body.signature, signL1Action(body.action as PackValue, body.nonce, ENTROPY_KEY), '签的就是发出去的动作与 nonce');
  assert.match(body.signature.r, /^0x[0-9a-f]{64}$/);
  assert.ok(!h.calls.some(call => call.raw.includes(ENTROPY_KEY.slice(2))), '请求里没有私钥');

  // 第二笔：卖出只减仓；盘序号已缓存不再读，nonce 在同一毫秒内也递增。
  h.exchange = () => filled('0.25', '0');
  const second = await h.trader.place(order(IO, 1_800_000_000_002, { side: 'sell', qty: 0.25, limit: 99.5, reduceOnly: true }), signalFor);
  assert.deepEqual(second, { kind: 'done', filledQty: 0.25, avgPrice: null, note: '已成交' }, '没有有效均价时为 null，由上层按限价估');
  assert.equal(h.calls.filter(call => call.body?.type === 'perpDexs').length, 1);
  const next = h.sent()[1]!.body;
  assert.deepEqual([next.action.orders[0].b, next.action.orders[0].r, next.action.orders[0].s, next.nonce], [false, true, '0.25', T0 + 1]);
  // 时钟回拨时 nonce 仍然递增。
  h.clock = T0 - 5_000;
  await h.trader.place(order(IO, 1_800_000_000_003), signalFor);
  assert.equal(h.sent()[2]!.body.nonce, T0 + 2);
});

test('Entropy 下单：IOC 没有对手盘是确定的未成交，交易所拒绝是确定的 0；说明里不带地址与编号', async () => {
  const h = entropyHarness();
  h.exchange = () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: 'Order could not immediately match against any resting orders. asset=120003' }] } } });
  const missed = await h.trader.place(order(IO, 11), signalFor);
  assert.deepEqual([missed.kind, missed.kind === 'done' && missed.filledQty, missed.kind === 'done' && missed.avgPrice], ['done', 0, null]);
  assert.match((missed as { note: string }).note, /^未成交：Order could not immediately match/);
  assert.ok(!(missed as { note: string }).note.includes('120003'));
  clean(missed, 'IOC 未成交');

  h.exchange = () => json({ status: 'err', response: `User or API Wallet ${ADDRESS} does not exist.` });
  const rejected = await h.trader.place(order(IO, 12), signalFor);
  assert.deepEqual(rejected, { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所拒绝：User or API Wallet 0x… does not exist.' });
  clean(rejected, '拒绝');
  h.exchange = () => json({ status: 'err', response: { code: 1 } });
  assert.deepEqual(await h.trader.place(order(IO, 13), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所拒绝：未说明原因' });
  // 4xx（格式、限流）：交易所没有受理。
  h.exchange = () => text('Too Many Requests', 429);
  assert.deepEqual(await h.trader.place(order(IO, 14), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所没有受理（HTTP 429）' });
  h.exchange = () => json({ error: 'bad' }, 422);
  assert.equal((await h.trader.place(order(IO, 15), signalFor)).kind, 'done');
  h.exchange = () => text('Bad Request', 400);
  assert.equal((await h.trader.place(order(IO, 151), signalFor)).kind, 'done');
  // 其余 4xx（中间层的 403、408、499 等）读不懂：不能当成没受理。
  for (const status of [401, 403, 404, 408, 499]) {
    h.exchange = () => text('nope', status);
    unknownOnly(await h.trader.place(order(IO, 152), signalFor), `HTTP ${status}`);
  }
  // 部分成交照实报。
  h.exchange = () => filled('0.2', '100.4');
  assert.deepEqual(await h.trader.place(order(IO, 16), signalFor), { kind: 'done', filledQty: 0.2, avgPrice: 100.4, note: '已成交' });
});

test('Entropy 下单：HTTP 5xx、超时、断网、读不懂的应答一律是结果未知，绝不当成没成交', async () => {
  const h = entropyHarness();
  const cases: [string, () => Response | Promise<Response>][] = [
    ['HTTP 500 非 JSON', () => text('Internal Server Error', 500)],
    ['HTTP 502 网关页', () => text('<html>Bad Gateway</html>', 502)],
    ['HTTP 503 空 JSON', () => json({}, 503)],
    ['HTTP 504', () => text('', 504)],
    ['超时', () => Promise.reject(new DOMException('The operation was aborted', 'AbortError'))],
    ['断网（报错里带地址与私钥样的串）', () => Promise.reject(new Error(`connect ECONNRESET ${ADDRESS} ${LIGHTER_KEY}`))],
    ['抛出的不是 Error', () => Promise.reject(`socket hang up ${ACCOUNT}`)],
    ['HTTP 200 但不是 JSON', () => text('ok', 200)],
    ['HTTP 200 空对象', () => json({})],
    ['HTTP 200 数组', () => json([])],
    ['应答过大', () => text('x'.repeat(300 * 1024), 200)],
    ['ok 但没有 statuses', () => json({ status: 'ok', response: { type: 'order', data: {} } })],
    ['ok 但 statuses 为空', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [] } } })],
    ['ok 但 statuses 有两条', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '0.5', avgPx: '1' } }, { filled: { totalSz: '0.5', avgPx: '1' } }] } } })],
    ['ok 但条目是字符串', () => json({ status: 'ok', response: { type: 'order', data: { statuses: ['waitingForFill'] } } })],
    ['IOC 单显示挂着', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: 77 } }] } } })],
    ['成交数量缺失', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { avgPx: '100' } }] } } })],
    ['成交数量为负', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: '-1', avgPx: '100' } }] } } })],
    ['成交数量不是数字', () => json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: 'abc', avgPx: '100' } }] } } })],
  ];
  let id = 100;
  for (const [label, answer] of cases) {
    h.exchange = answer;
    unknownOnly(await h.trader.place(order(IO, ++id), signalFor), label);
  }
  assert.equal(h.sent().length, cases.length, '每笔只发一次，连接器自己不重发');
  assert.equal(new Set(h.sent().map(call => call.body.action.orders[0].c)).size, cases.length);
});

test('Entropy 下单：发出之前就失败（读不到盘序号、数量或价格无效）是确定的没有发出，不占用交易所请求', async () => {
  const h = entropyHarness();
  for (const [label, dexes] of [['HTTP 500', () => json({}, 500)], ['没有 io 盘', () => json([null, { name: 'xyz' }])], ['io 在第 0 项', () => json([{ name: 'io' }])], ['不是数组', () => json({ name: 'io' })]] as [string, () => Response][]) {
    h.dexes = dexes;
    const outcome = await h.trader.place(order(IO, 21), signalFor);
    assert.deepEqual([outcome.kind, outcome.kind === 'done' && outcome.filledQty], ['done', 0], label);
    assert.match((outcome as { note: string }).note, /^没有发出：读不到 Entropy 所在盘的序号/, label);
  }
  assert.equal(h.sent().length, 0);
  // 失败不缓存：盘序号读到之后照常下单。
  h.dexes = () => json([null, { name: ENTROPY_ENDPOINTS.dex }]);
  h.exchange = () => filled('0.5', '100');
  assert.equal((await h.trader.place(order(IO, 22), signalFor)).kind, 'done');
  assert.equal(h.sent()[0]!.body.action.orders[0].a, 110003);
  for (const [label, bad] of [['数量为 0', { qty: 0 }], ['数量为负', { qty: -1 }], ['价格为 0', { limit: 0 }], ['价格不是数', { limit: NaN }], ['数量超过 8 位小数', { qty: 0.123456789 }], ['自编号为负', { clientId: -5 }]] as [string, Partial<VenueOrder>][]) {
    const outcome = await h.trader.place(order(IO, 23, bad), signalFor);
    assert.deepEqual([outcome.kind, outcome.kind === 'done' && outcome.filledQty, /^没有发出：/.test((outcome as { note: string }).note)], ['done', 0, true], label);
  }
  assert.equal(h.sent().length, 1, '无效的单没有发到交易所');
});

test('Entropy 查单：按自编号查，成交与撤销照实报；查不到报 absent（不论过了多久），还挂着与没查成一律未知', async () => {
  const h = entropyHarness();
  const target = order(IO, 1_800_000_000_009), sentAt = T0;
  const found = (state: string, original: string, remaining: string) => json({ status: 'order', order: { order: { coin: 'io:NVDA', side: 'B', limitPx: '100.5', sz: remaining, oid: 77, origSz: original, cloid: cloidOf(target.clientId) }, status: state, statusTimestamp: T0 } });
  h.status = () => found('filled', '0.5', '0.0');
  assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'done', filledQty: 0.5, avgPrice: null, note: '查单结果：filled' });
  assert.deepEqual(h.calls[0], { url: ENTROPY_ENDPOINTS.info, body: { type: 'orderStatus', user: ADDRESS, oid: cloidOf(target.clientId) }, raw: h.calls[0]!.raw });
  assert.equal(h.sent().length, 0, '查单不发任何订单');
  h.status = () => found('canceled', '0.5', '0.3');
  assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'done', filledQty: 0.2, avgPrice: null, note: '查单结果：canceled' });
  h.status = () => found('iocCancelRejected', '0.5', '0.5');
  assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '查单结果：iocCancelRejected' });

  // 查不到：连接器只报 absent，过了订单过期时限也一样；判不判零成交由上层结合持仓决定。
  h.status = () => json({ status: 'unknownOid' });
  for (const at of [sentAt + 1, sentAt + ORDER_EXPIRY_MS.entropy, sentAt + 24 * 3_600_000]) {
    h.clock = at;
    assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'absent', reason: '交易所查无此单' });
  }
  // 还挂着、待触发：这笔单还活着、随时可能成交，保持不明，不能进入判零。
  h.status = () => found('open', '0.5', '0.5');
  unknownOnly(await h.trader.resolve(target, sentAt, signalFor), '还挂着');
  h.status = () => found('triggered', '0.5', '0.5');
  unknownOnly(await h.trader.resolve(target, sentAt, signalFor), '待触发');

  // 没查成：不论过了多久都不能当成没成交。
  h.clock = sentAt + 24 * 3_600_000;
  const failures: [string, () => Response | Promise<Response>][] = [
    ['HTTP 500', () => text('err', 500)], ['HTTP 429', () => text('slow down', 429)], ['HTTP 500 带 unknownOid', () => json({ status: 'unknownOid' }, 500)],
    ['超时', () => Promise.reject(new DOMException('aborted', 'AbortError'))], ['断网', () => Promise.reject(new Error(`ECONNREFUSED ${ADDRESS}`))],
    ['不是 JSON', () => text('<html>', 200)], ['数组', () => json([])], ['状态不认识', () => json({ status: 'weird' })], ['没有订单体', () => json({ status: 'order' })],
    ['剩余大于原始', () => found('filled', '0.5', '0.6')], ['剩余为负', () => found('filled', '0.5', '-0.1')], ['数量缺失', () => json({ status: 'order', order: { order: { cloid: 'x' }, status: 'filled' } })],
  ];
  for (const [label, answer] of failures) { h.status = answer; unknownOnly(await h.trader.resolve(target, sentAt, signalFor), label); }
  assert.equal(h.sent().length, 0);
});

// ---- Lighter ----
interface LighterCall { kind: 'nextNonce' | 'sendTx' | 'accountOrders'; url: string; body: string | null; auth: string | null; tag: string }
type Answer = () => Response | Promise<Response>;
const M7 = market('lighter', 7);
function lighterHarness(venue: 'lighter' | 'rh' = 'lighter', start = T0) {
  const rest = LIGHTER_ENDPOINTS[venue].rest;
  const calls: LighterCall[] = [], signed: LighterOrderInput[] = [], pauses: number[] = [], tokens: number[] = [];
  let clock = start, serverNonce = 40;
  let nonceAnswer: Answer = () => json({ code: 200, nonce: serverNonce });
  let sendAnswer: Answer = () => json({ code: 200, tx_hash: 'hash' });
  /** 每次查单取队首；队列空了就用 fallback。 */
  const lookups: Answer[] = [];
  let fallback: Answer = () => json({ code: 200, orders: [] });
  let signerFault: (() => never) | null = null, signerLoad: Error | null = null;
  const fetchImpl = async (url: string, init: RequestInit) => {
    assert.ok(url.startsWith(rest + '/'), `请求发到了别的地址：${url}`);
    assert.ok(init.signal instanceof AbortSignal);
    const kind = url.slice(rest.length + 1).split('?')[0] as LighterCall['kind'];
    const body = typeof init.body === 'string' ? init.body : null, headers = (init.headers ?? {}) as Record<string, string>;
    const tag = kind === 'sendTx' ? String(JSON.parse(new URLSearchParams(body!).get('tx_info')!).client) : kind === 'accountOrders' ? new URL(url).searchParams.get('client_order_indexes')! : '';
    calls.push({ kind, url, body, auth: headers.authorization ?? null, tag });
    await new Promise(resolve => setImmediate(resolve));
    if (kind === 'nextNonce') return nonceAnswer();
    if (kind === 'sendTx') { assert.equal(init.method, 'POST'); return sendAnswer(); }
    return (lookups.shift() ?? fallback)();
  };
  const signer: LighterSigner = {
    signCreateOrder(input) { signerFault?.(); signed.push(input); return { txType: 14, txInfo: JSON.stringify({ client: input.clientOrderIndex, nonce: input.nonce }), txHash: `hash-${input.nonce}` }; },
    createAuthToken(deadline) { tokens.push(deadline); return `auth-token-${tokens.length}`; },
  };
  const trader = createLighterTrader({ venue, key: { accountIndex: ACCOUNT, apiKeyIndex: 5, privateKey: LIGHTER_KEY }, fetchImpl, now: () => clock,
    signer: async () => { if (signerLoad) throw signerLoad; return signer; }, pause: async ms => { pauses.push(ms); } });
  return {
    trader, calls, signed, pauses, tokens, lookups, rest,
    kinds: () => calls.map(call => call.kind), count: (kind: LighterCall['kind']) => calls.filter(call => call.kind === kind).length,
    set clock(value: number) { clock = value; }, get clock() { return clock; },
    set serverNonce(value: number) { serverNonce = value; },
    set nonceAnswer(value: Answer) { nonceAnswer = value; }, set sendAnswer(value: Answer) { sendAnswer = value; }, set fallback(value: Answer) { fallback = value; },
    set signerFault(value: (() => never) | null) { signerFault = value; }, set signerLoad(value: Error | null) { signerLoad = value; },
  };
}
const lighterOrder = (clientId: number, state: string, base: string, quote: string, extra: Record<string, unknown> = {}) => ({ order_index: 5, client_order_index: clientId, market_index: 7, status: state, filled_base_amount: base, filled_quote_amount: quote, ...extra });
const orders = (...items: unknown[]): Answer => () => json({ code: 200, orders: items });

test('Lighter 下单：取 nonce、签名、发送、按自编号查到成交；交易被接受不等于成交', async () => {
  const h = lighterHarness();
  // 第一次还查不到，第二次查到全部成交。
  h.lookups.push(orders(), orders(lighterOrder(555, 'filled', '0.50', '50.1')));
  const outcome = await h.trader.place(order(M7, 555), signalFor);
  assert.deepEqual(outcome, { kind: 'done', filledQty: 0.5, avgPrice: 100.2, note: '已成交' });
  assert.deepEqual(h.kinds(), ['nextNonce', 'sendTx', 'accountOrders', 'accountOrders']);
  assert.deepEqual(h.pauses, [700], '两次查单之间等一下');
  assert.equal(h.calls[0]!.url, `${h.rest}/nextNonce?account_index=${ACCOUNT}&api_key_index=5`);
  // 数量与价格按市场精度换成整数：0.5 → 50（两位），100.5 → 100500（三位）；IOC、不带触发价与过期时间。
  assert.deepEqual(h.signed, [{ marketIndex: 7, clientOrderIndex: 555, baseAmount: 50, price: 100500, isAsk: false, orderType: 1, timeInForce: 0, reduceOnly: false, triggerPrice: 0, orderExpiry: 0, nonce: 40 }]);
  assert.equal(h.calls[1]!.body, new URLSearchParams({ tx_type: '14', tx_info: JSON.stringify({ client: 555, nonce: 40 }) }).toString());
  assert.equal(h.calls[2]!.url, `${h.rest}/accountOrders?account_index=${ACCOUNT}&client_order_indexes=555`);
  assert.deepEqual([h.calls[2]!.auth, h.calls[3]!.auth, h.tokens], ['auth-token-1', 'auth-token-1', [Math.floor(T0 / 1000) + 3600]], '鉴权令牌复用');
  assert.ok(!h.calls.some(call => `${call.url}${call.body}`.includes(LIGHTER_KEY)), '请求里没有私钥');

  // 第二笔：卖出只减仓；nonce 本地加一，不再读 nextNonce。
  h.lookups.push(orders(lighterOrder(556, 'filled', '0.25', '25.5')));
  const second = await h.trader.place(order(M7, 556, { side: 'sell', qty: 0.25, limit: 99.123, reduceOnly: true }), signalFor);
  assert.deepEqual(second, { kind: 'done', filledQty: 0.25, avgPrice: 102, note: '已成交' });
  assert.equal(h.count('nextNonce'), 1);
  assert.deepEqual([h.signed[1]!.nonce, h.signed[1]!.isAsk, h.signed[1]!.reduceOnly, h.signed[1]!.baseAmount, h.signed[1]!.price], [41, true, true, 25, 99123]);

  // RH 走自己的接口地址。
  const rh = lighterHarness('rh');
  rh.lookups.push(orders(lighterOrder(9, 'filled', '0.5', '50')));
  assert.equal((await rh.trader.place(order(market('rh', 7), 9), signalFor)).kind, 'done');
  assert.ok(rh.calls.every(call => call.url.startsWith('https://api.rh.lighter.xyz/api/v1/')));
});

test('Lighter 下单：部分成交后被撤销照实报，全撤是确定的 0；别人的单与还没有结论的状态不算数', async () => {
  const h = lighterHarness();
  h.lookups.push(orders(lighterOrder(601, 'canceled-too-much-slippage', '0.20', '20.1')));
  assert.deepEqual(await h.trader.place(order(M7, 601), signalFor), { kind: 'done', filledQty: 0.2, avgPrice: 100.5, note: '交易所撤销：canceled-too-much-slippage' });
  h.lookups.push(orders(lighterOrder(602, 'canceled-margin-not-allowed', '0', '0')));
  assert.deepEqual(await h.trader.place(order(M7, 602), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所撤销：canceled-margin-not-allowed' });
  h.lookups.push(orders(lighterOrder(603, 'canceled', '0.0', '0.0')));
  assert.deepEqual(await h.trader.place(order(M7, 603), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所撤销：canceled' });
  // 成交了但没给成交额：均价为 null，由上层按限价估。
  h.lookups.push(orders(lighterOrder(604, 'filled', '0.5', '')));
  assert.deepEqual(await h.trader.place(order(M7, 604), signalFor), { kind: 'done', filledQty: 0.5, avgPrice: null, note: '已成交' });

  // 应答里只有别的自编号的单、或者这笔单还在处理中：8 次都没有结论 → 未知，不是没成交。
  h.pauses.length = 0;
  h.fallback = orders(lighterOrder(999, 'filled', '0.5', '50'), lighterOrder(605, 'in-progress', '0', '0'));
  const before = h.count('accountOrders');
  const pending = await h.trader.place(order(M7, 605), signalFor);
  unknownOnly(pending, '一直没有结论');
  assert.match((pending as { reason: string }).reason, /交易已被接受/);
  assert.deepEqual([h.count('accountOrders') - before, h.pauses], [8, Array(7).fill(700)]);
  for (const state of ['open', 'pending', '', null, 7]) {
    h.fallback = orders(lighterOrder(606, state as string, '0.5', '50'));
    unknownOnly(await h.trader.place(order(M7, 606), signalFor), `状态 ${JSON.stringify(state)}`);
  }
  // 查单一直失败（HTTP 500、鉴权失败、成交数量缺失）：同样是未知。
  for (const [label, answer] of [['HTTP 500', () => text('err', 500)], ['HTTP 401', () => json({ code: 20013, message: 'invalid auth' }, 401)], ['断网', () => Promise.reject(new Error('ECONNRESET'))],
    ['code 不是 200', () => json({ code: 29500, message: 'internal' })], ['成交数量缺失', orders({ client_order_index: 607, status: 'filled' })], ['成交数量为负', orders(lighterOrder(607, 'filled', '-1', '5'))]] as [string, Answer][]) {
    h.fallback = answer;
    unknownOnly(await h.trader.place(order(M7, 607), signalFor), `查单 ${label}`);
  }
  assert.equal(h.count('sendTx'), 4 + 1 + 5 + 6, '每笔只发送一次');
});

test('Lighter 下单：接口明确拒绝是确定的 0 并重新取 nonce；说明里不带账户编号', async () => {
  const h = lighterHarness();
  h.sendAnswer = () => json({ code: 21104, message: `invalid nonce 39 for account ${ACCOUNT} key ${LIGHTER_KEY}` }, 400);
  const rejected = await h.trader.place(order(M7, 701), signalFor);
  assert.deepEqual(rejected, { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所拒绝（21104）：invalid nonce 39 for account … key …' });
  clean(rejected, '拒绝');
  assert.equal(h.count('accountOrders'), 0, '被拒的交易不用查单');
  // HTTP 200 里带错误码同样是拒绝。
  h.sendAnswer = () => json({ code: 21502, message: 'margin not enough' });
  assert.deepEqual(await h.trader.place(order(M7, 702), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所拒绝（21502）：margin not enough' });
  h.sendAnswer = () => json({ code: 23000 }, 429);
  assert.deepEqual(await h.trader.place(order(M7, 703), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '交易所拒绝（23000）：' });
  // 每次被拒后 nonce 缓存作废：下一笔重新读 nextNonce，用服务器给的值。
  assert.equal(h.count('nextNonce'), 3);
  h.serverNonce = 77;
  h.sendAnswer = () => json({ code: 200 });
  h.lookups.push(orders(lighterOrder(704, 'filled', '0.5', '50')));
  assert.equal((await h.trader.place(order(M7, 704), signalFor)).kind, 'done');
  assert.deepEqual([h.count('nextNonce'), h.signed.at(-1)!.nonce], [4, 77]);
});

test('Lighter 下单：sendTx 结果不明（5xx、超时、断网、读不懂）是未知，不查单定论、不重发，nonce 缓存作废', async () => {
  const h = lighterHarness();
  const cases: [string, Answer][] = [
    ['HTTP 500 非 JSON', () => text('Internal Server Error', 500)],
    ['HTTP 502 带错误码', () => json({ code: 29500, message: 'internal server error' }, 502)],
    ['HTTP 503', () => json({}, 503)],
    ['超时', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['断网', () => Promise.reject(new Error(`ECONNRESET account ${ACCOUNT}`))],
    ['HTTP 200 非 JSON', () => text('ok', 200)],
    ['HTTP 200 空对象', () => json({})],
    ['HTTP 200 code 是字符串', () => json({ code: '200' })],
    ['HTTP 400 非 JSON', () => text('Bad Request', 400)],
  ];
  let id = 800;
  for (const [label, answer] of cases) {
    h.sendAnswer = answer;
    unknownOnly(await h.trader.place(order(M7, ++id), signalFor), label);
  }
  assert.equal(h.count('sendTx'), cases.length, '每笔只发送一次');
  assert.equal(h.count('nextNonce'), cases.length, '结果不明后 nonce 缓存作废，每笔都重新读');
  assert.equal(h.count('accountOrders'), 0);
  // 之后的一笔照常：重新读 nonce。
  h.serverNonce = 41;
  h.sendAnswer = () => json({ code: 200 });
  h.lookups.push(orders(lighterOrder(900, 'filled', '0.5', '50')));
  assert.equal((await h.trader.place(order(M7, 900), signalFor)).kind, 'done');
  assert.deepEqual([h.count('nextNonce'), h.signed.at(-1)!.nonce], [cases.length + 1, 41]);
});

test('Lighter 下单：发出之前就失败（读不到 nonce、签名器不可用）是确定的没有发出，报错不带私钥', async () => {
  const h = lighterHarness();
  for (const [label, answer] of [['HTTP 500', () => text('err', 500)], ['code 不是 200', () => json({ code: 21100, message: 'account not found' })], ['nonce 为负', () => json({ code: 200, nonce: -1 })],
    ['nonce 是字符串', () => json({ code: 200, nonce: '40' })], ['nonce 是小数', () => json({ code: 200, nonce: 1.5 })], ['断网', () => Promise.reject(new Error('ECONNRESET'))]] as [string, Answer][]) {
    h.nonceAnswer = answer;
    const outcome = await h.trader.place(order(M7, 1001), signalFor);
    assert.deepEqual([outcome.kind, outcome.kind === 'done' && outcome.filledQty, /^没有发出：/.test((outcome as { note: string }).note)], ['done', 0, true], label);
  }
  h.nonceAnswer = () => json({ code: 200, nonce: 40 });
  h.signerFault = () => { throw new Error(`签名失败 key=${LIGHTER_KEY} account=${ACCOUNT}`); };
  const fault = await h.trader.place(order(M7, 1002), signalFor);
  assert.deepEqual(fault, { kind: 'done', filledQty: 0, avgPrice: null, note: '没有发出：签名失败 key=… account=…' });
  h.signerFault = null;
  h.signerLoad = new Error('签名器文件不存在');
  assert.deepEqual(await h.trader.place(order(M7, 1003), signalFor), { kind: 'done', filledQty: 0, avgPrice: null, note: '没有发出：签名器文件不存在' });
  assert.deepEqual([h.count('sendTx'), h.count('accountOrders')], [0, 0], '没有发出任何交易');
  // 签名失败后 nonce 缓存也作废。
  h.signerLoad = null;
  const before = h.count('nextNonce');
  h.lookups.push(orders(lighterOrder(1004, 'filled', '0.5', '50')));
  assert.equal((await h.trader.place(order(M7, 1004), signalFor)).kind, 'done');
  assert.equal(h.count('nextNonce'), before + 1);
});

test('Lighter 查单：查到最终状态照实报；读成功但查不到报 absent（不论过了多久）', async () => {
  const h = lighterHarness();
  const target = order(M7, 1101), sentAt = T0;
  h.lookups.push(orders(lighterOrder(1101, 'filled', '0.5', '50.25')));
  assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'done', filledQty: 0.5, avgPrice: 100.5, note: '已成交' });
  h.lookups.push(orders(), orders(lighterOrder(1101, 'canceled-too-much-slippage', '0.1', '10')));
  assert.deepEqual(await h.trader.resolve(target, sentAt, signalFor), { kind: 'done', filledQty: 0.1, avgPrice: 100, note: '交易所撤销：canceled-too-much-slippage' });
  assert.deepEqual([h.count('sendTx'), h.count('nextNonce'), h.signed.length], [0, 0, 0], '查单不发任何交易');

  // 查不到：交易 10 分钟内都可能被打包；连接器只报 absent，过了有效期也不自己判零成交。
  h.clock = sentAt + 1_000;
  const before = h.count('accountOrders');
  absentOnly(await h.trader.resolve(target, sentAt, signalFor), '早于时限查不到');
  assert.equal(h.count('accountOrders') - before, 2, '每次查两遍');
  h.clock = sentAt + ORDER_EXPIRY_MS.lighter + 1;
  absentOnly(await h.trader.resolve(target, sentAt, signalFor), '过了有效期查不到');
  // 两遍里有一遍没读成、最后一遍读成了但查不到：按最后一次报 absent；反过来最后一遍没读成则是 unknown。
  h.lookups.push(() => text('err', 500), orders());
  absentOnly(await h.trader.resolve(target, sentAt, signalFor), '先失败后查不到');
  h.lookups.push(orders(), () => text('err', 500));
  unknownOnly(await h.trader.resolve(target, sentAt, signalFor), '先查不到后失败');

  // 查单把 nonce 缓存作废：这笔交易可能占了 nonce，也可能没占，下一笔重新读。
  const fresh = lighterHarness();
  fresh.lookups.push(orders(lighterOrder(1, 'filled', '0.5', '50')));
  await fresh.trader.place(order(M7, 1), signalFor);
  await fresh.trader.resolve(order(M7, 2), T0, signalFor);
  fresh.lookups.push(orders(lighterOrder(3, 'filled', '0.5', '50')));
  await fresh.trader.place(order(M7, 3), signalFor);
  assert.equal(fresh.count('nextNonce'), 2);
});

test('Lighter 查单：鉴权失败后换新令牌；令牌 50 分钟后续期', async () => {
  const h = lighterHarness();
  h.lookups.push(() => json({ code: 20013, message: 'invalid auth' }, 401), orders(lighterOrder(1201, 'filled', '0.5', '50')));
  assert.equal((await h.trader.resolve(order(M7, 1201), T0, signalFor)).kind, 'done');
  assert.deepEqual(h.calls.map(call => call.auth), ['auth-token-1', 'auth-token-2']);
  h.clock = T0 + 49 * 60_000;
  await h.trader.resolve(order(M7, 1202), T0, signalFor);
  assert.equal(h.tokens.length, 2, '时限内复用');
  h.clock = T0 + 51 * 60_000;
  await h.trader.resolve(order(M7, 1203), T0, signalFor);
  assert.deepEqual([h.tokens.length, h.tokens[2]], [3, Math.floor(h.clock / 1000) + 3600]);
});

test('Lighter 查单：没查成（接口报错、鉴权失败、断网）不是「查无此单」，过了时限也只能是未知（L039、L093）', async () => {
  const target = order(M7, 1301), sentAt = T0;
  const failures: [string, Answer][] = [
    ['HTTP 500', () => text('Internal Server Error', 500)],
    ['HTTP 401', () => json({ code: 20013, message: 'invalid auth' }, 401)],
    ['HTTP 429', () => json({ code: 23000, message: 'too many requests' }, 429)],
    ['断网', () => Promise.reject(new Error('ECONNRESET'))],
    ['超时', () => Promise.reject(new DOMException('aborted', 'AbortError'))],
    ['不是 JSON', () => text('<html>', 200)],
    ['code 不是 200', () => json({ code: 29500, message: 'internal' })],
    ['没有 orders 字段', () => json({ code: 200 })],
    ['成交数量缺失', orders({ client_order_index: 1301, status: 'filled' })],
  ];
  for (const [label, answer] of failures) {
    const h = lighterHarness();
    h.fallback = answer;
    h.clock = sentAt + ORDER_EXPIRY_MS.lighter + 3_600_000;
    unknownOnly(await h.trader.resolve(target, sentAt, signalFor), label);
  }
  // 签名器坏了、鉴权令牌签不出来：一次也没查成。
  const broken = lighterHarness();
  broken.signerLoad = new Error('签名器文件不存在');
  broken.clock = sentAt + ORDER_EXPIRY_MS.lighter + 3_600_000;
  unknownOnly(await broken.trader.resolve(target, sentAt, signalFor), '签名器不可用');
  assert.equal(broken.calls.length, 0);
});

test('Lighter 查单：交易所有这笔单但还没有最终状态时只报 absent，不能当成有了结果', async () => {
  for (const state of ['open', 'pending', 'in-progress']) {
    const h = lighterHarness();
    h.fallback = orders(lighterOrder(1401, state, '0.3', '30'));
    h.clock = T0 + ORDER_EXPIRY_MS.lighter + 60_000;
    absentOnly(await h.trader.resolve(order(M7, 1401), T0, signalFor), `状态 ${state}`);
  }
});

test('Lighter 下单串行：两笔并发时第二笔等第一笔查到结果后才取 nonce 与发送，前一笔失败不卡住后一笔', async () => {
  const h = lighterHarness();
  h.fallback = () => json({ code: 200, orders: [] });
  // 第一笔查三次才有结果，第二笔一次就有。
  h.lookups.push(orders(), orders(), orders(lighterOrder(1501, 'filled', '0.5', '50')), orders(lighterOrder(1502, 'filled', '0.25', '25')));
  const [first, second] = await Promise.all([h.trader.place(order(M7, 1501), signalFor), h.trader.place(order(M7, 1502, { qty: 0.25 }), signalFor)]);
  assert.deepEqual([first.kind === 'done' && first.filledQty, second.kind === 'done' && second.filledQty], [0.5, 0.25]);
  assert.deepEqual(h.calls.map(call => `${call.kind}${call.tag ? `:${call.tag}` : ''}`),
    ['nextNonce', 'sendTx:1501', 'accountOrders:1501', 'accountOrders:1501', 'accountOrders:1501', 'sendTx:1502', 'accountOrders:1502']);
  assert.deepEqual(h.signed.map(item => [item.clientOrderIndex, item.nonce]), [[1501, 40], [1502, 41]], 'nonce 不重复、不跳号');

  // 三笔并发，第一笔发送时断网：后两笔照常，且重新读 nonce。
  const g = lighterHarness();
  let sends = 0;
  g.sendAnswer = () => ++sends === 1 ? Promise.reject(new Error('ECONNRESET')) : json({ code: 200 });
  g.lookups.push(orders(lighterOrder(1602, 'filled', '0.5', '50')), orders(lighterOrder(1603, 'filled', '0.5', '50')));
  const results = await Promise.all([1601, 1602, 1603].map(id => g.trader.place(order(M7, id), signalFor)));
  assert.deepEqual(results.map(item => item.kind), ['unknown', 'done', 'done']);
  assert.deepEqual(g.calls.map(call => `${call.kind}${call.tag ? `:${call.tag}` : ''}`),
    ['nextNonce', 'sendTx:1601', 'nextNonce', 'sendTx:1602', 'accountOrders:1602', 'sendTx:1603', 'accountOrders:1603']);
  assert.deepEqual(g.signed.map(item => item.clientOrderIndex), [1601, 1602, 1603], '每笔只签一次、只发一次');
});
