import assert from 'node:assert/strict';
import test from 'node:test';
import { SCAN_HISTORY_MS, parseChainArbScan } from '../../src/chain-arb/scan-model.ts';
import { chainArbQuery } from '../src/chain-arb-form.ts';
import { initialScanForm, readTimedScan, reviewScanRow, scanBands, scanQuery } from '../src/chain-arb-scan-form.ts';

test('an all-chain scan needs no token identifiers and normalizes budgets, fees and explicit extra costs', () => {
  const { path, input } = scanQuery({ ...initialScanForm, amount: ' 2345.00 ', perpCosts: '0.9' });
  const url = new URL(path, 'http://localhost');
  assert.equal(url.pathname, '/api/monitor/perpetual/chain-arb-scan');
  assert.deepEqual(Object.fromEntries(url.searchParams), { ...initialScanForm, amount: '2345', perpCosts: '0.9' });
  assert.deepEqual(parseChainArbScan(Object.fromEntries(url.searchParams)), input);
  for (const patch of [{ spotCosts: ' ' }, { perpCosts: '' }, { chain: 'unsupported' }, { amount: '0' },
    { spotFeeBps: '100.01' }, { perpCosts: '-1' }]) assert.throws(() => scanQuery({ ...initialScanForm, ...patch }));
});

const address = '0x' + 'f'.repeat(40);
const source = 1_800_000_000_000;
function row(symbol, options = {}) {
  return { chain: 'bsc', address, symbol, kind: 'perp', netBps: 40, netUsdt: 0.4, gasUsdt: 0.03,
    dexPrice: 10, gatePrice: 11, at: source, expiresAt: source + 15_000, ...options };
}
function view(rows, history = []) {
  return { asOf: source, rows, history, phase: 'scanning', cycle: 1, total: 10, checked: 3, failed: 0, message: null };
}

test('a single-token review sends the selected identity and the same budget, fees and route costs with fresh automatic swap gas', () => {
  const { input } = scanQuery({ ...initialScanForm, amount: '25.5', spotFeeBps: '17', perpFeeBps: '4.2', spotCosts: '1.5', perpCosts: '3' });
  const setup = reviewScanRow(input, row('ABC'));
  const query = chainArbQuery(setup.form, setup.autoGas);
  const params = new URL(query.path, 'http://localhost').searchParams;
  assert.deepEqual(Object.fromEntries(params), { ...input, chain: 'bsc', symbol: 'ABC', address, swapGas: 'auto', source: 'scan' });
  assert.ok(!chainArbQuery(setup.form).path.includes('swapGas'));
});

test('复核保留中文和大小写敏感的 Unicode 币种代码，拒绝分隔符、隐形字符和超长输入', () => {
  for (const symbol of ['哈基米', '我踏马来了', 'Straße币', '𠀀'.repeat(24)]) {
    const setup = reviewScanRow(initialScanForm, row(symbol));
    const { input, path } = chainArbQuery(setup.form, setup.autoGas);
    const params = new URL(path, 'http://localhost').searchParams;
    assert.equal(input.symbol, symbol);
    assert.equal(params.get('symbol'), symbol);
    assert.equal(params.get('swapGas'), 'auto');
  }
  for (const symbol of ['币/种', '币%2F种', '币?种', '币_种', '币\u200d种', '币\u3164种', '币'.repeat(25), '\ud800']) {
    const setup = reviewScanRow(initialScanForm, row(symbol));
    assert.throws(() => chainArbQuery(setup.form, setup.autoGas), /基础币代码/);
  }
});

test('row lifetime starts at the local request: one expires in transit and the next deadlines move each remaining row to samples', async () => {
  const expired = row('OLD', { expiresAt: source + 50, at: source - 14_950 });
  const first = row('FIRST', { expiresAt: source + 1000, at: source - 14_000, netBps: 33 });
  const second = row('SECOND', { expiresAt: source + 5000, at: source - 10_000, netBps: 50 });
  let mono = 100;
  const scan = await readTimedScan(async () => { mono += 750; return view([first, expired, second]); }, () => mono);
  const arrival = scanBands(scan, false, mono);
  assert.deepEqual(arrival.live, [second, first]);
  assert.deepEqual(arrival.history, [expired]);
  assert.equal(arrival.nextDeadline, 1100);
  const later = scanBands(scan, false, 1100);
  assert.deepEqual(later.live, [second]);
  assert.deepEqual(later.history, [first, expired]);
  assert.equal(later.nextDeadline, 5100);
  assert.deepEqual(scanBands(scan, false, 5100).live, []);
});

test('paused, failed and cooling-down scans keep bounded recent samples; expired history disappears during pause', () => {
  const current = row('CURRENT');
  const previous = Array.from({ length: 24 }, (_, index) => row('H' + index, { at: source - 16_000 - index * 1000 }));
  previous.push(row('TOO_OLD', { at: source - SCAN_HISTORY_MS }));
  for (const phase of ['scanning', 'loading', 'error', 'cooldown']) {
    const scan = { startedAt: 10, view: { ...view([current], previous), phase } };
    const bands = scanBands(scan, phase === 'scanning', 10);
    assert.deepEqual(bands.live, []);
    assert.deepEqual(bands.history, [current, ...previous.slice(0, 19)]);
    assert.deepEqual(scanBands(scan, true, 10 + SCAN_HISTORY_MS), { live: [], history: [], nextDeadline: Infinity });
  }
});
