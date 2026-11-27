// Entropy 真实成交、实扣手续费与账户费率采集测试（docs/dexspread.md 第 17 节）。
// 覆盖：解析校验、负手续费、非 USDC 隔离、满页二分与有界上限（L093）、坏行不推游标、HYPE 历史价回填、cloid 关联、账户隔离与脱敏（D4）、并发与路由。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { accountHashOf, createEntropyCostCollector, parseEntropyFills, parseHypeHourlyCandles, parseHypeMid, parseHyperliquidUserFees } from '../src/varlighter/entropy-cost.ts';
import { openVarLighterStore } from '../src/varlighter/store.ts';
import { localDexForward, openVarLighter, varLighterViews } from '../src/dex/host.ts';
import type { MarketSpec } from '../src/varlighter/model.ts';
import type { EntropyCostView } from '../src/varlighter/views.ts';

const T0 = Date.parse('2026-11-27T12:00:00Z');
const ADDR_A = '0x2222222222222222222222222222222222222222';
const ADDR_B = '0x1111111111111111111111111111111111111111';

const MARKET_SNDK: MarketSpec = {
  venue: 'entropy', symbol: 'SNDK', name: '', id: 2, coin: 'io:SNDK', mark: 100, index: 100, fundingHourly: 0,
  sizeDecimals: 2, priceDecimals: 4, minBase: 0, minQuote: 10, takerFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled',
};

const fillRow = (tid: number, extra: Record<string, unknown> = {}) => ({
  coin: 'io:SNDK', px: '100', sz: '1', side: 'B', time: T0 - 60_000, oid: tid + 1000, tid,
  crossed: true, fee: '0.00864', feeToken: 'USDC', dir: 'Open Long', closedPnl: '0', builderFee: '0',
  ...extra,
});

test('解析器：过滤非 io 标的、支持负手续费、坏行计入 invalidCount 不静默跳过', () => {
  const fees = parseHyperliquidUserFees({ userCrossRate: '0.00045', userAddRate: '0.00015', activeReferralDiscount: '0.04', activeStakingDiscount: { discount: '0.05' } });
  assert.deepEqual(fees, { userCrossRate: 0.00045, userAddRate: 0.00015, referralDiscount: 0.04, stakingDiscount: 0.05 });
  assert.equal(parseHypeMid({ HYPE: '66.12', BTC: '98000' }), 66.12);
  assert.equal(parseHypeMid({ HYPE: '0' }), null);
  const candles = parseHypeHourlyCandles([{ t: T0 - 3_600_000, c: '65.5' }, { t: T0, c: '66.0' }]);
  assert.equal(candles.get(T0 - 3_600_000), 65.5);

  const parsed = parseEntropyFills([
    { coin: 'BTC', tid: 1, oid: 1, time: T0, side: 'B', px: '90000', sz: '0.1', fee: '4', feeToken: 'USDC', crossed: true },
    fillRow(10, { crossed: false, fee: '-0.002', builderFee: undefined }), // Maker 负返佣合法
    fillRow(11, { fee: 'bad-num' }), // 坏行
    { coin: '', tid: 12 }, // 缺 coin
  ]);
  assert.equal(parsed.totalReturned, 4);
  assert.equal(parsed.invalidCount, 2);
  assert.equal(parsed.fills.length, 1);
  assert.deepEqual([parsed.fills[0]!.tid, parsed.fills[0]!.feeUsd, parsed.fills[0]!.builderFeeUsd], [10, -0.002, 0]);
});

test('采集、去重、关联 cloid、历史 HYPE K 线回填、非 USDC 隔离与隐私保护', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-cost-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  let clock = T0;
  let currentAddress: string | null = ADDR_A;
  const requests: { type: string; body: Record<string, unknown> }[] = [];
  const logs: string[] = [];

  const oldTime = T0 - 2 * 3_600_000;
  const recentTime = T0 - 2 * 60_000;
  const cloid = '0x0000000000000000000000000000007b';
  store.saveEntropyOrderLink({
    cloid, accountHash: accountHashOf(ADDR_A), positionId: 'live-1', purpose: 'open',
    coin: 'io:SNDK', assumedFeeBps: 0.2, catalogFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled', at: recentTime,
  });

  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({ type: String(body.type), body });
    if (body.type === 'userFees') return Response.json({ userCrossRate: '0.00045', userAddRate: '0.00015', activeReferralDiscount: '0.04', activeStakingDiscount: { discount: '0' } });
    if (body.type === 'allMids') return Response.json({ HYPE: '66.0' });
    if (body.type === 'candleSnapshot') return Response.json([{ t: Math.floor(oldTime / 3_600_000) * 3_600_000, c: '64.0' }]);
    if (body.type === 'userFillsByTime') {
      return Response.json([
        fillRow(101, { time: oldTime, px: '100', sz: '10', fee: '0.0864', feeToken: 'USDC' }), // 外部历史单：$1000, fee=0.0864, HYPE=64
        fillRow(102, { time: recentTime, px: '100', sz: '5', fee: '0.0432', feeToken: 'USDC', cloid }), // 本平台实盘单：$500, fee=0.0432, HYPE=66
        fillRow(103, { time: recentTime, px: '100', sz: '2', fee: '0.001', feeToken: 'HYPE', crossed: false }), // 非 USDC 计费
        { coin: 'BTC', tid: 104, oid: 1, time: recentTime, side: 'B', px: '90000', sz: '0.1', fee: '4', feeToken: 'USDC', crossed: true },
      ]);
    }
    throw new Error('unexpected ' + body.type);
  };

  try {
    const collector = createEntropyCostCollector({
      store, fetchImpl: fetchImpl as typeof fetch, now: () => clock, signalFor: () => AbortSignal.timeout(1000),
      entropyAccount: () => currentAddress, assumedFeeBps: () => 0.2, markets: () => [MARKET_SNDK], log: line => logs.push(line),
    });

    // 并发调用只发一轮请求
    const [r1, r2] = await Promise.all([collector.sync(false), collector.sync(false)]);
    assert.deepEqual([r1.added, r2.added, r1.ok], [3, 3, true]);
    assert.equal(requests.filter(r => r.type === 'userFillsByTime').length, 1);

    // 防抖测试：5 秒内重复手动同步不发网路请求
    clock += 2_000;
    const beforeReqs = requests.length;
    await collector.sync(true);
    await collector.sync(true);
    assert.ok(requests.length > beforeReqs);
    const afterFirstManual = requests.length;
    await collector.sync(true);
    assert.equal(requests.length, afterFirstManual, '5 秒防抖生效');

    const view = collector.view(T0 - 86_400_000, T0 + 10_000, 50);
    assert.equal(view.configured, true);
    assert.equal(view.summary.fills, 3);
    assert.deepEqual([view.summary.platformFills, view.summary.externalFills, view.summary.nonUsdcFeeCount], [1, 2, 1]);
    assert.ok(Math.abs(view.summary.notionalUsd - 1700) < 1e-6);
    assert.ok(Math.abs(view.summary.usdcFeeUsd - 0.1296) < 1e-9);
    // actualFeeBps 严格同口径只按 USDC 成交分母 $1500 计算：0.1296 / 1500 * 10000 = 0.864
    assert.ok(Math.abs(view.summary.actualFeeBps! - 0.864) < 1e-6);
    assert.ok(Math.abs(view.estimatedExchangeFeeBps! - 0.864) < 1e-6);
    // HYPE 加权均价：(1000*64 + 700*66) / 1700 = 64.8235...
    assert.ok(Math.abs(view.summary.weightedHypePriceUsd! - (64000 + 46200) / 1700) < 1e-6);
    const liveFill = view.fills.find(f => f.tid === 102)!;
    assert.deepEqual([liveFill.livePositionId, liveFill.livePurpose, liveFill.hypePriceUsd], ['live-1', 'open', 66]);
    assert.equal(view.fills.find(f => f.tid === 101)!.hypePriceUsd, 64);

    // 账户隔离 & 隐私核对（D4）
    assert.doesNotMatch(JSON.stringify(view), new RegExp(ADDR_A.slice(2), 'i'));
    currentAddress = ADDR_B;
    assert.equal(collector.view().summary.fills, 0, '切换到另一账户看不到原账户成交');
    currentAddress = null;
    const unconfigured = collector.view();
    assert.equal(unconfigured.configured, false);
    assert.equal((await collector.sync(false)).configured, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('L093 分页满页拆分、请求上限游标安全与坏行不推游标，报错脱敏', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-l093-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  let clock = T0;
  const logs: string[] = [];
  let mode: 'split' | 'overflow' | 'invalid' | 'error' = 'split';
  const windows: [number, number][] = [];

  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number; endTime?: number };
    if (body.type === 'userFees') return Response.json({ userCrossRate: '0.00045', userAddRate: '0.00015', activeReferralDiscount: '0', activeStakingDiscount: { discount: '0' } });
    if (body.type === 'allMids') return Response.json({ HYPE: '66' });
    if (body.type === 'candleSnapshot') return Response.json([]);
    if (body.type === 'userFillsByTime') {
      const start = body.startTime!, end = body.endTime!;
      windows.push([start, end]);
      if (mode === 'error') throw new Error(`failed for ${ADDR_A}`);
      if (mode === 'invalid') return Response.json([fillRow(1, { time: end }), fillRow(2, { px: 'bad' })]);
      if (mode === 'overflow') return Response.json(Array.from({ length: 2000 }, (_, i) => ({ coin: 'ETH', tid: i })));
      // split 模式：如果窗口 > 10 天则返回 2000 条非 io + 1 条 io，触发二分拆半；拆分后完整返回
      if (end - start > 16 * 86_400_000) {
        return Response.json([...Array.from({ length: 1999 }, (_, i) => ({ coin: 'BTC', tid: 5000 + i })), fillRow(9001, { time: end - 1000 })]);
      }
      return Response.json([fillRow(start < T0 - 15 * 86_400_000 ? 9002 : 9003, { time: end - 500 })]);
    }
    return Response.json({});
  };

  try {
    const collector = createEntropyCostCollector({
      store, fetchImpl: fetchImpl as typeof fetch, now: () => clock, signalFor: () => AbortSignal.timeout(1000),
      entropyAccount: () => ADDR_A, assumedFeeBps: () => 0.2, markets: () => [MARKET_SNDK], log: line => logs.push(line),
    });

    // 1) split：30 天窗口拆半后一次同步拉全，写入 3 条唯一 io 成交并推进游标
    const resSplit = await collector.sync(false);
    assert.deepEqual([resSplit.ok, resSplit.incomplete, resSplit.added], [true, false, 3]);
    assert.equal(windows.length, 3, '1 次满页 + 2 个半窗口');

    // 2) invalid：遇到坏行时不推进游标（先推进时钟，观察 cursorMs 未变）
    clock += 10 * 60_000;
    const beforeInvalid = store.state<Record<string, { cursorMs: number }>>('entropy_cost_sync')![accountHashOf(ADDR_A)]!.cursorMs;
    mode = 'invalid';
    const resInvalid = await collector.sync(true);
    assert.deepEqual([resInvalid.ok, resInvalid.incomplete, resInvalid.added], [false, true, 1], '有效条仍保留，坏行标 incomplete');
    assert.equal(store.state<Record<string, { cursorMs: number }>>('entropy_cost_sync')![accountHashOf(ADDR_A)]!.cursorMs, beforeInvalid, '坏行绝不推进游标');

    // 3) overflow：最多发 5 次请求即停（有界），标记 incomplete，不推进游标
    clock += 10_000;
    mode = 'overflow';
    windows.length = 0;
    const resOver = await collector.sync(true);
    assert.deepEqual([resOver.ok, resOver.incomplete, windows.length], [false, true, 5]);

    // 4) error：报错绝对不包含地址明文
    clock += 10_000;
    mode = 'error';
    const resErr = await collector.sync(true);
    assert.equal(resErr.ok, false);
    assert.doesNotMatch(resErr.error ?? '', new RegExp(ADDR_A.slice(2), 'i'));
    assert.doesNotMatch(logs.join('\n'), new RegExp(ADDR_A.slice(2), 'i'));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('host 路由与参数校验：GET entropy-cost / POST entropy-cost/sync', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-host-'));
  const holder = openVarLighter(dir, {
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as { type?: string } : {};
      if (body.type === 'userFees') return Response.json({ userCrossRate: '0.00045', userAddRate: '0.00015', activeReferralDiscount: '0.04', activeStakingDiscount: { discount: '0' } });
      if (body.type === 'allMids') return Response.json({ HYPE: '66.1' });
      if (body.type === 'userFillsByTime') return Response.json([fillRow(777)]);
      return Response.json({});
    }) as typeof fetch,
    accounts: () => ({ accounts: { entropy: { address: ADDR_A } }, problem: null }),
    now: () => T0,
  }, () => {});
  const forward = localDexForward(varLighterViews(holder));
  try {
    const syncAns = await forward.page({ method: 'POST', path: 'entropy-cost/sync', query: [], body: {} });
    assert.equal(syncAns.status, 200);
    assert.equal((syncAns.body as { added: number }).added, 1);

    const viewAns = await forward.page({ method: 'GET', path: 'entropy-cost', query: [['from', '0'], ['to', String(T0)], ['limit', '10']] });
    assert.equal(viewAns.status, 200);
    const body = viewAns.body as EntropyCostView;
    assert.equal(body.summary.fills, 1);
    assert.equal(body.fills[0]!.tid, 777);

    assert.equal((await forward.page({ method: 'GET', path: 'entropy-cost', query: [['limit', '0']] })).status, 400);
    assert.equal((await forward.page({ method: 'GET', path: 'entropy-cost', query: [['from', String(T0)], ['to', '10']] })).status, 400);
  } finally { holder.engine?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P1/P2/P3 修复回归：手动限时返回 pending、跨轮满页二分推进、局部失败不覆盖费率快照、大小写 cloid 与空假设回退目录费率', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-fix-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  let clock = T0;
  let scenario: 'dense-split' | 'slow-manual' | 'fees-fail' | 'hype-missing' | 'backfill-hype' = 'dense-split';
  let assumed: number | null = null;
  const startDay = T0 - 30 * 86_400_000;
  const denseCutoff = startDay + 3_600_000; // 只在头 1 小时（< 30d/16 = 45h）内超过 2000 条，验证必须跨轮缩小 probeEndMs 才能完成
  const cloidLower = '0x00000000000000000000000000000abc';
  store.saveEntropyOrderLink({
    cloid: cloidLower.toUpperCase().replace('0X', '0x'),
    accountHash: accountHashOf(ADDR_A), positionId: 'live-upper', purpose: 'close',
    coin: 'io:SNDK', assumedFeeBps: null, catalogFeeBps: 0.9, deployerFeeScale: 1, growthMode: 'enabled', at: T0 - 300_000,
  });

  const fetchImpl = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number; endTime?: number };
    if (body.type === 'userFees') {
      if (scenario === 'fees-fail') throw new Error('userFees down');
      return Response.json({ userCrossRate: '0.00045', userAddRate: '-0.00010', activeReferralDiscount: '0.04', activeStakingDiscount: { discount: '0' } });
    }
    if (body.type === 'allMids') {
      if (scenario === 'slow-manual') await new Promise(resolve => setTimeout(resolve, 120));
      if (scenario === 'fees-fail') return Response.json({ HYPE: '72.0' }); // userFees 失败但 HYPE 涨 >1% 触发新快照
      if (scenario === 'hype-missing') return Response.json({ BTC: '99000' }); // 无 HYPE 价格，验证随后重拉能回填
      return Response.json({ HYPE: '68.5' });
    }
    if (body.type === 'candleSnapshot') return Response.json([{ t: Math.floor((startDay + 1000) / 3_600_000) * 3_600_000, c: '60.0' }]);
    if (body.type === 'userFillsByTime') {
      const start = body.startTime!, end = body.endTime!;
      if (scenario === 'dense-split') {
        if (end - start > 86_400_000 && start <= denseCutoff) {
          return Response.json(Array.from({ length: 2000 }, (_, i) => ({ coin: 'ETH', tid: 10_000 + i })));
        }
        if (start <= denseCutoff && end >= startDay) {
          return Response.json([fillRow(8001, { time: startDay + 1000, px: '100', sz: '2', fee: '0.01728', feeToken: 'USDC' })]);
        }
        return Response.json([
          fillRow(8002, { time: T0 - 120_000, px: '100', sz: '3', fee: '0.02592', feeToken: 'USDC', cloid: '0X00000000000000000000000000000ABC' }),
          fillRow(8003, { time: T0 - 60_000, px: '100', sz: '1', fee: '0.002', feeToken: 'HYPE' }),
        ]);
      }
      if (scenario === 'fees-fail') {
        return Response.json([fillRow(8004, { time: T0 + 10_000, px: '100', sz: '1', fee: '0.00864', feeToken: 'USDC' })]);
      }
      if (scenario === 'hype-missing' || scenario === 'backfill-hype') {
        return Response.json([fillRow(8005, { time: T0 + 20_000, px: '100', sz: '1', fee: '0.00864', feeToken: 'USDC' })]);
      }
      return Response.json([fillRow(8006, { time: T0 + 30_000, px: '100', sz: '1', fee: '0.00864', feeToken: 'USDC' })]);
    }
    return Response.json({});
  };

  try {
    const collector = createEntropyCostCollector({
      store, fetchImpl: fetchImpl as typeof fetch, now: () => clock,
      signalFor: () => AbortSignal.timeout(1000), manualWaitMs: 30,
      entropyAccount: () => ADDR_A, assumedFeeBps: () => assumed, markets: () => [MARKET_SNDK],
    });

    // 1) 跨轮满页二分推进：第 1 轮持久化 pendingQueue 与 probeStartMs/probeEndMs，后续几轮持续排空直至 cursorMs 推进到 tNow
    let rDense = await collector.sync(false);
    assert.equal(rDense.incomplete, true);
    const syncAfter1 = store.state<Record<string, { cursorMs: number; probeEndMs: number | null; probeStartMs: number | null; pendingQueue?: [number, number][] | null }>>('entropy_cost_sync')![accountHashOf(ADDR_A)]!;
    assert.ok(syncAfter1.probeEndMs !== null && syncAfter1.probeEndMs - startDay < 86_400_000);
    assert.equal(syncAfter1.probeStartMs, startDay);
    let denseAdded = rDense.added;
    for (let i = 0; i < 4 && rDense.incomplete; i++) {
      clock += 60_000;
      rDense = await collector.sync(false);
      denseAdded += rDense.added;
    }
    assert.deepEqual([rDense.ok, rDense.incomplete, denseAdded], [true, false, 3]);
    const syncAfter2 = store.state<Record<string, { cursorMs: number; probeEndMs: number | null; probeStartMs: number | null; pendingQueue?: [number, number][] | null }>>('entropy_cost_sync')![accountHashOf(ADDR_A)]!;
    assert.ok(syncAfter2.cursorMs >= T0);
    assert.deepEqual([syncAfter2.probeStartMs, syncAfter2.probeEndMs, syncAfter2.pendingQueue], [null, null, null]);

    // 验证大小写 cloid 关联成功 + 负 Maker userAddRate 解析 + 非 USDC 分母分离 + 空 assumedFeeBps 回退 catalogFeeBps
    const view = collector.view(0, T0 + 100_000, 50);
    assert.equal(view.snapshot?.userAddRate, -0.0001);
    assert.equal(view.summary.usdcNotionalUsd, 500, 'HYPE 计费成交不混入 USDC 分母');
    assert.equal(view.summary.notionalUsd, 600);
    assert.equal(view.fills.find(f => f.tid === 8002)!.livePositionId, 'live-upper');
    assert.ok(Math.abs(view.summary.assumedFeeUsd - 600 * 0.9 / 10_000) < 1e-9, '假设费率留空时外部与实盘成交均回退目录费率 0.9 bps');

    // 2) userFees 失败但 allMids 返回 72.0（触发新快照）：不得把已有 userCrossRate/userAddRate 覆盖为 null，成交留档保留费率
    scenario = 'fees-fail';
    clock += 60_000;
    const resFail = await collector.sync(false);
    assert.equal(resFail.added, 1);
    const viewAfterFail = collector.view(0, T0 + 200_000, 50);
    assert.equal(viewAfterFail.snapshot?.hypePriceUsd, 72);
    assert.equal(viewAfterFail.snapshot?.userCrossRate, 0.00045);
    assert.equal(viewAfterFail.snapshot?.userAddRate, -0.0001);
    assert.equal(store.entropyFillsAll(accountHashOf(ADDR_A), 0, T0 + 200_000).find(f => f.tid === 8004)!.hlCrossRate, 0.00045);

    // 3) allMids 缺失 HYPE 时入库为 null，恢复后在重叠窗内重新同步补写 hypePriceUsd 且不重复计 added（P3 #1）
    scenario = 'hype-missing';
    clock += 60_000;
    const resMissing = await collector.sync(false);
    assert.equal(resMissing.added, 1);
    assert.equal(collector.view(0, T0 + 200_000, 50).fills.find(f => f.tid === 8005)!.hypePriceUsd, null);
    scenario = 'backfill-hype';
    clock += 20_000;
    const resBackfill = await collector.sync(false);
    assert.equal(resBackfill.added, 0);
    assert.equal(collector.view(0, T0 + 200_000, 50).fills.find(f => f.tid === 8005)!.hypePriceUsd, 68.5);

    // 4) 手动同步超时返回 pending，不抛断链，且后台继续完成并通过 idle() 收尾落库
    scenario = 'slow-manual';
    clock += 10_000;
    const manualRes = await collector.sync(true);
    assert.deepEqual([manualRes.ok, manualRes.pending, manualRes.added], [true, true, 0]);
    await collector.idle();
    assert.equal(collector.view(0, T0 + 200_000, 50).summary.fills, 6);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('P1/P2 终轮回归：cursorMs > 0 跨重叠窗多轮满页推进，以及停服中止与后台抛错保护', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-entropy-cursor-'));
  const store = openVarLighterStore(path.join(dir, 'varlighter.sqlite'));
  const hash = accountHashOf(ADDR_A);
  const c = T0;
  let clock = T0 + 48 * 3_600_000; // 48 小时后做增量拉取
  store.setState('entropy_cost_sync', { [hash]: { cursorMs: c, lastSyncAt: c, lastOkAt: c, incomplete: false, error: null } }, c);

  try {
    // 1) cursorMs > 0 时，60s 重叠窗内有 >= 2000 条（跨度 > 10s 即超限），验证多轮间 probeStartMs/probeEndMs 持续推进直至全部完成
    const tailFillTime = clock - 1_000;
    const fetchOverlap = async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { type: string; startTime?: number; endTime?: number };
      if (body.type === 'userFees') return Response.json({ userCrossRate: '0.00045', userAddRate: '0', activeReferralDiscount: '0', activeStakingDiscount: { discount: '0' } });
      if (body.type === 'allMids') return Response.json({ HYPE: '66' });
      if (body.type === 'candleSnapshot') return Response.json([]);
      if (body.type === 'userFillsByTime') {
        const start = body.startTime!, end = body.endTime!;
        if (start <= c + 3_000 && end - start > 10_000) {
          return Response.json(Array.from({ length: 2000 }, (_, i) => ({ coin: 'ETH', tid: 30_000 + i })));
        }
        return Response.json(start <= tailFillTime && tailFillTime <= end ? [fillRow(9501, { time: tailFillTime })] : []);
      }
      return Response.json({});
    };
    const collector = createEntropyCostCollector({
      store, fetchImpl: fetchOverlap as typeof fetch, now: () => clock,
      signalFor: () => AbortSignal.timeout(1000), entropyAccount: () => ADDR_A,
      assumedFeeBps: () => 0.2, markets: () => [MARKET_SNDK],
    });

    // 连续多轮以内应当能跨越 c-60_000..c+3_000 并推进到 clock（旧逻辑在 pendingHead[1] <= c 时清零 probeEndMs 导致永远卡死）
    let finalRes = await collector.sync(false);
    let totalOverlapAdded = finalRes.added;
    for (let i = 0; i < 20 && finalRes.incomplete; i++) {
      const state = store.state<Record<string, { cursorMs: number; probeStartMs: number | null; probeEndMs: number | null }>>('entropy_cost_sync')![hash]!;
      assert.ok(state.probeEndMs !== null, `未完成第 ${i + 1} 轮不能清空 probeEndMs`);
      assert.ok(state.probeStartMs !== null && state.probeStartMs >= c - 60_000, '增量拆分须保留推进后的 probeStartMs');
      clock += 60_000;
      finalRes = await collector.sync(false);
      totalOverlapAdded += finalRes.added;
    }
    assert.deepEqual([finalRes.ok, finalRes.incomplete, totalOverlapAdded], [true, false, 1]);
    const finalState = store.state<Record<string, { cursorMs: number; probeStartMs: number | null; probeEndMs: number | null; pendingQueue?: [number, number][] | null }>>('entropy_cost_sync')![hash]!;
    assert.ok(finalState.cursorMs >= clock);
    assert.deepEqual([finalState.probeStartMs, finalState.probeEndMs, finalState.pendingQueue], [null, null, null]);

    // 2) stopSignal 已中止时 sync() 不应发起请求；手动超时提前返回 pending 后后台抛错不应导致 unhandledRejection
    const stop = new AbortController();
    let fetchCalls = 0;
    const logs: string[] = [];
    const failingStore = {
      ...store,
      setState: () => { throw new Error(`db busy ${ADDR_A}`); },
    };
    const safeCollector = createEntropyCostCollector({
      store: failingStore,
      fetchImpl: (async (_u: unknown, init?: RequestInit) => {
        fetchCalls++;
        const body = JSON.parse(String(init?.body)) as { type: string };
        if (body.type === 'allMids') await new Promise(resolve => setTimeout(resolve, 60));
        return Response.json(body.type === 'userFillsByTime' ? [] : {});
      }) as typeof fetch,
      now: () => clock,
      signalFor: () => AbortSignal.timeout(1000),
      stopSignal: stop.signal,
      manualWaitMs: 15,
      entropyAccount: () => ADDR_A,
      assumedFeeBps: () => 0.2,
      markets: () => [MARKET_SNDK],
      log: line => logs.push(line),
    });
    const pendingRes = await safeCollector.sync(true);
    assert.equal(pendingRes.pending, true);
    await safeCollector.idle(); // 后台 writeSync 抛错应被捕获记日志而非未捕获拒绝
    assert.ok(logs.some(line => line.includes('异常') && !line.includes(ADDR_A.slice(2))));

    stop.abort();
    const beforeAbort = fetchCalls;
    const afterAbort = await safeCollector.sync(false);
    assert.deepEqual([afterAbort.ok, afterAbort.error, fetchCalls], [false, '服务正在停止', beforeAbort]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
