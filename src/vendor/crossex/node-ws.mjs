// 本仓新写（非复制）：npm 包 ws 的最小兼容适配，基于 Node 24 全局 WebSocket，只覆盖 src/vendor/crossex 复制代码用到的部分，
// 让复制文件除 import 路径外保持原样。约定：
// - 构造 (url, { maxPayload, handshakeTimeout })：handshakeTimeout 毫秒内未连上即报 error 并关闭；单条消息超过 maxPayload
//   字节即报 error 并断开（全局 WebSocket 先收完整条再交付，因此只能在交付时拒绝，不能像 ws 那样在读帧时提前截断）。
//   其它 ws 选项（perMessageDeflate、followRedirects）被忽略：全局 WebSocket 不跟随重定向。
// - .on('open' | 'message' | 'error' | 'close')；message 参数同 ws：(Buffer, isBinary)；close 参数 (code, Buffer reason)，只触发一次。
// - readyState、send、close、terminate（立即断开并同步触发 close）；ping() 为空操作（全局 WebSocket 不能发 ping 帧，
//   终端行情连接被对端因空闲关闭时，terminal-market 的 read() 按原逻辑 5 秒后重连）。
import { EventEmitter } from 'node:events';

const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

export default class NodeWebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  #socket;
  #maxPayload;
  #timer = null;
  #closed = false;

  constructor(url, { maxPayload = 100 * 1024 * 1024, handshakeTimeout } = {}) {
    super();
    this.#maxPayload = maxPayload;
    const socket = new globalThis.WebSocket(url);
    socket.binaryType = 'arraybuffer';
    this.#socket = socket;
    if (Number.isFinite(handshakeTimeout) && handshakeTimeout > 0) {
      this.#timer = setTimeout(() => this.#abort(new Error('Opening handshake has timed out')), handshakeTimeout);
    }
    socket.addEventListener('open', () => {
      if (this.#closed) return;
      this.#clearTimer();
      this.emit('open');
    });
    socket.addEventListener('message', event => {
      if (this.#closed) return;
      const binary = typeof event.data !== 'string';
      const data = binary ? Buffer.from(event.data) : Buffer.from(event.data, 'utf8');
      if (data.length > this.#maxPayload) { this.#abort(new RangeError('Max payload size exceeded')); return; }
      this.emit('message', data, binary);
    });
    socket.addEventListener('error', event => {
      if (this.#closed) return;
      this.#emitError(event?.error instanceof Error ? event.error : new Error('WebSocket connection error'));
    });
    socket.addEventListener('close', event => this.#finish(event.code, event.reason));
  }

  get readyState() { return this.#closed ? CLOSED : this.#socket.readyState; }

  send(data) { this.#socket.send(data); }

  close(code, reason) {
    if (this.#closed) return;
    try {
      if (code === undefined) this.#socket.close();
      else this.#socket.close(code, reason);
    } catch {
      this.terminate();
    }
  }

  terminate() {
    if (this.#closed) return;
    try { this.#socket.close(); } catch { /* The native socket is already closing. */ }
    this.#finish(1006, '');
  }

  ping() { /* Not available on the global WebSocket; see the header. */ }

  #clearTimer() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #emitError(error) {
    // ws would throw on an unhandled 'error'; every vendored caller listens, but never crash a caller that does not.
    if (this.listenerCount('error')) this.emit('error', error);
  }

  #abort(error) {
    if (this.#closed) return;
    this.#emitError(error);
    this.terminate();
  }

  #finish(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimer();
    this.emit('close', code ?? 1006, Buffer.from(reason ?? '', 'utf8'));
  }
}
