// Paper positions (src/vendor/perpetual-paper.ts) that pass validatePerpetualPaperState, for the M-5e2 import tests and
// deploy/test-install.sh: Binance long, Bybit short on BTC, opened an hour before now (or before `closedAt`, which makes a
// stopped record).
import type { PerpetualPaperPosition, PerpetualPaperState } from '../src/vendor/perpetual-paper.ts';

export function paperPosition(id: string, { closedAt, at = (closedAt ?? Date.now()) - 3_600_000, requestId }: { at?: number; closedAt?: number; requestId?: string } = {}): PerpetualPaperPosition {
  const position = {
    id, mode: 'paper', status: closedAt === undefined ? 'active' : 'stopped', base: 'BTC', longKey: 'binance:BTCUSDT', shortKey: 'bybit:BTCUSDT',
    identity: 'binance:BTCUSDT|bybit:BTCUSDT', note: '', quantity: 10, entryLongPrice: 100, entryShortPrice: 104, entryFeePaid: 1, settledFunding: 0,
    capital: null, targetNetProfit: null, maxHoldingHours: null, takerOverrides: {},
    openedAt: at, createdAt: at, updatedAt: closedAt ?? at, fundingUpdatedAt: at, nextFundingAt: null,
    lastObservation: null, worstObservedNetProfit: null, targetReachedAt: null, timedOutAt: null, observations: 0, validObservations: 0, samples: [],
    close: closedAt === undefined ? null : { kind: 'stop', closedAt, exitLongPrice: null, exitShortPrice: null, closeFeePaid: null, settledFunding: 0, pnl: null },
    ...(requestId === undefined ? {} : { requestId, requestFingerprint: 'a'.repeat(64) }),
  };
  return position as unknown as PerpetualPaperPosition;
}

export const paperState = (positions: PerpetualPaperPosition[], revision = 1): PerpetualPaperState => ({ version: 1, revision, positions });
