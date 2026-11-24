// MEV 模块的链上编码（docs/mev.md）：十六进制、RLP、EIP-1559 交易的编码与签名、最小的 ABI 编解码。
// 不带运行时依赖；test/mev-codec.test.ts 把每个函数与 ethers 逐字节对照。签名用 src/aster/eip712.ts 里已核对过的 secp256k1。
import { addressOf, keccak256, signDigest } from '../aster/eip712.ts';

export type Hex = string;

export const isAddress = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
export const isHex = (value: unknown): value is string => typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value);
export const lower = (address: string): string => address.toLowerCase();

export function bytesOf(hex: Hex): Uint8Array {
  if (!isHex(hex)) throw new TypeError('不是成对的十六进制文本');
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
export const hexOf = (bytes: Uint8Array): Hex => '0x' + Buffer.from(bytes).toString('hex');
export const concatBytes = (...parts: Uint8Array[]): Uint8Array => Uint8Array.from(Buffer.concat(parts));
const utf8 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'utf8'));

/** JSON-RPC 的数量（`0x` 加不带前导零的十六进制）；不是这种写法就抛出。 */
export function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new TypeError('不是 JSON-RPC 数量');
  return BigInt(value);
}
export const toQuantity = (value: bigint | number): string => {
  const big = BigInt(value);
  if (big < 0n) throw new RangeError('数量不能为负');
  return '0x' + big.toString(16);
};

/** 无符号整数的最短大端字节（零为空串），RLP 里的整数写法。 */
export function minimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new RangeError('RLP 整数不能为负');
  if (value === 0n) return new Uint8Array(0);
  const hex = value.toString(16);
  return Uint8Array.from(Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex'));
}

export type RlpItem = Uint8Array | readonly RlpItem[];

function rlpLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const size = minimalBytes(BigInt(length));
  return concatBytes(Uint8Array.of(offset + 55 + size.length), size);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(rlpLength(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlpEncode));
  return concatBytes(rlpLength(body.length, 0xc0), body);
}

export interface Eip1559Transaction {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  /** null 表示合约创建交易。 */
  to: string | null;
  value: bigint;
  data: Hex;
}

function transactionFields(tx: Eip1559Transaction): RlpItem[] {
  if (tx.to !== null && !isAddress(tx.to)) throw new TypeError('交易的 to 不是地址');
  return [minimalBytes(tx.chainId), minimalBytes(tx.nonce), minimalBytes(tx.maxPriorityFeePerGas), minimalBytes(tx.maxFeePerGas), minimalBytes(tx.gasLimit),
    tx.to === null ? new Uint8Array() : bytesOf(tx.to), minimalBytes(tx.value), bytesOf(tx.data), []];
}

/** 未签名的 EIP-1559 交易（`0x02 || rlp(...)`）；估 L1 数据费时也用它（另补 65 字节占位签名）。 */
export const unsignedTransaction = (tx: Eip1559Transaction): Uint8Array => concatBytes(Uint8Array.of(2), rlpEncode(transactionFields(tx)));

/** 签名后的原始交易与它的哈希。 */
export function signTransaction(tx: Eip1559Transaction, privateKey: string): { raw: Hex; hash: Hex } {
  const signature = bytesOf(signDigest(keccak256(unsignedTransaction(tx)), privateKey));
  const strip = (bytes: Uint8Array): Uint8Array => { let start = 0; while (start < bytes.length && bytes[start] === 0) start++; return bytes.subarray(start); };
  const raw = concatBytes(Uint8Array.of(2), rlpEncode([...transactionFields(tx), minimalBytes(BigInt(signature[64]! - 27)), strip(signature.subarray(0, 32)), strip(signature.subarray(32, 64))]));
  return { raw: hexOf(raw), hash: hexOf(keccak256(raw)) };
}

export { addressOf };

/** 函数选择器：`name(type,...)` 的 keccak 前 4 字节。 */
export const selector = (signature: string): Hex => hexOf(keccak256(utf8(signature)).subarray(0, 4));
export const eventTopic = (signature: string): Hex => hexOf(keccak256(utf8(signature)));

export type AbiType = 'address' | 'uint' | 'int' | 'bool' | 'bytes' | { tuple: readonly AbiType[] } | { array: AbiType };
export type AbiValue = string | bigint | boolean | readonly AbiValue[];

const isDynamic = (type: AbiType): boolean => type === 'bytes' || (typeof type === 'object' && ('array' in type || type.tuple.some(isDynamic)));
const word = (value: bigint): Uint8Array => {
  const wrapped = value < 0n ? value + (1n << 256n) : value;
  if (wrapped < 0n || wrapped >= 1n << 256n) throw new RangeError('超出 256 位');
  return Uint8Array.from(Buffer.from(wrapped.toString(16).padStart(64, '0'), 'hex'));
};

function encodeTuple(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  if (types.length !== values.length) throw new TypeError('ABI 参数个数不符');
  const encoded = types.map((type, index) => encodeValue(type, values[index]!));
  let tail = types.reduce((size, type, index) => size + (isDynamic(type) ? 32 : encoded[index]!.length), 0);
  const heads: Uint8Array[] = [], tails: Uint8Array[] = [];
  types.forEach((type, index) => {
    if (!isDynamic(type)) { heads.push(encoded[index]!); return; }
    heads.push(word(BigInt(tail)));
    tails.push(encoded[index]!);
    tail += encoded[index]!.length;
  });
  return concatBytes(...heads, ...tails);
}

function encodeValue(type: AbiType, value: AbiValue): Uint8Array {
  if (type === 'address') { if (!isAddress(value)) throw new TypeError('ABI：不是地址'); return word(BigInt(value)); }
  if (type === 'uint' || type === 'int') {
    if (typeof value !== 'bigint' || (type === 'uint' && value < 0n) || (type === 'int' && (value < -(1n << 255n) || value >= 1n << 255n))) throw new TypeError('ABI：整数无效');
    return word(value);
  }
  if (type === 'bool') { if (typeof value !== 'boolean') throw new TypeError('ABI：不是布尔值'); return word(value ? 1n : 0n); }
  if (type === 'bytes') {
    if (typeof value !== 'string') throw new TypeError('ABI：bytes 须为十六进制文本');
    const bytes = bytesOf(value);
    return concatBytes(word(BigInt(bytes.length)), bytes, new Uint8Array((32 - bytes.length % 32) % 32));
  }
  if (!Array.isArray(value)) throw new TypeError('ABI：须为数组');
  if ('array' in type) return concatBytes(word(BigInt(value.length)), encodeTuple(value.map(() => type.array), value));
  return encodeTuple(type.tuple, value);
}

export const abiEncode = (types: readonly AbiType[], values: readonly AbiValue[]): Hex => hexOf(encodeTuple(types, values));
/** 函数调用数据：选择器加参数。 */
export const callData = (signature: string, types: readonly AbiType[], values: readonly AbiValue[]): Hex => selector(signature) + abiEncode(types, values).slice(2);

/** 应答按 32 字节一格读取；越界或不是整格就抛出，调用方把它当作这次读取无效。 */
export class AbiReader {
  private readonly bytes: Uint8Array;
  constructor(hex: Hex) { this.bytes = bytesOf(hex); }
  get length(): number { return this.bytes.length; }
  uint(offset: number): bigint {
    if (!Number.isInteger(offset) || offset < 0 || offset + 32 > this.bytes.length) throw new RangeError('ABI 应答太短');
    return BigInt('0x' + Buffer.from(this.bytes.subarray(offset, offset + 32)).toString('hex'));
  }
  int(offset: number): bigint { const value = this.uint(offset); return value >= 1n << 255n ? value - (1n << 256n) : value; }
  address(offset: number): string {
    const value = this.uint(offset);
    if (value >= 1n << 160n) throw new RangeError('ABI 应答里的地址无效');
    return '0x' + value.toString(16).padStart(40, '0');
  }
  /** 把一格当作长度或偏移：必须落在应答之内。 */
  index(offset: number): number {
    const value = this.uint(offset);
    if (value > BigInt(this.bytes.length)) throw new RangeError('ABI 应答里的偏移越界');
    return Number(value);
  }
  bytesAt(offset: number): Hex {
    const length = this.index(offset);
    if (offset + 32 + length > this.bytes.length) throw new RangeError('ABI 应答里的 bytes 越界');
    return hexOf(this.bytes.subarray(offset + 32, offset + 32 + length));
  }
}

/** Multicall3 `aggregate3` 的应答：`(bool success, bytes returnData)[]`。 */
export function decodeAggregate3(hex: Hex, expected: number): { success: boolean; data: Hex }[] {
  const reader = new AbiReader(hex), start = reader.index(0), count = reader.index(start);
  if (count !== expected) throw new RangeError(`Multicall 应答 ${count} 项，应为 ${expected} 项`);
  const base = start + 32, results: { success: boolean; data: Hex }[] = [];
  for (let index = 0; index < count; index++) {
    const item = base + reader.index(base + index * 32);
    results.push({ success: reader.uint(item) === 1n, data: reader.bytesAt(item + reader.index(item + 32)) });
  }
  return results;
}
