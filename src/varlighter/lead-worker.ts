// DEX 价差领先测速离线分析 Worker（独立于 DEX 主事件循环，不阻塞实盘采样与下单，R2）：
// 从只读打开的 lead.sqlite 读取任意时段（最长 7 天）事件与末端最多 6 小时稀疏 100ms 网格变化点，
// 按 run_id 与断线哨兵严格无损还原密集网格，产出：
// 1. 各参考领先源横向对比榜（Leaderboard + 相对 Binance 合约快慢 vsBinancePerpMs）；
// 2. 主参考源的三场所统计分位、分时段延迟趋势桶、500ms 收益率互相关曲线与多源相对涨跌幅走势。
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import {
  LEAD_BASE_STALE_MS,
  LEAD_CODE_TO_SOURCE,
  LEAD_GRID_ANCHOR_MS,
  LEAD_GRID_STEP_MS,
  LEAD_MAX_EVENTS_VIEW,
  LEAD_REF_NAMES,
  LEAD_REF_SOURCES,
  LEAD_SERIES_POINTS_MAX,
  LEAD_SOURCE_NAMES,
  LEAD_VENUES,
  LEAD_XCORR_MAX_WINDOW_MS,
  buildReturnSeriesFromDenseArrays,
  computeXcorrFromReturns,
  median,
  readLeadWatcherConfig,
  summarizeVenueStats,
  type GridReturnSeries,
  type VenueStatAccum,
} from './lead.ts';
import type {
  LeadAnalyzeView,
  LeadEventVenueView,
  LeadEventView,
  LeadLeaderboardRow,
  LeadRefSource,
  LeadSeriesPoint,
  LeadSource,
  LeadTimeBucketView,
  LeadVenue,
  LeadVenueStatsView,
  LeadWatcherConfig,
} from './views.ts';

export interface LeadAnalyzeJob {
  file: string;
  symbol: string;
  leadSource: LeadRefSource | null;
  from: number;
  to: number;
}

const MAX_GRID_READ_ROWS = 400_000;
// 配合 LeadTracker 最后锚点（30s）使单个静默窗口最大向前延续 30s，总外推严格不超过 LEAD_BASE_STALE_MS (60s)。
const MAX_STALE_SLOTS = Math.round((LEAD_BASE_STALE_MS - LEAD_GRID_ANCHOR_MS) / LEAD_GRID_STEP_MS);

function pickBucketMs(spanMs: number): number {
  const hour = 3_600_000;
  if (spanMs <= 2 * hour) return 5 * 60_000;
  if (spanMs <= 12 * hour) return 15 * 60_000;
  if (spanMs <= 48 * hour) return hour;
  if (spanMs <= 96 * hour) return 3 * hour;
  return 6 * hour;
}

const isRef = (source: LeadSource): source is LeadRefSource =>
  (LEAD_REF_SOURCES as readonly string[]).includes(source);

interface GridRow {
  at: number;
  source: number;
  runId: number;
  gridIdx: number;
  segId: number;
  mid: number | null;
}

interface DenseSourceGrid {
  mids: Float64Array;
  segIds: Int32Array;
  returns: GridReturnSeries;
}

function emptyAccum(): VenueStatAccum {
  return { followedLags: [], unfollowed: 0, disconnected: 0, noData: 0, cancelled: 0, pending: 0 };
}

function parseEventVenues(raw: string): Partial<Record<LeadVenue, LeadEventVenueView>> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<Record<LeadVenue, LeadEventVenueView>>
      : {};
  } catch {
    return {};
  }
}

/** 根据稀疏网格变化点（含 30s 心跳锚点与 `mid === null` 断线哨兵）无损还原全局 100ms 密集数组。 */
function reconstructDenseGrids(
  rows: readonly GridRow[],
  runEndMap: ReadonlyMap<number, number | null>,
  xcorrFrom: number,
  xcorrTo: number,
): { originWall: number; totalSlots: number; bySource: Map<LeadSource, DenseSourceGrid> } {
  const originWall = Math.floor(xcorrFrom / LEAD_GRID_STEP_MS) * LEAD_GRID_STEP_MS;
  const totalSlots = Math.max(1, Math.floor((xcorrTo - originWall) / LEAD_GRID_STEP_MS) + 1);
  const slotOf = (wallMs: number) => Math.round((wallMs - originWall) / LEAD_GRID_STEP_MS);

  // 按 (source, runId) 分组（保留原始顺序），避免跨重启或跨段混填。
  const grouped = new Map<LeadSource, Map<number, GridRow[]>>();
  for (const row of rows) {
    const source = LEAD_CODE_TO_SOURCE[row.source];
    if (!source) continue;
    let byRun = grouped.get(source);
    if (!byRun) {
      byRun = new Map();
      grouped.set(source, byRun);
    }
    let list = byRun.get(row.runId);
    if (!list) {
      list = [];
      byRun.set(row.runId, list);
    }
    list.push(row);
  }

  const bySource = new Map<LeadSource, DenseSourceGrid>();
  let nextGlobalSegId = 1;

  for (const [source, byRun] of grouped) {
    const mids = new Float64Array(totalSlots);
    mids.fill(Number.NaN);
    const segIds = new Int32Array(totalSlots);

    for (const [runId, runRows] of byRun) {
      runRows.sort((a, b) => a.gridIdx - b.gridIdx || a.segId - b.segId);
      const endedAt = runEndMap.get(runId) ?? null;
      const hardEndWall = endedAt !== null ? Math.min(endedAt, xcorrTo) : xcorrTo;
      const hardEndSlot = Math.min(totalSlots - 1, Math.floor((hardEndWall - originWall) / LEAD_GRID_STEP_MS));

      const segMap = new Map<number, number>();
      const globalSegOf = (rawSeg: number): number => {
        let mapped = segMap.get(rawSeg);
        if (mapped === undefined) {
          mapped = nextGlobalSegId++;
          segMap.set(rawSeg, mapped);
        }
        return mapped;
      };

      let prev: { slot: number; rawSeg: number; globalSeg: number; mid: number } | null = null;
      for (const r of runRows) {
        const slot = slotOf(r.at);
        if (r.mid === null || !(r.mid > 0)) {
          // 断线 / 停服哨兵：停止向前填充到该边界之后（包含边界前同 seg 最多补至 slot - 1）。
          if (prev && slot > prev.slot) {
            const fillFrom = Math.max(0, prev.slot);
            const fillTo = Math.min(hardEndSlot, slot - 1, prev.slot + MAX_STALE_SLOTS);
            for (let s = fillFrom; s <= fillTo; s++) {
              mids[s] = prev.mid;
              segIds[s] = prev.globalSeg;
            }
          }
          if (slot >= 0 && slot < totalSlots) {
            mids[slot] = Number.NaN;
            segIds[slot] = 0;
          }
          prev = null;
          continue;
        }

        const gSeg = globalSegOf(r.segId);
        if (prev && prev.rawSeg === r.segId) {
          const fillFrom = Math.max(0, prev.slot);
          const fillTo = Math.min(hardEndSlot, slot - 1, prev.slot + MAX_STALE_SLOTS);
          for (let s = fillFrom; s <= fillTo; s++) {
            mids[s] = prev.mid;
            segIds[s] = prev.globalSeg;
          }
        }
        if (slot >= 0 && slot <= hardEndSlot) {
          mids[slot] = r.mid;
          segIds[slot] = gSeg;
        }
        prev = { slot, rawSeg: r.segId, globalSeg: gSeg, mid: r.mid };
      }

      if (prev) {
        const fillFrom = Math.max(0, prev.slot);
        const fillTo = Math.min(hardEndSlot, prev.slot + MAX_STALE_SLOTS);
        for (let s = fillFrom; s <= fillTo; s++) {
          mids[s] = prev.mid;
          segIds[s] = prev.globalSeg;
        }
      }
    }

    const returns = buildReturnSeriesFromDenseArrays(0, mids, segIds);
    bySource.set(source, { mids, segIds, returns });
  }

  return { originWall, totalSlots, bySource };
}

/** 供测试直调与 Worker 线程执行的纯 SQLite 离线分析函数。 */
export function analyzeLeadDatabase(db: DatabaseSync, job: LeadAnalyzeJob): LeadAnalyzeView {
  const startedClock = Date.now();
  const { symbol, from, to } = job;
  const bucketMs = pickBucketMs(to - from);

  // 1. 整体可用时间范围与配置中各源原始代码映射
  const evRange = db.prepare('SELECT MIN(at) AS minAt, MAX(at) AS maxAt FROM lead_events WHERE symbol = ?').get(symbol) as { minAt: number | null; maxAt: number | null };
  const grRange = db.prepare('SELECT MIN(at) AS minAt, MAX(at) AS maxAt FROM lead_grid WHERE symbol = ?').get(symbol) as { minAt: number | null; maxAt: number | null };
  const minCandidates = [evRange?.minAt, grRange?.minAt].filter((v): v is number => typeof v === 'number');
  const maxCandidates = [evRange?.maxAt, grRange?.maxAt].filter((v): v is number => typeof v === 'number');
  const dataRange = {
    firstAt: minCandidates.length ? Math.min(...minCandidates) : null,
    lastAt: maxCandidates.length ? Math.max(...maxCandidates) : null,
  };

  let watcherConfig: LeadWatcherConfig | null = null;
  const watcherRow = db.prepare('SELECT config_json AS configJson FROM lead_watchers WHERE symbol = ?').get(symbol) as { configJson: string } | undefined;
  if (watcherRow) {
    try { watcherConfig = readLeadWatcherConfig(JSON.parse(watcherRow.configJson)); } catch { /* 忽略 */ }
  }
  const latestRunRow = db.prepare('SELECT config_json AS configJson FROM lead_runs WHERE symbol = ? ORDER BY id DESC LIMIT 1').get(symbol) as { configJson: string } | undefined;
  if (!watcherConfig && latestRunRow) {
    try { watcherConfig = readLeadWatcherConfig(JSON.parse(latestRunRow.configJson)); } catch { /* 忽略 */ }
  }

  const labelSymbolOf = (source: LeadSource): string => {
    if (isRef(source)) return watcherConfig?.leads[source] ?? symbol;
    return watcherConfig?.targets[source] ?? symbol;
  };

  // 2. 查询全窗口事件并按 leadSource 分组累计
  const eventRows = db.prepare(`
    SELECT id, run_id AS runId, lead_source AS leadSource, at, direction, base_mid AS baseMid, trigger_mid AS triggerMid, move_bps AS moveBps, venues_json AS venuesJson
    FROM lead_events
    WHERE symbol = ? AND at >= ? AND at <= ?
    ORDER BY at ASC
  `).all(symbol, from, to) as {
    id: number;
    runId: number;
    leadSource: number;
    at: number;
    direction: number;
    baseMid: number;
    triggerMid: number;
    moveBps: number;
    venuesJson: string;
  }[];

  const seenLeads = new Set<LeadRefSource>(Object.keys(watcherConfig?.leads ?? {}) as LeadRefSource[]);
  const seenVenues = new Set<LeadVenue>(Object.keys(watcherConfig?.targets ?? {}) as LeadVenue[]);
  const eventCounts = new Map<LeadRefSource, number>();
  const statsByLead = new Map<LeadRefSource, Map<LeadVenue, VenueStatAccum>>();
  const parsedEvents: {
    id: number;
    leadSource: LeadRefSource;
    at: number;
    direction: 'up' | 'down';
    baseMid: number;
    triggerMid: number;
    moveBps: number;
    venues: Partial<Record<LeadVenue, LeadEventVenueView>>;
  }[] = [];

  for (const row of eventRows) {
    const leadSource = LEAD_CODE_TO_SOURCE[row.leadSource];
    if (!leadSource || !isRef(leadSource)) continue;
    seenLeads.add(leadSource);
    eventCounts.set(leadSource, (eventCounts.get(leadSource) ?? 0) + 1);
    const venues = parseEventVenues(row.venuesJson);
    let venueMap = statsByLead.get(leadSource);
    if (!venueMap) {
      venueMap = new Map();
      statsByLead.set(leadSource, venueMap);
    }
    for (const venue of LEAD_VENUES) {
      const cell = venues[venue];
      if (!cell) continue;
      seenVenues.add(venue);
      let acc = venueMap.get(venue);
      if (!acc) {
        acc = emptyAccum();
        venueMap.set(venue, acc);
      }
      if (cell.status === 'followed') {
        if (cell.lagMs !== null) acc.followedLags.push(cell.lagMs);
      } else if (cell.status === 'unfollowed') acc.unfollowed++;
      else if (cell.status === 'disconnected') acc.disconnected++;
      else if (cell.status === 'no_data') acc.noData++;
      else if (cell.status === 'cancelled') acc.cancelled++;
      else if (cell.status === 'pending') acc.pending++;
    }
    parsedEvents.push({
      id: row.id,
      leadSource,
      at: row.at,
      direction: row.direction >= 0 ? 'up' : 'down',
      baseMid: row.baseMid,
      triggerMid: row.triggerMid,
      moveBps: row.moveBps,
      venues,
    });
  }

  // 3. 查询末端最多 6 小时稀疏网格，无损还原并算出全部 Lead × Venue 与 Lead-vs-BinancePerp 互相关
  const xcorrTo = to;
  const xcorrFrom = Math.max(from, to - LEAD_XCORR_MAX_WINDOW_MS);
  const xcorrTruncated = xcorrFrom > from;

  const rawGridDesc = db.prepare(`
    SELECT at, source, run_id AS runId, grid_idx AS gridIdx, seg_id AS segId, mid
    FROM lead_grid
    WHERE symbol = ? AND at >= ? AND at <= ?
    ORDER BY at DESC
    LIMIT ?
  `).all(symbol, xcorrFrom - (LEAD_BASE_STALE_MS + 5_000), xcorrTo, MAX_GRID_READ_ROWS + 1) as unknown as GridRow[];

  const gridTruncated = rawGridDesc.length > MAX_GRID_READ_ROWS;
  const gridRows = (gridTruncated ? rawGridDesc.slice(0, MAX_GRID_READ_ROWS) : rawGridDesc).reverse();

  const runIds = new Set<number>();
  for (const r of gridRows) {
    runIds.add(r.runId);
    const src = LEAD_CODE_TO_SOURCE[r.source];
    if (src) {
      if (isRef(src)) seenLeads.add(src);
      else seenVenues.add(src);
    }
  }
  const runEndMap = new Map<number, number | null>();
  if (runIds.size) {
    const stmtRun = db.prepare('SELECT id, ended_at AS endedAt FROM lead_runs WHERE symbol = ?');
    for (const rr of stmtRun.all(symbol) as { id: number; endedAt: number | null }[]) {
      runEndMap.set(rr.id, rr.endedAt);
    }
  }

  const dense = reconstructDenseGrids(gridRows, runEndMap, xcorrFrom, xcorrTo);
  const availableLeads = LEAD_REF_SOURCES.filter(s => seenLeads.has(s));
  const activeVenues = LEAD_VENUES.filter(v => seenVenues.has(v));
  const bnPerpDense = dense.bySource.get('binance_perp');

  // 4. 构建领先源横向对比榜（Leaderboard）
  const leaderboard: LeadLeaderboardRow[] = availableLeads.map(leadSource => {
    const leadDense = dense.bySource.get(leadSource);
    const venueStatsMap = statsByLead.get(leadSource);
    const venues: LeadLeaderboardRow['venues'] = {};
    const medians: number[] = [];

    for (const venue of activeVenues) {
      const acc = venueStatsMap?.get(venue) ?? emptyAccum();
      const sorted = [...acc.followedLags].sort((a, b) => a - b);
      const followed = sorted.length;
      const resolved = followed + acc.unfollowed;
      const m = median(sorted);
      if (m !== null) medians.push(Math.round(m));
      const dexDense = dense.bySource.get(venue);
      const xc = leadDense && dexDense
        ? computeXcorrFromReturns(leadDense.returns, dexDense.returns, LEAD_SOURCE_NAMES[leadSource], LEAD_SOURCE_NAMES[venue])
        : { xcorr: null, reason: null };
      venues[venue] = {
        followed,
        unfollowed: acc.unfollowed,
        followRate: resolved > 0 ? Number((followed / resolved).toFixed(4)) : null,
        medianMs: m !== null ? Math.round(m) : null,
        peakLagMs: xc.xcorr?.peakLagMs ?? null,
        peakCorr: xc.xcorr?.peakCorr ?? null,
      };
    }

    let vsBinancePerpMs: number | null = null;
    let vsBinancePerpCorr: number | null = null;
    if (leadSource === 'binance_perp') {
      vsBinancePerpMs = 0;
      vsBinancePerpCorr = 1;
    } else if (leadDense && bnPerpDense) {
      const cmp = computeXcorrFromReturns(leadDense.returns, bnPerpDense.returns, LEAD_SOURCE_NAMES[leadSource], LEAD_SOURCE_NAMES.binance_perp);
      if (cmp.xcorr) {
        vsBinancePerpMs = cmp.xcorr.peakLagMs;
        vsBinancePerpCorr = cmp.xcorr.peakCorr;
      }
    }

    const overallMed = median(medians);
    return {
      leadSource,
      name: LEAD_REF_NAMES[leadSource],
      symbol: labelSymbolOf(leadSource),
      events: eventCounts.get(leadSource) ?? 0,
      overallMedianMs: overallMed !== null ? Math.round(overallMed) : null,
      vsBinancePerpMs,
      vsBinancePerpCorr,
      venues,
    };
  });

  // 按综合领先速度（先对 DEX 综合中位延迟降序，再按相对 Binance 合约快慢降序，再按事件数）排行
  const descNullLast = (a: number | null, b: number | null): number =>
    a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;
  leaderboard.sort((a, b) =>
    descNullLast(a.overallMedianMs, b.overallMedianMs)
    || descNullLast(a.vsBinancePerpMs, b.vsBinancePerpMs)
    || b.events - a.events);

  // 选择当前详查的主基准源
  let activeLead: LeadRefSource;
  if (job.leadSource && availableLeads.includes(job.leadSource)) {
    activeLead = job.leadSource;
  } else {
    activeLead = leaderboard.find(r => r.events > 0)?.leadSource
      ?? (availableLeads.includes('binance_perp') ? 'binance_perp' : availableLeads[0] ?? 'binance_perp');
  }

  // 5. 生成主基准源的详查三场所统计、分时段桶、事件明细
  const activeVenueMap = statsByLead.get(activeLead);
  const activeDense = dense.bySource.get(activeLead);
  const venues: LeadVenueStatsView[] = activeVenues.map(venue => {
    const acc = activeVenueMap?.get(venue) ?? emptyAccum();
    const dexDense = dense.bySource.get(venue);
    const xc = activeDense && dexDense
      ? computeXcorrFromReturns(activeDense.returns, dexDense.returns, LEAD_SOURCE_NAMES[activeLead], LEAD_SOURCE_NAMES[venue])
      : { xcorr: null, reason: `${!activeDense ? LEAD_SOURCE_NAMES[activeLead] : LEAD_SOURCE_NAMES[venue]} 在互相关窗口内暂无连续采样` };
    return summarizeVenueStats(venue, labelSymbolOf(venue), acc, xc.xcorr, xc.reason);
  });

  const activeEvents = parsedEvents.filter(ev => ev.leadSource === activeLead);
  const bucketMap = new Map<number, { events: number; lags: Record<LeadVenue, number[]>; unfollowed: Record<LeadVenue, number> }>();
  for (const ev of activeEvents) {
    const bAt = Math.floor(ev.at / bucketMs) * bucketMs;
    let bucket = bucketMap.get(bAt);
    if (!bucket) {
      bucket = {
        events: 0,
        lags: { lighter: [], rh: [], entropy: [] },
        unfollowed: { lighter: 0, rh: 0, entropy: 0 },
      };
      bucketMap.set(bAt, bucket);
    }
    bucket.events++;
    for (const venue of activeVenues) {
      const cell = ev.venues[venue];
      if (!cell) continue;
      if (cell.status === 'followed' && cell.lagMs !== null) bucket.lags[venue].push(cell.lagMs);
      else if (cell.status === 'unfollowed') bucket.unfollowed[venue]++;
    }
  }

  const buckets: LeadTimeBucketView[] = [...bucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([at, b]) => {
      const venuesObj: LeadTimeBucketView['venues'] = {};
      for (const venue of activeVenues) {
        const lags = b.lags[venue];
        const unfollowed = b.unfollowed[venue];
        const followed = lags.length;
        const resolved = followed + unfollowed;
        const m = median(lags);
        venuesObj[venue] = {
          followed,
          unfollowed,
          followRate: resolved > 0 ? Number((followed / resolved).toFixed(4)) : null,
          medianMs: m !== null ? Math.round(m) : null,
        };
      }
      return { at, events: b.events, venues: venuesObj };
    });

  const recentEvents: LeadEventView[] = activeEvents
    .slice(-LEAD_MAX_EVENTS_VIEW)
    .reverse()
    .map(ev => ({
      id: ev.id,
      leadSource: ev.leadSource,
      leadName: LEAD_REF_NAMES[ev.leadSource],
      at: ev.at,
      direction: ev.direction,
      baseMid: ev.baseMid,
      triggerMid: ev.triggerMid,
      moveBps: ev.moveBps,
      venues: ev.venues,
    }));

  // 6. 生成近 6 小时或选中末端实际有采样区间内的多源归一化相对涨跌幅对比走势图（<= 300 点）
  const seriesSources: LeadSource[] = [...availableLeads, ...activeVenues].filter(s => dense.bySource.has(s));
  const series: LeadSeriesPoint[] = [];
  if (seriesSources.length && dense.totalSlots >= 2) {
    let minSlot = dense.totalSlots;
    let maxSlot = -1;
    for (const src of seriesSources) {
      const mids = dense.bySource.get(src)!.mids;
      for (let slot = 0; slot < dense.totalSlots; slot++) {
        const m = mids[slot]!;
        if (Number.isFinite(m) && m > 0) {
          if (slot < minSlot) minSlot = slot;
          break;
        }
      }
      for (let slot = dense.totalSlots - 1; slot >= 0; slot--) {
        const m = mids[slot]!;
        if (Number.isFinite(m) && m > 0) {
          if (slot > maxSlot) maxSlot = slot;
          break;
        }
      }
    }
    if (maxSlot > minSlot) {
      const dataSlots = maxSlot - minSlot + 1;
      const sampleStep = Math.max(1, Math.ceil(dataSlots / LEAD_SERIES_POINTS_MAX));
      const sampleSlots: number[] = [];
      for (let slot = minSlot; slot <= maxSlot; slot += sampleStep) sampleSlots.push(slot);
      if (sampleSlots.at(-1) !== maxSlot) sampleSlots.push(maxSlot);
      if (sampleSlots.length > LEAD_SERIES_POINTS_MAX) {
        sampleSlots.splice(LEAD_SERIES_POINTS_MAX - 1, sampleSlots.length - LEAD_SERIES_POINTS_MAX);
      }
      const bases: Partial<Record<LeadSource, number>> = {};
      for (const slot of sampleSlots) {
        for (const src of seriesSources) {
          if (bases[src] !== undefined) continue;
          const mid = dense.bySource.get(src)!.mids[slot]!;
          if (Number.isFinite(mid) && mid > 0) bases[src] = mid;
        }
      }
      if (Object.keys(bases).length) {
        for (const slot of sampleSlots) {
          const values: Partial<Record<LeadSource, number | null>> = {};
          for (const src of seriesSources) {
            const base = bases[src];
            const mid = dense.bySource.get(src)!.mids[slot]!;
            values[src] = base && Number.isFinite(mid) && mid > 0
              ? Number((((mid - base) / base) * 10_000).toFixed(2))
              : null;
          }
          series.push({ t: dense.originWall + slot * LEAD_GRID_STEP_MS, values });
        }
      }
    }
  }

  return {
    symbol,
    activeLead,
    availableLeads,
    from,
    to,
    xcorrFrom,
    xcorrTo,
    xcorrTruncated,
    gridTruncated,
    bucketMs,
    computedMs: Math.max(0, Date.now() - startedClock),
    eventCount: activeEvents.length,
    dataRange,
    leaderboard,
    venues,
    buckets,
    events: recentEvents,
    series,
  };
}

if (!isMainThread && parentPort) {
  const job = workerData as LeadAnalyzeJob;
  const db = new DatabaseSync(job.file, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=2000; PRAGMA query_only=ON; BEGIN');
    const result = analyzeLeadDatabase(db, job);
    db.exec('COMMIT');
    parentPort.postMessage(result);
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
    }
    throw error;
  } finally {
    db.close();
  }
}
