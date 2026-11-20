import { READ_BASE, READ_VERSION, ReadViewCache, readVersion, restoreView, versionLength, type ReadView } from '../../src/read-view.ts';

const views = new ReadViewCache();
const pending = new Map<string, { readers: number; latest: number; revision: number }>();

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
  for (const [key, group] of pending) {
    if (!key.startsWith(prefix)) continue;
    if (changesScope) pending.delete(key);
    else group.revision++;
  }
}

async function decodeView<T>(response: Response, base: ReadView | undefined, version: string | null, from: string | null) {
  const length = versionLength(version);
  let text: string;
  if (response.status === 204) {
    if (!base || from !== null || version !== base.version) throw Error('缺少已核对的数据版本');
    text = base.text;
  } else if (from !== null) {
    if (!base || base.version !== from || length < 0) throw Error('缺少增量数据对应的版本');
    text = restoreView(base.text, await response.json(), length);
  } else text = await response.text();
  if (version !== null && (length !== text.length || response.status !== 204 && await contentVersion(text) !== version)) throw Error('数据版本无效');
  const data = JSON.parse(text);
  if (data === null) throw Error('数据为空');
  return { text, data: data as T };
}

/** A saved body can only be used after the server has answered this particular read. */
export async function readDisplayView<T>(key: string, request: (known: string) => Promise<Response>, signal: AbortSignal): Promise<T> {
  const group = pending.get(key) ?? { readers: 0, latest: 0, revision: 0 };
  pending.set(key, group);
  group.readers++;
  const order = ++group.latest;
  const current = () => {
    signal.throwIfAborted();
    if (pending.get(key) !== group) throw Error('数据已更新，请重新读取');
  };
  let base = views.get(key);
  let retriedWrite = false, retriedBody = false;
  const retryAfterWrite = () => {
    if (retriedWrite) throw Error('数据持续更新，本次读取未完成');
    retriedWrite = true;
    base = views.get(key);
  };
  try {
    for (;;) {
      const revision = group.revision;
      let response: Response;
      try { response = await request(base?.version ?? '1'); }
      catch (error) {
        // A permission response already removed this group. Its original status must reach the page.
        if (signal.aborted || pending.get(key) !== group || group.revision === revision) throw error;
        retryAfterWrite();
        continue;
      }
      current();
      const version = response.headers.get(READ_VERSION);
      const from = response.headers.get(READ_BASE);
      let decoded;
      if (group.revision === revision) decoded = await decodeView<T>(response, base, version, from).catch(() => undefined);
      else void response.body?.cancel().catch(() => {});
      current();
      // A same-scope write can finish while fetching or verifying the body. Only a new server read may settle it.
      if (group.revision !== revision) {
        retryAfterWrite();
        continue;
      }
      if (decoded) {
        if (group.latest === order) {
          if (version) views.set(key, { version, text: decoded.text });
          else views.delete(key);
        }
        return decoded.data;
      }
      // A dropped baseline or broken patch gets one full read under the same deadline.
      if (group.latest === order) views.delete(key);
      if (retriedBody || (response.status !== 204 && from === null && version === null)) throw Error('响应无法解析，稍后自动重试');
      retriedBody = true;
      base = undefined;
    }
  } finally {
    if (--group.readers === 0 && pending.get(key) === group) pending.delete(key);
  }
}
