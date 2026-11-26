import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import type { ScanCandidate } from './catalog.ts';
import { CHAIN_ARB_TTL_MS, type ChainArbView } from './model.ts';
import { parseChainArbScan, SCAN_HISTORY_MS, type ScanInput, type ScanRow, type ScanView } from './scan-model.ts';

const BATCH_INTERVAL = 2_000;
const BACKOFF = 30_000;
const MAX_PROFILES = 4;
const IDLE_MS = 60_000;
const id = ({ chain, symbol, address }: ScanCandidate) => chain + ':' + symbol + ':' + address;

interface Profile {
  input: ScanInput; seen: number; turn: number; waiting: boolean; retryAt: number; message: string | null;
  cycle: number; total: number; directory: ScanCandidate[] | null; pending: ScanCandidate[]; cursor: number; batches: number;
  checked: Map<string, boolean>; failed: number;
  samples: Map<string, { candidate: ScanCandidate; cycle: number; checkedAt: number; rows: ScanRow[] }>;
}
function profileFor(input: ScanInput, now: number): Profile {
  return { input, seen: now, turn: 0, waiting: true, retryAt: 0, message: null, cycle: 0, total: 0,
    directory: null, pending: [], cursor: 0, batches: 0, checked: new Map(), failed: 0, samples: new Map() };
}

function rateLimited(value: unknown) {
  return value !== null && typeof value === 'object' && (('status' in value && value.status === 429)
    || ('rateLimited' in value && value.rateLimited === true));
}

function routeRows(candidate: ScanCandidate, view: ChainArbView, now: number): ScanRow[] {
  const gasUsdt = view.dex.swapGasUsdt;
  if (gasUsdt == null || !Number.isFinite(gasUsdt) || gasUsdt < 0) return [];
  const rows: ScanRow[] = [];
  for (const kind of ['spot', 'perp'] as const) {
    if (!candidate[kind]) continue;
    const leg = view[kind];
    if ('error' in leg || leg.netUsdt == null || leg.netBps == null) continue;
    if (![leg.coveredCostUsdt, leg.netUsdt, leg.netBps, leg.price, view.dex.price]
      .every(value => Number.isFinite(value) && value > 0)) continue;
    const at = Math.min(leg.at, view.dex.at, view.asOf);
    const expiresAt = at + CHAIN_ARB_TTL_MS;
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
    rows.push({ chain: candidate.chain, symbol: candidate.symbol, address: candidate.address,
      kind, netBps: leg.netBps, netUsdt: leg.netUsdt, dexPrice: view.dex.price,
      gatePrice: leg.price, gasUsdt, at, expiresAt });
  }
  return rows;
}

function prune(profile: Profile, now: number) {
  for (const [key, sample] of profile.samples) {
    sample.rows = sample.rows.filter(row => now - row.at < SCAN_HISTORY_MS);
    if (!sample.rows.length || sample.cycle < profile.cycle - 1) profile.samples.delete(key);
  }
}

function compareRows(a: ScanRow, b: ScanRow) {
  return b.netBps - a.netBps || a.symbol.localeCompare(b.symbol) || a.chain.localeCompare(b.chain)
    || a.address.localeCompare(b.address) || a.kind.localeCompare(b.kind);
}

function snapshot(profile: Profile, now: number, cooldown: boolean): ScanView {
  prune(profile, now);
  const rows: ScanRow[] = [], history: ScanRow[] = [];
  for (const sample of profile.samples.values()) for (const row of sample.rows) {
    (now < row.expiresAt ? rows : history).push(row);
  }
  const phase = cooldown ? 'cooldown' : profile.message ? 'error' : profile.cycle ? 'scanning' : 'loading';
  const message = cooldown ? '公开行情请求受限，稍后继续扫描' : profile.message
    ?? (profile.cycle && !profile.total ? '所选网络没有可扫描的 Gate 币种' : null);
  return { asOf: now, phase, cycle: profile.cycle, total: profile.total, checked: profile.checked.size, failed: profile.failed,
    message, rows: rows.sort(compareRows), history: history.sort((a, b) => b.at - a.at || compareRows(a, b)).slice(0, 50) };
}

export function createChainArbScanner({ catalog, quote, now = Date.now }: {
  catalog: (signal: AbortSignal) => Promise<ScanCandidate[]>;
  quote: (raw: unknown, signal: AbortSignal) => Promise<ChainArbView>; now?: () => number;
}) {
  const profiles = new Map<string, Profile>();
  let currentScope: string | undefined, active: AbortController | undefined, closed = false;
  let nextStart = -Infinity, cooldownUntil = -Infinity, turn = 0;

  async function sample(profile: Profile, candidate: ScanCandidate, ordinary: boolean, signal: AbortSignal) {
    const key = id(candidate);
    let failed = true;
    try {
      const { chain, symbol, address } = candidate;
      const view = await untilAborted(quote({ ...profile.input, chain, symbol, address, swapGas: 'auto' }, signal), signal);
      signal.throwIfAborted();
      if (rateLimited(view.spot) || rateLimited(view.perp)) cooldownUntil = now() + BACKOFF;
      const rows = routeRows(candidate, view, now());
      // Reinsertion makes refreshes rotate from the least recently sampled opportunity.
      profile.samples.delete(key);
      if (rows.length) profile.samples.set(key, { candidate, cycle: profile.cycle, checkedAt: now(), rows });
      failed = view.dex.swapGasUsdt == null || ((!candidate.spot || 'error' in view.spot) && (!candidate.perp || 'error' in view.perp));
    } catch (error) {
      if (rateLimited(error) && !signal.aborted) cooldownUntil = now() + BACKOFF;
      profile.samples.delete(key);
    } finally {
      if (ordinary) {
        profile.checked.set(key, failed);
        if (failed) profile.failed++;
      }
    }
  }

  async function run(profile: Profile, signal: AbortSignal) {
    const nextCycle = !profile.cycle || profile.cursor >= profile.pending.length;
    // The catalog owns its TTL (including HTTP Age). A cache hit returns the same array.
    // An updated directory can withdraw a candidate even in a long-running first sweep.
    const candidates = await untilAborted(catalog(signal), signal);
    signal.throwIfAborted();
    // All open rankings consume the same directory. Retract a closed route even when another profile fetched the update.
    for (const open of profiles.values()) {
      if (open !== profile && !open.cycle) continue;
      if (open === profile && nextCycle) {
        open.cycle++; open.checked.clear(); open.failed = 0;
      } else if (candidates === open.directory) continue;
      const directory = new Map(candidates.filter(c => open.input.chain === 'all' || c.chain === open.input.chain)
        .map(c => [id(c), c]));
      for (const [key, sample] of open.samples) {
        const allowed = directory.get(key);
        if (allowed) {
          sample.candidate = allowed;
          sample.rows = sample.rows.filter(row => allowed[row.kind]);
        }
        if (!allowed || !sample.rows.length) open.samples.delete(key);
      }
      for (const [key, failed] of open.checked) if (!directory.has(key)) {
        open.checked.delete(key);
        if (failed) open.failed--;
      }
      open.total = directory.size;
      open.pending = [...directory.values()].filter(c => !open.checked.has(id(c)));
      open.cursor = 0; open.directory = candidates; open.message = null;
      open.retryAt = directory.size ? 0 : now() + BACKOFF;
    }
    if (profile.cursor >= profile.pending.length) return;
    prune(profile, now());
    const first = profile.pending[profile.cursor++];
    const next = profile.pending[profile.cursor];
    let refresh: ScanCandidate | undefined;
    if (++profile.batches % 2 === 0) {
      for (const [key, previous] of profile.samples) {
        if (now() - previous.checkedAt >= CHAIN_ARB_TTL_MS / 2 && key !== id(first) && (!next || key !== id(next))) {
          refresh = previous.candidate; break;
        }
      }
    }
    // A slow directory refresh must not allow the following pair of quotes to start immediately after this pair.
    nextStart = now() + BATCH_INTERVAL;
    const batch = [sample(profile, first, true, signal)];
    if (refresh) batch.push(sample(profile, refresh, false, signal));
    else if (next) { profile.cursor++; batch.push(sample(profile, next, true, signal)); }
    await Promise.all(batch);
  }

  function start(nowMs: number) {
    if (active || nowMs < nextStart || nowMs < cooldownUntil) return;
    const profile = [...profiles.values()].filter(p => p.waiting && p.retryAt <= nowMs && nowMs - p.seen < 8_000)
      .sort((a, b) => a.turn - b.turn)[0];
    if (!profile) return;
    const stop = new AbortController();
    const signal = anySignal([stop.signal], 25_000);
    active = stop; nextStart = nowMs + BATCH_INTERVAL;
    profile.waiting = false; profile.turn = ++turn;
    void run(profile, signal).catch(error => {
      if (stop.signal.aborted) return;
      if (rateLimited(error)) cooldownUntil = now() + BACKOFF;
      profile.directory = null; profile.samples.clear();
      profile.message = signal.aborted ? '币种目录读取超时' : error instanceof Error ? error.message : '币种目录读取失败';
      profile.retryAt = now() + 10_000;
    }).finally(() => { stop.abort(); active = undefined; });
  }

  return {
    async read(raw: unknown, scope: string, signal: AbortSignal): Promise<ScanView> {
      signal.throwIfAborted();
      if (closed) throw Object.assign(new Error('机会扫描已停止'), { status: 503 });
      const input = parseChainArbScan(raw);
      if (scope !== currentScope) {
        profiles.clear(); active?.abort(); currentScope = scope;
      }
      const time = now(), key = JSON.stringify(input);
      for (const [id, p] of profiles) if (time - p.seen >= IDLE_MS) profiles.delete(id);
      let profile = profiles.get(key);
      if (!profile) {
        if (profiles.size >= MAX_PROFILES) {
          const [oldKey, oldest] = [...profiles].sort((a, b) => a[1].seen - b[1].seen)[0];
          if (time - oldest.seen < 8_000) throw Object.assign(new Error('扫描配置已满，请稍后再试'), { status: 429 });
          profiles.delete(oldKey);
        }
        profile = profileFor(input, time); profiles.set(key, profile);
      }
      profile.seen = time; profile.waiting = true;
      start(time);
      return snapshot(profile, time, time < cooldownUntil);
    },
    close() { closed = true; profiles.clear(); active?.abort(); },
  };
}
