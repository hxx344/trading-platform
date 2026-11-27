import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get, request as httpRequest, type IncomingMessage, type RequestListener } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { constants, createGunzip, createGzip, type Gzip } from 'node:zlib';
import { createControl } from '../src/control/main.ts';
import { ContractError, UUID } from '../src/contracts.ts';
import { CONTROL_HEADER, EXECUTION_HEADER, readJson, sendJson } from '../src/http-public.ts';
import { api, ApiError } from '../web/src/api.ts';
import { RequestIds } from '../web/src/request-ids.ts';

// Real public control listener, private HTTP socket and browser client. The private peer supplies faults the live
// executor cannot be asked to generate (committing a command and losing the connection before its first header).
async function listener(t: TestContext, upstream: RequestListener, upstreamLimit?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tp-transport-'));
  mkdirSync(join(dir, 'web', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'web', 'dist', 'index.html'), '<title>控制面</title>');
  writeFileSync(join(dir, 'VERSION'), 'v0.64.0 0123456789ab\n');
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\tp-transport-${randomUUID()}` : join(dir, 'execution.sock');
  const engine = createServer(upstream), control = createControl({ current: dir, socketPath, upstreamLimit });
  t.after(async () => {
    control.close();
    engine.closeAllConnections();
    await Promise.all([control.server, engine].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.all([once(engine.listen(socketPath), 'listening'), once(control.server.listen(0, '127.0.0.1'), 'listening')]);
  const port = (control.server.address() as AddressInfo).port;
  return { dir, port, base: `http://127.0.0.1:${port}`, server: control.server };
}

test('控制面没有上游容量时，查询可重试且交易写入保留原请求号', async t => {
  const { base } = await listener(t, () => assert.fail('容量不足时不能转发'), 0);
  assert.equal((await fetch(base + '/api/state')).status, 503);
  const ids = new RequestIds(), key = '/api/jobs/start', input = 'same';
  const before = ids.idFor(key, input);
  await assert.rejects(ids.run(key, input, requestId => api(base + key, {body: {requestId}})),
    error => error instanceof Error && !('status' in error));
  assert.equal(ids.idFor(key, input), before);
});

test('定长写入的最后一段正文先到时，执行器等控制面结束请求后只处理一次', { timeout: 10_000 }, async t => {
  const body = JSON.stringify({ requestId: randomUUID() });
  let sawBody!: (message: IncomingMessage) => void, finish!: () => void;
  const bodyReceived = new Promise<IncomingMessage>(resolve => { sawBody = resolve; });
  const canFinish = new Promise<void>(resolve => { finish = resolve; });
  let commands = 0;
  const { base, server } = await listener(t, (request, response) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received === Buffer.byteLength(body)) sawBody(request);
    });
    request.on('end', () => { commands++; sendJson(response, 200, JSON.parse(Buffer.concat(chunks).toString('utf8'))); });
  });
  // Drive the observed ordering without relying on Linux scheduling: deliver every body byte now, then release end.
  server.prependOnceListener('request', request => {
    const emit = request.emit.bind(request);
    request.emit = (event: string | symbol, ...args: unknown[]) => {
      if (event !== 'end') return emit(event, ...args);
      void canFinish.then(() => emit('end'));
      return true;
    };
  });
  const [response] = await Promise.all([
    fetch(base + '/api/confirm', { method: 'POST', headers: { 'content-length': String(Buffer.byteLength(body)) }, body }),
    bodyReceived.then(async request => {
      try {
        await nextTurn();
        assert.equal(request.complete, false, '私有请求的结束须与控制面的写入结束一致');
        assert.equal(commands, 0);
      } finally { finish(); }
    }),
  ]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), JSON.parse(body));
  assert.equal(commands, 1);
});

test('控制面按登录表单上限收齐正文，超限表单不会交给执行面', async t => {
  const received: string[] = [];
  const { base, server } = await listener(t, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString());
    response.writeHead(204).end();
  });
  assert.equal(server.headersTimeout, 10_000);
  assert.equal(server.requestTimeout, 30_000);
  const form = (body: string) => fetch(base + '/login', { method: 'POST', body });
  assert.equal((await form('password=demo')).status, 204);
  assert.equal((await form('a'.repeat(4_097))).status, 413);
  assert.deepEqual(received, ['password=demo']);
});

test('转发保留空正文和分块 JSON，执行器仍能明确拒绝非法或超限正文', async t => {
  const { base } = await listener(t, async (request, response) => {
    try { sendJson(response, 200, await readJson(request, 32)); }
    catch (error) {
      assert.ok(error instanceof ContractError);
      sendJson(response, error.status, { code: error.code }, error.status === 413 ? { connection: 'close' } : {});
    }
  });
  const url = base + '/api/confirm';
  const empty = await fetch(url, { method: 'POST', body: '' });
  assert.deepEqual([empty.status, await empty.json()], [200, null]);
  const chunked = httpRequest(url, { method: 'POST', agent: false });
  const received = once(chunked, 'response') as Promise<[IncomingMessage]>;
  chunked.write('{"value":');
  chunked.end('7}');
  const [response] = await received;
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  assert.deepEqual([response.statusCode, JSON.parse(Buffer.concat(chunks).toString())], [200, { value: 7 }]);
  for (const [body, status, code] of [['{', 400, 'invalid_json'], ['x'.repeat(40), 413, 'body_too_large']] as const) {
    const rejected = await fetch(url, { method: 'POST', body });
    assert.deepEqual([rejected.status, await rejected.json()], [status, { code }]);
  }
});

test('控制面把展示数据版本原样交给执行器，并保留其无正文的确认', async t => {
  const version = 'v1-' + 'a'.repeat(32) + '.3';
  const { base } = await listener(t, (request, response) => {
    assert.equal(request.headers['x-pa-read-cache'], version);
    response.writeHead(204, { 'x-pa-read-version': version, 'cache-control': 'no-store' });
    response.end();
  });
  const checked = await fetch(base + '/api/asset/positions', { headers: { 'x-pa-read-cache': version } });
  assert.equal(checked.status, 204);
  assert.equal(checked.headers.get('x-pa-read-version'), version);
  assert.equal(await checked.text(), '');
});

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

test('控制面把只读令牌的 Authorization 头原样转给执行面；执行面不可达时返回 503 且不带内部细节', async t => {
  const seen: (string | undefined)[] = [];
  const { base, dir } = await listener(t, (request, response) => {
    seen.push(request.headers.authorization);
    sendJson(response, 200, { ok: true });
  });
  const token = `tpr_${'A'.repeat(43)}`;
  assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.deepEqual(seen, [`Bearer ${token}`]);
  const down = createControl({ current: dir, socketPath: join(dir, 'missing.sock') });
  t.after(() => { down.close(); down.server.close(); });
  await once(down.server.listen(0, '127.0.0.1'), 'listening');
  const response = await fetch(`http://127.0.0.1:${(down.server.address() as AddressInfo).port}/api/status`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.doesNotMatch(body, /missing\.sock|ENOENT|tpr_/);
});

test('拆分部署：执行面校验令牌后交回的 /api/update，控制面对令牌只答投影，会话照旧得到完整状态', async t => {
  const { base } = await listener(t, (request, response) => {
    request.resume();
    response.writeHead(204, { [CONTROL_HEADER]: '1' });
    response.end();
  });
  const full = await (await fetch(`${base}/api/update`)).json() as Record<string, unknown>;
  assert.ok('manualAt' in full && 'error' in full, '没有令牌时是完整状态');
  const masked = await (await fetch(`${base}/api/update`, { headers: { authorization: `Bearer tpr_${'A'.repeat(43)}` } })).json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(masked).sort(), ['available', 'checkFailed', 'checkedAt', 'checking', 'current', 'enabled', 'job', 'latest', 'pending']);
});

