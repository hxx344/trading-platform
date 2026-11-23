// Var 登录后的询价（docs/varlighter.md 第 3 节「Var token 询价」）：用行情监控保存的 Var token 读 `/api/quotes/indicative`，
// 按要下的数量取买卖价与报价时刻。只读：token 文件由行情监控的表单或工作台导入写入，这里不写、不验证、不保存。
// 请求经 src/monitor/variational-transport.ts 的固定白名单（主机、路径、请求体逐字段重建），token 只进传输脚本的标准输入。
import { join } from 'node:path';
import { VARIATIONAL_SESSION_FILE, readVariationalSessionFile } from '../monitor/variational-session.ts';
import { VARIATIONAL_EXPIRY_MARGIN_MS, requestVariational, variationalRequestError, variationalTokenExpiry, type VariationalFetcher } from '../vendor/variational-market.mjs';
import type { AssetKind } from './model.ts';
import type { TokenStatus, TokenView } from './views.ts';

export const TOKEN_STATUS_NAMES: Record<TokenStatus, string> = { missing: '未配置', expired: '已过期', ready: '正常', rejected: '会话已失效', unavailable: '暂不可用' };
/** 询价的源时间早于现在这么久就不用（请求本身最多 10 秒）。 */
export const TOKEN_QUOTE_MAX_AGE_MS = 15_000;
/** 一轮里同时发出的询价数（每个请求起一个 python3 子进程）。 */
export const TOKEN_QUOTE_CONCURRENCY = 4;

export interface TokenQuote { bid: number; ask: number; mark: number; qty: number; /** Var 给的报价时刻。 */ at: number; /** 本机收到的时刻。 */ receivedAt: number }
export interface VarQuoter {
  /** 当前能不能询价；读一次 token 文件，不发请求。 */ usable(): boolean;
  /** 询一次价；失败抛出固定文案的错误（不含 token 与应答正文）。 */ quote(kind: AssetKind, symbol: string, notionalUsd: number, referencePrice: number, signal: AbortSignal): Promise<TokenQuote>;
  view(): TokenView;
}

type Instrument = Record<string, string | number>;
/**
 * 各类别在 Var 的合约定义。股票与商品的写法在公开价格流上逐个试出（2026-11-23：`kind: equity` 订阅成功），加密货币同（`funding_interval_s: 3600`）。
 * 询价接口是否接受同样的写法只有商品（原油监控在用）核实过，其余待服务器上实测；别的类别没有确认过写法，不询价。
 */
export function varInstrument(kind: AssetKind, symbol: string): Instrument | null {
  if (!/^[A-Z0-9]{1,16}$/.test(symbol)) return null;
  if (kind === 'crypto') return { underlying: symbol, instrument_type: 'perpetual_future', settlement_asset: 'USDC', funding_interval_s: 3600 };
  if (kind === 'equity' || kind === 'commodity') return { underlying: symbol, instrument_type: 'perpetual_rwa_future', settlement_asset: 'USDC', kind };
  return null;
}

/** 名义金额折成数量：四位有效数字、最多 8 位小数的十进制文本（传输白名单的格式）；算不出正数时返回 null。 */
export function quoteQty(notionalUsd: number, price: number): string | null {
  const raw = notionalUsd / price;
  if (!Number.isFinite(raw) || raw <= 0 || raw >= 1e12) return null;
  const fixed = Number(raw.toPrecision(4)).toFixed(8);
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return /[1-9]/.test(text) ? text : null;
}

const positive = (value: unknown): number => { const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN; return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN; };
/** 解析询价应答：标的与数量要对得上请求，买卖价有效，报价时刻在 [现在 − 15 秒, 现在 + 2 秒] 内。 */
export function parseTokenQuote(input: unknown, instrument: Instrument, qty: string, now: number): TokenQuote {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const echoed = value.instrument && typeof value.instrument === 'object' ? value.instrument as Record<string, unknown> : {};
  if (echoed.underlying !== instrument.underlying || echoed.instrument_type !== instrument.instrument_type || positive(value.qty) !== Number(qty)) throw new Error('Var 询价应答的标的或数量与请求不符');
  const bid = positive(value.bid), ask = positive(value.ask), mark = positive(value.mark_price);
  if (!(bid > 0) || !(ask >= bid) || !(mark > 0)) throw new Error('Var 询价应答的价格无效');
  const at = typeof value.timestamp === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.timestamp) ? Date.parse(value.timestamp) : NaN;
  if (!Number.isFinite(at) || at < now - TOKEN_QUOTE_MAX_AGE_MS || at > now + 2_000) throw new Error('Var 询价应答的时间无效或已过期');
  return { bid, ask, mark, qty: Number(qty), at, receivedAt: now };
}

/**
 * `dir` 是服务的数据目录（token 文件所在）。被 Var 拒绝的 token 记在内存里不再用，直到文件换成别的 token；
 * 判定只落在发请求时用的那个 token 上，请求途中文件换了新 token 不会把新的标成失效。
 */
export function createVarQuoter({ dir, fetcher, now = Date.now }: { dir: string; fetcher: VariationalFetcher; now?: () => number }): VarQuoter {
  const file = join(dir, VARIATIONAL_SESSION_FILE);
  let rejected = '', error: string | null = null, okAt: number | null = null, lagMs: number | null = null, unavailable = false;
  const read = (): { token: string; status: TokenStatus; expiresAt: number | null; problem: string } => {
    const { state, problem } = readVariationalSessionFile(file);
    if (!state.token) return { token: '', status: 'missing', expiresAt: null, problem };
    const expiresAt = variationalTokenExpiry(state.token);
    if (expiresAt <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) return { token: '', status: 'expired', expiresAt, problem: '' };
    if (state.token === rejected) return { token: '', status: 'rejected', expiresAt, problem: '' };
    return { token: state.token, status: unavailable ? 'unavailable' : 'ready', expiresAt, problem: '' };
  };
  return {
    usable: () => read().token !== '',
    async quote(kind, symbol, notionalUsd, referencePrice, signal) {
      const instrument = varInstrument(kind, symbol), qty = quoteQty(notionalUsd, referencePrice);
      if (!instrument) throw new Error('该类别的 Var 询价格式未确认');
      if (!qty) throw new Error('算不出询价数量');
      const { token } = read();
      if (!token) throw new Error('没有可用的 Var token');
      let answer: unknown;
      try { answer = await requestVariational('/quotes/indicative', token, { fetcher, signal, body: { instrument, qty } }); }
      catch (failure) {
        const classified = variationalRequestError(failure);
        if (classified.rejected) rejected = token; else unavailable = true;
        error = classified.message;
        throw new Error(classified.message);
      }
      try {
        const quote = parseTokenQuote(answer, instrument, qty, now());
        unavailable = false; error = null; okAt = quote.receivedAt; lagMs = quote.receivedAt - quote.at;
        return quote;
      } catch (failure) {
        // 应答读到了但内容不对：多半是这类标的的请求写法或应答格式与预期不同，不算 token 或网络的问题。
        error = failure instanceof Error ? failure.message : 'Var 询价应答无法解析';
        throw new Error(error);
      }
    },
    view() {
      const current = read();
      return { status: current.status, statusName: TOKEN_STATUS_NAMES[current.status], expiresAt: current.expiresAt,
        error: current.problem || (current.status === 'ready' || current.status === 'unavailable' ? error : null), okAt, lagMs };
    },
  };
}
