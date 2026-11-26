import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_BACKGROUND_SETTINGS } from '../src/chain-arb/background-model.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import { createMarketClient } from '../src/market/ipc.ts';
import { createMonitorData } from '../src/market/monitor-data.ts';
import { createMarketServer } from '../src/market/server.ts';
import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import { createNotifier } from '../src/service/feishu.ts';
import { openMonitor, stopMonitor, closeMonitor } from '../src/service/monitor.ts';
import { createRemoteMonitor } from '../src/service/remote-monitor.ts';
import { chainArbFixture, TEST_DEPOSIT } from './chain-arb-fake.ts';
import { band, book, network, okxTestNow, okxWallet, pair, perp, setupOkxPublic } from './chain-arb-okx-fake.ts';
import { createHarness } from './harness.ts';

test('同一连接续期保留原行情到期的历史，充值条件变更撤下两腿，换账户时撤下全部样本', async t => {
  let at = okxTestNow;
  const now = () => at, fixture = setupOkxPublic(), other = chainArbFixture(now);
  const market = createChainArbMarket({ now, fetchImpl: (url, init) => new URL(url).hostname === 'www.okx.com'
    ? fixture.fetchImpl(url, init) : other(url, init) });
  t.after(() => market.closeChainArb());
  const params = { venue: 'okx', chain: 'arbitrum', amount: '0.1', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
  const poll = (dir: ReturnType<typeof okxWallet>) => market.scanChainArb(params, 'a'.repeat(24) + ':0', AbortSignal.timeout(2000), true, dir);
  const first = await poll(okxWallet([network], at - 59_000));
  assert.deepEqual(first.rows.map(row => row.kind).sort(), ['perp', 'spot']);
  at += 1000;
  assert.deepEqual((await poll(okxWallet([{ ...network, minDeposit: '0.1500' }], at))).history.map(row => row.kind).sort(), ['perp', 'spot']);
  at += 1;
  assert.deepEqual((await poll(okxWallet([{ ...network, minDeposit: '2' }], at))).history.map(row => row.kind), []);
  assert.deepEqual((await poll({ ...okxWallet([], at), connection: 'b'.repeat(32) })).history, []);
});

test('在途复核被目录续期打断时保留仍合格的历史，未完成的币下一批再核验', async t => {
  for (const spotAllowed of [true, false]) {
    let at = okxTestNow, hold = false;
    const now = () => at;
    let begin!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const fixture = setupOkxPublic(), other = chainArbFixture(now);
    const market = createChainArbMarket({ now, fetchImpl: async (url, init) => {
      if (new URL(url).hostname !== 'www.okx.com') return other(url, init);
      if (hold) {
        begin();
        await new Promise<void>(resolve => init.signal!.addEventListener('abort', () => resolve(), { once: true }));
      }
      return fixture.fetchImpl(url, init);
    } });
    t.after(() => market.closeChainArb());
    const params = { venue: 'okx', chain: 'arbitrum', amount: '0.1', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
    const poll = (dir: ReturnType<typeof okxWallet>) => market.scanChainArb(params, 'b'.repeat(24) + ':0', AbortSignal.timeout(5000), true, dir);
    const old = okxWallet([network], at - 57_000);
    assert.equal((await poll(old)).rows.length, 2);
    at += 2100; hold = true;
    const pending = poll(old);
    await started;
    at += 900; hold = false;
    const fresh = okxWallet([{ ...network, depositEligible: spotAllowed }], at);
    const refreshed = await poll(fresh);
    await pending;
    assert.deepEqual(refreshed.history.map(row => row.kind).sort(), spotAllowed ? ['perp', 'spot'] : []);
    assert.deepEqual([refreshed.checked, refreshed.failed], [0, 0]);
    at += 2100;
    const next = await poll(fresh);
    assert.deepEqual([next.checked, next.failed], [spotAllowed ? 1 : 0, 0]);
    assert.deepEqual(next.rows.map(row => row.kind).sort(), spotAllowed ? ['perp', 'spot'] : []);
  }
});

test('后台独立通过账本和行情 IPC 排序两条 OKX 路线，只有超过阈值的路线进入飞书发件箱，撤权后立即撤榜', async () => {
  const h = createHarness(), socket = process.platform === 'win32' ? '\\\\.\\pipe\\tp-okx-' + randomUUID() : join(h.dir, 'okx.sock');
  let at = okxTestNow, connected = true, reads = 0, disconnectOnNotify = false;
  const now = () => at;
  const spot = { ...pair, maxMktSz: '20000', maxMktAmt: '30000' }, swap = { ...perp, maxMktSz: '30000' };
  const fixture = setupOkxPublic({ spotMeta: [spot], perpMeta: [swap],
    spotBook: [{ ...book, bids: [['0.103', '25000', '0', '1']] }],
    perpBook: [{ ...book, bids: [['0.104', '25000', '0', '1']] }],
    spotBand: [{ ...band, sellLmt: '0.09' }], perpBand: [{ ...band, sellLmt: '0.09', instType: 'SWAP', instId: perp.instId }] });
  const other = chainArbFixture(now);
  const market = createMarketServer({ monitor: createMonitorData({ now, fetchImpl: (url, init) =>
    new URL(url).hostname === 'www.okx.com' ? fixture.fetchImpl(url, init) : other(url, init) }) }, 'okx-test');
  const client = createMarketClient(socket);
  const notifier = createNotifier({ file: join(h.dir, 'notifications.sqlite'), events: () => [], latestSeq: () => 0,
    pairs: () => [], incidentPair: () => null, now, log: () => {}, feishu: { webhook: 'https://example.invalid/robot', secret: null },
    fetchImpl: async () => { throw new Error('本测试禁止联网'); } });
  const addressProof = { address: TEST_DEPOSIT, expiresAt: at + 60_000 };
  const ledger = { okxDepositRecipient: async () => addressProof,
    okxDepositRecipientCurrent: (dir: unknown, proof: unknown) => dir === fixture.state.wallet && proof === addressProof && connected && at < addressProof.expiresAt,
    async okxScanDirectory() { reads++; if (!connected) throw new Error('OKX 连接已断开'); return fixture.state.wallet; },
    okxScanDirectoryCurrent: (value: unknown) => connected && value === fixture.state.wallet && at < fixture.state.wallet.expiresAt };
  const runtime = openMonitor({ perpetual: {} }, h.dir, { now, marketClient: client, chainArbFetch: other, okxLedger: ledger, log: () => {},
    alertHooks: { robot: () => 'feishuMonitor', notify: () => null, test: async () => {}, delivery: () => new Map(),
      notifyRepeating: (key, message) => {
        const value = notifier.notifyRepeating(key, message);
        if (disconnectOnNotify) connected = false;
        return value;
      } } });
  const background = runtime.chainArbBackground!;
  const signal = AbortSignal.timeout(8000), scope = 'a'.repeat(24) + ':0';
  const params = { venue: 'okx', chain: 'arbitrum', amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0' };
  try {
    await new Promise<void>((resolve, reject) => { market.server.once('error', reject); market.server.listen(socket, resolve); });
    const remote = createRemoteMonitor(client, now);
    await assert.rejects(withChainArbLedger(remote, undefined, now).scanChainArb(params, scope, signal), /资产账本/);
    await assert.rejects(runtime.scanChainArb!({ ...params, directory: fixture.state.wallet }, scope, signal), /参数/);
    assert.equal(reads, 0);
    background.update({ revision: 0, settings: { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true,
      venues: ['okx'], thresholdBps: 300, chain: 'arbitrum' } });
    await background.tick();
    const result = background.view().results.okx!;
    assert.deepEqual(result.rows.map(row => [row.kind, row.netUsdt, row.netBps]), [['perp', 37.435, 374.35], ['spot', 28.47, 284.7]]);
    assert.equal(notifier.pending(), 1);
    const sent = notifier.status().recent[0]!.text;
    for (const expected of ['ARB', 'Arbitrum One', 'OKX 永续开空', '374.35 bp', '37.435 USDT']) assert.ok(sent.includes(expected), sent);
    await assert.rejects(remote.chainArbCatalog('okx', signal), /链目录/);
    const contaminated = { ...fixture.state.wallet, unrelated: 'test-field' };
    await assert.rejects(remote.chainArbCatalog('okx', signal, contaminated), /链目录/);
    await assert.rejects(withChainArbLedger(remote, { ...ledger, okxScanDirectory: async () => contaminated }, now)
      .scanChainArb(params, scope, signal), /链目录/);
    connected = false;
    const revoked = background.view().results.okx!;
    assert.deepEqual([revoked.phase, revoked.checked, revoked.total, revoked.rows], ['error', 0, 0, []]);
    await background.tick();
    assert.equal(background.view().results.okx?.phase, 'error');
    assert.deepEqual(background.view().results.okx?.history, []);
    connected = true; at += 2100;
    fixture.state.onFetch = () => { connected = false; };
    await background.tick();
    assert.deepEqual(background.view().results.okx?.rows, []);
    assert.equal(notifier.pending(), 1);
    assert.match(background.view().results.okx?.message ?? '', /变更/);
    connected = true; at += 2100; fixture.state.onFetch = () => {};
    background.update({ revision: 1, settings: { ...background.view().settings, spotCosts: '100', perpCosts: '100' } });
    await background.tick();
    const empty = background.view().results.okx!;
    assert.deepEqual([empty.checked, empty.rows], [1, []]);
    connected = false;
    const afterDisconnect = background.view().results.okx!;
    assert.deepEqual([afterDisconnect.phase, afterDisconnect.total, afterDisconnect.checked, afterDisconnect.cycle], ['error', 0, 0, 0]);
    connected = true; at += 2100; disconnectOnNotify = true;
    background.update({ revision: 2, settings: { ...background.view().settings, spotCosts: '0', perpCosts: '0', thresholdBps: 0 } });
    await background.tick();
    assert.equal(background.view().results.okx?.phase, 'error');
    assert.equal(notifier.pending(), 1);
  } finally {
    stopMonitor(runtime); closeMonitor(runtime); client.close(); market.close(); notifier.close(); h.dispose();
  }
});
