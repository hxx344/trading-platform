// The optional oil part of the service's operator files: config.json `oil` names the Binance/Bybit execution accounts,
// secrets.json `binance`/`bybit` hold their keys. The same rules as the live canary files apply, and no
// message built here carries a key, a secret or a field name read from the key file.
import { ContractError, VENUE_NAMES, VENUES, exactKeys, parseBinding, type AccountBinding, type Venue } from '../contracts.ts';
import { validCredentials, type LiveCredentials } from '../live/values.ts';

export interface OilConfig { accounts: AccountBinding[] }

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';

/**
 * { accounts: [{ venue, accountId, accountMode, credentialVersion }] }, at most one account per venue. `notionalLimits`, which
 * versions through v0.49.2 required, is still accepted and has no effect: those files load unchanged, and stay loadable after a rollback.
 */
export function parseOilConfig(value: unknown): OilConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, ['accounts'], ['notionalLimits']); } catch (error) { throw new Error(`oil 无效：${reason(error)}`); }
  if (!Array.isArray(raw.accounts) || raw.accounts.length < 1 || raw.accounts.length > VENUES.length) throw new Error('oil.accounts 须列出 1–2 个执行账户（Binance、Bybit 各至多一个）');
  const accounts = raw.accounts.map((item, index) => {
    try { return parseBinding({ ...exactKeys(item, ['venue', 'accountId', 'accountMode', 'credentialVersion']), environment: 'mainnet' }); }
    catch (error) { throw new Error(`oil.accounts 第 ${index + 1} 个账户无效：${reason(error)}`); }
  });
  if (new Set(accounts.map(account => account.venue)).size !== accounts.length) throw new Error('oil.accounts 每个交易所至多一个账户');
  return { accounts };
}

/** The keys of the oil accounts' venues, read from the secrets file's `binance` / `bybit` entries; a venue not configured is not read. */
export function parseOilSecrets(value: Record<string, unknown>, venues: readonly Venue[]): Map<Venue, LiveCredentials> {
  const keys = new Map<Venue, LiveCredentials>();
  for (const venue of VENUES) {
    const entry = value[venue];
    if (entry === undefined) {
      if (venues.includes(venue)) throw new Error(`缺少 ${venue} 的密钥（oil.accounts 配置了 ${VENUE_NAMES[venue]} 账户）`);
      continue;
    }
    // Field names are never echoed: a key pasted in place of a name would otherwise reach the message.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'apiKey') || !Object.hasOwn(entry, 'apiSecret')) throw new Error(`${venue} 的字段须恰好为 apiKey、apiSecret`);
    const credentials = { apiKey: (entry as Record<string, unknown>).apiKey, apiSecret: (entry as Record<string, unknown>).apiSecret } as LiveCredentials;
    if (!validCredentials(credentials)) throw new Error(`${venue} 的密钥不完整或格式无效`);
    if (venues.includes(venue)) keys.set(venue, credentials);
  }
  return keys;
}

/** For --check-config: the accounts masked; empty without oil so that output stays as it was. */
export function oilSummary(oil: OilConfig | undefined): string {
  if (!oil) return '';
  const accounts = oil.accounts.map(account => `${VENUE_NAMES[account.venue]} ***${account.accountId.slice(-4)}（${account.accountMode}，凭据版本 ${account.credentialVersion}）`).join('、');
  return `，原油执行账户 ${accounts}（不设名义金额上限）`;
}
