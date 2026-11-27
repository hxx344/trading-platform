// Single-account read-only readers for Lighter mainnet and Lighter RH (`GET /api/v1/account?by=index&value=<id>`),
// used by the asset ledger's DEX spread aggregation. Follows src/asset/sources/rh-lighter.ts and hyperliquid.ts for
// bounds, timeouts, 60 s cooldowns, USDC/USD pricing and error sanitization (no indices or addresses in errors/details).
import type { Balance, QuoteEvidence } from '../types.ts';
import { COINGECKO_QUOTES } from './quotes.ts';
import { priceReceivedAt } from './shared-reads.ts';
import { RH_LIGHTER_COOLDOWN_MS, RH_LIGHTER_ERRORS, rhLighterCooldown } from './rh-lighter.ts';
import { ExchangeResponseError, readJsonResponse } from '../../vendor/response.mjs';

type Json = Record<string, unknown>;
type Fetcher = typeof fetch;
type Venue = 'lighter' | 'rh';

export interface LighterIndexRead {
  accountIndex: number;
  l1Address: string;
  total: number;
  details: Balance[];
  updatedAt: string;
  quote?: QuoteEvidence;
}

const LIGHTER_ACCOUNT_MAX = 2 ** 48 - 2;
const ENDPOINTS: Record<Venue, string> = {
  lighter: 'https://mainnet.zklighter.elliot.ai/api/v1/account',
  rh: 'https://api.rh.lighter.xyz/api/v1/account',
};
const TIMEOUT_MS = 10_000;
const QUOTE_TIMEOUT_MS = 12_000;
const MAX_BYTES = 2 * 1024 * 1024;
const QUOTE_MAX_BYTES = 128 * 1024;
const MAX_ROWS = 2000;
const QUOTE_MAX_AGE_MS = 900_000;
const FUTURE_TOLERANCE_MS = 60_000;
const COOLDOWN_MS = RH_LIGHTER_COOLDOWN_MS;
const RATE_LIMIT_CODE = 23000;
const ACCOUNT_NOT_FOUND_CODE = 21100;
const DECIMAL = /^-?\d+(?:\.\d+)?$/;
const SYMBOL = /^[\p{L}\p{N}_.:/-]{1,32}$/u;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const COINBASE_USDC = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
export const NOTE_COIN = '—';

export const LIGHTER_MAINNET_ERRORS = {
  index: 'Lighter 主网 账户编号无效',
  missing: 'Lighter 主网 未找到该编号的账户：请确认填写的账户编号正确',
  network: 'Lighter 主网 读取失败：网络请求未完成或超时，请稍后重试；已保留上次数据',
  rateLimited: 'Lighter 主网 读取受到限流：60 秒内不再请求，请减少手动刷新；已保留上次数据',
  invalid: 'Lighter 主网 返回的账户数据不完整或格式不符；已保留上次数据',
  quote: 'Lighter 主网 USDC/USD 汇率读取失败或已过期；已保留上次数据',
} as const;

export const RH_LIGHTER_ACCOUNT_ERRORS = {
  index: 'Lighter RH 账户编号无效',
  missing: 'Lighter RH 未找到该编号的账户：请确认填写的账户编号正确',
  network: RH_LIGHTER_ERRORS.network,
  rateLimited: RH_LIGHTER_ERRORS.rateLimited,
  invalid: RH_LIGHTER_ERRORS.invalid,
} as const;

const VENUE_ERRORS = {
  lighter: {
    ...LIGHTER_MAINNET_ERRORS,
    httpPattern: /^Lighter 主网 读取失败（HTTP \d{3}）/,
    http: (status: number) => `Lighter 主网 读取失败（HTTP ${status}）：接口暂时不可用，请稍后重试；已保留上次数据`,
  },
  rh: {
    ...RH_LIGHTER_ACCOUNT_ERRORS,
    httpPattern: /^Lighter RH 读取失败（HTTP \d{3}）/,
    http: (status: number) => `Lighter RH 读取失败（HTTP ${status}）：接口暂时不可用，请稍后重试；已保留上次数据`,
  },
} as const;

const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function validAccountIndex(accountIndex: number, message: string): number {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > LIGHTER_ACCOUNT_MAX) throw new Error(message);
  return accountIndex;
}

function amount(value: unknown, invalidMsg: string): number {
  if (typeof value !== 'string' || value.length > 64 || !DECIMAL.test(value)) throw new Error(invalidMsg);
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value))) throw new Error(invalidMsg);
  return result === 0 ? 0 : result;
}

function rows(value: unknown, optional: boolean, invalidMsg: string): unknown[] {
  if (optional && value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ROWS) throw new Error(invalidMsg);
  return value;
}

const mainnetCooldowns = new WeakMap<Fetcher, { until: number }>();
function cooldownFor(venue: Venue, fetcher: Fetcher) {
  if (venue === 'rh') return rhLighterCooldown(fetcher);
  let slot = mainnetCooldowns.get(fetcher);
  if (!slot) { slot = { until: 0 }; mainnetCooldowns.set(fetcher, slot); }
  return {
    blocked: (now = Date.now()) => now < slot.until && slot.until - now <= COOLDOWN_MS,
    trigger: (now = Date.now()) => { slot.until = Math.max(slot.until, now + COOLDOWN_MS); },
  };
}

async function boundedJson(response: Response, limit: number, invalidMsg: string): Promise<unknown> {
  try { return await readJsonResponse(response, { maxBytes: limit }); }
  catch (error) {
    if (error instanceof ExchangeResponseError) throw new Error(invalidMsg);
    throw error;
  }
}

async function requestAccount(venue: Venue, accountIndex: number, fetcher: Fetcher): Promise<{ l1Address: string; totalAssetValue: number; assets: { symbol: string; balance: number; locked: number }[]; pooled: boolean; binary: boolean; at: number }> {
  const errors = VENUE_ERRORS[venue];
  validAccountIndex(accountIndex, errors.index);
  const cooldown = cooldownFor(venue, fetcher);
  const now = Date.now();
  if (cooldown.blocked(now)) throw new Error(errors.rateLimited);
  const safeMessages = new Set<string>(Object.values(errors).filter((item): item is string => typeof item === 'string'));
  const params = new URLSearchParams({ by: 'index', value: String(accountIndex), active_only: 'true' });
  const url = `${ENDPOINTS[venue]}?${params}`;
  const startedAt = Date.now();
  let data: unknown;
  try {
    const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 429 || response.status === 405) { void response.body?.cancel().catch(() => {}); cooldown.trigger(); throw new Error(errors.rateLimited); }
    if (response.redirected || (!response.ok && response.status !== 400)) { void response.body?.cancel().catch(() => {}); throw new Error(errors.http(response.status)); }
    data = await boundedJson(response, MAX_BYTES, errors.invalid).catch(error => {
      if (response.status === 400 && error instanceof Error && error.message === errors.invalid) throw new Error(errors.http(400));
      throw error;
    });
    if (object(data) && data.code === RATE_LIMIT_CODE) { cooldown.trigger(); throw new Error(errors.rateLimited); }
    if (response.status === 400) throw new Error(object(data) && data.code === ACCOUNT_NOT_FOUND_CODE ? errors.missing : errors.http(400));
  } catch (error) {
    if (error instanceof Error && (safeMessages.has(error.message) || errors.httpPattern.test(error.message))) throw error;
    throw new Error(errors.network);
  }
  if (!object(data) || data.code !== 200 || (data.total !== undefined && data.total !== 1) || !Array.isArray(data.accounts) || data.accounts.length !== 1) {
    throw new Error(errors.invalid);
  }
  const item = data.accounts[0];
  if (!object(item)) throw new Error(errors.invalid);
  const hasIndex = item.index !== undefined, hasAccountIndex = item.account_index !== undefined;
  if (!hasIndex && !hasAccountIndex) throw new Error(errors.invalid);
  if ((hasIndex && item.index !== accountIndex) || (hasAccountIndex && item.account_index !== accountIndex)) throw new Error(errors.invalid);
  if (typeof item.l1_address !== 'string' || !ADDRESS.test(item.l1_address.trim())) throw new Error(errors.invalid);
  const l1Address = item.l1_address.trim().toLowerCase();
  const totalAssetValue = amount(item.total_asset_value, errors.invalid);
  const assets = rows(item.assets, true, errors.invalid).map(asset => {
    if (!object(asset)) throw new Error(errors.invalid);
    const symbol = typeof asset.symbol === 'string' && SYMBOL.test(asset.symbol) ? asset.symbol
      : integer(asset.asset_id) ? `资产 #${asset.asset_id}` : (() => { throw new Error(errors.invalid); })();
    return { symbol, balance: amount(asset.balance, errors.invalid), locked: amount(asset.locked_balance, errors.invalid) };
  });
  const pooled = rows(item.shares, true, errors.invalid).length > 0;
  const binary = rows(item.bo_positions, true, errors.invalid).length > 0;
  return { l1Address, totalAssetValue, assets, pooled, binary, at: startedAt };
}

async function quoteJson(url: string, fetcher: Fetcher): Promise<{ data: Json; at: number }> {
  const response = await fetcher(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) });
  if (!response.ok || response.redirected) { void response.body?.cancel().catch(() => {}); throw new Error(LIGHTER_MAINNET_ERRORS.quote); }
  const data = await boundedJson(response, QUOTE_MAX_BYTES, LIGHTER_MAINNET_ERRORS.quote);
  if (!object(data)) throw new Error(LIGHTER_MAINNET_ERRORS.quote);
  return { data, at: priceReceivedAt(response) };
}

async function usdcQuote(fetcher: Fetcher): Promise<{ price: number; at: number; receivedAt: number; source: string }> {
  try {
    const { data, at: receivedAt } = await quoteJson(COINGECKO_QUOTES, fetcher);
    const coin = data['usd-coin'];
    if (!object(coin) || typeof coin.usd !== 'number' || !Number.isFinite(coin.usd) || coin.usd <= 0 || typeof coin.last_updated_at !== 'number') throw new Error(LIGHTER_MAINNET_ERRORS.quote);
    const at = coin.last_updated_at * 1000;
    if (!Number.isSafeInteger(at) || at <= 0 || Date.now() - at > QUOTE_MAX_AGE_MS || at - Date.now() > FUTURE_TOLERANCE_MS) throw new Error(LIGHTER_MAINNET_ERRORS.quote);
    return { price: coin.usd, at, receivedAt, source: 'CoinGecko / USD' };
  } catch {
    try {
      const { data, at } = await quoteJson(COINBASE_USDC, fetcher);
      if (!object(data.data) || data.data.currency !== 'USDC' || !object(data.data.rates)) throw new Error(LIGHTER_MAINNET_ERRORS.quote);
      const price = amount(data.data.rates.USD, LIGHTER_MAINNET_ERRORS.quote);
      if (price <= 0) throw new Error(LIGHTER_MAINNET_ERRORS.quote);
      return { price, at, receivedAt: at, source: 'Coinbase / USD（获取时间）' };
    } catch { throw new Error(LIGHTER_MAINNET_ERRORS.quote); }
  }
}

function buildDetails(collateral: string, rawTotal: number, usdPrice: number, usdTotal: number, assets: { symbol: string; balance: number; locked: number }[], pooled: boolean, binary: boolean): Balance[] {
  const details: Balance[] = [
    { coin: collateral, account: '账户总值（含未实现盈亏）', quantity: rawTotal, price: usdPrice, value: usdTotal },
  ];
  for (const asset of assets) {
    if (asset.balance !== 0) details.push({ coin: asset.symbol, account: '现货余额（未计入总额）', quantity: asset.balance, price: 0, value: 0 });
    if (asset.locked !== 0) details.push({ coin: asset.symbol, account: '现货挂单锁定（未计入总额）', quantity: asset.locked, price: 0, value: 0 });
  }
  const note = (account: string): Balance => ({ coin: NOTE_COIN, account, quantity: 0, price: 0, value: 0 });
  if (pooled) details.push(note('持有公共池份额，未计入总额'));
  if (binary) details.push(note('持有二元期权仓位，未单独列出'));
  return details;
}

/** Reads a single Lighter RH account by index (USDG 1:1 USD); shares rate-limit cooldown with rh-lighter.ts. */
export async function syncRhLighterAccount(accountIndex: number, fetcher: Fetcher = fetch): Promise<LighterIndexRead> {
  const parsed = await requestAccount('rh', accountIndex, fetcher);
  const total = parsed.totalAssetValue === 0 ? 0 : parsed.totalAssetValue;
  return {
    accountIndex,
    l1Address: parsed.l1Address,
    total,
    details: buildDetails('USDG', parsed.totalAssetValue, 1, total, parsed.assets, parsed.pooled, parsed.binary),
    updatedAt: new Date(parsed.at).toISOString(),
  };
}

/** Reads a single Lighter mainnet account by index and converts USDC using the shared USDC/USD quote. */
export async function syncLighterAccount(accountIndex: number, fetcher: Fetcher = fetch): Promise<LighterIndexRead> {
  const parsed = await requestAccount('lighter', accountIndex, fetcher);
  const quote = await usdcQuote(fetcher);
  const rawUsd = parsed.totalAssetValue * quote.price;
  if (!Number.isFinite(rawUsd) || (rawUsd === 0 && parsed.totalAssetValue !== 0)) throw new Error(LIGHTER_MAINNET_ERRORS.invalid);
  const total = rawUsd === 0 ? 0 : rawUsd;
  return {
    accountIndex,
    l1Address: parsed.l1Address,
    total,
    details: buildDetails('USDC', parsed.totalAssetValue, quote.price, total, parsed.assets, parsed.pooled, parsed.binary),
    updatedAt: new Date(Math.min(parsed.at, quote.at)).toISOString(),
    quote: {
      coin: 'USDC',
      usd: quote.price,
      source: quote.source,
      at: new Date(quote.at).toISOString(),
      receivedAt: new Date(quote.receivedAt).toISOString(),
    },
  };
}
