import assert from 'node:assert/strict';
import test from 'node:test';
import type { GateDepositProof, GateDepositSource } from '../src/chain-arb/gate-deposit-proof.ts';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import { CHAIN_ARB_TTL_MS, parseChainArb, type ChainArbView } from '../src/chain-arb/model.ts';
import type { ScanRow, ScanView } from '../src/chain-arb/scan-model.ts';
import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import { createChainArbBackground } from '../src/chain-arb/background.ts';
import { DEFAULT_BACKGROUND_SETTINGS } from '../src/chain-arb/background-model.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import { ARB_ADDRESS, verifiedBuy } from './chain-arb-fake.ts';

const start = 1_795_600_000_000, signal = new AbortController().signal;
const form = { chain: 'arbitrum' as const, amount: '1', spotFeeBps: '0', perpFeeBps: '0', spotCosts: '0', perpCosts: '0' };
const manual = { ...form, symbol: 'ARB', address: ARB_ADDRESS };

function quote(rawQuantity = '1000000000000000000', at = start) {
  const book = { at, step: '1e-18', bids: [['2', '10']] as [string, string][] };
  return compareChainArb(parseChainArb(manual), verifiedBuy({ rawQuantity, at, decimals: 18, swapGasUsdt: 0 }),
    { deposit: true, withdraw: true, spot: book, perp: book }, at);
}
function rows(at = start): ScanRow[] {
  const view = quote(undefined, at);
  return (['spot', 'perp'] as const).map(kind => ({ kind, chain: 'arbitrum', symbol: 'ARB', address: ARB_ADDRESS,
    at, expiresAt: at + CHAIN_ARB_TTL_MS, gasUsdt: 0, gatePrice: 2, dexPrice: 1, netBps: 10_000, netUsdt: 1,
    execution: { ...view.dex.execution!, transferQuantity: 1 } }));
}
function fixture() {
  const state = { at: start, generation: 1, minimum: '1', reads: 0, quote: quote(),
    snapshot: { asOf: start, phase: 'scanning', total: 1, checked: 1, cycle: 1, failed: 0, message: null, rows: rows(), history: [] } as ScanView };
  const generations = new WeakMap<GateDepositProof, number>();
  const ledger: GateDepositSource = {
    async gateDepositProof(symbol, chain) {
      state.reads++;
      const proof = { symbol, chain, at: state.at, expiresAt: state.at + 60_000, minDeposit: state.minimum };
      generations.set(proof, state.generation);
      return proof;
    },
    gateDepositCurrent: proof => generations.get(proof) === state.generation,
  };
  const now = () => state.at;
  const market = { chainArb: async () => structuredClone(state.quote), scanChainArb: async () => structuredClone(state.snapshot) };
  const service = withChainArbLedger(market, undefined, now, ledger);
  return { state, now, ledger, market, service, single: () => service.chainArb(manual, signal),
    scan: () => service.scanChainArb(form, 'scan', signal, true) };
}
function bothBlocked(view: ChainArbView, reason: RegExp) {
  for (const leg of [view.spot, view.perp]) { assert.ok('error' in leg); assert.match(leg.error, reason); }
}

test('单币 Gate 使用精确模拟转账量核对账户最低额，缺账本、无效最低额和错误网络关闭两条路线', async () => {
  const { state, single, market, now, ledger } = fixture();
  const pass = await single();
  assert.ok('netUsdt' in pass.spot && 'netUsdt' in pass.perp);
  state.quote = quote('999999999999999999');
  assert.equal(state.quote.dex.execution!.transferQuantity, 1);
  bothBlocked(await single(), /最低充值量/);
  state.minimum = '';
  bothBlocked(await single(), /未核实/);
  bothBlocked(await withChainArbLedger(market, undefined, now).chainArb(manual, signal), /只读连接/);
  ledger.gateDepositProof = async () => ({ symbol: 'ARB', chain: 'bsc', at: start, expiresAt: start + 60_000, minDeposit: '0' });
  ledger.gateDepositCurrent = () => true;
  bothBlocked(await single(), /未核实/);
});

test('手工与扫描的外部参数、旧版模拟、过期或非正机会都不能触发账户读取', async () => {
  const { state, single, service, scan } = fixture();
  await assert.rejects(service.chainArb({ ...manual, candidate: manual }, signal), /未知参数/);
  await assert.rejects(service.scanChainArb({ ...form, rows: rows() }, 'scan', signal), /未知参数/);
  state.quote.dex.execution!.transferAmount = undefined;
  bothBlocked(await single(), /精确/);
  const [good] = rows();
  state.snapshot.rows = [{ ...good, netBps: -1 }, { ...good, venue: 'binance' }, { ...good, chain: 'bsc' },
    { ...good, execution: { ...good.execution!, transferAmount: '2' } },
    { ...good, execution: { ...good.execution!, transferAmount: undefined } }];
  state.snapshot.history = [good];
  assert.deepEqual((await scan()).rows, []);
  state.at += CHAIN_ARB_TTL_MS;
  state.snapshot.rows = [good];
  state.quote = quote();
  bothBlocked(await single(), /过期/);
  assert.deepEqual((await scan()).history, []);
  const bitget = await service.chainArb({ ...manual, venue: 'bitget' }, signal);
  assert.deepEqual(bitget, state.quote);
  assert.equal(state.reads, 0);
});

test('Gate 单币费用缺失保留毛值，亏损保留净值，均标明只读测算且不查账户', async () => {
  const { state, service } = fixture();
  const query = { ...manual, spotCosts: '', perpCosts: '2' };
  const book = { at: start, step: '1', bids: [['2', '10']] as [string, string][] };
  state.quote = compareChainArb(parseChainArb(query), verifiedBuy({ rawQuantity: '1', decimals: 0, at: start }),
    { deposit: true, withdraw: true, spot: book, perp: book }, start);
  const result = await service.chainArb(query, signal);
  assert.ok('netUsdt' in result.spot && 'netUsdt' in result.perp);
  assert.deepEqual([result.spot.grossUsdt, result.spot.netUsdt, result.perp.netUsdt, result.perp.netBps], [1, null, -1, -10_000]);
  assert.equal(result.deposit, null);
  assert.equal(result.manualEstimateOnly, true);
  assert.equal(state.reads, 0);
});

test('单币不一致的正数不能查账户或作为测算显示；另一腿核验失败时保留真实亏损', async () => {
  const { state, service, ledger } = fixture();
  const { spot, perp } = state.quote;
  assert.ok('netUsdt' in spot && 'netUsdt' in perp);
  for (const mismatch of [{ netUsdt: null, netBps: 1 }, { netUsdt: -1, netBps: 1 }, { netUsdt: 1, netBps: 1 }]) {
    state.quote.spot = { ...spot, ...mismatch };
    state.quote.perp = { error: '深度不足' };
    const rejected = await service.chainArb(manual, signal);
    assert.ok('error' in rejected.spot && /不一致/.test(rejected.spot.error));
    assert.equal(rejected.manualEstimateOnly, undefined);
  }
  state.quote.spot = spot;
  const missing = await service.chainArb({ ...manual, spotCosts: '' }, signal);
  assert.ok('error' in missing.spot);
  assert.equal(state.reads, 0);
  state.quote.perp = { ...perp, netUsdt: -1, netBps: -10_000 };
  ledger.gateDepositCurrent = () => false;
  const mixed = await service.chainArb(manual, signal);
  assert.ok('error' in mixed.spot);
  assert.deepEqual(mixed.perp, state.quote.perp);
  assert.equal(mixed.deposit, null);
  assert.equal(mixed.manualEstimateOnly, true);
  assert.equal(state.reads, 1);
});

test('Gate 扫描两路和重复轮询复用同次核验，旧历史、撤销及换账户无法重新取得旧样本', async () => {
  const { state, scan, service } = fixture();
  const original = await scan();
  assert.deepEqual(original.rows.map(row => row.kind), ['spot', 'perp']);
  assert.ok(original.rows.every(service.gateResultCurrent));
  assert.equal((await scan()).rows.length, 2);
  const prior = state.snapshot.rows;
  state.at += CHAIN_ARB_TTL_MS;
  state.snapshot.asOf = state.at;
  state.snapshot.rows = rows(state.at);
  state.snapshot.history = [...prior, { ...prior[0], symbol: 'OTHER' }];
  const recent = await scan();
  assert.equal(recent.rows.length, 2);
  assert.deepEqual(recent.history.map(row => row.kind), ['spot', 'perp']);
  assert.equal(state.reads, 2);
  state.generation++;
  assert.ok(recent.rows.every(row => !service.gateResultCurrent(row)));
  const revoked = await scan();
  assert.deepEqual([revoked.rows, revoked.history], [[], []]);
  assert.equal(state.reads, 2);
  state.at++;
  state.snapshot.asOf = state.at;
  state.snapshot.rows = rows(state.at);
  state.minimum = '1.000000000000000001';
  assert.deepEqual((await scan()).rows, []);
  assert.equal(state.reads, 3);
});

test('慢速账户返回时重新检查公开样本到期与连接代次，过期未确认的样本永不进入历史', async () => {
  for (const failure of ['expired', 'revoked'] as const) {
    const { state, single, scan, ledger } = fixture();
    let markEntered!: () => void, resume!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const waiting = new Promise<void>(resolve => { resume = resolve; });
    const read = ledger.gateDepositProof;
    ledger.gateDepositProof = async (...args) => {
      const proof = await read(...args);
      markEntered(); await waiting; return proof;
    };
    const scanning = scan(), checking = single();
    await entered;
    if (failure === 'expired') state.at += CHAIN_ARB_TTL_MS;
    else state.generation++;
    resume();
    const result = await scanning;
    assert.deepEqual(result.rows, []);
    bothBlocked(await checking, /过期|未核实/);
    state.snapshot.history = state.snapshot.rows;
    state.snapshot.rows = []; state.snapshot.asOf = state.at;
    assert.deepEqual((await scan()).history, []);
    assert.equal(state.reads, 2);
  }
});

test('首条通知入队后连接撤销，下一条通知及后台视图立即撤回', async t => {
  const { service, state, now } = fixture();
  const store = createMonitorStore({ file: ':memory:' }); t.after(() => store.close());
  const recorded: string[] = [];
  const background = createChainArbBackground({ store, now, control: () => ({ enabled: true, revision: 0 }),
    scan: service.scanChainArb, gateResultCurrent: service.gateResultCurrent, hooks: { robot: () => 'feishu',
      notifyRepeating: key => { recorded.push(key); state.generation++; } } });
  t.after(() => background.stop());
  background.update({ revision: 0, settings: { ...DEFAULT_BACKGROUND_SETTINGS, ...form, enabled: true, venues: ['gate'] } });
  await background.tick();
  assert.equal(recorded.length, 1);
  assert.deepEqual(background.view().results.gate?.rows, []);
  assert.equal(state.reads, 1);
});
