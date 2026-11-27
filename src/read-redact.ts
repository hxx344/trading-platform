// Masks account identifiers in the JSON a read-only token gets (docs/mcp.md 3.2), so they never leave the server. Two
// passes over every value: by value, any 0x hex string of 40 or more digits (an address, a transaction hash or a
// signature) in any string or object key; by field name, the whole value of an identifier field whatever its format.
// Each original becomes a stable alias (an HMAC of it under the token's key), so rows still match up across reads.
import { redactClientAddresses, redactDiagnostic } from './redact-diagnostic.ts';
import { createHmac } from 'node:crypto';

export type AliasKind = 'acct' | 'addr' | 'tx';

/**
 * Field names (compared lowercased, without `_` and `-`) whose value identifies an account. Found in the responses of
 * the read-only routes (docs/mcp.md 3.1); a field added later that identifies an account belongs here too.
 */
export const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set([
  // Wallets and signers (ASTER, on-chain).
  'user', 'users', 'signer', 'signers', 'address', 'addresses', 'wallet', 'walletaddress', 'owner', 'trader', 'accountaddress',
  // Exchange accounts: ids, uids (Gate `user_id`, CrossEx `accountUid`), the ***last4 forms (`account`, `mainAccountId`).
  // An object under one of these names (CrossEx `live.account`) is walked like any other.
  'account', 'accountid', 'accountids', 'accountuid', 'mainaccountid', 'subaccount', 'subaccountid', 'subaccountids', 'subuid', 'uid', 'userid', 'masteruid', 'email',
  // Parts of credentials and where the setup is reached: API key ids and suffixes (Gate, Ondo `hint`), monitor login, URLs.
  'apikey', 'apikeyid', 'keysuffix', 'apikeysuffix', 'hint', 'monitorusername', 'monitorurl', 'url',
]);

const fieldKey = (name: string): string => name.toLowerCase().replace(/[_-]/g, '');
/** True for a field name whose value is masked whatever it holds. */
export const identifierField = (name: string): boolean => IDENTIFIER_FIELDS.has(fieldKey(name));

// By value, anywhere in a string: 0x hex of 40+ digits (an address, a hash, a signature); a masked id `***1234`; and a
// number of 5+ digits right after a word naming an account (the venues' preflight errors in the log name UIDs), unless
// a unit follows it (`子账户 50000 USDT` is an amount).
const HEX_RUN = /0x[0-9a-fA-F]{40,}/g;
const MASKED_ID = /\*{3}[0-9A-Za-z]{1,8}\b/g;
const NAMED_NUMBER = /(UID|uid|Uid|用户|账户|子账户|account|Account)(\s*[:：#=]?\s*)(\d{5,})(?!\d|[.,]\d)(?!\s*(?:(?:USDT|USDC|USD|BTC|ETH|U|ms)(?![A-Za-z0-9\u4e00-\u9fff-])|美元|元|%))/g;
// A number in an identifier field is aliased only when the name says it is an id (`users: 3` is a count).
const NUMERIC_ID = /(id|ids|uid|user|account|owner|trader|signer)$/;

/** The alias of one original: `kind-` and the first 8 hex digits of its HMAC; hex is compared case-insensitively. */
export function aliasOf(key: Buffer, kind: AliasKind, original: string): string {
  const value = kind === 'acct' ? original : original.toLowerCase();
  return `${kind}-${createHmac('sha256', key).update(`${kind}:${value}`).digest('hex').slice(0, 8)}`;
}

export interface Redactor {
  /** A copy of `value` with the identifiers replaced; plain JSON data only (what the routes answer). */
  (value: unknown): unknown;
}

/** `seen` receives each alias with its original, for the page's lookup. */
export function createRedactor(key: Buffer, seen: (alias: string, original: string) => void = () => {}): Redactor {
  const alias = (kind: AliasKind, original: string): string => {
    const name = aliasOf(key, kind, original);
    seen(name, kind === 'acct' ? original : original.toLowerCase());
    return name;
  };
  const text = (value: string): string => value
    .replace(HEX_RUN, run => alias(run.length === 42 ? 'addr' : 'tx', run))
    .replace(MASKED_ID, masked => alias('acct', masked))
    .replace(NAMED_NUMBER, (_, word: string, gap: string, digits: string) => `${word}${gap}${alias('acct', digits)}`);
  const whole = (value: unknown, name: string): unknown => {
    if (typeof value === 'string') {
      if (value === '') return value;
      // An address in an identifier field keeps its own kind, so it gets the same alias as the same address elsewhere.
      if (/^0x[0-9a-fA-F]{40,}$/.test(value)) return text(value);
      return alias('acct', value);
    }
    if (typeof value === 'number' || typeof value === 'bigint') return NUMERIC_ID.test(fieldKey(name)) ? alias('acct', String(value)) : value;
    if (Array.isArray(value)) return value.map(item => whole(item, name));
    if (value !== null && typeof value === 'object') return walk(value);
    return value;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== 'object') return value;
    // toJSON (a Date) gives the value JSON.stringify would write.
    const plain = typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON(): unknown }).toJSON() : value;
    if (plain !== value) return walk(plain);
    const out: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(value)) {
      // Only diagnostics contain transport details. Structured data such as a news link retains its API contract.
      const diagnostic = typeof field === 'string' && /^(?:text|line|message|(?:last)?error|reason|detail|stack|problem|note)$/i.test(name);
      const cleaned = diagnostic ? redactClientAddresses(redactDiagnostic(field)) : field;
      out[text(name)] = identifierField(name) ? whole(cleaned, name) : walk(cleaned);
    }
    return out;
  };
  return walk;
}
