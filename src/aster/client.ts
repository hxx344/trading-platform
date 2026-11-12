// Real ASTER futures v3 transport: request budget, EIP-712 signing and answer classification shared by the
// transfer, ADL and positions connectors. Endpoints, weights and the codes that prove a refusal mirror the
// workbench's production Python client (modules/aster/trading/exchange.py, margin_balance.py), which runs live.
import { VenueError } from '../connector.ts';
import { ASTER_ADDRESS } from '../contracts.ts';
import { exchange, isRecord, type FetchLike, type HttpReply } from '../live/http.ts';
import { addressOf, pythonUrlencode, signAsterMessage } from './eip712.ts';

export const ASTER_REST = 'https://fapi.asterdex.com';
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;

/** One ASTER API wallet: the account's own address, the API signer address and the signer's private key. */
export interface AsterCredentials { user: string; signer: string; privateKey: string }

/** Lower-cases and checks a credential set; the key must derive the signer, which must differ from the user. */
export function parseAsterCredentials(value: unknown, name: string): AsterCredentials {
  if (!isRecord(value)) throw new Error(`${name} 凭据须为对象`);
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'privateKey,signer,user') throw new Error(`${name} 凭据只能包含 user、signer、privateKey`);
  const field = (key: 'user' | 'signer' | 'privateKey', pattern: RegExp): string => {
    const raw = value[key];
    const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    const normalized = key === 'privateKey' && /^[0-9a-f]{64}$/.test(text) ? '0x' + text : text;
    if (!pattern.test(normalized)) throw new Error(`${name} 的 ${key} 格式无效`);
    return normalized;
  };
  const credentials = { user: field('user', ASTER_ADDRESS), signer: field('signer', ASTER_ADDRESS), privateKey: field('privateKey', PRIVATE_KEY) };
  if (addressOf(credentials.privateKey) !== credentials.signer) throw new Error(`${name} 的私钥推导出的地址与 signer 不一致`);
  if (credentials.signer === credentials.user) throw new Error(`${name} 的 signer 不能是账户地址本身（须使用 API 钱包）`);
  return credentials;
}

// ---- request budget -------------------------------------------------------------------------------
export type Priority = 'adl' | 'normal';
export interface BudgetOptions {
  /** Request weight per rolling minute this process may use on the shared exit IP. */
  limitPerMinute: number;
  /** Weight per minute only ADL reads and reductions may use. */
  adlReserve: number;
  now?: () => number;
}

/**
 * Rolling one-minute request weight on this process's exit IP, which the workbench's ASTER module shares: the
 * process stays under its own limit and stops sending entirely while the venue asks it to back off. A request the
 * budget refuses never leaves the process.
 */
/**
 * The venue's per-IP limit is 2400 a minute; the workbench stops at 1800 by its own count of the same header, so this
 * process yields once the shared IP nears the limit, keeping the last part for ADL.
 */
export const IP_CEILING = 2_100;
const IP_CEILING_ADL = 2_350;

export class RequestBudget {
  private readonly spent: { at: number; weight: number }[] = [];
  /** The exit IP's weight this minute as the venue last reported it (X-MBX-USED-WEIGHT-1M), workbench use included. */
  private reported: { minute: number; weight: number } | null = null;
  private coolUntil = 0;
  private coolReason = '';
  readonly limitPerMinute: number;
  readonly adlReserve: number;
  private readonly now: () => number;
  constructor({ limitPerMinute, adlReserve, now = Date.now }: BudgetOptions) {
    if (!Number.isSafeInteger(limitPerMinute) || limitPerMinute < 100 || limitPerMinute > 2400) throw new Error('ASTER 每分钟请求权重上限须为 100–2400');
    if (!Number.isSafeInteger(adlReserve) || adlReserve < 0 || adlReserve >= limitPerMinute) throw new Error('ADL 保留权重须为非负整数且小于每分钟上限');
    this.limitPerMinute = limitPerMinute; this.adlReserve = adlReserve; this.now = now;
  }
  private used(at: number): number {
    while (this.spent.length && this.spent[0]!.at <= at - 60_000) this.spent.shift();
    return this.spent.reduce((sum, item) => sum + item.weight, 0);
  }
  /** Returns the refusal message, or null after recording the weight as spent. */
  take(weight: number, priority: Priority): string | null {
    const at = this.now();
    if (at < this.coolUntil) return `ASTER 接口冷却中（${this.coolReason}），约 ${Math.ceil((this.coolUntil - at) / 1000)} 秒后恢复`;
    const ceiling = priority === 'adl' ? this.limitPerMinute : this.limitPerMinute - this.adlReserve;
    if (this.used(at) + weight > ceiling) return `本进程 ASTER 请求额度已用完（每分钟 ${ceiling}），稍后重试`;
    const shared = this.reported && this.reported.minute === Math.floor(at / 60_000) ? this.reported.weight : 0;
    const ipCeiling = priority === 'adl' ? IP_CEILING_ADL : IP_CEILING;
    if (shared + weight > ipCeiling) return `出口 IP 本分钟 ASTER 请求权重已用 ${shared}（含工作台），超过 ${ipCeiling}，稍后重试`;
    this.spent.push({ at, weight });
    return null;
  }
  /** Records the IP's usage the venue reported with an answer; within a minute the highest report counts (answers arrive out of order). */
  observe(weight: number): void {
    if (!Number.isSafeInteger(weight) || weight < 0) return;
    const minute = Math.floor(this.now() / 60_000);
    if (this.reported?.minute === minute && this.reported.weight >= weight) return;
    this.reported = { minute, weight };
  }
  cooldown(ms: number, reason: string): void {
    const until = this.now() + ms;
    if (until > this.coolUntil) { this.coolUntil = until; this.coolReason = reason; }
  }
  state(): { usedLastMinute: number; limitPerMinute: number; coolingUntil: number | null; reason: string | null } {
    const at = this.now();
    return { usedLastMinute: this.used(at), limitPerMinute: this.limitPerMinute, coolingUntil: at < this.coolUntil ? this.coolUntil : null, reason: at < this.coolUntil ? this.coolReason : null };
  }
}

// ---- answer classification -----------------------------------------------------------------------
/** Codes ASTER answers when a request was refused before it changed anything (Python REJECTION_CODES, transfers). */
export const TRANSFER_REJECTIONS: ReadonlySet<number> = new Set([-1002, -1003, -1011, -1015, -1020, -1022, -1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1130, -2014, -2015, -2019]);
/** Order POST/DELETE refusals (Python ORDER_REJECTION_CODES). Every other code leaves a write uncertain. */
export const ORDER_REJECTIONS: ReadonlySet<number> = new Set([
  -1002, -1003, -1011, -1015, -1020, -1022, -1100, -1101, -1102, -1103, -1104, -1105, -1106, -1111, -1121, -1130,
  -2014, -2015, -2019, -2027, -2028, -4028, -2010, -2029, -5018,
]);
export const NOT_FOUND_CODE = -2013;
const RATE_LIMIT_CODES = new Set([-1003, -1015]);
const GATEWAY_COOLDOWN_MS: Record<number, number> = { 403: 30_000, 429: 180_000, 418: 86_400_000 };

/** Venue text for notes and alerts: no control characters, addresses, signatures, long tokens or links. */
export function venueText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/https?:\/\/\S+/gi, '[链接]').replace(/0x[0-9a-f]{6,}/gi, '0x…').replace(/[A-Za-z0-9+/=_-]{32,}/g, '…').slice(0, 120);
}

export type Failure = { kind: 'not-found' | 'rejected' | 'unknown'; code: number | null; message: string };

function retryAfterMs(reply: HttpReply & { retryAfter?: string | null }): number {
  const seconds = Number(reply.retryAfter ?? '');
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 86_400_000) : 0;
}

/** null for a success answer; otherwise what the answer proves. Also starts the budget's back-off on rate limits. */
export function classify(reply: HttpReply & { retryAfter?: string | null }, rejections: ReadonlySet<number>, budget: RequestBudget, label: string): Failure | null {
  const data = reply.data;
  const raw = isRecord(data) ? data.code : undefined;
  const code = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
  const negative = code !== null && code < 0;
  if (reply.status >= 200 && reply.status < 300 && !negative) return null;
  const gateway = GATEWAY_COOLDOWN_MS[reply.status];
  if (gateway !== undefined) budget.cooldown(Math.max(gateway, retryAfterMs(reply)), `${label} HTTP ${reply.status}`);
  if (code !== null && RATE_LIMIT_CODES.has(code)) budget.cooldown(Math.max(180_000, retryAfterMs(reply)), `${label} 错误码 ${code}`);
  const detail = isRecord(data) && typeof data.msg === 'string' ? `：${venueText(data.msg)}` : '';
  const message = `ASTER HTTP ${reply.status}${code === null ? '' : ` 错误码 ${code}`}${detail}`;
  // A gateway refusal or rate limit, whatever body comes with it, is classed before the code as the Python client does
  // for 429/418: a rate-limited write stays unknown and is checked rather than ending the ADL incident as rejected.
  if (gateway !== undefined || (code !== null && RATE_LIMIT_CODES.has(code))) return { kind: 'unknown', code, message };
  if (code === NOT_FOUND_CODE && (reply.status === 400 || reply.status === 404 || reply.status === 200)) return { kind: 'not-found', code, message };
  if (reply.status >= 500 || reply.status === 408 || code === null || !negative) return { kind: 'unknown', code, message };
  return { kind: rejections.has(code) ? 'rejected' : 'unknown', code, message };
}

// ---- client ---------------------------------------------------------------------------------------
export interface AsterClientOptions {
  budget: RequestBudget;
  fetchImpl?: FetchLike;
  /** Per HTTP exchange. */
  timeoutMs?: number;
  /** Wall clock in microseconds for the nonce; tests pin it. */
  microseconds?: () => bigint;
  base?: string;
}
export interface SignedRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  params: Record<string, string>;
  weight: number;
  priority: Priority;
  /** Transfers are signed without `user` (Python margin_balance.signed_parameters). */
  withUser: boolean;
}

/**
 * Signs and sends one request. A mutation passes `beforeSend`; it runs synchronously right before fetch, so any
 * refusal there or by the budget proves nothing was sent. From the fetch call on, a mutation's failure is uncertain.
 */
export class AsterClient {
  private readonly budget: RequestBudget;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly microseconds: () => bigint;
  private readonly base: string;
  /** One nonce sequence for every signer of the process: strictly increasing, microseconds like the Python client. */
  private lastNonce = 0n;
  constructor({ budget, fetchImpl, timeoutMs = 8_000, microseconds = () => BigInt(Date.now()) * 1000n + BigInt(Math.floor((performance.now() % 1) * 1000)), base = ASTER_REST }: AsterClientOptions) {
    this.budget = budget; this.fetchImpl = fetchImpl ?? ((url, init) => fetch(url, init)); this.timeoutMs = timeoutMs; this.microseconds = microseconds; this.base = base;
  }
  get requestBudget(): RequestBudget { return this.budget; }

  private nonce(): string {
    const now = this.microseconds();
    this.lastNonce = now > this.lastNonce ? now : this.lastNonce + 1n;
    return this.lastNonce.toString();
  }

  /** The exact parameters sent: caller's, then nonce, user (unless withUser false), signer and signature. */
  sign(credentials: AsterCredentials, request: Pick<SignedRequest, 'params' | 'withUser'>): Record<string, string> {
    for (const key of ['nonce', 'user', 'signer', 'signature']) if (Object.hasOwn(request.params, key)) throw new VenueError('not-sent', `签名参数不能由调用方提供：${key}`);
    const data: Record<string, string> = { ...request.params, nonce: this.nonce(), ...(request.withUser ? { user: credentials.user } : {}), signer: credentials.signer };
    return { ...data, signature: signAsterMessage(pythonUrlencode(data), credentials.privateKey) };
  }

  async signed(credentials: AsterCredentials, request: SignedRequest, { signal, beforeSend }: { signal: AbortSignal; beforeSend?: () => void }): Promise<HttpReply & { retryAfter: string | null }> {
    const mutation = beforeSend !== undefined;
    if (signal.aborted) throw new VenueError(mutation ? 'not-sent' : 'read-failed', '请求已取消，未发送');
    const refused = this.budget.take(request.weight, request.priority);
    if (refused) throw new VenueError(mutation ? 'not-sent' : 'read-failed', refused);
    let params: Record<string, string>;
    try { params = this.sign(credentials, request); }
    catch (error) { throw error instanceof VenueError ? error : new VenueError(mutation ? 'not-sent' : 'read-failed', '请求无法在本地签名，未发送'); }
    const encoded = pythonUrlencode(params);
    const get = request.method === 'GET';
    return this.send({
      url: `${this.base}${request.path}${get ? `?${encoded}` : ''}`, method: request.method,
      headers: get ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }, ...(get ? {} : { body: encoded }),
    }, { signal, beforeSend });
  }

  async public(path: string, params: Record<string, string>, weight: number, priority: Priority, signal: AbortSignal): Promise<HttpReply & { retryAfter: string | null }> {
    if (signal.aborted) throw new VenueError('read-failed', '请求已取消，未发送');
    const refused = this.budget.take(weight, priority);
    if (refused) throw new VenueError('read-failed', refused);
    const query = pythonUrlencode(params);
    return this.send({ url: `${this.base}${path}${query ? `?${query}` : ''}`, method: 'GET' }, { signal });
  }

  private async send(request: { url: string; method: SignedRequest['method']; headers?: Record<string, string>; body?: string }, options: { signal: AbortSignal; beforeSend?: () => void }): Promise<HttpReply & { retryAfter: string | null }> {
    let retryAfter: string | null = null;
    // Reads the headers before the body: a gateway refusal often has no JSON, and its back-off must start regardless.
    const fetchImpl: FetchLike = async (url, init) => {
      const response = await this.fetchImpl(url, init);
      retryAfter = response.headers.get('retry-after');
      const used = response.headers.get('x-mbx-used-weight-1m');
      if (used !== null && /^[0-9]{1,9}$/.test(used)) this.budget.observe(Number(used));
      const gateway = GATEWAY_COOLDOWN_MS[response.status];
      if (gateway !== undefined) this.budget.cooldown(Math.max(gateway, retryAfterMs({ status: response.status, data: null, retryAfter })), `HTTP ${response.status}`);
      return response;
    };
    const reply = await exchange(fetchImpl, this.timeoutMs, request, options);
    return { ...reply, retryAfter };
  }
}
