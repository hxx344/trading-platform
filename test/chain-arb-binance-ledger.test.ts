import assert from 'node:assert/strict';
import test from 'node:test';
import { VENUE_NAMES } from '../src/chain-arb/model.ts';
import type { BinanceDepositSource } from '../src/chain-arb/binance-deposit-proof.ts';
import { createChainArbBackground } from '../src/chain-arb/background.ts';
import { DEFAULT_BACKGROUND_SETTINGS } from '../src/chain-arb/background-model.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import type { VenueReader } from '../src/chain-arb/venue.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import { ARB_ADDRESS, chainArbFixture, TEST_DEPOSIT } from './chain-arb-fake.ts';

const budget = { chain: 'arbitrum', amount: '1000', spotCosts: '0', perpCosts: '0', spotFeeBps: '10', perpFeeBps: '5' };
for (const venue of ['binance', 'bitget'] as const) test(VENUE_NAMES[venue] + ' 后台按实际充值地址、税费和阈值排名并复核飞书', async t => {
  const manual = { ...budget, venue, symbol: 'ARB', address: ARB_ADDRESS, swapGas: 'auto' };
  let at = 1_795_600_000_000, netTokens = 9800n, current = true, open = true, contract = ARB_ADDRESS;
  let publicMinimum = '0.1', walletMinimum = '0.05', addressReads = 0, transfers = 0;
  let bidSize = '20000', connected = true, publicReads = 0;
  const now = () => at, dex = chainArbFixture(now), signal = new AbortController().signal;
  const recipient = venue === 'binance' ? '0x' + '22'.repeat(20) : '0x' + '44'.repeat(20);
  const reader: VenueReader = {
    catalog: async () => { publicReads++; return [{ symbol: 'ARB', chain: 'arbitrum', address: ARB_ADDRESS, spot: open, perp: true }]; },
    read: async () => {
      const leg = (price: string) => ({ bids: [[price, bidSize]] as [string, string][], at, step: 1 });
      return { deposit: open, withdraw: true, minDeposit: publicMinimum, spot: leg('0.11'), perp: leg('0.12') };
    },
  };
  const market = createChainArbMarket({ now, venueReaders: { binance: reader, gate: reader, bitget: reader } });
  const proof: BinanceDepositSource['binanceDepositProof'] = async (symbol, chain, address) => {
    addressReads++;
    assert.equal(symbol, 'ARB'); assert.equal(chain, 'arbitrum'); assert.equal(address, ARB_ADDRESS);
    return { symbol, chain, contract, minDeposit: walletMinimum, at, expiresAt: at + 20_000 };
  };
  const binance = venue === 'binance' ? { binanceDepositProof: proof, binanceDepositRecipient: () => recipient, binanceDepositCurrent: () => current } : undefined;
  const bitget = venue === 'bitget' ? { bitgetDepositConnected: () => connected, bitgetDepositProof: proof,
    bitgetDepositRecipient: () => recipient, bitgetDepositCurrent: () => current } : undefined;
  const service = withChainArbLedger(market, undefined, now, undefined, async (url, init) => {
    publicReads++;
    const response = await dex(url, init);
    const data = JSON.parse(String(init.body ?? '{}'));
    const calls = data.params?.[0]?.blockStateCalls?.[0]?.calls;
    if (calls?.length !== 10) {
      assert.ok(!JSON.stringify(init).includes(recipient.slice(2)));
      return response;
    }
    assert.equal(new URL(url).hostname, 'arb1.arbitrum.io');
    assert.equal(data.method, 'eth_simulateV1');
    assert.equal('0x' + calls[7].data.slice(34, 74), recipient);
    assert.ok(!JSON.stringify(init).includes(TEST_DEPOSIT.slice(2)));
    transfers++;
    const body = await response.json() as { result: { calls: { returnData: string }[] }[] };
    body.result[0].calls[8].returnData = '0x' + (netTokens * 10n ** 18n).toString(16).padStart(64, '0');
    return Response.json(body);
  }, binance, bitget);
  const notices: { key: string; text: string }[] = [], store = createMonitorStore({ file: ':memory:' });
  const background = createChainArbBackground({ store, now, scan: service.scanChainArb, binanceResultCurrent: service.binanceResultCurrent,
    bitgetResultCurrent: service.bitgetResultCurrent,
    control: () => ({ enabled: true, revision: 1 }), hooks: { robot: () => 'feishuMonitor', notifyRepeating: (key, text) => { notices.push({ key, text }); } } });
  t.after(() => { background.stop(); service.close(); market.closeChainArb(); store.close(); });
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, venues: [venue], chain: 'arbitrum', thresholdBps: 1000 };
  background.update({ revision: 0, settings });
  if (venue === 'bitget') {
    connected = false;
    await assert.rejects(service.chainArb(manual, signal), /Bitget 只读账户/);
    await background.tick();
    assert.match(background.view().results.bitget!.message!, /Bitget 只读账户/);
    connected = true;
    const queued = service.chainArb(manual, signal);
    connected = false;
    await assert.rejects(queued, /Bitget 只读账户/);
    assert.deepEqual([publicReads, addressReads, notices.length], [0, 0, 0]);
    connected = true; at += 2100;
  }
  await background.tick();
  const ranked = background.view().results[venue]!.rows;
  assert.deepEqual(ranked.map(r => [r.kind, r.execution?.depositVenue, r.execution?.transferQuantity, r.netBps]), [
    ['perp', venue, 9800, 1732.95], ['spot', venue, 9800, 764.22],
  ]);
  assert.equal(notices.length, 1);
  const { key, text } = notices[0]!;
  assert.ok(key.startsWith('chain-arb-deposit:' + venue + ':'));
  assert.ok(text.includes(VENUE_NAMES[venue] + ' 永续开空'));
  assert.ok(text.includes(VENUE_NAMES[venue] + ' 充值地址模拟实收 9800 ARB'));
  if (venue === 'bitget') assert.match(text, /站内划转/);
  assert.ok(!text.includes(recipient) && !JSON.stringify(ranked).includes(recipient));
  assert.ok(background.notificationsCurrent(key, text));
  current = false;
  assert.deepEqual(background.view().results[venue]!.rows, []);
  assert.equal(background.notificationsCurrent(key, text), false);
  at += 2100; current = true; netTokens = 8000n;
  await background.tick();
  assert.deepEqual(background.view().results[venue]!.rows, []);
  assert.equal(notices.length, 1);

  netTokens = 9800n;
  bidSize = '9799';
  at += 2100;
  await background.tick();
  assert.deepEqual(background.view().results[venue]!.rows, []);
  assert.equal(notices.length, 1);
  bidSize = '20000';
  at += 2100;
  background.update({ revision: 1, settings: { ...settings, thresholdBps: 1732.95 } });
  await background.tick();
  assert.equal(background.view().results[venue]!.rows.length, 2);
  assert.equal(notices.length, 1);

  for (const source of ['public', 'signed']) {
    at += 1000;
    publicMinimum = source === 'public' ? '9800.000000000000000001' : '0.1';
    walletMinimum = source === 'signed' ? '9800.000000000000000001' : '0.1';
    const result = await service.chainArb(manual, signal);
    assert.ok('error' in result.spot && /最低充值量/.test(result.spot.error));
    assert.ok('error' in result.perp && /最低充值量/.test(result.perp.error));
  }
  at += 1000;
  const count = transfers;
  contract = '0x3333333333333333333333333333333333333333';
  const wrong = await service.chainArb(manual, signal);
  assert.ok('error' in wrong.spot && 'error' in wrong.perp);
  assert.equal(transfers, count);
  at += 1000;
  const requested = addressReads;
  open = false;
  await service.chainArb(manual, signal);
  assert.equal(addressReads, requested);
});
