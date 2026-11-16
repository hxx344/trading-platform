// The optional oil part of the service's operator files: config.json `oil` names the Binance/Bybit/OKX execution accounts,
// secrets.json `binance`/`bybit`/`okx` hold their keys. The same rules as the live canary files apply, and no
// message built here carries a key, a secret or a field name read from the key file.
import { ContractError, VENUE_NAMES, VENUES, exactKeys, parseBinding, type AccountBinding, type Venue } from '../contracts.ts';
import { validCredentials, validPassphrase, type LiveCredentials } from '../live/values.ts';

export interface OilConfig { accounts: AccountBinding[] }

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';

/**
 * { accounts: [{ venue, accountId, accountMode, credentialVersion }] }, at most one account per venue. `notionalLimits`, which
 * versions through v0.49.2 required, is still accepted and has no effect: those files load unchanged, and stay loadable after a rollback.
 */
export function parseOilConfig(value: unknown): OilConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, ['accounts'], ['notionalLimits']); } catch (error) { throw new Error(`oil 无效：${reason(error)}`); }
  if (!Array.isArray(raw.accounts) || raw.accounts.length < 1 || raw.accounts.length > VENUES.length) throw new Error(`oil.accounts 须列出 1–${VENUES.length} 个执行账户（${VENUES.map(venue => VENUE_NAMES[venue]).join('、')} 各至多一个）`);
  const accounts = raw.accounts.map((item, index) => {
    try { return parseBinding({ ...exactKeys(item, ['venue', 'accountId', 'accountMode', 'credentialVersion']), environment: 'mainnet' }); }
    catch (error) { throw new Error(`oil.accounts 第 ${index + 1} 个账户无效：${reason(error)}`); }
  });
  if (new Set(accounts.map(account => account.venue)).size !== accounts.length) throw new Error('oil.accounts 每个交易所至多一个账户');
  return { accounts };
}

/** The fields of each venue's entry in the secrets file: OKX keys also carry a passphrase (docs/oil.md section 10). */
export const OIL_SECRET_FIELDS: Record<Venue, readonly string[]> = { binance: ['apiKey', 'apiSecret'], bybit: ['apiKey', 'apiSecret'], okx: ['apiKey', 'apiSecret', 'passphrase'] };

/** The keys of the oil accounts' venues, read from the secrets file's `binance` / `bybit` / `okx` entries; a venue not configured is not read. */
export function parseOilSecrets(value: Record<string, unknown>, venues: readonly Venue[]): Map<Venue, LiveCredentials> {
  const keys = new Map<Venue, LiveCredentials>();
  for (const venue of VENUES) {
    const entry = value[venue], fields = OIL_SECRET_FIELDS[venue];
    if (entry === undefined) {
      if (venues.includes(venue)) throw new Error(`缺少 ${venue} 的密钥（oil.accounts 配置了 ${VENUE_NAMES[venue]} 账户）`);
      continue;
    }
    // Field names are never echoed: a key pasted in place of a name would otherwise reach the message.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== fields.length || !fields.every(field => Object.hasOwn(entry, field))) throw new Error(`${venue} 的字段须恰好为 ${fields.join('、')}`);
    const record = entry as Record<string, unknown>;
    const credentials = { apiKey: record.apiKey, apiSecret: record.apiSecret, ...(venue === 'okx' ? { passphrase: record.passphrase } : {}) } as LiveCredentials;
    if (!validCredentials(credentials) || (venue === 'okx' && !validPassphrase(credentials.passphrase))) throw new Error(`${venue} 的密钥不完整或格式无效${venue === 'okx' ? '（Passphrase 须为 8–128 个可打印 ASCII 字符，首尾不能是空格）' : ''}`);
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
