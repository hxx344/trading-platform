// Copied from project_aggregation modules/asset/lib/okx.ts at 0014655.
// The ledger and scan directory share signing, the fixed host and the read-only permission check.
import { okxAuthHeaders } from '../../vendor/okx.mjs';
import { readJsonResponse } from '../../vendor/response.mjs';
import type { Balance } from '../types.ts';
import { PositionsPermissionError } from '../positions-values.ts';
import { isGateBaseSymbol } from '../../chain-arb/model.ts';
import { OKX_DIRECTORY_TTL } from '../../chain-arb/okx-network.ts';

export type OkxCredential = { apiKey: string; apiSecret: string; passphrase: string };
type Json = Record<string, unknown>;
type Fetcher = typeof fetch;

const CONFIG_PATH = '/api/v5/account/config';
const VALUATION_PATH = '/api/v5/asset/asset-valuation';
const CURRENCIES_PATH = '/api/v5/asset/currencies';
const DEPOSIT_ADDRESS_PATH = '/api/v5/asset/deposit-address';
const AUTH_DENIED = new Set(['50100', '50101', '50105', '50110', '50111', '50113', '50114', '50119', '50120', '50121']);
export function okxAccessDenied(status: number, code?: unknown) {
  return status === 401 || status === 403 || (typeof code === 'string' && AUTH_DENIED.has(code));
}

export class OkxReadThrottle extends Error {}
const READ_PATHS = new Set([CONFIG_PATH, VALUATION_PATH]);
const ACCOUNT_NAMES = {
  funding: '资金账户（USD 估值）',
  trading: '交易账户（USD 估值）',
  earn: '赚币账户（USD 估值）',
  classic: '经典账户（USD 估值）',
} as const;
const INCOMPLETE = 'OKX 返回的账户数据不完整；已保留上次数据';
const MAX_BODY_BYTES = 2_000_000;
const READ_FAILED = 'OKX 读取失败，请检查网络、API 权限、IP 白名单及服务器时间；已保留上次数据';

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usdValue(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('OKX 美元估值不是有效数值；已保留上次数据');
  const result = Number(value);
  if (!Number.isFinite(result) || (result === 0 && /[1-9]/.test(value))) throw new Error('OKX 美元估值不是有效数值；已保留上次数据');
  return result === 0 ? 0 : result;
}

function singleAccount(data: unknown[]): Json {
  if (data.length !== 1 || !isObject(data[0])) throw new Error(INCOMPLETE);
  return data[0];
}

type ScanRead = { signal: AbortSignal; now: () => number; deniedAt: number; requireDate?: boolean };
async function requestOkx(c: OkxCredential, requestPath: string, fetcher: Fetcher, scan?: ScanRead) {
  if ([c?.apiKey, c?.apiSecret, c?.passphrase].some(value => typeof value !== 'string' || !value.trim())) throw new Error('OKX API Key、Secret 与 Passphrase 不能为空');
  const now = scan?.now ?? Date.now, start = now();
  const signal = scan?.signal ?? AbortSignal.timeout(12000);
  let response: Response;
  try {
    signal.throwIfAborted();
    response = await fetcher('https://openapi.okx.com' + requestPath, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', ...okxAuthHeaders(c, { timestamp: new Date(start).toISOString(), method: 'GET', requestPath }) },
      redirect: 'manual',
      cache: 'no-store', signal,
    });
  } catch {
    // Transport errors can contain authenticated request details; never relay them.
    throw new Error(READ_FAILED);
  }
  if (response.redirected || (response.status !== 200 && response.status !== 400) || (scan && response.headers.has('content-range'))) {
    void response.body?.cancel().catch(() => {});
    const message = `OKX 读取失败（HTTP ${response.status}），请检查网络、API 权限及服务器时间；已保留上次数据`;
    if (!response.redirected && okxAccessDenied(response.status)) throw new PositionsPermissionError(message);
    if (!response.redirected && response.status === 429) throw new OkxReadThrottle(message);
    throw new Error(message);
  }
  let data: unknown;
  try { data = await readJsonResponse(response, { maxBytes: MAX_BODY_BYTES, signal }); }
  catch { throw new Error(READ_FAILED); }
  if (!isObject(data)) throw new Error(INCOMPLETE);
  if (data.code !== '0') {
    const code = typeof data.code === 'string' && /^\d{1,10}$/.test(data.code) ? data.code : '未知代码';
    const message = `OKX 读取失败（${code}），请检查 API 权限、IP 白名单及服务器时间；已保留上次数据`;
    if (okxAccessDenied(response.status, code)) throw new PositionsPermissionError(message);
    if (code === '50011') throw new OkxReadThrottle(message);
    throw new Error(message);
  }
  if (response.status !== 200) throw new Error(READ_FAILED);
  let at = start;
  if (scan) {
    const age = response.headers.get('age') ?? '0', date = response.headers.get('date');
    const dateAt = date === null ? start : Date.parse(date);
    at = Math.min(start - Number(age) * 1000, dateAt);
    // Age is expressed in whole seconds. Even Age: 0 can describe a response from just before a denial.
    const earliest = Math.min(dateAt, start - Number(age) * 1000 - (response.headers.has('age') ? 999 : 0));
    if (scan.requireDate) at = earliest;
    if ((scan.requireDate && date === null) || !/^\d+$/.test(age) || !Number.isSafeInteger(at) || at <= 0
      || (scan.deniedAt > 0 && earliest <= scan.deniedAt) || now() < start || dateAt > now() + 2000 || now() - at >= OKX_DIRECTORY_TTL) {
      throw new Error(READ_FAILED);
    }
  }
  if (!Array.isArray(data.data)) throw new Error(INCOMPLETE);
  return { rows: data.data as unknown[], at };
}

export async function okxGet(c: OkxCredential, path: string, fetcher: Fetcher = fetch): Promise<unknown[]> {
  if (!READ_PATHS.has(path)) throw new Error('仅支持 OKX 只读账户接口');
  return (await requestOkx(c, path + (path === VALUATION_PATH ? '?ccy=USD' : ''), fetcher)).rows;
}

function assertReadOnly(config: unknown[]) {
  if (config.length !== 1 || !isObject(config[0])) throw new PositionsPermissionError(INCOMPLETE);
  if (config[0].perm !== 'read_only') throw new PositionsPermissionError('此 OKX API 无法确认只读权限，请使用仅启用读取的 API');
}

export async function readOkxCurrencies(c: OkxCredential, fetcher: Fetcher, scan: ScanRead, checkConnection: () => void) {
  const config = await requestOkx(c, CONFIG_PATH, fetcher, scan);
  checkConnection();
  if (scan.now() - config.at >= OKX_DIRECTORY_TTL) throw new Error(READ_FAILED);
  assertReadOnly(config.rows);
  const currencies = await requestOkx(c, CURRENCIES_PATH, fetcher, scan);
  return { rows: currencies.rows, at: Math.min(config.at, currencies.at) };
}

export async function readOkxDepositAddresses(c: OkxCredential, symbol: string, fetcher: Fetcher, scan: ScanRead) {
  if (!isGateBaseSymbol(symbol)) throw new Error(READ_FAILED);
  return requestOkx(c, DEPOSIT_ADDRESS_PATH + '?ccy=' + encodeURIComponent(symbol), fetcher, { ...scan, requireDate: true });
}

export async function syncOkx(c: OkxCredential, fetcher: Fetcher = fetch): Promise<{ total: number; details: Balance[]; updatedAt: string }> {
  assertReadOnly(await okxGet(c, CONFIG_PATH, fetcher));
  const valuation = singleAccount(await okxGet(c, VALUATION_PATH, fetcher));
  const total = usdValue(valuation.totalBal);
  if (typeof valuation.ts !== 'string' || !/^\d{1,16}$/.test(valuation.ts)) throw new Error('OKX 估值时间无效或已过期；已保留上次数据');
  const timestamp = Number(valuation.ts);
  const now = Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || now - timestamp > 900000 || timestamp - now > 60000) throw new Error('OKX 估值时间无效或已过期；已保留上次数据');
  if (!isObject(valuation.details)) throw new Error(INCOMPLETE);
  const accounts = valuation.details;
  if (Object.keys(accounts).some(key => !Object.hasOwn(ACCOUNT_NAMES, key))) throw new Error('OKX 返回未知账户分项，无法确认估值结构；已保留上次数据');
  const details: Balance[] = [];
  for (const key of Object.keys(ACCOUNT_NAMES) as (keyof typeof ACCOUNT_NAMES)[]) {
    // OKX deprecated classic; the other documented account categories must exist.
    if (key === 'classic' && !Object.hasOwn(accounts, key)) continue;
    const value = usdValue(accounts[key]);
    details.push({ coin: 'USD', account: ACCOUNT_NAMES[key], quantity: value, price: 1, value });
  }
  // totalBal is the sole total. Account valuations are display-only and may round differently.
  return { total, details, updatedAt: new Date(timestamp).toISOString() };
}
