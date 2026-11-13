// The built page: what the loader accepts and refuses, how the server hands it out, and the page's request-id rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createExecutorServer } from '../src/http.ts';
import { UUID } from '../src/contracts.ts';
import { WEB_DIST, checkIndexHtml, loadWebApp } from '../src/web-assets.ts';
import { RequestIds, newRequestId } from '../web/src/request-ids.ts';
import { ApiError, api } from '../web/src/api.ts';
import { bindAccounts, createHarness } from './harness.ts';

const INDEX = '<!doctype html><title>t</title><script type="module" crossorigin src="/assets/index-a1.js"></script><link rel="stylesheet" crossorigin href="/assets/index-b2.css">';

function fixture(edit?: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'tp-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets', 'index-a1.js'), 'console.info(1);');
  writeFileSync(join(dir, 'assets', 'index-b2.css'), 'body{margin:0}');
  edit?.(dir);
  return dir;
}
function refused(edit: (dir: string) => void, pattern: RegExp): void {
  const dir = fixture(edit);
  try { assert.throws(() => loadWebApp(dir), pattern); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('页面文件：加载构建产物，按扩展名给出类型', () => {
  const dir = fixture();
  try {
    const app = loadWebApp(dir);
    assert.equal(app.index.toString('utf8'), INDEX);
    assert.deepEqual([...app.assets].map(([name, asset]) => [name, asset.type]), [['index-a1.js', 'text/javascript; charset=utf-8'], ['index-b2.css', 'text/css; charset=utf-8']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('页面文件：缺失、内联脚本或样式、引用缺失、非普通文件与未知类型都拒绝', () => {
  refused(dir => rmSync(join(dir, 'index.html')), /页面文件缺失：index\.html（先运行 pnpm build:web）/);
  refused(dir => writeFileSync(join(dir, 'index.html'), `${INDEX}<script>alert(1)</script>`), /内联脚本/);
  refused(dir => writeFileSync(join(dir, 'index.html'), `${INDEX}<style>body{}</style>`), /内联样式/);
  refused(dir => writeFileSync(join(dir, 'index.html'), `${INDEX}<div style="color:red"></div>`), /内联样式属性或事件处理/);
  refused(dir => writeFileSync(join(dir, 'index.html'), `${INDEX}<img src="x" onerror="alert(1)">`), /内联样式属性或事件处理/);
  refused(dir => rmSync(join(dir, 'assets', 'index-b2.css')), /页面引用的文件缺失：assets\/index-b2\.css/);
  refused(dir => symlinkSync(join(dir, 'index.html'), join(dir, 'assets', 'link.js')), /不是普通文件：assets\/link\.js/);
  refused(dir => mkdirSync(join(dir, 'assets', 'nested.js')), /不是普通文件：assets\/nested\.js/);
  refused(dir => writeFileSync(join(dir, 'assets', 'page.html'), ''), /名或类型不受支持：assets\/page\.html/);
  refused(dir => writeFileSync(join(dir, 'assets', 'js'), ''), /名或类型不受支持：assets\/js/);
  refused(dir => writeFileSync(join(dir, 'assets', 'x.constructor'), ''), /名或类型不受支持：assets\/x\.constructor/);
  refused(dir => { rmSync(join(dir, 'index.html')); symlinkSync(join(dir, 'assets', 'index-a1.js'), join(dir, 'index.html')); }, /不是普通文件：index\.html/);
});

test('页面文件：仓库里的构建产物能通过同一检查', { skip: existsSync(join(WEB_DIST, 'index.html')) ? false : '未构建（pnpm build:web）' }, () => {
  const app = loadWebApp();
  assert.ok(app.assets.size >= 2, '至少一个脚本和一个样式');
  assert.doesNotThrow(() => checkIndexHtml(app.index.toString('utf8')));
});

test('HTTP：构建出的页面与 /assets 须登录，页面 CSP 不放行内联脚本和样式', async () => {
  const dir = fixture();
  const h = createHarness();
  bindAccounts(h.ex);
  const server = createExecutorServer({ executor: h.ex, accessToken: 'web-access-token-0001', session: 'web-session-value-0001', app: loadWebApp(dir) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 401);
    const anonymous = await fetch(`${base}/assets/index-a1.js`);
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(await anonymous.text(), /console/);
    const login = await fetch(`${base}/login?token=web-access-token-0001`, { redirect: 'manual' });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.equal(page.status, 200);
    assert.equal(await page.text(), INDEX);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /style-src 'self';/);
    assert.match(csp, /base-uri 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');

    const script = await fetch(`${base}/assets/index-a1.js`, { headers: { cookie } });
    assert.equal(script.status, 200);
    assert.equal(await script.text(), 'console.info(1);');
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${base}/assets/missing.js`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/assets/%2e%2e%2findex.html`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/assets/x/index-a1.js`, { headers: { cookie } })).status, 404);
    assert.equal((await fetch(`${base}/assets/index-a1.js`, { method: 'POST', headers: { cookie } })).status, 404);
    // The JSON API is unchanged.
    assert.equal((await fetch(`${base}/api/state`, { headers: { cookie } })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    h.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('页面请求号：应答前重试沿用同一编号；有应答（含拒绝）或输入变化后换新编号；格式是服务端接受的 UUID', async () => {
  const ids = new Set(Array.from({ length: 200 }, () => newRequestId()));
  assert.equal(ids.size, 200);
  for (const id of ids) assert.match(id, UUID);

  const requests = new RequestIds();
  const first = requests.idFor('p1:1');
  assert.equal(requests.idFor('p1:1'), first, '没有应答时沿用');
  assert.notEqual(requests.idFor('p1:0'), first, '另一个动作另起编号');
  const config = requests.idFor('config:p1', '{"batchNotional":"100"}');
  assert.notEqual(requests.idFor('config:p1', '{"batchNotional":"200"}'), config, '输入变化另起编号');

  const seen: string[] = [];
  const lost = new Error('网络中断');
  await assert.rejects(requests.run('restart:x', '', async id => { seen.push(id); throw lost; }));
  await assert.rejects(requests.run('restart:x', '', async id => { seen.push(id); throw Object.assign(new Error('拒绝'), { status: 409 }); }));
  await requests.run('restart:x', '', async id => { seen.push(id); });
  await requests.run('restart:x', '', async id => { seen.push(id); });
  assert.equal(seen[0], seen[1], '结果未知（无状态码）后重试沿用同一编号');
  assert.notEqual(seen[2], seen[1], '收到拒绝后下一次是新请求');
  assert.notEqual(seen[3], seen[2], '成功后下一次是新请求');
});

test('页面请求号：传入 settles 时只有它认可的拒绝才换编号（原油确认：结果未知后 401/5xx/编号被占用都沿用原编号）', async () => {
  const requests = new RequestIds();
  const seen: string[] = [];
  const refused = (status: number, code?: string) => Object.assign(new Error('拒绝'), { status, code });
  const settles = (error: unknown) => { const { status, code } = error as { status?: number; code?: string }; return (status === 400 || status === 409) && code !== 'request_reused'; };
  for (const error of [new Error('网络中断'), refused(503), refused(401), refused(409, 'request_reused'), refused(409, 'preview_invalid')]) {
    await assert.rejects(requests.run('confirm', 'p1', async id => { seen.push(id); throw error; }, settles));
  }
  await requests.run('confirm', 'p1', async id => { seen.push(id); }, settles);
  assert.equal(new Set(seen.slice(0, 5)).size, 1, '确认流程自己的拒绝之前一直沿用同一编号');
  assert.notEqual(seen[5], seen[4], '确认流程拒绝后下一次是新请求');
});

test('页面请求层：网络错误、超时与读响应体时中断都不带状态码（结果未知）；拒绝带状态码；成功但响应体不可读仍算成功', async () => {
  const original = globalThis.fetch;
  const seen: { url: string; init: RequestInit }[] = [];
  const reply = (handler: (init: RequestInit) => Promise<Response>) => { globalThis.fetch = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return handler(init); }) as typeof fetch; };
  const hang = (init: RequestInit) => new Promise<never>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));
  const statusOf = (error: unknown) => (error as { status?: unknown }).status;
  try {
    reply(async () => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(api('/api/x', { body: {} }), (error: unknown) => statusOf(error) === undefined && /Failed to fetch/.test((error as Error).message));

    reply(hang);
    await assert.rejects(api('/api/x', { body: {}, timeoutMs: 20 }), (error: unknown) => statusOf(error) === undefined && /请求超时，结果未知/.test((error as Error).message));

    // Headers arrived, the body did not before the timeout.
    reply(async init => new Response(new ReadableStream({ start(controller) { init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason)); } }), { status: 200 }));
    await assert.rejects(api('/api/x', { body: {}, timeoutMs: 20 }), (error: unknown) => statusOf(error) === undefined);

    reply(async () => Response.json({ code: 'takeover_refused', message: '两侧持仓不对冲' }, { status: 409 }));
    await assert.rejects(api('/api/x', { body: {} }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'takeover_refused' && error.message === '两侧持仓不对冲');
    reply(async () => new Response('<html>bad gateway</html>', { status: 502 }));
    await assert.rejects(api('/api/x', { body: {} }), (error: unknown) => error instanceof ApiError && error.status === 502 && /HTTP 502/.test(error.message));

    reply(async () => new Response('not json', { status: 200 }));
    assert.deepEqual(await api('/api/x', { body: {} }), {}, '写入成功但响应体不可读仍算成功');
    await assert.rejects(api('/api/state'), (error: unknown) => statusOf(error) === undefined && /响应无法解析/.test((error as Error).message), '读取没有结果，按读取失败处理');
    reply(async () => Response.json({ ok: 1 }));
    assert.deepEqual(await api('/api/state'), { ok: 1 });
    const [write, read] = [seen.at(-3)!.init, seen.at(-1)!.init];
    assert.equal(write.method, 'POST');
    assert.equal((write.headers as Record<string, string>)['x-pa-executor'], '1');
    assert.equal(read.method, undefined);
  } finally { globalThis.fetch = original; }
});

test('页面地址：#/pair/<配对>、#/status 与 #/settings 分别打开详情、运行状态与设置；配对编号不合规或无法解码时不选配对；其他都回到总览', async () => {
  const { parseRoute, pairHref } = await import('../web/src/route-parse.ts');
  assert.deepEqual(parseRoute(''), { page: 'overview' });
  assert.deepEqual(parseRoute('#/'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/status'), { page: 'status' });
  assert.deepEqual(parseRoute('#/logs'), { page: 'logs' });
  assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
  assert.deepEqual(parseRoute('#/settings/x'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/oil'), { page: 'oil' });
  assert.deepEqual(parseRoute('#/oil/x'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/monitor'), { page: 'monitor' });
  assert.deepEqual(parseRoute('#/monitor/x'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/asset'), { page: 'asset' });
  assert.deepEqual(parseRoute('#/asset/x'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/options'), { page: 'options', tab: 'desk' });
  assert.deepEqual(parseRoute('#/options/positions'), { page: 'options', tab: 'positions' });
  assert.deepEqual(parseRoute('#/options/orders'), { page: 'options', tab: 'orders' });
  assert.deepEqual(parseRoute('#/options/performance'), { page: 'options', tab: 'performance' });
  assert.deepEqual(parseRoute('#/options/x'), { page: 'overview' });
  assert.deepEqual(parseRoute('#/pair'), { page: 'pair', pairId: null });
  assert.deepEqual(parseRoute(pairHref('p_1-a')), { page: 'pair', pairId: 'p_1-a' });
  assert.deepEqual(parseRoute('#/pair/%E0%A4%A'), { page: 'pair', pairId: null });
  assert.deepEqual(parseRoute('#/pair/a%2Fb'), { page: 'pair', pairId: null });
  assert.deepEqual(parseRoute(`#/pair/${'x'.repeat(65)}`), { page: 'pair', pairId: null });
  assert.deepEqual(parseRoute('#/other'), { page: 'overview' });
});

test('历史列表合并：滑出最新页的记录保留；加载过更早页后最新页与已显示的没有交集且后面还有记录时，从最新页重新开始', async () => {
  const { emptyHistory, mergeLive, mergeOlder } = await import('../web/src/history-merge.ts');
  type R = { id: string; v?: number };
  const ids = (view: { rows: Map<string, R> }) => [...view.rows.keys()].sort();
  let view = mergeLive(emptyHistory<R>(), { items: [{ id: 'e' }, { id: 'd' }], next: 'c1' });
  assert.equal(view.next, 'c1');
  view = mergeOlder(view, 'c1', { items: [{ id: 'c' }, { id: 'b' }], next: 'b1' });
  assert.deepEqual([ids(view), view.next, view.olderLoaded], [['b', 'c', 'd', 'e'], 'b1', true]);
  // One new row: d slides off the live page but stays; "load older" still continues from the older pages.
  view = mergeLive(view, { items: [{ id: 'f' }, { id: 'e', v: 2 }], next: 'e1' });
  assert.deepEqual([ids(view), view.next, view.rows.get('e')!.v], [['b', 'c', 'd', 'e', 'f'], 'b1', 2]);
  // A late older page, read from a cursor the list has left, is dropped.
  assert.equal(mergeOlder(view, 'c1', { items: [{ id: 'z' }], next: null }), view);
  // More than a page of new rows (after the page sat in the background): rows between were never read.
  view = mergeLive(view, { items: [{ id: 'j' }, { id: 'i' }], next: 'i1' });
  assert.deepEqual([ids(view), view.next, view.olderLoaded], [['i', 'j'], 'i1', false]);
  // The live page is the whole list: no gap is possible, nothing is dropped.
  const whole = mergeLive(view, { items: [{ id: 'k' }], next: null });
  assert.deepEqual(ids(whole), ['i', 'j', 'k']);
});

test('设置页划转表单：秒与毫秒互换，非法或超出范围的秒数在本地拦下（按秒提示），其余原样交服务端校验；改动项列出改前改后；默认值与服务端一致', async () => {
  const { TRANSFER_DEFAULTS, TRANSFER_FIELDS, defaultText, transferBody, transferChanges, transferDraft } = await import('../web/src/transfer-form.ts');
  const { DEFAULT_TRANSFER_CONFIG, TRANSFER_CONFIG_KEYS } = await import('../src/contracts.ts');
  assert.deepEqual(TRANSFER_DEFAULTS, DEFAULT_TRANSFER_CONFIG);
  assert.deepEqual(TRANSFER_FIELDS.map(field => field.key), [...TRANSFER_CONFIG_KEYS]);
  const config = { ...DEFAULT_TRANSFER_CONFIG, checkIntervalMs: 2_500 };
  const draft = transferDraft(config);
  assert.deepEqual([draft.cooldownMs, draft.checkIntervalMs, draft.threshold, defaultText('checkIntervalMs')], ['30', '2.5', '10', '5']);
  assert.deepEqual(transferBody(draft), { config });
  assert.deepEqual(transferBody({ ...draft, threshold: ' abc ', cooldownMs: '1.25' }), { config: { ...config, threshold: 'abc', cooldownMs: 1_250 } });
  for (const bad of ['', '-1', '1e3', '0.0001', '五']) assert.match((transferBody({ ...draft, checkIntervalMs: bad }) as { error: string }).error, /检查间隔须为秒数/, bad);
  // Out of range in seconds, a number too large to be exact in milliseconds included, is stopped here with second units.
  for (const bad of ['0', '0.999', '3600.001', '9'.repeat(16), '9'.repeat(400)]) assert.equal((transferBody({ ...draft, checkIntervalMs: bad }) as { error: string }).error, '检查间隔须在 1 至 3600 秒之间', bad);
  for (const bad of ['0.5', '86401']) assert.equal((transferBody({ ...draft, cooldownMs: bad }) as { error: string }).error, '划转冷却须在 1 至 86400 秒之间', bad);
  assert.deepEqual(transferBody({ ...draft, cooldownMs: '86400', checkIntervalMs: '3600' }), { config: { ...config, cooldownMs: 86_400_000, checkIntervalMs: 3_600_000 } });
  assert.deepEqual(transferChanges(config, { ...config, threshold: '20', checkIntervalMs: 10_000 }), ['差额门槛 10 → 20 USD1', '检查间隔 2.5 → 10 秒']);
  assert.deepEqual(transferChanges(config, config), []);
});
