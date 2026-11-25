// DEX 价差引擎的宿主（docs/varlighter.md、docs/dexspread.md 第 11 节）：在 DEX 价差服务（src/dex/main.ts）里运行，执行服务不导入本文件。
// 模块只读公开行情与（有 Var token 时）登录后的询价、只写自己的 varlighter.sqlite，打不开库或采集出错都不影响别的服务。
import { join } from 'node:path';
import { createVarLighterEngine, VarLighterError, type VarLighterEngine } from '../varlighter/engine.ts';
import type { Connect, FetchLike } from '../varlighter/feeds.ts';
import { openVarLighterStore, VARLIGHTER_FILE } from '../varlighter/store.ts';
import { ParamsError } from '../varlighter/strategy.ts';
import { createVarQuoter, tokenFileSource, type TokenSource } from '../varlighter/varquote.ts';
import type { DexPageAnswer, DexPageRequest } from './protocol.ts';
import { createVariationalFetch } from '../monitor/variational-transport.ts';
import type { VariationalFetcher } from '../vendor/variational-market.mjs';

/**
 * `variationalFetch`：Var token 询价的传输（默认经 python3 传输脚本），测试里换成替身。`tokenSource`：Var token 的来源；
 * DEX 服务里是执行面推来的内存值，不给就读 `dir` 里的 token 文件（本机测试）。
 */
export interface VarLighterOptions { fetchImpl?: FetchLike; connect?: Connect; now?: () => number; variationalFetch?: VariationalFetcher; tokenSource?: () => TokenSource }
export interface VarLighterHolder { engine: VarLighterEngine | null; error: string | null }

export interface VarLighterViews {
  state(): unknown;
  symbol(symbol: string | null, hours: string | null): unknown;
  samples(symbol: string | null, after: string | null, limit: string | null): unknown;
  backtest(body: unknown): unknown;
  paper(): unknown;
  readiness(): unknown;
  settings(body: unknown): unknown;
  close(body: unknown): unknown;
  reset(body: unknown): unknown;
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}

export function openVarLighter(dir: string, options: VarLighterOptions, log: (line: string) => void): VarLighterHolder {
  let store: ReturnType<typeof openVarLighterStore> | null = null;
  try {
    store = openVarLighterStore(join(dir, VARLIGHTER_FILE));
    const { variationalFetch, tokenSource, ...engineOptions } = options;
    // 没有 token 时询价不发任何请求。
    const quoter = createVarQuoter({ source: tokenSource ?? tokenFileSource(dir), fetcher: variationalFetch ?? createVariationalFetch(), ...(options.now ? { now: options.now } : {}) });
    return { engine: createVarLighterEngine({ store, ...engineOptions, log, quoter }), error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 200) : String(error);
    // 迁移失败（事务已回滚）等引擎建不起来时也关库，下次启动重试。
    try { store?.close(); } catch { /* 已关闭 */ }
    log(`varlighter: 打不开 ${VARLIGHTER_FILE}，模块停用：${message}`);
    return { engine: null, error: message };
  }
}

export function varLighterViews(holder: VarLighterHolder): VarLighterViews {
  const engine = (): VarLighterEngine => holder.engine ?? (() => { throw new VarLighterError(503, 'unavailable', `Var/Lighter 模块不可用：${holder.error ?? '未启动'}`); })();
  return {
    state: () => engine().views.state(),
    symbol: (symbol, hours) => engine().views.symbol(symbol, hours === null ? undefined : hours),
    samples: (symbol, after, limit) => engine().views.samples(symbol, after, limit),
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

/** POST 请求体的上限，与执行面读请求体时用的一致（参数 64 KB，其余 16 KB）。 */

/**
 * 页面接口的路由表（原来在执行面 http.ts）：`path` 是 `/api/varlighter/` 之后的部分。出错按 `failure` 换成固定文案，
 * 原文只进本服务日志。
 */
export async function routePage(views: VarLighterViews, request: DexPageRequest, log: (line: string) => void): Promise<DexPageAnswer> {
  const { method, path } = request, query = new URLSearchParams(request.query), body = request.body ?? null;
  try {
    if (method === 'GET' && path === 'state') return { status: 200, body: views.state() };
    if (method === 'GET' && path === 'symbol') return { status: 200, body: views.symbol(query.get('symbol'), query.get('hours')) };
    if (method === 'GET' && path === 'samples') return { status: 200, body: views.samples(query.get('symbol'), query.get('after'), query.get('limit')) };
    if (method === 'GET' && path === 'paper') return { status: 200, body: views.paper() };
    if (method === 'GET' && path === 'readiness') return { status: 200, body: views.readiness() };
    if (method === 'POST' && path === 'backtest') return { status: 200, body: views.backtest(body) };
    if (method === 'POST' && path === 'settings') return { status: 200, body: views.settings(body) };
    if (method === 'POST' && path === 'paper/close') return { status: 200, body: views.close(body) };
    if (method === 'POST' && path === 'paper/reset') return { status: 200, body: views.reset(body) };
  } catch (error) {
    const failure = views.failure(error);
    if (failure.internal) log(`DEX 价差接口 ${path} 出错：${error instanceof Error ? error.message.slice(0, 200) : '未知错误'}`);
    return { status: failure.status, body: failure.body };
  }
  return { status: 404, body: { code: 'not_found', message: '不存在' } };
}

/** 同一进程里的转发（测试用）：和经套接字转发的行为一致，只是不经过 DEX 服务。 */
export function localDexForward(views: VarLighterViews, log: (line: string) => void = line => process.stderr.write(`${line}\n`)) {
  return { page: (request: DexPageRequest) => routePage(views, request, log) };
}
