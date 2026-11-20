/** Only display reads participate. The server still authenticates and produces the current view on every request. */
export const READ_CACHE = 'x-pa-read-cache';
export const READ_VERSION = 'x-pa-read-version';
export const READ_BASE = 'x-pa-read-base';

const displayGets = [
  /^\/api\/monitor\/(?:oil|goldoil|hynix|anthropic)\/quote$/,
  /^\/api\/monitor\/(?:oil|hynix)\/(?:funding|exchanges\/[a-z]{1,20}(?:\/funding-history)?)$/,
  /^\/api\/monitor\/perpetual\/(?:quote|summary|fx|paper)$/,
  /^\/api\/asset\/(?:positions|fills|state|ledger|period|history|daily-changes|withdrawals|cash-flows)$/,
  /^\/api\/(?:oil\/pnl|options\/performance|ondo\/rewards|crossex\/instruments|logs(?:\/problems)?)$/,
  /^\/api\/transfer-pairs\/[\w-]{1,64}\/(?:history|balances)$/,
  /^\/api\/adl\/pairs\/[\w-]{1,64}\/incidents$/,
];
const displayPost = /^\/api\/monitor\/perpetual\/(?:metrics|funding-history|scanner-data|quality)$/;

export function isDisplayRead(method: string, path: string): boolean {
  if (method === 'GET') return displayGets.some(pattern => pattern.test(path));
  return method === 'POST' && displayPost.test(path);
}

// String lengths and copy offsets are UTF-16 code units on both sides.
export const MAX_VIEW_LENGTH = 1_048_576;
export const MAX_VIEW_PARTS = 2048;
export type ReadView = { text: string; version: string };
export type ViewPart = string | [offset: number, length: number];

export function versionLength(version: string | null): number {
  if (!version || !/^v1-[0-9a-f]{32}\.[0-9a-z]{1,5}$/.test(version)) return -1;
  const length = parseInt(version.slice(version.lastIndexOf('.') + 1), 36);
  return length > 0 && length <= MAX_VIEW_LENGTH ? length : -1;
}

/** The browser retains only session memory. The executor uses the same bounds for its previous replies. */
export class ReadViewCache {
  private entries = new Map<string, ReadView>();
  private size = 0;

  get(key: string): ReadView | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  delete(key: string): void {
    const old = this.entries.get(key);
    if (old) { this.size -= old.text.length + key.length; this.entries.delete(key); }
  }

  set(key: string, view: ReadView): void {
    this.delete(key);
    if (view.text.length > MAX_VIEW_LENGTH || key.length > 32_768) return;
    this.entries.set(key, view);
    this.size += view.text.length + key.length;
    while (this.size > 4 * MAX_VIEW_LENGTH || this.entries.size > 64) this.delete(this.entries.keys().next().value!);
  }

  clear(): void { this.entries.clear(); this.size = 0; }

  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.delete(key);
  }
}

export function readVersion(digestHex: string, length: number): string {
  return 'v1-' + digestHex.slice(0, 32) + '.' + length.toString(36);
}

export function restoreView(base: string, parts: unknown, length: number): string {
  if (!Array.isArray(parts) || parts.length > MAX_VIEW_PARTS || length < 1 || length > MAX_VIEW_LENGTH) throw Error('数据版本无效');
  const chunks: string[] = [];
  let total = 0;
  for (const part of parts) {
    let chunk: string;
    if (typeof part === 'string') chunk = part;
    else {
      if (!Array.isArray(part) || part.length !== 2) throw Error('增量数据无效');
      const [start, count] = part;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count <= 0 || count > base.length - start) throw Error('增量区间无效');
      chunk = base.slice(start, start + count);
    }
    total += chunk.length;
    if (total > length) throw Error('数据长度无效');
    chunks.push(chunk);
  }
  if (total !== length) throw Error('数据长度无效');
  return chunks.join('');
}
