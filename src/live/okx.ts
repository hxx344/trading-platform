// Real OKX v5 connector (docs/oil.md section 10): USDT-margined swaps of oil and SK hynix, orders by clOrdId. Paths, the
// codes that prove a refusal, the rule and position checks follow the workbench (server/trading-okx-common.mjs and
// server/trading-okx-execution.mjs at 7745181); the bill types follow server/trading-okx-readonly.mjs.
import { okxAuthHeaders } from '../vendor/okx.mjs';
import { createHash } from 'node:crypto';
import { VENUE_EXECUTION_SYMBOLS, accountKey, type AccountBinding, type AccountSnapshot, type Instrument, type OpenOrder, type Position, type PositionSide, type Quote } from '../contracts.ts';
import { VenueError, type CallOptions, type ConnectorCapabilities, type LedgerEntry, type OrderReport, type OrderRequest, type OrderStatus, type PnlPosition, type PnlSnapshot, type SendOptions, type VenueConnector } from '../connector.ts';
import { cmp, isZero, mul, sub } from '../decimal.ts';
import { exchange, isRecord, type FetchLike, type HttpReply } from './http.ts';
import { PreflightError, okxAccountProblem, okxIpProblem, okxPermissionProblem } from './permissions.ts';
import { ShapeError, amount, cashAmount, describe, hedgeClose, identifier, list, millis, optionalPrice, record, validCredentials, validPassphrase, type LiveCredentials } from './values.ts';

export interface OkxConnectorOptions {
  /** Resolves the key for one binding; a throw refuses the call before anything is sent. */
  credentials: (binding: AccountBinding) => LiveCredentials;
  fetchImpl?: FetchLike;
  now?: () => number;
  /**
   * Per HTTP exchange; must stay well under the executor's callTimeoutMs (a create plus its follow-up read is two, a stale
   * clock offset adds a time read before the create).
   */
  timeoutMs?: number;
  ruleTtlMs?: number;
  /** Least time between two bill reads (the workbench spaces them 420 ms for the venue's bill rate limit). */
  billSpacingMs?: number;
}

const HOST = 'https://www.okx.com';
const MAX_CLOCK_OFFSET_MS = 300_000;
/**
 * A write is sent only with a clock offset read within this long, and carries OKX's expTime header (venue clock) this far
 * ahead. The offset is off by at most half the sync round trip (≤ 2.5 s, see syncClock), so the venue refuses the request
 * from 35 s + 2.5 s after it was signed by the local clock, within the 40 s the executor is told (requestValidityMs).
 */
const CLOCK_SYNC_TTL_MS = 600_000;
const REQUEST_EXPIRY_MS = 35_000;
const REQUEST_VALIDITY_MS = 40_000;
const CONFIG_TTL_MS = 60_000;
const PAGE_SIZE = 100;
const MAX_ORDER_PAGES = 20;
/** 60 pages at the 420 ms spacing (about 25 s) fit inside the PnL ledger timeout (LEDGER_TIMEOUT_MS, 30 s); more fails the window by name. */
const BILL_MAX_PAGES = 60;
export const INSTRUMENT_IDS: Record<string, string> = { CLUSDT: 'CL-USDT-SWAP', BZUSDT: 'BZ-USDT-SWAP', SKHYUSDT: 'SKHY-USDT-SWAP', SKHYNIXUSDT: 'SKHYNIX-USDT-SWAP' };
/** Strategy orders of any of these kinds can trade on the account at any time; each one counts as foreign activity. */
const ALGO_TYPES = ['conditional,oco', 'trigger', 'move_order_stop', 'iceberg', 'twap', 'chase'];
/**
 * Codes that prove a write did not execute, copied from the workbench (providerFailure). 50011 is the rate limit: refused
 * outright, never retried here. Every other code stays uncertain for a write.
 */
const KNOWN_REJECTIONS = new Set(['50011', '50101', '50103', '50104', '50105', '50106', '50107', '50108', '50109', '50110', '50111', '50113', '50114',
  '51000', '51001', '51004', '51005', '51006', '51007', '51008', '51010', '51020', '51120', '51121', '51122', '51131', '51201', '51202']);
const TIMESTAMP_CODE = '50102';
const NOT_FOUND_CODE = '51603';
const ORDER_TERMINAL: Record<string, OrderStatus> = { filled: 'filled', canceled: 'canceled', mmp_canceled: 'canceled' };
const ORDER_WORKING: Record<string, OrderStatus> = { live: 'new', partially_filled: 'partially-filled' };
/** cancelSource 31: the venue canceled a post-only order because it would have taken liquidity (it never rested). */
const POST_ONLY_TAKER_CANCEL = '31';
/** Bill types (workbench trades/funding): 8 funding, 2 trade, 5 liquidation, 9 ADL, 14 block trade carry PnL; 6 is an isolated margin move. */
const FUNDING_BILL = '8', MARGIN_BILL = '6', TRADE_BILLS = new Set(['2', '5', '9', '14']);

/**
 * The executor's client id `pa1-<24 hex>-<leg>[r<n>]` without its dashes is a clOrdId (letters and digits, at most 32),
 * and goes back the same way, so orders placed before a restart are still recognised.
 */
const EXECUTOR_ID = /^pa1-([0-9a-f]{24})-([01])(r\d{1,3})?$/;
const NATIVE_ID = /^pa1([0-9a-f]{24})([01])(r\d{1,3})?$/;
export const toClOrdId = (clientOrderId: string): string | null => { const match = EXECUTOR_ID.exec(clientOrderId); return match ? `pa1${match[1]}${match[2]}${match[3] ?? ''}` : null; };
export const fromClOrdId = (clOrdId: string): string | null => { const match = NATIVE_ID.exec(clOrdId); return match ? `pa1-${match[1]}-${match[2]}${match[3] ?? ''}` : null; };

type Mode = 'one-way' | 'hedge';
type Failure = { kind: 'timestamp' | 'not-found' | 'rejected' | 'unknown'; message: string };
/** A write that fails answers code 1 with its one row's sCode; that code is the one that counts. */
function classify(reply: HttpReply): Failure | null {
  const data = isRecord(reply.data) ? reply.data : null;
  const code = typeof data?.code === 'string' && /^\d{1,8}$/.test(data.code) ? data.code : undefined;
  if (reply.status >= 200 && reply.status < 300 && code === '0') return null;
  const row = Array.isArray(data?.data) && data.data.length === 1 && isRecord(data.data[0]) ? data.data[0] : null;
  const inner = (code === '1' || code === '2') && typeof row?.sCode === 'string' && /^\d{1,8}$/.test(row.sCode) && row.sCode !== '0' ? row.sCode : undefined;
  const effective = inner ?? code, text = inner ? row?.sMsg : data?.msg;
  const message = `OKX HTTP ${reply.status}${effective === undefined ? '' : ` 错误码 ${effective}`}${typeof text === 'string' && text ? `：${text.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120)}` : ''}`;
  if (reply.status >= 500 || effective === undefined) return { kind: 'unknown', message };
  if (effective === TIMESTAMP_CODE) return { kind: 'timestamp', message };
  if (effective === NOT_FOUND_CODE) return { kind: 'not-found', message };
  return { kind: KNOWN_REJECTIONS.has(effective) ? 'rejected' : 'unknown', message };
}
const sideOf = (value: unknown): 'buy' | 'sell' => value === 'buy' || value === 'sell' ? value : (() => { throw new ShapeError('方向无效'); })();
/** The position a one-way order acts on follows from its side and reduceOnly. */
const positionSideOf = (side: 'buy' | 'sell', reduceOnly: boolean): PositionSide => (side === 'buy') !== reduceOnly ? 'long' : 'short';
const ordTypeOf = (request: OrderRequest): string => request.type === 'market' ? 'market' : request.timeInForce === 'ioc' ? 'ioc' : request.timeInForce === 'gtx' ? 'post_only' : 'limit';
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new VenueError('read-failed', 'OKX 账单读取已取消')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(new VenueError('read-failed', 'OKX 账单读取已取消')); };
  signal.addEventListener('abort', stop, { once: true });
});

interface AccountConfig { uid: string; mode: Mode; perm: unknown; ip: unknown; acctLv: unknown; posMode: unknown }

export function createOkxConnector(options: OkxConnectorOptions): VenueConnector {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const now = options.now ?? Date.now, timeoutMs = options.timeoutMs ?? 10_000, ruleTtlMs = options.ruleTtlMs ?? 60_000, billSpacingMs = options.billSpacingMs ?? 420;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) throw new Error('OKX 连接器单次请求超时须在 100–15000 毫秒之间');
  if (!Number.isSafeInteger(billSpacingMs) || billSpacingMs < 0 || billSpacingMs > 5_000) throw new Error('OKX 账单请求间隔须在 0–5000 毫秒之间');
  let offset = 0, syncedAt: number | null = null, lastBillAt = -Infinity;
  const rules = new Map<string, { instrument: Instrument; expiresAt: number }>();
  const configs = new Map<string, { config: AccountConfig; at: number; apiKey: string }>();
  const bindingKey = (binding: AccountBinding): string => `${accountKey(binding)}:${binding.credentialVersion}:${binding.accountMode}`;

  function credentialsOf(binding: AccountBinding, mutation: boolean): LiveCredentials & { passphrase: string } {
    const fail = (message: string): never => { throw new VenueError(mutation ? 'not-sent' : 'read-failed', message); };
    if (binding.venue !== 'okx' || binding.environment !== 'mainnet' || (binding.accountMode !== 'cross' && binding.accountMode !== 'isolated')) fail('OKX 实盘连接器只接受 mainnet 的 OKX 全仓或逐仓账户');
    let credentials: LiveCredentials;
    try { credentials = options.credentials(binding); } catch (error) { return fail(`OKX 凭据不可用：${describe(error)}`); }
    // Messages name what is wrong, never the values.
    if (!validCredentials(credentials) || !validPassphrase(credentials.passphrase)) fail('OKX 凭据不完整或格式无效（须有 API Key、Secret 与 Passphrase）');
    return credentials as LiveCredentials & { passphrase: string };
  }

  async function syncClock(signal: AbortSignal): Promise<void> {
    const before = now();
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}/api/v5/public/time`, method: 'GET', maxBytes: 4096 }, { signal });
    const after = now();
    let ts: unknown;
    try { if (!classify(reply)) ts = record(list(record(reply.data, '服务器时间').data, '服务器时间', 1)[0], '服务器时间').ts; } catch { ts = undefined; }
    if (typeof ts !== 'string' || !/^\d{1,16}$/.test(ts) || after - before > 5_000) throw new VenueError('read-failed', 'OKX 服务器时间读取失败');
    const next = Math.round(Number(ts) - (before + after) / 2);
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_CLOCK_OFFSET_MS) throw new VenueError('read-failed', `本机时钟与 OKX 相差 ${next} 毫秒，超过上限`);
    offset = next; syncedAt = after;
  }

  async function publicRead(path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown[]> {
    const reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}${path}?${new URLSearchParams(params)}`, method: 'GET' }, { signal });
    const failure = classify(reply);
    if (failure) throw new VenueError('read-failed', failure.message);
    return list(record(reply.data, '应答').data, '应答数据');
  }

  /**
   * Signed request answering the data array; null when a read is answered "no such order" (51603). A timestamp refusal
   * (50102) proves the request did not execute, so it is sent once more after a clock sync; beforeSend runs again then.
   */
  async function signed(binding: AccountBinding, method: 'GET' | 'POST', path: string, params: Record<string, unknown>, { signal, beforeSend }: { signal: AbortSignal; beforeSend?: () => void }): Promise<unknown[] | null> {
    const mutation = method === 'POST';
    const credentials = credentialsOf(binding, mutation);
    const query = mutation ? '' : new URLSearchParams(params as Record<string, string>).toString(), body = mutation ? JSON.stringify(params) : '';
    const requestPath = `${path}${query ? `?${query}` : ''}`;
    // The validity a write declares rests on a recent offset (the start offset 0 is a guess): read it first when stale.
    const time = now();
    if (mutation && (syncedAt === null || time < syncedAt || time - syncedAt > CLOCK_SYNC_TTL_MS)) {
      try { await syncClock(signal); } catch (error) { throw new VenueError('not-sent', `OKX 时钟同步失败，请求未发送：${describe(error)}`); }
    }
    for (let attempt = 0; ; attempt++) {
      let headers: Record<string, string>;
      try {
        const signedAt = now() + offset;
        headers = { ...okxAuthHeaders(credentials, { timestamp: new Date(signedAt).toISOString(), method, requestPath, body }), ...(mutation ? { 'Content-Type': 'application/json', expTime: String(signedAt + REQUEST_EXPIRY_MS) } : {}) };
      }
      catch (error) { // A resend follows a refusal of the first transmission, so that refusal is the answer.
        throw new VenueError(!mutation ? 'read-failed' : attempt > 0 ? 'rejected' : 'not-sent', `OKX 请求签名失败：${describe(error)}`); }
      let reply: HttpReply;
      try { reply = await exchange(fetchImpl, timeoutMs, { url: `${HOST}${requestPath}`, method, headers, ...(mutation ? { body } : {}) }, { signal, ...(mutation ? { beforeSend: beforeSend ?? (() => undefined) } : {}) }); }
      catch (error) {
        if (attempt > 0 && error instanceof VenueError && error.kind === 'not-sent') throw new VenueError('rejected', `OKX 时间戳被拒后未重发：${error.message}`);
        throw error;
      }
      const failure = classify(reply);
      if (!failure) {
        try { return list(record(reply.data, '应答').data, '应答数据'); }
        catch (error) { throw new VenueError(mutation ? 'uncertain' : 'read-failed', `OKX 应答无法使用：${describe(error)}`); }
      }
      if (failure.kind === 'timestamp' && attempt === 0) {
        try { await syncClock(signal); } catch (error) { throw new VenueError(mutation ? 'rejected' : 'read-failed', `${failure.message}；时钟同步失败：${describe(error)}`); }
        continue;
      }
      if (failure.kind === 'not-found' && !mutation) return null;
      throw new VenueError(mutation ? (failure.kind === 'rejected' || failure.kind === 'timestamp' ? 'rejected' : 'uncertain') : 'read-failed', failure.message);
    }
  }
  const rows = async (binding: AccountBinding, path: string, params: Record<string, string>, signal: AbortSignal): Promise<unknown[]> => {
    const data = await signed(binding, 'GET', path, params, { signal });
    if (data === null) throw new ShapeError('交易所答复记录不存在');
    return data;
  };

  async function reading<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) {
      if (error instanceof ShapeError) throw new VenueError('read-failed', `OKX 应答无法使用：${error.message}`);
      throw error;
    }
  }

  function instrumentId(symbol: string): string {
    const id = INSTRUMENT_IDS[symbol];
    if (!id || !VENUE_EXECUTION_SYMBOLS.okx.includes(symbol)) throw new VenueError('read-failed', `${symbol} 不在 OKX 可读合约内`);
    return id;
  }

  /** The account's key, identity and position mode (one row); `fresh` skips the cache (start check). */
  async function readConfig(binding: AccountBinding, signal: AbortSignal, fresh = false): Promise<AccountConfig> {
    const key = bindingKey(binding), apiKey = credentialsOf(binding, false).apiKey, cached = configs.get(key), time = now();
    if (!fresh && cached && cached.apiKey === apiKey && time >= cached.at && time - cached.at < CONFIG_TTL_MS) return cached.config;
    const data = await rows(binding, '/api/v5/account/config', {}, signal);
    if (data.length !== 1) throw new ShapeError('账户配置不是一条记录');
    const row = record(data[0], '账户配置');
    const uid = identifier(row.uid, 'OKX 用户编号');
    if (!/^[1-9]\d{0,39}$/.test(uid)) throw new ShapeError('OKX 用户编号无效');
    if (row.posMode !== 'net_mode' && row.posMode !== 'long_short_mode') throw new ShapeError('OKX 持仓模式无法确认');
    const config: AccountConfig = { uid, mode: row.posMode === 'net_mode' ? 'one-way' : 'hedge', perm: row.perm, ip: row.ip, acctLv: row.acctLv, posMode: row.posMode };
    configs.set(key, { config, at: now(), apiKey });
    return config;
  }
  async function modeFor(binding: AccountBinding, signal: AbortSignal): Promise<Mode> {
    try { return (await reading(() => readConfig(binding, signal))).mode; }
    catch (error) { throw new VenueError('not-sent', `OKX 持仓模式读取失败，委托未发送：${describe(error)}`); }
  }

  /**
   * Positions of one symbol, read with the workbench's checks. A position held in the other margin mode than the account's
   * tdMode cannot be traded or attributed by this service, so it fails the read.
   */
  async function positionRows(binding: AccountBinding, symbol: string, mode: Mode, signal: AbortSignal): Promise<{ row: Record<string, unknown>; side: PositionSide; quantity: string }[]> {
    const instId = instrumentId(symbol), found: { row: Record<string, unknown>; side: PositionSide; quantity: string }[] = [], seen = new Set<string>();
    for (const item of await rows(binding, '/api/v5/account/positions', { instType: 'SWAP', instId }, signal)) {
      const row = record(item, '持仓');
      if (row.instId !== instId || row.instType !== 'SWAP') throw new ShapeError('持仓合约与请求不一致');
      if (row.mgnMode !== 'cross' && row.mgnMode !== 'isolated') throw new ShapeError('持仓保证金模式无法识别');
      if (!['net', 'long', 'short'].includes(row.posSide as string) || (row.posSide === 'net') !== (mode === 'one-way')) throw new ShapeError('持仓方向与账户持仓模式不一致');
      if (row.ccy !== undefined && row.ccy !== '' && row.ccy !== 'USDT') throw new ShapeError('持仓保证金币种不是 USDT');
      const signedSize = cashAmount(row.pos, '持仓数量');
      if (row.posSide !== 'net' && cmp(signedSize, '0') < 0) throw new ShapeError('双向持仓的数量为负');
      if (isZero(signedSize)) continue;
      if (row.mgnMode !== binding.accountMode) throw new ShapeError(`${symbol} 有${row.mgnMode === 'cross' ? '全仓' : '逐仓'}持仓，与配置的账户模式 ${binding.accountMode} 不一致`);
      const side: PositionSide = row.posSide === 'net' ? (cmp(signedSize, '0') > 0 ? 'long' : 'short') : row.posSide as PositionSide;
      if (seen.has(side)) throw new ShapeError('同一方向的持仓重复');
      seen.add(side);
      found.push({ row, side, quantity: cmp(signedSize, '0') < 0 ? sub('0', signedSize) : signedSize });
    }
    return found;
  }

  function orderReport(value: unknown, binding: AccountBinding, request: OrderRequest, mode: Mode | null, kind: 'uncertain' | 'read-failed'): OrderReport {
    try {
      const row = record(value, '委托回报');
      if (row.clOrdId !== toClOrdId(request.clientOrderId) || row.instId !== INSTRUMENT_IDS[request.symbol] || row.instType !== 'SWAP' || sideOf(row.side) !== request.side) throw new ShapeError('委托回报的客户订单号、合约或方向与请求不一致');
      if (row.tdMode !== binding.accountMode) throw new ShapeError('委托回报的保证金模式与账户不一致');
      if (row.ordType !== ordTypeOf(request)) throw new ShapeError('委托回报类型与请求不一致');
      if (request.type === 'limit' && (request.limitPrice === null || cmp(amount(row.px, '委托价格'), request.limitPrice) !== 0)) throw new ShapeError('委托回报的价格与请求不一致');
      if (row.posSide === 'net') {
        if (mode === 'hedge' || row.reduceOnly !== String(request.reduceOnly)) throw new ShapeError('委托回报只减仓标记与请求不一致');
      } else if (row.posSide !== request.positionSide || mode === 'one-way' || (row.reduceOnly !== 'true' && row.reduceOnly !== 'false')) throw new ShapeError('委托回报仓位方向与请求不一致');
      const quantity = amount(row.sz, '委托数量'), filledQuantity = amount(row.accFillSz, '成交数量', 'nonnegative');
      if (cmp(quantity, request.quantity) !== 0 || cmp(filledQuantity, quantity) > 0) throw new ShapeError('委托回报数量无效');
      const state = row.state as string;
      let status = typeof state === 'string' ? ORDER_TERMINAL[state] ?? ORDER_WORKING[state] : undefined;
      if (!status) throw new ShapeError(`委托状态 ${String(state).slice(0, 32)} 无法识别`);
      if (status === 'filled' && cmp(filledQuantity, quantity) !== 0) throw new ShapeError('全部成交的委托成交数量不足');
      // A post-only order the venue canceled for taking liquidity never rested: expired, as on Binance. Any other cancel stays canceled.
      if (status === 'canceled' && row.ordType === 'post_only' && isZero(filledQuantity) && row.cancelSource === POST_ONLY_TAKER_CANCEL) status = 'expired';
      const averagePrice = isZero(filledQuantity) ? null : optionalPrice(row.avgPx, '成交均价');
      if (!isZero(filledQuantity) && averagePrice === null) throw new ShapeError('有成交但没有成交均价');
      return {
        clientOrderId: request.clientOrderId, remoteId: identifier(row.ordId, '交易所订单号'), symbol: request.symbol, side: request.side, quantity, filledQuantity, averagePrice,
        status, terminal: Object.hasOwn(ORDER_TERMINAL, state), updatedAt: millis(row.uTime || row.cTime, '委托更新时间'),
      };
    } catch (error) {
      if (error instanceof ShapeError) throw new VenueError(kind, `OKX 委托回报无法使用：${error.message}`);
      throw error;
    }
  }
  /**
   * The order by clOrdId (open, or ended within the venue's retention); null only when the venue answers 51603. A success
   * with no row proves nothing, so it fails the read (L093).
   */
  async function findOrder(binding: AccountBinding, request: OrderRequest, signal: AbortSignal): Promise<unknown | null> {
    const clOrdId = toClOrdId(request.clientOrderId);
    if (!clOrdId) throw new VenueError('read-failed', 'OKX 查单：客户订单号格式无效');
    const data = await reading(async () => signed(binding, 'GET', '/api/v5/trade/order', { instId: instrumentId(request.symbol), clOrdId }, { signal }));
    if (data === null) return null;
    if (data.length === 0) throw new VenueError('read-failed', 'OKX 查单应答成功但没有委托记录');
    if (data.length > 1) throw new VenueError('read-failed', 'OKX 同一客户订单号返回了多笔委托');
    return data[0];
  }
  /** The one acknowledgement row of a write: sCode 0 and our clOrdId; anything else leaves the outcome open. */
  function ackOf(data: unknown[] | null, clOrdId: string, what: string): string {
    try {
      if (data === null || data.length !== 1) throw new ShapeError(`${what}回执不是一条记录`);
      const row = record(data[0], `${what}回执`);
      if (row.sCode !== '0' || row.clOrdId !== clOrdId) throw new ShapeError(`${what}回执的状态码或客户订单号与请求不一致`);
      return identifier(row.ordId, '交易所订单号');
    } catch (error) { throw new VenueError('uncertain', `OKX ${what}回执无法使用：${describe(error)}`); }
  }

  async function paceBills(signal: AbortSignal): Promise<void> {
    const wait = lastBillAt + billSpacingMs - Date.now();
    if (wait > 0) await sleep(wait, signal);
    lastBillAt = Date.now();
  }

  const capabilities: ConnectorCapabilities = {
    // The executor's 34-character ids fit: they are sent without their dashes (32 characters at most).
    transport: 'live', clientOrderId: true, queryByClientOrderId: true, cancelByClientOrderId: true, maxClientOrderIdLength: 34,
    // Writes carry expTime 35 s ahead on a recently synced clock (REQUEST_EXPIRY_MS); the offset error stays inside 40 s.
    requestValidityMs: REQUEST_VALIDITY_MS,
    postOnly: true,
  };

  return {
    venue: 'okx',
    capabilities,

    preflight: (binding: AccountBinding, { signal }: CallOptions) => reading(async () => {
      const config = await readConfig(binding, signal, true);
      const problem = okxPermissionProblem(config.perm) ?? okxIpProblem(config.ip);
      if (problem) throw new PreflightError(`OKX 密钥权限不符合要求：${problem}`);
      const accountProblem = okxAccountProblem(config.acctLv, config.posMode);
      if (accountProblem) throw new PreflightError(accountProblem);
      if (config.uid !== binding.accountId) throw new PreflightError(`OKX 密钥属于用户 ${config.uid}，与配置的账户 ${binding.accountId} 不一致`);
    }),

    instrument: (symbol: string, { signal }: CallOptions) => reading(async (): Promise<Instrument> => {
      const instId = instrumentId(symbol);
      const cached = rules.get(symbol), time = now();
      if (cached && time >= cached.expiresAt - ruleTtlMs && time < cached.expiresAt) return { ...cached.instrument };
      const data = await publicRead('/api/v5/public/instruments', { instType: 'SWAP', instId }, signal);
      if (data.length !== 1) throw new ShapeError(`合约目录里没有唯一的 ${instId}`);
      const row = record(data[0], '合约');
      // post_only state takes post-only orders only, so its market cap is unusable; only live trades here.
      if (row.instId !== instId || row.instType !== 'SWAP' || row.ctType !== 'linear' || row.settleCcy !== 'USDT' || row.ctValCcy !== symbol.slice(0, -4) || row.state !== 'live') throw new ShapeError(`${instId} 当前不可交易或不是 USDT 线性永续`);
      const fields = {
        contractSize: mul(amount(row.ctVal, '合约面值'), amount(row.ctMult, '合约乘数')), tickSize: amount(row.tickSz, '价格步长'), quantityStep: amount(row.lotSz, '数量步长'),
        minQuantity: amount(row.minSz, '最小数量'), maxQuantity: amount(row.maxLmtSz, '限价最大数量'), maxMarketQuantity: amount(row.maxMktSz, '市价最大数量'),
        // maxLmtAmt / maxMktAmt are USD, not USDT; OKX states no minimum notional for these swaps.
        minNotional: '0',
      };
      if (isZero(fields.contractSize)) throw new ShapeError('合约面值无效');
      const instrument: Instrument = { venue: 'okx', symbol, kind: 'linear-perpetual', settleAsset: 'USDT', ...fields, catalogVersion: `ok-${createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 16)}` };
      rules.set(symbol, { instrument, expiresAt: now() + ruleTtlMs });
      return { ...instrument };
    }),

    quote: (symbol: string, { signal }: CallOptions) => reading(async (): Promise<Quote> => {
      const instId = instrumentId(symbol);
      const data = await publicRead('/api/v5/market/books', { instId, sz: '1' }, signal);
      const receivedAt = now();
      if (data.length !== 1) throw new ShapeError('盘口不是一条记录');
      const book = record(data[0], '盘口');
      const level = (side: unknown, name: string): string => {
        const levels = list(side, name, 1), top = list(levels[0], name, 4);
        if (levels.length !== 1 || top.length < 2) throw new ShapeError(`${name}缺失`);
        amount(top[1], `${name}数量`);
        return amount(top[0], name);
      };
      const bid = level(book.bids, '买一价'), ask = level(book.asks, '卖一价');
      if (cmp(bid, ask) >= 0) throw new ShapeError('盘口买一不低于卖一');
      return { venue: 'okx', symbol, bid, ask, sourceTime: millis(book.ts, '盘口时间'), receivedAt, connectionGeneration: 0, sequence: null, complete: true };
    }),

    account: (binding: AccountBinding, symbols: readonly string[], { signal }: CallOptions) => reading(async (): Promise<AccountSnapshot> => {
      if (symbols.length === 0 || symbols.some(symbol => !VENUE_EXECUTION_SYMBOLS.okx.includes(symbol))) throw new VenueError('read-failed', '账户快照的合约无效');
      const config = await readConfig(binding, signal);
      const positions: Position[] = [], openOrders: OpenOrder[] = [], positionModes: Record<string, Mode> = {}, seenOrders = new Set<string>();
      for (const symbol of symbols) {
        const instId = instrumentId(symbol);
        // Orders before positions: one that fills between the reads still shows up in the later position read.
        let after = '';
        for (let page = 0; ; page++) {
          if (page >= MAX_ORDER_PAGES) throw new ShapeError(`活动委托超过 ${MAX_ORDER_PAGES} 页`);
          const data = list(await rows(binding, '/api/v5/trade/orders-pending', { instType: 'SWAP', instId, limit: String(PAGE_SIZE), ...(after ? { after } : {}) }, signal), '活动委托', PAGE_SIZE);
          for (const item of data) {
            const row = record(item, '活动委托');
            if (row.instId !== instId) throw new ShapeError('活动委托合约与请求不一致');
            const id = identifier(row.ordId, '交易所订单号');
            if (!Object.hasOwn(ORDER_WORKING, row.state as string)) throw new ShapeError(`活动委托状态 ${String(row.state).slice(0, 32)} 无法识别`);
            if (seenOrders.has(id)) throw new ShapeError('活动委托重复');
            seenOrders.add(id);
            const clOrdId = typeof row.clOrdId === 'string' && /^[\x21-\x7e]{1,64}$/.test(row.clOrdId) ? row.clOrdId : null;
            openOrders.push({ symbol, clientOrderId: clOrdId === null ? null : fromClOrdId(clOrdId) ?? clOrdId, remoteId: id });
          }
          if (data.length < PAGE_SIZE) break;
          after = identifier(record(data.at(-1), '活动委托').ordId, '分页编号');
        }
        // Any working strategy order may place orders at any time, so each one counts as foreign activity (workbench).
        for (const ordType of ALGO_TYPES) {
          for (const item of list(await rows(binding, '/api/v5/trade/orders-algo-pending', { instType: 'SWAP', instId, ordType, limit: String(PAGE_SIZE) }, signal), '策略委托', PAGE_SIZE)) {
            const row = record(item, '策略委托');
            if (row.instId !== instId) throw new ShapeError('策略委托合约与请求不一致');
            openOrders.push({ symbol, clientOrderId: null, remoteId: `algo-${identifier(row.algoId, '策略委托编号')}` });
          }
        }
        positionModes[symbol] = config.mode;
        for (const { side, quantity } of await positionRows(binding, symbol, config.mode, signal)) positions.push({ symbol, side, quantity });
      }
      return { venue: 'okx', accountId: config.uid, positionModes, positions, openOrders, receivedAt: now() };
    }),

    async place(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      const refuse = (message: string): never => { throw new VenueError('not-sent', `OKX 委托未发送：${message}`); };
      if (!VENUE_EXECUTION_SYMBOLS.okx.includes(request.symbol) || !INSTRUMENT_IDS[request.symbol]) refuse(`${request.symbol} 不是可执行合约`);
      const clOrdId = toClOrdId(request.clientOrderId);
      if (!clOrdId) return refuse('客户订单号格式无效');
      try { amount(request.quantity, '数量'); if (request.limitPrice !== null) amount(request.limitPrice, '限价'); } catch { refuse('数量或价格无效'); }
      if (request.type === 'market' && (request.limitPrice !== null || request.timeInForce === 'gtc' || request.timeInForce === 'gtx')) refuse('市价单不带限价，只能 IOC');
      if (request.type === 'limit' && request.limitPrice === null) refuse('限价单缺少价格');
      credentialsOf(binding, true);
      const mode = await modeFor(binding, signal);
      if (mode === 'hedge' && hedgeClose(request.side, request.positionSide) !== request.reduceOnly) refuse('双向持仓模式下只减仓标记与仓位方向不一致');
      if (mode === 'one-way' && positionSideOf(request.side, request.reduceOnly) !== request.positionSide) refuse('单向持仓模式下仓位方向与买卖方向、只减仓标记不一致');
      const body = {
        instId: INSTRUMENT_IDS[request.symbol], tdMode: binding.accountMode, clOrdId, side: request.side, posSide: mode === 'one-way' ? 'net' : request.positionSide,
        ordType: ordTypeOf(request), sz: request.quantity, ...(request.type === 'limit' ? { px: request.limitPrice } : {}), ...(mode === 'one-way' ? { reduceOnly: request.reduceOnly } : {}),
      };
      const remoteId = ackOf(await signed(binding, 'POST', '/api/v5/trade/order', body, { signal, beforeSend }), clOrdId, '下单');
      // The create answers only an acknowledgement. One read gives the first state; when it fails the acceptance is
      // reported as a new order with nothing filled, which the executor reconciles by client id like any working order.
      let row: unknown = null;
      try { row = await findOrder(binding, request, signal); }
      catch (error) { if (!(error instanceof VenueError && error.kind === 'read-failed')) throw error; }
      if (row !== null) {
        const report = orderReport(row, binding, request, mode, 'uncertain');
        if (report.remoteId !== remoteId) throw new VenueError('uncertain', 'OKX 同一客户订单号查到的委托编号与下单回执不一致');
        return report;
      }
      return { clientOrderId: request.clientOrderId, remoteId, symbol: request.symbol, side: request.side, quantity: request.quantity, filledQuantity: '0', averagePrice: null, status: 'new', terminal: false, updatedAt: now() + offset };
    },

    async query(binding: AccountBinding, request: OrderRequest, { signal }: CallOptions): Promise<OrderReport | null> {
      if (!VENUE_EXECUTION_SYMBOLS.okx.includes(request.symbol)) throw new VenueError('read-failed', `${request.symbol} 不是可执行合约`);
      const row = await findOrder(binding, request, signal);
      return row === null ? null : orderReport(row, binding, request, null, 'read-failed');
    },

    async cancel(binding: AccountBinding, request: OrderRequest, { signal, beforeSend }: SendOptions): Promise<OrderReport> {
      const clOrdId = toClOrdId(request.clientOrderId);
      if (!VENUE_EXECUTION_SYMBOLS.okx.includes(request.symbol) || !INSTRUMENT_IDS[request.symbol] || !clOrdId) throw new VenueError('not-sent', 'OKX 撤单未发送：合约或客户订单号无效');
      ackOf(await signed(binding, 'POST', '/api/v5/trade/cancel-order', { instId: INSTRUMENT_IDS[request.symbol], clOrdId }, { signal, beforeSend }), clOrdId, '撤单');
      // The cancel answers only an acknowledgement; without a readable order the outcome stays open and is read again later.
      let row: unknown;
      try { row = await findOrder(binding, request, signal); } catch (error) { throw new VenueError('uncertain', `OKX 撤单已受理，委托回报读取失败：${describe(error)}`); }
      if (row === null) throw new VenueError('uncertain', 'OKX 撤单已受理，但查不到该委托');
      return orderReport(row, binding, request, null, 'uncertain');
    },

    pnlPositions: (binding: AccountBinding, symbols: readonly string[], { signal }: CallOptions) => reading(async (): Promise<PnlSnapshot> => {
      if (symbols.length === 0 || symbols.some(symbol => !VENUE_EXECUTION_SYMBOLS.okx.includes(symbol))) throw new VenueError('read-failed', '盈亏持仓的合约无效');
      const config = await readConfig(binding, signal), positions: PnlPosition[] = [];
      for (const symbol of symbols) {
        for (const { row, side, quantity } of await positionRows(binding, symbol, config.mode, signal)) {
          positions.push({ symbol, side, quantity, entryPrice: optionalPrice(row.avgPx, '开仓均价'), markPrice: optionalPrice(row.markPx, '标记价格'), unrealizedPnl: cashAmount(row.upl, '未实现盈亏') });
        }
      }
      return { venue: 'okx', accountId: config.uid, positions, receivedAt: now() };
    }),

    /**
     * Bills of the last 3 months (bills-archive), newest first, 100 a page, paged backwards by billId. Funding (8) carries
     * its signed payment in pnl; trades (2), liquidations (5), ADL (9) and block trades (14) carry closing pnl and a signed
     * fee; isolated margin moves (6) are not PnL. Any other type is refused by name, never left out (L093).
     */
    ledger: (binding: AccountBinding, symbol: string, window: { from: number; to: number }, { signal }: CallOptions) => reading(async (): Promise<LedgerEntry[]> => {
      const instId = instrumentId(symbol);
      if (!Number.isSafeInteger(window.from) || !Number.isSafeInteger(window.to) || window.from < 0 || window.to <= window.from) throw new VenueError('read-failed', '账单读取的合约或时间窗无效');
      const entries = new Map<string, LedgerEntry>();
      const cash = (value: unknown, name: string): string => value === undefined || value === null || value === '' ? '0' : cashAmount(value, name);
      const put = (entry: LedgerEntry): void => {
        if (isZero(entry.amount)) return;
        const previous = entries.get(entry.id);
        if (previous && (previous.time !== entry.time || cmp(previous.amount, entry.amount) !== 0)) throw new ShapeError('同一账单编号出现不同内容');
        entries.set(entry.id, entry);
      };
      let after = '', previousId: bigint | null = null;
      for (let page = 1; ; page++) {
        if (page > BILL_MAX_PAGES) throw new ShapeError(`账单超过 ${BILL_MAX_PAGES} 页仍未读完`);
        await paceBills(signal);
        const data = list(await rows(binding, '/api/v5/account/bills-archive', {
          instType: 'SWAP', instId, ccy: 'USDT', ctType: 'linear', begin: String(window.from), end: String(window.to), limit: String(PAGE_SIZE), ...(after ? { after } : {}),
        }, signal), '账单', PAGE_SIZE);
        for (const item of data) {
          const row = record(item, '账单');
          if (row.instId !== instId || row.instType !== 'SWAP') throw new ShapeError('账单合约与请求不一致');
          if (row.ccy !== 'USDT') throw new ShapeError('账单币种不是 USDT，无法计入');
          const billId = identifier(row.billId, '账单编号');
          if (!/^\d{1,30}$/.test(billId) || (previousId !== null && BigInt(billId) >= previousId)) throw new ShapeError('账单编号不是严格递减');
          previousId = BigInt(billId);
          const time = millis(row.ts, '账单时间');
          if (time < window.from || time > window.to) throw new ShapeError('账单时间超出请求时间窗');
          const type = typeof row.type === 'string' && /^\d{1,4}$/.test(row.type) ? row.type : null;
          if (type === MARGIN_BILL) continue;
          if (type === FUNDING_BILL) {
            const value = cash(row.pnl, '资金费');
            if ((row.subType === '173' && cmp(value, '0') > 0) || (row.subType === '174' && cmp(value, '0') < 0) || (row.subType !== '173' && row.subType !== '174')) throw new ShapeError('资金费账单的子类型与金额方向不一致');
            put({ id: `${billId}:funding`, time, symbol, kind: 'funding', amount: value });
          } else if (type !== null && TRADE_BILLS.has(type)) {
            put({ id: `${billId}:realized`, time, symbol, kind: 'realized', amount: cash(row.pnl, '平仓盈亏') });
            put({ id: `${billId}:fee`, time, symbol, kind: 'fee', amount: cash(row.fee, '手续费') });
          } else throw new ShapeError(`账单类型 ${type ?? '无效'} 无法归类，暂不计入`);
        }
        if (data.length < PAGE_SIZE) break;
        after = String(previousId);
      }
      return [...entries.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    }),
  };
}
