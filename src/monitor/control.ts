// M-3c: each market's run switch (the workbench's monitor-control.mjs, M11). Turning a market off stops its collection
// loops before their next round and its alert checks; the history in monitor.sqlite and the alert tiers stay. The switch
// is saved in monitor.sqlite (`control.<market>`: { version: 1, enabled, revision }), so it survives restarts; a market
// without a saved switch runs. config.json `monitor` still decides which markets exist at all.
import { ContractError } from '../contracts.ts';
import type { MonitorMarket } from '../service/monitor-config.ts';
import type { MonitorStore } from './store.ts';

export interface MarketControl { enabled: boolean; revision: number }
export interface ControlView extends MarketControl { market: MonitorMarket; error: string | null }

export const controlKey = (market: MonitorMarket): string => `control.${market}`;
const NAMES: Record<MonitorMarket, string> = { anthropic: 'Anthropic', oil: '原油', goldoil: '金油比', hynix: '海力士', perpetual: '合约价差' };
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function parseSaved(value: unknown): MarketControl {
  const raw = value as { version?: unknown; enabled?: unknown; revision?: unknown } | null;
  if (!raw || typeof raw !== 'object' || raw.version !== 1 || typeof raw.enabled !== 'boolean' || !Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) throw new Error('开关记录格式无效');
  return { enabled: raw.enabled, revision: raw.revision as number };
}

export function createMonitorControl({ store, markets, log = () => undefined }: { store: MonitorStore; markets: readonly MonitorMarket[]; log?: (line: string) => void }) {
  const state = new Map<MonitorMarket, MarketControl & { error: string | null }>();
  for (const market of markets) {
    try {
      const saved = store.readState(controlKey(market));
      state.set(market, { ...(saved ? parseSaved(saved.value) : { enabled: true, revision: 0 }), error: null });
    } catch (error) {
      // Collection is read-only: an unreadable switch runs the market rather than leaving it silently off.
      const message = `${NAMES[market]}监控开关无法读取（${reason(error)}），按开启运行；在页面点一次开关会保存为关闭并覆盖坏记录，需要运行时再点一次开启`;
      log(message);
      state.set(market, { enabled: true, revision: 0, error: message });
    }
  }
  const entry = (market: MonitorMarket) => {
    const value = state.get(market);
    if (!value) throw new ContractError(404, 'not_found', `本服务没有配置${NAMES[market]}行情监控`);
    return value;
  };
  const view = (market: MonitorMarket): ControlView => {
    const { enabled, revision, error } = entry(market);
    return { market, enabled, revision, error };
  };

  return {
    /** Whether the market runs; false only for a configured market switched off. */
    enabled: (market: MonitorMarket): boolean => state.get(market)?.enabled ?? false,
    view,
    views: (): Partial<Record<MonitorMarket, ControlView>> => Object.fromEntries(markets.map(market => [market, view(market)])),
    /**
     * Sets the switch from the page: `{ enabled, revision }` with the revision last read. A switch already in that position
     * answers its state (so a retry is harmless); a change from another revision is 409. The new value is saved before it
     * takes effect; a write failure is 503 and nothing changes. While the saved switch is unreadable, saving either
     * position with the shown revision overwrites it.
     */
    update(market: MonitorMarket, input: unknown): ControlView {
      const current = entry(market);
      const body = input as { enabled?: unknown; revision?: unknown } | null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'enabled' && key !== 'revision')
        || typeof body.enabled !== 'boolean' || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0) {
        throw new ContractError(400, 'invalid_control', '请提供监控开关（enabled）和有效版本号（revision）');
      }
      const enabled = body.enabled, revision = body.revision as number;
      // Already so (a retry whose answer was lost, or another page did the same): nothing to save.
      if (enabled === current.enabled && !current.error) return view(market);
      if (revision !== current.revision) throw new ContractError(409, 'control_conflict', '开关已被其他页面修改，请刷新状态后重试');
      const next = { enabled, revision: current.revision + 1 };
      try { store.writeState(controlKey(market), { version: 1, ...next }); }
      catch (error) { throw new ContractError(503, 'control_unsaved', `监控开关未保存（monitor.sqlite 写入失败：${reason(error)}），状态未改变`); }
      state.set(market, { ...next, error: null });
      log(`${NAMES[market]}监控已${enabled ? '开启' : '关闭'}（页面操作）`);
      return view(market);
    },
  };
}

export type MonitorControl = ReturnType<typeof createMonitorControl>;
