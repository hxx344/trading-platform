import test from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../src/api.ts';

function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original; });
}

test('api：只读预览与反查 POST 路由超时不误报实盘未知，空响应体直接报读错', async () => {
  const queryPaths = [
    '/api/preview',
    '/api/four-leg/preview',
    '/api/options/plans',
    '/api/crossex/preview',
    '/api/read-token/lookup',
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
  }
});

test('api：写入接口仅 204 或 content-length 0 返回空对象，截断 HTTP 200 抛无 status 的未知错误', async () => {
  await withFetch(async () => new Response(null, { status: 204 }), async () => {
    assert.deepEqual(await api('/api/confirm', { body: { previewId: 'p1' } }), {});
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
