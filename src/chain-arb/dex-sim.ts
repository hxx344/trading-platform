import { keccak256 } from '../aster/eip712.ts';
import { isObject } from '../contracts.ts';
import { readSource, type DexFetcher } from './dex-request.ts';
import { isSettlementOrNative, networks } from './networks.ts';
import { CHAIN_ARB_TTL_MS, CHAIN_ARB_CLOCK_SKEW_MS, type Chain } from './model.ts';

interface SimulationInput {
  chain: Chain; address: string; amountIn: string; quote: Record<string, unknown>;
  signal: AbortSignal; fetcher?: DexFetcher; blockNumber?: string; blockHash?: string; probeTransfer?: boolean; now?: () => number;
}
export interface DexFill {
  rawQuantity: string; rawTransferQuantity: string | null; blockNumber: string; blockHash: string; blockAt: number;
  gasUnits: string; extraGasUnits: string | null;
}

// Low 20 bytes of keccak256("trading-platform:chain-arb:simulation:{buyer,recipient}:v1").
const buyer = '0x405addf30a92554095055aaf8cb7b89ef3553038';
const recipient = '0xfa89a63ff8bf31ab1d9136f39150ef414a4d9ca1';
const router = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5';
const multicall3 = '0xca11bde05977b3631167028862be2a173976ca11';
// Mapping slot in each supported settlement contract. Verify the override through balanceOf on every replay.
const balanceSlots = { ethereum: 2, arbitrum: 51, bsc: 1 } as const;
const hexQuantity = /^0x(?:0|[1-9a-f][a-f0-9]{0,63})$/i;
const abiWord = /^0x[0-9a-f]{64}$/i;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const addressWord = (address: string) => address.slice(2).padStart(64, '0');
const bytes = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[\da-f]{2}){4,}$/i.test(value);
const equalsAddress = (value: unknown, expected: string) => typeof value === 'string' && value.toLowerCase() === expected;
const badBuy = '无法核验固定预算的链上买入到账';
type Call = { from: string; to: string; data: string; gas: string };
const call = (to: string, data: string, gas: number): Call => ({ from: buyer, to, data, gas: '0x' + gas.toString(16) });
const balanceOf = (token: string, owner: string) => call(token, '0x70a08231' + addressWord(owner), 150_000);

async function buildSwap(input: SimulationInput, fetcher: DexFetcher): Promise<string> {
  const { data, ok } = await readSource(fetcher, `https://aggregator-api.kyberswap.com/${input.chain}/api/v1/route/build`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Id': 'trading-platform' },
    body: JSON.stringify({ routeSummary: input.quote, sender: buyer, recipient: buyer, source: 'trading-platform',
      enableGasEstimation: false, slippageTolerance: 2000 }),
  }, input.signal, 'KyberSwap', 512 * 1024);
  const built = ok && isObject(data) && data.code === 0 && isObject(data.data) ? data.data : null;
  if (!built || !equalsAddress(built.routerAddress, router) || built.amountIn !== input.amountIn ||
    built.transactionValue !== '0' || !bytes(built.data)) throw new Error('KyberSwap 模拟路由无效');
  return built.data;
}

async function simulate(input: SimulationInput, fetcher: DexFetcher, calls: Call[], block: string, amount: bigint) {
  const { rpc, usdt } = networks[input.chain];
  const slotWords = addressWord(buyer) + word(BigInt(balanceSlots[input.chain]));
  const slotKey = '0x' + Buffer.from(keccak256(Buffer.from(slotWords, 'hex'))).toString('hex');
  const stateOverrides = { [usdt]: { stateDiff: { [slotKey]: '0x' + word(amount) } }, [buyer]: { balance: '0xde0b6b3a7640000' } };
  const { data } = await readSource(fetcher, rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [
      { blockStateCalls: [{ stateOverrides, calls }], validation: false }, block,
    ] }),
  }, input.signal, '链上模拟节点', 512 * 1024);
  const result = isObject(data) && data.jsonrpc === '2.0' && data.id === 1 && !('error' in data) &&
    Array.isArray(data.result) && data.result.length === 1 ? data.result[0] : null;
  if (!isObject(result) || typeof result.number !== 'string' || !hexQuantity.test(result.number) || BigInt(result.number) < 1n ||
    typeof result.parentHash !== 'string' || !abiWord.test(result.parentHash) ||
    !Array.isArray(result.calls) || result.calls.length !== calls.length) throw new Error(badBuy);
  const blockNumber = '0x' + (BigInt(result.number) - 1n).toString(16);
  if (block !== 'latest' && blockNumber !== block) throw new Error(badBuy);
  return { blockNumber, parentHash: result.parentHash.toLowerCase(), calls: result.calls as unknown[] };
}

function successful(result: unknown): Record<string, unknown> {
  if (!isObject(result) || result.status !== '0x1' || 'error' in result) throw new Error(badBuy);
  return result;
}
function balance(result: unknown): bigint {
  const { returnData } = successful(result);
  if (typeof returnData !== 'string' || !abiWord.test(returnData)) throw new Error(badBuy);
  return BigInt(returnData);
}
function checkTokenWrite(result: unknown) {
  const { returnData } = successful(result);
  if (returnData !== '0x' && returnData !== '0x' + word(1n)) throw new Error(badBuy);
}
function gasUsed(result: unknown): bigint | null {
  const gas = successful(result).gasUsed;
  return typeof gas === 'string' && hexQuantity.test(gas) && BigInt(gas) > 0n ? BigInt(gas) : null;
}
function readBuy(calls: unknown[], budget: bigint) {
  const initialUsdt = balance(calls[0]), initialTarget = balance(calls[1]);
  checkTokenWrite(calls[2]);
  const swapGas = gasUsed(calls[3]);
  const remainingUsdt = balance(calls[4]), bought = balance(calls[5]) - initialTarget;
  if (initialUsdt !== budget || remainingUsdt !== 0n || bought <= 0n || swapGas === null) throw new Error(badBuy);
  return { bought, initialTarget, gasUnits: swapGas.toString() };
}

async function canonicalTime(input: SimulationInput, fetcher: DexFetcher, blockHash: string) {
  // The simulated block's timestamp is synthetic. Read the real parent's TIMESTAMP at its canonical hash.
  const { data } = await readSource(fetcher, networks[input.chain].rpc, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [
      { to: multicall3, data: '0x0f28c97d' }, { blockHash, requireCanonical: true },
    ] }),
  }, input.signal, '链上模拟节点', 16_384);
  if (!isObject(data) || data.jsonrpc !== '2.0' || data.id !== 1 || 'error' in data ||
    typeof data.result !== 'string' || !abiWord.test(data.result)) throw new Error('无法核验链上模拟区块时间');
  return Number(BigInt(data.result)) * 1000;
}

export async function simulateDexFill(input: SimulationInput): Promise<DexFill> {
  input.signal.throwIfAborted();
  const { chain, address, amountIn, quote, blockNumber } = input;
  if (!Object.hasOwn(networks, chain) || !/^0x[a-f\d]{40}$/.test(address) || isSettlementOrNative(chain, address) ||
    address === buyer || address === recipient || !/^[1-9]\d{0,77}$/.test(amountIn) || BigInt(amountIn) >= 1n << 256n ||
    (blockNumber !== undefined && !hexQuantity.test(blockNumber)) ||
    (input.blockHash !== undefined && (!blockNumber || !abiWord.test(input.blockHash)))) throw new Error(badBuy);
  const usdt = networks[chain].usdt;
  if (!equalsAddress(quote.tokenIn, usdt) || !equalsAddress(quote.tokenOut, address) || quote.amountIn !== amountIn) throw new Error(badBuy);
  const fetcher = input.fetcher ?? fetch;
  const budget = BigInt(amountIn);
  const encoded = await buildSwap(input, fetcher);
  const buyCalls = [
    balanceOf(usdt, buyer), balanceOf(address, buyer),
    call(usdt, '0x095ea7b3' + addressWord(router) + word(budget), 500_000),
    call(router, encoded, 8_000_000), balanceOf(usdt, buyer), balanceOf(address, buyer),
  ];
  const first = await simulate(input, fetcher, buyCalls, blockNumber ?? 'latest', budget);
  if (input.blockHash && first.parentHash !== input.blockHash.toLowerCase()) throw new Error('链上模拟区块已变更');
  const buy = readBuy(first.calls, budget);
  async function transferQuantity() {
    if (input.probeTransfer === false) return null;
    try {
      const replay = await simulate(input, fetcher, [...buyCalls, balanceOf(address, recipient),
        call(address, '0xa9059cbb' + addressWord(recipient) + word(buy.bought), 750_000),
        balanceOf(address, recipient), balanceOf(address, buyer),
      ], first.blockNumber, budget);
      const repeat = readBuy(replay.calls, budget);
      checkTokenWrite(replay.calls[7]);
      const received = balance(replay.calls[8]) - balance(replay.calls[6]);
      if (replay.parentHash !== first.parentHash || repeat.bought !== buy.bought || repeat.initialTarget !== buy.initialTarget ||
        balance(replay.calls[9]) !== buy.initialTarget || received <= 0n || received > buy.bought) return null;
      const approveGas = gasUsed(replay.calls[2]), transferGas = gasUsed(replay.calls[7]);
      return { raw: received.toString(), extraGas: approveGas !== null && transferGas !== null ? (approveGas + transferGas).toString() : null };
    } catch {
      input.signal.throwIfAborted();
    }
    return null;
  }
  const [transfer, blockAt] = await Promise.all([transferQuantity(), canonicalTime(input, fetcher, first.parentHash)]);
  input.signal.throwIfAborted();
  const age = (input.now ?? Date.now)() - blockAt;
  if (!Number.isSafeInteger(blockAt) || blockAt <= 0 || age < -CHAIN_ARB_CLOCK_SKEW_MS || age >= CHAIN_ARB_TTL_MS) {
    throw new Error('链上模拟区块已过期或时间异常');
  }
  return { rawQuantity: buy.bought.toString(), rawTransferQuantity: transfer?.raw ?? null, blockNumber: first.blockNumber,
    blockHash: first.parentHash, blockAt, gasUnits: buy.gasUnits, extraGasUnits: transfer?.extraGas ?? null };
}
