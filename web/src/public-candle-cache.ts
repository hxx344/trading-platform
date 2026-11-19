/** Only public, closed candle history belongs here. Quotes, books, accounts and order state have separate readers. */
const STORE = 'series';
const READ_BUDGET_MS = 1_200;
let opening: Promise<IDBDatabase | null> | undefined;
let readOpening: Promise<IDBDatabase | null> | undefined;

// Detect damaged persisted data before advertising its server versions. Works on plain HTTP as well as HTTPS.
function checksum(value: unknown): string {
  const json = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 16777619);
  return json.length.toString(36) + '-' + (hash >>> 0).toString(36);
}

function database(waitForOpen = false): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (opening) return waitForOpen ? opening : readOpening!;
  const ready = new Promise<IDBDatabase | null>(resolve => {
    let request: IDBOpenDBRequest;
    try { request = indexedDB.open('trading-platform-public-candles-v1', 1); }
    catch { resolve(null); return; }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ['namespace', 'key'] });
      store.createIndex('bySaved', ['namespace', 'savedAt']);
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = readOpening = undefined; };
      resolve(db);
    };
  });
  opening = ready;
  readOpening = new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), READ_BUDGET_MS);
    void ready.then(db => {
      clearTimeout(timer);
      if (db) readOpening = ready;
      else opening = readOpening = undefined;
      resolve(db);
    });
  });
  return waitForOpen ? ready : readOpening;
}

/** Memory handles navigation immediately. IndexedDB is optional and is bounded independently for each kind of chart. */
export function createPublicCandleCache<V>(namespace: string, limit: number) {
  const memory = new Map<string, V>();
  const pending = new Map<string, Promise<V | undefined>>();
  const waitingWrites = new Map<string, string>(), deleting = new Set<string>();
  const marker = (key: string) => `trading-platform:candle-version:${JSON.stringify([namespace, key])}`;
  function version(key: string) {
    try { return localStorage.getItem(marker(key)); } catch { return undefined; }
  }
  function revoke(key: string, expected?: string) {
    try { if (!expected || version(key) === expected) localStorage.removeItem(marker(key)); } catch { /* Storage is optional. */ }
  }
  function keep(key: string, value: V) {
    memory.delete(key); memory.set(key, value);
    if (memory.size > limit) memory.delete(memory.keys().next().value!);
  }
  function load(key: string): Promise<V | undefined> {
    if (memory.has(key)) return Promise.resolve(memory.get(key));
    const token = version(key);
    if (!token) { if (token === null) eraseUnversioned(key); return Promise.resolve(undefined); }
    const reading = pending.get(key);
    if (reading) return reading;
    const started = Date.now();
    const flight = database().then(db => db && new Promise<V | undefined>(resolve => {
      const transaction = db.transaction(STORE);
      const get = transaction.objectStore(STORE).get([namespace, key]);
      const timer = setTimeout(() => {
        resolve(undefined);
        try { transaction.abort(); } catch { /* already completed */ }
      }, Math.max(0, READ_BUDGET_MS - (Date.now() - started)));
      get.onsuccess = () => {
        clearTimeout(timer);
        const entry = get.result;
        try { resolve(entry?.version === token && version(key) === token && entry.checksum === checksum(entry.value) ? entry.value : undefined); }
        catch { resolve(undefined); }
      };
      get.onerror = () => { clearTimeout(timer); resolve(undefined); };
    })).then(value => {
      if (value != null && pending.get(key) === flight) keep(key, value);
      return memory.get(key);
    }).catch(() => memory.get(key)).finally(() => {
      if (pending.get(key) === flight) pending.delete(key);
    });
    pending.set(key, flight);
    return flight;
  }
  function put(key: string, value: V) {
    pending.delete(key);
    if (memory.get(key) === value) return;
    keep(key, value);
    // A persisted row may be shown only with its matching version. Revocation needs no new disk space.
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(marker(key), token); } catch { revoke(key); return; }
    const waiting = waitingWrites.has(key);
    waitingWrites.set(key, token);
    if (waiting) return;
    void database(true).then(db => {
      const latest = waitingWrites.get(key), data = memory.get(key);
      waitingWrites.delete(key);
      if (!db || !latest || version(key) !== latest || data === undefined) return;
      const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
      const check = store.get([namespace, key]);
      check.onsuccess = () => {
        if (version(key) !== latest) return;
        store.put({ namespace, key, savedAt: Date.now(), version: latest, checksum: checksum(data), value: data });
        const range = IDBKeyRange.bound([namespace, 0], [namespace, Number.MAX_SAFE_INTEGER]);
        const cursor = store.index('bySaved').openCursor(range, 'prev');
        let count = 0;
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if (++count > limit) { if (row.value.version) revoke(row.value.key, row.value.version); row.delete(); }
          row.continue();
        };
      };
    }).catch(() => { /* Private mode or a full disk still leaves the in-memory cache available. */ });
  }
  function eraseUnversioned(key: string) {
    if (deleting.has(key)) return;
    deleting.add(key);
    // A delayed cleanup must not delete a newer authorized value written in another tab.
    void database(true).then(db => db && new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
      const get = store.get([namespace, key]);
      get.onsuccess = () => {
        const current = version(key);
        if (get.result && current !== undefined && (!current || get.result.version !== current)) store.delete([namespace, key]);
      };
    })).catch(() => { /* A row without a matching version remains unreadable. */ }).finally(() => deleting.delete(key));
  }
  function remove(key: string) {
    pending.delete(key); memory.delete(key); revoke(key); eraseUnversioned(key);
  }
  return { peek: (key: string) => memory.get(key), load, put, remove };
}
