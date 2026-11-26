import assert from 'node:assert/strict';
import test from 'node:test';
import { solidityPackedKeccak256 } from 'ethers';
import { simulateDexFill } from '../src/chain-arb/dex-sim.ts';
import { networks } from '../src/chain-arb/networks.ts';

const buyer = '0x405addf30a92554095055aaf8cb7b89ef3553038', recipient = '0xfa89a63ff8bf31ab1d9136f39150ef414a4d9ca1';
const router = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5', target = '0x14778860e937f509e651192a90589de711fb88a9';
const hash = '0x' + 'ab'.repeat(32), now = 1_795_724_000_000;
const hex = (amount: bigint | number) => '0x' + amount.toString(16).padStart(64, '0');
const success = (returnData: string, gasUsed = '0x10000') => ({ returnData, gasUsed, status: '0x1' });
type Receipt = ReturnType<typeof success>;
interface Options {
  chain?: keyof typeof networks; changeBuy?: (calls: Receipt[]) => void; changeReplay?: (calls: Receipt[]) => void;
  changeBuild?: Record<string, unknown>; timestamp?: number; replayHash?: string; probeTransfer?: boolean;
  blockNumber?: string; blockHash?: string;
}
function fixture(options: Options = {}) {
  const chain = options.chain ?? 'ethereum', usdt = networks[chain].usdt;
  const amount = 100n * 10n ** BigInt(networks[chain].decimals);
  const quote = { tokenIn: usdt, tokenOut: target, amountIn: String(amount), amountOut: '1000' };
  const seen: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(String(init.body));
    if (url.startsWith('https://aggregator-api.kyberswap.com/')) {
      seen.push('build');
      assert.equal(url, `https://aggregator-api.kyberswap.com/${chain}/api/v1/route/build`);
      assert.equal(init.method, 'POST');
      assert.equal(body.sender, buyer); assert.equal(body.recipient, buyer);
      assert.deepEqual(body.routeSummary, quote);
      assert.equal(body.enableGasEstimation, false);
      return Response.json({ code: 0, data: { routerAddress: router, amountIn: String(amount),
        transactionValue: '0', data: '0xe21fd0e9', ...options.changeBuild } });
    }
    assert.equal(url, networks[chain].rpc);
    assert.equal(init.method, 'POST');
    const [params, block] = body.params;
    if (body.method === 'eth_call') {
      seen.push('time');
      assert.deepEqual(params, { to: '0xca11bde05977b3631167028862be2a173976ca11', data: '0x0f28c97d' });
      assert.deepEqual(block, { blockHash: hash, requireCanonical: true });
      return Response.json({ jsonrpc: '2.0', id: 1, result: hex(options.timestamp ?? now / 1000 - 1) });
    }
    assert.equal(body.method, 'eth_simulateV1');
    assert.equal(params.validation, false);
    assert.equal(params.blockStateCalls.length, 1);
    const [{ calls, stateOverrides }] = params.blockStateCalls;
    const transfer = calls.length === 10;
    seen.push(transfer ? 'transfer' : 'buy');
    assert.equal(block, transfer ? '0x11' : options.blockNumber ?? 'latest');
    assert.deepEqual(Object.keys(stateOverrides).sort(), [buyer, usdt].sort());
    const slot = { ethereum: 2, arbitrum: 51, bsc: 1 }[chain];
    const key = solidityPackedKeccak256(['uint256', 'uint256'], [BigInt(buyer), slot]);
    assert.deepEqual(stateOverrides[usdt], { stateDiff: { [key]: hex(amount) } });
    assert.equal(calls.length, transfer ? 10 : 6);
    assert.ok(calls.every((c: { from: string }) => c.from === buyer));
    const selector = (i: number, to: string, encoded: string) => {
      assert.equal(calls[i].to, to); assert.equal(calls[i].data, encoded);
    };
    const addressArg = (a: string) => a.slice(2).padStart(64, '0');
    const bal = (i: number, to: string, who: string) => selector(i, to, '0x70a08231' + addressArg(who));
    bal(0, usdt, buyer); bal(1, target, buyer);
    selector(2, usdt, '0x095ea7b3' + addressArg(router) + hex(amount).slice(2));
    selector(3, router, '0xe21fd0e9'); bal(4, usdt, buyer); bal(5, target, buyer);
    const receipts = [success(hex(amount)), success(hex(13)), success('0x'), success('0x', '0x50000'), success(hex(0)), success(hex(763))];
    options.changeBuy?.(receipts);
    if (transfer) {
      bal(6, target, recipient); selector(7, target, '0xa9059cbb' + addressArg(recipient) + hex(750).slice(2));
      bal(8, target, recipient); bal(9, target, buyer);
      receipts.push(success(hex(5)), success(hex(1)), success(hex(605)), success(hex(13)));
      options.changeReplay?.(receipts);
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result: [{ number: '0x12', parentHash: transfer ? options.replayHash ?? hash : hash, calls: receipts }] });
  };
  return { seen, run: () => simulateDexFill({ chain, address: target, amountIn: String(amount), quote,
    signal: new AbortController().signal, fetcher, now: () => now, probeTransfer: options.probeTransfer,
    blockNumber: options.blockNumber, blockHash: options.blockHash }) };
}

test('各链只用完整 USDT 预算和钱包增量，独立重放测得普通转账实际到账及额外 Gas', async () => {
  for (const chain of ['ethereum', 'arbitrum', 'bsc'] as const) {
    const { seen, run } = fixture({ chain });
    assert.deepEqual(await run(), { rawQuantity: '750', rawTransferQuantity: '600', gasUnits: '327680', extraGasUnits: '131072',
      blockNumber: '0x11', blockHash: hash, blockAt: now - 1000 });
    assert.deepEqual(seen.sort(), ['build', 'buy', 'time', 'transfer']);
  }
});

test('拒绝不同路由地址、输入、原生价值或不完整的模拟账目', async () => {
  for (const changeBuild of [{ routerAddress: recipient }, { amountIn: '1' }, { transactionValue: '1' }, { data: '0xbeef' }]) {
    const { run, seen } = fixture({ changeBuild });
    await assert.rejects(run(), /模拟路由无效/); assert.deepEqual(seen, ['build']);
  }
  for (const changeBuy of [
    (r: Receipt[]) => { r[0].returnData = hex(999); }, (r: Receipt[]) => { r[4].returnData = hex(1); },
    (r: Receipt[]) => { r[2].returnData = hex(0); }, (r: Receipt[]) => { r[3].status = '0x0'; },
    (r: Receipt[]) => { r[5].returnData = hex(13); }, (r: Receipt[]) => { r[3].gasUsed = '0x0'; },
  ]) await assert.rejects(fixture({ changeBuy }).run(), /固定预算/);
});

test('已测得的买入与不可核实的普通转账分别返回，同一父块才采用转账数量', async () => {
  for (const options of [
    { replayHash: '0x' + '03'.repeat(32) }, { changeReplay: (r: Receipt[]) => { r[7].returnData = hex(0); } },
    { changeReplay: (r: Receipt[]) => { r[9].returnData = hex(14); } },
    { changeReplay: (r: Receipt[]) => { r[8].returnData = hex(5); } },
    { changeReplay: (r: Receipt[]) => { r[8].returnData = hex(756); } },
    { changeReplay: (r: Receipt[]) => { r[5].returnData = hex(762); } },
  ]) {
    const result = await fixture(options).run();
    assert.equal(result.rawQuantity, '750'); assert.equal(result.rawTransferQuantity, null); assert.equal(result.extraGasUnits, null);
  }
  const result = await fixture({ changeReplay: (r: Receipt[]) => { r[7].gasUsed = ''; } }).run();
  assert.equal(result.rawTransferQuantity, '600'); assert.equal(result.extraGasUnits, null);
});

test('探针复用指定块高与哈希，拒绝超时、未来区块以及换块，不重复转账', async () => {
  const { run, seen } = fixture({ probeTransfer: false, blockNumber: '0x11', blockHash: hash });
  assert.equal((await run()).rawQuantity, '750'); assert.deepEqual(seen, ['build', 'buy', 'time']);
  await assert.rejects(fixture({ blockNumber: '0x10' }).run(), /固定预算/);
  await assert.rejects(fixture({ blockNumber: '0x11', blockHash: '0x' + 'cc'.repeat(32) }).run(), /区块已变更/);
  for (const delta of [-15, 3]) await assert.rejects(fixture({ timestamp: now / 1000 + delta }).run(), /过期或时间异常/);
});
