import assert from 'node:assert/strict';
import test from 'node:test';
import { createBitgetSnapshots } from '../src/chain-arb/bitget-streams.ts';

const at = 1_795_690_885_886, seq = 1_304_314_508_780_744_705n, signal = new AbortController().signal;
class Socket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  sends: string[] = [];
  close() { this.readyState = 3; }
  send(body: string) { this.sends.push(body); }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(body: object) { this.onmessage?.({ data: JSON.stringify(body).replace(/"(\d{18,20})"/g, '$1') }); }
}
function setup() {
  const sockets: Socket[] = [];
  const streams = createBitgetSnapshots(() => at, () => {
    const socket = new Socket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  return { sockets, streams };
}
function push(socket: Socket, symbol: string, topic: string, row: object, action = 'snapshot', instType = 'spot') {
  socket.emit({ arg: { symbol, topic, instType }, ts: at, data: [row], action });
}
const book = { b: [['10', '1']], maxDepth: '50', ts: at - 100, seq: String(seq), pseq: '0' };
const tick = { lastPrice: '10' };

test('Bitget 并行币对共用连接，晚到帧与前一轮盘口不能填充新复核', async () => {
  const { sockets, streams } = setup();
  try {
    const a = streams.read('AAAUSDT', ['spot'], signal), b = streams.read('BBBUSDT', ['spot'], signal);
    assert.equal(sockets.length, 1);
    const first = sockets[0];
    first.open();
    assert.equal(JSON.parse(first.sends[0]).args.length, 4);
    for (const symbol of ['AAAUSDT', 'BBBUSDT']) {
      push(first, symbol, 'books', book);
      push(first, symbol, 'books', { ts: at, pseq: String(seq - 1n), seq: String(seq + 1n), b: [['90', '90']] }, 'update');
      push(first, symbol, 'ticker', tick);
    }
    const value = { at, bids: [['90', '90'], ['10', '1']], reference: '10' };
    for (const result of await Promise.all([a, b])) assert.deepEqual(result.get('spot'), value);
    const again = streams.read('AAAUSDT', ['spot'], signal);
    assert.equal(sockets.length, 2);
    push(first, 'AAAUSDT', 'books', book);
    const next = sockets[1];
    next.open();
    push(next, 'AAAUSDT', 'ticker', tick);
    next.onclose?.();
    assert.ok((await again).get('spot') instanceof Error);
  } finally { streams.close(); }
});

test('等待永续期间持续应用现货替换、撤单与新增买盘，按绝对数量和十进制价格合并', async () => {
  const { streams, sockets } = setup();
  try {
    const reading = streams.read('AAAUSDT', ['spot', 'perp'], signal), socket = sockets[0];
    socket.open();
    push(socket, 'AAAUSDT', 'books', { ...book, b: [['1e1', '2e0'], ['9.50', '9']] });
    push(socket, 'AAAUSDT', 'ticker', tick);
    push(socket, 'AAAUSDT', 'books', { ts: at - 2, seq: String(seq + 1n), pseq: String(seq),
      b: [['1.0e1', '0e-8'], ['9.5', '3'], ['9.500000000000000001', '1.000000000000000001']] }, 'update');
    push(socket, 'AAAUSDT', 'books', { ts: at - 1, seq: String(seq + 2n), pseq: String(seq + 1n),
      b: [['9.60', '2'], ['9.5', '1']] }, 'update');
    push(socket, 'AAAUSDT', 'books', book, 'snapshot', 'usdt-futures');
    push(socket, 'AAAUSDT', 'ticker', { markPrice: '11' }, 'snapshot', 'usdt-futures');
    const result = await reading;
    assert.deepEqual(result.get('spot'), { reference: '10', at: at - 1,
      bids: [['9.6', '2'], ['9.500000000000000001', '1.000000000000000001'], ['9.5', '1']] });
    assert.deepEqual(result.get('perp'), { reference: '11', at: at - 100, bids: book.b });
  } finally { streams.close(); }
});

test('等待另一市场时撤空买盘、增量断序、源时回退或连接断开均撤下已凑齐的旧报价', async () => {
  for (const fault of ['empty', 'gap', 'clock', 'disconnect']) {
    const { streams, sockets } = setup();
    try {
      const reading = streams.read('AAAUSDT', ['spot', 'perp'], signal), socket = sockets[0];
      socket.open();
      push(socket, 'AAAUSDT', 'books', book);
      push(socket, 'AAAUSDT', 'ticker', tick);
      if (fault === 'disconnect') socket.onclose?.();
      else {
        push(socket, 'AAAUSDT', 'books', { ts: fault === 'clock' ? at - 101 : at - 1,
          pseq: String(fault === 'gap' ? seq + 1n : seq), seq: String(seq + 2n),
          b: [['10', fault === 'empty' ? '0' : '2']] }, 'update');
        push(socket, 'AAAUSDT', 'books', book, 'snapshot', 'usdt-futures');
        push(socket, 'AAAUSDT', 'ticker', { markPrice: '11' }, 'snapshot', 'usdt-futures');
      }
      const result = await reading;
      assert.ok(result.get('spot') instanceof Error, fault);
      assert.equal(result.get('perp') instanceof Error, fault === 'disconnect');
    } finally { streams.close(); }
  }
});

test('永续订阅超时但连接仍在线时，现货使用持续跟踪至截止时的盘口', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { streams, sockets } = setup();
  try {
    const reading = streams.read('AAAUSDT', ['spot', 'perp'], signal), socket = sockets[0];
    socket.open();
    push(socket, 'AAAUSDT', 'books', book);
    push(socket, 'AAAUSDT', 'ticker', tick);
    push(socket, 'AAAUSDT', 'books', { ts: at, seq: String(seq + 1n), pseq: String(seq), b: [['10', '3']] }, 'update');
    t.mock.timers.tick(5500);
    const result = await reading;
    assert.deepEqual(result.get('spot'), { at, bids: [['10', '3']], reference: '10' });
    assert.ok(result.get('perp') instanceof Error);
  } finally { streams.close(); }
});

test('Bitget 不采信缺快照、断序、错身份、超档位和过期数据', async () => {
  for (const fault of ['delta-first', 'gap', 'backwards', 'wrong-symbol', 'depth', 'clock']) {
    const { sockets, streams } = setup();
    try {
      const reading = streams.read('AAAUSDT', ['spot'], signal), sock = sockets[0];
      sock.open();
      if (fault !== 'delta-first') push(sock, 'AAAUSDT', 'books', {
        ...book, ...(fault === 'depth' ? { maxdepth: '1001' } : {}), ...(fault === 'clock' ? { ts: at - 15_000 } : {}),
      });
      if (fault === 'delta-first' || fault === 'gap' || fault === 'backwards') push(sock, 'AAAUSDT', 'books', {
        ts: at, pseq: String(fault === 'gap' ? seq + 1n : seq), seq: String(fault === 'backwards' ? seq : seq + 2n),
      }, 'update');
      push(sock, 'AAAUSDT', 'ticker', fault === 'wrong-symbol' ? { symbol: 'BBBUSDT', ...tick } : tick);
      assert.ok((await reading).get('spot') instanceof Error, fault);
    } finally { streams.close(); }
  }
});

test('Bitget 限流结束所有在途订阅并退避，取消和关闭释放未取得快照的观察者', async () => {
  const { sockets, streams } = setup();
  const aborted = new AbortController();
  const a = streams.read('AAAUSDT', ['spot'], aborted.signal), b = streams.read('BBBUSDT', ['perp'], signal);
  const sock = sockets[0]; sock.open();
  aborted.abort(); await assert.rejects(a, { name: 'AbortError' });
  sock.emit({ event: 'error', code: 30007 });
  const result = (await b).get('perp');
  assert.ok(result instanceof Error && 'status' in result && result.status === 429);
  await assert.rejects(streams.read('AAAUSDT', ['spot'], signal), { status: 429 });
  assert.equal(sock.readyState, 3);
  streams.close();
  const other = setup();
  const read = other.streams.read('AAAUSDT', ['spot'], signal);
  other.streams.close();
  assert.ok((await read).get('spot') instanceof Error);
  assert.equal(other.sockets[0].readyState, 3);
  await assert.rejects(other.streams.read('AAAUSDT', ['spot'], signal));
});
