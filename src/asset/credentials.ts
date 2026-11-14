// Sealed exchange credentials of the asset ledger (A-3/A-4). Written after project_aggregation modules/asset/lib/vault.ts
// at 0014655: AES-256-GCM with a 12-byte random iv, the JSON text of the credential as plaintext, the connection's name
// as additional data, stored as the JSON text {iv:number[], cipher:number[]} where cipher is the ciphertext followed by
// the 16-byte tag (what WebCrypto's encrypt returns), so a value sealed by either side opens on the other. Changes:
// - node:crypto instead of WebCrypto (synchronous);
// - no owner: the additional data is the connection name alone ('binance', 'aster', 'aster:<account id>'), where the
//   workbench uses owner + ':' + name;
// - the key is not in a config file but in <data dir>/asset-credential.key (64 hex digits and a newline, mode 0600,
//   the service account's), created the first time a credential is sealed (a connection saved or imported). It is
//   created whole or not at all (written to a private temporary file, then linked into place), so a concurrent reader
//   never sees a half-written key; a key file that is there but not 64 hex digits is an error and never overwritten.
// Like the workbench, the key sits beside the database under the same account: it protects a copy of asset.sqlite that
// leaves the machine on its own, not the account. Nothing here logs; errors name the file or the connection, never a
// credential or the key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, openSync, readSync, rmSync, writeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const CREDENTIAL_KEY_FILE = 'asset-credential.key';
const KEY_TEXT = /^[0-9a-f]{64}$/i;
/** The text the HTTP layer maps to 503 (the workbench's failure() matches "decrypt"), without the crypto library's detail. */
export const UNSEALED_FAILED = '已保存的连接无法解密（decrypt failed），请重新连接';
export const KEY_MISSING = '资产凭据密钥文件 asset-credential.key 不存在（decrypt failed），已保存的连接无法读取，请重新连接';

function readKeyFile(path: string): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${path} 是符号链接，不读取`);
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path} 不是普通文件，不读取`);
    const buffer = Buffer.alloc(256), read = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString('utf8').trim();
    if (!KEY_TEXT.test(text)) throw new Error(`${path} 不是 64 位十六进制密钥，未改动；请恢复原文件，或确认不再需要已保存的连接后删除它再重新连接`);
    return Buffer.from(text, 'hex');
  } finally { closeSync(fd); }
}

/** A new key, linked into place only if no key is there yet; the one that ends up in place is returned. */
function createKeyFile(path: string): Buffer {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, randomBytes(32).toString('hex') + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(temporary, path);
    // The connections sealed next are committed to the database; the key's directory entry must be durable first.
    const dir = openSync(dirname(path), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { rmSync(temporary, { force: true }); }
  const key = readKeyFile(path);
  if (!key) throw new Error(`${path} 创建后读不到`);
  return key;
}

/** The data directory's credential key; created when `create` and absent. Without `create` an absent key is an error. */
export function credentialKey(dataDir: string, { create = false }: { create?: boolean } = {}): Buffer {
  const path = join(dataDir, CREDENTIAL_KEY_FILE);
  const key = readKeyFile(path);
  if (key) return key;
  if (!create) throw new Error(KEY_MISSING);
  return createKeyFile(path);
}

/** Seals `value` (its JSON text) for the connection `name`; the stored text is the workbench vault's format. */
export function seal(value: unknown, name: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const sealed = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ iv: [...iv], cipher: [...sealed] });
}

const bytes = (value: unknown, min: number): Buffer | null =>
  Array.isArray(value) && value.length >= min && value.length <= 1 << 20 && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? Buffer.from(value as number[]) : null;

/** Opens a sealed value of the connection `name`; any failure (another key, another name, damaged text) is UNSEALED_FAILED. */
export function unseal(text: string, name: string, key: Buffer): unknown {
  try {
    const data = JSON.parse(text) as { iv?: unknown; cipher?: unknown };
    const iv = bytes(data?.iv, 12), sealed = bytes(data?.cipher, 17);
    if (!iv || iv.length !== 12 || !sealed) throw new Error('format');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch { throw new Error(UNSEALED_FAILED); }
}

/** Sealing and opening with the key of one data directory, read at each use (created on the first seal). */
export interface Vault { seal(value: unknown, name: string): string; unseal(text: string, name: string): unknown }
export function dataDirVault(dataDir: string): Vault {
  return {
    seal: (value, name) => seal(value, name, credentialKey(dataDir, { create: true })),
    unseal: (text, name) => unseal(text, name, credentialKey(dataDir)),
  };
}

/** The last four characters a page may show for a credential (the workbench's `label`): the key's or wallet's tail. */
export function credentialTail(stored: object): string | undefined {
  const credential = stored as { apiKey?: unknown; walletAddress?: unknown };
  const value = typeof credential.walletAddress === 'string' ? credential.walletAddress : typeof credential.apiKey === 'string' ? credential.apiKey : undefined;
  return value?.slice(-4);
}
