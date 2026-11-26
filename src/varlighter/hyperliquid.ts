// Hyperliquid（Entropy 所在的交易所）下单动作的签名与编码（docs/dexspread.md 第 13 节）。照官方 Python SDK 的
// hyperliquid/utils/signing.py：动作按 msgpack 编码（键的顺序就是签名的一部分），后接 8 字节大端 nonce 与金库标记，keccak 后作为
// EIP-712 `Agent(string source,bytes32 connectionId)` 的 connectionId，域为 Exchange / 1 / 1337 / 零地址，主网 source 是 "a"。
// 只覆盖本模块要用的值类型（字符串、布尔、非负整数、数组、对象）；用 SDK 测试里的签名向量对拍（test/dex-hyperliquid.test.ts）。
import { keccak256, signDigest } from '../aster/eip712.ts';

export type PackValue = string | boolean | number | PackValue[] | { [key: string]: PackValue };

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const utf8 = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'utf8'));
const be = (value: bigint, bytes: number): Uint8Array => {
  const out = new Uint8Array(bytes);
  for (let i = bytes - 1; i >= 0; i--) { out[i] = Number(value & 0xffn); value >>= 8n; }
  return out;
};

/** msgpack 的最短编码，与 Python msgpack.packb 的默认输出一致。对象按键的插入顺序写。 */
export function pack(value: PackValue): Uint8Array {
  if (typeof value === 'boolean') return Uint8Array.of(value ? 0xc3 : 0xc2);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('msgpack 只编码非负安全整数');
    if (value < 0x80) return Uint8Array.of(value);
    if (value < 0x100) return Uint8Array.of(0xcc, value);
    if (value < 0x10000) return concat([Uint8Array.of(0xcd), be(BigInt(value), 2)]);
    if (value < 0x100000000) return concat([Uint8Array.of(0xce), be(BigInt(value), 4)]);
    return concat([Uint8Array.of(0xcf), be(BigInt(value), 8)]);
  }
  if (typeof value === 'string') {
    const bytes = utf8(value), n = bytes.length;
    const head = n < 32 ? Uint8Array.of(0xa0 | n) : n < 0x100 ? Uint8Array.of(0xd9, n) : n < 0x10000 ? concat([Uint8Array.of(0xda), be(BigInt(n), 2)]) : concat([Uint8Array.of(0xdb), be(BigInt(n), 4)]);
    return concat([head, bytes]);
  }
  if (Array.isArray(value)) {
    const n = value.length;
    if (n >= 0x10000) throw new RangeError('msgpack 数组过长');
    return concat([n < 16 ? Uint8Array.of(0x90 | n) : concat([Uint8Array.of(0xdc), be(BigInt(n), 2)]), ...value.map(pack)]);
  }
  const entries = Object.entries(value), n = entries.length;
  if (n >= 0x10000) throw new RangeError('msgpack 对象过大');
  return concat([n < 16 ? Uint8Array.of(0x80 | n) : concat([Uint8Array.of(0xde), be(BigInt(n), 2)]), ...entries.flatMap(([key, item]) => [pack(key), pack(item)])]);
}

/**
 * 数字写成交易所要的十进制文本（SDK 的 float_to_wire）：最多 8 位小数、去掉尾零，不用科学计数。
 * 多于 8 位小数的值直接拒绝，不悄悄舍入：数量与价格在调用前已按市场精度取整。
 */
export function floatToWire(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError('数值无效');
  const rounded = value.toFixed(8);
  if (Math.abs(Number(rounded) - value) >= 1e-12) throw new RangeError('数值超出 8 位小数');
  const text = rounded.includes('.') ? rounded.replace(/0+$/, '').replace(/\.$/, '') : rounded;
  return text === '-0' ? '0' : text;
}

export interface OrderRequest {
  /** 资产编号：主盘是 universe 里的序号；HIP-3 盘是 100000 + 盘序号 × 10000 + 盘内序号。 */ asset: number;
  isBuy: boolean; price: number; size: number; reduceOnly: boolean;
  /** 自编号：0x 加 32 位十六进制。 */ cloid?: string;
}
export interface OrderAction { [key: string]: PackValue; type: 'order'; orders: PackValue[]; grouping: 'na' }

const CLOID = /^0x[0-9a-f]{32}$/;
/** IOC 限价单的动作。键的顺序固定为 a b p s r t c 与 type orders grouping，改动会改变签名。 */
export function iocOrderAction(orders: readonly OrderRequest[], tif: 'Ioc' | 'Gtc' = 'Ioc'): OrderAction {
  return {
    type: 'order',
    orders: orders.map(order => {
      if (!Number.isSafeInteger(order.asset) || order.asset < 0) throw new RangeError('资产编号无效');
      if (!(order.price > 0) || !(order.size > 0)) throw new RangeError('价格与数量须为正');
      if (order.cloid !== undefined && !CLOID.test(order.cloid)) throw new RangeError('自编号格式无效');
      const wire: { [key: string]: PackValue } = { a: order.asset, b: order.isBuy, p: floatToWire(order.price), s: floatToWire(order.size), r: order.reduceOnly, t: { limit: { tif } } };
      if (order.cloid !== undefined) wire.c = order.cloid;
      return wire;
    }),
    grouping: 'na',
  };
}

const DOMAIN_TYPE = keccak256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const AGENT_TYPE = keccak256(utf8('Agent(string source,bytes32 connectionId)'));
const DOMAIN = keccak256(concat([DOMAIN_TYPE, keccak256(utf8('Exchange')), keccak256(utf8('1')), be(1337n, 32), new Uint8Array(32)]));

/** 动作哈希：msgpack(动作) ‖ nonce（8 字节大端）‖ 金库标记。本模块不用金库与 expiresAfter。 */
export function actionHash(action: PackValue, nonce: number): Uint8Array {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new RangeError('nonce 无效');
  return keccak256(concat([pack(action), be(BigInt(nonce), 8), Uint8Array.of(0)]));
}

export interface Signature { r: string; s: string; v: number }
/** 用 API 钱包私钥给动作签名。`mainnet` 为假时是测试网（只在对拍测试里用）。 */
export function signL1Action(action: PackValue, nonce: number, privateKey: string, mainnet = true): Signature {
  const struct = keccak256(concat([AGENT_TYPE, keccak256(utf8(mainnet ? 'a' : 'b')), actionHash(action, nonce)]));
  const digest = keccak256(concat([Uint8Array.of(0x19, 0x01), DOMAIN, struct]));
  const signature = signDigest(digest, privateKey).replace(/^0x/, '');
  return { r: '0x' + signature.slice(0, 64), s: '0x' + signature.slice(64, 128), v: parseInt(signature.slice(128, 130), 16) };
}

/** HIP-3 盘的资产编号。 */
export const hip3Asset = (dexIndex: number, indexInDex: number): number => {
  if (!Number.isSafeInteger(dexIndex) || dexIndex < 1 || !Number.isSafeInteger(indexInDex) || indexInDex < 0 || indexInDex >= 10_000) throw new RangeError('HIP-3 资产序号无效');
  return 100_000 + dexIndex * 10_000 + indexInDex;
};
