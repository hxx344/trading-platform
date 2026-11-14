// Aster read signing (A-3/A-4 sources): src/asset/sources/aster.ts signs with this repository's src/aster/eip712.ts
// instead of ethers. These checks compare it with ethers (a devDependency, imported only here) on the same keys and
// queries: the EIP-712 digest, the 65-byte signature and the wallet address must be identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TypedDataEncoder, Wallet } from 'ethers';
import { asterDigest, signAsterMessage } from '../src/aster/eip712.ts';
import { asterGet, nextAsterNonce, syncAster, validateAsterWallet } from '../src/asset/sources/aster.ts';
// The DOM lib is not loaded (tsconfig "types": ["node"]); these are the fetch argument types the copied fixtures use.
type RequestInfo = string | Request;

// The workbench's ASTER_DOMAIN and ASTER_TYPES (modules/asset/lib/exchanges.ts, 0014655), verbatim.
const ASTER_DOMAIN = { name: 'AsterSignTransaction', version: '1', chainId: 1666, verifyingContract: '0x0000000000000000000000000000000000000000' };
const ASTER_TYPES = { Message: [{ name: 'msg', type: 'string' }] };
const hex = (bytes: Uint8Array): string => '0x' + Buffer.from(bytes).toString('hex');
// Fixed synthetic keys (never funded) plus random ones, so a failure is reproducible.
const FIXED = ['0x' + '1'.repeat(64), '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318', '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140'];

test('asterDigest uses exactly the workbench EIP-712 domain and Message{msg:string} type', () => {
  for (const msg of ['', 'nonce=1&signer=0xabc', 'nonce=1763000000000000&signer=0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A', 'a'.repeat(300), '中文 & spaces']) {
    assert.equal(hex(asterDigest(msg)), TypedDataEncoder.hash(ASTER_DOMAIN, ASTER_TYPES, { msg }), msg);
  }
});

test('the same private key and query give byte-identical signatures and the same address as ethers', async () => {
  const keys = [...FIXED, ...Array.from({ length: 6 }, () => Wallet.createRandom().privateKey)];
  for (const privateKey of keys) {
    const wallet = new Wallet(privateKey);
    for (const prefixed of [privateKey, privateKey.slice(2)]) {
      const own = validateAsterWallet({ walletAddress: wallet.address.toLowerCase(), privateKey: prefixed, includeSpot: false });
      assert.equal(own.address, wallet.address, 'EIP-55 address like ethers Wallet.address');
    }
    const query = new URLSearchParams({ nonce: nextAsterNonce(), signer: wallet.address }).toString();
    assert.equal(signAsterMessage(query, privateKey), await wallet.signTypedData(ASTER_DOMAIN, ASTER_TYPES, { msg: query }));
  }
});

test('asterGet sends the signature ethers would produce for the exact query sent', async () => {
  const wallet = Wallet.createRandom();
  const sent: URL[] = [];
  const fetcher = (async (input: RequestInfo | URL) => { sent.push(new URL(String(input))); return Response.json({ assets: [], balances: [] }); }) as typeof fetch;
  await syncAster({ walletAddress: wallet.address, privateKey: wallet.privateKey, includeSpot: true }, {}, fetcher);
  await asterGet({ walletAddress: wallet.address.toLowerCase(), privateKey: wallet.privateKey.slice(2), includeSpot: false }, '/fapi/v3/accountWithJoinMargin', fetcher);
  assert.equal(sent.length, 3);
  for (const url of sent) {
    const signature = url.searchParams.get('signature')!;
    const query = url.search.slice(1, url.search.indexOf('&signature='));
    assert.deepEqual([...new URLSearchParams(query).keys()], ['nonce', 'signer']);
    assert.equal(url.searchParams.get('signer'), wallet.address);
    assert.equal(signature, await wallet.signTypedData(ASTER_DOMAIN, ASTER_TYPES, { msg: query }));
  }
});

test('mismatched and invalid keys fail with the workbench messages and never echo the key', () => {
  const wallet = Wallet.createRandom(), other = Wallet.createRandom();
  assert.throws(() => validateAsterWallet({ walletAddress: other.address, privateKey: wallet.privateKey, includeSpot: false }), { message: 'API 钱包地址与私钥不匹配，请使用同一个 API 钱包的地址和私钥' });
  for (const privateKey of ['0x' + '0'.repeat(64), '0x' + 'f'.repeat(64), '0x1234', 'z'.repeat(64), '0x' + '1'.repeat(65)]) {
    assert.throws(() => validateAsterWallet({ walletAddress: wallet.address, privateKey, includeSpot: false }),
      (error: Error) => error.message === 'API 钱包私钥无效，请检查是否为 64 位十六进制私钥' && !error.message.includes(privateKey));
  }
  assert.throws(() => validateAsterWallet({ walletAddress: '', privateKey: wallet.privateKey, includeSpot: false }), { message: 'Aster 连接需要更新：请填写 API Pro 钱包地址和对应私钥；已保留旧估值' });
});

test('nonces are strictly increasing microseconds', () => {
  const values = Array.from({ length: 50 }, () => BigInt(nextAsterNonce()));
  for (let i = 1; i < values.length; i++) assert.ok(values[i]! > values[i - 1]!);
  assert.ok(Number(values[0]! / 1000n) - Date.now() < 1000);
});
