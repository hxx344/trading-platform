// Entropy 真实成交、实扣手续费与账户费率采集（docs/dexspread.md 第 17 节）：
// 定期与下单成交后同步 Hyperliquid `io:*` 成交明细、`userFees` 与交易时刻 HYPE 价格，落库到 varlighter.sqlite，
// 供下次双周 HYPE 返佣发放时直接核算真实返佣率与真实单边/往返交易成本。
// 账户隔离与保密：仅用主账户地址做公开只读查询，落库按地址小写的 SHA-256 截断摘要归档，绝不把地址明文写进库、日志、接口或报错。
import { createHash } from 'node:crypto';
import { ENTROPY_ENDPOINTS, readJson, type FetchLike } from './feeds.ts';
import type { MarketSpec } from './model.ts';
import type { StoredEntropyFeeSnapshot, StoredEntropyFill, VarLighterStore } from './store.ts';
import { ParamsError } from './strategy.ts';
import type { EntropyCostSummary, EntropyCostView, EntropyFillView } from './views.ts';

export const ENTROPY_COST_SYNC_KEY = 'entropy_cost_sync';
export const ENTROPY_COST_POLL_MS = 5 * 60_000;
export const ENTROPY_COST_AFTER_FILL_MS = 8_000;
const MANUAL_SYNC_DEBOUNCE_MS = 5_000;
const MANUAL_WAIT_MS = 7_000;
const DEFAULT_LOOKBACK_DAYS = 14;
const INITIAL_SYNC_DAYS = 30;
const CURSOR_OVERLAP_MS = 60_000;
const RECENT_FILL_MS = 15 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 6 * 3_600_000;
const MAX_FILLS_PAGE = 2000;
const MAX_FILL_REQUESTS = 5;
const MIN_SPLIT_WINDOW_MS = 1_000;
const INFO_LIMIT = 4 * 1024 * 1024;
const MAX_CANDLE_SPAN_MS = 180 * 86_400_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export interface ParsedUserFees {
  userCrossRate: number | null;
  userAddRate: number | null;
  referralDiscount: number | null;
  stakingDiscount: number | null;
}

export interface ParsedEntropyFill {
  tid: number; oid: number; cloid: string | null; time: number; coin: string; side: 'B' | 'A'; dir: string | null;
  crossed: boolean; px: number; sz: number; notionalUsd: number; feeUsd: number; feeToken: string;
  builderFeeUsd: number; closedPnl: number | null;
}

export interface EntropyCostSyncState {
  cursorMs: number; lastSyncAt: number | null; lastOkAt: number | null; incomplete: boolean; error: string | null;
  probeStartMs?: number | null; probeEndMs?: number | null; pendingQueue?: [number, number][] | null;
}

export interface EntropyCostSyncResult {
  ok: boolean; configured: boolean; added: number; incomplete: boolean; pending?: boolean; error: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 64 || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const nonNegative = (value: unknown): number | null => { const parsed = decimal(value); return parsed !== null && parsed >= 0 ? parsed : null; };
const positive = (value: unknown): number | null => { const parsed = decimal(value); return parsed !== null && parsed > 0 ? parsed : null; };
const safeInt = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

export const accountHashOf = (address: string): string =>
  createHash('sha256').update(address.trim().toLowerCase()).digest('hex').slice(0, 16);

export function scrubAddress(text: string, address?: string | null): string {
  let clean = text;
  if (address) clean = clean.replaceAll(address.trim(), '[account]').replaceAll(address.trim().toLowerCase(), '[account]');
  return clean.replace(/0x[0-9a-fA-F]{16,}/g, '[hex]').slice(0, 200);
}

export function parseHyperliquidUserFees(input: unknown): ParsedUserFees {
  if (!isRecord(input)) throw new Error('Entropy 账户费率格式无效');
  const staking = isRecord(input.activeStakingDiscount) ? nonNegative(input.activeStakingDiscount.discount) : null;
  return {
    userCrossRate: nonNegative(input.userCrossRate),
    userAddRate: decimal(input.userAddRate),
    referralDiscount: nonNegative(input.activeReferralDiscount),
    stakingDiscount: staking,
  };
}

export function parseHypeMid(input: unknown): number | null {
  if (!isRecord(input)) throw new Error('Entropy 行情中位价格式无效');
  return positive(input.HYPE);
}

export function parseHypeHourlyCandles(input: unknown): Map<number, number> {
  if (!Array.isArray(input)) throw new Error('HYPE K 线格式无效');
  const map = new Map<number, number>();
  for (const row of input) {
    if (!isRecord(row)) continue;
    const t = safeInt(row.t), close = positive(row.c);
    if (t !== null && t > 0 && close !== null) map.set(Math.floor(t / HOUR_MS) * HOUR_MS, close);
  }
  return map;
}

/**
 * 解析 Hyperliquid `userFillsByTime` 应答：只提取 `io:` 市场，其余市场跳过；
 * 对 `io:` 市场逐项严格校验，发现损坏记录计入 `invalidCount`，避免静默漏算并阻止游标前推（L093）。
 */
export function parseEntropyFills(input: unknown): { fills: ParsedEntropyFill[]; totalReturned: number; invalidCount: number } {
  if (!Array.isArray(input)) throw new Error('Entropy 成交记录格式无效');
  const fills: ParsedEntropyFill[] = [];
  let invalidCount = 0;
  for (const raw of input) {
    if (!isRecord(raw) || typeof raw.coin !== 'string' || !raw.coin) { invalidCount++; continue; }
    if (!raw.coin.startsWith('io:')) continue;
    const tid = safeInt(raw.tid), oid = safeInt(raw.oid), time = safeInt(raw.time);
    const side = raw.side === 'B' || raw.side === 'A' ? raw.side : null;
    const px = positive(raw.px), sz = positive(raw.sz), feeUsd = decimal(raw.fee);
    const feeToken = typeof raw.feeToken === 'string' && raw.feeToken.trim() ? raw.feeToken.trim().slice(0, 24) : null;
    const builderFeeUsd = raw.builderFee === undefined || raw.builderFee === null ? 0 : decimal(raw.builderFee);
    const crossed = typeof raw.crossed === 'boolean' ? raw.crossed : null;
    if (tid === null || tid < 0 || oid === null || oid < 0 || time === null || time <= 0 || !side || px === null || sz === null || feeUsd === null || !feeToken || builderFeeUsd === null || crossed === null) {
      invalidCount++;
      continue;
    }
    const rawCloid = typeof raw.cloid === 'string' && raw.cloid.trim() && raw.cloid.length <= 80 ? raw.cloid.trim() : null;
    const cloid = rawCloid ? (rawCloid.startsWith('0x') || rawCloid.startsWith('0X') ? rawCloid.toLowerCase() : rawCloid) : null;
    const dir = typeof raw.dir === 'string' && raw.dir.trim() ? raw.dir.trim().slice(0, 64) : null;
    const closedPnl = raw.closedPnl === undefined || raw.closedPnl === null ? null : decimal(raw.closedPnl);
    fills.push({ tid, oid, cloid, time, coin: raw.coin.slice(0, 40), side, dir, crossed, px, sz, notionalUsd: px * sz, feeUsd, feeToken, builderFeeUsd, closedPnl });
  }
  return { fills, totalReturned: input.length, invalidCount };
}

function medianOf(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

export interface EntropyCostCollectorDeps {
  store: VarLighterStore;
  fetchImpl: FetchLike;
  now: () => number;
  signalFor: () => AbortSignal;
  stopSignal?: AbortSignal;
  manualWaitMs?: number;
  entropyAccount: () => string | null;
  assumedFeeBps: () => number | null;
  markets: () => readonly MarketSpec[];
  log?: (line: string) => void;
}

export function createEntropyCostCollector(deps: EntropyCostCollectorDeps) {
  const { store, fetchImpl, now, signalFor, log = () => {} } = deps;
  const manualWaitMs = deps.manualWaitMs ?? MANUAL_WAIT_MS;
  const inFlight = new Map<string, Promise<EntropyCostSyncResult>>();
  const lastManual = new Map<string, { at: number; result: EntropyCostSyncResult }>();

  const readSyncMap = (): Record<string, EntropyCostSyncState> => {
    const raw = store.state<unknown>(ENTROPY_COST_SYNC_KEY);
    return isRecord(raw) ? { ...(raw as Record<string, EntropyCostSyncState>) } : {};
  };
  const emptySync = (): EntropyCostSyncState => ({ cursorMs: 0, lastSyncAt: null, lastOkAt: null, incomplete: false, error: null, probeStartMs: null, probeEndMs: null, pendingQueue: null });
  const readSync = (hash: string): EntropyCostSyncState => {
    const entry = readSyncMap()[hash];
    const pendingQueue = Array.isArray(entry?.pendingQueue)
      ? entry.pendingQueue.filter((item): item is [number, number] => Array.isArray(item) && item.length === 2 && typeof item[0] === 'number' && Number.isFinite(item[0]) && typeof item[1] === 'number' && Number.isFinite(item[1]) && item[0] <= item[1])
      : null;
    return isRecord(entry) && typeof entry.cursorMs === 'number'
      ? {
          cursorMs: entry.cursorMs, lastSyncAt: entry.lastSyncAt ?? null, lastOkAt: entry.lastOkAt ?? null,
          incomplete: !!entry.incomplete, error: entry.error ?? null,
          probeStartMs: typeof entry.probeStartMs === 'number' && Number.isFinite(entry.probeStartMs) ? entry.probeStartMs : null,
          probeEndMs: typeof entry.probeEndMs === 'number' && Number.isFinite(entry.probeEndMs) ? entry.probeEndMs : null,
          pendingQueue: pendingQueue?.length ? pendingQueue : null,
        }
      : emptySync();
  };
  const writeSync = (hash: string, next: EntropyCostSyncState, at: number): void => {
    const all = readSyncMap();
    all[hash] = next;
    store.setState(ENTROPY_COST_SYNC_KEY, all, at);
  };

  const validAddress = (): string | null => {
    const raw = deps.entropyAccount()?.trim() ?? '';
    return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
  };
  const marketByCoin = (coin: string): MarketSpec | undefined =>
    deps.markets().find(item => (item.coin ?? `io:${item.symbol}`) === coin);

  function shouldRecordSnapshot(prev: StoredEntropyFeeSnapshot | null, next: Omit<StoredEntropyFeeSnapshot, 'id'>): boolean {
    if (!prev) return true;
    if (next.at - prev.at >= SNAPSHOT_MAX_AGE_MS) return true;
    for (const key of ['userCrossRate', 'userAddRate', 'referralDiscount', 'stakingDiscount', 'assumedFeeBps'] as const) {
      if (prev[key] !== next[key]) return true;
    }
    if (next.hypePriceUsd !== null && (prev.hypePriceUsd === null || Math.abs(next.hypePriceUsd - prev.hypePriceUsd) / prev.hypePriceUsd >= 0.01)) return true;
    return false;
  }

  async function runSync(address: string, hash: string): Promise<EntropyCostSyncResult> {
    const tNow = now();
    const prevSync = readSync(hash);
    const errors: string[] = [];
    const safeErr = (label: string, error: unknown) => `${label}：${scrubAddress(error instanceof Error ? error.message : String(error), address)}`;

    // 并行拉取费率配置与当前 HYPE 中位价；任一路失败不拖累成交流水同步。
    let fees: ParsedUserFees | null = null;
    let hypeMid: number | null = null;
    await Promise.all([
      readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), INFO_LIMIT, {}, { type: 'userFees', user: address })
        .then(raw => { fees = parseHyperliquidUserFees(raw); })
        .catch(error => { errors.push(safeErr('账户费率读取失败', error)); }),
      readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), INFO_LIMIT, {}, { type: 'allMids' })
        .then(raw => { hypeMid = parseHypeMid(raw); })
        .catch(error => { errors.push(safeErr('HYPE 行情读取失败', error)); }),
    ]);

    const prevSnap = store.latestEntropyFeeSnapshot(hash);
    const currentAssumed = deps.assumedFeeBps();
    const f = fees as ParsedUserFees | null;
    const effectiveFees: ParsedUserFees | null = f ?? (prevSnap ? {
      userCrossRate: prevSnap.userCrossRate,
      userAddRate: prevSnap.userAddRate,
      referralDiscount: prevSnap.referralDiscount,
      stakingDiscount: prevSnap.stakingDiscount,
    } : null);
    if (f !== null || hypeMid !== null) {
      const snap: Omit<StoredEntropyFeeSnapshot, 'id'> = {
        accountHash: hash, at: tNow,
        userCrossRate: effectiveFees?.userCrossRate ?? null,
        userAddRate: effectiveFees?.userAddRate ?? null,
        referralDiscount: effectiveFees?.referralDiscount ?? null,
        stakingDiscount: effectiveFees?.stakingDiscount ?? null,
        hypePriceUsd: hypeMid ?? (prevSnap?.hypePriceUsd ?? null),
        assumedFeeBps: currentAssumed,
      };
      if (shouldRecordSnapshot(prevSnap, snap)) store.addEntropyFeeSnapshot(snap);
    }

    // 增量拉取 io:* 成交：遇到 2000 条满页自动二分前半窗口，最多发 MAX_FILL_REQUESTS 次请求；跨轮次持久化二分队列与前缀边界，确保游标单调推进（L093）。
    const baseStart = prevSync.cursorMs > 0
      ? Math.max(0, prevSync.cursorMs - CURSOR_OVERLAP_MS)
      : Math.max(0, tNow - INITIAL_SYNC_DAYS * DAY_MS);
    const savedQueue = prevSync.pendingQueue;
    const queueValid = !!savedQueue && savedQueue.length <= 64
      && savedQueue[0]![0] >= (prevSync.cursorMs > 0 ? baseStart : 0)
      && (prevSync.cursorMs > 0 || tNow - savedQueue[0]![0] <= (INITIAL_SYNC_DAYS + 7) * DAY_MS)
      && savedQueue.every(([s, e], i) => s >= 0 && s <= e && e <= tNow && (i === 0 || savedQueue[i - 1]![1] < s));
    let queue: [number, number][];
    if (queueValid) {
      queue = savedQueue!.map(([s, e]) => [s, e] as [number, number]);
      const lastEnd = queue.at(-1)![1];
      if (lastEnd < tNow) {
        if (queue.length >= 40) queue[queue.length - 1] = [queue.at(-1)![0], tNow];
        else queue.push([lastEnd + 1, tNow]);
      }
    } else {
      const rawProbeStart = typeof prevSync.probeStartMs === 'number' && Number.isFinite(prevSync.probeStartMs) ? prevSync.probeStartMs : null;
      const validProbeStart = rawProbeStart !== null && rawProbeStart <= tNow && (
        prevSync.cursorMs > 0
          ? rawProbeStart >= baseStart
          : rawProbeStart >= 0 && tNow - rawProbeStart <= (INITIAL_SYNC_DAYS + 7) * DAY_MS
      ) ? rawProbeStart : null;
      const startFrom = validProbeStart ?? baseStart;
      const savedProbeEnd = typeof prevSync.probeEndMs === 'number' && Number.isFinite(prevSync.probeEndMs) ? prevSync.probeEndMs : null;
      queue = startFrom > tNow
        ? []
        : savedProbeEnd !== null && savedProbeEnd >= startFrom && savedProbeEnd < tNow
          ? [[startFrom, savedProbeEnd], [savedProbeEnd + 1, tNow]]
          : [[startFrom, tNow]];
    }
    const collected = new Map<number, ParsedEntropyFill>();
    let requests = 0, incomplete = false, sawInvalid = false, safeCoveredUntil = prevSync.cursorMs;
    let prefixIntact = true;

    while (queue.length && requests < MAX_FILL_REQUESTS) {
      const [winStart, winEnd] = queue.shift()!;
      requests++;
      let parsed: ReturnType<typeof parseEntropyFills>;
      try {
        const raw = await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), INFO_LIMIT, {}, {
          type: 'userFillsByTime', user: address, startTime: winStart, endTime: winEnd, aggregateByTime: false,
        });
        parsed = parseEntropyFills(raw);
      } catch (error) {
        errors.push(safeErr('成交流水读取失败', error));
        incomplete = true;
        prefixIntact = false;
        queue.unshift([winStart, winEnd]);
        break;
      }
      for (const fill of parsed.fills) collected.set(fill.tid, fill);
      if (parsed.invalidCount > 0) {
        sawInvalid = true;
        incomplete = true;
        prefixIntact = false;
        queue.unshift([winStart, winEnd]);
        errors.push(`发现 ${parsed.invalidCount} 条无法解析的成交记录`);
        break;
      }
      if (parsed.totalReturned >= MAX_FILLS_PAGE) {
        if (winEnd - winStart > MIN_SPLIT_WINDOW_MS) {
          const mid = Math.floor((winStart + winEnd) / 2);
          queue.unshift([mid + 1, winEnd]);
          queue.unshift([winStart, mid]);
        } else {
          incomplete = true;
          prefixIntact = false;
          queue.unshift([winStart, winEnd]);
          errors.push('成交记录在 1 秒窗口内达到单页上限 2000 条，无法继续拆分');
          break;
        }
      } else if (prefixIntact) {
        safeCoveredUntil = Math.max(safeCoveredUntil, winEnd);
      }
    }
    if (queue.length) incomplete = true;

    // 历史成交补查交易小时 HYPE 收盘价（绝不用当前价冒充历史价格）。
    const fillsList = [...collected.values()];
    const historicalTimes = fillsList.filter(fill => fill.time < tNow - RECENT_FILL_MS).map(fill => fill.time);
    let hourlyHype = new Map<number, number>();
    if (historicalTimes.length) {
      const minT = Math.max(tNow - MAX_CANDLE_SPAN_MS, Math.min(...historicalTimes));
      const maxT = Math.max(...historicalTimes);
      if (minT <= maxT) {
        const startTime = Math.floor(minT / HOUR_MS) * HOUR_MS;
        const endTime = Math.floor(maxT / HOUR_MS) * HOUR_MS + HOUR_MS;
        try {
          const raw = await readJson(fetchImpl, ENTROPY_ENDPOINTS.info, signalFor(), INFO_LIMIT, {}, {
            type: 'candleSnapshot', req: { coin: 'HYPE', interval: '1h', startTime, endTime },
          });
          hourlyHype = parseHypeHourlyCandles(raw);
        } catch (error) {
          errors.push(safeErr('历史 HYPE 价格读取失败', error));
        }
      }
    }

    const toStore: StoredEntropyFill[] = fillsList.map(fill => {
      const link = fill.cloid ? store.entropyOrderLink(fill.cloid) : null;
      const matched = link && link.accountHash === hash ? link : null;
      const market = marketByCoin(fill.coin);
      const hypePriceUsd = fill.time >= tNow - RECENT_FILL_MS
        ? hypeMid
        : (hourlyHype.get(Math.floor(fill.time / HOUR_MS) * HOUR_MS) ?? null);
      return {
        accountHash: hash,
        tid: fill.tid, oid: fill.oid, cloid: fill.cloid, time: fill.time, coin: fill.coin, side: fill.side, dir: fill.dir,
        crossed: fill.crossed, px: fill.px, sz: fill.sz, notionalUsd: fill.notionalUsd, feeUsd: fill.feeUsd, feeToken: fill.feeToken,
        builderFeeUsd: fill.builderFeeUsd, closedPnl: fill.closedPnl,
        livePositionId: matched?.positionId ?? null, livePurpose: matched?.purpose ?? null,
        assumedFeeBps: matched?.assumedFeeBps ?? currentAssumed,
        catalogFeeBps: matched?.catalogFeeBps ?? market?.takerFeeBps ?? null,
        deployerFeeScale: matched?.deployerFeeScale ?? market?.deployerFeeScale ?? null,
        growthMode: matched?.growthMode ?? market?.growthMode ?? null,
        hlCrossRate: effectiveFees?.userCrossRate ?? null,
        hlReferralDiscount: effectiveFees?.referralDiscount ?? null,
        hlStakingDiscount: effectiveFees?.stakingDiscount ?? null,
        hypePriceUsd,
        recordedAt: tNow,
      };
    });
    const added = store.upsertEntropyFills(toStore);

    const nextCursor = !sawInvalid && prefixIntact ? Math.max(prevSync.cursorMs, safeCoveredUntil) : prevSync.cursorMs;
    const pendingHead = queue[0] ?? null;
    const nextProbeStartMs = pendingHead ? pendingHead[0] : null;
    const nextProbeEndMs = pendingHead && pendingHead[1] < tNow ? pendingHead[1] : null;
    const nextPendingQueue = queue.length ? queue.slice(0, 64) : null;
    const errorText = errors.length ? errors.join('；').slice(0, 300) : null;
    const ok = errors.length === 0 && !incomplete;
    writeSync(hash, {
      cursorMs: nextCursor,
      lastSyncAt: tNow,
      lastOkAt: ok ? tNow : prevSync.lastOkAt,
      incomplete,
      error: errorText,
      probeStartMs: nextProbeStartMs,
      probeEndMs: nextProbeEndMs,
      pendingQueue: nextPendingQueue,
    }, tNow);
    if (errorText) log(`varlighter: Entropy 成本采集提示：${errorText}`);
    return { ok, configured: true, added, incomplete, error: errorText };
  }

  async function sync(force = false): Promise<EntropyCostSyncResult> {
    const address = validAddress();
    if (!address) return { ok: true, configured: false, added: 0, incomplete: false, error: null };
    const hash = accountHashOf(address);
    let task = inFlight.get(hash);
    if (deps.stopSignal?.aborted) {
      if (task && force) return { ok: true, configured: true, added: 0, incomplete: true, pending: true, error: null };
      return { ok: false, configured: true, added: 0, incomplete: true, error: '服务正在停止' };
    }
    if (!task && force) {
      const recent = lastManual.get(hash);
      if (recent && now() - recent.at < MANUAL_SYNC_DEBOUNCE_MS) return recent.result;
    }
    if (!task) {
      task = runSync(address, hash)
        .catch((error): EntropyCostSyncResult => {
          const text = `同步失败：${scrubAddress(error instanceof Error ? error.message : String(error), address)}`;
          log(`varlighter: Entropy 成本采集异常：${text}`);
          return { ok: false, configured: true, added: 0, incomplete: true, error: text };
        })
        .finally(() => { inFlight.delete(hash); });
      inFlight.set(hash, task);
    }
    if (!force) return task;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onStop: (() => void) | undefined;
    try {
      const result = await Promise.race([
        task,
        new Promise<EntropyCostSyncResult>(resolve => {
          const pendingResult = (): EntropyCostSyncResult => ({ ok: true, configured: true, added: 0, incomplete: true, pending: true, error: null });
          timer = setTimeout(() => resolve(pendingResult()), manualWaitMs);
          onStop = () => resolve(pendingResult());
          deps.stopSignal?.addEventListener('abort', onStop, { once: true });
        }),
      ]);
      if (!result.pending) lastManual.set(hash, { at: now(), result });
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onStop) deps.stopSignal?.removeEventListener('abort', onStop);
    }
  }

  function parseWindow(fromRaw: unknown, toRaw: unknown, limitRaw: unknown, tNow: number): { from: number; to: number; limit: number } {
    const parseIntParam = (raw: unknown, name: string): number | null => {
      if (raw === undefined || raw === null || raw === '') return null;
      const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
      if (!/^\d{1,16}$/.test(text)) throw new ParamsError(`${name} 须为非负整数`);
      const value = Number(text);
      if (!Number.isSafeInteger(value)) throw new ParamsError(`${name} 数值无效`);
      return value;
    };
    const to = parseIntParam(toRaw, '结束时间') ?? tNow;
    const from = parseIntParam(fromRaw, '起始时间') ?? Math.max(0, to - DEFAULT_LOOKBACK_DAYS * DAY_MS);
    if (from > to) throw new ParamsError('起始时间不能晚于结束时间');
    const limit = parseIntParam(limitRaw, '条数上限') ?? 50;
    if (limit < 1 || limit > 500) throw new ParamsError('条数上限须在 1 到 500 之间');
    return { from, to, limit };
  }

  function view(fromRaw?: unknown, toRaw?: unknown, limitRaw?: unknown): EntropyCostView {
    const tNow = now();
    const { from, to, limit } = parseWindow(fromRaw, toRaw, limitRaw, tNow);
    const assumedFeeBps = deps.assumedFeeBps();
    const catalogFees = deps.markets().map(item => item.takerFeeBps).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const catalogFeeBps = medianOf(catalogFees);
    const address = validAddress();
    const emptySummary: EntropyCostSummary = {
      fills: 0, takerFills: 0, makerFills: 0, platformFills: 0, externalFills: 0,
      notionalUsd: 0, usdcNotionalUsd: 0, usdcFeeUsd: 0, builderFeeUsd: 0, nonUsdcFeeCount: 0,
      actualFeeBps: null, actualRoundTripBps: null, assumedFeeUsd: 0, rebateGapUsd: 0,
      weightedHypePriceUsd: null, hypeCoveredNotionalRatio: null,
    };
    if (!address) {
      return {
        now: tNow, configured: false, from, to, assumedFeeBps,
        assumedRoundTripBps: assumedFeeBps !== null ? 2 * assumedFeeBps : null,
        catalogFeeBps, estimatedExchangeFeeBps: null, snapshot: null,
        sync: { lastSyncAt: null, lastOkAt: null, incomplete: false, error: null },
        summary: emptySummary, fills: [],
      };
    }
    const hash = accountHashOf(address);
    const snap = store.latestEntropyFeeSnapshot(hash);
    const syncState = readSync(hash);
    const all = store.entropyFillsAll(hash, from, to);

    let takerFills = 0, makerFills = 0, platformFills = 0, externalFills = 0;
    let notionalUsd = 0, usdcFeeUsd = 0, usdcNotionalUsd = 0, builderFeeUsd = 0, nonUsdcFeeCount = 0;
    let assumedFeeUsd = 0, hypeWeighted = 0, hypeNotional = 0;

    for (const fill of all) {
      if (fill.crossed) takerFills++; else makerFills++;
      if (fill.livePositionId) platformFills++; else externalFills++;
      notionalUsd += fill.notionalUsd;
      builderFeeUsd += fill.builderFeeUsd;
      if (fill.feeToken === 'USDC') {
        usdcFeeUsd += fill.feeUsd;
        usdcNotionalUsd += fill.notionalUsd;
      } else {
        nonUsdcFeeCount++;
      }
      const feeBps = fill.assumedFeeBps ?? assumedFeeBps ?? fill.catalogFeeBps ?? 0;
      assumedFeeUsd += fill.notionalUsd * feeBps / 10_000;
      if (fill.hypePriceUsd !== null && fill.hypePriceUsd > 0) {
        hypeWeighted += fill.notionalUsd * fill.hypePriceUsd;
        hypeNotional += fill.notionalUsd;
      }
    }

    const actualFeeBps = usdcNotionalUsd > 0 ? (usdcFeeUsd / usdcNotionalUsd) * 10_000 : null;
    const summary: EntropyCostSummary = {
      fills: all.length, takerFills, makerFills, platformFills, externalFills,
      notionalUsd, usdcNotionalUsd, usdcFeeUsd, builderFeeUsd, nonUsdcFeeCount,
      actualFeeBps,
      actualRoundTripBps: actualFeeBps !== null ? 2 * actualFeeBps : null,
      assumedFeeUsd,
      rebateGapUsd: usdcFeeUsd - assumedFeeUsd,
      weightedHypePriceUsd: hypeNotional > 0 ? hypeWeighted / hypeNotional : null,
      hypeCoveredNotionalRatio: notionalUsd > 0 ? hypeNotional / notionalUsd : null,
    };

    const refMult = catalogFeeBps !== null ? catalogFeeBps / 4.5 : 0.2;
    const estimatedExchangeFeeBps = snap && snap.userCrossRate !== null
      ? snap.userCrossRate * 10_000 * refMult * (1 - (snap.referralDiscount ?? 0)) * (1 - (snap.stakingDiscount ?? 0))
      : null;

    const fills: EntropyFillView[] = all.slice(0, limit).map(fill => ({
      tid: fill.tid, oid: fill.oid, cloid: fill.cloid, time: fill.time, coin: fill.coin, side: fill.side, dir: fill.dir,
      crossed: fill.crossed, px: fill.px, sz: fill.sz, notionalUsd: fill.notionalUsd, feeUsd: fill.feeUsd, feeToken: fill.feeToken,
      builderFeeUsd: fill.builderFeeUsd, closedPnl: fill.closedPnl, livePositionId: fill.livePositionId, livePurpose: fill.livePurpose,
      assumedFeeBps: fill.assumedFeeBps, catalogFeeBps: fill.catalogFeeBps, deployerFeeScale: fill.deployerFeeScale, growthMode: fill.growthMode,
      hypePriceUsd: fill.hypePriceUsd,
    }));

    return {
      now: tNow, configured: true, from, to, assumedFeeBps,
      assumedRoundTripBps: assumedFeeBps !== null ? 2 * assumedFeeBps : null,
      catalogFeeBps, estimatedExchangeFeeBps,
      snapshot: snap ? {
        at: snap.at, userCrossRate: snap.userCrossRate, userAddRate: snap.userAddRate,
        referralDiscount: snap.referralDiscount, stakingDiscount: snap.stakingDiscount,
        hypePriceUsd: snap.hypePriceUsd, assumedFeeBps: snap.assumedFeeBps,
      } : null,
      sync: {
        lastSyncAt: syncState.lastSyncAt, lastOkAt: syncState.lastOkAt,
        incomplete: syncState.incomplete, error: syncState.error,
      },
      summary, fills,
    };
  }

  return { sync, view, idle: () => Promise.allSettled([...inFlight.values()]).then(() => undefined) };
}
