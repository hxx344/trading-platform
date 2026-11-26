// 实盘场所账户的只读（docs/dexspread.md 第 12 节）：保证金、可用余额与持仓。三个场所的这些读取都是公开接口，
// 只需要账户编号或地址，不签名。应答里的账户身份与请求的不一致时按读取失败处理，不采用。
import type { DexAccounts, KeyVenue } from '../dex/keys.ts';
import { ENTROPY_ENDPOINTS, LIGHTER_ENDPOINTS, readJson, type FetchLike } from './feeds.ts';

export interface AccountPosition { symbol: string; size: number; valueUsd: number }
/** `collateral` 是账户权益，`available` 是可用于新开仓的余额，单位都是该场所的保证金币种。 */
export interface AccountSnapshot { collateral: number; available: number; positions: AccountPosition[] }
/** 各场所的保证金币种：Lighter RH 用 USDG，不是 USDC。 */
export const COLLATERAL_ASSET: Record<KeyVenue, string> = { lighter: 'USDC', rh: 'USDG', entropy: 'USDC' };

const ACCOUNT_LIMIT = 2 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function amount(value: unknown, what: string): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number)) throw new Error(`账户应答缺少${what}`);
  return number;
}

export function parseLighterAccount(value: unknown, accountIndex: number): AccountSnapshot {
  if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.accounts) || value.accounts.length !== 1) throw new Error('账户应答格式无效');
  const account: unknown = value.accounts[0];
  if (!isRecord(account) || account.account_index !== accountIndex) throw new Error('账户应答与请求的账户不一致');
  if (!Array.isArray(account.positions)) throw new Error('账户应答缺少持仓');
  const positions: AccountPosition[] = [];
  for (const item of account.positions as unknown[]) {
    if (!isRecord(item) || typeof item.symbol !== 'string' || (item.sign !== 1 && item.sign !== -1)) throw new Error('账户应答的持仓格式无效');
    const size = amount(item.position, '持仓数量');
    if (size === 0) continue;
    positions.push({ symbol: item.symbol.slice(0, 40), size: item.sign * Math.abs(size), valueUsd: Math.abs(amount(item.position_value, '持仓市值')) });
  }
  return { collateral: amount(account.collateral, '保证金'), available: amount(account.available_balance, '可用余额'), positions };
}

export function parseEntropyAccount(value: unknown): AccountSnapshot {
  if (!isRecord(value) || !isRecord(value.marginSummary) || !Array.isArray(value.assetPositions)) throw new Error('账户应答格式无效');
  const positions: AccountPosition[] = [];
  for (const item of value.assetPositions as unknown[]) {
    const position = isRecord(item) ? item.position : null;
    if (!isRecord(position) || typeof position.coin !== 'string') throw new Error('账户应答的持仓格式无效');
    const size = amount(position.szi, '持仓数量');
    if (size === 0) continue;
    positions.push({ symbol: position.coin.slice(0, 40), size, valueUsd: Math.abs(amount(position.positionValue, '持仓市值')) });
  }
  return { collateral: amount(value.marginSummary.accountValue, '账户权益'), available: amount(value.withdrawable, '可用余额'), positions };
}

export async function fetchAccount(fetchImpl: FetchLike, signal: AbortSignal, venue: KeyVenue, accounts: DexAccounts): Promise<AccountSnapshot> {
  if (venue === 'entropy') {
    const account = accounts.entropy;
    if (!account) throw new Error('没有配置账户');
    // 账户地址放在请求体里，不进地址栏。
    return parseEntropyAccount(await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, ACCOUNT_LIMIT, {}, { type: 'clearinghouseState', user: account.address, dex: ENTROPY_ENDPOINTS.dex }));
  }
  const account = accounts[venue];
  if (!account) throw new Error('没有配置账户');
  return parseLighterAccount(await readJson(fetchImpl, `${LIGHTER_ENDPOINTS[venue].rest}/account?by=index&value=${account.accountIndex}`, signal, ACCOUNT_LIMIT, {}), account.accountIndex);
}
