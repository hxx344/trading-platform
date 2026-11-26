import assert from 'node:assert/strict';
import test from 'node:test';
import { compareChainArb } from '../src/chain-arb/estimate.ts';
import { address, band, book, index, network, okxInput as input, okxTestNow as now, okxWallet as wallet,
  openInterest, pair, perp, setupOkxPublic as setup } from './chain-arb-okx-fake.ts';

const signal = new AbortController().signal;

test('OKX 两腿按同链同址入选，复核张数、面额、步长、美元限额和实际受保护深度', async () => {
  const { reader, calls } = setup();
  const rows = await reader.catalog(signal);
  assert.deepEqual(rows, [{ symbol: 'ARB', chain: 'arbitrum', address, spot: true, perp: true }]);
  assert.equal(await reader.catalog(signal), rows);
  const view = await reader.read(input, signal);
  assert.deepEqual(view, { deposit: true, withdraw: false, minDeposit: '0.15',
    spot: { at: now - 30, bids: [['10', '1'], ['9', '1']], step: '0.1', minQuantity: '0.2', maxNotional: '100' },
    perp: { at: now - 20, bids: [['10', '0.5'], ['9', '1']], step: '0.05', minQuantity: '0.1', maxQuantity: '5' } });
  assert.equal(calls.filter(key => key === 'spots').length, 1);
  assert.ok(!calls.includes('interest'));
  const quote = (rawQuantity: string) => compareChainArb(input,
    { rawQuantity, decimals: 1, at: now }, view, now).spot;
  assert.ok('price' in quote('20'));
  assert.ok('error' in quote('21'));
});

test('OKX 入金关闭只剔除现货，钱包和公共市场各自换代后撤销候选', async () => {
  const { reader, state, calls, available } = setup();
  const before = await reader.catalog(signal);
  state.wallet = wallet([{ ...network, deposit: false, depositEligible: false }, { ...network, chain: 'ethereum' }, { ...network, chain: 'bsc' }]);
  const next = await reader.catalog(signal);
  assert.notEqual(before, next);
  assert.deepEqual(next.map(row => [row.chain, row.spot, row.perp]),
    [['arbitrum', false, true], ['ethereum', true, true], ['bsc', true, true]]);
  const view = await reader.read(input, signal);
  assert.ok('error' in view.spot && 'bids' in view.perp);
  assert.ok(!calls.includes('spotBook'));
  state.time += 300_000;
  state.wallet = wallet([network], state.time);
  available.spots = [pair, pair];
  available.perps = [{ ...perp, expTime: String(state.time + 60_000) }];
  assert.deepEqual(await reader.catalog(signal), []);
  assert.equal(calls.filter(key => key === 'spots').length, 2);
});

test('OKX 开放充值而到账规则不明时，显示实际开关并只给同币永续报价', async () => {
  const { reader, state } = setup();
  state.wallet = wallet([{ ...network, depositEligible: false }]);
  assert.deepEqual((await reader.catalog(signal)).map(row => [row.spot, row.perp]), [[false, true]]);
  const priced = compareChainArb(input, { rawQuantity: '15', decimals: 1, at: now }, await reader.read(input, signal), now);
  assert.equal(priced.deposit, true);
  assert.match('error' in priced.spot ? priced.spot.error : '', /到账条件或费用/);
  assert.ok('price' in priced.perp);
});

test('OKX 同名或同链地址冲突、身份不符、读取中换连接和过期均停止报价', async () => {
  const { reader, state } = setup();
  for (const wrong of [{ address: '0x' + '1'.repeat(40) }, { symbol: 'ALT' }, { chain: 'ethereum' as const }]) {
    await assert.rejects(reader.read({ ...input, ...wrong }, signal), /唯一匹配/);
  }
  for (const conflict of [{ ...network, symbol: 'ALT' }, { ...network, address: '0x' + '1'.repeat(40) }]) {
    state.wallet = wallet([network, conflict]);
    await assert.rejects(reader.catalog(signal), /目录/);
  }
  state.wallet = wallet();
  state.onFetch = key => { if (key === 'spotBook') state.wallet = { ...state.wallet, connection: 'b'.repeat(32) }; };
  await assert.rejects(reader.read(input, signal), /更新/);
  state.onFetch = () => {};
  state.wallet = { ...wallet(), expiresAt: now + 800 };
  const view = await reader.read(input, signal);
  assert.ok('at' in view.spot && view.spot.at + 15_000 === now + 800);
  state.time += 800;
  await assert.rejects(reader.catalog(signal), /过期/);
});

test('OKX 公开目录与单币产品均须确认市场正常、身份和交易币种一致', async () => {
  for (const changed of [{ state: 'post_only' }, { instCategory: '3' }, { ruleType: 'pre_market' },
    { ctType: 'inverse' }, { ctValCcy: 'USD' }, { settleCcy: 'USDC' }, { uly: 'X-USDT' }]) {
    const { reader } = setup({ perps: [{ ...perp, ...changed }] });
    const [row] = await reader.catalog(signal);
    assert.ok(row.spot && !row.perp);
  }
  for (const changed of [{ quoteCcy: 'USDC' }, { contTdSwTime: String(now + 1) }, { tradeQuoteCcyList: ['USD'] },
    { expTime: String(now + 700_000) }, { instId: 'OTHER-USDT' }]) {
    const { reader } = setup({ spotMeta: [{ ...pair, ...changed }] });
    const result = await reader.read(input, signal);
    assert.ok('error' in result.spot && 'bids' in result.perp);
  }
  const halted = setup({ perpMeta: [{ ...perp, state: 'suspend' }] });
  assert.ok('error' in (await halted.reader.read(input, signal)).perp);
  const limited = setup({ spotMeta: [{ ...pair, upcChg: [{ param: 'minSz', effTime: String(now + 100) }] }] });
  const result = await limited.reader.read(input, signal);
  assert.ok('at' in result.spot && result.spot.at + 15_000 === now + 100);
});

test('OKX 价格下限、原始时间、外汇及限流独立影响对应路线', async () => {
  for (const changes of [
    { spotBook: [{ ...book, ts: String(now - 15_000) }] },
    { spotBook: [{ ...book, bids: [...book.bids].reverse() }] },
    { spotBand: [{ ...band, ts: String(now + 2001) }] }, { spotBand: [{ ...band, instId: perp.instId }] },
    { spotBand: [{ ...band, enabled: 'false' }] }, { index: [{ ...index, instId: 'USD-USDT' }] },
    { index: [{ ...index, ts: String(now - 15_001) }] }, { index: [{ ...index, idxPx: '0' }] },
  ]) {
    const result = await setup(changes).reader.read(input, signal);
    assert.ok('error' in result.spot && 'bids' in result.perp);
  }
  const { reader } = setup({ index: [{ ...index, idxPx: '0.8' }], spotBand: [{ ...band, enabled: false, sellLmt: '' }],
    perpBand: Response.json({ code: '50011', data: [] }) });
  const view = await reader.read(input, signal);
  assert.ok('bids' in view.spot && view.spot.maxNotional === '120');
  assert.ok('error' in view.perp && view.perp.rateLimited);
  const exact = setup({ perpMeta: [{ ...perp, ctVal: '0.000000000000000001', ctMult: '0.000000000000000001' }] });
  const tiny = (await exact.reader.read(input, signal)).perp;
  assert.ok('step' in tiny && tiny.step === '0.' + '0'.repeat(36) + '1');
});

test('OKX 有平台开仓上限时按原币和美元分别核对当前持仓量', async () => {
  const rules = { ...perp, maxPlatOILmt: '100', maxPlatOICoinLmt: '21' };
  for (const changes of [{ oiUsd: '100' }, { oiCcy: '22' }, { instId: 'OTHER-USDT-SWAP' }, { ts: String(now - 15_000) }]) {
    const result = await setup({ perpMeta: [rules], interest: [{ ...openInterest, ...changes }] }).reader.read(input, signal);
    assert.ok('error' in result.perp && 'bids' in result.spot);
  }
  const result = await setup({ perpMeta: [rules] }).reader.read(input, signal);
  assert.ok('at' in result.perp && result.perp.at === now - 40);
});

test('OKX 整笔估算在美元或 USDT 现货限额、永续最大张数的边界接受，超过一步时拒绝', async () => {
  const deep = [{ ...book, bids: [['10', '1000', '0', '1']] }];
  for (const [idxPx, bound] of [['1.25', 100], ['0.8', 120]] as const) {
    const { reader } = setup({ spotBook: deep, perpBook: deep, index: [{ ...index, idxPx }] });
    const view = await reader.read(input, signal);
    const quote = (rawQuantity: number) => compareChainArb(input,
      { rawQuantity: String(rawQuantity), decimals: 2, at: now }, view, now);
    assert.ok('quantity' in quote(bound * 10).spot);
    assert.match((quote(bound * 10 + 10).spot as { error: string }).error, /名义金额/);
    assert.ok('quantity' in quote(500).perp);
    assert.match((quote(505).perp as { error: string }).error, /数量不在/);
    assert.match((quote(5).perp as { error: string }).error, /数量不在/);
  }
});
