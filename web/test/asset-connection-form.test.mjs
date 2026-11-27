import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionCredentials } from '../src/asset-connection-form.ts';

test('连接表单仅向所选交易所提供对应的凭据字段', () => {
  const input = { key: ' key ', secret: ' secret ', passphrase: ' pass ', accountMode: 'uta', region: 'eu',
    walletAddress: ' address ', vrToken: ' token ' };
  const pair = { apiKey: 'key', apiSecret: 'secret' };
  for (const accountMode of ['uta', 'classic']) {
    assert.deepEqual(connectionCredentials('bitget', { ...input, accountMode }), { exchange: 'bitget', ...pair, passphrase: 'pass', accountMode });
  }
  assert.deepEqual(connectionCredentials('okx', input), { exchange: 'okx', ...pair, passphrase: 'pass' });
  assert.deepEqual(connectionCredentials('bybit', input), { exchange: 'bybit', ...pair, region: 'eu' });
  assert.deepEqual(connectionCredentials('binance', input), { exchange: 'binance', ...pair });
  assert.deepEqual(connectionCredentials('hyperliquid', input), { exchange: 'hyperliquid', walletAddress: 'address' });
  assert.deepEqual(connectionCredentials('variational', input), { exchange: 'variational', vrToken: 'token' });
});
