import assert from 'node:assert/strict';
import test from 'node:test';
import { chainArbQuery, initialChainArbForm, readTimedChainArb } from '../src/chain-arb-form.ts';
import { parseChainArb } from '../../src/chain-arb/model.ts';

test('normalizes pasted token identifiers, preserves the budget, and distinguishes blank costs from zero', () => {
  const { path, input } = chainArbQuery({
    ...initialChainArbForm, amount: ' 0.000001 ', symbol: ' arb ', spotCosts: ' ', perpCosts: '0',
  });
  const url = new URL(path, 'http://localhost');
  assert.equal(url.pathname, '/api/monitor/perpetual/chain-arb');
  assert.equal(url.searchParams.get('address'), initialChainArbForm.address.toLowerCase());
  assert.equal(url.searchParams.get('symbol'), 'ARB');
  assert.equal(url.searchParams.get('amount'), '0.000001');
  assert.equal(url.searchParams.has('spotCosts'), false);
  assert.equal(url.searchParams.get('perpCosts'), '0');
  assert.deepEqual(parseChainArb(Object.fromEntries(url.searchParams)), input);
});

test('blocks invalid drafts before a quote request can start', () => {
  for (const patch of [{ symbol: 'ARB/USDT' }, { address: '0x123' }, { chain: 'other' }, { amount: '0' },
    { amount: '0.0000001' }, { spotFeeBps: '100.01' }, { perpCosts: '-1' }]) {
    assert.throws(() => chainArbQuery({ ...initialChainArbForm, ...patch }));
  }
});

test('a quote that used up its remaining lifetime in transit is already expired on arrival', async () => {
  let elapsed = 100;
  const response = await readTimedChainArb(async () => {
    elapsed += 250;
    return { asOf: 1_800_000_000_000, expiresAt: 1_800_000_000_200 };
  }, () => elapsed);
  assert.equal(response.deadline, 300);
  assert.ok(response.deadline <= elapsed);
});

test('every refresh uses its own request start and does not renew the preceding quote', async () => {
  let elapsed = 100;
  const load = () => readTimedChainArb(async () => {
    elapsed += 50;
    return { asOf: 1_000_000 + elapsed, expiresAt: 1_000_200 + elapsed };
  }, () => elapsed);
  const first = await load();
  elapsed = 10_100;
  const second = await load();
  assert.equal(first.deadline, 300);
  assert.equal(second.deadline, 10_300);
  assert.equal(second.deadline - elapsed, 150);
});
