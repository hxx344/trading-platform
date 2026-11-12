// Real ASTER margin-transfer connector. The main account lists its sub-accounts and sends the transfer; each
// sub-account reads its own balance and income with its own API wallet (as the workbench's Python balancer does;
// reading a sub-account's balance with the main account's authority was never verified live).
import { VenueError, type CallOptions, type SendOptions, type TransferAck, type TransferCapabilities, type TransferConnector, type TransferRequest } from '../connector.ts';
import { ASTER_ADDRESS, TRANSFER_ASSET, type SubAccountList, type TransferBalance, type TransferHistory, type TransferReceipt } from '../contracts.ts';
import { add, cmp, decimal } from '../decimal.ts';
import { isRecord } from '../live/http.ts';
import { ShapeError, describe, identifier, list, millis, record } from '../live/values.ts';
import { classify, TRANSFER_REJECTIONS, type AsterClient, type AsterCredentials, type Failure, type Priority } from './client.ts';

/** Income types that move USD1 between accounts of one main account (Python TRANSFER_TYPES). */
export const ASTER_TRANSFER_TYPES: ReadonlySet<string> = new Set(['TRANSFER', 'SUBUSER_ASSET_TRANSFER']);
export const INCOME_PAGE_ROWS = 1000;
export const INCOME_MAX_PAGES = 8;
/** The signed request stops being accepted this long after it was signed: nonce window plus clock skew (plan §6, unmeasured). */
export const ASTER_REQUEST_VALIDITY_MS = 120_000;

export interface AsterTransferOptions {
  client: AsterClient;
  /** Credentials by account address (lower case); a throw refuses the call before anything is sent. */
  credentials: (accountId: string) => AsterCredentials;
  /** Every configured account address; used only to identify a listing row that carries no wallet address. */
  knownAccounts: () => readonly string[];
  now?: () => number;
}

const fail = (failure: Failure, write: boolean): VenueError => new VenueError(write ? (failure.kind === 'rejected' ? 'rejected' : 'uncertain') : 'read-failed', failure.message);
/** A number is accepted only in plain notation; venue amounts normally arrive as strings. */
function decimalText(value: unknown): string | null {
  const textual = typeof value === 'number' && Number.isFinite(value) && !/e/i.test(String(value)) ? String(value) : value;
  try { return typeof textual === 'string' ? decimal(textual) : null; } catch { return null; }
}

/** The listing's wallet address for one row: every present address field must agree. Null when the row carries none. */
export function rowAddress(row: Record<string, unknown>): string | null {
  const values = new Set<string>();
  for (const key of ['address', 'sourceAddr', 'subSourceAddr', 'walletAddress']) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    if (!ASTER_ADDRESS.test(text)) throw new ShapeError('子账户列表的钱包地址无效');
    values.add(text);
  }
  if (values.size > 1) throw new ShapeError('子账户列表同一行的钱包地址字段互相冲突');
  return values.values().next().value ?? null;
}

export class AsterTransferConnector implements TransferConnector {
  readonly venue = 'aster' as const;
  readonly capabilities: TransferCapabilities = { transport: 'live', clientTransferId: false, requestValidityMs: ASTER_REQUEST_VALIDITY_MS, attribution: 'side-amount-time' };
  private readonly client: AsterClient;
  private readonly credentials: (accountId: string) => AsterCredentials;
  private readonly knownAccounts: () => readonly string[];
  private readonly now: () => number;
  constructor({ client, credentials, knownAccounts, now = Date.now }: AsterTransferOptions) {
    this.client = client; this.credentials = credentials; this.knownAccounts = knownAccounts; this.now = now;
  }

  private creds(accountId: string, write: boolean): AsterCredentials {
    try {
      const found = this.credentials(accountId);
      if (found.user !== accountId) throw new Error('凭据的账户地址与请求不一致');
      return found;
    } catch (error) { throw new VenueError(write ? 'not-sent' : 'read-failed', `账户 ***${accountId.slice(-4)} 没有可用凭据：${describe(error)}`); }
  }

  private async read(accountId: string, path: string, params: Record<string, string>, weight: number, signal: AbortSignal, priority: Priority = 'normal'): Promise<unknown> {
    const reply = await this.client.signed(this.creds(accountId, false), { method: 'GET', path, params, weight, priority, withUser: true }, { signal });
    const failure = classify(reply, TRANSFER_REJECTIONS, this.client.requestBudget, path);
    if (failure) throw fail(failure, false);
    return reply.data;
  }

  /**
   * Every non-parent row of the main account's listing, by wallet address. A row without an address is matched to
   * a configured sub-account through that account's own accountId; a row nothing can identify is left out, so the
   * executor sees the account as missing and refuses.
   */
  async subAccounts(mainAccountId: string, { signal }: CallOptions): Promise<SubAccountList> {
    const data = await this.read(mainAccountId, '/fapi/v3/getSubAccountList', {}, 5, signal);
    try {
      const rows = list(data, '子账户列表', 1_000).map(item => record(item, '子账户列表行'));
      if (!rows.length) throw new ShapeError('子账户列表为空');
      if (rows.some(row => typeof row.parentAccount !== 'boolean')) throw new ShapeError('子账户列表缺少明确的主子账户标记');
      const parents = rows.filter(row => row.parentAccount === true);
      if (parents.length !== 1) throw new ShapeError('子账户列表未唯一标识主账户');
      const parentAddress = rowAddress(parents[0]!);
      if (parentAddress !== null && parentAddress !== mainAccountId) throw new ShapeError('子账户列表的主账户地址与配置不一致');
      const ids = rows.map(row => identifier(row.accountId, '子账户编号'));
      if (new Set(ids).size !== ids.length) throw new ShapeError('子账户列表包含重复的账户编号');
      const subAccounts: SubAccountList['subAccounts'] = [];
      const unaddressed = new Map<string, boolean>();
      rows.forEach((row, index) => {
        if (row.parentAccount === true) return;
        const status = row.status ?? row.subAccountStatus;
        const frozen = status === 'FROZEN' || status === 'FREEZE';
        const address = rowAddress(row);
        if (address === null) unaddressed.set(ids[index]!, frozen);
        else subAccounts.push({ accountId: address, frozen });
      });
      // Python fallback: a configured account whose own accountId matches a row without an address.
      if (unaddressed.size) {
        for (const accountId of this.knownAccounts()) {
          if (accountId === mainAccountId || subAccounts.some(item => item.accountId === accountId)) continue;
          const own = record(await this.read(accountId, '/fapi/v3/accountWithJoinMargin', {}, 5, signal), '账户信息');
          const id = own.accountId === undefined ? null : identifier(own.accountId, '账户编号');
          if (id !== null && unaddressed.has(id)) { subAccounts.push({ accountId, frozen: unaddressed.get(id)! }); unaddressed.delete(id); }
        }
      }
      return { mainAccountId, subAccounts, receivedAt: this.now() };
    } catch (error) {
      if (error instanceof ShapeError) throw new VenueError('read-failed', error.message);
      throw error;
    }
  }

  async balance(_mainAccountId: string, accountId: string, { signal }: CallOptions): Promise<TransferBalance> {
    const data = await this.read(accountId, '/fapi/v3/accountWithJoinMargin', {}, 5, signal);
    try { return { accountId, asset: TRANSFER_ASSET, ...usd1Balance(data), receivedAt: this.now() }; }
    catch (error) { throw error instanceof ShapeError ? new VenueError('read-failed', error.message) : error; }
  }

  /**
   * USD1 transfer rows in [from, to] (closed on both ends, whole-second venue times). A full page is split at its
   * midpoint and both halves read, up to INCOME_MAX_PAGES pages; an open-ended window (to null) cannot be split, so
   * a full page there answers complete false. A row that cannot be classified makes the read incomplete.
   */
  async history(_mainAccountId: string, accountId: string, { from, to }: { from: number; to: number | null }, { signal }: CallOptions): Promise<TransferHistory> {
    const rows = new Map<string, TransferReceipt>();
    let complete = true, pages = 0;
    const windows: [number, number | null][] = [[from, to]];
    while (windows.length) {
      const [low, high] = windows.pop()!;
      if (pages >= INCOME_MAX_PAGES) { complete = false; break; }
      pages++;
      let page: ReturnType<typeof incomePage>;
      try {
        const data = await this.read(accountId, '/fapi/v3/income', { startTime: String(low), ...(high === null ? {} : { endTime: String(high) }), limit: String(INCOME_PAGE_ROWS) }, 30, signal);
        page = incomePage(data);
      } catch (error) {
        // Nothing usable at all is a read failure; a later page that fails keeps what was read, as incomplete.
        if (pages === 1) throw error instanceof ShapeError ? new VenueError('read-failed', error.message) : error;
        complete = false; break;
      }
      for (const row of page.rows) rows.set(`${row.tranId}|${row.direction}|${row.amount}|${row.time}`, row);
      if (!page.complete) complete = false;
      if (page.full) {
        if (high === null || high - low <= 1) { complete = false; continue; }
        const middle = Math.floor((low + high) / 2);
        windows.push([middle, high], [low, middle]);
      }
    }
    return { accountId, rows: [...rows.values()].sort((a, b) => a.time - b.time), complete };
  }

  /** Signed with the main account's API wallet and without `user`, as the Python balancer and the 2.6b probe send it. */
  async transfer(mainAccountId: string, request: TransferRequest, { signal, beforeSend }: SendOptions): Promise<TransferAck> {
    if (request.asset !== TRANSFER_ASSET || !ASTER_ADDRESS.test(request.source) || !ASTER_ADDRESS.test(request.destination) || request.source === request.destination) throw new VenueError('not-sent', '划转请求无效，未发送');
    let value: string;
    try { value = decimal(request.amount, 'positive'); } catch { throw new VenueError('not-sent', '划转金额无效，未发送'); }
    const params = { toAccountAddress: request.destination, asset: TRANSFER_ASSET, amount: value, kindType: 'FUTURE_FUTURE', fromAccountAddress: request.source };
    const reply = await this.client.signed(this.creds(mainAccountId, true), { method: 'POST', path: '/fapi/v3/subAccountTransfer', params, weight: 5, priority: 'normal', withUser: false }, { signal, beforeSend });
    const failure = classify(reply, TRANSFER_REJECTIONS, this.client.requestBudget, 'subAccountTransfer');
    if (failure) throw fail(failure.kind === 'not-found' ? { ...failure, kind: 'unknown' } : failure, true);
    // Success needs code 0/200 with msg "success" (2.6b: the answer carries no tranId). Anything else is unknown, never a refusal.
    const data = reply.data;
    const code = isRecord(data) ? data.code : undefined;
    const confirmed = isRecord(data) && (code === 0 || code === 200 || code === '0' || code === '200') && typeof data.msg === 'string' && data.msg.trim().toLowerCase() === 'success';
    let tranId: string | null = null;
    if (isRecord(data) && data.tranId !== undefined && data.tranId !== null) { try { tranId = identifier(data.tranId, '交易编号'); } catch { tranId = null; } }
    if (tranId !== null && !/^[0-9A-Za-z_-]{1,64}$/.test(tranId)) tranId = null;
    return { confirmed, tranId };
  }
}

/** USD1 balance fields of /fapi/v3/accountWithJoinMargin: equity is marginBalance, or wallet plus unrealized PnL in the same scope. */
export function usd1Balance(data: unknown): Pick<TransferBalance, 'available' | 'equity' | 'maxWithdraw'> {
  const assets = list(record(data, '账户信息').assets, '账户资产').map(item => record(item, '账户资产行')).filter(row => row.asset === TRANSFER_ASSET);
  if (assets.length !== 1) throw new ShapeError('账户信息中没有唯一的 USD1 资产');
  const asset = assets[0]!;
  const field = (key: string): string => { const parsed = decimalText(asset[key]); if (parsed === null) throw new ShapeError(`USD1 ${key} 无效`); return parsed; };
  const available = field('availableBalance');
  const maxWithdraw = field('maxWithdrawAmount');
  if (cmp(maxWithdraw, '0') < 0) throw new ShapeError('USD1 maxWithdrawAmount 为负');
  let equity: string;
  if ('marginBalance' in asset) equity = field('marginBalance');
  else if ('walletBalance' in asset) equity = add(field('walletBalance'), field('unrealizedProfit'));
  else equity = add(field('crossWalletBalance'), field('crossUnPnl'));
  return { available, equity, maxWithdraw };
}

/** One /fapi/v3/income page reduced to USD1 transfer receipts. full: the venue returned a whole page. */
export function incomePage(data: unknown): { rows: TransferReceipt[]; full: boolean; complete: boolean } {
  const raw = list(data, '划转流水', INCOME_PAGE_ROWS);
  const rows: TransferReceipt[] = [];
  let complete = true;
  for (const item of raw) {
    if (!isRecord(item)) { complete = false; continue; }
    const asset = item.asset, kind = item.incomeType;
    // Only a row that is clearly another asset or type may be left out; an unreadable one could be the receipt.
    if (typeof asset !== 'string' || !asset.trim() || typeof kind !== 'string' || !kind.trim()) { complete = false; continue; }
    if (asset !== TRANSFER_ASSET || !ASTER_TRANSFER_TYPES.has(kind)) continue;
    let tranId: string, time: number;
    try { tranId = identifier(item.tranId, '交易编号'); time = millis(item.time, '流水时间'); } catch { complete = false; continue; }
    const signed = decimalText(item.income);
    if (signed === null || cmp(signed, '0') === 0 || !/^[0-9A-Za-z_-]{1,64}$/.test(tranId)) { complete = false; continue; }
    const out = signed.startsWith('-');
    rows.push({ tranId, asset: TRANSFER_ASSET, type: 'transfer', direction: out ? 'out' : 'in', amount: out ? signed.slice(1) : signed, time });
  }
  return { rows, full: raw.length >= INCOME_PAGE_ROWS, complete };
}
