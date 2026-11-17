import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalUnits as u } from '../../src/vendor/ondo/decimal.mjs';
import { createOndoObservation } from '../../src/vendor/ondo/observation.mjs';

const START = 1_800_000_000_000, MARKET = 'NVDA-USD.P';
function fixture() {
  const rules = { tick: u('0.01'), step: u('0.01'), trading: true, at: START };
  const cfg = { target: u('4'), min: u('3'), max: u('4.8'), orderUsd: u('100'), wallMin: u('5000') };
  const trial = createOndoObservation({ markets: [MARKET], cfg, startedAt: START, readRules: () => rules,
    bookMaxAgeMs: 1500, rulesMaxAgeMs: 300_000, dwellMs: 1500, minRestMs: 1000 });
  const book = (at, { source = at, bid = '99.99', ask = '100.01', bidSize = '100', askSize = '100' } = {}) =>
    trial.book(MARKET, { time: START + source, bids: [[u(bid), u(bidSize)]], asks: [[u(ask), u(askSize)]] }, START + at);
  const trade = (side, price, time, id, received = time) =>
    trial.trade(MARKET, { id, time: START + time, aggressorSide: side, price: u(price) }, START + received);
  const row = (at, side, dist = 4) => trial.snapshot(START + at).rows.find(r => r.distanceBps === dist && r.side === side);
  return { trial, book, trade, rules, row };
}

test('six resting trials keep their prices and count each touch and sweep once per virtual order', () => {
  const { book, trade, row } = fixture();
  book(0);
  trade('sell', '99.96', 50, 'touch');
  book(75);
  trade('sell', '99.96', 80, 'another-at-the-same-price');
  trade('buy', '99.90', 85, 'wrong-aggressor');
  assert.deepEqual([row(100, 'buy').touches, row(100, 'buy').sweeps], [1, 0]);
  trade('sell', '99.92', 110, 'both');
  assert.deepEqual([row(110, 'buy').touches, row(110, 'buy').sweeps, row(110, 'buy', 8).touches, row(110, 'buy', 8).sweeps], [1, 1, 1, 0]);
  book(125);
  trade('sell', '99.92', 110, 'both', 130); // replay after the 4 bps quote was rearmed
  trade('buy', '100.16', 140, 'sweep-all-asks');
  assert.deepEqual([4, 8, 15].map(d => row(200, 'sell', d).sweeps), [1, 1, 1]);
  assert.deepEqual([4, 8, 15].map(d => row(200, 'buy', d).touches), [1, 1, 0]);
  // The 4 bps buy was absent between the sweep and the next book. 8 bps was only touched.
  assert.deepEqual([row(200, 'buy').activeMs, row(200, 'buy', 8).activeMs], [185, 200]);
});

test('a prompt but later-delivered trade matches the quote resting at its exchange time', () => {
  const { book, trade, row } = fixture();
  book(0);
  book(100, { bid: '99.89', ask: '99.91' });
  trade('sell', '99.95', 80, 'previous-price', 110);
  assert.deepEqual([row(110, 'buy').touches, row(110, 'buy').sweeps, row(110, 'buy').activeMs], [1, 1, 90]);
  trade('sell', '99.95', 105, 'only-the-new-price-was-live', 120);
  assert.equal(row(120, 'buy').touches, 1);
});

test('a venue clock 600 ms ahead keeps source-time causality and local exposure duration', () => {
  const { book, trade, row } = fixture();
  book(0, { source: 600 });
  trade('sell', '99.90', 590, 'before-the-book', 20);
  book(100, { source: 700, bid: '99.89', ask: '99.91' });
  trade('sell', '99.95', 680, 'late-old-quote', 115);
  trade('buy', '100.25', 4500, 'overly-future', 125);
  assert.deepEqual([row(125, 'buy').touches, row(125, 'buy').sweeps, row(125, 'buy').activeMs], [1, 1, 105]);
  assert.equal(row(125, 'sell').touches, 0);
  assert.equal(row(2400, 'buy').activeMs, 1580); // the last book earns at most 1.5s on the host clock
});

test('duplicates, gaps, past prints, future frames, disconnects and halts cannot create exposure or events', () => {
  const { trial, book, trade, rules, row } = fixture();
  book(0);
  book(1400, { source: 0 });
  trade('sell', '99.80', -1, 'pre-session', 1400);
  trade('sell', '99.80', 1600, 'expired-book');
  assert.deepEqual([row(4000, 'buy').activeMs, row(4000, 'buy').touches], [1500, 0]);
  book(4000);
  trial.down(START + 4100);
  trade('sell', '99.80', 4150, 'offline');
  book(4300, { source: 4050 }); // pre-disconnect replay
  book(4300);
  trade('sell', '99.80', 4050, 'old-subscription', 4350);
  trade('sell', '99.80', 6000, 'future-print', 4350);
  rules.trading = false; rules.at = START + 4400;
  trade('sell', '99.80', 4410, 'halted');
  assert.deepEqual([row(4550, 'buy').activeMs, row(4550, 'buy').touches], [1700, 0]);
  rules.trading = true; rules.at = START + 4600;
  book(4600, { source: 6500 });
  assert.equal(row(4700, 'buy').activeMs, 1700);
});

test('only protected, tick-aligned orders of a tradable size earn side time; rates need a full minute', () => {
  const { book, trade, rules, row } = fixture();
  for (let ms = 0; ms <= 60_000; ms += 1000) {
    book(ms, { bidSize: ms < 30_000 ? '1' : '100' });
    if (ms === 10_000) trade('buy', '100.04', ms + 50, 'touch-ask');
  }
  assert.deepEqual([row(60_000, 'buy').activeMs, row(60_000, 'buy').touchesPerHour], [30_000, null]);
  assert.deepEqual([row(60_000, 'sell').activeMs, row(60_000, 'sell').touchesPerHour, row(60_000, 'sell').sweepsPerHour], [60_000, 60, 0]);
  const coarse = fixture(); coarse.rules.tick = u('1');
  coarse.book(0);
  assert.equal(coarse.row(1000, 'sell').activeMs, 0);
  rules.step = u('1000');
  const tiny = fixture(); tiny.rules.step = rules.step;
  tiny.book(0);
  assert.equal(tiny.row(1000, 'buy').activeMs, 0);
});
