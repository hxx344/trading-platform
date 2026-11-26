import assert from 'node:assert/strict';
import test from 'node:test';
import { SCAN_HISTORY_MS, parseChainArbScan } from '../../src/chain-arb/scan-model.ts';
import { chainArbQuery } from '../src/chain-arb-form.ts';
import { ALL_SCAN_VENUES, DEFAULT_BACKGROUND_SETTINGS } from '../../src/chain-arb/background-model.ts';
import { backgroundBands, backgroundDraft, initialScanForm, readTimedScan, reviewScanRow, saveBackgroundDraft, scanBands,
  scanQuery, venueScanForm } from '../src/chain-arb-scan-form.ts';

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
    dexPrice: 10, gatePrice: 11, at: source, expiresAt: (options.at ?? source) + 15_000,
    execution: { depositVenue: options.venue ?? 'gate', depositExpiresAt: (options.at ?? source) + 60_000, transferAmount: '98', receivedQuantity: 100, transferQuantity: 98, impactBps: 400, blockNumber: '0x123' }, ...options };
}
function view(rows, history = []) {
  return { asOf: source, rows, history, phase: 'scanning', cycle: 1, total: 10, checked: 3, failed: 0, message: null };
}

test('旧版报价和未通过模拟的报价均不进入有效机会或最近采样', () => {
  const valid = row('ATLIMIT');
  valid.execution.impactBps = 500;
  const invalid = [
    row('OLD', { execution: undefined }),
    row('ORDINARY', { execution: { ...valid.execution, depositVenue: undefined } }),
    row('NO_EXPIRY', { execution: { ...valid.execution, depositExpiresAt: undefined } }),
    row('INFINITE_EXPIRY', { execution: { ...valid.execution, depositExpiresAt: Infinity } }),
    row('WRONG_VENUE', { venue: 'okx', execution: valid.execution }),
    row('UNSUPPORTED', { venue: 'bitget', execution: valid.execution }),
    row('TOO_LONG', { expiresAt: source + 15_001 }),
    row('NO_TRANSFER', { execution: { ...valid.execution, transferQuantity: null } }),
    row('TOO_THIN', { execution: { ...valid.execution, impactBps: 501 } }),
  ];
  const sample = row('SAMPLE', { at: source - 20_000 });
  const scan = { startedAt: 10, view: view([...invalid, valid], [...invalid, sample]) };
  const { live, history } = scanBands(scan, false, 10);
  assert.deepEqual(live, [valid]);
  assert.deepEqual(history, [sample]);
});

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

test('后台扫描草稿按版本保存，允许零阈值和交易所独立费率，至少选一个市场', () => {
  const draft = backgroundDraft(DEFAULT_BACKGROUND_SETTINGS);
  assert.ok(ALL_SCAN_VENUES.includes('okx'));
  assert.deepEqual(draft.venues, ['gate', 'binance', 'bitget']);
  const changed = { ...draft, enabled: true, thresholdBps: '0', amount: '25.50', venues: ['bitget', 'binance'],
    fees: { binance: { spotFeeBps: '8.3', perpFeeBps: '5' }, bitget: { spotFeeBps: '10', perpFeeBps: '5' } } };
  const settings = saveBackgroundDraft(changed);
  assert.deepEqual(settings, { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, amount: '25.5',
    thresholdBps: 0, venues: ['binance', 'bitget'], fees: changed.fees });
  const next = saveBackgroundDraft({ ...backgroundDraft(settings), spotFeeBps: '2' });
  assert.equal(venueScanForm(next, 'bitget').spotFeeBps, '10');
  assert.equal(venueScanForm(next, 'gate').spotFeeBps, '2');
  for (const thresholdBps of ['', '-1', ' ', '1000001', '1e999']) assert.throws(() => saveBackgroundDraft({ ...draft, thresholdBps }));
  assert.throws(() => saveBackgroundDraft({ ...draft, venues: [] }), /交易所/);
  assert.throws(() => saveBackgroundDraft({ ...draft, fees: { gate: { spotFeeBps: '3', perpFeeBps: '' } } }), /费率/);
  assert.deepEqual(saveBackgroundDraft(backgroundDraft(settings)), settings);
  assert.equal(saveBackgroundDraft(backgroundDraft({ ...settings, thresholdBps: 1e-7 })).thresholdBps, 1e-7);
});

test('跨所榜单使用各快照生成时间和本次 GET 往返耗时，单所失败不撤下其他所的有效行情', async () => {
  const gate = row('ARB', { netBps: 10 }), okx = row('ARB', { venue: 'okx', netBps: 90 });
  const proofExpired = row('PAST', { venue: 'okx', expiresAt: source + 200 });
  proofExpired.execution.depositExpiresAt = proofExpired.expiresAt;
  const bitget = row('ARB', { venue: 'bitget', netBps: 99, at: source - 200 });
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, venues: ALL_SCAN_VENUES, enabled: true };
  let mono = 100;
  const result = await readTimedScan(async () => { mono += 220; return { revision: 3, robot: null, error: null, settings,
    results: { gate: view([gate]), okx: view([proofExpired, okx]), bitget: { ...view([bitget]), phase: 'error' } } }; }, () => mono);
  const bands = backgroundBands(result, false, mono);
  assert.deepEqual(bands.live, [okx, gate]);
  assert.deepEqual(bands.history, []);
  assert.equal(bands.nextDeadline, 15_100);
  assert.deepEqual(backgroundBands(result, true, mono).live, []);
  const offline = backgroundBands(result, true, 15_100);
  assert.deepEqual(offline.live, []);
  assert.equal(offline.history.length, 2);
  assert.equal(offline.nextDeadline, 60_100);
  assert.deepEqual(backgroundBands(result, true, 61_100).history, []);
  assert.deepEqual(backgroundBands(result, true, 100 + SCAN_HISTORY_MS).history, []);
});

test('从单行复核只传已保存的预算、路线成本和该所费率，不混入飞书或后台参数', () => {
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, amount: '212', spotCosts: '1.25', perpCosts: '2',
    fees: { bitget: { spotFeeBps: '7.5', perpFeeBps: '2' }, okx: { spotFeeBps: '9', perpFeeBps: '4' } } };
  const withOkx = saveBackgroundDraft({ ...backgroundDraft(settings), venues: ['okx', 'binance', 'bitget'] });
  assert.deepEqual(withOkx.venues, ['binance', 'bitget', 'okx']);
  assert.deepEqual(saveBackgroundDraft(backgroundDraft(withOkx)), withOkx);
  for (const venue of withOkx.venues) {
    const form = venueScanForm(settings, venue);
    assert.deepEqual(Object.keys(form).sort(), Object.keys(initialScanForm).sort());
    assert.equal(form.spotFeeBps, { binance: '10', bitget: '7.5', okx: '9' }[venue]);
    const review = reviewScanRow(form, row('ABC', { venue }));
    const query = chainArbQuery(review.form, review.autoGas).input;
    assert.equal(query.venue, venue);
    assert.equal(query.amount, '212');
    assert.equal(query.perpCosts, 2);
    assert.equal(query.spotFeeBps, Number(form.spotFeeBps));
    assert.equal(query.perpFeeBps, Number(form.perpFeeBps));
    assert.equal(query.swapGas, 'auto');
  }
});

test('后台单腿限流时保留同所仍新鲜的另一条路线，失效或暂停时降为历史', () => {
  const valid = row('ARB', { venue: 'gate', kind: 'spot' });
  const sample = { startedAt: 100, view: { settings: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true },
    results: { gate: { ...view([valid]), phase: 'cooldown' } } } };
  assert.deepEqual(backgroundBands(sample, false, 1000).live, [valid]);
  assert.deepEqual(backgroundBands(sample, true, 1000).history, [valid]);
  assert.deepEqual(backgroundBands(sample, false, 15_100).history, [valid]);
});
