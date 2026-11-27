// 实盘场所账户的只读与历史读取（docs/dexspread.md 第 12、14、15 节）：保证金、权益、可用余额、持仓、成交、资金费与盈亏曲线。
// 账户余额/持仓及 Entropy 历史均为公开接口，只需要账户编号或地址（Entropy 会按 userAbstraction 区分标准与统一账户）；Lighter 成交、资金费与盈亏需要 API 凭据鉴权令牌。
// 应答里的账户身份与请求的不一致时按读取失败处理，不采用；错误文本统一经 scrub 脱敏，不泄露编号、地址或密钥。
import type { DexAccounts, KeyVenue } from '../dex/keys.ts';
import { ENTROPY_ENDPOINTS, LIGHTER_ENDPOINTS, readJson, type FetchLike } from './feeds.ts';
import { scrub } from './orders.ts';

export interface AccountAsset { symbol: string; balance: number; locked: number }
export interface AccountPosition {
  symbol: string;
  size: number;
  valueUsd: number;
  entryPrice?: number | null;
  unrealizedPnl?: number | null;
  realizedPnl?: number | null;
  liquidationPrice?: number | null;
  leverage?: number | null;
  marginMode?: 'cross' | 'isolated' | null;
  marketId?: number | null;
}
/** `collateral` 是保证金，`equity` 是含未实现盈亏的账户权益，`available` 是可用于新开仓的余额，单位都是该场所的保证金币种。 */
export interface AccountSnapshot {
  collateral: number;
  available: number;
  positions: AccountPosition[];
  equity?: number;
  marginUsed?: number | null;
  unrealizedPnl?: number | null;
  assets?: AccountAsset[];
}
export interface AccountTrade {
  id: string;
  venue: KeyVenue;
  symbol: string;
  side: 'buy' | 'sell';
  dir: string | null;
  role: 'taker' | 'maker' | null;
  price: number;
  qty: number;
  notionalUsd: number;
  feeUsd: number | null;
  realizedPnlUsd: number | null;
  at: number;
}
export interface AccountFunding {
  id: string;
  venue: KeyVenue;
  symbol: string;
  side: 'long' | 'short' | null;
  positionSize: number | null;
  rate: number | null;
  /** 正数表示净收到，负数表示净支付。 */
  amountUsd: number;
  at: number;
}
export interface AccountPnlPoint {
  at: number;
  pnlUsd: number;
  equityUsd: number | null;
}
export interface AccountHistorySummary {
  tradeCount: number;
  volumeUsd: number;
  feeUsd: number | null;
  realizedPnlUsd: number | null;
  fundingUsd: number | null;
}
export interface AccountHistorySnapshot {
  at: number;
  trades: AccountTrade[];
  tradesTruncated: boolean;
  tradesError: string | null;
  funding: AccountFunding[];
  fundingTruncated: boolean;
  fundingError: string | null;
  pnlSeries: AccountPnlPoint[];
  pnlError: string | null;
  authRequired: boolean;
  summary: AccountHistorySummary;
}

/** 各场所的保证金币种：Lighter RH 用 USDG，不是 USDC。 */
export const COLLATERAL_ASSET: Record<KeyVenue, string> = { lighter: 'USDC', rh: 'USDG', entropy: 'USDC' };
export const ACCOUNT_HISTORY_WINDOW_MS = 30 * 86_400_000;
export const ACCOUNT_HISTORY_LIMIT = 200;

const ACCOUNT_LIMIT = 2 * 1024 * 1024;
const MAX_ENTROPY_PAGES = 3;
const ENTROPY_FILLS_PAGE = 2000;
const ENTROPY_FUNDING_PAGE = 500;
const LIGHTER_PAGE_LIMIT = 100;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function amount(value: unknown, what: string): number {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number)) throw new Error(`账户应答缺少${what}`);
  return number;
}
function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}
function positiveOrNull(value: unknown): number | null {
  const number = optionalNumber(value);
  return number !== null && number > 0 ? number : null;
}
function normalizeTs(value: unknown): number | null {
  const number = optionalNumber(value);
  if (number === null || number <= 0) return null;
  if (number < 1e12) return Math.round(number * 1000);
  if (number >= 1e14) return Math.round(number / 1000);
  return Math.round(number);
}
function leverageFromImf(value: unknown): number | null {
  const imf = positiveOrNull(value);
  if (imf === null) return null;
  const leverage = Number((100 / imf).toFixed(2));
  return leverage > 0 ? leverage : null;
}
function sumOptional(values: readonly (number | null | undefined)[]): number | null {
  if (!values.length) return 0;
  let total = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

export function parseLighterAccount(value: unknown, accountIndex: number): AccountSnapshot {
  if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.accounts) || value.accounts.length !== 1) throw new Error('账户应答格式无效');
  const account: unknown = value.accounts[0];
  if (!isRecord(account) || account.account_index !== accountIndex) throw new Error('账户应答与请求的账户不一致');
  if (!Array.isArray(account.positions)) throw new Error('账户应答缺少持仓');
  const positions: AccountPosition[] = [];
  const allocatedMargins: (number | null)[] = [];
  for (const item of account.positions as unknown[]) {
    if (!isRecord(item) || typeof item.symbol !== 'string') throw new Error('账户应答的持仓格式无效');
    const size = amount(item.position, '持仓数量');
    // 空仓条目先跳过再看方向：已平仓市场的 sign 取值没有在真实账户上核对过。
    if (size === 0) continue;
    if (item.sign !== 1 && item.sign !== -1) throw new Error('账户应答的持仓格式无效');
    const marketId = typeof item.market_id === 'number' && Number.isSafeInteger(item.market_id) && item.market_id >= 0 ? item.market_id : null;
    const marginMode = item.margin_mode === 0 ? 'cross' : item.margin_mode === 1 ? 'isolated' : null;
    positions.push({
      symbol: item.symbol.slice(0, 40),
      size: item.sign * Math.abs(size),
      valueUsd: Math.abs(amount(item.position_value, '持仓市值')),
      entryPrice: positiveOrNull(item.avg_entry_price),
      unrealizedPnl: optionalNumber(item.unrealized_pnl),
      realizedPnl: optionalNumber(item.realized_pnl),
      liquidationPrice: positiveOrNull(item.liquidation_price),
      leverage: leverageFromImf(item.initial_margin_fraction),
      marginMode,
      marketId,
    });
    const allocated = optionalNumber(item.allocated_margin);
    allocatedMargins.push(allocated !== null && allocated >= 0 ? allocated : null);
  }
  const assets: AccountAsset[] = [];
  if (Array.isArray(account.assets)) {
    for (const raw of (account.assets as unknown[]).slice(0, 200)) {
      if (!isRecord(raw)) continue;
      const symbol = typeof raw.symbol === 'string' && raw.symbol.trim()
        ? raw.symbol.trim().slice(0, 40)
        : typeof raw.asset_id === 'number' && Number.isSafeInteger(raw.asset_id) && raw.asset_id >= 0
          ? `资产 #${raw.asset_id}`
          : null;
      if (!symbol) continue;
      const balance = optionalNumber(raw.balance) ?? 0;
      const locked = optionalNumber(raw.locked_balance) ?? 0;
      if (balance === 0 && locked === 0) continue;
      assets.push({ symbol, balance, locked });
    }
  }
  const collateral = amount(account.collateral, '保证金');
  const available = amount(account.available_balance, '可用余额');
  const unrealizedPnl = sumOptional(positions.map(item => item.unrealizedPnl));
  const totalAssetValue = optionalNumber(account.total_asset_value);
  const equity = totalAssetValue !== null ? totalAssetValue : unrealizedPnl !== null ? collateral + unrealizedPnl : collateral;
  const marginUsed = positions.length === 0 ? 0 : sumOptional(allocatedMargins);
  return { collateral, available, positions, equity, marginUsed, unrealizedPnl, assets };
}

export function parseEntropyAccount(value: unknown): AccountSnapshot {
  if (!isRecord(value) || !isRecord(value.marginSummary) || !Array.isArray(value.assetPositions)) throw new Error('账户应答格式无效');
  const positions: AccountPosition[] = [];
  for (const item of value.assetPositions as unknown[]) {
    const position = isRecord(item) ? item.position : null;
    if (!isRecord(position) || typeof position.coin !== 'string') throw new Error('账户应答的持仓格式无效');
    const size = amount(position.szi, '持仓数量');
    if (size === 0) continue;
    const lev = isRecord(position.leverage) ? position.leverage : null;
    const marginMode = lev?.type === 'cross' || lev?.type === 'isolated' ? lev.type : null;
    positions.push({
      symbol: position.coin.slice(0, 40),
      size,
      valueUsd: Math.abs(amount(position.positionValue, '持仓市值')),
      entryPrice: positiveOrNull(position.entryPx),
      unrealizedPnl: optionalNumber(position.unrealizedPnl),
      realizedPnl: null,
      liquidationPrice: positiveOrNull(position.liquidationPx),
      leverage: lev ? positiveOrNull(lev.value) : null,
      marginMode,
      marketId: null,
    });
  }
  const collateral = amount(value.marginSummary.accountValue, '账户权益');
  const available = amount(value.withdrawable, '可用余额');
  const unrealizedPnl = sumOptional(positions.map(item => item.unrealizedPnl));
  const totalMarginUsed = optionalNumber(value.marginSummary.totalMarginUsed);
  const marginUsed = totalMarginUsed !== null ? totalMarginUsed : positions.length === 0 ? 0 : null;
  return { collateral, available, positions, equity: collateral, marginUsed, unrealizedPnl, assets: [] };
}

const ENTROPY_SEPARATE_MODES = new Set(['default', 'disabled']);
const ENTROPY_MAX_ASSETS = 200;

export function parseEntropyUnifiedBalance(value: unknown): { collateral: number; available: number; assets: AccountAsset[] } {
  if (!isRecord(value) || !Array.isArray(value.balances)) throw new Error('统一账户应答格式无效');
  let usdc: Record<string, unknown> | null = null;
  const others: AccountAsset[] = [];
  for (const item of value.balances as unknown[]) {
    if (!isRecord(item)) throw new Error('统一账户应答的余额格式无效');
    if (item.token === 0) {
      if (usdc !== null || item.coin !== 'USDC') throw new Error('统一账户应答格式无效');
      usdc = item;
      continue;
    }
    if (others.length >= ENTROPY_MAX_ASSETS) continue;
    const symbol = typeof item.coin === 'string' && item.coin.trim() ? item.coin.trim().slice(0, 40) : null;
    if (!symbol) continue;
    const balance = optionalNumber(item.total) ?? 0;
    const locked = optionalNumber(item.hold) ?? 0;
    if (balance === 0 && locked === 0) continue;
    others.push({ symbol, balance, locked });
  }
  if (!usdc) return { collateral: 0, available: 0, assets: others };
  const total = amount(usdc.total, '统一账户权益');
  const hold = amount(usdc.hold, '统一账户冻结余额');
  if (total < 0 || hold < 0) throw new Error('统一账户应答的余额格式无效');
  const assets: AccountAsset[] = total === 0 && hold === 0 ? others : [{ symbol: 'USDC', balance: total, locked: hold }, ...others].slice(0, ENTROPY_MAX_ASSETS);
  return { collateral: total, available: Math.max(0, total - hold), assets };
}

function parseEntropyMode(mode: unknown): 'separate' | 'unified' {
  if (typeof mode !== 'string') throw new Error('Entropy 账户模式应答格式无效');
  if (ENTROPY_SEPARATE_MODES.has(mode)) return 'separate';
  if (mode === 'unifiedAccount') return 'unified';
  if (mode === 'portfolioMargin') throw new Error('Entropy 账户处于组合保证金模式（portfolioMargin），暂不支持读取可用余额；请改用统一账户或标准模式');
  if (mode === 'dexAbstraction') throw new Error('Entropy 账户处于旧版 DEX 抽象模式（dexAbstraction），暂不支持；请在 Hyperliquid 切换为统一账户或标准模式');
  if (/^[a-zA-Z0-9_-]{1,32}$/.test(mode)) throw new Error(`暂不支持的 Entropy 账户模式（${mode}）`);
  throw new Error('Entropy 账户模式应答格式无效');
}

export function parseEntropyTrades(value: unknown, dex: string = ENTROPY_ENDPOINTS.dex): AccountTrade[] {
  if (!Array.isArray(value)) throw new Error('Entropy 成交应答格式无效');
  const prefix = `${dex}:`;
  const trades: AccountTrade[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.coin !== 'string') throw new Error('Entropy 成交格式无效');
    if (!item.coin.startsWith(prefix)) continue;
    const price = positiveOrNull(item.px), qty = positiveOrNull(item.sz), at = normalizeTs(item.time);
    const side = item.side === 'B' ? 'buy' : item.side === 'A' ? 'sell' : null;
    if (price === null || qty === null || at === null || !side) throw new Error('Entropy 成交格式无效');
    const feeToken = item.feeToken;
    const feeUsd = feeToken === undefined || feeToken === 'USDC' ? optionalNumber(item.fee) : null;
    const id = item.tid !== undefined && item.tid !== null
      ? `entropy:${String(item.tid)}`
      : typeof item.hash === 'string' && item.hash
        ? `entropy:${item.hash}:${at}:${side}:${qty}`
        : `entropy:${at}:${item.coin}:${side}:${qty}:${price}`;
    trades.push({
      id,
      venue: 'entropy',
      symbol: item.coin.slice(0, 40),
      side,
      dir: typeof item.dir === 'string' && item.dir.trim() ? item.dir.trim().slice(0, 32) : null,
      role: item.crossed === true ? 'taker' : item.crossed === false ? 'maker' : null,
      price,
      qty,
      notionalUsd: price * qty,
      feeUsd,
      realizedPnlUsd: optionalNumber(item.closedPnl),
      at,
    });
  }
  return trades;
}

export function parseEntropyFunding(value: unknown, dex: string = ENTROPY_ENDPOINTS.dex): AccountFunding[] {
  if (!Array.isArray(value)) throw new Error('Entropy 资金费应答格式无效');
  const prefix = `${dex}:`;
  const funding: AccountFunding[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.delta)) throw new Error('Entropy 资金费格式无效');
    if (item.delta.type !== 'funding') continue;
    if (typeof item.delta.coin !== 'string') throw new Error('Entropy 资金费格式无效');
    if (!item.delta.coin.startsWith(prefix)) continue;
    const at = normalizeTs(item.time), amountUsd = optionalNumber(item.delta.usdc);
    if (at === null || amountUsd === null) throw new Error('Entropy 资金费格式无效');
    const positionSize = optionalNumber(item.delta.szi);
    const side = positionSize !== null && positionSize !== 0 ? (positionSize > 0 ? 'long' : 'short') : null;
    const id = typeof item.hash === 'string' && item.hash
      ? `entropy-f:${item.hash}:${item.delta.coin}:${at}`
      : `entropy-f:${item.delta.coin}:${at}:${amountUsd}`;
    funding.push({
      id,
      venue: 'entropy',
      symbol: item.delta.coin.slice(0, 40),
      side,
      positionSize,
      rate: optionalNumber(item.delta.fundingRate),
      amountUsd,
      at,
    });
  }
  return funding;
}

export function parseLighterTrades(value: unknown, accountIndex: number, marketNames?: ReadonlyMap<number, string>, venue: 'lighter' | 'rh' = 'lighter'): { trades: AccountTrade[]; truncated: boolean } {
  if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.trades)) throw new Error('Lighter 成交应答格式无效');
  const trades: AccountTrade[] = [];
  for (const item of value.trades as unknown[]) {
    if (!isRecord(item)) throw new Error('Lighter 成交格式无效');
    const bidAccount = optionalNumber(item.bid_account_id);
    const askAccount = optionalNumber(item.ask_account_id);
    // 防御身份错配：不属于请求账户的成交直接跳过。
    if (bidAccount !== accountIndex && askAccount !== accountIndex) continue;
    const side: 'buy' | 'sell' = bidAccount === accountIndex ? 'buy' : 'sell';
    const role: 'taker' | 'maker' | null = typeof item.is_maker_ask === 'boolean'
      ? (side === 'buy' ? (item.is_maker_ask ? 'taker' : 'maker') : (item.is_maker_ask ? 'maker' : 'taker'))
      : null;
    const price = positiveOrNull(item.price);
    const qty = optionalNumber(item.size);
    const at = normalizeTs(item.timestamp ?? item.transaction_time);
    if (price === null || qty === null || qty < 0 || at === null) throw new Error('Lighter 成交格式无效');
    if (qty === 0) continue;
    const marketId = optionalNumber(item.market_id);
    const symbol = typeof item.market_symbol === 'string' && item.market_symbol.trim()
      ? item.market_symbol.trim().slice(0, 40)
      : marketId !== null && marketNames?.has(marketId)
        ? marketNames.get(marketId)!
        : marketId !== null
          ? `#${marketId}`
          : 'UNKNOWN';
    const usd = optionalNumber(item.usd_amount);
    const notionalUsd = usd !== null ? Math.abs(usd) : price * qty;
    // Lighter 标准账户常见为 0 手续费；非零字段可能是 ppm 费率而非美元，在实测核对前保守置 null（docs/live-results.md）。
    const rawFee = role === 'maker' ? optionalNumber(item.maker_fee) : role === 'taker' ? optionalNumber(item.taker_fee) : (optionalNumber(item.taker_fee) ?? optionalNumber(item.maker_fee));
    const feeUsd = rawFee === 0 ? 0 : null;
    const id = item.trade_id_str !== undefined && item.trade_id_str !== null
      ? `${venue}:${String(item.trade_id_str)}`
      : item.trade_id !== undefined && item.trade_id !== null
        ? `${venue}:${String(item.trade_id)}`
        : `${venue}:${at}:${symbol}:${side}:${qty}`;
    trades.push({
      id,
      venue,
      symbol,
      side,
      dir: null,
      role,
      price,
      qty,
      notionalUsd,
      feeUsd,
      realizedPnlUsd: null,
      at,
    });
  }
  const truncated = (typeof value.next_cursor === 'string' && value.next_cursor.length > 0) || value.trades.length >= LIGHTER_PAGE_LIMIT;
  return { trades, truncated };
}

export function parseLighterFunding(value: unknown, marketNames?: ReadonlyMap<number, string>, venue: 'lighter' | 'rh' = 'lighter'): { funding: AccountFunding[]; truncated: boolean } {
  if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.position_fundings)) throw new Error('Lighter 资金费应答格式无效');
  const funding: AccountFunding[] = [];
  for (const item of value.position_fundings as unknown[]) {
    if (!isRecord(item)) throw new Error('Lighter 资金费格式无效');
    const at = normalizeTs(item.timestamp);
    const amountUsd = optionalNumber(item.change ?? item.payment);
    if (at === null || amountUsd === null) throw new Error('Lighter 资金费格式无效');
    const marketId = optionalNumber(item.market_id);
    const symbol = typeof item.market_symbol === 'string' && item.market_symbol.trim()
      ? item.market_symbol.trim().slice(0, 40)
      : marketId !== null && marketNames?.has(marketId)
        ? marketNames.get(marketId)!
        : marketId !== null
          ? `#${marketId}`
          : 'UNKNOWN';
    const rawSide = typeof item.position_side === 'string' ? item.position_side : typeof item.side === 'string' ? item.side : null;
    const side = rawSide === 'long' ? 'long' : rawSide === 'short' ? 'short' : null;
    const positionSize = optionalNumber(item.position_size ?? item.size);
    const rate = optionalNumber(item.rate ?? item.funding_rate);
    const id = item.funding_id !== undefined && item.funding_id !== null
      ? `${venue}-f:${String(item.funding_id)}`
      : `${venue}-f:${symbol}:${at}:${amountUsd}`;
    funding.push({ id, venue, symbol, side, positionSize, rate, amountUsd, at });
  }
  const truncated = (typeof value.next_cursor === 'string' && value.next_cursor.length > 0) || value.position_fundings.length >= LIGHTER_PAGE_LIMIT;
  return { funding, truncated };
}

export function parseLighterPnl(value: unknown): AccountPnlPoint[] {
  if (!isRecord(value) || value.code !== 200 || !Array.isArray(value.pnl)) throw new Error('Lighter 盈亏应答格式无效');
  const byTime = new Map<number, AccountPnlPoint>();
  for (const item of value.pnl as unknown[]) {
    if (!isRecord(item)) throw new Error('Lighter 盈亏格式无效');
    const at = normalizeTs(item.timestamp);
    const pnlUsd = optionalNumber(item.trade_pnl);
    if (at === null || pnlUsd === null) throw new Error('Lighter 盈亏格式无效');
    byTime.set(at, { at, pnlUsd, equityUsd: null });
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

export async function fetchAccount(fetchImpl: FetchLike, signal: AbortSignal, venue: KeyVenue, accounts: DexAccounts): Promise<AccountSnapshot> {
  if (venue === 'entropy') {
    const account = accounts.entropy;
    if (!account) throw new Error('没有配置账户');
    // 账户地址放在请求体里，不进地址栏。
    const [state, mode] = await Promise.all([
      readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, ACCOUNT_LIMIT, {}, { type: 'clearinghouseState', user: account.address, dex: ENTROPY_ENDPOINTS.dex }),
      readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, ACCOUNT_LIMIT, {}, { type: 'userAbstraction', user: account.address }),
    ]);
    const base = parseEntropyAccount(state);
    if (parseEntropyMode(mode) === 'separate') return base;
    const spot = await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signal, ACCOUNT_LIMIT, {}, { type: 'spotClearinghouseState', user: account.address });
    const unified = parseEntropyUnifiedBalance(spot);
    return {
      ...base,
      collateral: unified.collateral,
      equity: unified.collateral,
      available: unified.available,
      assets: unified.assets,
    };
  }
  const account = accounts[venue];
  if (!account) throw new Error('没有配置账户');
  return parseLighterAccount(await readJson(fetchImpl, `${LIGHTER_ENDPOINTS[venue].rest}/account?by=index&value=${account.accountIndex}`, signal, ACCOUNT_LIMIT, {}), account.accountIndex);
}

const cleanError = (error: unknown): string => scrub(error instanceof Error ? error.message : String(error));
const emptySummary = (): AccountHistorySummary => ({ tradeCount: 0, volumeUsd: 0, feeUsd: 0, realizedPnlUsd: null, fundingUsd: 0 });

function summarizeHistory(venue: KeyVenue, trades: readonly AccountTrade[], funding: readonly AccountFunding[], tradesError: string | null, fundingError: string | null): AccountHistorySummary {
  const tradeCount = tradesError ? 0 : trades.length;
  const volumeUsd = tradesError ? 0 : trades.reduce((sum, item) => sum + item.notionalUsd, 0);
  const feeUsd = tradesError ? null : sumOptional(trades.map(item => item.feeUsd));
  const realizedPnlUsd = tradesError || venue !== 'entropy' ? null : sumOptional(trades.map(item => item.realizedPnlUsd));
  const fundingUsd = fundingError ? null : funding.reduce((sum, item) => sum + item.amountUsd, 0);
  return { tradeCount, volumeUsd, feeUsd, realizedPnlUsd, fundingUsd };
}

function buildEntropyPnlSeries(trades: readonly AccountTrade[], funding: readonly AccountFunding[]): AccountPnlPoint[] {
  const deltas: { at: number; delta: number }[] = [];
  for (const trade of trades) {
    if (trade.realizedPnlUsd === null && trade.feeUsd === null) continue;
    deltas.push({ at: trade.at, delta: (trade.realizedPnlUsd ?? 0) - (trade.feeUsd ?? 0) });
  }
  for (const item of funding) deltas.push({ at: item.at, delta: item.amountUsd });
  if (!deltas.length) return [];
  deltas.sort((a, b) => a.at - b.at);
  let cumulative = 0;
  const points: AccountPnlPoint[] = [];
  for (const item of deltas) {
    cumulative += item.delta;
    const prev = points.at(-1);
    if (prev && prev.at === item.at) prev.pnlUsd = cumulative;
    else points.push({ at: item.at, pnlUsd: cumulative, equityUsd: null });
  }
  return points;
}

async function readLighterAuthed(
  fetchImpl: FetchLike,
  url: string,
  signalFor: () => AbortSignal,
  authToken: (forceRefresh?: boolean) => Promise<string | null>,
): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await authToken(attempt > 0);
    if (!token) throw new Error('AUTH_REQUIRED');
    try {
      return await readJson(fetchImpl, url, signalFor(), ACCOUNT_LIMIT, { authorization: token });
    } catch (error) {
      if (attempt === 0 && error instanceof Error && (error.message === 'HTTP 401' || error.message === 'HTTP 403')) continue;
      throw error;
    }
  }
  throw new Error('HTTP 401');
}

export interface FetchHistoryOptions {
  fetchImpl: FetchLike;
  signalFor: () => AbortSignal;
  venue: KeyVenue;
  accounts: DexAccounts;
  now: number;
  marketNames?: ReadonlyMap<number, string>;
  authToken?: (forceRefresh?: boolean) => Promise<string | null>;
}

function maxRawTs(list: readonly unknown[]): number | null {
  let maxTime: number | null = null;
  for (const item of list) {
    const ts = isRecord(item) ? normalizeTs(item.time) : null;
    if (ts !== null && (maxTime === null || ts > maxTime)) maxTime = ts;
  }
  return maxTime;
}

export async function fetchAccountHistory({ fetchImpl, signalFor, venue, accounts, now, marketNames, authToken }: FetchHistoryOptions): Promise<AccountHistorySnapshot> {
  const cutoff = now - ACCOUNT_HISTORY_WINDOW_MS;
  if (venue === 'entropy') {
    const account = accounts.entropy;
    if (!account) throw new Error('没有配置账户');
    const fetchFills = async (): Promise<{ trades: AccountTrade[]; truncated: boolean }> => {
      const byId = new Map<string, AccountTrade>();
      let cursorStart = cutoff, truncated = false;
      for (let page = 0; page < MAX_ENTROPY_PAGES; page++) {
        const raw = await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), ACCOUNT_LIMIT, {}, { type: 'userFillsByTime', user: account.address, startTime: cursorStart, endTime: now });
        const parsed = parseEntropyTrades(raw);
        for (const item of parsed) if (item.at >= cutoff && item.at <= now + 60_000) byId.set(item.id, item);
        const list = raw as unknown[];
        if (list.length < ENTROPY_FILLS_PAGE) break;
        const maxTime = maxRawTs(list);
        if (page === MAX_ENTROPY_PAGES - 1 || maxTime === null || maxTime <= cursorStart) { truncated = true; break; }
        cursorStart = maxTime;
      }
      return { trades: [...byId.values()].sort((a, b) => b.at - a.at), truncated };
    };
    const fetchFunding = async (): Promise<{ funding: AccountFunding[]; truncated: boolean }> => {
      const byId = new Map<string, AccountFunding>();
      let cursorStart = cutoff, truncated = false;
      for (let page = 0; page < MAX_ENTROPY_PAGES; page++) {
        const raw = await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), ACCOUNT_LIMIT, {}, { type: 'userFunding', user: account.address, startTime: cursorStart, endTime: now });
        const parsed = parseEntropyFunding(raw);
        for (const item of parsed) if (item.at >= cutoff && item.at <= now + 60_000) byId.set(item.id, item);
        const list = raw as unknown[];
        if (list.length < ENTROPY_FUNDING_PAGE) break;
        const maxTime = maxRawTs(list);
        if (page === MAX_ENTROPY_PAGES - 1 || maxTime === null || maxTime <= cursorStart) { truncated = true; break; }
        cursorStart = maxTime;
      }
      return { funding: [...byId.values()].sort((a, b) => b.at - a.at), truncated };
    };
    const [fillsRes, fundingRes] = await Promise.allSettled([fetchFills(), fetchFunding()]);
    const tradesError = fillsRes.status === 'rejected' ? cleanError(fillsRes.reason) : null;
    const fundingError = fundingRes.status === 'rejected' ? cleanError(fundingRes.reason) : null;
    const allTrades = fillsRes.status === 'fulfilled' ? fillsRes.value.trades : [];
    const allFunding = fundingRes.status === 'fulfilled' ? fundingRes.value.funding : [];
    const pnlError = tradesError ?? fundingError;
    const pnlSeries = pnlError ? [] : buildEntropyPnlSeries(allTrades, allFunding);
    return {
      at: now,
      trades: allTrades.slice(0, ACCOUNT_HISTORY_LIMIT),
      tradesTruncated: fillsRes.status === 'fulfilled' ? fillsRes.value.truncated : false,
      tradesError,
      funding: allFunding.slice(0, ACCOUNT_HISTORY_LIMIT),
      fundingTruncated: fundingRes.status === 'fulfilled' ? fundingRes.value.truncated : false,
      fundingError,
      pnlSeries,
      pnlError,
      authRequired: false,
      summary: summarizeHistory('entropy', allTrades, allFunding, tradesError, fundingError),
    };
  }

  const account = accounts[venue];
  if (!account) throw new Error('没有配置账户');
  if (!authToken) {
    const reason = '仅配置了只读账户；在「实盘准备」录入 API 凭据后可查看成交、资金费与盈亏';
    return {
      at: now, trades: [], tradesTruncated: false, tradesError: reason,
      funding: [], fundingTruncated: false, fundingError: reason,
      pnlSeries: [], pnlError: reason, authRequired: true, summary: { ...emptySummary(), feeUsd: null, fundingUsd: null },
    };
  }

  const rest = LIGHTER_ENDPOINTS[venue].rest;
  const startSec = Math.floor(cutoff / 1000), endSec = Math.floor(now / 1000);
  const [tradesRes, fundingRes, pnlRes] = await Promise.allSettled([
    readLighterAuthed(fetchImpl, `${rest}/trades?account_index=${account.accountIndex}&sort_by=timestamp&limit=${LIGHTER_PAGE_LIMIT}`, signalFor, authToken)
      .then(raw => parseLighterTrades(raw, account.accountIndex, marketNames, venue)),
    readLighterAuthed(fetchImpl, `${rest}/positionFunding?account_index=${account.accountIndex}&limit=${LIGHTER_PAGE_LIMIT}`, signalFor, authToken)
      .then(raw => parseLighterFunding(raw, marketNames, venue)),
    readLighterAuthed(fetchImpl, `${rest}/pnl?by=index&value=${account.accountIndex}&resolution=1d&start_timestamp=${startSec}&end_timestamp=${endSec}&count_back=30&ignore_transfers=false`, signalFor, authToken)
      .then(parseLighterPnl),
  ]);

  const isAuthErr = (res: PromiseSettledResult<unknown>) => res.status === 'rejected' && res.reason instanceof Error && res.reason.message === 'AUTH_REQUIRED';
  const authRequired = isAuthErr(tradesRes) || isAuthErr(fundingRes) || isAuthErr(pnlRes);
  const msgOf = (res: PromiseSettledResult<unknown>) => res.status === 'fulfilled' ? null : (res.reason instanceof Error && res.reason.message === 'AUTH_REQUIRED' ? '仅配置了只读账户；在「实盘准备」录入 API 凭据后可查看成交、资金费与盈亏' : cleanError(res.reason));

  const tradesError = msgOf(tradesRes);
  const fundingError = msgOf(fundingRes);
  const pnlError = msgOf(pnlRes);

  const rawTrades = tradesRes.status === 'fulfilled' ? tradesRes.value.trades : [];
  const windowTrades = rawTrades.filter(item => item.at >= cutoff).sort((a, b) => b.at - a.at);
  const tradesTruncated = tradesRes.status === 'fulfilled' && tradesRes.value.truncated && rawTrades.every(item => item.at >= cutoff);

  const rawFunding = fundingRes.status === 'fulfilled' ? fundingRes.value.funding : [];
  const windowFunding = rawFunding.filter(item => item.at >= cutoff).sort((a, b) => b.at - a.at);
  const fundingTruncated = fundingRes.status === 'fulfilled' && fundingRes.value.truncated && rawFunding.every(item => item.at >= cutoff);

  const pnlSeries = pnlRes.status === 'fulfilled' ? pnlRes.value : [];
  return {
    at: now,
    trades: windowTrades.slice(0, ACCOUNT_HISTORY_LIMIT),
    tradesTruncated,
    tradesError,
    funding: windowFunding.slice(0, ACCOUNT_HISTORY_LIMIT),
    fundingTruncated,
    fundingError,
    pnlSeries,
    pnlError,
    authRequired,
    summary: summarizeHistory(venue, windowTrades, windowFunding, tradesError, fundingError),
  };
}
