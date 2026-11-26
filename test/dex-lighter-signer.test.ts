// Lighter 交易签名器（src/varlighter/lighter-signer.ts）：加载由 CI 从固定源码编译的 WASM，签下单交易与鉴权令牌。
// 不连任何外部服务。签名器文件由 scripts/build-lighter-signer.sh 生成、不进仓库：CI 里必须有（没有就失败），
// 本机没有时跳过需要它的用例。txInfo 的字段名对照 lighter-go（提交 e8687faa）的 L2CreateOrderTxInfo 与内嵌的 OrderInfo。
import test from 'node:test';
import assert from 'node:assert/strict';
import { LighterSignerError, createLighterSigner, lighterSignerProblem, type LighterOrderInput, type LighterSignerConfig } from '../src/varlighter/lighter-signer.ts';

// 测试值，不对应任何真实账户：小端 40 字节，高 8 字节为 0。
const TEST_KEY = '0123456789abcdef'.repeat(4) + '0'.repeat(16);
const MAINNET = 304, RH = 466324;
const MAIN: LighterSignerConfig = { chainId: MAINNET, privateKey: TEST_KEY, apiKeyIndex: 3, accountIndex: 123456 };
const ORDER: LighterOrderInput = { marketIndex: 1, clientOrderIndex: 987654321, baseAmount: 1500, price: 4_250_000, isAsk: true, orderType: 1, timeInForce: 0, reduceOnly: false, triggerPrice: 0, orderExpiry: 0, nonce: 42 };

const problem = lighterSignerProblem();
const inCi = !!process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0';
/** 需要签名器文件的用例：CI 里缺文件是失败，本机缺文件是跳过。 */
function signerTest(name: string, fn: (t: test.TestContext) => Promise<void>): void {
  if (problem !== null && inCi) test(name, () => assert.fail(`CI 里必须有签名器文件：${problem}`));
  else test(name, { skip: problem ?? false }, fn);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  return assert.fail('应当失败');
}

test('签名器配置在加载文件之前校验，报错不带私钥与编号', async () => {
  const bad: [string, LighterSignerConfig][] = [
    ['私钥不是十六进制', { ...MAIN, privateKey: 'z'.repeat(80) }],
    ['私钥长度不对', { ...MAIN, privateKey: TEST_KEY.slice(2) }],
    ['私钥带 0x', { ...MAIN, privateKey: '0x' + TEST_KEY }],
    ['chainId 为 0', { ...MAIN, chainId: 0 }],
    ['chainId 超过 32 位', { ...MAIN, chainId: 2 ** 32 }],
    ['API 密钥编号 255', { ...MAIN, apiKeyIndex: 255 }],
    ['API 密钥编号为小数', { ...MAIN, apiKeyIndex: 1.5 }],
    ['账户编号 0', { ...MAIN, accountIndex: 0 }],
    ['账户编号超出 48 位', { ...MAIN, accountIndex: 2 ** 48 - 1 }],
    ['账户编号是字符串', { ...MAIN, accountIndex: '123456' as unknown as number }],
  ];
  for (const [label, config] of bad) {
    const error = await rejection(createLighterSigner(config));
    assert.ok(error instanceof LighterSignerError, label);
    assert.ok(!error.message.includes(TEST_KEY) && !error.message.includes(TEST_KEY.slice(2)) && !error.message.includes('z'.repeat(8)), `${label}：文案不带私钥`);
    assert.ok(!error.message.includes('123456'), `${label}：文案不带账户编号`);
  }
  const reason = lighterSignerProblem();
  assert.ok(reason === null || (typeof reason === 'string' && reason.length > 0 && !reason.includes('\n')), '文件齐全返回 null，否则一句原因');
});

signerTest('主网与 RH 各一个实例：市价 IOC 单的 txInfo 与入参一致，实例之间互不相混', async t => {
  const main = await createLighterSigner(MAIN);
  // 并发创建：内部串行，各自拿到自己的实例。
  const [rh, mainTwin, rhSameAccount] = await Promise.all([
    createLighterSigner({ chainId: RH, privateKey: TEST_KEY, apiKeyIndex: 4, accountIndex: 654321 }),
    createLighterSigner(MAIN),
    createLighterSigner({ ...MAIN, chainId: RH }),
  ]);
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of ['Go', 'CreateClient', 'SignCreateOrder', 'CreateAuthToken', 'GenerateAPIKey', 'SignCancelOrder']) assert.equal(scope[name], undefined, `globalThis.${name} 已清走`);

  // 上游用 Date 取当前时间来定交易的 ExpiredAt（现在 + 10 分钟 − 1 秒）。定住它，同样的入参就得到同样的待签哈希。
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const signed = main.signCreateOrder(ORDER);
  assert.equal(signed.txType, 14);
  assert.match(signed.txHash, /^[0-9a-f]{80}$/);
  const info = JSON.parse(signed.txInfo) as Record<string, unknown>;
  assert.deepEqual(Object.keys(info).sort(), ['AccountIndex', 'ApiKeyIndex', 'BaseAmount', 'ClientOrderIndex', 'ExpiredAt', 'IsAsk', 'L2TxAttributes', 'MarketIndex', 'Nonce', 'OrderExpiry', 'Price', 'ReduceOnly', 'Sig', 'TimeInForce', 'TriggerPrice', 'Type'].sort());
  const { Sig, ...rest } = info;
  assert.deepEqual(rest, {
    AccountIndex: 123456, ApiKeyIndex: 3, MarketIndex: 1, ClientOrderIndex: 987654321, BaseAmount: 1500, Price: 4_250_000, IsAsk: 1, Type: 1, TimeInForce: 0,
    ReduceOnly: 0, TriggerPrice: 0, OrderExpiry: 0, ExpiredAt: now + 599_000, Nonce: 42, L2TxAttributes: null,
  });
  assert.equal(typeof Sig, 'string');
  assert.equal(Buffer.from(Sig as string, 'base64').length, 80, 'Sig 是 80 字节签名的 base64');

  // 买单、只减仓、另一个 nonce。
  const buy = JSON.parse(main.signCreateOrder({ ...ORDER, isAsk: false, reduceOnly: true, nonce: 43 }).txInfo) as Record<string, unknown>;
  assert.deepEqual([buy.IsAsk, buy.ReduceOnly, buy.Nonce], [0, 1, 43]);
  // 限价 GTT 单带到期时间。
  const limit = JSON.parse(main.signCreateOrder({ ...ORDER, orderType: 0, timeInForce: 1, orderExpiry: now + 3_600_000 }).txInfo) as Record<string, unknown>;
  assert.deepEqual([limit.Type, limit.TimeInForce, limit.OrderExpiry], [0, 1, now + 3_600_000]);

  // RH 实例用自己的账户与 API 密钥编号。
  const rhInfo = JSON.parse(rh.signCreateOrder(ORDER).txInfo) as Record<string, unknown>;
  assert.deepEqual([rhInfo.AccountIndex, rhInfo.ApiKeyIndex, rhInfo.MarketIndex, rhInfo.Nonce], [654321, 4, 1, 42]);
  // 待签哈希由 chainId 与交易内容决定：同配置的另一个实例相同，只换 chainId 就不同。
  assert.equal(mainTwin.signCreateOrder(ORDER).txHash, signed.txHash, '同一 chainId、账户与入参，另一个实例的哈希相同');
  assert.notEqual(rhSameAccount.signCreateOrder(ORDER).txHash, signed.txHash, '只换 chainId，哈希不同');
  assert.equal(main.signCreateOrder(ORDER).txHash, signed.txHash, '建过别的实例之后，原实例仍按自己的 chainId 签');
  t.mock.timers.reset();

  // 鉴权令牌：截止秒:账户编号:API 密钥编号:160 位十六进制签名。
  const deadline = 1_800_000_600;
  assert.match(main.createAuthToken(deadline), new RegExp(`^${deadline}:123456:3:[0-9a-f]{160}$`));
  assert.match(rh.createAuthToken(deadline), new RegExp(`^${deadline}:654321:4:[0-9a-f]{160}$`));
});

signerTest('越界入参报 LighterSignerError，文案不带私钥', async () => {
  const signer = await createLighterSigner(MAIN);
  const bad: [string, Partial<Record<keyof LighterOrderInput, unknown>>][] = [
    ['clientOrderIndex 为 0', { clientOrderIndex: 0 }],
    ['clientOrderIndex 超过 48 位', { clientOrderIndex: 2 ** 48 }],
    ['price 为 0', { price: 0 }],
    ['price 超过 32 位', { price: 2 ** 32 }],
    ['price 为小数', { price: 1.5 }],
    ['baseAmount 为 0', { baseAmount: 0 }],
    ['baseAmount 为负', { baseAmount: -1 }],
    ['baseAmount 不是数', { baseAmount: Number.NaN }],
    ['baseAmount 不是安全整数', { baseAmount: 2 ** 53 }],
    ['marketIndex 为负', { marketIndex: -1 }],
    ['marketIndex 为 255', { marketIndex: 255 }],
    ['orderType 越界', { orderType: 7 }],
    ['timeInForce 越界', { timeInForce: 3 }],
    ['triggerPrice 超过 32 位', { triggerPrice: 2 ** 32 }],
    ['orderExpiry 为 -1', { orderExpiry: -1 }],
    ['nonce 为 -1', { nonce: -1 }],
    ['isAsk 不是布尔', { isAsk: 1 }],
    ['reduceOnly 不是布尔', { reduceOnly: 'false' }],
    ['price 是字符串', { price: '4250000' }],
    // 这两项范围内，由上游的校验拒绝：市价单必须 IOC、不带到期时间。
    ['市价单用 GTT', { timeInForce: 1 }],
    ['市价单带到期时间', { orderExpiry: 1_800_000_000_000 }],
  ];
  for (const [label, patch] of bad) {
    assert.throws(() => signer.signCreateOrder({ ...ORDER, ...patch } as LighterOrderInput), (error: unknown) => {
      assert.ok(error instanceof LighterSignerError, label);
      assert.ok(!error.message.includes(TEST_KEY), `${label}：文案不带私钥`);
      assert.ok(!error.message.includes('123456'), `${label}：文案不带账户编号`);
      return true;
    }, label);
  }
  for (const deadline of [0, -1, 1.5, 2 ** 48, Number.NaN]) assert.throws(() => signer.createAuthToken(deadline), LighterSignerError, `deadline ${deadline}`);
  assert.throws(() => signer.signCreateOrder({ ...ORDER, timeInForce: 1 }), /OrderTimeInForce is not valid/, '上游的固定校验句式原样带出');
  // 出过错之后实例照常可用。
  assert.equal(signer.signCreateOrder(ORDER).txType, 14);
});
