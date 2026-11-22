// Var/Lighter 价差模块接进执行服务（docs/varlighter.md）：与 EQN 快讯一样默认开启，config.json 写 `"varLighter": false` 关闭。
// 模块只读公开行情、只写自己的 varlighter.sqlite，打不开库或采集出错都不影响执行服务本身。
import { join } from 'node:path';
import { createVarLighterEngine, VarLighterError, type VarLighterEngine } from '../varlighter/engine.ts';
import type { Connect, FetchLike } from '../varlighter/feeds.ts';
import { openVarLighterStore, VARLIGHTER_FILE } from '../varlighter/store.ts';
import { ParamsError } from '../varlighter/strategy.ts';

export interface VarLighterOptions { fetchImpl?: FetchLike; connect?: Connect; now?: () => number }
export interface VarLighterHolder { engine: VarLighterEngine | null; error: string | null }

export interface VarLighterViews {
  state(): unknown;
  symbol(symbol: string | null, hours: string | null): unknown;
  backtest(body: unknown): unknown;
  paper(): unknown;
  readiness(): unknown;
  settings(body: unknown): unknown;
  close(body: unknown): unknown;
  reset(body: unknown): unknown;
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}

export function openVarLighter(dir: string, options: VarLighterOptions, log: (line: string) => void): VarLighterHolder {
  try {
    const store = openVarLighterStore(join(dir, VARLIGHTER_FILE));
    return { engine: createVarLighterEngine({ store, ...options, log }), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
    log(`varlighter: 打不开 ${VARLIGHTER_FILE}，模块停用：${message}`);
    return { engine: null, error: message };
  }
}

export function varLighterViews(holder: VarLighterHolder): VarLighterViews {
  const engine = (): VarLighterEngine => holder.engine ?? (() => { throw new VarLighterError(503, 'unavailable', `Var/Lighter 模块不可用：${holder.error ?? '未启动'}`); })();
  return {
    state: () => engine().views.state(),
    symbol: (symbol, hours) => engine().views.symbol(symbol, hours === null ? undefined : hours),
    backtest: body => engine().views.backtest(body),
    paper: () => engine().views.paper(),
    readiness: () => engine().views.readiness(),
    settings: body => engine().views.settings(body),
    close: body => engine().views.close(body),
    reset: body => engine().views.reset(body),
    failure(error) {
      if (error instanceof VarLighterError) return { status: error.status, body: { code: error.code, message: error.message }, internal: false };
      if (error instanceof ParamsError) return { status: 400, body: { code: 'invalid_params', message: error.message }, internal: false };
      return { status: 500, body: { code: 'internal', message: 'Var/Lighter 模块内部错误' }, internal: true };
    },
  };
}

export async function varLighterLoop(holder: VarLighterHolder, context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
  if (!holder.engine) return;
  const engine = holder.engine;
  // 启动时已在停服也要关库。
  try { if (!context.stopped()) await engine.loop(context); } finally { holder.engine = null; holder.error = '服务正在停止'; engine.close(); }
}
