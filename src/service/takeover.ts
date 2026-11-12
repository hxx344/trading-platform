// The checks run before a pair is switched on in this service. The workbench must have stopped and deleted the same pair
// first; these reads look for signs that it, or anything else, still acts on the sub-accounts (a USD1 transfer this
// service did not make within the window, a workbench ADL reduction order still resting), and for a hedge that is
// already off: ADL history is only scanned from the takeover on, so an ADL in the gap shows here instead.
import { ContractError, type PairSide } from '../contracts.ts';
import { add, cmp, sub } from '../decimal.ts';
import { parseAsterPositions } from '../positions.ts';
import type { PairRecord } from '../transfer.ts';
import type { AsterTransferConnector } from '../aster/transfer.ts';
import type { AsterTradingConnector } from '../aster/trading.ts';

export const TAKEOVER_WINDOW_MS = 10 * 60_000;
const TAKEOVER_TIMEOUT_MS = 20_000;
/** The workbench's reduction orders (modules/aster/trading/adl.py) and this service's. */
const ADL_ORDER = /^adl[_-]/;
const SIDE_NAMES: Record<PairSide, string> = { long: '多侧', short: '空侧' };
const CLOCK_TOLERANCE_MS = 5_000;
const mask = (id: string): string => `***${id.slice(-4)}`;

export interface TakeoverDeps {
  transfers: Pick<AsterTransferConnector, 'history'>;
  trading: Pick<AsterTradingConnector, 'allOpenOrders' | 'positions'>;
  now?: () => number;
  timeoutMs?: number;
}

const refuse = (message: string): never => { throw new ContractError(409, 'takeover_refused', message); };

export function createTakeoverGuard({ transfers, trading, now = Date.now, timeoutMs = TAKEOVER_TIMEOUT_MS }: TakeoverDeps) {
  return async function enableGuard(pair: Readonly<PairRecord>): Promise<void> {
    const signal = AbortSignal.timeout(timeoutMs);
    const from = now() - TAKEOVER_WINDOW_MS;
    const own = new Set(pair.usedReceipts.map(item => item.tranId));
    for (const side of ['long', 'short'] as const) {
      let history;
      try { history = await transfers.history(pair.mainAccountId, pair[side], { from, to: null }, { signal }); }
      catch (error) { return refuse(`接管检查无法读取${SIDE_NAMES[side]}划转流水：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}；稍后重试`); }
      if (!history.complete) refuse(`${SIDE_NAMES[side]}近 10 分钟划转流水读取不完整，无法确认没有其他程序在划转；稍后重试`);
      const foreign = history.rows.filter(row => !own.has(row.tranId));
      if (foreign.length) refuse(`${SIDE_NAMES[side]}近 10 分钟有 ${foreign.length} 笔不是本平台记账的 USD1 划转（${foreign.slice(0, 3).map(row => mask(row.tranId)).join('、')}）。请确认工作台已停用并删除该配对，最后一笔划转满 10 分钟后再启用`);
      let orders;
      try { orders = await trading.allOpenOrders(pair[side], { signal }); }
      catch (error) { return refuse(`接管检查无法读取${SIDE_NAMES[side]}挂单：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}；稍后重试`); }
      const adl = orders.filter(order => ADL_ORDER.test(order.clientOrderId));
      if (adl.length) refuse(`${SIDE_NAMES[side]}有未结束的 ADL 减仓挂单（${[...new Set(adl.map(order => order.symbol))].join('、')}），工作台可能仍在处理 ADL；结束后再启用`);
    }
    // Both sides together must hold no net position in any symbol, as after any completed ADL handling.
    const totals = new Map<string, string>();
    for (const side of ['long', 'short'] as const) {
      let snapshot;
      try { snapshot = parseAsterPositions(await trading.positions(pair[side], { signal }), pair[side], now(), CLOCK_TOLERANCE_MS); }
      catch (error) { return refuse(`接管检查无法读取${SIDE_NAMES[side]}持仓：${error instanceof Error ? error.message.slice(0, 120) : '未知错误'}；稍后重试`); }
      for (const row of snapshot.positions) totals.set(row.symbol, (row.direction === 'long' ? add : sub)(totals.get(row.symbol) ?? '0', row.quantity));
    }
    const off = [...totals].filter(([, value]) => cmp(value, '0') !== 0).sort(([a], [b]) => a < b ? -1 : 1);
    if (off.length) refuse(`两侧持仓不对冲：${off.slice(0, 5).map(([symbol, value]) => `${symbol} 净${cmp(value, '0') > 0 ? '多' : '空'} ${value.replace(/^-/, '')}`).join('、')}。可能在停用工作台后发生过 ADL，请先人工处理到两侧一致再启用`);
  };
}
