import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get, type IncomingMessage, type RequestListener } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { constants, createGunzip, createGzip, type Gzip } from 'node:zlib';
import { createControl } from '../src/control/main.ts';
import { UUID } from '../src/contracts.ts';
import { EXECUTION_HEADER, readJson, sendJson } from '../src/http-public.ts';
import { api, ApiError } from '../web/src/api.ts';
import { RequestIds } from '../web/src/request-ids.ts';

// Real public control listener, private HTTP socket and browser client. The private peer supplies faults the live
// executor cannot be asked to generate (committing a command and losing the connection before its first header).
async function listener(t: TestContext, upstream: RequestListener) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-transport-'));
  mkdirSync(join(dir, 'web', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'web', 'dist', 'index.html'), '<title>控制面</title>');
  writeFileSync(join(dir, 'VERSION'), 'v0.64.0 0123456789ab\n');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\tp-transport-${randomUUID()}` : join(dir, 'execution.sock');
  const engine = createServer(upstream), control = createControl({ current: dir, socketPath });
  t.after(async () => {
    control.close();
    engine.closeAllConnections();
    await Promise.all([control.server, engine].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.all([once(engine.listen(socketPath), 'listening'), once(control.server.listen(0, '127.0.0.1'), 'listening')]);
  const port = (control.server.address() as AddressInfo).port;
  return { dir, port, base: `http://127.0.0.1:${port}` };
}

for (const [method, path] of [['POST', '/api/confirm'], ['PUT', '/api/crossex/settings']] as const) {
  test(`控制面 ${method} 已落盘但缺少响应头时，页面沿用原编号核对，业务拒绝保留 HTTP 状态`, async t => {
    const arrivals: string[] = [];
    let mode: 'disconnect' | 'mismatch' | 'respond' | 'refuse' | 'busy' = 'disconnect';
    const { dir, base } = await listener(t, async (request, response) => {
      if (request.method === 'GET') { response.destroy(); return; }
      assert.equal(request.method, method);
      assert.equal(request.url, path);
      assert.equal(request.headers['x-pa-executor'], '1');
      const { requestId } = await readJson(request) as { requestId: string };
      if (typeof requestId !== 'string' || !UUID.test(requestId)) { sendJson(response, 400, { code: 'request_id' }); return; }
      arrivals.push(requestId);
      if (mode === 'mismatch') {
        sendJson(response, 503, { code: 'execution_version', message: '执行器版本不匹配' }, { [EXECUTION_HEADER]: 'f'.repeat(64) });
        return;
      }
      if (mode === 'refuse') {
        sendJson(response, 409, { code: 'preview_invalid', message: '预览已失效' }, { [EXECUTION_HEADER]: 'development' });
        return;
      }
      if (mode === 'busy') {
        sendJson(response, 503, { code: 'venue_unavailable', message: '场所暂不可用' }, { [EXECUTION_HEADER]: 'development' });
        return;
      }
      const saved = join(dir, `${requestId}.json`), duplicate = existsSync(saved);
      if (!duplicate) writeFileSync(saved, JSON.stringify({ job: randomUUID() }), { flag: 'wx', flush: true });
      if (mode === 'disconnect') { response.destroy(); return; }
      sendJson(response, 200, { ...JSON.parse(readFileSync(saved, 'utf8')), duplicate });
    });
    const ids = new RequestIds();
    const run = () => ids.run(path, 'same-input', requestId => api<{ job: string; duplicate: boolean }>(base + path, { method, body: { requestId } }));
    const unknown = (error: unknown) => error instanceof Error && !('status' in error);
    const firstId = ids.idFor(path, 'same-input');
    await assert.rejects(run, unknown);
    assert.deepEqual(arrivals, [firstId], '控制面没有自行重放写入');
    const first = JSON.parse(readFileSync(join(dir, `${firstId}.json`), 'utf8')) as { job: string };
    assert.equal(ids.idFor(path, 'same-input'), firstId);
    mode = 'mismatch';
    await assert.rejects(run, unknown);
    assert.equal(ids.idFor(path, 'same-input'), firstId);
    mode = 'respond';
    assert.deepEqual(await run(), { job: first.job, duplicate: true });
    assert.deepEqual(arrivals, [firstId, firstId, firstId]);

    mode = 'refuse';
    const secondId = ids.idFor(path, 'same-input');
    assert.notEqual(secondId, firstId);
    await assert.rejects(run, (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'preview_invalid' && error.message === '预览已失效');
    assert.deepEqual(arrivals, [firstId, firstId, firstId, secondId]);
    assert.notEqual(ids.idFor(path, 'same-input'), secondId, '明确应答结束这次请求');
    assert.equal(existsSync(join(dir, `${secondId}.json`)), false);
    mode = 'busy';
    await assert.rejects(run, (error: unknown) => error instanceof ApiError && error.status === 503 && error.code === 'venue_unavailable');
    await assert.rejects(api(base + '/api/state'), (error: unknown) => error instanceof ApiError && error.status === 503);
  });
}

test('控制面即时转发 gzip SSE 首帧和后续帧，浏览器断开会释放上游订阅', { timeout: 10_000 }, async t => {
  let output!: Gzip, release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const { base } = await listener(t, (request, response) => {
    assert.equal(request.url, '/api/monitor/perpetual/stream');
    assert.equal(request.headers['accept-encoding'], 'gzip');
    assert.equal(request.headers['last-event-id'], '40');
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'cache-control': 'no-store, no-transform' });
    output = createGzip({ level: 1, flush: constants.Z_SYNC_FLUSH });
    output.pipe(response);
    response.once('close', () => { output.destroy(); release(); });
    output.write('id: 41\ndata: first\n\n');
  });
  const client = get(base + '/api/monitor/perpetual/stream', { agent: false, headers: { 'accept-encoding': 'gzip', 'last-event-id': '40' } });
  t.after(() => client.destroy());
  const [response] = await once(client, 'response') as [IncomingMessage];
  assert.deepEqual([response.statusCode, response.headers['content-type'], response.headers['content-encoding']], [200, 'text/event-stream', 'gzip']);
  const decoded = response.pipe(createGunzip()), lines = createInterface({ input: decoded })[Symbol.asyncIterator]();
  const frame = async () => [(await lines.next()).value, (await lines.next()).value, (await lines.next()).value];
  assert.deepEqual(await frame(), ['id: 41', 'data: first', '']);
  output.write('id: 42\ndata: second\n\n');
  assert.deepEqual(await frame(), ['id: 42', 'data: second', '']);
  client.destroy();
  await closed;
  decoded.destroy();
});

test('HTTP/1.0 没有 Host 的请求通过控制面时仍返回 421', async t => {
  const { port } = await listener(t, (request, response) => {
    sendJson(response, request.headers.host ? 200 : 421, {});
  });
  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET /api/state HTTP/1.0\r\n\r\n');
  const chunks: Buffer[] = [];
  for await (const chunk of socket) chunks.push(chunk as Buffer);
  assert.match(Buffer.concat(chunks).toString('utf8'), /^HTTP\/1\.[01] 421 /);
});
