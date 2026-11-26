// /api/fundingbook 路由（src/http.ts）接在真实服务入口上：登录与写请求校验、默认不启用、错误映射。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/fundingbook/model.ts';
import { parseServiceConfig } from '../src/service/config.ts';

test('/api/fundingbook：要登录，写请求要页面标记；默认不启用；参数、确认与轮次的错误各有状态码', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-fundingbook-http-'));
  t.after(() => { process.removeAllListeners('SIGINT'); process.removeAllListeners('SIGTERM'); rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise<number>(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); }); });
  const { startService } = await import('../src/service/main.ts');
  const app = { index: Buffer.from('<!doctype html><title>统一交易平台</title><script type="module" src="/assets/app-1.js"></script>'), assets: new Map([['app-1.js', { body: Buffer.from('void 0;'), type: 'text/javascript; charset=utf-8' }]]) };
  const outside: typeof fetch = async () => { throw new TypeError('fetch failed'); };
  const run = await startService({ config: parseServiceConfig({ secretsFile: '/etc/tp/secrets.json', pairs: [] }), secrets: { accounts: new Map(), feishu: null }, dir, port, fetchImpl: outside, app, mevOptions: { fetchImpl: outside } });
  try {
    let link = '';
    for (let i = 0; i < 200 && !link; i++) { try { link = readFileSync(join(dir, 'access-url'), 'utf8').trim().split('\n').at(-1)!; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
    const cookie = (await fetch(link, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]!;
    const base = `http://127.0.0.1:${port}`;
    const get = (route: string) => fetch(base + route, { headers: { cookie } });
    const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-pa-executor': '1' }, body: JSON.stringify(body) });
    const code = async (answer: Response) => [answer.status, ((await answer.json()) as { code?: string }).code];

    assert.equal((await fetch(`${base}/api/fundingbook/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/fundingbook/settings`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal(((await (await get('/api/shell')).json()) as { modules: { fundingbook: boolean } }).modules.fundingbook, true);

    const state = (await (await get('/api/fundingbook/state')).json()) as { settings: { enabled: boolean }; running: boolean; book: unknown; round: unknown };
    assert.deepEqual([state.settings.enabled, state.running, state.book, state.round], [false, false, null, null]);
    assert.deepEqual(await code(await post('/api/fundingbook/plan', {})), [409, 'disabled']);
    assert.deepEqual(await code(await post('/api/fundingbook/paper/reset', {})), [400, 'confirm_required']);
    assert.deepEqual(await code(await post('/api/fundingbook/settings', { ...DEFAULT_SETTINGS, safetySigma: 0 })), [400, 'invalid_settings']);
    assert.deepEqual(await code(await post('/api/fundingbook/settings', { ...DEFAULT_SETTINGS, apiKey: 'x' })), [400, 'invalid_settings']);
    for (const id of ['abc', '0', '', '1']) assert.deepEqual(await code(await get(`/api/fundingbook/round?id=${id}`)), [404, 'not_found']);
    assert.equal((await get('/api/fundingbook/unknown')).status, 404);

    const saved = await post('/api/fundingbook/settings', { ...DEFAULT_SETTINGS, safetySigma: 6 });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { settings: { safetySigma: number } }).settings.safetySigma, 6);
  } finally { await run.shutdown(); await run.done; }
});
