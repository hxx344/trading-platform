import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { isDisplayRead, MAX_VIEW_LENGTH, READ_BASE, READ_CACHE, READ_VERSION, ReadViewCache, restoreView, versionLength } from '../src/read-view.ts';
import { readViewReply } from '../src/read-view-server.ts';
import { api, ApiError } from '../web/src/api.ts';
import { createHarness } from './harness.ts';

const records = Array.from({ length: 200 }, (_, id) => ({ id, price: String(300 + id), text: '关联成交📈', time: 1_800_000_000_000 + id }));

test('成交有新增、删除、同时间修订，元数据更新后仅传差异，并精确还原顺序和数值', () => {
  const cache = new ReadViewCache();
  const first = { generatedAt: 1, fills: records, proof: { complete: true } };
  const initial = readViewReply(cache, 'account', '1', first);
  const next = { generatedAt: 2, fills: [{ ...records[0], id: 400 }, ...records.slice(2, 90), { ...records[90], price: '123.4500' }, ...records.slice(91)], proof: { complete: false } };
  const updated = readViewReply(cache, 'account', initial.headers[READ_VERSION], next);
  const version = updated.headers[READ_VERSION];
  assert.equal(updated.headers[READ_BASE], initial.headers[READ_VERSION]);
  assert.equal(restoreView(initial.text, JSON.parse(updated.text), versionLength(version)), JSON.stringify(next));
  assert.ok(Buffer.byteLength(updated.text) < Buffer.byteLength(initial.text) / 10);
  assert.deepEqual(readViewReply(cache, 'account', version, next), { status: 204, text: '', headers: { [READ_VERSION]: version } });
  assert.equal(readViewReply(cache, 'other-query', version, first).text, initial.text);
  assert.equal(readViewReply(cache, 'account', version, { fills: [], permission: 'denied' }).text, '{"fills":[],"permission":"denied"}');
  assert.throws(() => restoreView('x', [[0, 2]], 2), /区间/);
  assert.throws(() => restoreView('x', [[0, 1], [0, 1]], 1), /长度/);
  const large = { value: 'x'.repeat(MAX_VIEW_LENGTH) };
  assert.deepEqual(readViewReply(cache, 'account', version, large).headers, {});
  assert.equal(cache.get('account'), undefined);
});

test('展示资料的版本协商仅适用于列出的读取，执行盘口、在途单、预览与写入实时查询', () => {
  for (const path of ['/api/asset/positions', '/api/asset/fills', '/api/asset/cash-flows', '/api/oil/pnl', '/api/options/performance',
    '/api/monitor/hynix/quote', '/api/monitor/oil/exchanges/bybit/funding-history', '/api/transfer-pairs/oil/balances',
    '/api/adl/pairs/gold/incidents', '/api/logs/problems', '/api/ondo/rewards']) {
    assert.ok(isDisplayRead('GET', path), path);
    assert.equal(isDisplayRead('POST', path), false, path);
  }
  for (const path of ['/api/oil/market', '/api/hynix/market', '/api/state', '/api/ondo/rewards/book', '/api/jobs/1',
    '/api/crossex/market', '/api/options/preview', '/api/options/rfq', '/api/monitor/oil/exchanges/variational/session', '/api/read-token']) {
    assert.equal(isDisplayRead('GET', path), false, path);
  }
  for (const path of ['/api/monitor/perpetual/depth', '/api/monitor/perpetual/exit', '/api/confirm', '/api/crossex/confirm', '/api/monitor/perpetual/paper']) {
    assert.equal(isDisplayRead('POST', path), false, path);
  }
});

test('真实 HTTP 页面读取先核对鉴权与监控状态，按查询参数和 POST 请求体分别协商', async t => {
  const harness = createHarness();
  let reads = 0, bodyReads = 0, enabled = true, revision = 0;
  let reading: (() => void) | undefined, gate: Promise<void> | undefined;
  const server = createExecutorServer({ executor: harness.ex, accessToken: 'read-view-test-token', views: {
    logs: (_filter, before) => { reads++; return { before, items: records }; },
    monitor: { state: () => ({ markets: ['perpetual'], controls: { perpetual: { enabled, revision } } }), enabled: () => enabled, candles: () => null, quote: () => null,
      perpetual: () => ({ snapshot: () => ({}), summary: () => ({}), stream: () => {}, marketMetrics: async pairs => { bodyReads++; reading?.(); await gate; return { pairs, items: records }; } }) },
  } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); harness.dispose(); });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const login = await fetch(base + '/login?token=read-view-test-token', { redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const get = (query: string, known: string) => fetch(base + '/api/logs' + query, { headers: { cookie, [READ_CACHE]: known } });
  const full = await get('', '1'), known = full.headers.get(READ_VERSION)!;
  assert.deepEqual((await full.json() as { items: unknown }).items, records);
  const same = await get('', known);
  assert.equal(same.status, 204);
  assert.equal(await same.text(), '');
  assert.equal(same.headers.get('cache-control'), 'no-store');
  const page = await get('?before=123', known);
  assert.equal(page.headers.get(READ_BASE), null);
  assert.equal((await page.json() as { before: number }).before, 123);
  const oldClient = await fetch(base + '/api/logs', { headers: { cookie } });
  assert.equal(oldClient.headers.get(READ_VERSION), null);
  assert.deepEqual((await oldClient.json() as { items: unknown }).items, records);
  const denied = await fetch(base + '/api/logs', { headers: { [READ_CACHE]: known } });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get(READ_VERSION), null);
  assert.equal(reads, 4);
  const post = (pair: string, version: string) => fetch(base + '/api/monitor/perpetual/metrics', { method: 'POST',
    headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1', [READ_CACHE]: version }, body: JSON.stringify({ pair }) });
  const first = await post('BTC', '1'), metric = first.headers.get(READ_VERSION)!;
  assert.equal((await post('BTC', metric)).status, 204);
  const eth = await post('ETH', metric);
  assert.equal(eth.headers.get(READ_BASE), null);
  assert.deepEqual((await eth.json() as { pairs: unknown }).pairs, { pair: 'ETH' });
  enabled = false;
  assert.equal((await post('BTC', metric)).status, 423);
  assert.equal(bodyReads, 3);
  for (const reopen of [false, true]) {
    enabled = true; revision++;
    const started = new Promise<void>(resolve => { reading = resolve; });
    let release!: () => void;
    gate = new Promise<void>(resolve => { release = resolve; });
    const pending = post('BTC', metric);
    await started;
    enabled = false; revision++;
    if (reopen) { enabled = true; revision++; }
    release();
    const obsolete = await pending;
    assert.equal(obsolete.status, reopen ? 409 : 423);
    assert.equal(obsolete.headers.get(READ_VERSION), null);
  }
});

test('页面先核对私有结果，损坏增量只补读一次，权限变化使迟到的旧读取作废', async t => {
  const server = new ReadViewCache(), sent: string[] = [];
  const path = '/api/asset/fills?market=oil';
  let body: unknown = { generatedAt: 1, fills: records }, denied = 0, broken = false;
  let pause: Promise<void> | undefined;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    if (url !== path) return Response.json({ ok: true });
    const known = new Headers(init.headers).get(READ_CACHE)!;
    sent.push(known);
    if (denied) return Response.json({ code: 'forbidden' }, { status: denied });
    const answer = readViewReply(server, path, known, body);
    if (pause) { const gate = pause; pause = undefined; await gate; }
    return new Response(answer.status === 204 ? null : broken && answer.headers[READ_BASE] ? '[[-1,30]]' : answer.text,
      { status: answer.status, headers: answer.headers });
  });
  assert.deepEqual(await api(path), body);
  assert.deepEqual(await api(path), body);
  assert.equal(sent[0], '1');
  assert.ok(versionLength(sent[1]) > 0);
  body = { generatedAt: 2, fills: records.slice(1) };
  broken = true;
  assert.deepEqual(await api(path), body);
  assert.equal(sent.length, 4);
  assert.equal(sent[3], '1');
  let release!: () => void;
  pause = new Promise<void>(resolve => { release = resolve; });
  const late = api(path);
  denied = 403;
  await assert.rejects(api(path), (error: unknown) => error instanceof ApiError && error.status === 403);
  release();
  await assert.rejects(late, /重新读取/);
  denied = 0;
  body = { generatedAt: 3, fills: [] };
  assert.deepEqual(await api(path), body);
  assert.equal(sent.at(-1), '1');
  await api('/api/asset/sync', { body: {} });
  assert.deepEqual(await api(path), body);
  assert.ok(versionLength(sent.at(-1)!) > 0, '例行估值同步后继续复用成交基准');
  await api('/api/asset/connections/delete', { body: {} });
  assert.deepEqual(await api(path), body);
  assert.equal(sent.at(-1), '1', '更换账户范围清除私有基准');
});

test('相同长度的错误金额和不匹配的完整版本都不会进入缓存，普通 HTTP 也核对摘要', async t => {
  // WebCrypto is unavailable on plain HTTP at a LAN address.
  const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(globalThis, 'crypto', crypto));
  const path = '/api/options/performance', server = new ReadViewCache();
  const sent: string[] = [];
  let amount = '10', corruptFull = false;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const known = new Headers(init.headers).get(READ_CACHE)!;
    sent.push(known);
    const answer = readViewReply(server, path, known, { amount, items: records });
    const text = answer.headers[READ_BASE] ? JSON.stringify(JSON.parse(answer.text).map((part: unknown) => typeof part === 'string' ? part.replace('2', '9') : part))
      : corruptFull ? answer.text.replace('"20"', '"90"') : answer.text;
    return new Response(answer.status === 204 ? null : text, { status: answer.status, headers: answer.headers });
  });
  assert.equal((await api<{ amount: string }>(path)).amount, '10');
  amount = '20';
  assert.equal((await api<{ amount: string }>(path)).amount, '20');
  assert.equal(sent.length, 3, '增量合法但内容不匹配时完整重读');
  assert.equal(sent.at(-1), '1');
  assert.equal((await api<{ amount: string }>(path)).amount, '20');
  const otherPage = path + '?currency=USD';
  corruptFull = true;
  const before = sent.length;
  await assert.rejects(api(otherPage), /响应无法解析/);
  assert.deepEqual(sent.slice(before), ['1', '1'], '损坏的完整应答仅重试一次');
  corruptFull = false;
  assert.equal((await api<{ amount: string }>(otherPage)).amount, '20');
  assert.equal(sent.at(-1), '1');
});

test('首次进入资产页可在慢同步完成前读取保存的账本与历史', async t => {
  let finish!: () => void, release!: () => void;
  const sync = new Promise<void>(resolve => { finish = resolve; });
  const saved = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url === '/api/asset/sync') { await sync; return Response.json({ ok: true }); }
    await saved; return Response.json({ source: url });
  });
  const ledger = api('/api/asset/ledger'), history = api('/api/asset/history');
  const background = api('/api/asset/sync', { body: {} });
  try {
    release();
    assert.deepEqual(await Promise.all([ledger, history]), [{ source: '/api/asset/ledger' }, { source: '/api/asset/history' }]);
  } finally { finish(); await background; }
});

function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => { open = resolve; });
  return { wait, open };
}

test('估值同步完成或切页取消时，受影响的展示读在原时限内重新核对，行情读继续', async t => {
  for (const cancelled of [false, true]) await t.test(cancelled ? '切出资产页' : '同步完成', async t => {
    const reads = ['/api/asset/positions', '/api/asset/fills?market=hynix', '/api/asset/ledger', '/api/monitor/hynix/quote'];
    const oldReads = gate(), finishSync = gate();
    const signals = new Map<string, AbortSignal[]>();
    t.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
      if (path === '/api/asset/sync') { await finishSync.wait; init.signal!.throwIfAborted(); return Response.json({}); }
      const attempts = signals.get(path) ?? [];
      signals.set(path, attempts);
      attempts.push(init.signal!);
      const observed = attempts.length;
      if (observed === 1) await oldReads.wait;
      return Response.json({ observed });
    });
    const controller = new AbortController();
    const sync = api('/api/asset/sync', { body: {}, signal: controller.signal });
    const results = reads.map(path => api<{ observed: number }>(path));
    if (cancelled) controller.abort();
    finishSync.open();
    if (cancelled) await assert.rejects(sync, { name: 'AbortError' });
    else await sync;
    oldReads.open();
    assert.deepEqual((await Promise.all(results)).map(view => view.observed), [2, 2, 2, 1]);
    for (const path of reads.slice(0, 3)) {
      const attempts = signals.get(path)!;
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0], attempts[1]);
    }
  });
});

test('补读再次遇到写入时有界退出，拒绝访问、换账户或页面中止时不重放迟到应答', async t => {
  const path = '/api/asset/positions';
  for (const event of ['write', 'denied', 'account', 'abort'] as const) await t.test(event, async t => {
    const oldRead = gate(), retryStarted = gate(), finishRetry = gate();
    const controller = new AbortController();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url !== path) return Response.json({});
      reads++;
      if (reads === 1) { await oldRead.wait; return Response.json({ owner: 'previous' }); }
      retryStarted.open();
      await finishRetry.wait;
      return event === 'denied' ? Response.json({ code: 'forbidden' }, { status: 403 }) : Response.json({ owner: 'current' });
    });
    const result = api(path, { signal: controller.signal });
    await api('/api/asset/sync', { body: {} });
    oldRead.open();
    await Promise.race([retryStarted.wait, result.then(() => assert.fail('过时应答应触发补读'))]);
    if (event === 'write') await api('/api/asset/sync', { body: {} });
    if (event === 'account') await api('/api/asset/connections/delete', { body: {} });
    if (event === 'abort') controller.abort();
    finishRetry.open();
    if (event === 'denied') await assert.rejects(result, (error: unknown) => error instanceof ApiError && error.status === 403);
    else if (event === 'abort') await assert.rejects(result, { name: 'AbortError' });
    else await assert.rejects(result, event === 'write' ? /持续更新/ : /重新读取/);
    assert.equal(reads, 2);
  });
});

test('旧正文解码时发生写入，补读得到服务端新值；随后换账户直接撤销待补读', async t => {
  for (const changeAccount of [false, true]) await t.test(changeAccount ? '更换账户' : '保持账户', async t => {
    const decoding = gate(), finishBody = gate();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (path: string) => {
      if (path !== '/api/asset/history') return Response.json({});
      if (++reads > 1) return Response.json({ amount: 2 });
      const response = Response.json({ amount: 1 });
      t.mock.method(response, 'text', async () => { decoding.open(); await finishBody.wait; return '{"amount":1}'; });
      return response;
    });
    const result = api('/api/asset/history');
    await decoding.wait;
    await api('/api/asset/sync', { body: {} });
    if (changeAccount) await api('/api/asset/connections/delete', { body: {} });
    finishBody.open();
    if (changeAccount) await assert.rejects(result, /重新读取/);
    else assert.deepEqual(await result, { amount: 2 });
    assert.equal(reads, changeAccount ? 1 : 2);
  });
});

test('同范围写入之后迟到的短时失败可重读，拒权或范围变更直接交付服务端状态', async t => {
  for (const status of [503, 401, 403, 404, 409, 423]) await t.test(String(status), async t => {
    const oldRead = gate();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (path: string) => {
      if (path !== '/api/asset/positions') return Response.json({});
      if (++reads > 1) return Response.json({ fresh: true });
      await oldRead.wait;
      return Response.json({ message: '上一轮应答' }, { status });
    });
    const result = api('/api/asset/positions');
    await api('/api/asset/sync', { body: {} });
    oldRead.open();
    if (status === 503) assert.deepEqual(await result, { fresh: true });
    else await assert.rejects(result, (error: unknown) => error instanceof ApiError && error.status === status);
    assert.equal(reads, status === 503 ? 2 : 1);
  });
});

test('原表预览允许账本历史继续读取，确认导入撤销旧账本的应答', async t => {
  const path = '/api/asset/history';
  for (const apply of [false, true]) await t.test(apply ? '确认导入' : '只读预览', async t => {
    const oldRead = gate();
    let reads = 0;
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url !== path) return Response.json({ preview: !apply });
      reads++; await oldRead.wait;
      return Response.json({ owner: 'old' });
    });
    const read = api(path);
    await api('/api/asset/import', { body: { source: {}, apply } });
    oldRead.open();
    if (apply) await assert.rejects(read, /重新读取/);
    else assert.deepEqual(await read, { owner: 'old' });
    assert.equal(reads, 1);
  });
});

test('一次性原表预览的坏正文和超时提示重选文件，确认导入超时保留结果未知', async t => {
  const path = '/api/asset/import';
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response(''));
  await assert.rejects(api(path, { body: { apply: false } }), /重新选择文件/);
  mock.mock.mockImplementation((_url: unknown, init: RequestInit = {}) => new Promise<Response>((_, reject) => {
    const signal = init.signal;
    assert.ok(signal);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(api(path, { body: { apply: false }, timeoutMs: 5 }), /预览超时，请重新选择文件/);
  await assert.rejects(api(path, { body: { apply: true }, timeoutMs: 5 }), /结果未知/);
});
