import assert from 'node:assert/strict';
import type { ChainArbInput } from '../src/chain-arb/model.ts';
import type { OkxDirectory, OkxNetwork } from '../src/chain-arb/okx-network.ts';
import { createOkxReader } from '../src/chain-arb/okx.ts';
import type { VenueFetch } from '../src/chain-arb/venue.ts';

const now = 1_795_690_885_886;
const address = '0x912ce59144191c1204e64559fe8253a0e49e6548';
const input: ChainArbInput = { venue: 'okx', chain: 'arbitrum', symbol: 'ARB', address, amount: '10',
  spotFeeBps: 10, perpFeeBps: 5, spotCosts: 0, perpCosts: 0 };
const network: OkxNetwork = { symbol: 'ARB', chain: 'arbitrum', address, deposit: true, withdraw: false, depositEligible: true, minDeposit: '0.15' };
const wallet = (rows = [network], at = now): OkxDirectory => ({ rows, connection: 'a'.repeat(32), at, expiresAt: at + 60_000 });
const common = { state: 'live', ruleType: 'normal', instCategory: '1', expTime: '', listTime: String(now - 100_000),
  lotSz: '0.1', minSz: '0.2', upcChg: [] };
const pair = { ...common, instId: 'ARB-USDT', instType: 'SPOT', baseCcy: 'ARB', quoteCcy: 'USDT',
  tradeQuoteCcyList: ['USDT'], contTdSwTime: '', maxMktSz: '120', maxMktAmt: '125' };
const perp = { ...common, instId: 'ARB-USDT-SWAP', instType: 'SWAP', ctType: 'linear', instFamily: 'ARB-USDT',
  uly: 'ARB-USDT', ctValCcy: 'ARB', ctVal: '0.25', ctMult: '2', settleCcy: 'USDT', maxMktSz: '10',
  maxPlatOILmt: '', maxPlatOICoinLmt: '' };
const book = { bids: [['10', '1', '0', '1'], ['9', '2', '0', '1'], ['8', '10', '0', '2']], ts: String(now - 10) };
const band = { instId: pair.instId, instType: 'MARGIN', sellLmt: '8.5', enabled: true, ts: String(now - 20) };
const index = { instId: 'USDT-USD', idxPx: '1.25', ts: String(now - 30) };
const openInterest = { instId: perp.instId, instType: 'SWAP', oiUsd: '90', oiCcy: '20', ts: String(now - 40) };
const data = () => ({ spots: [pair], perps: [perp], spotMeta: [pair], perpMeta: [perp],
  spotBook: [book], perpBook: [book], spotBand: [band], perpBand: [{ ...band, instId: perp.instId, instType: 'SWAP' }],
  index: [index], interest: [openInterest] });
type Data = Record<keyof ReturnType<typeof data>, unknown>;
const path: Record<string, keyof Data> = {
  '/api/v5/public/instruments?instType=SPOT': 'spots', '/api/v5/public/instruments?instType=SWAP': 'perps',
  '/api/v5/public/instruments?instType=SPOT&instId=ARB-USDT': 'spotMeta',
  '/api/v5/public/instruments?instType=SWAP&instId=ARB-USDT-SWAP': 'perpMeta',
  '/api/v5/market/books?instId=ARB-USDT&sz=100': 'spotBook', '/api/v5/market/books?instId=ARB-USDT-SWAP&sz=100': 'perpBook',
  '/api/v5/public/price-limit?instId=ARB-USDT': 'spotBand', '/api/v5/public/price-limit?instId=ARB-USDT-SWAP': 'perpBand',
  '/api/v5/market/index-tickers?instId=USDT-USD': 'index', '/api/v5/public/open-interest?instType=SWAP&instId=ARB-USDT-SWAP': 'interest',
};
export function setupOkxPublic(changes: Partial<Data> = {}) {
  const state = { time: now, wallet: wallet(), onFetch: (_key: string) => {} };
  const available: Data = { ...data(), ...changes }, calls: string[] = [];
  const fetchImpl: VenueFetch = async (url, init) => {
    const endpoint = new URL(url), key = path[endpoint.pathname + endpoint.search];
    assert.equal(endpoint.origin, 'https://www.okx.com');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers!), ['Accept']);
    assert.ok(key);
    calls.push(key);
    state.onFetch(key);
    return available[key] instanceof Response ? available[key].clone() : Response.json({ code: '0', data: available[key] });
  };
  const reader = createOkxReader({ now: () => state.time, fetchImpl }, () => state.wallet);
  return { reader, fetchImpl, state, available, calls };
}

export { now as okxTestNow, input as okxInput, wallet as okxWallet };
export { address, network, pair, perp, book, band, index, openInterest };
