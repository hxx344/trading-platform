import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { chartEquity, runBacktest } from './backtest.ts';
import { prepareSampleRange } from './store.ts';
import type { AssetKind } from './model.ts';
import type { SymbolParams, GlobalParams, LegFees } from './strategy.ts';

export interface ReplayJob { file: string; symbol: string; kind: AssetKind; from: number; to: number; params: SymbolParams; global: GlobalParams; fees: LegFees | null }

const job: ReplayJob = workerData;
const db = new DatabaseSync(job.file, { readOnly: true });
try {
  db.exec('BEGIN');
  const samples = prepareSampleRange(db)(job.symbol, job.from - job.global.windowHours * 3_600_000, job.to);
  const result = runBacktest(job.symbol, job.kind, samples, job.from, job.to, job.params, job.global, job.fees);
  db.exec('COMMIT');
  parentPort!.postMessage({ ...result, trades: result.trades.slice(-1000), equity: chartEquity(result.equity), truncated: result.trades.length > 1000 });
} finally { db.close(); }
