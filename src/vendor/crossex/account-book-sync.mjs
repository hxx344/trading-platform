const DAY = 86_400_000, OVERLAP = 60_000, PAGE_SIZE = 200, PAGE_BUDGET = 8;

// The checkpoint belongs to live_supplemental's connection version. Only a complete,
// fixed time range advances through. A legacy single-page asOf has no coverage semantics.
export async function syncAccountBook({ record, previous, now, read, timeLeft, current, store, save, verifyUid }) {
  if (!current() || !record.accountUid) throw new Error('UNVERIFIED_ACCOUNT_BOOK');
  let state = previous.accountBookSync;
  if (!state) {
    state = { uid: record.accountUid, since: Math.max(0, now - DAY), through: null, pending: null };
    save({ accountBookSync: state });
  }
  if (state.uid !== record.accountUid || now < (state.through ?? state.since)) throw new Error('INVALID_ACCOUNT_BOOK_CHECKPOINT');
  const pending = state.pending;
  const target = pending?.target ?? Math.min(now, (state.through ?? state.since) + DAY);
  const from = pending?.from ?? Math.max(state.since, (state.through ?? state.since) - OVERLAP);
  const to = pending?.to ?? target;
  if (to > now) throw new Error('ACCOUNT_BOOK_CLOCK_REGRESSED');
  const records = new Map();
  async function page(query, destination = records) {
    if (!current()) throw new Error('CONNECTION_CHANGED');
    const rows = await read(query);
    if (!Array.isArray(rows) || rows.length > query.limit) throw new Error('INVALID_ACCOUNT_BOOK_PAGE');
    let repeated = false;
    for (const entry of rows) {
      verifyUid(entry?.user_id, record.accountUid);
      const stamp = Number(entry?.create_time);
      if (!entry?.id || !Number.isSafeInteger(stamp) || stamp < (query.from ?? 0) || stamp > query.to) throw new Error('INVALID_ACCOUNT_ENTRY');
      if (destination.has(entry.id)) repeated = true;
      destination.set(entry.id, entry);
    }
    return { count: rows.length, repeated };
  }
  function narrowWindow() {
    // Retry the unread interval with a smaller range. At a single millisecond a full
    // page still cannot prove coverage, so the checkpoint stays put.
    const next = { from, to: from + Math.floor((to - from) / 2), target };
    save({ accountBookSync: { ...state, pending: next }, accountBookError: to === from
      ? '同一毫秒的流水分页尚未核实，保留上次同步进度' : '账户流水分页尚未核实，下一轮缩小时间范围继续同步' });
  }
  for (let n = 1; n <= PAGE_BUDGET; n++) {
    let result;
    try { result = await page({ from, to, page: n, limit: PAGE_SIZE }); }
    catch (error) {
      if (n > 1 && timeLeft() <= 1 && current()) { narrowWindow(); return; }
      throw error;
    }
    if (!current()) return;
    if (result.repeated || n === PAGE_BUDGET && result.count === PAGE_SIZE) {
      narrowWindow();
      return;
    }
    if (result.count < PAGE_SIZE) break;
  }
  if (!current()) return;
  const through = Math.max(state.through ?? 0, to);
  const next = to < target ? { from: to + 1, to: target, target } : null;
  const olderLimit = state.olderLimit ?? (state.through === null && state.since > 0 ? PAGE_SIZE - Math.min(PAGE_SIZE, records.size) : 0);
  const progress = { ...state, through, pending: next, olderLimit };
  const lag = through < now ? '账户流水正在按时间补齐，已保留本地记录' : null;
  function commit(entries, checkpoint, error, older = false) {
    store.transaction(() => {
      const upsert = store.prepare(older ? 'INSERT INTO live_account_book VALUES (?,?,?,?) ON CONFLICT(version,id) DO NOTHING'
        : `INSERT INTO live_account_book VALUES (?,?,?,?) ON CONFLICT(version,id) DO UPDATE SET created_at=excluded.created_at, json=excluded.json`);
      for (const entry of entries.values()) upsert.run(record.version, entry.id, Number(entry.create_time), JSON.stringify(entry));
      save({ accountBookSync: checkpoint, accountBookAsOf: through, accountBookError: error });
    });
  }
  // Commit the completed range even when the separate, older display page fails or times out.
  commit(records, progress, olderLimit ? '较早的账户流水仍待补齐' : lag);
  if (!olderLimit || timeLeft() <= 1) return;
  try {
    const older = new Map();
    const result = await page({ to: state.since - 1, limit: olderLimit }, older);
    if (current() && !result.repeated) commit(older, { ...progress, olderLimit: 0 }, lag, true);
  } catch { /* The completed range and the pending older page are already durable. */ }
}
