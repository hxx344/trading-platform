import { BINANCE_DEPOSIT_TTL } from '../../chain-arb/binance-deposit-proof.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, isGateBaseSymbol, type Chain } from '../../chain-arb/model.ts';
import { isSettlementOrNative } from '../../chain-arb/networks.ts';
import { isObject } from '../../contracts.ts';
import type { BinanceCredential } from './exchanges.ts';
import { readBinanceWallet } from './binance-wallet.ts';

export const binanceDepositUnavailable = () => new Error('币安充值网络、最低充值量或收款地址无法核实，请检查资产账本只读连接');
const invalid = binanceDepositUnavailable;
const NETWORKS: ReadonlyMap<string, Chain> = new Map([['ETH', 'ethereum'], ['ARBITRUM', 'arbitrum'], ['BSC', 'bsc']]);
export const evmAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
type Selection = { symbol: string; chain: Chain; network: string; contract: string; minDeposit: string };
type ReadContext = { credential: BinanceCredential; fetcher: typeof fetch; signal: AbortSignal; now: () => number; deniedAt: number; check(): void };

async function get(ctx: ReadContext, request: Parameters<typeof readBinanceWallet>[1]) {
  ctx.check();
  const { headers, data, start } = await readBinanceWallet(ctx.credential, request, ctx.fetcher, ctx.signal, ctx.now);
  ctx.check();
  const age = headers.get('age'), date = Date.parse(headers.get('date') ?? ''), received = ctx.now();
  // HTTP Age is rounded to seconds. Include its uncertainty when comparing against revocation.
  const earliest = age === null ? start : start - Number(age) * 1000 - 999;
  const at = Math.min(start, date, earliest);
  if ((age !== null && !/^\d{1,9}$/.test(age)) || !Number.isSafeInteger(at) || at <= ctx.deniedAt ||
    received < start || date > received + CHAIN_ARB_CLOCK_SKEW_MS || received - at >= BINANCE_DEPOSIT_TTL) throw invalid();
  return { data, at };
}

export async function readBinanceDepositNetworks(ctx: ReadContext) {
  const permission = await get(ctx, { kind: 'permissions' });
  const answer = await get(ctx, { kind: 'networks' });
  if (!Array.isArray(answer.data) || answer.data.length > 12_000) throw invalid();
  const symbols = new Set<string>(), duplicateSymbols = new Set<string>();
  const contracts = new Set<string>(), duplicates = new Set<string>();
  const rows = new Map<string, Selection>();
  for (const coin of answer.data) {
    if (!isObject(coin) || typeof coin.coin !== 'string' || !coin.coin || !Array.isArray(coin.networkList) || coin.networkList.length > 128) throw invalid();
    const symbol = coin.coin;
    if (symbols.has(symbol)) duplicateSymbols.add(symbol);
    symbols.add(symbol);
    const seen = new Set<Chain>();
    for (const n of coin.networkList) {
      if (!isObject(n) || typeof n.network !== 'string' || n.coin !== symbol) throw invalid();
      const chain = NETWORKS.get(n.network);
      if (!chain) continue;
      const key = symbol + ':' + chain;
      const contract = evmAddress(n.contractAddress) ? n.contractAddress.toLowerCase() : undefined;
      if (contract) {
        const id = chain + ':' + contract;
        if (contracts.has(id)) duplicates.add(id);
        contracts.add(id);
      }
      if (seen.has(chain)) { rows.delete(key); continue; }
      seen.add(chain);
      if (!isGateBaseSymbol(symbol) || !contract || isSettlementOrNative(chain, contract) || n.denomination !== 1 ||
        coin.depositAllEnable !== true || n.depositEnable !== true || n.busy !== false || n.resetAddressStatus !== false ||
        n.memoRegex !== '' || typeof n.depositDust !== 'string' || !/^(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/.test(n.depositDust) ||
        (Object.hasOwn(coin, 'depositHideAll') && coin.depositHideAll !== false) ||
        (Object.hasOwn(n, 'depositHideEnable') && n.depositHideEnable !== false) ||
        (Object.hasOwn(n, 'depositFee') && !(typeof n.depositFee === 'string' && /^0(?:\.0{1,18})?$/.test(n.depositFee)))) continue;
      rows.set(key, { symbol, chain, network: n.network, contract, minDeposit: n.depositDust });
    }
  }
  for (const [key, row] of rows) if (duplicateSymbols.has(row.symbol) || duplicates.has(row.chain + ':' + row.contract)) rows.delete(key);
  const at = Math.min(permission.at, answer.at);
  return { at, expiresAt: at + BINANCE_DEPOSIT_TTL, rows };
}

export async function readBinanceDepositAddress(ctx: ReadContext, selected: Selection) {
  const { at, data } = await get(ctx, { kind: 'addresses', coin: selected.symbol, network: selected.network });
  if (!Array.isArray(data) || data.length > 512) throw invalid();
  let address: string | undefined;
  for (const row of data) {
    // Binance identifies all supported EVM address spaces as ETH here. The signed query binds the coin and network.
    if (!isObject(row) || row.coin !== 'ETH' || (row.isDefault !== 1 && row.isDefault !== 0) ||
      (Object.hasOwn(row, 'network') && row.network !== selected.network)) throw invalid();
    if (row.isDefault === 0) continue;
    if (address || !evmAddress(row.address) || row.tag !== '' || (Object.hasOwn(row, 'memo') && row.memo !== '') ||
      isSettlementOrNative(selected.chain, row.address) || row.address.toLowerCase() === selected.contract) throw invalid();
    address = row.address.toLowerCase();
  }
  if (!address) throw invalid();
  return { at, address };
}
