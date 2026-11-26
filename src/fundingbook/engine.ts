// 资金费组合的引擎（docs/fundingbook.md）：回补各条腿的已结算资金费与各标的的小时收盘价，按间隔求解目标仓位、
// 生成路径规划并记入模拟盘。第一期不读任何账户、不向任何交易所发单；行情与历史都经合约价差监控读取，监控没有
// 运行时本模块不采集也不规划。
import { DEFAULT_SETTINGS, parseSettings, PRICE_VENUES, storedSettings, VENUE_SPECS, venueSpec, type Settings } from './model.ts';
import { accountEquity, accrueFunding, applyPlan, newBook, occupiedAccounts, reconcileAccounts, unrealized, type PaperBook } from './paper.ts';
import { buildPlan, type PlanLeg } from './plan.ts';
import { allocate, accountRisk, solve, type SolveAccount, type SolveInput, type Solution } from './solver.ts';
import { DAY, fundingStats, HOUR, riskModel, type FundingRecord, type FundingStats, type PricePoint, type RiskModel } from './stats.ts';
import type { Coverage, FundingBookStore } from './store.ts';
import type { BookView, LegView, RoundAccount, RoundBase, RoundSummary, RoundView, StateView } from './views.ts';

/** 行情里一个合约的报价：只列本模块用到的字段（合约价差监控的 PerpetualQuote 可以直接传进来）。 */
export interface SourceQuote {
  exchange: string; symbol: string; base: string; quoteCurrency: string;
  bid: number | null; ask: number | null; mark: number | null; last: number | null;
  fundingRate: number | null; fundingIntervalHours: number | null;
  comparable?: boolean; delisting?: boolean;
}
export interface HistoryRange { from: number; to: number }
/** 合约价差监控给本模块的只读入口。 */
export interface MarketSource {
  running(): boolean;
  quotes(): readonly SourceQuote[];
  /** 已结算资金费，时间在 [from, to] 内；每次结算的原始费率。 */
  funding(exchange: string, symbol: string, range: HistoryRange, signal: AbortSignal): Promise<FundingRecord[]>;
  /** 小时收盘价，时间是整点（那一小时的结束），在 (from, to] 内；from、to 须为整点。 */
  price(exchange: string, symbol: string, range: HistoryRange, signal: AbortSignal): Promise<PricePoint[]>;
}
export class FundingBookError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'FundingBookError'; this.status = status; this.code = code; }
}
export interface EngineOptions {
  store: FundingBookStore;
  source: () => MarketSource | null;
  now?: () => number;
  log?: (line: string) => void;
  /** 一次采集最多用多久；测试里调小。 */
  collectBudgetMs?: number;
}
interface LoopContext { stopped(): boolean; pause(ms: number): Promise<void> }

/** 场所的历史资金费接口一次最多查这么长（行情监控的读取器按场所限定，Bitget 走分页可以更长）。 */
const fundingSegment = (venue: string): number => venue === 'bitget' ? 30 * DAY : 4 * DAY;
/** 一次查 7 天的小时线（168 根），低于各所单页上限。 */
const PRICE_SEGMENT = 7 * DAY;
const FUNDING_REFRESH_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const COLLECT_BUDGET_MS = 30_000;
/** 一条腿的资金费这么久没有读到新范围就不再用它（这条腿本轮按做不了处理）。 */
export const STALE_FUNDING_MS = 6 * HOUR;
const RETENTION_MS = 100 * DAY;
const ROUND_LIST = 50;
/** 增量刷新每次回看这么久：结算与整点 K 线在历史接口上会晚发布，只从上次读到的时刻往后读会永久漏掉它们。 */
const REFRESH_LOOKBACK_MS = 2 * HOUR;
/** 求解的不交易带：一个标的各腿的调整都小于单边名义金额的这个比例时不动（solver.ts）。 */
const NO_TRADE_BAND = 0.03;
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 160);
const quotePrice = (quote: SourceQuote): number | null => {
  const value = quote.mark ?? (quote.bid !== null && quote.ask !== null ? (quote.bid + quote.ask) / 2 : quote.last);
  return value !== null && value > 0 ? value : null;
};
const legKey = (venue: string, symbol: string): string => `${venue}:${symbol}`;

interface Target { key: string; kind: 'funding' | 'price'; venue: string; symbol: string; base: string; want: number; segment: number }
interface LegInfo { view: LegView; key: string; stats: FundingStats | null; usable: boolean }

export function createFundingBookEngine(options: EngineOptions) {
  const { store, source } = options, now = options.now ?? Date.now, log = options.log ?? (() => {});
  const budget = options.collectBudgetMs ?? COLLECT_BUDGET_MS;
  let settings: Settings = storedSettings(store.settings());
  let book: PaperBook | null = store.book();
  let revision = 0, closed = false, solving = false, nextRoundAt = 0, prunedAt = 0;
  let roundError: string | null = null;
  let collect = { done: 0, total: 0, errors: [] as string[] };
  let legsView: LegView[] = [], risk: RiskModel | null = null;
  let inflight: AbortController | null = null;

  const withId = (id: number, detail: unknown): RoundView => ({ ...(detail as RoundView), id });
  const listRounds = (): StateView['rounds'] => store.rounds(ROUND_LIST).map(row => ({ id: row.id, at: row.at, ...(row.summary as RoundSummary) }));
  const latest = store.latestRound();
  let lastRound: RoundView | null = latest ? withId(latest.id, latest.detail) : null;
  let rounds = listRounds();

  const venuesInUse = (): string[] => [...new Set(settings.accounts.map(account => account.venue))];

  /** 每个（场所，标的）选一个合约：按场所的计价币顺序取第一个可比、没在下架的。 */
  function index(market: MarketSource): (venue: string, base: string) => SourceQuote | null {
    const wanted = new Set([...settings.bases, ...Object.values(book?.accounts ?? {}).flatMap(account => Object.keys(account.positions))]);
    const found = new Map<string, SourceQuote[]>();
    for (const quote of market.quotes()) {
      if (!wanted.has(quote.base) || quote.comparable === false || quote.delisting) continue;
      const key = `${quote.exchange}|${quote.base}`, list = found.get(key);
      if (list) list.push(quote); else found.set(key, [quote]);
    }
    return (venue, base) => {
      const list = found.get(`${venue}|${base}`), spec = venueSpec(venue);
      if (!list || !spec) return null;
      for (const currency of spec.quotes) { const quote = list.find(item => item.quoteCurrency === currency); if (quote) return quote; }
      return null;
    };
  }

  function targets(pick: ReturnType<typeof index>, at: number): Target[] {
    const list: Target[] = [];
    for (const base of settings.bases) {
      for (const venue of venuesInUse()) {
        const quote = pick(venue, base);
        if (quote) list.push({ key: `funding:${legKey(venue, quote.symbol)}`, kind: 'funding', venue, symbol: quote.symbol, base, want: at - settings.longDays * DAY, segment: fundingSegment(venue) });
      }
      for (const venue of PRICE_VENUES) {
        const quote = pick(venue, base);
        if (!quote) continue;
        list.push({ key: `price:${base}:${legKey(venue, quote.symbol)}`, kind: 'price', venue, symbol: quote.symbol, base, want: Math.floor((at - settings.volDays * DAY) / HOUR) * HOUR - HOUR, segment: PRICE_SEGMENT });
        break;
      }
    }
    return list;
  }

  /** 这条序列下一段要查的范围与查完后的覆盖范围；不用查时为 null。先接上最新的，再往回补。 */
  function need(target: Target, coverage: Coverage | null, at: number): { range: HistoryRange; next: HistoryRange } | null {
    const end = target.kind === 'price' ? Math.floor(at / HOUR) * HOUR : at - 2_000;
    if (!coverage || coverage.from === null || coverage.to === null || end - coverage.to > target.segment) {
      const range = { from: end - target.segment, to: end };
      return { range, next: range };
    }
    const due = target.kind === 'price' ? end > coverage.to : end - coverage.to >= FUNDING_REFRESH_MS;
    if (due) return { range: { from: Math.max(coverage.from, coverage.to - REFRESH_LOOKBACK_MS, end - target.segment), to: end }, next: { from: coverage.from, to: end } };
    if (coverage.from > target.want + HOUR) {
      const from = Math.max(target.kind === 'price' ? target.want : Math.floor(target.want), coverage.from - target.segment);
      return { range: { from, to: coverage.from }, next: { from, to: coverage.to } };
    }
    return null;
  }

  /** 采集一遍；返回 true 表示没有还能马上读的范围了（都补齐，或失败的在退避里）。 */
  async function collectOnce(market: MarketSource, context: LoopContext): Promise<boolean> {
    const started = now(), rev = revision;
    const list = targets(index(market), started);
    let pending = true;
    while (pending && !context.stopped() && !closed && rev === revision && now() - started < budget) {
      pending = false;
      for (const target of list) {
        if (context.stopped() || closed || rev !== revision || now() - started >= budget) break;
        const at = now(), coverage = store.coverage(target.key);
        if (coverage && coverage.retryAt > at) continue;
        const step = need(target, coverage, at);
        if (!step) continue;
        pending = true;
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error('读取超时')), REQUEST_TIMEOUT_MS);
        inflight = controller;
        try {
          const done: Coverage = { from: step.next.from, to: step.next.to, error: null, retryAt: 0 };
          if (target.kind === 'funding') store.addFunding(legKey(target.venue, target.symbol), await market.funding(target.venue, target.symbol, step.range, controller.signal), target.key, done);
          else store.addPrices(target.base, await market.price(target.venue, target.symbol, step.range, controller.signal), target.key, done);
        } catch (error) {
          // 停服或参数刚改（在途的读取被主动中止）：不是这条序列的失败，不记退避。
          if (closed || rev !== revision) break;
          store.setCoverage(target.key, { from: coverage?.from ?? null, to: coverage?.to ?? null, error: errorText(error), retryAt: now() + RETRY_MS });
        } finally { clearTimeout(timer); if (inflight === controller) inflight = null; }
      }
    }
    if (rev !== revision) return false;
    const at = now();
    let done = 0, waiting = 0;
    const errors: string[] = [];
    for (const target of list) {
      const coverage = store.coverage(target.key);
      if (coverage?.error) errors.push(`${target.kind === 'funding' ? '资金费' : '价格'} ${target.venue} ${target.symbol}：${coverage.error}`);
      if (need(target, coverage, at) === null) done += 1;
      else if (!coverage || coverage.retryAt <= at) waiting += 1;
    }
    collect = { done, total: list.length, errors: errors.slice(0, 20) };
    if (at - prunedAt > HOUR) { prunedAt = at; store.prune(at - RETENTION_MS); }
    return waiting === 0;
  }

  function computeRisk(at: number): RiskModel {
    return riskModel(new Map(settings.bases.map(base => [base, store.prices(base, at - settings.volDays * DAY - HOUR)])), at, settings.volDays);
  }

  /** 每条腿的统计与本轮能不能用。 */
  function computeLegs(pick: ReturnType<typeof index>, model: RiskModel, at: number): Map<string, LegInfo> {
    const result = new Map<string, LegInfo>();
    for (const venue of venuesInUse()) for (const base of settings.bases) {
      const quote = pick(venue, base), id = `${venue}|${base}`;
      if (!quote) {
        result.set(id, { key: '', stats: null, usable: false, view: { venue, base, symbol: '', price: null, currentApr: null, shortApr: null, longApr: null, adjustedApr: null, settlements: 0, coverageDays: 0, note: '行情里没有这个合约' } });
        continue;
      }
      const key = legKey(venue, quote.symbol), coverage = store.coverage(`funding:${key}`), price = quotePrice(quote);
      const stats = fundingStats(store.funding(key, at - settings.longDays * DAY), coverage?.from ?? null, at, settings);
      const note = price === null ? '没有价格'
        : coverage?.to == null ? (coverage?.error ? `资金费读取失败：${coverage.error}` : '资金费历史还在回补')
        : at - coverage.to > STALE_FUNDING_MS ? `资金费数据已过期${coverage.error ? `：${coverage.error}` : ''}`
        : !stats ? '资金费历史还没有覆盖短窗口'
        : !model.bases.includes(base) ? '价格样本不足，没进风险模型' : null;
      const currentApr = quote.fundingRate !== null && quote.fundingIntervalHours ? quote.fundingRate / quote.fundingIntervalHours * 8760 : null;
      result.set(id, { key, stats, usable: note === null, view: {
        venue, base, symbol: quote.symbol, price, currentApr, shortApr: stats?.shortApr ?? null, longApr: stats?.longApr ?? null, adjustedApr: stats?.adjustedApr ?? null,
        settlements: stats?.count ?? 0, coverageDays: stats?.coverageDays ?? 0, note,
      } });
    }
    return result;
  }

  function refreshViews(market: MarketSource): void {
    const at = now(), model = computeRisk(at);
    risk = model;
    legsView = [...computeLegs(index(market), model, at).values()].map(info => info.view);
  }

  /** 求解占 CPU：隔几毫秒让出一次事件循环，同进程的其他循环不被卡住。 */
  function yielder(): () => Promise<void> {
    let last = performance.now();
    return async () => {
      if (performance.now() - last < 8) return;
      await new Promise<void>(resolve => setImmediate(resolve));
      last = performance.now();
    };
  }

  async function round(market: MarketSource): Promise<void> {
    const at = now(), rev = revision, current = settings;
    const pick = index(market), model = computeRisk(at), legs = computeLegs(pick, model, at);
    risk = model; legsView = [...legs.values()].map(info => info.view);
    const accounts = current.accounts, ids = accounts.map(account => account.id);
    const working: PaperBook = structuredClone(book ?? newBook(ids, current.capital, at));
    reconcileAccounts(working, ids);

    // 模拟持仓里有参数已删掉的标的时也带进来：它没有可做的腿，求解会把它平掉。
    const bases = [...new Set([...current.bases, ...ids.flatMap(id => Object.keys(working.accounts[id]!.positions))])];
    const prices = accounts.map(account => bases.map(base => { const quote = pick(account.venue, base); return quote ? quotePrice(quote) : null; }));
    for (const [a, account] of accounts.entries()) for (const [base, position] of Object.entries(working.accounts[account.id]!.positions)) {
      const price = prices[a]![bases.indexOf(base)];
      if (price == null) throw new FundingBookError(409, 'no_price', `账户 ${account.id} 的 ${base} 模拟持仓拿不到价格，本轮不规划`);
      accrueFunding(working.accounts[account.id]!, base, store.funding(legKey(account.venue, position.symbol), position.fundingAt), price, at);
    }
    const equity = accounts.map((account, a) => accountEquity(working.accounts[account.id]!, base => prices[a]![bases.indexOf(base)] ?? null) ?? 0);
    const capital = equity.reduce((sum, value) => sum + value, 0);
    if (!(capital > 0)) throw new FundingBookError(409, 'no_capital', '模拟盘的权益已经不为正，重置模拟盘后再规划');

    const modelIndex = bases.map(base => model.bases.indexOf(base));
    const cov = bases.map((_, i) => bases.map((__, j) => modelIndex[i]! >= 0 && modelIndex[j]! >= 0 ? model.cov[modelIndex[i]!]![modelIndex[j]!]! : 0));
    const leg = (a: number, b: number): LegInfo | undefined => legs.get(`${accounts[a]!.venue}|${bases[b]}`);
    const apr = accounts.map((_, a) => bases.map((__, b) => { const info = leg(a, b); return info?.usable && info.stats ? info.stats.adjustedApr : null; }));
    // 当前仓位按每个标的同一个参考价折成名义金额：各场所自己的价格有基差，按各自的价格折，数量配平的两腿名义金额
    // 合计不为零，求解会去「修」它，出单腿订单。目标名义金额也按参考价折回数量，所以各账户的数量合计为零。
    const ref = bases.map((_, b) => { const list = prices.map(row => row[b]).filter((value): value is number => value != null); return list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null; });
    const held = accounts.map((account, a) => bases.map((base, b) => { const position = working.accounts[account.id]!.positions[base]; return position ? position.qty * ref[b]! : 0; }));
    // 有持仓的腿这一轮用不了（资金费读不到、过期或样本不足）而标的还在参数里：这个标的保持不动，等数据恢复。
    const hold = bases.map((base, b) => current.bases.includes(base) && accounts.some((_, a) => held[a]![b] !== 0 && apr[a]![b] === null));
    const solveAccounts: SolveAccount[] = accounts.map(account => ({ id: account.id, mmr: account.mmrPct / 100, maxLeverage: account.maxLeverage, costRate: (account.takerBps + current.slippageBps) / 10_000 }));
    const input: SolveInput = {
      accounts: solveAccounts, cov, apr, current: held, capital, reserve: current.reservePct / 100, sigmas: current.safetySigma,
      horizonDays: current.horizonDays, maxGross: current.maxGrossLeverage, minLeg: current.minLegUsd, hold, band: NO_TRADE_BAND,
    };
    const pause = yielder(), hz = current.horizonDays / 365;
    const solution = await solve(input, pause);
    if (rev !== revision || closed) return;
    const net = (value: Solution): number => value.income - value.cost;

    const planLegs: (PlanLeg | null)[][] = accounts.map((account, a) => bases.map((base, b) => {
      const price = prices[a]![b], symbol = working.accounts[account.id]!.positions[base]?.symbol ?? leg(a, b)?.view.symbol;
      return price != null && symbol && ref[b] != null ? { symbol, price, ref: ref[b]! } : null;
    }));
    let targetEquity = allocate(solution.risk, capital);
    let steps = buildPlan({
      accounts: ids, bases, legs: planLegs, current: held, target: solution.w, equity, targetEquity,
      minOrder: Math.max(5, current.minLegUsd / 5), minTransfer: Math.max(current.minLegUsd, capital * 0.01),
    });
    // 没有订单、每个账户现有的权益也都够它的所需资金时不为了凑比例去划转：浮动盈亏每轮都在账户之间挪动，
    // 照着补就是每轮一次跨所调拨。
    if (!steps.some(step => step.kind === 'order') && accounts.every((_, a) => equity[a]! >= solution.risk[a]!.required)) { steps = []; targetEquity = equity.slice(); }
    const roundBases: RoundBase[] = [];
    for (const [b, base] of bases.entries()) {
      if (!solution.w.some(row => row[b] !== 0)) continue;
      const without = await solve({ ...input, excludeBase: b }, pause);
      if (rev !== revision || closed) return;
      let notional = 0, income = 0, cost = 0;
      const impacts: RoundBase['impacts'] = [];
      for (const [a, account] of accounts.entries()) {
        const value = solution.w[a]![b]!;
        if (value === 0) continue;
        if (value > 0) notional += value;
        income += -value * (apr[a]![b] ?? 0) * hz;
        cost += Math.abs(value) * solveAccounts[a]!.costRate * 2;
        const row = solution.w[a]!.slice(); row[b] = 0;
        const bare = accountRisk(row, solveAccounts[a]!, cov, current.safetySigma), full = solution.risk[a]!;
        impacts.push({
          account: account.id, sigma: full.sigma, sigmaWithout: bare.sigma,
          distance: full.sigma > 0 ? (targetEquity[a]! - full.mm) / full.sigma : null,
          distanceWithout: bare.sigma > 0 ? (targetEquity[a]! - bare.mm) / bare.sigma : null,
        });
      }
      roundBases.push({ base, notional, income, cost, marginal: net(solution) - net(without), impacts });
    }

    let gross = 0, expected = 0, optimistic = 0;
    const roundAccounts: RoundAccount[] = accounts.map((account, a) => {
      const item = solution.risk[a]!;
      gross += item.gross;
      const positions = bases.flatMap((base, b) => {
        const value = solution.w[a]![b]!, info = leg(a, b), price = prices[a]![b];
        if (value === 0 || !info?.stats || price == null) return [];
        expected += -value * info.stats.adjustedApr; optimistic += -value * info.stats.shortApr;
        return [{ base, symbol: info.view.symbol, notional: value, qty: value / (ref[b] ?? price), price, adjustedApr: info.stats.adjustedApr, shortApr: info.stats.shortApr }];
      });
      return { id: account.id, venue: account.venue, equityBefore: equity[a]!, equity: targetEquity[a]!, gross: item.gross, sigma: item.sigma, mm: item.mm, required: item.required,
        distance: item.sigma > 0 ? (targetEquity[a]! - item.mm) / item.sigma : null, positions };
    });
    if (current.paperAuto) applyPlan(working, steps, id => solveAccounts[ids.indexOf(id)]?.costRate ?? 0, at);
    const summary: RoundSummary = { capital, gross, stepCount: steps.length, expectedApr: expected / capital, optimisticApr: optimistic / capital };
    const detail: RoundView = {
      ...summary, id: 0, at, horizonDays: current.horizonDays, safetySigma: current.safetySigma,
      income: solution.income, cost: solution.cost, required: solution.required, lambda: solution.lambda,
      applied: current.paperAuto, accounts: roundAccounts, bases: roundBases, steps,
    };
    const id = store.commitRound(working, at, summary, detail);
    book = working; lastRound = withId(id, detail); rounds = listRounds();
    roundError = null; nextRoundAt = at + current.roundMinutes * 60_000;
  }

  function bookView(pick: ReturnType<typeof index> | null): BookView | null {
    if (!book) return null;
    const venues = new Map(settings.accounts.map(account => [account.id, account.venue]));
    let equity: number | null = 0, funding = 0, fees = 0, realized = 0;
    const accounts = Object.entries(book.accounts).map(([id, account]) => {
      const venue = venues.get(id);
      let own: number | null = account.cash;
      const positions = Object.entries(account.positions).map(([base, position]) => {
        const quote = pick && venue ? pick(venue, base) : null, price = quote ? quotePrice(quote) : null;
        const floating = price === null ? null : unrealized(position, price);
        own = own === null || floating === null ? null : own + floating;
        return { base, symbol: position.symbol, qty: position.qty, entry: position.entry, price, notional: price === null ? null : position.qty * price, unrealized: floating };
      });
      equity = equity === null || own === null ? null : equity + own;
      funding += account.funding; fees += account.fees; realized += account.realized;
      return { id, cash: account.cash, equity: own, funding: account.funding, fees: account.fees, realized: account.realized, positions };
    });
    return { startedAt: book.startedAt, initialCapital: book.initialCapital, equity, funding, fees, realized, accounts };
  }

  const views = {
    state(): StateView {
      const market = source(), running = market?.running() ?? false;
      return {
        running, settings, venues: VENUE_SPECS, collect, roundError, solving,
        lastRoundAt: lastRound?.at ?? null, nextRoundAt: settings.enabled && running ? nextRoundAt : null,
        legs: legsView, risk: risk ? { bases: risk.bases, vol: risk.vol, corr: risk.corr, samples: risk.samples } : null,
        round: lastRound, rounds, book: bookView(running && market ? index(market) : null), checkedAt: now(),
      };
    },
    settings(body: unknown): StateView {
      const next = parseSettings(body);
      if (book) {
        const occupied = occupiedAccounts(book, next.accounts.map(account => account.id));
        if (occupied.length) throw new FundingBookError(409, 'account_in_use', `账户 ${occupied.join('、')} 在模拟盘里还有资金或持仓，先重置模拟盘再删除`);
        const moved = next.accounts.filter(account => {
          const before = settings.accounts.find(item => item.id === account.id), paper = book!.accounts[account.id];
          return before && before.venue !== account.venue && paper && Object.keys(paper.positions).length > 0;
        }).map(account => account.id);
        if (moved.length) throw new FundingBookError(409, 'account_in_use', `账户 ${moved.join('、')} 在模拟盘里还有持仓，先重置模拟盘再换场所`);
      }
      store.saveSettings(next, now());
      settings = next; revision += 1; nextRoundAt = 0; roundError = null;
      inflight?.abort(new Error('参数已修改'));
      return views.state();
    },
    /** 立即规划一轮（等这一遍采集结束后）。 */
    plan(): StateView {
      if (!settings.enabled) throw new FundingBookError(409, 'disabled', '模块还没有启用');
      nextRoundAt = 0;
      return views.state();
    },
    reset(body: unknown): StateView {
      if (!body || typeof body !== 'object' || (body as { confirm?: unknown }).confirm !== true) throw new FundingBookError(400, 'confirm_required', '重置模拟盘须带上确认');
      store.resetPaper();
      book = null; lastRound = null; rounds = []; revision += 1; nextRoundAt = 0; roundError = null;
      return views.state();
    },
    round(id: number): RoundView {
      const detail = Number.isSafeInteger(id) && id > 0 ? store.round(id) : null;
      if (!detail) throw new FundingBookError(404, 'not_found', '没有这一轮规划');
      return withId(id, detail);
    },
  };

  return {
    views,
    /** 停服：中止在途的读取，循环在下一个检查点退出。 */
    quiesce(): void { closed = true; inflight?.abort(new Error('服务正在停止')); },
    async loop(context: LoopContext): Promise<void> {
      while (!context.stopped() && !closed) {
        const market = source();
        if (!settings.enabled || !market?.running()) { await context.pause(3_000); continue; }
        let settled = false;
        try { settled = await collectOnce(market, context); refreshViews(market); }
        catch (error) { log(`fundingbook: 采集出错：${errorText(error)}`); }
        if (settled && !context.stopped() && !closed && now() >= nextRoundAt) {
          solving = true;
          try { await round(market); }
          catch (error) {
            roundError = errorText(error); nextRoundAt = now() + 60_000;
            if (!(error instanceof FundingBookError)) log(`fundingbook: 规划出错：${roundError}`);
          } finally { solving = false; }
        }
        await context.pause(settled ? 15_000 : 1_000);
      }
    },
  };
}
export type FundingBookEngine = ReturnType<typeof createFundingBookEngine>;
export { DEFAULT_SETTINGS };
