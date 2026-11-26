// 资金费组合的模拟盘（docs/fundingbook.md 第 6 节）：按规划的步骤记账，不向任何交易所发单。每个账户一份现金，
// 每个（账户，标的）至多一个持仓；权益 = 现金 + 各持仓的浮动盈亏。成交按规划时的价格，手续费与滑点按账户的
// 单边成本率从现金里扣；资金费按已结算记录逐笔计，持仓数量取计入那一刻的数量。
import type { PlanStep } from './plan.ts';
import type { FundingRecord } from './stats.ts';

export interface PaperPosition {
  symbol: string;
  /** 带符号的数量（标的单位），多为正。 */
  qty: number;
  entry: number;
  /** 已计入资金费的最后一次结算时间；晚于它的结算才计。 */
  fundingAt: number;
}
export interface PaperAccount { cash: number; funding: number; fees: number; realized: number; positions: Record<string, PaperPosition> }
export interface PaperBook { startedAt: number; initialCapital: number; accounts: Record<string, PaperAccount> }

const empty = (cash = 0): PaperAccount => ({ cash, funding: 0, fees: 0, realized: 0, positions: {} });

/** 新的模拟盘：本金全部在第一个账户，第一轮规划会把它划到各账户。 */
export function newBook(accounts: readonly string[], capital: number, now: number): PaperBook {
  return { startedAt: now, initialCapital: capital, accounts: Object.fromEntries(accounts.map((id, index) => [id, empty(index === 0 ? capital : 0)])) };
}

/** 参数里删掉的账户还留着现金或持仓时返回它们的名称（先重置模拟盘才能删）。 */
export function occupiedAccounts(book: PaperBook, keep: readonly string[]): string[] {
  return Object.entries(book.accounts).filter(([id, account]) => !keep.includes(id) && (Math.abs(account.cash) > 1e-6 || Object.keys(account.positions).length > 0)).map(([id]) => id);
}

/** 让账户表与参数一致：补上新加的账户，去掉已删且空着的账户。 */
export function reconcileAccounts(book: PaperBook, accounts: readonly string[]): void {
  for (const id of accounts) book.accounts[id] ??= empty();
  for (const id of Object.keys(book.accounts)) if (!accounts.includes(id) && !occupiedAccounts(book, accounts).includes(id)) delete book.accounts[id];
}

export function unrealized(position: PaperPosition, price: number): number { return position.qty * (price - position.entry); }

/** 账户权益；有持仓拿不到价格时返回 null。 */
export function accountEquity(account: PaperAccount, priceOf: (base: string) => number | null): number | null {
  let equity = account.cash;
  for (const [base, position] of Object.entries(account.positions)) {
    const price = priceOf(base);
    if (price === null) return null;
    equity += unrealized(position, price);
  }
  return equity;
}

/**
 * 把一个持仓在 `position.fundingAt` 之后的结算计入现金：多头按正费率付出，空头收入。名义金额用当前价格近似
 * （结算那一刻的标记价没有存）。返回计入的金额。
 */
export function accrueFunding(account: PaperAccount, base: string, records: readonly FundingRecord[], price: number, now: number): number {
  const position = account.positions[base];
  if (!position) return 0;
  let paid = 0, last = position.fundingAt;
  for (const { time, rate } of records) {
    if (time <= position.fundingAt || time > now) continue;
    paid += -position.qty * price * rate;
    if (time > last) last = time;
  }
  position.fundingAt = last;
  account.cash += paid; account.funding += paid;
  return paid;
}

/** 按规划记账。`costRate` 是账户的单边成本率（手续费加滑点，小数）。 */
export function applyPlan(book: PaperBook, steps: readonly PlanStep[], costRate: (account: string) => number, now: number): void {
  for (const step of steps) {
    const account = book.accounts[step.account];
    if (!account) continue;
    if (step.kind === 'transfer') {
      const receiver = step.to ? book.accounts[step.to] : undefined;
      if (!receiver) continue;
      account.cash -= step.notional; receiver.cash += step.notional;
      continue;
    }
    if (!step.base || !step.symbol || !step.price || !step.qty) continue;
    const held = account.positions[step.base], price = step.price;
    const change = step.close && held ? -held.qty : step.side === 'buy' ? step.qty : -step.qty;
    const fee = Math.abs(change) * price * costRate(step.account);
    account.cash -= fee; account.fees += fee;
    if (!held || held.qty === 0) { account.positions[step.base] = { symbol: step.symbol, qty: change, entry: price, fundingAt: now }; continue; }
    if (held.qty * change > 0) {
      held.entry = (held.entry * Math.abs(held.qty) + price * Math.abs(change)) / (Math.abs(held.qty) + Math.abs(change));
      held.qty += change;
      continue;
    }
    const closed = Math.min(Math.abs(change), Math.abs(held.qty)), gain = closed * (price - held.entry) * Math.sign(held.qty);
    account.cash += gain; account.realized += gain;
    const left = held.qty + change;
    if (Math.abs(left) * price < 1e-6) delete account.positions[step.base];
    else if (left * held.qty > 0) held.qty = left;
    // 反手：剩下的部分是按这笔的价格新开的仓。
    else account.positions[step.base] = { symbol: step.symbol, qty: left, entry: price, fundingAt: now };
  }
}
