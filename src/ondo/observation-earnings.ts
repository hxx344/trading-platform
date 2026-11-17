import type { OndoMmConfig } from '../vendor/ondo/mm.mjs';
import { BANDS, bandOf, simulate } from './reward-sim.ts';
import { BUCKETS, type OndoObservationEarnings, type OndoObservationTier, type OndoRewardConfig, type OndoRewardMarket } from './reward-types.ts';

export const OBSERVATION_WINDOW_MIN = 60;
const MIN_QUOTE_MS = 60_000, MAX_SAMPLE_AGE_MS = 120_000;
const REACTION_SEC = 1, DECAY_K = 0.1;
const DISTANCES = [4, 8, 15] as const;

interface ObservationExposure {
  startedAt: number;
  rows: { market: string; side: 'buy' | 'sell'; distanceBps: OndoObservationTier['distanceBps']; activeMs: number }[];
}
interface ObservationMarketStatus { market: string; issue: string | null; makerFee: string | null }
export type ObservationEstimator = (observation: ObservationExposure, status: ObservationMarketStatus[], at: number) => OndoObservationEarnings;

/** The session fixes order size, quote band, exit horizon and pool split. Only its effective times and public samples advance. */
export function observationEarnings(config: OndoMmConfig, pool: OndoRewardConfig, observation: ObservationExposure,
  status: readonly ObservationMarketStatus[], history: readonly Pick<OndoRewardMarket, 'market' | 'avg' | 'returns' | 'sigma1m'>[], at: number): OndoObservationEarnings {
  const orderUsd = Number(config.orderUsd), poolUsd = Number(pool.poolUsd), elapsed = Math.max(0, at - observation.startedAt);
  const gapBps = Number(config.targetBps) - Number(config.minBps);
  const uptime = (ms: number) => elapsed > 0 ? Math.min(1, Math.max(0, ms / elapsed)) : 0;
  const markets = status.map(({ market, issue, makerFee: fee }) => {
    const sample = history.find(item => item.market === market), sampleAt = sample?.avg.to ?? null;
    const makerFee = fee !== null && fee.trim() !== '' && Number.isFinite(Number(fee)) ? Number(fee) : null;
    const sigma = sample?.sigma1m;
    const sigma1m = typeof sigma === 'number' && Number.isFinite(sigma) && sigma >= 0 ? sigma : null;
    const rows = observation.rows.filter(row => row.market === market);
    let reason = issue;
    if (!reason && !pool.markets.includes(market)) reason = '该市场未列入本轮启动时的奖励采集名单';
    if (!reason && (sampleAt === null || !sample?.avg.samples)) reason = '等待完整的奖励分钟样本';
    if (!reason && sampleAt !== null && (at < sampleAt || at - sampleAt > MAX_SAMPLE_AGE_MS)) reason = '奖励分钟样本已过期';
    if (!reason && sample && [sample.avg.bid, sample.avg.ask].some(side => side.length !== BUCKETS || side.some(usd => !Number.isFinite(usd) || usd < 0))) reason = '奖励盘口分档深度无效';
    const tiers = DISTANCES.map((distanceBps): OndoObservationTier => {
      const buyMs = rows.find(row => row.distanceBps === distanceBps && row.side === 'buy')?.activeMs ?? 0;
      const sellMs = rows.find(row => row.distanceBps === distanceBps && row.side === 'sell')?.activeMs ?? 0;
      const buyUptime = uptime(buyMs), sellUptime = uptime(sellMs);
      const tier = { distanceBps, buyUptime, sellUptime, rewardDay: null, lossDay: null, netDay: null, reason };
      if (reason || !sample) return tier;
      if (elapsed < MIN_QUOTE_MS || Math.max(buyMs, sellMs) < MIN_QUOTE_MS) return { ...tier, reason: '至少一侧有效虚挂须满 60 秒' };
      const band = BANDS[bandOf(distanceBps)!], { bid, ask, cover } = sample.avg;
      if ((cover.bid ?? 0) < band.to || (cover.ask ?? 0) < band.to) return { ...tier, reason: `买卖盘口需完整覆盖 ${band.to} bps 奖励档` };

      // Unit uptime gives both sides' scores and the daily cost for two fully active sides. Weight each independently;
      // observed touches are queue-dependent and cannot be counted as fills. The trial's inner bound is floored at 0.1 bps.
      const sim = simulate({ bid, ask, sigma1m, makerFee }, { poolUsd, eligible: pool.eligible, sizeUsd: orderUsd, distanceBps,
        minBps: Math.max(0.1, distanceBps - gapBps), reactionSec: REACTION_SEC, holdSec: config.maxHoldSec, decayK: DECAY_K, uptime: 1, sides: 2 });
      const rewardDay = sim.capDay / 2 * (sim.share.bid * buyUptime + sim.share.ask * sellUptime);
      if (makerFee === null) return { ...tier, rewardDay, reason: '公开 Maker 费率缺失' };
      if (sim.lossDay === null) return { ...tier, rewardDay, reason: '波动率样本不足，需 20 个有效收益样本' };
      const lossDay = sim.lossDay / 2 * (buyUptime + sellUptime);
      return { ...tier, rewardDay, lossDay, netDay: rewardDay - lossDay };
    });
    return { market, sampleAt, samples: sample?.avg.samples ?? 0, returns: sample?.returns ?? 0, makerFee, sigma1m, tiers };
  });
  return { asOf: at, windowMin: OBSERVATION_WINDOW_MIN, orderUsd, referenceCapitalUsd: 2 * orderUsd, poolUsd, eligible: pool.eligible,
    reactionSec: REACTION_SEC, holdSec: config.maxHoldSec, decayK: DECAY_K, markets };
}
