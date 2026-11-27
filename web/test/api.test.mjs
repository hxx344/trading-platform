import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('api：只读预览与反查 POST 路由超时不误报实盘未知，空响应体与 null JSON 直接报读错', async () => {
  const queryPaths = [
    '/api/preview',
    '/api/four-leg/preview',
    '/api/options/plans',
    '/api/crossex/preview',
    '/api/crossex/open-capacity',
    '/api/read-token/lookup',
    '/api/varlighter/backtest',
    '/api/monitor/perpetual/price-history',
    '/api/monitor/perpetual/depth',
    '/api/monitor/perpetual/exit',
  ];

  for (const path of queryPaths) {
    await withFetch((_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }), async () => {
      await assert.rejects(
        api(path, { body: { sample: true }, timeoutMs: 5 }),
        error => !(error instanceof ApiError) && error.name === 'TimeoutError' && /数据读取超时/.test(error.message),
        path,
      );
    });

    await withFetch(async () => new Response('', { status: 200 }), async () => {
      await assert.rejects(
        api(path, { body: { sample: true } }),
        error => !(error instanceof ApiError) && /响应无法解析/.test(error.message),
        path,
      );
    });

    await withFetch(async () => new Response('null', { status: 200 }), async () => {
      await assert.rejects(
        api(path, { body: { sample: true } }),
        error => !(error instanceof ApiError) && /响应无法解析/.test(error.message),
        `${path} null`,
      );
    });
  }
});

test('api：/api/asset/import 按 apply=false 区分只读预览与写入语义，写入 JSON null 不静默返空对象', async () => {
  await withFetch((_input, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }), async () => {
    await assert.rejects(
      api('/api/asset/import', { body: { apply: false, rows: [] }, timeoutMs: 5 }),
      error => !(error instanceof ApiError) && /原表预览超时/.test(error.message),
    );
    await assert.rejects(
      api('/api/asset/import', { body: { apply: true, rows: [] }, timeoutMs: 5 }),
      error => !(error instanceof ApiError) && /请求超时，结果未知/.test(error.message),
    );
  });

  await withFetch(async () => new Response('', { status: 200 }), async () => {
    await assert.rejects(
      api('/api/asset/import', { body: { apply: false, rows: [] } }),
      error => !(error instanceof ApiError) && /未收到预览结果/.test(error.message),
    );
  });

  await withFetch(async () => new Response('null', { status: 200 }), async () => {
    await assert.rejects(
      api('/api/confirm', { body: { previewId: 'p1' } }),
      error => !(error instanceof ApiError) && /响应无法解析，结果未知/.test(error.message),
    );
  });

  for (const status of [401, 409]) {
    await withFetch(async () => new Response(JSON.stringify({ code: `err_${status}`, message: `拒绝 ${status}`, extra: 1 }), { status }), async () => {
      await assert.rejects(
        api('/api/confirm', { body: { previewId: 'p1' } }),
        error => error instanceof ApiError && error.status === status && error.code === `err_${status}` && error.body?.extra === 1,
      );
    });
  }
});

test('api：写入接口仅 204 或 content-length 0 返回空对象，截断 HTTP 200 抛无 status 的未知错误', async () => {
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    assert.deepEqual(await api('/api/confirm', { body: { previewId: 'p1' } }), {});
    assert.deepEqual(await api('/api/crossex/settings', { body: { x: 1 }, method: 'PUT' }), {});
  });

  await withFetch(async () => new Response('', { status: 200, headers: { 'content-length': '0' } }), async () => {
    assert.deepEqual(await api('/api/confirm', { body: { previewId: 'p1' } }), {});
  });

  await withFetch(async () => new Response('{truncated', { status: 200 }), async () => {
    await assert.rejects(
      api('/api/confirm', { body: { previewId: 'p1' } }),
      error => !(error instanceof ApiError) && error.status === undefined && /结果未知/.test(error.message),
    );
  });

  await withFetch(async () => new Response('', { status: 200 }), async () => {
    await assert.rejects(
      api('/api/oil/rules', { body: { name: 'r1' } }),
      error => !(error instanceof ApiError) && error.status === undefined && /结果未知/.test(error.message),
    );
  });
});
