// MEV 套利的编解码（src/mev/codec.ts）：自写的 RLP、EIP-1559 签名与 ABI 编解码，逐项对照 ethers（只是开发依赖）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Transaction, Wallet, encodeRlp, id } from 'ethers';
import { AbiReader, abiEncode, addressOf, bytesOf, callData, decodeAggregate3, eventTopic, hexOf, isAddress, quantity, rlpEncode, selector, signTransaction, toQuantity, unsignedTransaction, type Eip1559Transaction } from '../src/mev/codec.ts';
import { executeData } from '../src/mev/simulate.ts';
import { KIND_V3 } from '../src/mev/chain.ts';

const KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2', P = '0x1111111111111111111111111111111111111111', F = '0x2222222222222222222222222222222222222222';

test('数量与地址：JSON-RPC 数量不接受前导零与非十六进制，地址须 40 位', () => {
  assert.equal(quantity('0x0'), 0n);
  assert.equal(quantity('0x1b4'), 436n);
  for (const bad of ['0x', '0x01', '1b4', 12, null, '0xzz']) assert.throws(() => quantity(bad), /不是 JSON-RPC 数量/);
  assert.equal(toQuantity(0), '0x0');
  assert.equal(toQuantity(255n), '0xff');
  assert.throws(() => toQuantity(-1n), /不能为负/);
  assert.ok(isAddress(A));
  assert.ok(!isAddress('0x1234') && !isAddress(A + '00') && !isAddress(7));
});

test('RLP 与 ethers 一致：空串、单字节、长串、嵌套列表', () => {
  const cases: [Parameters<typeof rlpEncode>[0], Parameters<typeof encodeRlp>[0]][] = [
    [new Uint8Array(0), '0x'], [Uint8Array.of(0x7f), '0x7f'], [Uint8Array.of(0x80), '0x80'], [new Uint8Array(55).fill(7), '0x' + '07'.repeat(55)], [new Uint8Array(56).fill(7), '0x' + '07'.repeat(56)],
    [new Uint8Array(300).fill(1), '0x' + '01'.repeat(300)], [[], []], [[Uint8Array.of(1), [Uint8Array.of(2), []]], ['0x01', ['0x02', []]]],
    [Array.from({ length: 60 }, () => Uint8Array.of(9)), Array.from({ length: 60 }, () => '0x09')],
  ];
  for (const [ours, theirs] of cases) assert.equal(hexOf(rlpEncode(ours)), encodeRlp(theirs));
});

test('EIP-1559 签名与 ethers 逐字节一致，地址推导一致', async () => {
  const wallet = new Wallet(KEY);
  assert.equal(addressOf(KEY), wallet.address.toLowerCase());
  const txs: Eip1559Transaction[] = [
    { chainId: 8453n, nonce: 0n, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 16_000_000n, gasLimit: 494_000n, to: P, value: 0n, data: '0x' },
    { chainId: 8453n, nonce: 257n, maxPriorityFeePerGas: 0n, maxFeePerGas: 123_456_789_012n, gasLimit: 1_200_000n, to: F, value: 0n, data: '0xdeadbeef' + '00'.repeat(70) },
    { chainId: 1n, nonce: 9n, maxPriorityFeePerGas: 7n, maxFeePerGas: 9n, gasLimit: 21_000n, to: A, value: 5n, data: '0x00' },
  ];
  for (const tx of txs) {
    const ours = signTransaction(tx, KEY);
    const theirs = await wallet.signTransaction({ type: 2, chainId: tx.chainId, nonce: Number(tx.nonce), maxPriorityFeePerGas: tx.maxPriorityFeePerGas, maxFeePerGas: tx.maxFeePerGas, gasLimit: tx.gasLimit, to: tx.to, value: tx.value, data: tx.data });
    assert.equal(ours.raw, theirs);
    const parsed = Transaction.from(ours.raw);
    assert.equal(parsed.hash, ours.hash);
    assert.equal(parsed.from?.toLowerCase(), addressOf(KEY));
    assert.equal(hexOf(unsignedTransaction(tx)), parsed.unsignedSerialized);
  }
  assert.throws(() => signTransaction({ ...txs[0]!, to: '0x12' }, KEY), /to 不是地址/);
});

test('ABI 编码与 ethers 一致：静态、bytes、数组、元组数组', () => {
  const coder = AbiCoder.defaultAbiCoder();
  assert.equal(abiEncode(['address', 'uint', 'int', 'bool'], [A, 12n, -3n, true]), coder.encode(['address', 'uint256', 'int256', 'bool'], [A, 12n, -3n, true]));
  assert.equal(abiEncode(['bytes', 'uint'], ['0x010203', 9n]), coder.encode(['bytes', 'uint256'], ['0x010203', 9n]));
  assert.equal(abiEncode(['address', 'address', { array: 'address' }, { array: 'uint' }], [A, B, [P, F], [1n, 3n]]), coder.encode(['address', 'address', 'address[]', 'uint8[]'], [A, B, [P, F], [1, 3]]));
  const calls = [[P, true, '0x0dfe1681'], [F, true, '0x'], [A, false, '0x' + 'ab'.repeat(40)]] as const;
  assert.equal(abiEncode([{ array: { tuple: ['address', 'bool', 'bytes'] } }], [calls.map(call => [...call])]), coder.encode(['tuple(address,bool,bytes)[]'], [calls.map(call => [...call])]));
  assert.equal(selector('transfer(address,uint256)'), '0xa9059cbb');
  assert.equal(eventTopic('Executed(address,uint256,uint256)'), id('Executed(address,uint256,uint256)'));
  assert.equal(callData('balanceOf(address)', ['address'], [A]), '0x70a08231' + '0'.repeat(24) + A.slice(2));
});

test('execute 的调用数据与 ethers 按合约签名编出的一致', () => {
  const pool = (address: string) => ({ address, factory: F, kind: KIND_V3, token0: A, token1: B, feePpm: 500 } as const);
  const cycle = { id: 'x', start: A, hops: [{ pool: pool(P), tokenIn: A, tokenOut: B }, { pool: pool('0x3333333333333333333333333333333333333333'), tokenIn: B, tokenOut: A }] };
  const expected = id('execute((address,address,address,address)[],uint256,uint256,uint256)').slice(0, 10)
    + AbiCoder.defaultAbiCoder().encode(['tuple(address,address,address,address)[]', 'uint256', 'uint256', 'uint256'], [[[P, F, A, B], ['0x3333333333333333333333333333333333333333', F, B, A]], 10n ** 18n, 77n, 1234n]).slice(2);
  assert.equal(executeData(cycle, 10n ** 18n, 77n, 1234n), expected);
});

test('ABI 读取：越界、坏地址、项数不符都抛出而不是读出错值', () => {
  const coder = AbiCoder.defaultAbiCoder();
  const answer = coder.encode(['tuple(bool,bytes)[]'], [[[true, '0x' + '00'.repeat(31) + '12'], [false, '0x']]]);
  assert.deepEqual(decodeAggregate3(answer, 2), [{ success: true, data: '0x' + '00'.repeat(31) + '12' }, { success: false, data: '0x' }]);
  assert.throws(() => decodeAggregate3(answer, 3), /应为 3 项/);
  assert.throws(() => decodeAggregate3(answer.slice(0, -64), 2), RangeError);
  const reader = new AbiReader('0x' + 'ff'.repeat(32) + '00'.repeat(31) + '05');
  assert.throws(() => reader.address(0), /地址无效/);
  assert.throws(() => reader.index(0), /越界/);
  assert.throws(() => reader.uint(40), /太短/);
  assert.equal(reader.int(0), -1n);
  assert.equal(reader.uint(32), 5n);
  assert.throws(() => bytesOf('0x123'));
});
