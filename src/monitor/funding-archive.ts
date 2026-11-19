// Exact venue settlements and the inclusive windows that actually finished paging. One leg can
// be shared by a comparison and a scheduled collector without borrowing the other's projections.
import type { Exchange, SpreadMarket } from '../vendor/exchange-comparison.mjs';
import type { FundingHistoryRange, FundingFact, FundingSide } from '../vendor/exchange-funding-history.mjs';
import type { MonitorStore } from './store.ts';

export type { FundingFact, FundingSide };
type Range = FundingHistoryRange;
export type FundingProof = Range & { checkedAt: number };
type Proof = FundingProof;
type FundingLeg = { records: FundingFact[]; proofs: Proof[] };
export type ReadFundingLeg = (market: SpreadMarket, exchange: Exchange, side: FundingSide, range: Range, signal: AbortSignal) => Promise<FundingFact[]>;
export class FundingArchiveWriteError extends Error {}
const DAY = 86_400_000;
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const empty = (): FundingLeg => ({ records: [], proofs: [] });

function uncovered(range: Range, proofs: Proof[], since: number): Range[] {
  let from = range.from;
  const missing = [];
  for (const proof of proofs) {
    if (proof.from > range.to) break;
    if (proof.to < from || proof.checkedAt < since) continue;
    if (from < proof.from) missing.push({ from, to: proof.from - 1 });
    from = Math.max(from, proof.to + 1);
  }
  if (from <= range.to) missing.push({ from, to: range.to });
  return missing;
}

function recordProof(proofs: Proof[], added: Proof, cutoff: number): Proof[] {
  const next = [added];
  for (const proof of proofs) {
    if (proof.to < cutoff) continue;
    if (proof.to < added.from || proof.from > added.to) next.push(proof);
    else {
      if (proof.from < added.from) next.push({ ...proof, to: added.from - 1 });
      if (proof.to > added.to) next.push({ ...proof, from: added.to + 1 });
    }
  }
  return next.filter(proof => proof.to >= cutoff).map(proof => proof.from < cutoff ? { ...proof, from: cutoff } : proof).sort((a, b) => a.from - b.from);
}

function checkedFacts(records: FundingFact[], range: Range): Map<number, FundingFact> {
  if (!Array.isArray(records) || records.length > 20_000) throw Error('Invalid funding history size');
  const result = new Map<number, FundingFact>();
  for (const row of records) {
    if (!row || !time(row.time) || row.time < range.from || row.time > range.to || !Number.isFinite(row.rate) || Math.abs(row.rate) > 1 || row.special !== undefined && row.special !== true) throw Error('Invalid funding history records');
    const old = result.get(row.time);
    if (old && (old.rate !== row.rate || old.special !== row.special)) throw Error('Conflicting funding settlements');
    result.set(row.time, row);
  }
  return result;
}

/** Load once per leg. Only the executor receives a store. A failed write leaves the last durable range in memory. */
export function createFundingArchive(store?: Pick<MonitorStore, 'loadFundingFacts' | 'writeFundingFacts'>, now = Date.now) {
  const legs = new Map<string, FundingLeg>(), pending = new Map<string, Promise<unknown>>();
  const keyOf = (market: SpreadMarket, exchange: Exchange, side: FundingSide) => `funding.raw.v1.${market}.${exchange}.${side}`;
  function state(key: string): FundingLeg {
    let leg = legs.get(key);
    if (!leg) {
      const saved = store?.loadFundingFacts(key);
      if (saved && (saved.proofs.length || saved.records.length)) {
        if (!saved.proofs.length || !saved.proofs.every((p, i) => p && time(p.from) && time(p.to) && time(p.checkedAt) && p.from <= p.to && p.to <= p.checkedAt && (!i || saved.proofs[i - 1]!.to < p.from))) throw Error('Invalid stored funding coverage');
        const records = checkedFacts(saved.records, { from: saved.proofs[0]!.from, to: saved.proofs.at(-1)!.to });
        let i = 0;
        for (const row of records.values()) {
          while (saved.proofs[i] && saved.proofs[i]!.to < row.time) i++;
          if (!saved.proofs[i] || row.time < saved.proofs[i]!.from) throw Error('Invalid stored funding coverage');
        }
        leg = { proofs: saved.proofs, records: [...records.values()] };
      } else leg = empty();
      legs.set(key, leg);
    }
    return leg;
  }
  function slice(leg: FundingLeg, range: Range) {
    const proofs = leg.proofs.filter(p => p.to >= range.from && p.from <= range.to);
    return { records: leg.records.filter(row => row.time >= range.from && row.time <= range.to), proofs,
      fetchedAt: proofs.reduce((at, p) => Math.max(at, p.checkedAt), 0) };
  }
  return {
    inspect: (market: SpreadMarket, exchange: Exchange, side: FundingSide, range: Range) => slice(state(keyOf(market, exchange, side)), range),
    async read(market: SpreadMarket, exchange: Exchange, side: FundingSide, range: Range, load: ReadFundingLeg, signal: AbortSignal, since = 0) {
      const key = keyOf(market, exchange, side);
      // Replan after the previous reader commits, even when it failed after committing only one of its windows.
      const work = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        signal.throwIfAborted();
        let leg = state(key);
        for (const gap of uncovered(range, leg.proofs, since)) {
          const received = await load(market, exchange, side, gap, signal);
          signal.throwIfAborted();
          const incoming = checkedFacts(received, gap), checkedAt = now();
          if (gap.to > checkedAt) throw Error('Future funding query coverage');
          const retention = (market === 'oil' && exchange === 'binance' || market === 'hynix' && exchange === 'hyperliquid') ? 400 : 60;
          const cutoff = Math.min(range.from, checkedAt - retention * DAY);
          const records = new Map(leg.records.filter(row => row.time >= cutoff).map(row => [row.time, row]));
          const added: FundingFact[] = [];
          for (const [stamp, fact] of incoming) {
            const old = records.get(stamp);
            if (old && (old.rate !== fact.rate || old.special !== fact.special)) throw Error('Conflicting funding settlements');
            if (!old) added.push(fact);
            records.set(stamp, fact);
          }
          const next = { records: [...records.values()].sort((a, b) => a.time - b.time), proofs: recordProof(leg.proofs, { ...gap, checkedAt }, cutoff) };
          if (store) {
            const oldProofs = new Set(leg.proofs), newProofs = new Set(next.proofs);
            try { store.writeFundingFacts(key, added, cutoff, leg.proofs.filter(p => !newProofs.has(p)), next.proofs.filter(p => !oldProofs.has(p))); }
            catch (cause) { throw new FundingArchiveWriteError('monitor.sqlite 写入失败', { cause }); }
          }
          legs.set(key, next); leg = next;
        }
        return slice(leg, range);
      });
      pending.set(key, work);
      return new Promise<ReturnType<typeof slice>>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        work.then(resolve, reject).finally(() => {
          signal.removeEventListener('abort', abort);
          if (pending.get(key) === work) pending.delete(key);
        });
        if (signal.aborted) abort();
      });
    },
  };
}
export type FundingArchive = ReturnType<typeof createFundingArchive>;
