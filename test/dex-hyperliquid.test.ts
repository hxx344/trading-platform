// Hyperliquid 签名与编码（src/varlighter/hyperliquid.ts）：与官方 Python SDK tests/signing_test.py 的签名向量对拍。
import assert from 'node:assert/strict';
import test from 'node:test';
import { floatToWire, hip3Asset, iocOrderAction, pack, signL1Action } from '../src/varlighter/hyperliquid.ts';

const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
/** SDK 把不足 32 字节的 r、s 写成不带前导零的十六进制；这里统一成整数比较。 */
const same = (actual: string, expected: string) => assert.equal(BigInt(actual), BigInt(expected));

test('下单动作的签名与官方 SDK 的向量一致（主网与测试网，带与不带自编号）', () => {
  const plain = iocOrderAction([{ asset: 1, isBuy: true, price: 100, size: 100, reduceOnly: false }], 'Gtc');
  const main = signL1Action(plain, 0, KEY, true);
  same(main.r, '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e');
  same(main.s, '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e');
  assert.equal(main.v, 28);
  const testnet = signL1Action(plain, 0, KEY, false);
  same(testnet.r, '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54');
  same(testnet.s, '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5');
  assert.equal(testnet.v, 27);

  const withCloid = iocOrderAction([{ asset: 1, isBuy: true, price: 100, size: 100, reduceOnly: false, cloid: '0x00000000000000000000000000000001' }], 'Gtc');
  const signed = signL1Action(withCloid, 0, KEY, true);
  same(signed.r, '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3');
  same(signed.s, '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da');
  assert.equal(signed.v, 27);
  assert.equal(signed.r.length, 66, 'r 补足 32 字节');
});

test('动作里键的顺序、IOC 与只减仓', () => {
  const action = iocOrderAction([{ asset: hip3Asset(10, 3), isBuy: false, price: 182.35, size: 0.5, reduceOnly: true, cloid: '0x' + 'ab'.repeat(16) }]);
  assert.equal(JSON.stringify(action), JSON.stringify({ type: 'order', orders: [{ a: 200003, b: false, p: '182.35', s: '0.5', r: true, t: { limit: { tif: 'Ioc' } }, c: '0x' + 'ab'.repeat(16) }], grouping: 'na' }));
  assert.throws(() => iocOrderAction([{ asset: 1, isBuy: true, price: 0, size: 1, reduceOnly: false }]), /须为正/);
  assert.throws(() => iocOrderAction([{ asset: 1, isBuy: true, price: 1, size: 1, reduceOnly: false, cloid: '0x1' }]), /自编号/);
  assert.throws(() => hip3Asset(0, 1));
});

test('数字的写法：去尾零、不用科学计数、超过 8 位小数时拒绝', () => {
  assert.deepEqual([100, 0.5, 182.35, 1e-8, 123456.78901234, 0.1 + 0.2].map(floatToWire), ['100', '0.5', '182.35', '0.00000001', '123456.78901234', '0.3']);
  assert.throws(() => floatToWire(1e-9), /8 位小数/);
  assert.throws(() => floatToWire(Number.NaN));
});

test('msgpack：各长度段的编码', () => {
  const hex = (value: Parameters<typeof pack>[0]) => Buffer.from(pack(value)).toString('hex');
  assert.deepEqual([hex(0), hex(127), hex(128), hex(255), hex(256), hex(65536), hex(2 ** 32)], ['00', '7f', 'cc80', 'ccff', 'cd0100', 'ce00010000', 'cf0000000100000000']);
  assert.deepEqual([hex(true), hex(false), hex('a'), hex([1, 'b']), hex({ a: 1 })], ['c3', 'c2', 'a161', '9201a162', '81a16101']);
  assert.equal(hex('x'.repeat(32)).slice(0, 4), 'd920');
  assert.equal(hex(Array.from({ length: 16 }, () => 0)).slice(0, 6), 'dc0010');
  assert.throws(() => pack(-1));
  assert.throws(() => pack(1.5));
});
