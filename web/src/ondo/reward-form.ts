// The reward section's forms (docs/ondo.md §6): the simulation's parameters (kept in this browser only) and the reward
// settings the service saves. Kept free of the DOM so the server-side tests can import it.
import type { SimParams } from '../../../src/ondo/reward-sim.ts';
import type { OndoRewardConfig } from '../../../src/ondo/reward-types.ts';
import type { OndoMmConfig } from './ondo-mm-types.ts';

export type SimForm = {
  sizeUsd: string; distanceBps: string; minBps: string; reactionSec: string; holdSec: string; decayK: string; uptimePct: string; sides: '1' | '2';
};
export const SIM_STORAGE_KEY = 'ondo-reward-sim';
const FIELDS = ['sizeUsd', 'distanceBps', 'minBps', 'reactionSec', 'holdSec', 'decayK', 'uptimePct', 'sides'] as const;

/** Starting values: the quote from the saved quoting settings, the model's own assumptions for the rest. */
export function defaultSimForm(config: Pick<OndoMmConfig, 'orderUsd' | 'targetBps' | 'minBps'> | null): SimForm {
  return { sizeUsd: config?.orderUsd ?? '100', distanceBps: config?.targetBps ?? '4', minBps: config?.minBps ?? '3', reactionSec: '1', holdSec: '60', decayK: '0.1', uptimePct: '95', sides: '2' };
}

/** A form saved earlier in this browser, or null when absent or not a whole form. */
export function readSimForm(raw: string | null): SimForm | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || !FIELDS.every(key => typeof value[key] === 'string' && (value[key] as string).length <= 20)) return null;
    if (value.sides !== '1' && value.sides !== '2') return null;
    return Object.fromEntries(FIELDS.map(key => [key, value[key]])) as SimForm;
  } catch { return null; }
}

const number = (text: string, name: string, low: number, high: number): number => {
  const value = Number(text.trim());
  if (!text.trim() || !Number.isFinite(value) || value < low || value > high) throw new Error(`${name}须为 ${low}–${high}`);
  return value;
};

/** The simulation's parameters, or the first field that is wrong. */
export function simParams(form: SimForm, config: Pick<OndoRewardConfig, 'poolUsd' | 'eligible'>): { params: SimParams } | { error: string } {
  try {
    const distanceBps = number(form.distanceBps, '挂单距离', 0, 50), minBps = number(form.minBps, '最近距离', 0, 50);
    if (minBps > distanceBps) throw new Error('最近距离不能大于挂单距离');
    return { params: {
      poolUsd: Number(config.poolUsd), eligible: config.eligible,
      sizeUsd: number(form.sizeUsd, '每单金额', 0, 10_000_000), distanceBps, minBps,
      reactionSec: number(form.reactionSec, '撤单反应时间', 0.05, 600), holdSec: number(form.holdSec, '平仓耗时', 0, 86_400),
      decayK: number(form.decayK, '衰减系数 k', 0, 10), uptime: number(form.uptimePct, '在线比例', 0, 100) / 100, sides: form.sides === '1' ? 1 : 2,
    } };
  } catch (error) { return { error: (error as Error).message }; }
}

export type RewardConfigForm = { markets: string; poolUsd: string; eligible: string };
export const rewardConfigForm = (config: OndoRewardConfig): RewardConfigForm => ({ markets: config.markets.join(', '), poolUsd: config.poolUsd, eligible: String(config.eligible) });

/** The body of PUT /api/ondo/rewards/config; the service checks it again. */
export function rewardConfigRequest(form: RewardConfigForm): { body: OndoRewardConfig } | { error: string } {
  const markets = [...new Set(form.markets.split(/[\s,，、]+/).filter(Boolean).map(item => item.toUpperCase()))];
  if (!markets.length) return { error: '至少填写一个市场' };
  const bad = markets.find(item => !/^[A-Z0-9]{1,16}-USD\.P$/.test(item));
  if (bad) return { error: `市场代码 ${bad} 无效（如 NVDA-USD.P）` };
  const poolUsd = form.poolUsd.trim().replace(/,/g, '');
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(poolUsd) || Number(poolUsd) <= 0) return { error: '每周奖池须为大于 0 的美元数' };
  const eligible = Number(form.eligible.trim());
  if (!Number.isInteger(eligible) || eligible < 1 || eligible > 100) return { error: '参与分配的市场数须为 1–100 的整数' };
  return { body: { markets, poolUsd, eligible } };
}
