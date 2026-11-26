// DEX 价差实盘的下单连接器（docs/dexspread.md 第 13 节）：Entropy（Hyperliquid）与 Lighter（主网、RH）各一个，只发「立即成交、剩余撤销」的单。
// 每笔单的结局只有两种：`done`（交易所给了确定的结果，成交量可以是 0）或 `unknown`（发出去了但不知道结果）。
// `unknown` 的单绝不重发（L039、L093）：由 resolve 按自编号去查，查不到时交给上层按账户持仓核对。
// 报错文案先去掉长的十六进制串与长数字（地址、账户编号），再给日志与页面。
import { ENTROPY_ENDPOINTS, LIGHTER_ENDPOINTS, type FetchLike } from './feeds.ts';
import { hip3Asset, iocOrderAction, signL1Action } from './hyperliquid.ts';
import type { EntropyKey, LighterKey } from './livekeys.ts';
import type { LighterSigner } from './lighter-signer.ts';
import type { MarketSpec } from './model.ts';

export interface VenueOrder {
  market: MarketSpec; side: 'buy' | 'sell';
  /** 数量与限价，已按该市场的精度取整。买单的限价是愿意付的最高价，卖单是最低价。 */ qty: number; limit: number;
  reduceOnly: boolean;
  /** 自编号：本进程内单调递增的正整数（小于 2^48），两个场所都用它查单。 */ clientId: number;
}
export type OrderOutcome =
  | { kind: 'done'; filledQty: number; /** 成交均价；交易所没给时为 null（上层按限价估）。 */ avgPrice: number | null; note: string }
  | { kind: 'unknown'; reason: string };
export interface VenueTrader {
  place(order: VenueOrder, signalFor: () => AbortSignal): Promise<OrderOutcome>;
  /** 查一笔结果未知的单。`sentAt` 是发出的时刻。 */
  resolve(order: VenueOrder, sentAt: number, signalFor: () => AbortSignal): Promise<OrderOutcome>;
}

const EXCHANGE_URL = 'https://api.hyperliquid.xyz/exchange';
const RESPONSE_LIMIT = 256 * 1024;
/** 查不到单时，发出后至少过这么久才认定没有成交。Lighter 的交易 10 分钟后过期，在那之前都可能被打包。 */
export const ENTROPY_ABSENT_MS = 15_000, LIGHTER_ABSENT_MS = 11 * 60_000;
const LIGHTER_POLL_TRIES = 8, LIGHTER_POLL_MS = 700;
const AUTH_TTL_SEC = 3600, AUTH_RENEW_MS = 50 * 60_000;

export const scrub = (text: string): string => text.replace(/0x[0-9a-fA-F]{8,}/g, '0x…').replace(/[0-9a-fA-F]{24,}/g, '…').replace(/\d{5,}/g, '…').slice(0, 160);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const numberOf = (value: unknown): number | null => { const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN; return Number.isFinite(number) ? number : null; };
const reasonOf = (error: unknown) => scrub(error instanceof Error ? error.message : String(error));
const done = (filledQty: number, avgPrice: number | null, note: string): OrderOutcome => ({ kind: 'done', filledQty, avgPrice, note });
const unknown = (reason: string): OrderOutcome => ({ kind: 'unknown', reason });

/** 发一个请求并读回 JSON：返回 HTTP 状态与应答体（不是 JSON 时 body 为 null）。网络错误与超时照常抛出。 */
async function call(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  if (text.length > RESPONSE_LIMIT) throw new Error('响应过大');
  let body: unknown = null;
  try { body = JSON.parse(text) as unknown; } catch { /* 不是 JSON */ }
  return { status: response.status, body };
}
const jsonPost = (body: unknown, signal: AbortSignal): RequestInit => ({ method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

// ---- Entropy（Hyperliquid HIP-3 io 盘） ----
export const cloidOf = (clientId: number): string => '0x' + clientId.toString(16).padStart(32, '0');

export function createEntropyTrader({ key, fetchImpl, now }: { key: EntropyKey; fetchImpl: FetchLike; now: () => number }): VenueTrader {
  let dexIndex: number | null = null, lastNonce = 0;
  /** io 盘在 perpDexs 里的序号（第 0 项是主盘，为 null）：资产编号要用它，不写死。 */
  async function indexOfDex(signal: AbortSignal): Promise<number> {
    if (dexIndex !== null) return dexIndex;
    const { status, body } = await call(fetchImpl, ENTROPY_ENDPOINTS.info, jsonPost({ type: 'perpDexs' }, signal));
    const index = status === 200 && Array.isArray(body) ? body.findIndex(item => isRecord(item) && item.name === ENTROPY_ENDPOINTS.dex) : -1;
    if (index < 1) throw new Error('读不到 Entropy 所在盘的序号');
    return dexIndex = index;
  }
  function parseStatus(body: unknown): OrderOutcome | null {
    if (!isRecord(body)) return null;
    if (body.status === 'err') return done(0, null, `交易所拒绝：${scrub(typeof body.response === 'string' ? body.response : '未说明原因')}`);
    const response = isRecord(body.response) ? body.response : null, data = response && isRecord(response.data) ? response.data : null;
    const statuses = body.status === 'ok' && data && Array.isArray(data.statuses) ? data.statuses as unknown[] : null;
    if (!statuses || statuses.length !== 1) return null;
    const item = statuses[0];
    if (!isRecord(item)) return null;
    if (typeof item.error === 'string') return done(0, null, `未成交：${scrub(item.error)}`);
    if (isRecord(item.filled)) {
      const size = numberOf(item.filled.totalSz), price = numberOf(item.filled.avgPx);
      return size !== null && size >= 0 ? done(size, price !== null && price > 0 ? price : null, '已成交') : null;
    }
    // IOC 单不会挂着；真出现了按结果未知处理，由上层去查。
    return null;
  }
  return {
    async place(order, signalFor) {
      let request: RequestInit;
      try {
        const asset = hip3Asset(await indexOfDex(signalFor()), order.market.id);
        const action = iocOrderAction([{ asset, isBuy: order.side === 'buy', price: order.limit, size: order.qty, reduceOnly: order.reduceOnly, cloid: cloidOf(order.clientId) }]);
        const nonce = lastNonce = Math.max(lastNonce + 1, now());
        request = jsonPost({ action, nonce, signature: signL1Action(action, nonce, key.privateKey), vaultAddress: null }, signalFor());
      } catch (error) { return done(0, null, `没有发出：${reasonOf(error)}`); }
      let answer: { status: number; body: unknown };
      try { answer = await call(fetchImpl, EXCHANGE_URL, request); } catch (error) { return unknown(`请求没有应答：${reasonOf(error)}`); }
      const outcome = parseStatus(answer.body);
      if (outcome) return outcome;
      // 4xx（格式、限流）是交易所没有受理；其余读不懂的应答按未知处理。
      if (answer.status >= 400 && answer.status < 500) return done(0, null, `交易所没有受理（HTTP ${answer.status}）`);
      return unknown(`应答读不懂（HTTP ${answer.status}）`);
    },
    async resolve(order, sentAt, signalFor) {
      let answer: { status: number; body: unknown };
      try { answer = await call(fetchImpl, ENTROPY_ENDPOINTS.info, jsonPost({ type: 'orderStatus', user: key.address, oid: cloidOf(order.clientId) }, signalFor())); }
      catch (error) { return unknown(`查单失败：${reasonOf(error)}`); }
      const body = answer.body;
      if (answer.status !== 200 || !isRecord(body)) return unknown(`查单应答读不懂（HTTP ${answer.status}）`);
      if (body.status === 'unknownOid') return now() - sentAt >= ENTROPY_ABSENT_MS ? done(0, null, '交易所查无此单') : unknown('交易所暂时查不到这笔单');
      const wrapper = isRecord(body.order) ? body.order : null, inner = wrapper && isRecord(wrapper.order) ? wrapper.order : null;
      if (body.status !== 'order' || !wrapper || !inner) return unknown('查单应答读不懂');
      if (wrapper.status === 'open' || wrapper.status === 'triggered') return unknown('这笔单还挂着');
      const original = numberOf(inner.origSz), remaining = numberOf(inner.sz);
      if (original === null || remaining === null || remaining < 0 || remaining > original) return unknown('查单应答缺少数量');
      return done(original - remaining, null, `查单结果：${scrub(String(wrapper.status))}`);
    },
  };
}

// ---- Lighter（主网与 RH） ----
/** 订单已有最终结果的状态：filled 或各种 canceled-*。 */
const lighterFinal = (status: unknown): status is string => typeof status === 'string' && (status === 'filled' || status.startsWith('canceled'));

export function createLighterTrader({ venue, key, fetchImpl, now, signer, pause = ms => new Promise<void>(resolve => { setTimeout(resolve, ms); }) }:
  { venue: 'lighter' | 'rh'; key: LighterKey; fetchImpl: FetchLike; now: () => number; signer: () => Promise<LighterSigner>; pause?: (ms: number) => Promise<void> }): VenueTrader {
  const rest = LIGHTER_ENDPOINTS[venue].rest;
  let nonce: number | null = null, queue: Promise<unknown> = Promise.resolve();
  let auth: { token: string; at: number } | null = null;
  /** 同一个 API 密钥的交易按 nonce 排队，一次只发一笔。 */
  const serial = <T>(job: () => Promise<T>): Promise<T> => { const next = queue.then(job, job); queue = next.catch(() => undefined); return next; };
  async function nextNonce(signal: AbortSignal): Promise<number> {
    if (nonce !== null) return nonce;
    const { status, body } = await call(fetchImpl, `${rest}/nextNonce?account_index=${key.accountIndex}&api_key_index=${key.apiKeyIndex}`, { headers: { accept: 'application/json' }, signal });
    const value = status === 200 && isRecord(body) && body.code === 200 ? body.nonce : null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('读不到下一个 nonce');
    return nonce = value;
  }
  async function token(): Promise<string> {
    if (auth && now() - auth.at < AUTH_RENEW_MS) return auth.token;
    const value = (await signer()).createAuthToken(Math.floor(now() / 1000) + AUTH_TTL_SEC);
    auth = { token: value, at: now() };
    return value;
  }
  /** 按自编号查单：有最终结果返回 done，还没有或查不到返回 null。 */
  async function lookup(order: VenueOrder, signal: AbortSignal): Promise<OrderOutcome | null> {
    const { status, body } = await call(fetchImpl, `${rest}/accountOrders?account_index=${key.accountIndex}&client_order_indexes=${order.clientId}`, { headers: { accept: 'application/json', authorization: await token() }, signal });
    if (status === 401 || status === 403) { auth = null; throw new Error(`查单鉴权失败（HTTP ${status}）`); }
    if (status !== 200 || !isRecord(body) || body.code !== 200 || !Array.isArray(body.orders)) throw new Error(`查单应答读不懂（HTTP ${status}）`);
    const found = (body.orders as unknown[]).find(item => isRecord(item) && Number(item.client_order_index) === order.clientId);
    if (!isRecord(found) || !lighterFinal(found.status)) return null;
    const filled = numberOf(found.filled_base_amount), quote = numberOf(found.filled_quote_amount);
    if (filled === null || filled < 0) throw new Error('查单应答缺少成交数量');
    return done(filled, filled > 0 && quote !== null && quote > 0 ? quote / filled : null, found.status === 'filled' ? '已成交' : `交易所撤销：${scrub(found.status)}`);
  }
  async function poll(order: VenueOrder, signalFor: () => AbortSignal, tries: number): Promise<OrderOutcome | null> {
    let last = '还没有结果';
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt > 0) await pause(LIGHTER_POLL_MS);
      try { const outcome = await lookup(order, signalFor()); if (outcome) return outcome; } catch (error) { last = reasonOf(error); }
    }
    void last;
    return null;
  }
  return {
    place: (order, signalFor) => serial(async () => {
      const sizeDecimals = order.market.sizeDecimals ?? 0, priceDecimals = order.market.priceDecimals ?? 0;
      let form: URLSearchParams;
      try {
        const used = await nextNonce(signalFor());
        const signed = (await signer()).signCreateOrder({
          marketIndex: order.market.id, clientOrderIndex: order.clientId, baseAmount: Math.round(order.qty * 10 ** sizeDecimals), price: Math.round(order.limit * 10 ** priceDecimals),
          isAsk: order.side === 'sell', orderType: 1, timeInForce: 0, reduceOnly: order.reduceOnly, triggerPrice: 0, orderExpiry: 0, nonce: used,
        });
        form = new URLSearchParams({ tx_type: String(signed.txType), tx_info: signed.txInfo });
      } catch (error) { nonce = null; return done(0, null, `没有发出：${reasonOf(error)}`); }
      let answer: { status: number; body: unknown };
      try { answer = await call(fetchImpl, `${rest}/sendTx`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), signal: signalFor() }); }
      catch (error) { nonce = null; return unknown(`请求没有应答：${reasonOf(error)}`); }
      const body = answer.body;
      if (answer.status === 200 && isRecord(body) && body.code === 200) {
        nonce = nonce === null ? null : nonce + 1;
        // 交易被接受不等于成交：保证金不足、滑点超限时订单会被撤销，要查成交量。
        return await poll(order, signalFor, LIGHTER_POLL_TRIES) ?? unknown('交易已被接受，还没查到成交结果');
      }
      nonce = null;
      // 接口明确拒绝的交易不占用 nonce，也不会被执行。
      if (isRecord(body) && typeof body.code === 'number' && body.code !== 200 && answer.status < 500) return done(0, null, `交易所拒绝（${body.code}）：${scrub(typeof body.message === 'string' ? body.message : '')}`);
      return unknown(`应答读不懂（HTTP ${answer.status}）`);
    }),
    async resolve(order, sentAt, signalFor) {
      nonce = null;
      const outcome = await poll(order, signalFor, 2);
      if (outcome) return outcome;
      return now() - sentAt >= LIGHTER_ABSENT_MS ? done(0, null, '交易所查无此单') : unknown('交易所暂时查不到这笔单');
    },
  };
}
