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
/** 一轮询价的总时限：到点就用已经拿到的，不让慢的询价拖住这一轮的样本。 */
export const TOKEN_QUOTE_PHASE_MS = 8_000;
/** 被拦截后整个 token 暂停、单个标的失败后该标的暂停的时长。 */
export const TOKEN_BLOCK_PAUSE_MS = 5 * 60_000, TOKEN_SYMBOL_PAUSE_MS = 5 * 60_000;
/** 最近一次失败的原因在状态里保留多久。 */
export const TOKEN_ERROR_KEEP_MS = 90_000;

export interface TokenQuote { bid: number; ask: number; mark: number; qty: number; /** Var 给的报价时刻。 */ at: number; /** 本机收到的时刻。 */ receivedAt: number }
export interface VarQuoter {
  /** 当前能不能询价（有可用 token 且不在被拦截后的暂停里）；读一次 token 文件，不发请求。 */ usable(): boolean;
  /** 这个标的这一轮要不要询：类别的写法确认过，且不在失败后的暂停里。 */ wants(kind: AssetKind, symbol: string): boolean;
  /**
   * 询一次价；失败抛出固定文案的错误（不含 token 与应答正文）。`signal` 交给传输层；`stop` 是调用方自己的中止信号（不给就是 `signal`）：
   * 只有它中止才算调用方不要了、不记失败。引擎给 `signal` 加了阶段时限，到时限而 `stop` 没中止的请求按超时记失败并暂停该标的。
   */
  quote(kind: AssetKind, symbol: string, notionalUsd: number, referencePrice: number, signal: AbortSignal, stop?: AbortSignal): Promise<TokenQuote>;
  view(): TokenView;
}

type Instrument = Record<string, string | number>;
/**
 * 各类别在 Var 的合约定义。股票与商品的写法在公开价格流上逐个试出（2026-11-23：`kind: equity` 订阅成功），加密货币同（`funding_interval_s: 3600`）。
 * 询价接口是否接受同样的写法只有商品（原油监控在用）核实过，其余待服务器上实测；别的类别（ETF、贵金属、未上市、其他）没有确认过写法，不询价。
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
  const rounded = Number(raw.toPrecision(4));
  if (rounded >= 1e12) return null;
  const fixed = rounded.toFixed(8);
  const text = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return /[1-9]/.test(text) ? text : null;
}

/** 正的十进制数：数值，或纯十进制文本（不收十六进制、指数与带空格的写法）。 */
const positive = (value: unknown): number => { const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN; return Number.isFinite(parsed) && parsed > 0 ? parsed : NaN; };
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
 * 退避：被拦截（403 或质询）后这个 token 停 5 分钟；单个标的询价失败（超时、非 2xx、应答对不上）后这个标的停 5 分钟，
 * 写法不对的合约不会每分钟重试。调用方中止（`stop`）的请求不算失败；引擎的阶段时限到了而请求还没回来，按超时算。
 */
export function createVarQuoter({ dir, fetcher, now = Date.now }: { dir: string; fetcher: VariationalFetcher; now?: () => number }): VarQuoter {
  const file = join(dir, VARIATIONAL_SESSION_FILE);
  let rejected = '', unavailableToken = '', pausedToken = '', pausedUntil = 0;
  let failure: { token: string; at: number; message: string } | null = null;
  let success: { token: string; at: number; lagMs: number } | null = null;
  const symbolPause = new Map<string, number>();
  const read = (): { token: string; status: TokenStatus; expiresAt: number | null; problem: string } => {
    const { state, problem } = readVariationalSessionFile(file);
    if (!state.token) return { token: '', status: 'missing', expiresAt: null, problem };
    const expiresAt = variationalTokenExpiry(state.token);
    if (expiresAt <= now() + VARIATIONAL_EXPIRY_MARGIN_MS) return { token: '', status: 'expired', expiresAt, problem: '' };
    if (state.token === rejected) return { token: '', status: 'rejected', expiresAt, problem: '' };
    return { token: state.token, status: unavailableToken === state.token ? 'unavailable' : 'ready', expiresAt, problem: '' };
  };
  return {
    usable: () => { const { token } = read(); return token !== '' && !(token === pausedToken && now() < pausedUntil); },
    wants: (kind, symbol) => varInstrument(kind, symbol) !== null && !((symbolPause.get(symbol) ?? 0) > now()),
    async quote(kind, symbol, notionalUsd, referencePrice, signal, stop = signal) {
      const instrument = varInstrument(kind, symbol), qty = quoteQty(notionalUsd, referencePrice);
      if (!instrument) throw new Error('该类别的 Var 询价格式未确认');
      if (!qty) throw new Error('算不出询价数量');
      const { token } = read();
      if (!token) throw new Error('没有可用的 Var token');
      let answer: unknown;
      try { answer = await requestVariational('/quotes/indicative', token, { fetcher, signal, body: { instrument, qty } }); }
      catch (caught) {
        // requestVariational 抛出的已经是分类后的错误（固定文案，带 rejected / blocked）；别的才再分类一次。
        const known = caught as { variational?: boolean; rejected?: boolean; blocked?: boolean; message?: string } | null;
        const classified = known && typeof known === 'object' && known.variational === true ? known : variationalRequestError(caught);
        if (stop.aborted) throw new Error(String(classified.message));
        // 被拒与被拦截是整个 token 的事；其余（超时、非 2xx、缺 Python）记在标的上，原因带标的代码。
        const message = classified.rejected || classified.blocked ? String(classified.message) : `${symbol}：${String(classified.message)}`;
        if (classified.rejected) rejected = token;
        else {
          unavailableToken = token;
          if (classified.blocked) { pausedToken = token; pausedUntil = now() + TOKEN_BLOCK_PAUSE_MS; }
          else symbolPause.set(symbol, now() + TOKEN_SYMBOL_PAUSE_MS);
        }
        failure = { token, at: now(), message };
        throw new Error(message);
      }
      try {
        const quote = parseTokenQuote(answer, instrument, qty, now());
        if (unavailableToken === token) unavailableToken = '';
        success = { token, at: quote.receivedAt, lagMs: quote.receivedAt - quote.at };
        return quote;
      } catch (caught) {
        // 应答读到了但内容不对：多半是这类标的的请求写法或应答格式与预期不同，不算 token 或网络的问题。
        const message = `${symbol}：${caught instanceof Error ? caught.message : 'Var 询价应答无法解析'}`;
        symbolPause.set(symbol, now() + TOKEN_SYMBOL_PAUSE_MS);
        failure = { token, at: now(), message };
        throw new Error(message);
      }
    },
    view() {
      const current = read(), live = current.status === 'ready' || current.status === 'unavailable';
      // 一轮里有成功也有失败时两边都留着：最近一次失败的原因保留 90 秒（一轮多一点），不被同一轮里别的成功盖掉。
      const error = live && failure && failure.token === current.token && now() - failure.at < TOKEN_ERROR_KEEP_MS ? failure.message : null;
      const ok = live && success && success.token === current.token ? success : null;
      return { status: current.status, statusName: TOKEN_STATUS_NAMES[current.status], expiresAt: current.expiresAt, error: current.problem || error, okAt: ok?.at ?? null, lagMs: ok?.lagMs ?? null };
    },
  };
}
