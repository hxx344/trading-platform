import assert from 'node:assert/strict';
import test from 'node:test';
import { readDex } from '../src/chain-arb/dex.ts';

const target = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const input = { chain: 'arbitrum', address: target, amount: '123.456789' } as const;
const signal = new AbortController().signal;
// Arbitrum 公开 GET /api/v1/routes 样本，仅保留参与解析的字段。
const sourceRoute = {
  tokenIn: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', tokenOut: target,
  amountIn: '123456789', amountOut: '72841644585880832', timestamp: 1795690821,
};
const routeBody = (fields: Record<string, unknown> = {}) => ({ code: 0, data: { routeSummary: { ...sourceRoute, ...fields } } });
const decimalsBody = (decimals: number) => ({ jsonrpc: '2.0', id: 1, result: '0x' + decimals.toString(16).padStart(64, '0') });
const respond = (route: unknown, metadata: unknown = decimalsBody(18)) => async (_url: string, init: RequestInit) =>
  Response.json(init.method === 'GET' ? route : metadata);

test('使用各链的 USDT 与整数金额，按 ERC-20 精度返回数量与报价源时间', async () => {
  const fixtures = [
    { chain: 'ethereum', usdt: '0xdac17f958d2ee523a2206206994597c13d831ec7', scaled: '123456789', rpc: 'https://ethereum-rpc.publicnode.com' },
    { chain: 'arbitrum', usdt: sourceRoute.tokenIn, scaled: '123456789', rpc: 'https://arb1.arbitrum.io/rpc' },
    { chain: 'bsc', usdt: '0x55d398326f99059ff775485246999027b3197955', scaled: '123456789000000000000', rpc: 'https://bsc-dataseed.bnbchain.org' },
  ] as const;
  for (const network of fixtures) {
    const calls: string[] = [];
    const result = await readDex({ ...input, chain: network.chain }, signal, async (url, init) => {
      assert.equal(init.redirect, 'error');
      const endpoint = new URL(url);
      calls.push(init.method!);
      if (init.method === 'POST') {
        assert.equal(url, network.rpc);
        assert.deepEqual(JSON.parse(String(init.body)), {
          jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: target, data: '0x313ce567' }, 'latest'],
        });
        return Response.json(decimalsBody(18));
      }
      assert.equal(endpoint.origin, 'https://aggregator-api.kyberswap.com');
      assert.equal(endpoint.pathname, `/${network.chain}/api/v1/routes`);
      assert.deepEqual(Object.fromEntries(endpoint.searchParams), { tokenIn: network.usdt, tokenOut: target, amountIn: network.scaled });
      return Response.json(routeBody({ tokenIn: network.usdt, amountIn: network.scaled }));
    });
    assert.deepEqual(calls.sort(), ['GET', 'POST']);
    assert.deepEqual(result, { rawQuantity: sourceRoute.amountOut, decimals: 18, at: 1795690821000, swapGasUsdt: null });
  }
  const tiny = await readDex(input, signal, respond(routeBody({ amountOut: '1', timestamp: '1795690821' }), decimalsBody(255)));
  assert.deepEqual(tiny, { rawQuantity: '1', decimals: 255, at: 1795690821000, swapGasUsdt: null });
});

test('拒绝错误币种、金额、数量、时间与精度响应', async () => {
  for (const fields of [{ tokenIn: target }, { tokenOut: sourceRoute.tokenIn }, { amountIn: '123456790' }]) {
    await assert.rejects(readDex(input, signal, respond(routeBody(fields))), /币种或输入金额不符/);
  }
  for (const invalid of ['0', -1, '1.5', '3e5', (1n << 256n).toString()]) {
    await assert.rejects(readDex(input, signal, respond(routeBody({ amountOut: invalid }))), /数量无效/);
  }
  for (const invalid of [undefined, 0, null, 1795690821000, []]) {
    await assert.rejects(readDex(input, signal, respond(routeBody({ timestamp: invalid }))), /报价时间/);
  }
  for (const invalid of [{ ...decimalsBody(18), id: 2 }, decimalsBody(256), { ...decimalsBody(18), result: '0x' }, { error: { message: 'private trace' } }]) {
    await assert.rejects(readDex(input, signal, respond(routeBody(), invalid)), /无法读取目标代币的 ERC-20 精度/);
  }
});

test('按同份路由的 USDT 美元估值折算买入 Gas，缺失或无效的 Gas 保留未知', async () => {
  const gas = async (gasUsd: unknown, amountInUsd: unknown) =>
    (await readDex(input, signal, respond(routeBody({ gasUsd, amountInUsd })))).swapGasUsdt;
  assert.equal(await gas('2', '246.913578'), 1);
  for (const value of [null, '', '0', '-1', 'Infinity', '1x']) assert.equal(await gas(value, '123'), null);
  assert.equal(await gas('2', '0'), null);
});

test('不向外发送无效输入，保留上游明确的缺少路由或限流原因', async () => {
  let calls = 0;
  const unexpected = async () => { calls++; return Response.json(null); };
  for (const amount of ['0.000000', '1e6', '1.0000001', '-5']) {
    await assert.rejects(readDex({ ...input, amount }, signal, unexpected), /USDT 金额/);
  }
  for (const address of [sourceRoute.tokenIn, '0x' + '0'.repeat(40), 'https://example.org']) {
    await assert.rejects(readDex({ ...input, address }, signal, unexpected), /合约/);
  }
  await assert.rejects(readDex(input, AbortSignal.abort('private trace'), unexpected), /链上报价请求已中止/);
  assert.equal(calls, 0);
  for (const [status, code, message] of [[400, 4008, /可用兑换路线/], [400, 4011, /未收录/], [429, 0, /请求受限/]] as const) {
    const failing = async (_url: string, init: RequestInit) => init.method === 'POST' ? Response.json(decimalsBody(18)) :
      Response.json({ code, message: 'private trace' }, { status });
    await assert.rejects(readDex(input, signal, failing), error => error instanceof Error && message.test(error.message) && !error.message.includes('private trace'));
  }
});

test('超长响应或取消会关闭读取，网络异常只显示来源', async () => {
  await assert.rejects(readDex(input, signal, async (_url, init) => init.method === 'POST' ? Response.json(decimalsBody(18)) :
    new Response('x'.repeat(512 * 1024 + 1))), /KyberSwap响应过大/);
  await assert.rejects(readDex(input, signal, async () => { throw new Error('private trace'); }), { message: 'KyberSwap连接失败' });
  const controller = new AbortController();
  const pending = readDex(input, controller.signal, async (_url, init) => init.method === 'POST' ? Response.json(decimalsBody(18)) :
    new Response(new ReadableStream<Uint8Array>({ start() {} })));
  await new Promise<void>(resolve => setImmediate(resolve));
  controller.abort('private trace');
  await assert.rejects(pending, { message: '链上报价请求已中止' });
});
