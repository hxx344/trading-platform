// Expected quoting income on an Ondo reward market (docs/ondo.md §6). Pure; the page runs it on the averaged depth the
// service collects, so every assumption here is a parameter the page shows.
//
// Reward (Ondo's published rules): every snapshot scores each quote size × e^(−k·distance) inside its band (0–5 bps 85%,
// 5–10 bps 10%, 10–25 bps 5%); each market gets an equal share of the weekly pool; bid and ask are scored on their own,
// which this model reads as half the market's pool per side. My share of a band is my score over everyone's.
// Fills (a model, not a rule): the mid is a random walk with the measured one-minute volatility; the quote is filled when
// the mid moves past its closest distance (minBps) within one reaction time τ, before it is moved away. A fill costs the
// expected absolute move over the time to close the position (taken as wholly adverse) plus the maker fee twice, and
// takes the market's quotes down for that time: no reward and no further fill until the position is closed.
import { BUCKET_BPS, BUCKETS } from './reward-types.ts';

export const BANDS = [{ from: 0, to: 5, weight: 0.85 }, { from: 5, to: 10, weight: 0.10 }, { from: 10, to: 25, weight: 0.05 }] as const;
const DAY_S = 86_400;

export interface SimParams {
  poolUsd: number;
  eligible: number;
  /** My quote's USD size on each side. */
  sizeUsd: number;
  /** Where my quote rests, in bps from the mid: decides its band and score. */
  distanceBps: number;
  /** The closest the quote gets to the mid before it is moved (the quoting setting minBps). */
  minBps: number;
  /** Seconds from the mid moving to the quote being moved away (re-pricing delay). */
  reactionSec: number;
  /** Seconds to close a filled position. */
  holdSec: number;
  /** The score's decay per bps (Ondo does not publish k; 0 scores every size in a band the same). */
  decayK: number;
  /** Share of snapshots my quote is up for (0–1). */
  uptime: number;
  sides: 1 | 2;
}

export interface SimMarket {
  /** Average USD per bucket of other makers (BUCKETS × BUCKET_BPS from the mid). */
  bid: readonly number[];
  ask: readonly number[];
  sigma1m: number | null;
  /** Maker fee rate (0.0001 = 1 bps); null counts as 0. */
  makerFee: number | null;
}

export interface SimResult {
  /** Index into BANDS, or null beyond 25 bps (no reward). */
  band: number | null;
  /** My score on one side, and the others' score in that band per side. */
  myScore: number;
  others: { bid: number; ask: number };
  /** My share of the band, per side (0–1). */
  share: { bid: number; ask: number };
  /** After the time lost to closing filled positions. */
  rewardDay: number;
  /** Share of the day not spent closing a filled position (1 without a volatility estimate). */
  quoting: number;
  /** Null without a volatility estimate. */
  fillsDay: number | null;
  lossPerFill: number | null;
  lossDay: number | null;
  netDay: number | null;
  /** The pool this market's chosen sides could pay at most per day (my share 100%, full uptime). */
  capDay: number;
}

export const bandOf = (bps: number): number | null => {
  if (!(bps >= 0) || bps >= 25) return null;
  return BANDS.findIndex(band => bps < band.to);
};

/** Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7), enough for a fill estimate. */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Everyone else's score per band on one side: Σ bucket USD × e^(−k·bucket centre). */
export function bandScores(buckets: readonly number[], decayK: number): number[] {
  const scores = BANDS.map(() => 0);
  for (let i = 0; i < Math.min(buckets.length, BUCKETS); i++) {
    const centre = (i + 0.5) * BUCKET_BPS, band = bandOf(centre), usd = buckets[i];
    if (band !== null && Number.isFinite(usd) && usd > 0) scores[band] += usd * Math.exp(-decayK * centre);
  }
  return scores;
}

/** Fills a day on one side: (day / τ) windows, each with the reflection-principle chance the mid travels minBps. */
export function fillsPerDay(sigma1m: number, minBps: number, reactionSec: number): number {
  const sigmaSec = sigma1m / Math.sqrt(60);
  if (!(sigmaSec > 0) || !(reactionSec > 0)) return 0;
  const z = (minBps / 1e4) / (sigmaSec * Math.sqrt(reactionSec));
  return DAY_S / reactionSec * Math.min(1, 2 * (1 - normalCdf(z)));
}

/**
 * Share of the day the quotes are up when each fill takes them down for holdSec: `rate` fills a day while quoting make
 * rate × share fills, each followed by holdSec without quotes, rewards or further fills.
 */
export function quotingShare(rate: number, holdSec: number): number {
  return rate > 0 && holdSec > 0 ? 1 / (1 + rate * holdSec / DAY_S) : 1;
}

export function simulate(market: SimMarket, params: SimParams): SimResult {
  const band = bandOf(params.distanceBps);
  const perSideDay = params.eligible > 0 ? params.poolUsd / params.eligible / 7 / 2 : 0;
  const myScore = params.sizeUsd > 0 ? params.sizeUsd * Math.exp(-params.decayK * params.distanceBps) : 0;
  const othersOf = (buckets: readonly number[]) => band === null ? 0 : bandScores(buckets, params.decayK)[band];
  const others = { bid: othersOf(market.bid), ask: othersOf(market.ask) };
  const shareOf = (theirs: number) => band === null || myScore <= 0 ? 0 : myScore / (theirs + myScore);
  const share = { bid: shareOf(others.bid), ask: shareOf(others.ask) };
  const weight = band === null ? 0 : BANDS[band].weight;
  const uptime = Math.min(1, Math.max(0, params.uptime));
  // One side quotes the bid only (a choice of the page, not of Ondo).
  const sideShares = params.sides === 2 ? share.bid + share.ask : share.bid;
  const gross = uptime * perSideDay * weight * sideShares;
  const capDay = perSideDay * weight * params.sides;
  if (market.sigma1m === null || !(market.sigma1m >= 0)) return { band, myScore, others, share, rewardDay: gross, quoting: 1, fillsDay: null, lossPerFill: null, lossDay: null, netDay: null, capDay };
  const rate = uptime * params.sides * fillsPerDay(market.sigma1m, params.minBps, params.reactionSec);
  const quoting = quotingShare(rate, params.holdSec);
  const fillsDay = rate * quoting;
  const rewardDay = gross * quoting;
  const sigmaSec = market.sigma1m / Math.sqrt(60);
  const lossPerFill = params.sizeUsd * (sigmaSec * Math.sqrt(Math.max(0, params.holdSec)) * Math.sqrt(2 / Math.PI) + 2 * (market.makerFee ?? 0));
  const lossDay = fillsDay * lossPerFill;
  return { band, myScore, others, share, rewardDay, quoting, fillsDay, lossPerFill, lossDay, netDay: rewardDay - lossDay, capDay };
}

/** The same quote at several distances (minBps keeps its gap below the distance, at least 0.5 bps). */
export function sweep(market: SimMarket, params: SimParams, distances: readonly number[]): { distanceBps: number; result: SimResult }[] {
  const gap = Math.max(0, params.distanceBps - params.minBps);
  return distances.map(distanceBps => ({ distanceBps, result: simulate(market, { ...params, distanceBps, minBps: Math.max(0.5, distanceBps - gap) }) }));
}

export const SWEEP_BPS = [1, 2, 3, 4, 4.8, 6, 8, 12, 20] as const;
