// 资金费组合模块接进执行服务（docs/fundingbook.md）。模块总是加载，参数里默认不启用；启用后只采集公开行情、
// 求解与记模拟盘，不读账户、不下单。只写自己的 fundingbook.sqlite，打不开库只停用本模块。
import { join } from 'node:path';
import { createFundingBookEngine, FundingBookError, type FundingBookEngine, type MarketSource } from '../fundingbook/engine.ts';
import { SettingsError } from '../fundingbook/model.ts';
import { FUNDINGBOOK_FILE, openFundingBookStore, type FundingBookStore } from '../fundingbook/store.ts';
import type { PerpetualMonitor } from '../monitor/perpetual.ts';

export interface FundingBookOptions { now?: () => number; collectBudgetMs?: number }
interface Hooks { log: (line: string) => void }
interface LoopContext { stopped(): boolean; pause(ms: number): Promise<void> }

export interface FundingBookViews {
  state(): unknown;
  settings(body: unknown): unknown;
  plan(): unknown;
  reset(body: unknown): unknown;
  round(id: number): unknown;
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}
export interface FundingBookManager { views: FundingBookViews; loop(context: LoopContext): Promise<void>; shutdown(): void }

/** 合约价差监控给本模块的只读入口；没有配置监控时为 null。 */
export function perpetualSource(monitor: () => PerpetualMonitor | null | undefined): () => MarketSource | null {
  return () => {
    const perpetual = monitor();
    if (!perpetual) return null;
    return {
      running: () => perpetual.running(),
      quotes: () => perpetual.liveQuotes(),
      funding: (exchange, symbol, range, signal) => perpetual.legFunding(exchange, symbol, range, signal),
      price: (exchange, symbol, range, signal) => perpetual.legPrice(exchange, symbol, range, signal),
    };
  };
}

export function openFundingBook(dir: string, source: () => MarketSource | null, options: FundingBookOptions, hooks: Hooks): FundingBookManager {
  let store: FundingBookStore | null = null, engine: FundingBookEngine | null = null, error: string | null = null;
  try {
    store = openFundingBookStore(join(dir, FUNDINGBOOK_FILE));
    engine = createFundingBookEngine({ store, source, log: hooks.log, ...(options.now ? { now: options.now } : {}), ...(options.collectBudgetMs === undefined ? {} : { collectBudgetMs: options.collectBudgetMs }) });
  } catch (cause) {
    error = `打不开 ${FUNDINGBOOK_FILE}：${(cause instanceof Error ? cause.message : String(cause)).slice(0, 200)}`;
    hooks.log(`fundingbook: ${error}，模块停用`);
    try { store?.close(); } catch { /* 已经在报错路径上 */ }
    store = null;
  }
  const current = (): FundingBookEngine['views'] => engine?.views ?? (() => { throw new FundingBookError(503, 'unavailable', `资金费组合模块不可用：${error ?? '未知原因'}`); })();
  return {
    views: {
      state: () => current().state(),
      settings: body => current().settings(body),
      plan: () => current().plan(),
      reset: body => current().reset(body),
      round: id => current().round(id),
      failure(cause) {
        if (cause instanceof FundingBookError) return { status: cause.status, body: { code: cause.code, message: cause.message }, internal: false };
        if (cause instanceof SettingsError) return { status: 400, body: { code: 'invalid_settings', message: cause.message }, internal: false };
        return { status: 500, body: { code: 'internal', message: '资金费组合模块内部错误' }, internal: true };
      },
    },
    shutdown(): void { engine?.quiesce(); },
    async loop(context: LoopContext): Promise<void> {
      try { await engine?.loop(context); }
      finally { engine?.quiesce(); try { store?.close(); } catch { /* 关库失败不影响停服 */ } store = null; engine = null; error ??= '服务正在停止'; }
    },
  };
}
