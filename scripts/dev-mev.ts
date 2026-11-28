// MEV 套利页（docs/mev.md）的本地预览：替身 Base 节点（src/mev/fake-chain.ts），不联网、不用任何真实密钥。
// 临时数据目录里预先写入几笔已结清的交易；两个 WETH/USDC 池子之间留了价差，页面上会持续出现机会。
// 热钱包私钥在启动时随机生成，只存在于本进程。点「开始实盘」后，替身节点在下一个区块让发出的交易上链。
// 加 --setup 从「还没启用」开始，用来看页面启用向导：在页面填下面这把公开的测试私钥（各测试文件共用的 KEY）与任意收款地址，
// 点部署后替身节点在下一个区块让合约「上链」。
//   pnpm build:web; node scripts/dev-mev.ts [--port 4734] [--setup]
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/store.ts';
import { createExecutor } from '../src/executor.ts';
import { createSimulatedVenues } from '../src/simulation.ts';
import { runExecutor } from '../src/runtime.ts';
import { loadWebApp } from '../src/web-assets.ts';
import { DEFAULT_MIDDLE_TOKENS, FACTORIES, KIND_AERO_V2, KIND_V2, USDC, WETH, type FactoryInfo, type TokenInfo } from '../src/mev/chain.ts';
import { addressOf } from '../src/mev/codec.ts';
import { contractAddress } from '../src/mev/setup.ts';
import { createFakeChain, type FakePool } from '../src/mev/fake-chain.ts';
import { MEV_FILE, openMevStore } from '../src/mev/store.ts';
import { openMev } from '../src/service/mev.ts';

const { values } = parseArgs({ options: { port: { type: 'string', default: '4734' }, setup: { type: 'boolean', default: false } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port 无效');

/** 公开的测试私钥，只用于 --setup 的替身链预览；不要给它转入任何真实资产。 */
const SETUP_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const privateKey = values.setup ? SETUP_KEY : '0x' + randomBytes(32).toString('hex');
const operator = addressOf(privateKey), owner = '0x000000000000000000000000000000000000b0b0';
const executor = values.setup ? contractAddress(operator, 0) : '0x00000000000000000000000000000000004d4556';
const AERO = '0x940181a94a35a4569e4529a3cdfb74e38fd98631', CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const tokens: TokenInfo[] = [
  { address: WETH, symbol: 'WETH', decimals: 18 }, { address: USDC, symbol: 'USDC', decimals: 6 },
  { address: AERO, symbol: 'AERO', decimals: 18 }, { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
];
const USD: Record<string, number> = { [WETH]: 3_400, [USDC]: 1, [AERO]: 1.1, [CBBTC]: 97_000 };
const decimalsOf = (address: string): number => tokens.find(token => token.address === address)!.decimals;
const factoryNamed = (label: string): FactoryInfo => FACTORIES.find(factory => factory.label === label)!;
const uniswap = factoryNamed('Uniswap v3'), slipstream = factoryNamed('Aerodrome Slipstream'), aeroV2 = factoryNamed('Aerodrome v2'), uniV2 = factoryNamed('Uniswap v2'), pancake = factoryNamed('PancakeSwap v3');
let serial = 0;
/** 一个池子：两种代币按地址排序，`skew` 是相对公允价的偏移，`depthUsd` 是单侧深度。 */
function pool(factory: FactoryInfo, a: string, b: string, tier: bigint | undefined, fee: bigint, depthUsd: number, skew = 0): FakePool {
  const [token0, token1] = a < b ? [a, b] : [b, a];
  const price = USD[token0]! / USD[token1]! * 10 ** (decimalsOf(token1) - decimalsOf(token0)) * (1 + skew);
  const reserve0 = depthUsd / USD[token0]! * 10 ** decimalsOf(token0);
  return { address: '0x' + (0xfeed0000 + ++serial).toString(16).padStart(40, '0'), factory, token0, token1, ...(tier === undefined ? {} : { tier }), fee, price,
    depth: factory.kind === KIND_AERO_V2 || factory.kind === KIND_V2 ? reserve0 : reserve0 * Math.sqrt(price) };
}
const pools = [
  pool(uniswap, WETH, USDC, 500n, 500n, 6_000_000), pool(slipstream, WETH, USDC, 100n, 400n, 4_500_000, 0.0032), pool(uniswap, WETH, USDC, 3000n, 3000n, 800_000),
  pool(aeroV2, WETH, USDC, undefined, 30n, 2_200_000), pool(slipstream, WETH, CBBTC, 100n, 300n, 3_000_000), pool(uniswap, USDC, CBBTC, 500n, 500n, 2_500_000, -0.0011),
  pool(aeroV2, WETH, AERO, undefined, 30n, 1_400_000), pool(slipstream, USDC, AERO, 200n, 2500n, 900_000), pool(uniswap, WETH, AERO, 10000n, 10000n, 12_000),
  pool(uniV2, WETH, USDC, undefined, 0n, 650_000, 0.0008), pool(pancake, WETH, CBBTC, 500n, 500n, 1_100_000),
];

const app = loadWebApp();
const dir = mkdtempSync(join(tmpdir(), 'tp-dev-mev-'));
const now = Date.now();
const chain = createFakeChain({
  executor, owner, operator, tokens, pools,
  // 利润随输入先增后减，约在 5000 美元名义处最大；每隔几个区块才有一次，像真实链上那样时有时无。
  profit: call => {
    if (chain.state.block % 4 === 0 || call.pools.length !== 2) return null;
    const unit = 10 ** decimalsOf(call.start), notional = Number(call.amountIn) / unit * USD[call.start]!;
    const usd = notional * 0.0021 - notional ** 2 / 4_800_000;
    return usd > 0 ? BigInt(Math.floor(usd / USD[call.start]! * unit)) : null;
  },
});
chain.state.nonce = values.setup ? 0 : 3;
chain.state.balance = 12n * 10n ** 15n;
chain.state.deployed = !values.setup;

// 预先写入三笔已结清的交易与对应的机会。
if (!values.setup) {
  const store = openMevStore(join(dir, MEV_FILE));
  for (const token of tokens) store.putToken(token, now);
  store.writeState('seeded', true, now);
  store.writeState('seededTokens', [...DEFAULT_MIDDLE_TOKENS], now);
  const path = 'WETH → USDC → WETH（Uniswap v3、Aerodrome Slipstream）';
  const seed = (nonce: number, minutesAgo: number, status: 'success' | 'reverted', profit: bigint): void => {
    const at = now - minutesAgo * 60_000, hash = '0x' + randomBytes(32).toString('hex'), expected = 1_450_000_000_000_000n;
    const opportunityId = store.addOpportunity({ at, block: 990 + nonce, cycleId: `seed-${nonce}`, path, start: WETH, edgeBps: 21.4, amountIn: 14n * 10n ** 17n, profit: expected, profitUsd: 4.93, costUsd: 1.52, netUsd: 3.41, outcome: 'sent', reason: null });
    store.recordTx({ hash, nonce, raw: '0x02', createdAt: at, deadlineBlock: 992 + nonce, maxFeePerGas: 20_000_000n, maxPriorityFeePerGas: 3_000_000n, worstCostWei: 30_000_000_000_000n, opportunityId, start: WETH, path, expectedProfit: expected });
    store.settleTx(hash, status, at + 4_000, { block: 991 + nonce, feeWei: status === 'success' ? 9_800_000_000_000n : 6_100_000_000_000n, profit: status === 'success' ? profit : null, error: null });
  };
  seed(0, 95, 'success', 1_390_000_000_000_000n); seed(1, 52, 'reverted', 0n); seed(2, 17, 'success', 1_120_000_000_000_000n);
  store.close();
}

const mev = openMev(values.setup ? {} : { config: { executor, owner }, secrets: { rpcUrl: 'https://fake.invalid', privateKey } }, dir, { fetchImpl: chain.fetchImpl },
  { log: line => process.stderr.write(`${line}\n`), notify: (_key, text) => process.stderr.write(`（通知）${text}\n`) });
// 两秒一个区块；上一个区块里发出的交易在这个区块上链。
const mined = new Set<string>();
const blocks = setInterval(() => {
  chain.advance();
  for (const tx of chain.state.sent) if (!mined.has(tx.hash)) {
    mined.add(tx.hash);
    if (!chain.state.deployed) { chain.state.deployed = true; chain.mine(tx.hash, 'success'); continue; }
    chain.mine(tx.hash, mined.size % 4 === 0 ? 'reverted' : 'success', { profit: 1_300_000_000_000_000n }); }
}, 2_000);

const store = openStore(join(dir, 'executor.sqlite'));
const { binance, bybit, aster, asterTrading } = createSimulatedVenues(Date.now);
const service = createExecutor({ store, connectors: [binance, bybit], transfers: aster, adl: asterTrading, positions: asterTrading });
if (!service.acquire()) throw new Error('写入租约被占用');
const run = runExecutor({
  executor: service, store, dir, port, app, passes: [],
  views: { mev: mev.views },
  startedMessage: `MEV 套利预览（替身节点）已启动，数据目录 ${dir}`,
  background: context => [mev.loop(context)],
});
let link = '';
for (let i = 0; i < 100 && !link; i++) {
  try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; }
  catch { await new Promise(resolve => setTimeout(resolve, 50)); }
}
process.stdout.write(link ? `登录链接：${link}\n登录后打开：http://127.0.0.1:${port}/#/mev\n按 Ctrl+C 停止（临时数据目录随之删除）\n${values.setup ? `启用向导用的测试私钥：${SETUP_KEY}\n收款地址可填：${owner}\n` : ''}` : '未能读到登录链接\n');
await run.done;
clearInterval(blocks);
rmSync(dir, { recursive: true, force: true });
