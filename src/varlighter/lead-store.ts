// DEX 价差子模块「Binance & 多参考源领先测速」独立数据库（lead.sqlite，R2）：
// 与交易/持仓数据库（varlighter.sqlite）物理隔离：保存最多 3 个常驻测速标的、7 天滚动事件与稀疏 100ms 网格变化点。
// 打不开库或写入失败不阻塞 DEX 实盘，删掉本文件仅丢测速历史，不影响任何真实交易或模拟数据。
import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  LEAD_CODE_TO_SOURCE,
  LEAD_REF_SOURCES,
  LEAD_RETENTION_DAYS,
  LEAD_SOURCE_CODES,
  LEAD_VENUES,
  readLeadWatcherConfig,
  type PersistLeadEvent,
  type PersistLeadGrid,
} from './lead.ts';
import type {
  LeadRefSource,
  LeadStorageView,
  LeadStoredSymbolSummary,
  LeadVenue,
  LeadWatcherConfig,
} from './views.ts';

export const LEAD_DB_FILE = 'lead.sqlite';

export interface StoredWatcherRow {
  symbol: string;
  config: LeadWatcherConfig;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

function statDbBytes(file: string): number | null {
  if (file === ':memory:') return null;
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += statSync(file + suffix).size; } catch { /* 文件不存在忽略 */ }
  }
  return total;
}

const isRef = (source: string): source is LeadRefSource =>
  (LEAD_REF_SOURCES as readonly string[]).includes(source);
const isVenue = (source: string): source is LeadVenue =>
  (LEAD_VENUES as readonly string[]).includes(source);

export function openLeadStore(file: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=2000;
      PRAGMA journal_size_limit=8388608;
      PRAGMA temp_store=MEMORY;
      CREATE TABLE IF NOT EXISTS lead_watchers (
        symbol TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS lead_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        config_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lead_runs_symbol ON lead_runs(symbol, started_at);
      CREATE TABLE IF NOT EXISTS lead_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        run_id INTEGER NOT NULL,
        lead_source INTEGER NOT NULL,
        at INTEGER NOT NULL,
        direction INTEGER NOT NULL,
        base_mid REAL NOT NULL,
        trigger_mid REAL NOT NULL,
        move_bps REAL NOT NULL,
        threshold_bps REAL NOT NULL,
        follow_bps REAL NOT NULL,
        venues_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS lead_events_symbol_at ON lead_events(symbol, at);
      CREATE INDEX IF NOT EXISTS lead_events_symbol_lead_at ON lead_events(symbol, lead_source, at);
      CREATE INDEX IF NOT EXISTS lead_events_at ON lead_events(at);
      CREATE INDEX IF NOT EXISTS lead_events_run ON lead_events(run_id);
      CREATE TABLE IF NOT EXISTS lead_grid (
        symbol TEXT NOT NULL,
        at INTEGER NOT NULL,
        source INTEGER NOT NULL,
        run_id INTEGER NOT NULL,
        grid_idx INTEGER NOT NULL,
        seg_id INTEGER NOT NULL,
        mid REAL,
        PRIMARY KEY (symbol, at, source, run_id, grid_idx)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS lead_grid_at ON lead_grid(at);
      CREATE INDEX IF NOT EXISTS lead_grid_run ON lead_grid(run_id);
    `);

    const selWatchers = db.prepare('SELECT symbol, config_json AS configJson, enabled, created_at AS createdAt, updated_at AS updatedAt FROM lead_watchers ORDER BY created_at ASC');
    const stmtUpsertWatcher = db.prepare(`
      INSERT INTO lead_watchers(symbol, config_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET config_json = excluded.config_json, enabled = excluded.enabled, updated_at = excluded.updated_at
    `);
    const stmtToggleWatcher = db.prepare('UPDATE lead_watchers SET enabled = ?, updated_at = ? WHERE symbol = ? AND updated_at = ?');
    const stmtDeleteWatcher = db.prepare('DELETE FROM lead_watchers WHERE symbol = ? AND updated_at = ?');
    const stmtStartRun = db.prepare('INSERT INTO lead_runs(symbol, started_at, ended_at, config_json) VALUES (?, ?, NULL, ?)');
    const stmtCloseStaleRuns = db.prepare(`
      UPDATE lead_runs
      SET ended_at = COALESCE((SELECT MAX(at) FROM lead_grid WHERE lead_grid.run_id = lead_runs.id), ?)
      WHERE symbol = ? AND ended_at IS NULL
    `);
    const stmtEndRun = db.prepare('UPDATE lead_runs SET ended_at = ? WHERE id = ?');
    const stmtInsertEvent = db.prepare(`
      INSERT INTO lead_events(symbol, run_id, lead_source, at, direction, base_mid, trigger_mid, move_bps, threshold_bps, follow_bps, venues_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtUpsertGrid = db.prepare(`
      INSERT OR REPLACE INTO lead_grid(symbol, at, source, run_id, grid_idx, seg_id, mid)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const stmtPruneEvents = db.prepare('DELETE FROM lead_events WHERE rowid IN (SELECT rowid FROM lead_events WHERE at < ? LIMIT ?)');
    const stmtPruneGrid = db.prepare('DELETE FROM lead_grid WHERE (symbol, at, source, run_id, grid_idx) IN (SELECT symbol, at, source, run_id, grid_idx FROM lead_grid WHERE at < ? LIMIT ?)');
    const stmtPruneRuns = db.prepare(`
      DELETE FROM lead_runs
      WHERE ended_at IS NOT NULL AND ended_at < ?
        AND NOT EXISTS (SELECT 1 FROM lead_events WHERE lead_events.run_id = lead_runs.id)
        AND NOT EXISTS (SELECT 1 FROM lead_grid WHERE lead_grid.run_id = lead_runs.id)
    `);

    const stmtClearEventsAll = db.prepare('DELETE FROM lead_events');
    const stmtClearGridAll = db.prepare('DELETE FROM lead_grid');
    const stmtClearRunsAll = db.prepare('DELETE FROM lead_runs WHERE ended_at IS NOT NULL');
    const stmtClearEventsSym = db.prepare('DELETE FROM lead_events WHERE symbol = ?');
    const stmtClearGridSym = db.prepare('DELETE FROM lead_grid WHERE symbol = ?');
    const stmtClearRunsSym = db.prepare('DELETE FROM lead_runs WHERE symbol = ? AND ended_at IS NOT NULL');

    const stmtEventSummary = db.prepare('SELECT symbol, COUNT(*) AS cnt, MIN(at) AS firstAt, MAX(at) AS lastAt FROM lead_events GROUP BY symbol');
    const stmtGridSummary = db.prepare('SELECT symbol, COUNT(*) AS cnt, MIN(at) AS firstAt, MAX(at) AS lastAt FROM lead_grid GROUP BY symbol');
    const stmtGridSources = db.prepare('SELECT DISTINCT symbol, source FROM lead_grid');

    const runTx = <T>(fn: () => T): T => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        if (db.isTransaction) {
          try { db.exec('ROLLBACK'); } catch { /* 保留原始错误 */ }
        }
        throw error;
      }
    };

  function listWatchers(): StoredWatcherRow[] {
    const rows = selWatchers.all() as { symbol: string; configJson: string; enabled: number; createdAt: number; updatedAt: number }[];
    const result: StoredWatcherRow[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.configJson) as unknown;
        const config = readLeadWatcherConfig(parsed);
        result.push({
          symbol: config.symbol,
          config,
          enabled: row.enabled !== 0,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
      } catch { /* 损坏条目跳过，不影响其他正常标的和启动 */ }
    }
    return result;
  }

  function upsertWatcher(config: LeadWatcherConfig, enabled: boolean, nowMs: number): void {
    stmtUpsertWatcher.run(config.symbol, JSON.stringify(config), enabled ? 1 : 0, nowMs, nowMs);
  }

  function setWatcherEnabled(symbol: string, enabled: boolean, expectedUpdatedAt: number, nextUpdatedAt: number): boolean {
    const info = stmtToggleWatcher.run(enabled ? 1 : 0, nextUpdatedAt, symbol, expectedUpdatedAt);
    return Number(info.changes) > 0;
  }

  function deleteWatcher(symbol: string, expectedUpdatedAt: number): boolean {
    const info = stmtDeleteWatcher.run(symbol, expectedUpdatedAt);
    return Number(info.changes) > 0;
  }

  function startRun(symbol: string, startedAt: number, config: LeadWatcherConfig): number {
    return runTx(() => {
      stmtCloseStaleRuns.run(startedAt, symbol);
      const res = stmtStartRun.run(symbol, startedAt, JSON.stringify(config));
      return Number(res.lastInsertRowid);
    });
  }

  function endRun(runId: number, endedAt: number): void {
    stmtEndRun.run(endedAt, runId);
  }

  function flushBatch(events: readonly PersistLeadEvent[], grids: readonly PersistLeadGrid[]): void {
    if (!events.length && !grids.length) return;
    runTx(() => {
      for (const ev of events) {
        stmtInsertEvent.run(
          ev.symbol,
          ev.runId,
          LEAD_SOURCE_CODES[ev.leadSource],
          ev.at,
          ev.direction,
          ev.baseMid,
          ev.triggerMid,
          ev.moveBps,
          ev.thresholdBps,
          ev.followBps,
          JSON.stringify(ev.venues),
        );
      }
      for (const pt of grids) {
        stmtUpsertGrid.run(
          pt.symbol,
          pt.at,
          LEAD_SOURCE_CODES[pt.source],
          pt.runId,
          pt.gridIdx,
          pt.segId,
          pt.mid,
        );
      }
    });
  }

  function pruneBatch(cutoffMs: number, limit = 500): { deleted: number; more: boolean } {
    return runTx(() => {
      const e = Number(stmtPruneEvents.run(cutoffMs, limit).changes);
      const g = Number(stmtPruneGrid.run(cutoffMs, limit).changes);
      const more = e >= limit || g >= limit;
      if (!more) stmtPruneRuns.run(cutoffMs);
      return { deleted: e + g, more };
    });
  }

  function clearData(symbol?: string): void {
    runTx(() => {
      if (symbol) {
        stmtClearEventsSym.run(symbol);
        stmtClearGridSym.run(symbol);
        stmtClearRunsSym.run(symbol);
      } else {
        stmtClearEventsAll.run();
        stmtClearGridAll.run();
        stmtClearRunsAll.run();
      }
    });
  }

  function summary(): LeadStorageView {
    const bySymbol = new Map<string, { events: number; gridPoints: number; firstAt: number | null; lastAt: number | null; leads: Set<LeadRefSource>; targets: Set<LeadVenue> }>();
    const ensure = (sym: string) => {
      let item = bySymbol.get(sym);
      if (!item) {
        item = { events: 0, gridPoints: 0, firstAt: null, lastAt: null, leads: new Set(), targets: new Set() };
        bySymbol.set(sym, item);
      }
      return item;
    };
    const widen = (item: { firstAt: number | null; lastAt: number | null }, lo: number | null, hi: number | null) => {
      if (lo !== null) item.firstAt = item.firstAt === null ? lo : Math.min(item.firstAt, lo);
      if (hi !== null) item.lastAt = item.lastAt === null ? hi : Math.max(item.lastAt, hi);
    };

    let totalEvents = 0;
    let totalGridPoints = 0;
    for (const row of stmtEventSummary.all() as { symbol: string; cnt: number; firstAt: number | null; lastAt: number | null }[]) {
      const entry = ensure(row.symbol);
      entry.events = Number(row.cnt);
      totalEvents += entry.events;
      widen(entry, row.firstAt, row.lastAt);
    }
    for (const row of stmtGridSummary.all() as { symbol: string; cnt: number; firstAt: number | null; lastAt: number | null }[]) {
      const entry = ensure(row.symbol);
      entry.gridPoints = Number(row.cnt);
      totalGridPoints += entry.gridPoints;
      widen(entry, row.firstAt, row.lastAt);
    }
    for (const row of stmtGridSources.all() as { symbol: string; source: number }[]) {
      const src = LEAD_CODE_TO_SOURCE[row.source];
      if (!src) continue;
      const entry = ensure(row.symbol);
      if (isRef(src)) entry.leads.add(src);
      else if (isVenue(src)) entry.targets.add(src);
    }

    const symbols: LeadStoredSymbolSummary[] = [...bySymbol.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([symbol, entry]) => ({
        symbol,
        events: entry.events,
        gridPoints: entry.gridPoints,
        firstAt: entry.firstAt,
        lastAt: entry.lastAt,
        leads: LEAD_REF_SOURCES.filter(s => entry.leads.has(s)),
        targets: LEAD_VENUES.filter(v => entry.targets.has(v)),
      }));

    return {
      file: file === ':memory:' ? ':memory:' : LEAD_DB_FILE,
      retentionDays: LEAD_RETENTION_DAYS,
      error: null,
      dbBytes: statDbBytes(file),
      totalEvents,
      totalGridPoints,
      symbols,
    };
  }

    return {
      file,
      db,
      listWatchers,
      upsertWatcher,
      setWatcherEnabled,
      deleteWatcher,
      startRun,
      endRun,
      flushBatch,
      pruneBatch,
      clearData,
      summary,
      close: () => { db.close(); },
    };
  } catch (error) {
    try { db.close(); } catch { /* 已关闭 */ }
    throw error;
  }
}

export type LeadStore = ReturnType<typeof openLeadStore>;
