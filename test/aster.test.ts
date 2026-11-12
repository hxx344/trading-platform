// Real ASTER connectors against the signature-checking stand-in: signing (cross-checked with Python eth_account),
// request budget, answer classification as in the Python client, and every value passing the executor's own parsers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsterClient, RequestBudget, classify, parseAsterCredentials, TRANSFER_REJECTIONS } from '../src/aster/client.ts';
import { pythonUrlencode, signAsterMessage } from '../src/aster/eip712.ts';
import { AsterTransferConnector, INCOME_PAGE_ROWS } from '../src/aster/transfer.ts';
import { AsterTradingConnector, streamEvidence } from '../src/aster/trading.ts';
import { VenueError } from '../src/connector.ts';
import { parseSubAccountList, parseTransferBalance, parseTransferHistory, ContractError } from '../src/contracts.ts';
import { parseAdlAccount, parseAdlEvidence, parseAdlOrderReport, parseAdlRule, type AdlOrderRequest } from '../src/adl-contracts.ts';
import { parseAsterPositions } from '../src/positions.ts';
import { createExecutor } from '../src/executor.ts';
import { createHarness } from './harness.ts';
import { CREDENTIALS, FakeAster, LONG, MAIN, NOW, SHORT, json } from './aster-fake.ts';

const signal = () => new AbortController().signal;
const send = (beforeSend: () => void = () => undefined) => ({ signal: signal(), beforeSend });
const kind = (expected: string) => (error: unknown) => error instanceof VenueError && error.kind === expected;
const lookup = (accountId: string) => { const found = CREDENTIALS.get(accountId); if (!found) throw new Error('未配置'); return found; };

function setup({ limit = 600, reserve = 200 }: { limit?: number; reserve?: number } = {}) {
  const fake = new FakeAster();
  const clock = { now: NOW };
  let micros = BigInt(NOW) * 1000n;
  const budget = new RequestBudget({ limitPerMinute: limit, adlReserve: reserve, now: () => clock.now });
  const client = new AsterClient({ budget, fetchImpl: fake.fetch, microseconds: () => micros, timeoutMs: 1_000 });
  const transfers = new AsterTransferConnector({ client, credentials: lookup, knownAccounts: () => [...CREDENTIALS.keys()], now: () => clock.now });
  const trading = new AsterTradingConnector({ client, credentials: lookup, now: () => clock.now });
  return { fake, clock, budget, client, transfers, trading, tick: (ms: number) => { clock.now += ms; micros += BigInt(ms) * 1000n; } };
}

test('ASTER 签名：与 Python eth_account 及 urlencode 逐字节一致', () => {
  // Vector produced by modules/aster/.venv-aster (eth_account encode_typed_data + sign_message) and urllib.parse.urlencode.
  const privateKey = '0x' + '11'.repeat(32);
  const message = 'toAccountAddress=0xabababababababababababababababababababab&asset=USD1&amount=12.5&kindType=FUTURE_FUTURE&fromAccountAddress=0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd&nonce=1762900000000123&signer=0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a';
  assert.equal(signAsterMessage(message, privateKey), '0xda6c33d1930b6f49c142321a2a7e8bd9e1e058e702f77a49b5608ad67ace899c3f7f40558be125adedd175756af44491705242ca69bc4a3e7d6bcbe2022869361b');
  assert.equal(pythonUrlencode({ a: "x y+z/é~*'()!", b: '中文' }), 'a=x+y%2Bz%2F%C3%A9~%2A%27%28%29%21&b=%E4%B8%AD%E6%96%87');

  const client = new AsterClient({ budget: new RequestBudget({ limitPerMinute: 600, adlReserve: 0 }), microseconds: () => 1_762_900_000_000_123n });
  const signer = { user: '0x' + 'ef'.repeat(20), signer: '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a', privateKey };
  const params = client.sign(signer, { params: { toAccountAddress: '0x' + 'ab'.repeat(20), asset: 'USD1', amount: '12.5', kindType: 'FUTURE_FUTURE', fromAccountAddress: '0x' + 'cd'.repeat(20) }, withUser: false });
  assert.equal(params.signature, '0xda6c33d1930b6f49c142321a2a7e8bd9e1e058e702f77a49b5608ad67ace899c3f7f40558be125adedd175756af44491705242ca69bc4a3e7d6bcbe2022869361b');
  // The nonce never repeats, even when the clock does not move.
  assert.equal(client.sign(signer, { params: {}, withUser: true }).nonce, '1762900000000124');
  assert.throws(() => client.sign(signer, { params: { nonce: '1' }, withUser: true }), kind('not-sent'));
});

test('ASTER 凭据：私钥须推出 signer，signer 不能是账户本身，字段不能多也不能少', () => {
  const ok = parseAsterCredentials({ user: LONG.user.toUpperCase().replace('0X', '0x'), signer: LONG.signer, privateKey: LONG.privateKey.slice(2) }, '多侧');
  assert.deepEqual(ok, LONG);
  assert.throws(() => parseAsterCredentials({ ...LONG, signer: SHORT.signer }, '多侧'), /私钥推导出的地址与 signer 不一致/);
  assert.throws(() => parseAsterCredentials({ ...LONG, user: LONG.signer }, '多侧'), /不能是账户地址本身/);
  assert.throws(() => parseAsterCredentials({ ...LONG, extra: 1 }, '多侧'), /只能包含/);
  assert.throws(() => parseAsterCredentials({ ...LONG, privateKey: '0x12' }, '多侧'), /privateKey 格式无效/);
});

test('ASTER 请求额度：普通请求让出 ADL 保留额，额度用完或冷却中不发送；限流应答启动冷却', async () => {
  const { fake, budget, transfers, trading, tick } = setup({ limit: 100, reserve: 40 });
  // 12 balance reads × 5 = 60 = the normal ceiling (100 − 40).
  for (let i = 0; i < 12; i++) await transfers.balance(MAIN.user, LONG.user, { signal: signal() });
  await assert.rejects(transfers.balance(MAIN.user, LONG.user, { signal: signal() }), (error: unknown) => kind('read-failed')(error) && /额度已用完/.test((error as Error).message));
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '5' }, send()), kind('not-sent'));
  // ADL may still use the reserve.
  fake.risk.set(LONG.user, []);
  await trading.account(LONG.user, ['BTCUSDT'], { signal: signal() });
  assert.equal(fake.count('/fapi/v3/subAccountTransfer'), 0);
  tick(60_001);
  assert.equal(budget.state().usedLastMinute, 0);

  // HTTP 429 with Retry-After 200 s: everything waits that long, sends nothing meanwhile.
  fake.script('GET /fapi/v3/accountWithJoinMargin', () => json({ code: -1003, msg: 'Too many requests' }, 429, { 'Retry-After': '200' }));
  await assert.rejects(transfers.balance(MAIN.user, LONG.user, { signal: signal() }), kind('read-failed'));
  const before = fake.calls.length;
  await assert.rejects(trading.account(LONG.user, ['BTCUSDT'], { signal: signal() }), (error: unknown) => /冷却中/.test((error as Error).message));
  assert.equal(fake.calls.length, before);
  tick(199_000);
  await assert.rejects(transfers.balance(MAIN.user, LONG.user, { signal: signal() }), /冷却中/);
  tick(1_001);
  await transfers.balance(MAIN.user, LONG.user, { signal: signal() });
  assert.throws(() => new RequestBudget({ limitPerMinute: 50, adlReserve: 0 }), /100–2400/);
});

test('ASTER 应答分类：与 Python 客户端的拒绝码、未知码与网关状态一致', () => {
  const budget = new RequestBudget({ limitPerMinute: 600, adlReserve: 0, now: () => NOW });
  const verdict = (status: number, data: unknown) => classify({ status, data }, TRANSFER_REJECTIONS, budget, 't')?.kind ?? 'ok';
  assert.equal(verdict(200, { code: 200, msg: 'success' }), 'ok');
  assert.equal(verdict(400, { code: -2019, msg: 'Margin is insufficient.' }), 'rejected');
  assert.equal(verdict(400, { code: -1007, msg: 'Timeout' }), 'unknown');
  assert.equal(verdict(400, { code: -4999, msg: 'new code' }), 'unknown');
  assert.equal(verdict(503, { code: -2019 }), 'unknown');
  assert.equal(verdict(502, '<html>'), 'unknown');
  assert.equal(verdict(400, { code: -2013, msg: 'Order does not exist.' }), 'not-found');
  assert.equal(verdict(200, { code: -1102, msg: 'bad' }), 'rejected');
  assert.equal(budget.state().coolingUntil, null);
  assert.equal(verdict(418, { code: -1003 }), 'rejected');
  assert.equal(budget.state().coolingUntil, NOW + 86_400_000);
});

test('ASTER 划转：主账户 API 钱包签名、不带 user、表单正文；回执 200/success 才算已确认', async () => {
  const { fake, transfers } = setup();
  let guarded = 0;
  const ack = await transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '12.50' }, send(() => { guarded++; }));
  assert.deepEqual(ack, { confirmed: true, tranId: null });
  assert.equal(guarded, 1);
  const call = fake.calls.at(-1)!;
  assert.deepEqual(Object.keys(call.params), ['toAccountAddress', 'asset', 'amount', 'kindType', 'fromAccountAddress', 'nonce', 'signer', 'signature']);
  assert.deepEqual({ ...call.params, nonce: 0, signature: 0 }, { toAccountAddress: SHORT.user, asset: 'USD1', amount: '12.5', kindType: 'FUTURE_FUTURE', fromAccountAddress: LONG.user, nonce: 0, signer: MAIN.signer, signature: 0 });
  assert.deepEqual(fake.refused, []);

  fake.script('POST /fapi/v3/subAccountTransfer', () => json({ code: 0, msg: 'processing', tranId: 778899 }));
  assert.deepEqual(await transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send()), { confirmed: false, tranId: '778899' });
  fake.script('POST /fapi/v3/subAccountTransfer', () => json({ code: -2019, msg: 'Margin is insufficient.' }, 400));
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send()), kind('rejected'));
  fake.script('POST /fapi/v3/subAccountTransfer', () => json({ code: -1000, msg: 'unknown' }, 400));
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send()), kind('uncertain'));
  fake.script('POST /fapi/v3/subAccountTransfer', () => { throw new Error('reset'); });
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send()), kind('uncertain'));

  const sent = fake.count('/fapi/v3/subAccountTransfer');
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send(() => { throw new Error('租约已失'); })), kind('not-sent'));
  await assert.rejects(transfers.transfer('0x' + '99'.repeat(20), { source: LONG.user, destination: SHORT.user, asset: 'USD1', amount: '1' }, send()), kind('not-sent'));
  await assert.rejects(transfers.transfer(MAIN.user, { source: LONG.user, destination: LONG.user, asset: 'USD1', amount: '1' }, send()), kind('not-sent'));
  assert.equal(fake.count('/fapi/v3/subAccountTransfer'), sent);
});

test('ASTER 子账户与余额：主账户列表核实归属与冻结，余额用子账户自己的凭据读取', async () => {
  const { fake, transfers } = setup();
  const list = parseSubAccountList(await transfers.subAccounts(MAIN.user, { signal: signal() }), MAIN.user);
  assert.deepEqual(list.subAccounts, [{ accountId: LONG.user, frozen: false }, { accountId: SHORT.user, frozen: false }]);
  assert.equal(fake.calls.at(-1)!.params.signer, MAIN.signer);

  // A row without an address is identified through the configured account's own accountId; frozen is kept.
  fake.subAccounts[2] = { parentAccount: false, accountId: '3', subAccountStatus: 'FREEZE' };
  assert.deepEqual(parseSubAccountList(await transfers.subAccounts(MAIN.user, { signal: signal() }), MAIN.user).subAccounts, [{ accountId: LONG.user, frozen: false }, { accountId: SHORT.user, frozen: true }]);
  fake.subAccounts[0] = { parentAccount: false, accountId: 1, address: MAIN.user };
  await assert.rejects(transfers.subAccounts(MAIN.user, { signal: signal() }), /未唯一标识主账户/);
  fake.subAccounts[0] = { parentAccount: true, accountId: 1, address: '0x' + '77'.repeat(20) };
  await assert.rejects(transfers.subAccounts(MAIN.user, { signal: signal() }), /主账户地址与配置不一致/);
  fake.subAccounts[0] = { parentAccount: true, accountId: 1, address: MAIN.user, walletAddress: LONG.user };
  await assert.rejects(transfers.subAccounts(MAIN.user, { signal: signal() }), /互相冲突/);

  const long = parseTransferBalance(await transfers.balance(MAIN.user, LONG.user, { signal: signal() }), LONG.user);
  assert.deepEqual([long.available, long.equity, long.maxWithdraw], ['120.5', '150', '110']);
  assert.equal(fake.calls.at(-1)!.params.signer, LONG.signer);
  assert.equal(fake.calls.at(-1)!.params.user, LONG.user);
  const short = parseTransferBalance(await transfers.balance(MAIN.user, SHORT.user, { signal: signal() }), SHORT.user);
  assert.equal(short.equity, '84.5');
  fake.accounts.set(SHORT.user, { assets: [{ asset: 'USDT', availableBalance: '1' }] });
  await assert.rejects(transfers.balance(MAIN.user, SHORT.user, { signal: signal() }), (error: unknown) => kind('read-failed')(error) && /USD1/.test((error as Error).message));
});

test('ASTER 划转流水：只留 USD1 划转、带符号金额转方向；无法分类的行使结果不完整；满页对半拆分', async () => {
  const { fake, transfers } = setup();
  fake.income.set(LONG.user, [
    { asset: 'USD1', incomeType: 'SUBUSER_ASSET_TRANSFER', income: '-12.50000000', tranId: 9_007_199_254_740_993n, time: NOW - 5_000 },
    { asset: 'USD1', incomeType: 'TRANSFER', income: '3.00000000', tranId: '42', time: NOW - 4_000 },
    { asset: 'USD1', incomeType: 'REALIZED_PNL', income: '7', tranId: 43, time: NOW - 3_000 },
    { asset: 'USDT', incomeType: 'TRANSFER', income: '7', tranId: 44, time: NOW - 2_000 },
  ]);
  const read = await transfers.history(MAIN.user, LONG.user, { from: NOW - 10_000, to: NOW }, { signal: signal() });
  const history = parseTransferHistory(read, LONG.user);
  assert.equal(history.complete, true);
  // The 64-bit tranId keeps its exact digits.
  assert.deepEqual(history.rows.map(row => [row.tranId, row.direction, row.amount, row.type]), [['9007199254740993', 'out', '12.5', 'transfer'], ['42', 'in', '3', 'transfer']]);
  assert.deepEqual(fake.calls.at(-1)!.params.limit, String(INCOME_PAGE_ROWS));

  fake.income.get(LONG.user)!.push({ asset: 'USD1', incomeType: 'TRANSFER', income: 'NaN', tranId: 45, time: NOW - 1_000 }, { incomeType: 'TRANSFER' });
  const partial = parseTransferHistory(await transfers.history(MAIN.user, LONG.user, { from: NOW - 10_000, to: NOW }, { signal: signal() }), LONG.user);
  assert.equal(partial.complete, false);
  assert.equal(partial.rows.length, 2);

  // 1500 rows over 1500 seconds: the first page is full, both halves are read and every row is found.
  fake.income.set(SHORT.user, Array.from({ length: 1500 }, (_, i) => ({ asset: 'USD1', incomeType: 'SUBUSER_ASSET_TRANSFER', income: '1', tranId: 1000 + i, time: NOW - 1_500_000 + i * 1000 })));
  const before = fake.count('/fapi/v3/income');
  const full = parseTransferHistory(await transfers.history(MAIN.user, SHORT.user, { from: NOW - 1_500_000, to: NOW }, { signal: signal() }), SHORT.user);
  assert.equal(full.complete, true);
  assert.equal(full.rows.length, 1500);
  assert.equal(fake.count('/fapi/v3/income') - before, 3);
  // Open-ended: a full page cannot be split and is reported incomplete.
  const open = parseTransferHistory(await transfers.history(MAIN.user, SHORT.user, { from: NOW - 1_500_000, to: null }, { signal: signal() }), SHORT.user);
  assert.equal(open.complete, false);
  assert.equal(fake.calls.at(-1)!.params.endTime, undefined);

  fake.script('GET /fapi/v3/income', () => json({ code: -1000, msg: 'busy' }, 500));
  await assert.rejects(transfers.history(MAIN.user, LONG.user, { from: NOW - 10_000, to: NOW }, { signal: signal() }), kind('read-failed'));
});

const order = (overrides: Partial<AdlOrderRequest> = {}): AdlOrderRequest => ({ clientOrderId: 'adl-' + 'a'.repeat(28), symbol: 'BTCUSDT', side: 'sell', positionSide: 'LONG', quantity: '0.004', reduceOnly: true, type: 'market', ...overrides });

test('ASTER 减仓单：双向持仓按 positionSide 减仓不带 reduceOnly，单向带 reduceOnly；回报过执行器校验', async () => {
  const { fake, trading } = setup();
  const report = parseAdlOrderReport(await trading.place(LONG.user, order(), send()), order(), NOW, 1_000);
  assert.deepEqual([report.status, report.orderId, report.filledQuantity, report.averagePrice], ['filled', '9000000001', '0.004', '100.5']);
  const hedge = fake.calls.at(-1)!;
  assert.equal(hedge.method, 'POST');
  assert.deepEqual({ ...hedge.params, nonce: 0, signature: 0 }, { symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: '0.004', newClientOrderId: order().clientOrderId, newOrderRespType: 'RESULT', nonce: 0, user: LONG.user, signer: LONG.signer, signature: 0 });
  await trading.place(SHORT.user, order({ clientOrderId: 'adl-' + 'b'.repeat(28), side: 'buy', positionSide: 'BOTH' }), send());
  assert.equal(fake.calls.at(-1)!.params.reduceOnly, 'true');
  assert.equal(fake.calls.at(-1)!.params.positionSide, 'BOTH');

  assert.equal(await trading.query(LONG.user, 'BTCUSDT', 'adl-' + 'c'.repeat(28), { signal: signal() }), null);
  parseAdlOrderReport(await trading.query(LONG.user, 'BTCUSDT', order().clientOrderId, { signal: signal() }), order(), NOW, 1_000);
  const canceled = parseAdlOrderReport(await trading.cancel(LONG.user, 'BTCUSDT', order().clientOrderId, send()), order(), NOW, 1_000);
  assert.equal(canceled.status, 'canceled');
  assert.equal(fake.calls.at(-1)!.method, 'DELETE');
  // Unknown order on cancel is not in the Python rejection set: the outcome stays uncertain.
  await assert.rejects(trading.cancel(LONG.user, 'BTCUSDT', 'adl-' + 'd'.repeat(28), send()), kind('uncertain'));

  fake.script('POST /fapi/v3/order', () => json({ code: -2019, msg: 'Margin is insufficient.' }, 400));
  await assert.rejects(trading.place(LONG.user, order({ clientOrderId: 'adl-' + 'e'.repeat(28) }), send()), kind('rejected'));
  fake.script('POST /fapi/v3/order', () => json({ code: -1007, msg: 'Timeout waiting for response' }, 400));
  await assert.rejects(trading.place(LONG.user, order({ clientOrderId: 'adl-' + 'f'.repeat(28) }), send()), kind('uncertain'));
  fake.script('POST /fapi/v3/order', () => json({ orderId: 1, status: 'WEIRD' }));
  await assert.rejects(trading.place(LONG.user, order({ clientOrderId: 'adl-' + '0'.repeat(28) }), send()), kind('uncertain'));
  const sent = fake.count('/fapi/v3/order');
  await assert.rejects(trading.place(LONG.user, order(), send(() => { throw new Error('现场已变'); })), kind('not-sent'));
  assert.equal(fake.count('/fapi/v3/order'), sent);
  assert.deepEqual(fake.refused, []);
});

test('ASTER 减仓现场：两个持仓接口一致才给出快照，挂单按标的读取；交易规则取两个数量过滤器的交集', async () => {
  const { fake, trading } = setup();
  fake.risk.set(LONG.user, [
    { symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.5', entryPrice: '98000', markPrice: '100000', unRealizedProfit: '1000', updateTime: NOW - 10 },
    { symbol: 'BTCUSDT', positionSide: 'SHORT', positionAmt: '0', entryPrice: '0.0', markPrice: '100000', unRealizedProfit: '0', updateTime: 0 },
    { symbol: 'ETHUSDT', positionSide: 'LONG', positionAmt: '3', entryPrice: '3900', markPrice: '4000', unRealizedProfit: '300', updateTime: NOW - 10 },
  ]);
  fake.accounts.get(LONG.user)!.positions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.5' }, { symbol: 'ETHUSDT', positionSide: 'LONG', positionAmt: '3' }];
  fake.openOrders.set(LONG.user, [{ symbol: 'BTCUSDT', clientOrderId: 'adl_old', orderId: 5 }]);
  const scene = parseAdlAccount(await trading.account(LONG.user, ['BTCUSDT'], { signal: signal() }), LONG.user, ['BTCUSDT'], NOW, 1_000);
  assert.equal(scene.canTrade, true);
  assert.deepEqual(scene.positions.map(row => [row.positionSide, row.quantity, row.direction]), [['LONG', '0.5', 'long'], ['SHORT', '0', null]]);
  assert.deepEqual(scene.openOrders, [{ symbol: 'BTCUSDT', clientOrderId: 'adl_old' }]);
  assert.equal(fake.calls.at(-1)!.params.symbol, 'BTCUSDT');

  fake.accounts.get(LONG.user)!.positions = [{ symbol: 'BTCUSDT', positionSide: 'LONG', positionAmt: '0.4' }];
  await assert.rejects(trading.account(LONG.user, ['BTCUSDT'], { signal: signal() }), (error: unknown) => kind('read-failed')(error) && /尚未同步/.test((error as Error).message));

  const display = parseAsterPositions(await trading.positions(LONG.user, { signal: signal() }), LONG.user, NOW, 1_000);
  assert.deepEqual(display.positions.map(row => [row.symbol, row.direction, row.quantity, row.entryPrice]), [['BTCUSDT', 'long', '0.5', '98000'], ['ETHUSDT', 'long', '3', '3900']]);

  const rule = parseAdlRule(await trading.rule('BTCUSDT', { signal: signal() }), 'BTCUSDT');
  assert.deepEqual(rule, { symbol: 'BTCUSDT', quantityStep: '0.002', minQuantity: '0.002', maxMarketQuantity: '120', tradable: true, quoteAsset: 'USDT' });
  await trading.rule('BTCUSDT', { signal: signal() });
  assert.equal(fake.count('/fapi/v3/exchangeInfo'), 1);
  fake.info = [{ ...fake.info[0], symbol: 'ETHUSDT', status: 'SETTLING' }];
  const fresh = setup();
  fresh.fake.info = fake.info;
  assert.equal(parseAdlRule(await fresh.trading.rule('ETHUSDT', { signal: signal() }), 'ETHUSDT').tradable, false);
  await assert.rejects(fresh.trading.rule('XRPUSDT', { signal: signal() }), kind('read-failed'));
});

test('ASTER ADL 证据：强平历史与推送都转成执行器的证据行', async () => {
  const { fake, trading } = setup();
  fake.forceOrders.set(SHORT.user, [
    { clientOrderId: 'adl_autoclose', symbol: 'BTCUSDT', orderId: 9_007_199_254_740_995n, positionSide: 'SHORT', side: 'BUY', origQty: '0.3', executedQty: '0.3', avgPrice: '99000', status: 'FILLED', time: NOW - 2_000, updateTime: NOW - 1_000 },
    { clientOrderId: 'adl_autoclose', symbol: 'BTCUSDT', orderId: 7, positionSide: 'SHORT', side: 'BUY', origQty: '0.1', executedQty: '0', avgPrice: '0', status: 'REJECTED', time: NOW - 3_000, updateTime: NOW - 3_000 },
  ]);
  const rows = (await trading.adlHistory(SHORT.user, { from: NOW - 60_000, to: NOW }, 100, { signal: signal() })).map(row => parseAdlEvidence(row, NOW, 1_000));
  assert.deepEqual(rows.map(row => [row.orderId, row.status, row.filledQuantity, row.averagePrice]), [['7', 'canceled', '0', null], ['9007199254740995', 'filled', '0.3', '99000']]);
  assert.deepEqual({ ...fake.calls.at(-1)!.params, nonce: 0, signature: 0 }, { autoCloseType: 'ADL', startTime: String(NOW - 60_000), endTime: String(NOW), limit: '100', nonce: 0, user: SHORT.user, signer: SHORT.signer, signature: 0 });

  const seen: unknown[] = [];
  const stop = trading.subscribe((accountId, row) => seen.push([accountId, row]));
  trading.push(LONG.user, { e: 'ORDER_TRADE_UPDATE', E: NOW, T: NOW, o: { c: 'adl_autoclose', s: 'BTCUSDT', i: 11, ps: 'LONG', S: 'SELL', q: '0.2', z: '0.1', X: 'PARTIALLY_FILLED', ap: '100100', T: NOW - 5 } });
  trading.push(LONG.user, { e: 'ORDER_TRADE_UPDATE', E: NOW, o: { c: 'my-order', s: 'BTCUSDT' } });
  trading.push(LONG.user, { e: 'ACCOUNT_UPDATE', E: NOW });
  stop();
  trading.push(LONG.user, { e: 'ORDER_TRADE_UPDATE', E: NOW, T: NOW, o: { c: 'adl_autoclose', s: 'BTCUSDT', i: 12, ps: 'LONG', S: 'SELL', q: '0.2', z: '0.2', X: 'FILLED', ap: '1', T: NOW } });
  assert.equal(seen.length, 1);
  const pushed = parseAdlEvidence((seen[0] as [string, unknown])[1], NOW, 1_000);
  assert.deepEqual([pushed.orderId, pushed.status, pushed.time, pushed.updateTime], ['11', 'partially-filled', NOW - 5, NOW]);
  // A malformed ADL push is passed on so the executor counts it as a bad row instead of losing it silently.
  assert.throws(() => parseAdlEvidence(streamEvidence({ e: 'ORDER_TRADE_UPDATE', E: NOW, o: { c: 'adl_autoclose', s: 'BTCUSDT', q: 'x' } }), NOW, 1_000), ContractError);
});

test('执行器：实盘环境接受真实 ASTER 划转、ADL 与持仓连接器，模拟环境拒绝它们', () => {
  const h = createHarness();
  try {
    const { transfers, trading } = setup();
    createExecutor({ store: h.store, connectors: [], environment: 'mainnet', transfers, adl: trading, positions: trading });
    const refused = (error: unknown) => error instanceof ContractError && error.code === 'live_transport_refused';
    assert.throws(() => createExecutor({ store: h.store, connectors: [], transfers }), refused);
    assert.throws(() => createExecutor({ store: h.store, connectors: [], adl: trading }), refused);
    assert.throws(() => createExecutor({ store: h.store, connectors: [], positions: trading }), refused);
  } finally { h.dispose(); }
});
