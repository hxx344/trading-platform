// The page's login password. Only an scrypt digest is kept, in `login-password` next to the service config (root writes
// it with install.sh --set-password, the service reads it at start through the same owner-and-mode check as its other
// files). Wrong passwords are throttled for the whole process: the tailnet is small, so a lockout that also delays the
// owner for a while is cheaper than guesses at full speed.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { readPrivateFile } from './live/setup.ts';

export const PASSWORD_FILE = 'login-password';
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;
const N = 2 ** 15, R = 8, P = 1, KEY_BYTES = 32, SALT_BYTES = 16;
/** 128·N·r is 32 MiB for the default; the stored parameters are bounded so a hand-edited file cannot ask for more. */
const MAX_MEMORY = 64 * 2 ** 20;
const FORMAT = /^scrypt:(\d{1,8}):(\d{1,2}):(\d{1,2}):([A-Za-z0-9_-]{22,88}):([A-Za-z0-9_-]{43})$/;

export interface PasswordHash { n: number; r: number; p: number; salt: Buffer; key: Buffer }

const derive = (password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> => new Promise((resolve, reject) => {
  scrypt(password.normalize('NFC'), salt, KEY_BYTES, { N: n, r, p, maxmem: MAX_MEMORY }, (error, key) => { if (error) reject(error); else resolve(key); });
});

export function checkPasswordStrength(password: string): void {
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
  if (length > MAX_PASSWORD_LENGTH) throw new Error(`密码最多 ${MAX_PASSWORD_LENGTH} 个字符`);
  if (/[\x00-\x1f\x7f]/.test(password)) throw new Error('密码不能含控制字符');
}

export async function hashPassword(password: string): Promise<string> {
  checkPasswordStrength(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, R, P);
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64url')}:${key.toString('base64url')}`;
}

export function parsePasswordHash(text: string): PasswordHash {
  const match = FORMAT.exec(text.trim());
  if (!match) throw new Error('登录密码文件格式无效，请用 install.sh --set-password 重新设置');
  const [n, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (n < 2 ** 14 || n > 2 ** 17 || (n & (n - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4 || 128 * n * r > MAX_MEMORY / 2) {
    throw new Error('登录密码文件的参数超出范围，请用 install.sh --set-password 重新设置');
  }
  return { n, r, p, salt: Buffer.from(match[4], 'base64url'), key: Buffer.from(match[5], 'base64url') };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH * 2) return false;
  const key = await derive(password, stored.salt, stored.n, stored.r, stored.p);
  return timingSafeEqual(key, stored.key);
}

/** The digest in `path`, or null when no password is set (the file is absent). */
export function loadPasswordHash(path: string, read = readPrivateFile): PasswordHash | null {
  let text: string;
  try { text = read(path, '登录密码文件'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  return parsePasswordHash(text);
}

// Kernel-reported IPv4-mapped addresses share the IPv4 bucket. Other IPv6 clients share a /64.
export function throttleAddress(address: string): string {
  if (!address.includes(':')) return address;
  const host = new URL(`http://[${address.split('%')[0]}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16), low = parseInt(mapped[2]!, 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  const [left, right] = host.split('::');
  const prefix = left ? left.split(':') : [], suffix = right ? right.split(':') : [];
  const parts = [...prefix, ...Array(8 - prefix.length - suffix.length).fill('0'), ...suffix];
  return parts.slice(0, 4).join(':') + '::/64';
}

/** Consecutive wrong passwords allowed before the first lockout. */
export const FREE_FAILURES = 5;
const FIRST_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/** A run of wrong passwords ends after this long without one, so old slips do not add up over days. */
export const FAILURE_MEMORY_MS = 60 * 60_000;

export interface ThrottleLimits { freeFailures: number; firstLockMs: number; maxLockMs: number }
/** One client address: five tries, then 30 s doubling up to 15 min. */
export const ADDRESS_LOGIN_LIMITS: ThrottleLimits = { freeFailures: FREE_FAILURES, firstLockMs: FIRST_LOCK_MS, maxLockMs: MAX_LOCK_MS };
/**
 * Combined failure count; password backoff applies only to sources that previously failed.
 */
export const GLOBAL_LOGIN_LIMITS: ThrottleLimits = { freeFailures: 50, firstLockMs: 5_000, maxLockMs: 60_000 };

/**
 * A counter of wrong passwords: after freeFailures of them in a row, each further one locks login for firstLockMs,
 * doubling up to maxLockMs. A right password or the access-url link clears it, and so does an hour without a wrong one.
 * A restart clears it too, which systemd's restart delay bounds.
 */
export class LoginThrottle {
  private failures = 0;
  private lockedUntil = 0;
  private lastFailure = 0;
  private readonly now: () => number;
  private readonly limits: ThrottleLimits;
  constructor(now: () => number = Date.now, limits: ThrottleLimits = ADDRESS_LOGIN_LIMITS) { this.now = now; this.limits = limits; }
  /** Milliseconds until the next attempt is accepted; 0 when it is now. */
  waitMs(): number { return Math.max(0, this.lockedUntil - this.now()); }
  hasFailures(): boolean { return this.failures > 0 && this.now() - this.lastFailure <= FAILURE_MEMORY_MS; }
  failed(): void {
    if (this.now() - this.lastFailure > FAILURE_MEMORY_MS) this.failures = 0;
    this.lastFailure = this.now();
    this.failures += 1;
    const { freeFailures, firstLockMs, maxLockMs } = this.limits;
    if (this.failures >= freeFailures) this.lockedUntil = this.now() + Math.min(maxLockMs, firstLockMs * 2 ** Math.min(30, this.failures - freeFailures));
  }
  succeeded(): void { this.failures = 0; this.lockedUntil = 0; }
}
