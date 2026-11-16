// OKX connector (docs/oil.md section 10) against the stand-in venue: rules, book, account, orders, refusals, the start
// check, PnL reads, and jobs driven end to end through the executor. No network is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VenueError } from '../src/connector.ts';
import { createExecutor } from '../src/executor.ts';
import { PreflightError } from '../src/live/permissions.ts';
import { createOkxConnector, fromClOrdId, toClOrdId } from '../src/live/okx.ts';
import { createLiveConnectors, preflightLive } from '../src/live/setup.ts';
import { openStore } from '../src/store.ts';
import { createOilMarket } from '../src/oil/market.ts';
import { createOilPnl } from '../src/oil/pnl.ts';
import { prepareOil } from '../src/service/oil.ts';
import { CREDENTIALS, FakeOkx, INST, KEY, PASSPHRASE, SECRET, binding, fail, failWrite, json, order, type Row } from './live-fake-okx.ts';

const signal = () => new AbortController().signal;
const send = (beforeSend: () => void = () => undefined) => ({ signal: signal(), beforeSend });
const kind = (expected: string, pattern?: RegExp) => (error: unknown) => error instanceof VenueError && error.kind === expected && (!pattern || pattern.test(error.message));
const preflightError = (pattern: RegExp) => (error: unknown) => error instanceof PreflightError && pattern.test(error.message);
function setup(configure: (venue: FakeOkx) => void = () => undefined) {
  const venue = new FakeOkx();
  configure(venue);
  return { venue, connector: createOkxConnector({ credentials: () => CREDENTIALS, fetchImpl: venue.fetch, now: () => venue.clock, billSpacingMs: 0 }) };
}
const NATIVE = 'pa10123456789abcdef012345670';

test('OKX 连接器：客户订单号去掉连字符作 clOrdId 并能还原；不符合执行器格式的不发送', async () => {
  assert.equal(toClOrdId('pa1-0123456789abcdef01234567-0'), NATIVE);
  assert.equal(toClOrdId('pa1-0123456789abcdef01234567-1r999'), 'pa10123456789abcdef012345671r999');
  assert.equal(toClOrdId('pa1-0123456789abcdef01234567-1r999')!.length, 32);
  assert.equal(fromClOrdId('pa10123456789abcdef012345671r12'), 'pa1-0123456789abcdef01234567-1r12');
  for (const bad of ['pa1-0123456789abcdef01234567-2', 'pa1-0123456789ABCDEF01234567-0', 'pa1-0123456789abcdef01234567-0r1000', 'other']) assert.equal(toClOrdId(bad), null, bad);
  assert.equal(fromClOrdId('ox1234'), null);
  const { venue, connector } = setup();
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r1000' }), send()), kind('not-sent', /客户订单号格式无效/));
  assert.equal(venue.calls.length, 0);
});

test('OKX 连接器：合约规则按张解析（面值 × 乘数），市价上限取 maxMktSz、最小名义为 0；非 live 或非 USDT 线性读取失败；盘口取买一卖一', async () => {
  const { venue, connector } = setup();
  const rule = await connector.instrument('CLUSDT', { signal: signal() });
  assert.deepEqual({ ...rule, catalogVersion: rule.catalogVersion.slice(0, 3) }, {
    venue: 'okx', symbol: 'CLUSDT', kind: 'linear-perpetual', settleAsset: 'USDT', contractSize: '0.1', tickSize: '0.01', quantityStep: '1', minQuantity: '1', maxQuantity: '100000', maxMarketQuantity: '5000', minNotional: '0', catalogVersion: 'ok-',
  });
  assert.equal(venue.last('GET /api/v5/public/instruments').params.get('instId'), 'CL-USDT-SWAP');
  await connector.instrument('CLUSDT', { signal: signal() });
  assert.equal(venue.count('GET /api/v5/public/instruments'), 1, '60 秒内复用');
  for (const [symbol, change] of [['BZUSDT', { state: 'post_only' }], ['SKHYUSDT', { settleCcy: 'USDC' }], ['SKHYNIXUSDT', { ctType: 'inverse' }]] as const) {
    venue.instruments = venue.instruments.map(row => row.instId === INST[symbol] ? { ...row, ...change } : row);
    await assert.rejects(connector.instrument(symbol, { signal: signal() }), kind('read-failed', /不可交易/), symbol);
  }
  await assert.rejects(connector.instrument('ANTHROPICUSDT', { signal: signal() }), kind('read-failed'));
  const quote = await connector.quote('BZUSDT', { signal: signal() });
  assert.deepEqual([quote.venue, quote.bid, quote.ask, quote.sourceTime, quote.receivedAt], ['okx', '70.1', '70.12', venue.clock - 250, venue.clock]);
  assert.equal(venue.last('GET /api/v5/market/books').params.get('instId'), 'BZ-USDT-SWAP');
});

test('OKX 启动检查：权限恰为读取与交易、绑定 IP、acctLv 2 或 3、单向或双向持仓、UID 与配置一致才通过', async () => {
  const cases: [Row, RegExp][] = [
    [{ perm: 'read_only,trade,withdraw' }, /请关闭：提现/],
    [{ perm: 'read_only' }, /请开启：交易/],
    [{ perm: 'trade' }, /请开启：读取/],
    [{ ip: '' }, /未绑定 IP/],
    [{ acctLv: '4' }, /acctLv 2 或 3）.*当前为 4/],
    [{ acctLv: '1' }, /acctLv 2 或 3/],
    [{ uid: '777' }, /属于用户 777，与配置的账户 5551234567 不一致/],
  ];
  for (const [change, pattern] of cases) {
    const { connector } = setup(venue => { venue.config = { ...venue.config, ...change }; });
    await assert.rejects(connector.preflight!(binding(), { signal: signal() }), preflightError(pattern), JSON.stringify(change));
  }
  const { venue, connector } = setup();
  await connector.preflight!(binding(), { signal: signal() });
  venue.posMode = 'long_short_mode';
  await connector.preflight!(binding(), { signal: signal() });
  await assert.rejects(connector.preflight!(binding({ accountMode: 'unified' }), { signal: signal() }), kind('read-failed', /全仓或逐仓/));
  // Keys without a passphrase never leave the process.
  const bare = createOkxConnector({ credentials: () => ({ apiKey: 'k', apiSecret: 's' }), fetchImpl: venue.fetch, now: () => venue.clock });
  const before = venue.calls.length;
  await assert.rejects(bare.preflight!(binding(), { signal: signal() }), kind('read-failed', /Passphrase/));
  assert.equal(venue.calls.length, before);
});

test('OKX 连接器：账户快照先读活动委托与策略委托、后读持仓；本服务的委托还原客户订单号，策略委托算外部委托；另一保证金模式的持仓读取失败', async () => {
  const { venue, connector } = setup();
  venue.orders.set(NATIVE, { instType: 'SWAP', instId: 'CL-USDT-SWAP', ordId: '11', clOrdId: NATIVE, state: 'live' });
  venue.orders.set('manual', { instType: 'SWAP', instId: 'CL-USDT-SWAP', ordId: '12', clOrdId: '', state: 'partially_filled' });
  venue.orders.set('done', { instType: 'SWAP', instId: 'BZ-USDT-SWAP', ordId: '13', clOrdId: 'x', state: 'filled' });
  venue.algos = [{ instId: 'BZ-USDT-SWAP', ordType: 'trigger', algoId: '99' }];
  venue.positions = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', mgnMode: 'cross', posSide: 'net', pos: '-30', ccy: 'USDT' }, { instType: 'SWAP', instId: 'BZ-USDT-SWAP', mgnMode: 'cross', posSide: 'net', pos: '0' }];
  const snapshot = await connector.account(binding(), ['CLUSDT', 'BZUSDT'], { signal: signal() });
  assert.deepEqual(snapshot, {
    venue: 'okx', accountId: '5551234567', positionModes: { CLUSDT: 'one-way', BZUSDT: 'one-way' }, receivedAt: venue.clock,
    positions: [{ symbol: 'CLUSDT', side: 'short', quantity: '30' }],
    openOrders: [{ symbol: 'CLUSDT', clientOrderId: 'pa1-0123456789abcdef01234567-0', remoteId: '11' }, { symbol: 'CLUSDT', clientOrderId: null, remoteId: '12' }, { symbol: 'BZUSDT', clientOrderId: null, remoteId: 'algo-99' }],
  });
  const paths = venue.calls.map(call => call.path).filter(path => path !== '/api/v5/account/config');
  assert.ok(paths.indexOf('/api/v5/trade/orders-pending') < paths.indexOf('/api/v5/account/positions'));
  assert.ok(paths.lastIndexOf('/api/v5/trade/orders-algo-pending') < paths.lastIndexOf('/api/v5/account/positions'));
  venue.positions = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', mgnMode: 'isolated', posSide: 'net', pos: '5' }];
  await assert.rejects(connector.account(binding(), ['CLUSDT'], { signal: signal() }), kind('read-failed', /逐仓持仓，与配置的账户模式 cross 不一致/));
  venue.positions = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', mgnMode: 'cross', posSide: 'long', pos: '5' }];
  await assert.rejects(connector.account(binding(), ['CLUSDT'], { signal: signal() }), kind('read-failed', /持仓方向与账户持仓模式不一致/));
});

test('OKX 连接器：单向持仓发 posSide net 与 reduceOnly，市价 market、限价 IOC ioc；部分成交按已撤销报告成交量；双向持仓按仓位方向发、不带 reduceOnly', async () => {
  const { venue, connector } = setup();
  let guarded = 0;
  const filled = await connector.place(binding(), order({ type: 'market', limitPrice: null, timeInForce: 'ioc', side: 'sell', positionSide: 'long', reduceOnly: true }), send(() => { guarded++; }));
  assert.equal(guarded, 1);
  assert.deepEqual(venue.last('POST /api/v5/trade/order').body, { instId: 'CL-USDT-SWAP', tdMode: 'cross', clOrdId: NATIVE, side: 'sell', posSide: 'net', ordType: 'market', sz: '20', reduceOnly: true });
  assert.deepEqual([filled.clientOrderId, filled.status, filled.terminal, filled.filledQuantity, filled.averagePrice], ['pa1-0123456789abcdef01234567-0', 'filled', true, '20', '70.11']);

  venue.fill = 'partial';
  const partial = await connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-1' }), send());
  assert.deepEqual(venue.last('POST /api/v5/trade/order').body, { instId: 'CL-USDT-SWAP', tdMode: 'cross', clOrdId: 'pa10123456789abcdef012345671', side: 'buy', posSide: 'net', ordType: 'ioc', sz: '20', px: '70.5', reduceOnly: false });
  assert.deepEqual([partial.status, partial.terminal, partial.filledQuantity, partial.quantity], ['canceled', true, '1', '20']);

  venue.fill = 'rest';
  const resting = await connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r1', timeInForce: 'gtc' }), send());
  assert.equal(venue.last('POST /api/v5/trade/order').body!.ordType, 'limit');
  assert.deepEqual([resting.status, resting.terminal], ['new', false]);
  const canceled = await connector.cancel(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r1', timeInForce: 'gtc' }), send());
  assert.deepEqual(venue.last('POST /api/v5/trade/cancel-order').body, { instId: 'CL-USDT-SWAP', clOrdId: 'pa10123456789abcdef012345670r1' });
  assert.deepEqual([canceled.status, canceled.terminal], ['canceled', true]);

  venue.posMode = 'long_short_mode';
  venue.fill = 'full';
  const hedge = setup(fake => { fake.posMode = 'long_short_mode'; });
  await hedge.connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r2', side: 'sell', positionSide: 'short' }), send());
  assert.deepEqual(hedge.venue.last('POST /api/v5/trade/order').body, { instId: 'CL-USDT-SWAP', tdMode: 'cross', clOrdId: 'pa10123456789abcdef012345670r2', side: 'sell', posSide: 'short', ordType: 'ioc', sz: '20', px: '70.5' });
  await assert.rejects(hedge.connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r3', side: 'sell', positionSide: 'long', reduceOnly: false }), send()), kind('not-sent', /只减仓标记与仓位方向不一致/));
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r4', side: 'buy', positionSide: 'short' }), send()), kind('not-sent'));
  // Isolated accounts send tdMode isolated.
  await hedge.connector.place(binding({ accountMode: 'isolated' }), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r5' }), send());
  assert.equal(hedge.venue.last('POST /api/v5/trade/order').body!.tdMode, 'isolated');
});

test('OKX 连接器：只挂单发 post_only；会立即成交被交易所撤销记为过期；用户撤单仍是已撤销；市价单不能只挂单', async () => {
  const { venue, connector } = setup(fake => { fake.fill = 'rest'; });
  const request = order({ timeInForce: 'gtx', limitPrice: '70.10' });
  const resting = await connector.place(binding(), request, send());
  assert.equal(venue.last('POST /api/v5/trade/order').body!.ordType, 'post_only');
  assert.equal(resting.status, 'new');
  assert.equal((await connector.cancel(binding(), request, send())).status, 'canceled');
  venue.crossPostOnly = true;
  const crossed = await connector.place(binding(), { ...request, clientOrderId: 'pa1-0123456789abcdef01234567-0r1' }, send());
  assert.deepEqual([crossed.status, crossed.terminal, crossed.filledQuantity], ['expired', true, '0']);
  // Only cancelSource 31 (would take liquidity) means it never rested; a venue cancel for any other reason stays canceled.
  const other = venue.orders.get('pa10123456789abcdef012345670r1')!;
  for (const source of ['', '6', '14']) {
    other.cancelSource = source;
    assert.equal((await connector.query(binding(), { ...request, clientOrderId: 'pa1-0123456789abcdef01234567-0r1' }, { signal: signal() }))!.status, 'canceled', source);
  }
  await assert.rejects(connector.place(binding(), order({ type: 'market', limitPrice: null, timeInForce: 'gtx' }), send()), kind('not-sent'));
});

test('OKX 连接器：50011 限频与清单内拒绝码按已拒绝且不重发；5xx、未知码、坏回执、断线与超时按结果未知；守卫拒绝按未发送', async () => {
  for (const [reply, expected] of [
    [() => failWrite('50011', 'Too Many Requests', 429), 'rejected'], [() => fail('50011', 'Too Many Requests', 429), 'rejected'], [() => failWrite('51008', 'Insufficient balance'), 'rejected'],
    [() => failWrite('51016', 'Duplicated clOrdId'), 'uncertain'], [() => fail('50001', 'Service temporarily unavailable', 503), 'uncertain'], [() => failWrite('51008', 'x', 502), 'uncertain'],
    [() => json({ code: '0', msg: '', data: [] }), 'uncertain'], [() => json({ code: '0', msg: '', data: [{ clOrdId: NATIVE, ordId: '1', sCode: '1' }] }), 'uncertain'],
    [() => { throw new TypeError('socket hang up'); }, 'uncertain'],
  ] as [() => Response, string][]) {
    const { venue, connector } = setup();
    venue.script('POST /api/v5/trade/order', reply);
    await assert.rejects(connector.place(binding(), order(), send()), kind(expected), `${expected}`);
    assert.equal(venue.count('POST /api/v5/trade/order'), 1, '不重发');
    assert.equal(venue.count('GET /api/v5/trade/order'), 0);
  }
  const { venue, connector } = setup();
  await assert.rejects(connector.place(binding(), order(), send(() => { throw new Error('登记已变化'); })), kind('not-sent'));
  assert.equal(venue.count('POST /api/v5/trade/order'), 0);
  const slow = createOkxConnector({ credentials: () => CREDENTIALS, fetchImpl: (url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))), now: () => venue.clock, timeoutMs: 100 });
  await assert.rejects(slow.place(binding(), order(), send()), kind('not-sent'), '持仓模式读不到时不发送');
});

test('OKX 连接器：写请求前时钟偏移过期就先同步，带 expTime（OKX 时钟 + 35 秒），同步失败不发送', async () => {
  // The local clock runs 29 s fast: the start offset 0 would let a signed request live about 59 s.
  const { venue, connector } = setup(fake => { fake.serverSkew = -29_000; });
  await connector.account(binding(), ['CLUSDT'], { signal: signal() });
  assert.equal(venue.count('GET /api/v5/public/time'), 0, '读取不同步时钟');
  await connector.place(binding(), order(), send());
  assert.equal(venue.count('GET /api/v5/public/time'), 1);
  assert.equal(Number(venue.last('POST /api/v5/trade/order').expTime), venue.clock - 29_000 + 35_000);
  assert.ok(connector.capabilities.requestValidityMs >= 35_000 + 2_500);
  venue.fill = 'rest';
  const resting = order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r1', timeInForce: 'gtc' });
  venue.clock += 60_000;
  await connector.place(binding(), resting, send());
  await connector.cancel(binding(), resting, send());
  assert.equal(venue.count('GET /api/v5/public/time'), 1, '10 分钟内沿用偏移');
  assert.equal(Number(venue.last('POST /api/v5/trade/cancel-order').expTime), venue.clock - 29_000 + 35_000, '撤单也带 expTime');
  venue.clock += 600_001;
  venue.script('GET /api/v5/public/time', () => fail('50001', 'busy', 503));
  await assert.rejects(connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r2' }), send()), kind('not-sent', /时钟同步失败/));
  assert.equal(venue.count('POST /api/v5/trade/order'), 2, '同步失败不发送');
  await connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r2' }), send());
  assert.equal(venue.count('GET /api/v5/public/time'), 3);
});

test('OKX 连接器：时间戳过期（50102）同步时钟后同一 clOrdId 重发一次；回执后查单失败按已受理未成交报告', async () => {
  const { venue, connector } = setup();
  await connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-1' }), send());
  venue.serverSkew = 45_000;
  let guarded = 0;
  const report = await connector.place(binding(), order(), send(() => { guarded++; }));
  assert.equal(guarded, 2, '重发前再过一次守卫');
  assert.equal(venue.count('POST /api/v5/trade/order'), 3);
  assert.equal(venue.count('GET /api/v5/public/time'), 2);
  assert.equal(report.status, 'filled');

  const second = setup();
  second.venue.script('GET /api/v5/trade/order', () => fail('50001', 'busy', 503));
  const accepted = await second.connector.place(binding(), order(), send());
  assert.deepEqual([accepted.status, accepted.filledQuantity, accepted.terminal], ['new', '0', false]);
  // Query: 51603 is "no such order"; cancel without a readable order stays open.
  assert.equal(await second.connector.query(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-1' }), { signal: signal() }), null);
  // Only 51603 is "no such order": a success without a row proves nothing (L093).
  second.venue.script('GET /api/v5/trade/order', () => json({ code: '0', msg: '', data: [] }));
  await assert.rejects(second.connector.query(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-1' }), { signal: signal() }), kind('read-failed', /没有委托记录/));
  second.venue.fill = 'rest';
  const resting = order({ clientOrderId: 'pa1-0123456789abcdef01234567-0r1', timeInForce: 'gtc' });
  await second.connector.place(binding(), resting, send());
  second.venue.script('GET /api/v5/trade/order', () => fail('50001', 'busy', 503));
  await assert.rejects(second.connector.cancel(binding(), resting, send()), kind('uncertain', /撤单已受理/));
  assert.equal((await second.connector.query(binding(), resting, { signal: signal() }))!.status, 'canceled');
  // A report that does not match the request is a read failure.
  second.venue.orders.get('pa10123456789abcdef012345670r1')!.sz = '21';
  await assert.rejects(second.connector.query(binding(), resting, { signal: signal() }), kind('read-failed', /数量/));
});

test('OKX 盈亏读取：持仓带开仓均价、标记价与浮盈亏；账单资金费、平仓与手续费分类，按 billId 翻页，未知类型或资金费方向不符整窗失败', async () => {
  const { venue, connector } = setup();
  venue.positions = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', mgnMode: 'cross', posSide: 'net', pos: '-30', avgPx: '70.5', markPx: '70.2', upl: '0.9', ccy: '' }];
  const pnl = await connector.pnlPositions!(binding(), ['CLUSDT', 'BZUSDT'], { signal: signal() });
  assert.deepEqual(pnl, { venue: 'okx', accountId: '5551234567', receivedAt: venue.clock, positions: [{ symbol: 'CLUSDT', side: 'short', quantity: '30', entryPrice: '70.5', markPrice: '70.2', unrealizedPnl: '0.9' }] });

  const bill = (billId: number, overrides: Row): Row => ({ billId: String(billId), instType: 'SWAP', instId: 'CL-USDT-SWAP', ccy: 'USDT', ts: String(venue.clock - 1_000_000 + billId), type: '2', subType: '1', pnl: '0', fee: '0', ...overrides });
  venue.bills = [
    bill(1, { type: '8', subType: '173', pnl: '-0.12' }), bill(2, { type: '8', subType: '174', pnl: '0.05' }), bill(3, { type: '2', pnl: '1.5', fee: '-0.03' }),
    bill(4, { type: '6', pnl: '0' }), bill(5, { type: '9', pnl: '-0.4', fee: '0' }),
    ...Array.from({ length: 120 }, (_, index) => bill(10 + index, { type: '2', subType: '2', pnl: '0', fee: '-0.01' })),
    bill(500, { instId: 'BZ-USDT-SWAP', type: '2', fee: '-9' }),
  ];
  const window = { from: venue.clock - 2_000_000, to: venue.clock };
  const entries = await connector.ledger!(binding(), 'CLUSDT', window, { signal: signal() });
  assert.equal(venue.count('GET /api/v5/account/bills-archive'), 2, '满页后按最后一条 billId 翻页');
  assert.equal(venue.last('GET /api/v5/account/bills-archive').params.get('after'), '30');
  assert.deepEqual(entries.slice(0, 5).map(entry => [entry.id, entry.kind, entry.amount]), [['1:funding', 'funding', '-0.12'], ['2:funding', 'funding', '0.05'], ['3:fee', 'fee', '-0.03'], ['3:realized', 'realized', '1.5'], ['5:realized', 'realized', '-0.4']]);
  assert.equal(entries.length, 125);
  for (const bad of [{ type: '1' }, { type: '8', subType: '173', pnl: '0.1' }, { type: '8', subType: '999', pnl: '0' }, { ccy: 'USDC' }]) {
    venue.bills = [bill(1, bad)];
    await assert.rejects(connector.ledger!(binding(), 'CLUSDT', window, { signal: signal() }), kind('read-failed'), JSON.stringify(bad));
  }
  venue.script('GET /api/v5/account/bills-archive', () => json({ code: '0', msg: '', data: [bill(2, {}), bill(3, {})] }));
  await assert.rejects(connector.ledger!(binding(), 'CLUSDT', window, { signal: signal() }), kind('read-failed', /严格递减/));
});

/** One OKX account and the executor; `run` drives a job to its end. */
test('OKX 连接器：再次 50102、重发前守卫拒绝、同步时钟失败都按已拒绝，不再发送', async () => {
  const cases: [string, (venue: FakeOkx) => void, () => void, number][] = [
    ['再次 50102', venue => venue.script('POST /api/v5/trade/order', () => fail('50102', 'Timestamp request expired', 401), () => fail('50102', 'Timestamp request expired', 401)), () => undefined, 2],
    ['守卫拒绝', venue => venue.script('POST /api/v5/trade/order', () => fail('50102', 'Timestamp request expired', 401)), (() => { let n = 0; return () => { if (n++ > 0) throw new Error('登记已变化'); }; })(), 1],
    ['同步失败', venue => { venue.script('POST /api/v5/trade/order', () => fail('50102', 'Timestamp request expired', 401)); venue.script('GET /api/v5/public/time', () => fail('50001', 'busy', 503)); }, () => undefined, 1],
  ];
  for (const [name, configure, guard, posts] of cases) {
    const { venue, connector } = setup();
    await connector.place(binding(), order({ clientOrderId: 'pa1-0123456789abcdef01234567-1' }), send());
    configure(venue);
    await assert.rejects(connector.place(binding(), order(), send(guard)), kind('rejected'), name);
    assert.equal(venue.count('POST /api/v5/trade/order'), 1 + posts, name);
    assert.equal(venue.orders.has(NATIVE), false, name);
  }
});

test('OKX 连接器：撤单拒绝 51400 / 51401 结果未知、50011 已拒绝；撤单异步时回报仍挂着，下一次查单才是已撤销', async () => {
  for (const [code, expected] of [['51400', 'uncertain'], ['51401', 'uncertain'], ['50011', 'rejected']] as const) {
    const { venue, connector } = setup(fake => { fake.fill = 'rest'; });
    await connector.place(binding(), order({ timeInForce: 'gtc' }), send());
    venue.script('POST /api/v5/trade/cancel-order', () => failWrite(code, 'refused'));
    await assert.rejects(connector.cancel(binding(), order({ timeInForce: 'gtc' }), send()), kind(expected), code);
    assert.equal(venue.count('GET /api/v5/trade/order'), 1, `${code} 不查单`);
  }
  const { venue, connector } = setup(fake => { fake.fill = 'rest'; fake.asyncCancel = true; });
  const resting = order({ timeInForce: 'gtc' });
  await connector.place(binding(), resting, send());
  const accepted = await connector.cancel(binding(), resting, send());
  assert.deepEqual([accepted.status, accepted.terminal], ['new', false]);
  const ended = await connector.query(binding(), resting, { signal: signal() });
  assert.deepEqual([ended!.status, ended!.terminal], ['canceled', true]);
});

async function withExecutor(work: (ctx: { venue: FakeOkx; ex: ReturnType<typeof createExecutor>; run: (intent: unknown, between?: (i: number) => void) => Promise<ReturnType<ReturnType<typeof createExecutor>['jobView']>>; clock: { now: number } }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'pa-okx-'));
  const venue = new FakeOkx(), clock = { now: venue.clock };
  const account = binding(), config = { accounts: [account] };
  const connectors = createLiveConnectors(config, new Map([['okx', CREDENTIALS]]) as never, { fetchImpl: venue.fetch, now: () => clock.now }).filter(item => item.venue === 'okx');
  const store = openStore(join(dir, 'executor.sqlite'));
  try {
    await preflightLive(config, connectors);
    const ex = createExecutor({ store, connectors, environment: 'mainnet', now: () => clock.now });
    assert.ok(ex.acquire());
    ex.registerAccount(account);
    const run = async (intent: unknown, between?: (i: number) => void) => {
      const preview = await ex.preview(intent, 'live-session');
      const { job } = ex.confirm({ previewId: preview.id, requestId: randomUUID(), confirmLive: true }, 'live-session');
      for (let i = 0; i < 200; i++) {
        await ex.tick();
        const view = ex.jobView(job.id);
        if (['completed', 'failed', 'stopped', 'attention'].includes(view.status)) return view;
        between?.(i);
        clock.now += 1_000; venue.clock = clock.now; ex.acquire();
      }
      return ex.jobView(job.id);
    };
    await work({ venue, ex, run, clock });
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
}
const sameOkx = (barrels = '2') => ({ market: 'oil', preset: 'same-exchange', action: 'open', timeoutMs: 600_000, legs: [
  { venue: 'okx', symbol: 'BZUSDT', side: 'short', orderType: 'market', barrels }, { venue: 'okx', symbol: 'CLUSDT', side: 'long', orderType: 'market', barrels }] });

test('端到端（OKX 同所）：执行器按桶数换算成张下单，两腿成交后完成；首腿下单结果未知时在观察窗内按 clOrdId 查到并继续', async () => {
  await withExecutor(async ({ venue, run }) => {
    const opened = await run(sameOkx());
    assert.equal(opened.status, 'completed', JSON.stringify(opened.events.slice(-5)));
    assert.deepEqual(opened.legs.map(leg => [leg.venue, leg.symbol, leg.filledQuantity]), [['okx', 'BZUSDT', '20'], ['okx', 'CLUSDT', '20']]);
    assert.deepEqual([venue.net.get('BZ-USDT-SWAP'), venue.net.get('CLUSDT') ?? venue.net.get('CL-USDT-SWAP')], [-20, 20]);
    const bodies = venue.calls.filter(call => call.path === '/api/v5/trade/order' && call.method === 'POST').map(call => [call.body!.instId, call.body!.ordType, call.body!.sz]);
    assert.deepEqual(bodies, [['BZ-USDT-SWAP', 'ioc', '20'], ['CL-USDT-SWAP', 'market', '20']]);

    // The lead's create reaches the venue but its answer is lost: the executor finds it by clOrdId and hedges.
    venue.script('POST /api/v5/trade/order', call => { venue.create(call.body!); throw new TypeError('socket hang up'); });
    const lost = await run({ ...sameOkx('1'), action: 'close', legs: [{ venue: 'okx', symbol: 'BZUSDT', side: 'short', orderType: 'market', barrels: '1' }, { venue: 'okx', symbol: 'CLUSDT', side: 'long', orderType: 'market', barrels: '1' }] });
    assert.equal(lost.status, 'completed', JSON.stringify(lost.events.slice(-6)));
    assert.deepEqual([venue.net.get('BZ-USDT-SWAP'), venue.net.get('CL-USDT-SWAP')], [-10, 10]);
    assert.ok(venue.count('GET /api/v5/trade/order') >= 3);
  });
});

test('端到端（OKX 本地追价）：撤单受理后查到仍挂着时不发新单，读到已撤销后才按新价重挂，成交后对冲完成', async () => {
  await withExecutor(async ({ venue, run }) => {
    venue.fill = 'rest'; venue.asyncCancel = true;
    const job = await run({ ...sameOkx(), legs: [{ venue: 'okx', symbol: 'CLUSDT', side: 'long', orderType: 'local-chase', barrels: '2' }, { venue: 'okx', symbol: 'BZUSDT', side: 'short', orderType: 'market', barrels: '2' }] }, i => {
      if (i === 3) venue.book = { bid: '70.20', ask: '70.22' };
      if (venue.count('POST /api/v5/trade/cancel-order') > 0) venue.fill = 'full';
    });
    assert.equal(job.status, 'completed', JSON.stringify(job.events.slice(-6)));
    const leads = venue.calls.filter(call => call.method === 'POST' && call.path === '/api/v5/trade/order' && call.body!.instId === 'CL-USDT-SWAP').map(call => [call.body!.ordType, call.body!.px]);
    assert.deepEqual(leads, [['post_only', '70.1'], ['post_only', '70.2']]);
    assert.ok(venue.liveAfterCancel >= 1, '撤单受理后至少一次查到仍挂着');
    assert.equal(venue.overlaps, 0, '旧挂单未结束时不发新单');
    assert.deepEqual([venue.net.get('CL-USDT-SWAP'), venue.net.get('BZ-USDT-SWAP')], [20, -20]);
  });
});

test('端到端（OKX 同所）：首腿 50011 限频按已拒绝结束、不重发也不发对冲腿', async () => {
  await withExecutor(async ({ venue, run }) => {
    venue.script('POST /api/v5/trade/order', () => failWrite('50011', 'Too Many Requests', 429));
    const job = await run(sameOkx());
    assert.equal(job.status, 'failed', JSON.stringify(job.events.slice(-5)));
    assert.equal(venue.count('POST /api/v5/trade/order'), 1);
    assert.equal(venue.net.size, 0);
  });
});

test('原油行情：跨所价差按已配置交易所两两列出（Binance–Bybit、Binance–OKX、Bybit–OKX），OKX 盘口取自其连接器', async () => {
  const { venue, connector } = setup();
  const stub = (name: 'binance' | 'bybit', bid: string, ask: string) => ({ venue: name, quote: async (symbol: string) => ({ venue: name, symbol, bid, ask, sourceTime: null, receivedAt: venue.clock, connectionGeneration: 0, sequence: null, complete: true }) });
  const market = createOilMarket({ connectors: [stub('bybit', '70.00', '70.05'), connector, stub('binance', '70.20', '70.22')] as never, accounts: [], now: () => venue.clock });
  await market.refreshQuotes();
  const rows = market.view().crossExchange.filter(row => row.symbol === 'CLUSDT').map(row => [row.first, row.second, row.firstOverSecond, row.secondOverFirst, row.receivedAt]);
  assert.deepEqual(rows, [['binance', 'bybit', '0.15', '-0.22', venue.clock], ['binance', 'okx', '0.08', '-0.12', venue.clock], ['bybit', 'okx', '-0.12', '0.05', venue.clock]]);
  const two = createOilMarket({ connectors: [connector] as never, accounts: [], now: () => venue.clock });
  assert.deepEqual(two.view().crossExchange, []);
});

test('原油盈亏（OKX 腿）：盈亏库用 OKX 连接器的持仓与账单，总盈亏 = 浮盈亏 + 资金费 + 平仓盈亏 + 手续费', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-okx-pnl-'));
  const { venue, connector } = setup();
  try {
    venue.positions = [{ instType: 'SWAP', instId: 'CL-USDT-SWAP', mgnMode: 'cross', posSide: 'net', pos: '-30', avgPx: '70.5', markPx: '70.2', upl: '0.9', ccy: 'USDT' }];
    const bill = (billId: number, ago: number, overrides: Row): Row => ({ billId: String(billId), instType: 'SWAP', instId: 'CL-USDT-SWAP', ccy: 'USDT', ts: String(venue.clock - ago), type: '2', subType: '1', pnl: '0', fee: '0', ...overrides });
    venue.bills = [bill(1, 3_600_000, { type: '8', subType: '173', pnl: '-0.12' }), bill(2, 1_800_000, { type: '2', pnl: '1.5', fee: '-0.03' })];
    const pnl = createOilPnl({ file: join(dir, 'oil-pnl.sqlite'), connectors: [connector], accounts: [binding()], now: () => venue.clock });
    venue.clock += 1000;
    await pnl.sample();
    venue.clock += 1000;
    await pnl.syncLedgers();
    const view = pnl.read({ range: '1d' }) as { latest: { unrealizedPnl: string; fundingPnl: string; realizedPnl: string; feePnl: string; totalPnl: string } | null };
    assert.deepEqual(view.latest && [view.latest.unrealizedPnl, view.latest.fundingPnl, view.latest.realizedPnl, view.latest.feePnl, view.latest.totalPnl], ['0.9', '-0.12', '1.5', '-0.03', '2.25']);
    pnl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('服务启动（OKX 账户）：按账户加进程锁、启动检查不通过时拒绝启动且报错不含密钥，通过后行情与执行都用 OKX 连接器', async () => {
  const venue = new FakeOkx();
  const config = { accounts: [binding({ accountId: String(Date.now()).slice(-10) })] };
  venue.config = { ...venue.config, uid: config.accounts[0]!.accountId, perm: 'read_only,trade,withdraw' };
  const keys = new Map([['okx', CREDENTIALS]]) as never;
  await assert.rejects(prepareOil(config as never, keys, { fetchImpl: venue.fetch, now: () => venue.clock }), (error: unknown) => error instanceof Error
    && /原油执行账户启动检查未通过，拒绝启动：.*请关闭：提现/.test(error.message) && ![KEY, SECRET, PASSPHRASE].some(secret => error.message.includes(secret)));
  venue.config = { ...venue.config, perm: 'read_only,trade' };
  const oil = await prepareOil(config as never, keys, { fetchImpl: venue.fetch, now: () => venue.clock });
  try {
    assert.deepEqual(oil.connectors.map(connector => connector.venue), ['okx']);
    await assert.rejects(prepareOil(config as never, keys, { fetchImpl: venue.fetch, now: () => venue.clock }), /已被本机另一个/);
  } finally { oil.locks.release(); }
});
