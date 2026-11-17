// The Ondo maker-reward module (docs/ondo.md): the workbench's quoting module (vendor/ondo/mm.mjs) plus the reward-market
// collector (ondo/rewards.ts). The routes call `views`; `loop` keeps the collector sampling and, when the service stops,
// withdraws a live session's quotes inside the shutdown's drain.
import { createOndoMarketMaker, HttpError, type OndoMarketMaker } from '../vendor/ondo/mm.mjs';
import { ONDO_MARKET, type OndoClient } from '../vendor/ondo/client.mjs';
import { createOndoRewards, RewardInputError, type OndoRewards } from '../ondo/rewards.ts';
import type { OndoCredentials, OndoServiceConfig } from './ondo-config.ts';

/** How long a stop waits for a live session's quotes to be withdrawn; inside the 20 s drain (main.ts DRAIN_MS). */
export const ONDO_CLOSE_WAIT_MS = 15_000;

export interface OndoViews {
  state(): unknown;
  save(body: unknown): unknown;
  start(body: unknown): Promise<unknown>;
  stop(body: unknown): Promise<unknown>;
  cleanup(body: unknown): Promise<unknown>;
  discardRecovery(body: unknown): unknown;
  rewards(windowMin: number | undefined): unknown;
  saveRewards(body: unknown): unknown;
  book(market: string): Promise<unknown>;
  /** The answer for an error a view threw: the module's own refusals keep their text, anything else is fixed. */
  failure(error: unknown): { status: number; body: { code: string; message: string }; internal: boolean };
}

export interface OndoModule {
  views: OndoViews;
  loop(context: { stopped(): boolean; pause(ms: number): Promise<void> }): Promise<void>;
  /** Stops the quoting timer without waiting (a start that failed later in main.ts). */
  close(): Promise<void>;
}

type Log = (line: string) => void;

function only(body: unknown, ...keys: string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !keys.includes(key))) throw new HttpError(400, '请求包含未知字段');
  return body as Record<string, unknown>;
}

export function createOndoModule(config: OndoServiceConfig, key: OndoCredentials | undefined, dataDir: string, options: {
  log?: Log; fetchImpl?: typeof fetch; WebSocketImpl?: unknown; rewardsClient?: () => OndoClient; mmIntervalMs?: number;
} = {}): OndoModule {
  const log = options.log ?? (line => process.stderr.write(`${line}\n`));
  const say = (level: string) => (detail: unknown, message?: unknown) => {
    const text = typeof message === 'string' ? message : typeof detail === 'string' ? detail : '';
    const err = detail && typeof detail === 'object' && 'err' in detail ? (detail as { err?: unknown }).err : null;
    if (level !== 'debug' && text) log(`Ondo：${text}${err instanceof Error ? `（${err.message.slice(0, 160)}）` : ''}`);
  };
  const mm: OndoMarketMaker = createOndoMarketMaker({
    dataDir, readCredentials: () => key ?? null, ...(config.initial ? { initialConfig: config.initial } : {}), closeWaitMs: ONDO_CLOSE_WAIT_MS,
    log: { info: say('info'), warn: say('warn'), error: say('error'), debug: say('debug') },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), ...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
    ...(options.mmIntervalMs === undefined ? {} : { intervalMs: options.mmIntervalMs }),
  });
  const rewards: OndoRewards = createOndoRewards({ dataDir, restingOrders: () => mm.restingOrders(), log, ...(options.rewardsClient ? { clientFactory: options.rewardsClient } : {}) });
  mm.initialize();
  rewards.initialize();

  const views: OndoViews = {
    state: () => mm.state(),
    // The workbench route's bodies (data-plane.mjs): settings under `config`, a start with its three fields, the rest empty.
    save: body => mm.save(only(body, 'config').config),
    start: body => mm.start(only(body, 'revision', 'confirmLive', 'adoptPositions')),
    stop: body => { only(body); return mm.stop(); },
    cleanup: body => { only(body); return mm.cleanup(); },
    discardRecovery: body => { only(body); return mm.discardRecovery(); },
    rewards: windowMin => rewards.state(windowMin),
    saveRewards: body => rewards.save(body),
    book: market => {
      if (!ONDO_MARKET.test(market)) throw new RewardInputError('市场代码无效');
      return rewards.book(market);
    },
    failure(error) {
      if (error instanceof HttpError || error instanceof RewardInputError) return { status: (error as { status: number }).status, body: { code: 'ondo', message: error.message }, internal: false };
      const status = (error as { status?: unknown } | null)?.status;
      if (error instanceof Error && error.constructor === Error && status === 503) return { status: 503, body: { code: 'ondo', message: error.message }, internal: false };
      return { status: 500, body: { code: 'internal', message: 'Ondo 模块内部错误' }, internal: true };
    },
  };

  let closing: Promise<void> | null = null;
  const close = (waitMs?: number) => closing ??= (async () => {
    try { await mm.close(waitMs); } catch (error) { log(`Ondo 挂单关闭出错：${error instanceof Error ? error.message : String(error)}`); }
    rewards.close();
  })();

  return {
    views,
    async loop(context) {
      try { await rewards.run(context); }
      catch (error) { log(`Ondo 奖励盘口采集异常退出：${error instanceof Error ? error.message : String(error)}`); while (!context.stopped()) await context.pause(1000); }
      // The service is stopping: a live session withdraws its quotes before the process goes.
      if (mm.state().live) log('服务停止：正在撤销 Ondo 挂单');
      await close(ONDO_CLOSE_WAIT_MS);
    },
    close: () => close(0),
  };
}
