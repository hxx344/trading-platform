import test from 'node:test';
import assert from 'node:assert/strict';
import { readRhLighterSnapshot, RH_LIGHTER_COOLDOWN_MS, RH_LIGHTER_ERRORS } from '../src/asset/sources/rh-lighter.ts';
import {
  LIGHTER_MAINNET_ERRORS,
  NOTE_COIN,
  RH_LIGHTER_ACCOUNT_ERRORS,
  syncLighterAccount,
  syncRhLighterAccount,
} from '../src/asset/sources/lighter-account.ts';

type RequestInfo = string | Request;

const ADDRESS = '0x00000000000000000000000000000000000000Ab';
const USER = ADDRESS.toLowerCase();
const GECKO = 'https://api.coingecko.com/api/v3/simple/price?ids=virtual-protocol,tether,usd-coin&vs_currencies=usd&include_last_updated_at=true';
const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const NOW = Date.parse('2026-11-10T08:00:00Z');

const accountPayload = (index: number, extra: Record<string, unknown> = {}) => ({
  code: 200,
  total: 1,
  accounts: [{
    index,
    account_index: index,
    l1_address: ADDRESS,
    total_asset_value: '250.5',
    assets: [],
    positions: [],
    ...extra,
  }],
});

test('Lighter 主网单账户读取：按 USDC/USD 汇率折算、Coinbase 回退，细节不含编号与地址', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let useCoinbase = false;
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(url);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'manual');
    if (url.startsWith('https://mainnet.zklighter.elliot.ai/api/v1/account')) {
      const parsed = new URL(url);
      assert.deepEqual([parsed.searchParams.get('by'), parsed.searchParams.get('value'), parsed.searchParams.get('active_only')], ['index', '12345', 'true']);
      return Response.json(accountPayload(12345, {
        total_asset_value: '1000',
        assets: [{ symbol: 'USDC', asset_id: 3, balance: '50', locked_balance: '2.5' }],
        shares: [{ public_pool_index: 1, shares_amount: 4 }],
        bo_positions: [{ market_id: 2 }],
      }));
    }
    if (url === GECKO) {
      if (useCoinbase) return new Response('', { status: 503 });
      return Response.json({ 'usd-coin': { usd: 0.999, last_updated_at: Math.floor((NOW - 45_000) / 1000) } });
    }
    if (url === COINBASE) {
      return Response.json({ data: { currency: 'USDC', rates: { USD: '1.0002' } } });
    }
    throw new Error('unexpected URL ' + url);
  }) as typeof fetch;

  const first = await syncLighterAccount(12345, fetcher);
  assert.equal(first.accountIndex, 12345);
  assert.equal(first.l1Address, USER);
  assert.ok(Math.abs(first.total - 999) < 1e-9);
  assert.equal(first.updatedAt, new Date(NOW - 45_000).toISOString());
  assert.deepEqual(first.quote, {
    coin: 'USDC',
    usd: 0.999,
    source: 'CoinGecko / USD',
    at: new Date(NOW - 45_000).toISOString(),
    receivedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(first.details.map(row => [row.coin, row.account, row.quantity, row.price, row.value]), [
    ['USDC', '账户总值（含未实现盈亏）', 1000, 0.999, 999],
    ['USDC', '现货余额（未计入总额）', 50, 0, 0],
    ['USDC', '现货挂单锁定（未计入总额）', 2.5, 0, 0],
    [NOTE_COIN, '持有公共池份额，未计入总额', 0, 0, 0],
    [NOTE_COIN, '持有二元期权仓位，未单独列出', 0, 0, 0],
  ]);
  const text = JSON.stringify(first.details);
  assert.equal(text.includes('12345'), false);
  assert.equal(text.toLowerCase().includes(USER), false);

  useCoinbase = true;
  const second = await syncLighterAccount(12345, fetcher);
  assert.ok(Math.abs(second.total - 1000.2) < 1e-9);
  assert.equal(second.quote?.source, 'Coinbase / USD（获取时间）');
  assert.equal(seen.filter(url => url === COINBASE).length, 1);
});

test('Lighter RH 单账户读取：USDG 1:1 计价并与全地址读取共享 60 秒限流冷却', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let hits = 0;
  let block = true;
  const fetcher = (async (input: RequestInfo | URL) => {
    hits++;
    const url = new URL(String(input));
    if (block) return new Response('', { status: 429 });
    if (url.searchParams.get('by') === 'l1_address') {
      return Response.json({ code: 200, total: 1, accounts: accountPayload(77).accounts });
    }
    assert.deepEqual([url.searchParams.get('by'), url.searchParams.get('value')], ['index', '77']);
    return Response.json(accountPayload(77, { total_asset_value: '321.25' }));
  }) as typeof fetch;

  await assert.rejects(syncRhLighterAccount(77, fetcher), { message: RH_LIGHTER_ERRORS.rateLimited });
  assert.equal(hits, 1);
  // Shared cooldown blocks readRhLighterSnapshot without issuing another HTTP request.
  await assert.rejects(readRhLighterSnapshot(ADDRESS, fetcher), { message: RH_LIGHTER_ERRORS.rateLimited });
  assert.equal(hits, 1);

  t.mock.timers.tick(RH_LIGHTER_COOLDOWN_MS + 1);
  block = false;
  const res = await syncRhLighterAccount(77, fetcher);
  assert.equal(res.total, 321.25);
  assert.equal(res.l1Address, USER);
  assert.equal(res.details[0]?.coin, 'USDG');
  assert.equal(hits, 2);

  // Triggering cooldown from readRhLighterSnapshot also blocks syncRhLighterAccount.
  const shared = (async () => new Response(JSON.stringify({ code: 23000, message: 'rate limit' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
  await assert.rejects(readRhLighterSnapshot(ADDRESS, shared), { message: RH_LIGHTER_ERRORS.rateLimited });
  await assert.rejects(syncRhLighterAccount(77, shared), { message: RH_LIGHTER_ERRORS.rateLimited });
});

test('Lighter 单账户读取失败场景：不合法参数、身份不符、缺字段、400/500/重定向/超大/超时均只报安全错误', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  await assert.rejects(syncLighterAccount(-1, fetch), { message: LIGHTER_MAINNET_ERRORS.index });
  await assert.rejects(syncLighterAccount(1.5, fetch), { message: LIGHTER_MAINNET_ERRORS.index });
  await assert.rejects(syncRhLighterAccount(2 ** 48, fetch), { message: RH_LIGHTER_ACCOUNT_ERRORS.index });

  const badPayloads = [
    accountPayload(999), // mismatched index
    accountPayload(10, { l1_address: 'not-an-address' }),
    accountPayload(10, { l1_address: undefined }),
    accountPayload(10, { total_asset_value: undefined }),
    accountPayload(10, { total_asset_value: 'abc' }),
    { code: 200, total: 2, accounts: [accountPayload(10).accounts[0], accountPayload(11).accounts[0]] },
  ];
  for (const body of badPayloads) {
    const fetcher = (async () => Response.json(body)) as typeof fetch;
    await assert.rejects(syncLighterAccount(10, fetcher), { message: LIGHTER_MAINNET_ERRORS.invalid });
  }

  const missingFetcher = (async () => Response.json({ code: 21100, message: 'account not found 10 ' + ADDRESS }, { status: 400 })) as typeof fetch;
  await assert.rejects(syncLighterAccount(10, missingFetcher), { message: LIGHTER_MAINNET_ERRORS.missing });
  await assert.rejects(syncRhLighterAccount(10, missingFetcher), { message: RH_LIGHTER_ACCOUNT_ERRORS.missing });

  const serverErrorFetcher = (async () => new Response('secret internal error ' + ADDRESS, { status: 500 })) as typeof fetch;
  const err500 = await syncLighterAccount(10, serverErrorFetcher).then(() => assert.fail('expected reject'), (e: Error) => e.message);
  assert.match(err500, /^Lighter 主网 读取失败（HTTP 500）/);
  assert.equal(err500.includes(ADDRESS), false);

  const redirectedFetcher = (async () => ({ ok: true, redirected: true, status: 302, body: { cancel: async () => {} } }) as unknown as Response) as typeof fetch;
  await assert.rejects(syncLighterAccount(10, redirectedFetcher), { message: /^Lighter 主网 读取失败（HTTP 302）/ });

  const hugeFetcher = (async () => new Response('x'.repeat(2 * 1024 * 1024 + 10), { status: 200 })) as typeof fetch;
  await assert.rejects(syncLighterAccount(10, hugeFetcher), { message: LIGHTER_MAINNET_ERRORS.invalid });

  const timeoutFetcher = (async () => { throw new Error('connect ETIMEDOUT secret-internal-host'); }) as typeof fetch;
  await assert.rejects(syncLighterAccount(10, timeoutFetcher), { message: LIGHTER_MAINNET_ERRORS.network });
});

test('Lighter 主网 60 秒独立冷却与恢复、双汇率源失败及非 21100 400 应答', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  let mainnetHits = 0;
  let rhHits = 0;
  let mode: '429' | 'ok' | '23000' = '429';
  let failQuotes = false;
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://mainnet.zklighter.elliot.ai/')) {
      mainnetHits++;
      if (mode === '429') return new Response('', { status: 429 });
      if (mode === '23000') return Response.json({ code: 23000, message: 'rate limit' });
      return Response.json(accountPayload(55, { total_asset_value: '400' }));
    }
    if (url.startsWith('https://api.rh.lighter.xyz/')) {
      rhHits++;
      return Response.json(accountPayload(55, { total_asset_value: '125' }));
    }
    if (url === GECKO) {
      if (failQuotes) return new Response('', { status: 503 });
      return Response.json({ 'usd-coin': { usd: 1, last_updated_at: Math.floor(NOW / 1000) } });
    }
    if (url === COINBASE) return new Response('', { status: 503 });
    throw new Error('unexpected URL ' + url);
  }) as typeof fetch;

  await assert.rejects(syncLighterAccount(55, fetcher), { message: LIGHTER_MAINNET_ERRORS.rateLimited });
  assert.equal(mainnetHits, 1);
  // Blocked inside 60s window without issuing mainnet request, and does not block RH cooldown.
  await assert.rejects(syncLighterAccount(55, fetcher), { message: LIGHTER_MAINNET_ERRORS.rateLimited });
  assert.equal(mainnetHits, 1);
  const rhOk = await syncRhLighterAccount(55, fetcher);
  assert.deepEqual([rhOk.total, rhHits], [125, 1]);

  t.mock.timers.tick(RH_LIGHTER_COOLDOWN_MS + 1);
  mode = 'ok';
  const recovered = await syncLighterAccount(55, fetcher);
  assert.deepEqual([recovered.total, mainnetHits], [400, 2]);

  // JSON code 23000 also activates 60s cooldown.
  mode = '23000';
  await assert.rejects(syncLighterAccount(55, fetcher), { message: LIGHTER_MAINNET_ERRORS.rateLimited });
  await assert.rejects(syncLighterAccount(55, fetcher), { message: LIGHTER_MAINNET_ERRORS.rateLimited });
  assert.equal(mainnetHits, 3);

  // CoinGecko + Coinbase dual failure throws safe quote error.
  t.mock.timers.tick(RH_LIGHTER_COOLDOWN_MS + 1);
  mode = 'ok';
  failQuotes = true;
  await assert.rejects(syncLighterAccount(55, fetcher), { message: LIGHTER_MAINNET_ERRORS.quote });

  // HTTP 400 with non-21100 code or non-JSON body maps to safe HTTP 400 error.
  const other400 = (async () => Response.json({ code: 99999, message: 'bad param ' + ADDRESS }, { status: 400 })) as typeof fetch;
  await assert.rejects(syncLighterAccount(55, other400), { message: /^Lighter 主网 读取失败（HTTP 400）/ });
  const text400 = (async () => new Response('not json ' + ADDRESS, { status: 400 })) as typeof fetch;
  await assert.rejects(syncLighterAccount(55, text400), { message: /^Lighter 主网 读取失败（HTTP 400）/ });
});
