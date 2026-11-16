// The oil module inside the ASTER service: Binance/Bybit execution accounts named in config.json `oil`. Started only when
// that block is there; the service without it runs exactly as before. Before anything is opened the accounts are locked
// on this host and every account passes its venue's key and identity check, so a bad key or a second process refuses start.
import type { VenueConnector } from '../connector.ts';
import { MARKET_NAMES, VENUE_NAMES, marketOfSymbol, type Venue } from '../contracts.ts';
import type { Executor } from '../executor.ts';
import { createLiveConnectors, holdAccountLocks, preflightLive } from '../live/setup.ts';
import type { FetchLike } from '../live/http.ts';
import type { LiveCredentials } from '../live/values.ts';
import { createOilMarket, MARKET_READ_MS, POSITIONS_READ_MS, type OilMarket } from '../oil/market.ts';
import { createHynixMarket, type HynixMarket } from '../hynix/market.ts';
import { DEFAULT_BALANCE_SETTINGS, type BalanceSettings } from '../hynix/balance.ts';
import { createBalanceStore, HYNIX_DATABASE } from '../hynix/balance-store.ts';
import { createBalanceAlerts } from '../hynix/balance-alert.ts';
import { createOilRules, OIL_RULES_DATABASE } from '../oil/rules.ts';
import { createOilPnl, LEDGER_SYNC_MS, OIL_PNL_DATABASE, PNL_RANGES, PNL_SAMPLE_MS, type PnlRange } from '../oil/pnl.ts';
import type { RuleExecutor } from '../oil/rule-live.ts';
import { ContractError } from '../contracts.ts';
import { join } from 'node:path';
import type { OilConfig } from './oil-config.ts';

/** The shortest gap between two book rounds, so a round that took its whole timeout does not start the next at once. */
const MIN_GAP_MS = 500;

export interface OilRuntime {
  config: OilConfig;
  connectors: VenueConnector[];
  market: OilMarket;
  /** SK hynix trades on the same accounts and executor (docs/hynix.md); its books and positions are read apart. */
  hynix: HynixMarket;
  locks: { release(): void };
}

/**
 * Locks the oil accounts (one live executor per real account on this host), builds the configured venues' connectors and
 * runs their start checks (preflightLive: one signed read set per account, 30 s timeout each, no retry). Any failure
 * releases the locks and throws, which refuses start.
 */
export async function prepareOil(config: OilConfig, keys: Map<Venue, LiveCredentials> | undefined, { fetchImpl, now = Date.now, preflightTimeoutMs }: { fetchImpl?: FetchLike; now?: () => number; preflightTimeoutMs?: number } = {}): Promise<OilRuntime> {
  if (!keys) throw new Error('配置了 oil，但密钥文件里没有对应交易所的密钥');
  const locks = await holdAccountLocks(config.accounts);
  try {
    const venues = new Set(config.accounts.map(account => account.venue));
    const connectors = createLiveConnectors(config, keys, { ...(fetchImpl ? { fetchImpl } : {}), now }).filter(connector => venues.has(connector.venue));
    await preflightLive(config, connectors, ...(preflightTimeoutMs === undefined ? [] : [preflightTimeoutMs]));
    return { config, connectors, market: createOilMarket({ connectors, accounts: config.accounts, now }), hynix: createHynixMarket({ connectors, accounts: config.accounts, now }), locks };
  } catch (error) { locks.release(); throw new Error(`原油执行账户启动检查未通过，拒绝启动：${error instanceof Error ? error.message : String(error)}`); }
}

/** Binds the oil accounts in the executor (after it holds the lease); a binding change refused there refuses start. */
export function registerOilAccounts(oil: OilRuntime, executor: Executor): void {
  for (const account of oil.config.accounts) executor.registerAccount(account);
}

/**
 * Oil jobs still open while oil, or one of their venues, is no longer configured: no loop drives or reconciles them and the
 * page cannot show them, so the operator hears it (log and Feishu) at every start until oil is configured again.
 */
export function strandedOilJobs(executor: Pick<Executor, 'unfinished' | 'jobView'>, config: OilConfig | undefined): string[] {
  const configured = new Set<Venue>(config?.accounts.map(account => account.venue) ?? []);
  return executor.unfinished().flatMap(id => {
    const legs = executor.jobView(id).legs, missing = [...new Set(legs.map(leg => leg.venue))].filter(venue => !configured.has(venue));
    if (!missing.length) return [];
    const where = config ? `没有 ${missing.map(venue => VENUE_NAMES[venue]).join('、')} 执行账户` : '已没有 oil';
    return [`${MARKET_NAMES[marketOfSymbol(legs[0]!.symbol)]}任务 ${id} 尚未结束，但配置里${where}：本服务不再推进或核对它，交易所上可能仍有敞口；请把配置加回后重启，处理完再删除`];
  });
}

/** The spread rules as the page and the market loop use them; a store that cannot open leaves orders and jobs alone. */
export interface OilRulesRuntime {
  view(): unknown;
  create(body: unknown): unknown;
  update(id: string, body: unknown): unknown;
  act(id: string, action: string, body: unknown): unknown;
  tick(stopped?: () => boolean): Promise<void>;
  close(): void;
}

/**
 * Opens oil-rules.sqlite in the data directory. A failure is logged and shown on the page; the rest of oil runs on. With
 * the executor, live rules order through its preview and confirm (docs/oil.md 7.3); without it they can only observe.
 */
export function openOilRules(oil: OilRuntime, dir: string, { now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`), executor }: { now?: () => number; log?: (line: string) => void; executor?: RuleExecutor } = {}): OilRulesRuntime {
  try {
    return createOilRules({ file: join(dir, OIL_RULES_DATABASE), venues: oil.config.accounts.map(account => account.venue), books: () => [...oil.market.view().books, ...oil.hynix.view().books], now, ...(executor ? { executor } : {}) });
  } catch (error) {
    const reason = `原油自动规则库无法打开，自动规则不可用（下单与任务不受影响）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
    log(reason);
    const refuse = () => { throw new ContractError(503, 'rules_unavailable', reason); };
    return { view: () => ({ available: false, error: reason, rules: [] }), create: refuse, update: refuse, act: refuse, tick: async () => {}, close: () => {} };
  }
}

/** The PnL and ledger reads (docs/oil.md section 9) as the page and the loops use them. */
export interface OilPnlRuntime {
  read(query: { range?: PnlRange; page?: number }): unknown;
  sample(): Promise<void>;
  syncLedgers(stopped?: () => boolean): Promise<void>;
  close(): void;
}

/** Opens oil-pnl.sqlite in the data directory. A failure is logged and shown on the page; orders, jobs and rules run on. */
export function openOilPnl(oil: OilRuntime, dir: string, { now = Date.now, log = (line: string) => process.stderr.write(`${line}\n`) }: { now?: () => number; log?: (line: string) => void } = {}): OilPnlRuntime {
  try {
    return createOilPnl({ file: join(dir, OIL_PNL_DATABASE), connectors: oil.connectors, accounts: oil.config.accounts, now });
  } catch (error) {
    const reason = `原油盈亏库无法打开，盈亏与资金费不可用（下单、任务与规则不受影响）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
    log(reason);
    return { read: () => ({ available: false, error: reason }), sample: async () => {}, syncLedgers: async () => {}, close: () => {} };
  }
}

/** The page's oil reads: the books and spreads, the accounts, venue positions, jobs, the spread rules and PnL. */
export function oilViews(oil: OilRuntime, executor: Executor, rules?: OilRulesRuntime, pnl?: OilPnlRuntime) {
  return {
    market: () => oil.market.view(),
    state: () => ({ accounts: executor.accounts(), positions: oil.market.positionsView(), jobs: executor.recentJobs(20, 'oil') }),
    ...(rules ? { rules } : {}),
    ...(pnl ? { pnl: (range: string, page: number) => Object.hasOwn(PNL_RANGES, range) ? pnl.read({ range: range as PnlRange, page }) : null } : {}),
  };
}

/** The H2 balance settings as the page, the alerts and the save use them; a store that cannot open keeps the defaults. */
export interface HynixBalanceRuntime {
  settings(): BalanceSettings;
  /** False only when the file cannot be used: saves are refused. */
  readonly available: boolean;
  /** Why the defaults are in effect: the file cannot be used, or the saved value is invalid (a save then overwrites it). */
  readonly error: string | null;
  save(body: unknown): BalanceSettings;
  close(): void;
}

/**
 * Opens hynix.sqlite in the data directory. A file that cannot open is logged and shown, and saves answer 503; saved
 * settings that no longer parse are logged and shown too, but a save overwrites them.
 */
export function openHynixBalance(dir: string, { log = (line: string) => process.stderr.write(`${line}\n`) }: { log?: (line: string) => void } = {}): HynixBalanceRuntime {
  try {
    const store = createBalanceStore(join(dir, HYNIX_DATABASE));
    const invalid = store.invalid();
    if (invalid) log(`海力士两腿平衡设置：${invalid}`);
    const save = (body: unknown): BalanceSettings => {
      const before = store.settings();
      let next: BalanceSettings;
      try { next = store.save(body); }
      catch (error) {
        if (error instanceof ContractError) throw error;
        throw new ContractError(503, 'settings_unavailable', `海力士两腿平衡设置未能保存：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      }
      const show = (s: BalanceSettings) => `调平线 ${s.rebalancePercent}% / 硬上限 ${s.hardPercent}% / 最小差额 ${s.minGapUsdt} USDT`;
      log(`海力士两腿平衡设置已修改：${show(before)} → ${show(next)}`);
      return next;
    };
    return { settings: store.settings, available: true, get error() { return store.invalid(); }, save, close: store.close };
  } catch (error) {
    const reason = `海力士设置库无法打开，两腿平衡按默认阈值判断、设置不能保存（下单与任务不受影响）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
    log(reason);
    return { settings: () => ({ ...DEFAULT_BALANCE_SETTINGS }), available: false, error: reason, save: () => { throw new ContractError(503, 'settings_unavailable', reason); }, close: () => {} };
  }
}

/** True while the venue has an unfinished hynix job (a rebalance job has one leg, a two-leg job may span both venues). */
export function hynixBusy(executor: Pick<Executor, 'unfinished' | 'jobView'>): (venue: Venue) => boolean {
  return venue => executor.unfinished().some(id => {
    const job = executor.jobView(id);
    return job.market === 'hynix' && job.legs.some(leg => leg.venue === venue);
  });
}

/** The balance alert judged after each hynix positions round (docs/hynix.md 7.4). */
export function hynixBalanceCheck(oil: OilRuntime, balance: Pick<HynixBalanceRuntime, 'settings'>, options: Parameters<typeof createBalanceAlerts>[0]): () => void {
  const alerts = createBalanceAlerts(options);
  return () => { const settings = balance.settings(); alerts.judge(oil.hynix.balanceView(settings), settings); };
}

/** The page's hynix reads (docs/hynix.md): the books and premium, the accounts, hynix positions, hynix jobs and the balance. */
export function hynixViews(oil: OilRuntime, executor: Executor, balance: HynixBalanceRuntime) {
  return {
    market: () => oil.hynix.view(),
    state: () => {
      const settings = balance.settings();
      return {
        accounts: executor.accounts(), positions: oil.hynix.positionsView(), jobs: executor.recentJobs(20, 'hynix'),
        balance: { settings, settingsAvailable: balance.available, settingsError: balance.error, venues: oil.hynix.balanceView(settings) },
      };
    },
    saveBalanceSettings: (body: unknown) => balance.save(body),
  };
}

/**
 * The market loops: oil and hynix books every 3 s (each round then the spread rules), positions every 15 s; with PnL, its positions every minute
 * and its ledgers every five minutes. Each round's reads carry their own timeout; a failure only marks the view.
 */
export function oilLoops(oil: OilRuntime, context: { stopped(): boolean; pause(ms: number): Promise<void> }, log: (line: string) => void, rules?: OilRulesRuntime, pnl?: OilPnlRuntime, hynixCheck?: () => void): Promise<void>[] {
  const every = (spacingMs: number, name: string, round: () => Promise<void>) => (async () => {
    while (!context.stopped()) {
      const started = Date.now();
      try { await round(); } catch (error) { log(`${name}失败：${error instanceof Error ? error.message : String(error)}`); }
      if (context.stopped()) break;
      await context.pause(Math.max(MIN_GAP_MS, spacingMs - (Date.now() - started)));
    }
  })();
  // The rules judge each round's books as soon as they are read; their own failure is logged apart from the read's. A live
  // rule's preview reads the venue (up to its timeout), so the books keep refreshing meanwhile and the next judging round
  // starts on the books read after this one ends. Both markets' book rounds start a judging round (one at a time), so a
  // hynix rule counts each fresh hynix sample even when the oil read lags; samples already counted are not counted again.
  let judging: Promise<void> | null = null;
  const judge = () => {
    if (rules && !judging) {
      judging = Promise.resolve().then(() => rules.tick(context.stopped))
        .catch(error => log(`原油自动规则判断失败：${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { judging = null; });
    }
  };
  // On stop the books loops end only after the judging round in flight, so its preview and confirm finish (or fail) before
  // the service closes the executor and the rules store.
  const books = every(MARKET_READ_MS, '原油盘口读取', async () => { await oil.market.refreshQuotes(); judge(); }).then(async () => { await judging; });
  const hynixBooks = every(MARKET_READ_MS, '海力士盘口读取', async () => { await oil.hynix.refreshQuotes(); judge(); }).then(async () => { await judging; });
  // The balance alert is judged on the positions just read; its failure is logged apart and never fails the read.
  const hynixPositions = async () => {
    await oil.hynix.refreshPositions();
    if (!hynixCheck) return;
    try { hynixCheck(); } catch (error) { log(`海力士两腿平衡告警判断失败：${error instanceof Error ? error.message : String(error)}`); }
  };
  return [books, every(POSITIONS_READ_MS, '原油持仓读取', oil.market.refreshPositions),
    hynixBooks, every(POSITIONS_READ_MS, '海力士持仓读取', hynixPositions),
    ...(pnl ? [every(PNL_SAMPLE_MS, '原油盈亏采样', () => pnl.sample()), every(LEDGER_SYNC_MS, '原油账单同步', () => pnl.syncLedgers(context.stopped))] : [])];
}
