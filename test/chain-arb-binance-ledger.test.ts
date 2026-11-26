import assert from 'node:assert/strict';
import test from 'node:test';
import type { BinanceDepositSource } from '../src/chain-arb/binance-deposit-proof.ts';
import { createChainArbBackground } from '../src/chain-arb/background.ts';
import { DEFAULT_BACKGROUND_SETTINGS } from '../src/chain-arb/background-model.ts';
import { createChainArbMarket } from '../src/chain-arb/read.ts';
import type { VenueReader } from '../src/chain-arb/venue.ts';
import { createMonitorStore } from '../src/monitor/store.ts';
import { withChainArbLedger } from '../src/service/chain-arb-ledger.ts';
import { ARB_ADDRESS, chainArbFixture, TEST_DEPOSIT } from './chain-arb-fake.ts';

const input = { venue: 'binance', chain: 'arbitrum', amount: '1000', spotCosts: '0', perpCosts: '0', spotFeeBps: '10', perpFeeBps: '5' };
const manual = { ...input, symbol: 'ARB', address: ARB_ADDRESS, swapGas: 'auto' };

test('币安后台按当前充值地址的余额差排名两路，严格阈值、手续费、扣税和撤权贯穿飞书投递', async t => {
  let at = 1_795_600_000_000, netTokens = 9800n, current = true, open = true, contract = ARB_ADDRESS;
  let publicMinimum = '0.1', walletMinimum = '0.05', addressReads = 0, transfers = 0;
  const now = () => at, dex = chainArbFixture(now), signal = new AbortController().signal;
  const recipient = '0x2222222222222222222222222222222222222222';
  const reader: VenueReader = {
    catalog: async () => [{ symbol: 'ARB', chain: 'arbitrum', address: ARB_ADDRESS, spot: open, perp: true }],
    read: async () => {
      const leg = (price: string) => ({ bids: [[price, '20000']] as [string, string][], at, step: 1 });
      return { deposit: open, withdraw: true, minDeposit: publicMinimum, spot: leg('0.11'), perp: leg('0.12') };
    },
  };
  const market = createChainArbMarket({ now, venueReaders: { binance: reader, gate: reader, bitget: reader } });
  const ledger: BinanceDepositSource = {
    async binanceDepositProof(symbol, chain, address) {
      addressReads++; assert.equal(address, ARB_ADDRESS);
      return { symbol, chain, contract, minDeposit: walletMinimum, at, expiresAt: at + 20_000 };
    },
    binanceDepositRecipient: () => recipient, binanceDepositCurrent: () => current,
  };
  const service = withChainArbLedger(market, undefined, now, undefined, async (url, init) => {
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
  }, ledger);
  const notices: { key: string; text: string }[] = [], store = createMonitorStore({ file: ':memory:' });
  const background = createChainArbBackground({ store, now, scan: service.scanChainArb, binanceResultCurrent: service.binanceResultCurrent,
    control: () => ({ enabled: true, revision: 1 }), hooks: { robot: () => 'feishuMonitor', notifyRepeating: (key, text) => { notices.push({ key, text }); } } });
  t.after(() => { background.stop(); service.close(); market.closeChainArb(); store.close(); });
  const settings = { ...DEFAULT_BACKGROUND_SETTINGS, enabled: true, venues: ['binance'], chain: 'arbitrum', thresholdBps: 1000 };
  background.update({ revision: 0, settings });
  await background.tick();
  const ranked = background.view().results.binance!.rows;
  assert.deepEqual(ranked.map(r => [r.kind, r.execution?.depositVenue, r.execution?.transferQuantity, r.netBps]), [
    ['perp', 'binance', 9800, 1732.95], ['spot', 'binance', 9800, 764.22],
  ]);
  assert.equal(notices.length, 1);
  const { key, text } = notices[0]!;
  assert.match(key, /^chain-arb-deposit:binance:/);
  assert.match(text, /Binance 永续开空/);
  assert.match(text, /Binance 充值地址模拟实收 9800 ARB/);
  assert.ok(!text.includes(recipient) && !JSON.stringify(ranked).includes(recipient));
  assert.ok(background.notificationsCurrent(key, text));
  current = false;
  assert.deepEqual(background.view().results.binance!.rows, []);
  assert.equal(background.notificationsCurrent(key, text), false);
  at += 2100; current = true; netTokens = 8000n;
  await background.tick();
  assert.deepEqual(background.view().results.binance!.rows, []);
  assert.equal(notices.length, 1);

  netTokens = 9800n;
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
