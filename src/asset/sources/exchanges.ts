// Copied from project_aggregation modules/asset/lib/exchanges.ts (Bybit and Binance readers) at 0014655.
// Changes: split out of exchanges.ts (Aster lives in ./aster.ts, readJson in ./http.ts, quotes in ./quotes.ts);
// signing imports point at src/vendor. Logic, hosts, read-only path allowlists and messages are unchanged.
import type { Balance } from '../types.ts';
import { binanceSignedQuery } from '../../vendor/binance.mjs';
import { bybitAuthHeaders } from '../../vendor/bybit.mjs';
import { finite, readJson, type Fetcher, type Json } from './http.ts';
import { usdPrice, type Quote } from './quotes.ts';

export type BybitCredential = { apiKey: string; apiSecret: string; region: 'global' | 'nl' | 'tr' | 'kz' | 'ge' | 'ae' | 'eu' };
const BYBIT_HOSTS = { global:'https://api.bybit.com', nl:'https://api.bybit.nl', tr:'https://api.bybit-tr.com', kz:'https://api.bybit.kz', ge:'https://api.bybitgeorgia.ge', ae:'https://api.bybit.ae', eu:'https://api.bybit.eu' };
const BYBIT_READ_PATHS = new Set(['/v5/user/query-api','/v5/account/wallet-balance','/v5/asset/transfer/query-account-coins-balance']);
export async function bybitGet(c: BybitCredential, path: string, query: string, fetcher: Fetcher = fetch): Promise<Json> {
  if (!BYBIT_READ_PATHS.has(path) || !BYBIT_HOSTS[c.region]) throw new Error('仅支持只读账户接口');
  const headers = bybitAuthHeaders(c, { timestamp: String(Date.now()), recvWindow: '10000', payload: query });
  const data = await readJson(BYBIT_HOSTS[c.region]+path+(query?'?'+query:''), { method:'GET', headers }, fetcher);
  if (data.retCode !== 0) throw new Error(`Bybit 读取失败（${Number(data.retCode) || '未知代码'}），请检查权限、IP 白名单及地区`);
  return data.result;
}
export async function syncBybit(c: BybitCredential, prices: Record<string,Quote>, fetcher: Fetcher = fetch): Promise<{total:number;details:Balance[]}> {
  const info = await bybitGet(c, '/v5/user/query-api', '', fetcher);
  if (Number(info.readOnly) !== 1) throw new Error('此 Bybit API 不是只读密钥，请重新创建只读 API');
  const [wallet, funding] = await Promise.all([
    bybitGet(c,'/v5/account/wallet-balance','accountType=UNIFIED',fetcher),
    bybitGet(c,'/v5/asset/transfer/query-account-coins-balance','accountType=FUND',fetcher),
  ]);
  const unified = wallet.list?.find((x: Json)=>x.accountType==='UNIFIED');
  if (!unified || !Array.isArray(unified.coin) || !Array.isArray(funding.balance)) throw new Error('Bybit 返回的账户数据不完整');
  const totalUnified = finite(unified.totalEquity, 'Bybit 统一账户权益');
  const details: Balance[] = unified.coin.map((c: Json)=>{
    const quantity=finite(c.equity,'币种权益'), value=finite(c.usdValue,'美元权益');
    return {coin:String(c.coin),account:'统一账户（净权益）',quantity,value,price:quantity===0?0:value/quantity};
  });
  const funds = await Promise.all(funding.balance.map(async (coin:Json)=>{
    const quantity = finite(coin.walletBalance,'资金账户余额');
    const price = quantity===0 ? 0 : await usdPrice(String(coin.coin),prices,fetcher);
    return {coin:String(coin.coin),account:'资金账户',quantity,price,value:quantity*price};
  }));
  return {total:totalUnified+funds.reduce((s:number,a:Balance)=>s+a.value,0),details:[...details,...funds].filter(a=>a.quantity!==0||a.value!==0)};
}
export type BinanceCredential = { apiKey: string; apiSecret: string };
const BINANCE_READ_PATHS = new Set(['/sapi/v1/account/apiRestrictions', '/sapi/v1/asset/wallet/balance']);
const BINANCE_CORE_WRITE_PERMISSIONS = ['enableWithdrawals', 'enableInternalTransfer', 'enableMargin', 'enableFutures', 'permitsUniversalTransfer', 'enableVanillaOptions', 'enableSpotAndMarginTrading'];
const BINANCE_NEW_WRITE_PERMISSIONS = ['enableFixApiTrade', 'enablePortfolioMarginTrading'];
export async function binanceGet(c: BinanceCredential, path: string, fetcher: Fetcher = fetch): Promise<unknown> {
  if (!BINANCE_READ_PATHS.has(path)) throw new Error('仅支持 Binance 只读账户接口');
  if (typeof c?.apiKey !== 'string' || !c.apiKey.trim() || typeof c?.apiSecret !== 'string' || !c.apiSecret.trim()) throw new Error('Binance API Key 与 Secret 不能为空');
  const params = new URLSearchParams();
  if (path === '/sapi/v1/asset/wallet/balance') params.set('quoteAsset', 'USDT');
  // Sign the exact encoded query sent to the fixed official host; no caller-supplied parameters.
  let data: unknown;
  try {
    const { query, headers } = binanceSignedQuery(c, params, { timestamp: String(Date.now()), recvWindow: '10000' });
    data = await readJson('https://api.binance.com' + path + '?' + query, { method: 'GET', headers }, fetcher);
  } catch (error) {
    // JSON parse and transport errors may contain response text or signed URLs. Never expose them.
    const http = error instanceof Error ? /^服务暂时不可用（HTTP (\d{3})），保留上次数据$/.exec(error.message) : null;
    throw new Error(`Binance 读取失败${http ? '（HTTP ' + http[1] + '）' : ''}，请检查网络、API 权限及服务器时间；已保留上次数据`);
  }
  if (!data || typeof data !== 'object') throw new Error('Binance 返回的数据不完整；已保留上次数据');
  if (Object.hasOwn(data, 'code')) {
    const code = (data as Json).code;
    throw new Error(`Binance 读取失败（${typeof code === 'number' && Number.isSafeInteger(code) ? code : '未知代码'}），请检查 API 权限、IP 白名单及服务器时间`);
  }
  return data;
}
export async function syncBinance(c: BinanceCredential, prices: Record<string, Quote>, fetcher: Fetcher = fetch): Promise<{total:number;details:Balance[]}> {
  const quote = prices.USDT;
  const quoteAt = typeof quote?.at === 'string' ? Date.parse(quote.at) : NaN;
  if (typeof quote?.price !== 'number' || !Number.isFinite(quote.price) || quote.price <= 0 || !Number.isFinite(quoteAt) || Date.now() - quoteAt > 900000 || quoteAt - Date.now() > 60000) throw new Error('USDT 美元行情无效或已过期；已保留上次数据');
  const info = await binanceGet(c, '/sapi/v1/account/apiRestrictions', fetcher) as Json;
  if (Array.isArray(info) || info.enableReading !== true || BINANCE_CORE_WRITE_PERMISSIONS.some(field => info[field] !== false)) throw new Error('此 Binance API 无法确认只读权限，请使用仅启用读取的 API');
  // Older responses omit FIX/portfolio fields. Missing new fields are accepted, but present
  // write permissions must be strictly false; FIX read-only permission may be true or false.
  if (BINANCE_NEW_WRITE_PERMISSIONS.some(field => Object.hasOwn(info, field) && info[field] !== false) || (Object.hasOwn(info, 'enableFixReadOnly') && typeof info.enableFixReadOnly !== 'boolean')) throw new Error('此 Binance API 无法确认只读权限，请使用仅启用读取的 API');
  const wallets = await binanceGet(c, '/sapi/v1/asset/wallet/balance', fetcher);
  if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('Binance 钱包数据不完整；已保留上次数据');
  const names = new Set<string>();
  const details: Balance[] = [];
  let total = 0;
  for (const wallet of wallets) {
    if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet) || typeof wallet.activate !== 'boolean' || typeof wallet.walletName !== 'string' || !wallet.walletName.trim()) throw new Error('Binance 钱包数据不完整；已保留上次数据');
    const name = wallet.walletName.trim();
    const identity = name.toLowerCase();
    if (names.has(identity)) throw new Error('Binance 钱包重复，无法确认总额；已保留上次数据');
    names.add(identity);
    if (typeof wallet.balance !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(wallet.balance)) throw new Error('Binance 钱包余额不是有效数值；已保留上次数据');
    const quantity = Number(wallet.balance);
    if (!Number.isFinite(quantity) || (quantity === 0 && /[1-9]/.test(wallet.balance))) throw new Error('Binance 钱包余额不是有效数值；已保留上次数据');
    if (!wallet.activate) {
      if (quantity !== 0) throw new Error('Binance 未激活钱包返回非零余额；已保留上次数据');
      continue;
    }
    const value = quantity * quote.price;
    total += value;
    if (!Number.isFinite(value) || !Number.isFinite(total) || (quantity !== 0 && value === 0)) throw new Error('Binance 钱包美元估值不是有效数值；已保留上次数据');
    // This endpoint is the sole balance source: do not add spot, futures or P&L again.
    details.push({ coin: 'USDT', account: name + '（折合 USDT）', quantity: quantity === 0 ? 0 : quantity, price: quote.price, value: value === 0 ? 0 : value });
  }
  return { total, details };
}
