import { READ_BASE, READ_VERSION, ReadViewCache, readVersion, restoreView, versionLength } from '../../src/read-view.ts';

const views = new ReadViewCache();
const pending = new Map<string, { readers: number; latest: number }>();

async function contentVersion(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  // Plain HTTP on a LAN has no SubtleCrypto. Use the existing SHA-256 implementation there.
  if (!globalThis.crypto?.subtle) {
    const { sha256 } = await import('ethers/crypto');
    return readVersion(sha256(bytes).slice(2), text.length);
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return readVersion(Array.from(digest.subarray(0, 16), b => b.toString(16).padStart(2, '0')).join(''), text.length);
}

export function invalidateReadViews(key?: string): void {
  if (key === undefined) { views.clear(); pending.clear(); }
  else { views.delete(key); pending.delete(key); }
}

// A completed edit can use its last body as a delta base. Changing the account, login or monitor scope drops it.
export function invalidateMutationReads(path: string, finished: boolean): void {
  const monitor = /^\/api\/monitor\/(oil|hynix|anthropic|perpetual)\//.exec(path);
  const prefix = path.startsWith('/api/asset/') ? '/api/asset/' : monitor?.[0] ?? '/api/';
  const changesScope = /^\/api\/(?:asset\/(?:connections|aster-accounts|import)(?:\/|$)|import$)/.test(path) ||
    Boolean(monitor && /\/(?:control|variational\/session)$/.test(path));
  if (changesScope) views.deletePrefix(prefix);
  // The ledger can show its saved values while a valuation sync is still contacting exchanges.
  if (!changesScope && !finished) return;
  for (const key of pending.keys()) if (key.startsWith(prefix)) pending.delete(key);
}

/** A saved body can only be used after the server has answered this particular read. */
export async function readDisplayView<T>(key: string, request: (known: string) => Promise<Response>, signal: AbortSignal): Promise<T> {
  const group = pending.get(key) ?? { readers: 0, latest: 0 };
  pending.set(key, group);
  group.readers++;
  const order = ++group.latest;
  const current = () => {
    signal.throwIfAborted();
    if (pending.get(key) !== group) throw Error('数据已更新，请重新读取');
  };
  let base = views.get(key);
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await request(base?.version ?? '1');
      current();
      const version = response.headers.get(READ_VERSION);
      const from = response.headers.get(READ_BASE);
      const length = versionLength(version);
      const partial = response.status === 204 || from !== null;
      try {
        let text: string;
        if (response.status === 204) {
          if (!base || from !== null || version !== base.version) throw Error('缺少已核对的数据版本');
          text = base.text;
        } else if (from !== null) {
          if (!base || base.version !== from || length < 0) throw Error('缺少增量数据对应的版本');
          text = restoreView(base.text, await response.json(), length);
        } else text = await response.text();
        current();
        if (version !== null && (length !== text.length || response.status !== 204 && await contentVersion(text) !== version)) throw Error('数据版本无效');
        current();
        const data = JSON.parse(text);
        if (data === null) throw Error('数据为空');
        if (group.latest === order) {
          if (version) views.set(key, { version, text });
          else views.delete(key);
        }
        return data as T;
      } catch {
        current();
        // A dropped baseline or broken patch gets one full read under the original deadline.
        if (group.latest === order) views.delete(key);
        if ((!partial && version === null) || attempt !== 0) throw Error('响应无法解析，稍后自动重试');
        base = undefined;
      }
    }
  } finally {
    if (--group.readers === 0 && pending.get(key) === group) pending.delete(key);
  }
}
