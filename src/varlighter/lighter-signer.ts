// Lighter 交易签名器（docs/dexspread.md 第 12 节）：加载 elliottech/lighter-go 的 WASM 构建，在本进程里给下单交易与鉴权令牌签名。
// 两个文件（signer/lighter-signer.wasm、signer/wasm_exec.js）由 scripts/build-lighter-signer.sh 从固定源码编译，不进仓库；
// 加载前按同目录 SHA256SUMS 核对实际读入的字节，不一致拒绝加载。这里不发任何网络请求：CreateClient 的 url 传空串，
// 上游据此不建 HTTP 客户端，nonce 一律由调用方给出。
//
// 对照的上游源码：lighter-go 提交 e8687faa091ae78de3da78fc338a11c48b4de87e（v1.0.13）的 wasm/main.go。它把函数挂在 globalThis 上，
// 全部同步、按位置传参，数值一律是 JS number（Go 侧 Value.Int()，传布尔或字符串会 panic）：
//   CreateClient(url, privateKey, chainId, apiKeyIndex, accountIndex) → {} 或 {error}
//   SignCreateOrder(marketIndex, clientOrderIndex, baseAmount, price, isAsk, orderType, timeInForce, reduceOnly, triggerPrice,
//     orderExpiry, integratorAccountIndex, integratorTakerFee, integratorMakerFee, selfTradeBehaviorMode, selfTradeEqualityMode,
//     skipNonce, nonce, apiKeyIndex, accountIndex) → {txType, txInfo, txHash} 或 {error}
//   CreateAuthToken(deadline, apiKeyIndex, accountIndex) → {authToken} 或 {error}
// Go 侧对 price、triggerPrice 做 uint32()、对 isAsk 等做 uint8() 的静默截断，所以范围一律在这里先校验，
// 签完再把 txInfo 里的字段与入参逐项比对。
//
// 每个签名器一个独立的 WASM 实例（主网与 RH 的 chainId 不同，不共用上游的客户端表）。实例启动后把它挂到 globalThis 的函数
// 取进闭包并从 globalThis 删除；创建过程串行。
//
// 报错文案不含私钥、账户编号与 API 密钥编号：上游的 error 字符串只有命中固定句式的校验结果才透传，其余换成固定文案。
// Go 运行时写到标准输出与标准错误的内容（panic 的栈等）一律丢弃，不进日志。
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

export interface LighterOrderInput { marketIndex: number; clientOrderIndex: number; baseAmount: number; price: number; isAsk: boolean; /** 0 限价、1 市价 */ orderType: number; /** 0 IOC、1 GTT、2 只挂单 */ timeInForce: number; reduceOnly: boolean; triggerPrice: number; orderExpiry: number; nonce: number }
export interface LighterSignedTx { txType: number; txInfo: string; txHash: string }
export interface LighterSigner { signCreateOrder(order: LighterOrderInput): LighterSignedTx; /** deadline 为秒级时间戳 */ createAuthToken(deadlineSec: number): string }
export interface LighterSignerConfig { chainId: number; /** 80 位十六进制，不带 0x */ privateKey: string; apiKeyIndex: number; accountIndex: number }

export class LighterSignerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LighterSignerError';
  }
}

const SIGNER_DIR = fileURLToPath(new URL('./signer/', import.meta.url));
const WASM_FILE = 'lighter-signer.wasm';
const EXEC_FILE = 'wasm_exec.js';
const SUMS_FILE = 'SHA256SUMS';
const PLACEHOLDER = '0'.repeat(64);

// 上游 types/txtypes/constants.go。
const MAX_48 = 2 ** 48 - 1;
const MAX_32 = 2 ** 32 - 1;
const MAX_ACCOUNT_INDEX = 2 ** 48 - 2;
const MAX_API_KEY_INDEX = 254;
const NIL_MARKET_INDEX = 255;
const MAX_ORDER_TYPE = 6;
const MAX_TIME_IN_FORCE = 2;
const TX_TYPE_CREATE_ORDER = 14;

function integer(name: string, value: unknown, min: number, max: number): number {
  // 文案只说字段与范围，不带收到的值（可能是账户编号）。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new LighterSignerError(`${name} 须为 ${min} 到 ${max} 之间的整数`);
  return value;
}

function flag(name: string, value: unknown): number {
  if (typeof value !== 'boolean') throw new LighterSignerError(`${name} 须为布尔值`);
  return value ? 1 : 0;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 读校验清单：两个文件各恰好一行、64 位十六进制。读不到或格式不对时返回原因。 */
function readSums(): { wasm: string; exec: string } | string {
  let text: string;
  try { text = readFileSync(SIGNER_DIR + SUMS_FILE, 'utf8'); } catch { return 'Lighter 签名器的校验清单（SHA256SUMS）读不到，不能加载签名器'; }
  const found = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](\S+)$/.exec(line);
    if (match) found.set(match[2], [...(found.get(match[2]) ?? []), match[1]]);
  }
  const wasm = found.get(WASM_FILE), exec = found.get(EXEC_FILE);
  if (wasm?.length !== 1 || exec?.length !== 1) return 'Lighter 签名器的校验清单（SHA256SUMS）格式不对，不能加载签名器';
  if (wasm[0] === PLACEHOLDER || exec[0] === PLACEHOLDER) return 'Lighter 签名器的校验值尚未登记（SHA256SUMS 仍是占位），不能加载签名器';
  return { wasm: wasm[0], exec: exec[0] };
}

const MISSING = 'Lighter 签名器文件不在（由 scripts/build-lighter-signer.sh 从源码编译，随发布包安装），不能签名下单';
const MISMATCH = 'Lighter 签名器文件与校验清单不一致，已拒绝加载';

// 页面会反复问，按文件大小与修改时间记住算过的哈希，文件没变就不重读。
const hashed = new Map<string, { size: number; mtimeMs: number; sha: string }>();
function fileSha(name: string): string | null {
  const file = SIGNER_DIR + name;
  let stat: { size: number; mtimeMs: number };
  try { const s = statSync(file); if (!s.isFile()) return null; stat = { size: s.size, mtimeMs: s.mtimeMs }; } catch { hashed.delete(name); return null; }
  const known = hashed.get(name);
  if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.sha;
  let sha: string;
  try { sha = sha256(readFileSync(file)); } catch { return null; }
  hashed.set(name, { ...stat, sha });
  return sha;
}

/** 签名器文件齐全时返回 null，否则返回给页面看的原因（一句中文）。 */
export function lighterSignerProblem(): string | null {
  const sums = readSums();
  if (typeof sums === 'string') return sums;
  const wasm = fileSha(WASM_FILE), exec = fileSha(EXEC_FILE);
  if (wasm === null || exec === null) return MISSING;
  if (wasm !== sums.wasm || exec !== sums.exec) return MISMATCH;
  return null;
}

// 项目的类型库（ES2023 加 node）里没有 WebAssembly 的声明，这里只写用到的部分。
type WasmModule = object;
type WasmInstance = object;
type WasmImports = Record<string, Record<string, unknown> | undefined>;
const wasmApi = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<WasmModule>; Instance: new (module: WasmModule, imports: WasmImports) => WasmInstance } }).WebAssembly;

/** wasm_exec.js 定义的 Go 类里这里用到的部分。 */
interface GoRuntime {
  importObject: WasmImports;
  exit: (code: number) => void;
  exited?: boolean;
  _scheduledTimeouts?: Map<number, unknown>;
  run(instance: WasmInstance): Promise<void>;
}
type GoConstructor = new () => GoRuntime;
type GoFunction = (...args: unknown[]) => unknown;

const quietFs = Symbol('lighter-signer quiet fs');

/**
 * wasm_exec.js 在 globalThis.fs 不在时自己装一个把 Go 的输出打到 console.log 的桩。这里先装一个丢弃输出的：Go 的 panic 栈
 * 可能带着参数，不让它进日志。桩必须留在 globalThis 上，wasm_exec.js 与 Go 的 syscall 包运行时都按全局名取它。
 * 字段与 Go 1.26 的 wasm_exec.js 里那一份相同。wasm_exec.js 另外会在 globalThis 上留一个只有 resolve 的 path 桩，同样留着。
 */
function installQuietFs(): void {
  const scope = globalThis as unknown as { fs?: Record<PropertyKey, unknown> };
  if (scope.fs) {
    if (scope.fs[quietFs] === true) return;
    throw new LighterSignerError('运行环境已有全局 fs 对象，无法保证签名器的输出不进日志，已拒绝加载');
  }
  const enosys = (): Error => Object.assign(new Error('not implemented'), { code: 'ENOSYS' });
  const fail = (...args: unknown[]): void => { const callback = args[args.length - 1]; if (typeof callback === 'function') callback(enosys()); };
  const stub: Record<PropertyKey, unknown> = {
    [quietFs]: true,
    constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1, O_DIRECTORY: -1 },
    writeSync: (_fd: number, buf: Uint8Array): number => buf.length,
    write: (_fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, callback: (error: Error | null, written?: number) => void): void => {
      if (offset !== 0 || length !== buf.length || position !== null) callback(enosys());
      else callback(null, buf.length);
    },
    fsync: (_fd: number, callback: (error: Error | null) => void): void => callback(null),
  };
  for (const name of ['chmod', 'chown', 'close', 'fchmod', 'fchown', 'fstat', 'ftruncate', 'lchown', 'link', 'lstat', 'mkdir', 'open', 'read', 'readdir', 'readlink', 'rename', 'rmdir', 'stat', 'symlink', 'truncate', 'unlink', 'utimes']) stub[name] = fail;
  Object.defineProperty(globalThis, 'fs', { value: stub, configurable: true, writable: true, enumerable: false });
}

interface Loaded { Go: GoConstructor; module: WasmModule }
let loading: Promise<Loaded> | null = null;

async function load(): Promise<Loaded> {
  const sums = readSums();
  if (typeof sums === 'string') throw new LighterSignerError(sums);
  let wasm: Buffer, exec: Buffer;
  try { wasm = readFileSync(SIGNER_DIR + WASM_FILE); exec = readFileSync(SIGNER_DIR + EXEC_FILE); } catch { throw new LighterSignerError(MISSING); }
  // 核对的就是接下来要执行的这两份字节。
  if (sha256(wasm) !== sums.wasm || sha256(exec) !== sums.exec) throw new LighterSignerError(MISMATCH);
  installQuietFs();
  const scope = globalThis as unknown as { Go?: GoConstructor };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Go');
  let Go: GoConstructor | undefined;
  try {
    // 普通脚本（不是模块），执行后设置 globalThis.Go；取走后恢复原样。
    runInThisContext(exec.toString('utf8'), { filename: SIGNER_DIR + EXEC_FILE });
    Go = scope.Go;
  } catch {
    throw new LighterSignerError('Lighter 签名器的运行时脚本（wasm_exec.js）执行失败');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Go', previous); else delete scope.Go;
  }
  if (typeof Go !== 'function') throw new LighterSignerError('Lighter 签名器的运行时脚本（wasm_exec.js）没有提供 Go 类');
  let module: WasmModule;
  try { module = await wasmApi.compile(wasm); } catch { throw new LighterSignerError('Lighter 签名器的 WASM 文件无法编译'); }
  return { Go, module };
}

function loaded(): Promise<Loaded> {
  // 失败不记住：文件补齐后下一次创建可以重试。
  loading ??= load().catch(error => { loading = null; throw error; });
  return loading;
}

// 上游的校验结果是固定句式（types/txtypes/errors.go），里面的数字是协议常量，不是本账户的值；只有这些原样透传。
const VALIDATION = /^(AccountIndex|ApiKeyIndex|MarketIndex|ClientOrderIndex|BaseAmount|OrderPrice|IsAsk|OrderType|OrderTimeInForce|ReduceOnly|TriggerPrice|OrderExpiry|ExpiredAt|AccountNonce) (should not be (less|larger) than -?\d+|should be 0 or 1|is (not valid|invalid))$/;

/** 把上游的 error 字符串变成可以给人看的文案：不透传任何可能带私钥、账户编号或 API 密钥编号的内容。 */
function describe(error: unknown): string {
  const text = typeof error === 'string' ? error : '';
  if (VALIDATION.test(text)) return `参数未通过签名器校验（${text}）`;
  if (text.startsWith('panic:')) return '签名器内部异常';
  if (text.includes('creating TxClient')) return '私钥无法解析';
  if (text.includes('invalid account index')) return '账户编号无效';
  if (text.includes('client is not created')) return '签名客户端不存在';
  if (text.includes('nonce was not provided')) return '没有给出 nonce';
  if (/^argument \d+ is undefined$/.test(text) || text.includes('expects')) return '传给签名器的参数个数不对';
  return '签名器返回了未归类的错误';
}

function validateConfig(config: LighterSignerConfig): { chainId: number; privateKey: string; apiKeyIndex: number; accountIndex: number } {
  if (!config || typeof config !== 'object') throw new LighterSignerError('签名器配置无效');
  const chainId = integer('chainId', config.chainId, 1, MAX_32);
  if (typeof config.privateKey !== 'string' || !/^[0-9a-fA-F]{80}$/.test(config.privateKey)) throw new LighterSignerError('私钥须为 80 位十六进制（不带 0x）');
  const apiKeyIndex = integer('API 密钥编号', config.apiKeyIndex, 0, MAX_API_KEY_INDEX);
  // 上游 CreateClient 拒绝 accountIndex <= 0。
  const accountIndex = integer('账户编号', config.accountIndex, 1, MAX_ACCOUNT_INDEX);
  return { chainId, privateKey: config.privateKey, apiKeyIndex, accountIndex };
}

async function start(config: { chainId: number; privateKey: string; apiKeyIndex: number; accountIndex: number }): Promise<LighterSigner> {
  const { Go, module } = await loaded();
  const go = new Go();
  let dead = false;
  // 默认的 exit 会 console.warn；这里只记下实例已退出。go.env 默认是空对象，进程环境不会传进去。
  go.exit = () => { dead = true; };
  // Go 运行时的定时器走 setTimeout。取消引用，空闲的签名器不拦着进程退出。
  const gojs = go.importObject.gojs as Record<string, ((sp: number) => unknown) | undefined> | undefined;
  const schedule = gojs?.['runtime.scheduleTimeoutEvent'];
  if (gojs && typeof schedule === 'function') {
    gojs['runtime.scheduleTimeoutEvent'] = sp => {
      const result = schedule(sp);
      for (const timer of go._scheduledTimeouts?.values() ?? []) (timer as { unref?: () => void } | null)?.unref?.();
      return result;
    };
  }
  let instance: WasmInstance;
  try { instance = new wasmApi.Instance(module, go.importObject); } catch { throw new LighterSignerError('Lighter 签名器的 WASM 实例无法创建'); }

  // 从这里到取走函数之间没有 await：go.run 同步执行到 Go 的 main 阻塞为止，期间 main 把函数挂到 globalThis。
  // 用启动前后的属性差找出它新挂的全部函数（不止用到的三个），取走后全部删除，下一个实例不会与它相混。
  const scope = globalThis as unknown as Record<string, unknown>;
  const before = new Set(Object.getOwnPropertyNames(globalThis));
  const taken = new Map<string, unknown>();
  let startFailed = false;
  try {
    go.run(instance).then(() => { dead = true; }, () => { dead = true; });
  } catch {
    startFailed = true;
  } finally {
    for (const name of Object.getOwnPropertyNames(globalThis)) {
      if (before.has(name)) continue;
      taken.set(name, scope[name]);
      delete scope[name];
    }
  }
  const createClient = taken.get('CreateClient'), signCreateOrder = taken.get('SignCreateOrder'), createAuthToken = taken.get('CreateAuthToken');
  if (startFailed || dead || go.exited || typeof createClient !== 'function' || typeof signCreateOrder !== 'function' || typeof createAuthToken !== 'function') {
    throw new LighterSignerError('Lighter 签名器启动后没有提供预期的函数');
  }

  const call = (fn: unknown, args: readonly unknown[]): Record<string, unknown> => {
    if (dead || go.exited) throw new LighterSignerError('签名器实例已退出');
    let result: unknown;
    // 异常对象可能带参数，不向外传。
    try { result = (fn as GoFunction)(...args); } catch { throw new LighterSignerError('签名器调用失败'); }
    if (!result || typeof result !== 'object') throw new LighterSignerError('签名器没有返回结果');
    const record = result as Record<string, unknown>;
    if (record.error !== undefined) throw new LighterSignerError(describe(record.error));
    return record;
  };

  // url 传空串：上游不建 HTTP 客户端，之后的签名都不联网。
  call(createClient, ['', config.privateKey, config.chainId, config.apiKeyIndex, config.accountIndex]);
  const { apiKeyIndex, accountIndex } = config;

  return {
    signCreateOrder(order) {
      if (!order || typeof order !== 'object') throw new LighterSignerError('下单参数无效');
      const expected: Record<string, number> = {
        AccountIndex: accountIndex,
        ApiKeyIndex: apiKeyIndex,
        MarketIndex: integer('marketIndex', order.marketIndex, 0, MAX_48),
        ClientOrderIndex: integer('clientOrderIndex', order.clientOrderIndex, 1, MAX_48),
        BaseAmount: integer('baseAmount', order.baseAmount, 1, MAX_48),
        Price: integer('price', order.price, 1, MAX_32),
        IsAsk: flag('isAsk', order.isAsk),
        Type: integer('orderType', order.orderType, 0, MAX_ORDER_TYPE),
        TimeInForce: integer('timeInForce', order.timeInForce, 0, MAX_TIME_IN_FORCE),
        ReduceOnly: flag('reduceOnly', order.reduceOnly),
        TriggerPrice: integer('triggerPrice', order.triggerPrice, 0, MAX_32),
        // 0 表示不设；上游把 -1 换成「28 天后」，这里不放行负数，到期时间由调用方明确给出。
        OrderExpiry: integer('orderExpiry', order.orderExpiry, 0, Number.MAX_SAFE_INTEGER),
        // 上游在 nonce 为 -1 时去交易所取，这里没有网络，必须给出。
        Nonce: integer('nonce', order.nonce, 0, Number.MAX_SAFE_INTEGER),
      };
      // 上游把 255 当作「未指定市场」并拒绝。
      if (expected.MarketIndex === NIL_MARKET_INDEX) throw new LighterSignerError('marketIndex 不能是 255');
      // 第 11 到 16 个参数：不带 integrator（账户 0、两项费用 0）、自成交按默认（行为 0、判定 0）、不跳过 nonce（0）。
      // 这些都是上游的「空值」，签出的交易不带任何附加属性。
      const result = call(signCreateOrder, [expected.MarketIndex, expected.ClientOrderIndex, expected.BaseAmount, expected.Price, expected.IsAsk, expected.Type,
        expected.TimeInForce, expected.ReduceOnly, expected.TriggerPrice, expected.OrderExpiry, 0, 0, 0, 0, 0, 0, expected.Nonce, apiKeyIndex, accountIndex]);
      const { txType, txInfo, txHash } = result;
      if (txType !== TX_TYPE_CREATE_ORDER || typeof txInfo !== 'string' || typeof txHash !== 'string' || !/^[0-9a-f]{80}$/.test(txHash)) throw new LighterSignerError('签名器返回的下单交易格式不对');
      // 位置参数错一位就是另一笔单：把签出的内容与入参逐项比对后才交出去。
      let info: unknown;
      try { info = JSON.parse(txInfo); } catch { throw new LighterSignerError('签名器返回的下单交易不是 JSON'); }
      if (!info || typeof info !== 'object') throw new LighterSignerError('签名器返回的下单交易不是 JSON');
      const signed = info as Record<string, unknown>;
      for (const [field, value] of Object.entries(expected)) if (signed[field] !== value) throw new LighterSignerError(`签名器签出的 ${field} 与入参不一致`);
      if (signed.L2TxAttributes != null) throw new LighterSignerError('签名器签出的交易带了未请求的附加属性');
      if (typeof signed.Sig !== 'string' || !signed.Sig) throw new LighterSignerError('签名器返回的下单交易没有签名');
      return { txType, txInfo, txHash };
    },
    createAuthToken(deadlineSec) {
      // 上游把 0 换成「7 小时后」，这里要求明确给出。
      const deadline = integer('deadlineSec', deadlineSec, 1, MAX_48);
      const token = call(createAuthToken, [deadline, apiKeyIndex, accountIndex]).authToken;
      // 上游格式：「截止秒:账户编号:API 密钥编号:签名的十六进制」，签名 80 字节。
      const parts = typeof token === 'string' ? token.split(':') : [];
      if (parts.length !== 4 || parts[0] !== String(deadline) || parts[1] !== String(accountIndex) || parts[2] !== String(apiKeyIndex) || !/^[0-9a-f]{160}$/.test(parts[3])) throw new LighterSignerError('签名器返回的鉴权令牌格式不对');
      return token as string;
    },
  };
}

// 实例启动时要短暂占用 globalThis 上的函数名，创建一个接一个地做。
let queue: Promise<unknown> = Promise.resolve();

export function createLighterSigner(config: LighterSignerConfig): Promise<LighterSigner> {
  let valid: ReturnType<typeof validateConfig>;
  try { valid = validateConfig(config); } catch (error) { return Promise.reject(error); }
  const created = queue.then(() => start(valid));
  queue = created.catch(() => undefined);
  return created;
}
