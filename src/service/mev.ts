// MEV 套利模块接进执行服务（docs/mev.md）：config.json 有 `mev` 才开。模块只写自己的 mev.sqlite，
// 打不开库或节点不通都不影响执行服务本身；启动后是观察模式，实盘只能从页面开始，重启后回到观察模式。
import { join } from 'node:path';
import { BASE_CHAIN_ID } from '../mev/chain.ts';
import { createMevEngine, MevError, type MevEngine } from '../mev/engine.ts';
import { SettingsError } from '../mev/risk.ts';
import { createRpc, type FetchLike } from '../mev/rpc.ts';
import { MEV_FILE, openMevStore } from '../mev/store.ts';
import type { MevSecrets, MevServiceConfig } from './mev-config.ts';

/** 测试里替换节点传输与时钟。 */
export interface MevOptions { fetchImpl?: FetchLike; now?: () => number; pollMs?: number }
export interface MevHolder { engine: MevEngine | null; error: string | null; stop: AbortController }

export interface MevViews {
  state(): unknown;
  settings(body: unknown): unknown;
  start(body: unknown): Promise<unknown>;
  stop(): unknown;
  tokens(body: unknown): Promise<unknown>;
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}

export function openMev(config: MevServiceConfig, secrets: MevSecrets, dir: string, options: MevOptions, hooks: { log: (line: string) => void; notify: (key: string, text: string) => unknown }): MevHolder {
  const stop = new AbortController();
  try {
    const store = openMevStore(join(dir, MEV_FILE));
    try {
      const transport = { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), signal: stop.signal };
      const rpc = createRpc({ url: secrets.rpcUrl, ...transport });
      const sendRpc = secrets.sendRpcUrl ? createRpc({ url: secrets.sendRpcUrl, ...transport }) : rpc;
      const engine = createMevEngine({
        store, rpc, sendRpc, chainId: BASE_CHAIN_ID, executor: config.executor, owner: config.owner, privateKey: secrets.privateKey,
        log: hooks.log, notify: hooks.notify, ...(options.now ? { now: options.now } : {}), ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      });
      return { engine, error: null, stop };
    } catch (error) { store.close(); throw error; }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
    hooks.log(`mev: 打不开 ${MEV_FILE}，模块停用：${message}`);
    return { engine: null, error: message, stop };
  }
}

export function mevViews(holder: MevHolder): MevViews {
  const engine = (): MevEngine => holder.engine ?? (() => { throw new MevError(503, 'unavailable', `MEV 套利模块不可用：${holder.error ?? '未启动'}`); })();
  return {
    state: () => engine().views.state(),
    settings: body => engine().views.settings(body),
    start: body => engine().views.start(body),
    stop: () => engine().views.stop(),
    tokens: body => engine().views.tokens(body),
    failure(error) {
      if (error instanceof MevError) return { status: error.status, body: { code: error.code, message: error.message }, internal: false };
      if (error instanceof SettingsError) return { status: 400, body: { code: 'invalid_settings', message: error.message }, internal: false };
      return { status: 500, body: { code: 'internal', message: 'MEV 套利模块内部错误' }, internal: true };
    },
  };
}

export async function mevLoop(holder: MevHolder, context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void> {
  if (!holder.engine) return;
  const engine = holder.engine;
  // 停服时不再发新交易；已发出的交易留在库里，下次启动按回执、nonce 与区块号核对。
  try { if (!context.stopped()) await engine.loop(context); } finally { holder.engine = null; holder.error = '服务正在停止'; holder.stop.abort(); engine.close(); }
}
