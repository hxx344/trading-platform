import { gateChain } from '../../chain-arb/gate.ts';
import { GATE_DEPOSIT_TTL, type GateDepositProof } from '../../chain-arb/gate-deposit-proof.ts';
import { CHAIN_ARB_CLOCK_SKEW_MS, isGateBaseSymbol, type Chain } from '../../chain-arb/model.ts';
import { isObject } from '../../contracts.ts';
import { gateAuthHeaders, type GateCredentials } from '../../vendor/gate.mjs';
import { readJsonResponse } from '../../vendor/response.mjs';
import { PositionsPermissionError } from '../positions-values.ts';
import { gateAccessDenied } from './gate.ts';

const ADDRESS_PATH = '/api/v4/wallet/deposit_address', FEE_PATH = '/api/v4/wallet/withdraw_status';
export const GATE_DEPOSIT_UNAVAILABLE = 'Gate 充值网络或最低充值量无法核实，请检查资产账本连接及钱包读取权限';
export class GateDepositThrottle extends Error {}
const invalid = () => new Error(GATE_DEPOSIT_UNAVAILABLE);
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const MINIMUM = /^(?:0|[1-9]\d{0,59})(?:\.\d{1,18})?$/;

// The root minimum is denominated in the requested currency. Only the selected chain's address
// establishes availability. Neither that account address nor the default address is a token contract.
function project(raw: unknown, symbol: string, at: number) {
  if (!isObject(raw) || 'label' in raw || raw.currency !== symbol || typeof raw.address !== 'string'
    || typeof raw.min_deposit_amount !== 'string' || !MINIMUM.test(raw.min_deposit_amount)
    || !Array.isArray(raw.multichain_addresses) || raw.multichain_addresses.length > 256) throw invalid();
  const expiresAt = at + GATE_DEPOSIT_TTL;
  const rows = new Map<Chain, GateDepositProof>(), seen = new Set<Chain>();
  for (const row of raw.multichain_addresses) {
    if (!isObject(row) || typeof row.chain !== 'string' || !row.chain) throw invalid();
    const chain = gateChain(row.chain);
    if (!chain) continue;
    if (seen.has(chain)) { rows.delete(chain); continue; }
    seen.add(chain);
    if (row.obtain_failed !== 0 || typeof row.address !== 'string' || !ADDRESS.test(row.address)
      || /^0x0{40}$/i.test(row.address) || row.payment_id !== '' || row.payment_name !== ''
      || ['memo', 'tag'].some(key => Object.hasOwn(row, key) && row[key] !== '')
      || (Object.hasOwn(row, 'min_deposit_amount') && row.min_deposit_amount !== raw.min_deposit_amount)) continue;
    rows.set(chain, Object.freeze({ symbol, chain, minDeposit: raw.min_deposit_amount, at, expiresAt }));
  }
  return { rows, at, expiresAt };
}

export async function readGateDeposit(c: GateCredentials, symbol: string, fetcher: typeof fetch, signal: AbortSignal,
  now: () => number, deniedAt: number, check: () => void) {
  if (!isGateBaseSymbol(symbol)) throw invalid();
  const query = 'currency=' + encodeURIComponent(symbol);
  async function get(path: typeof ADDRESS_PATH | typeof FEE_PATH) {
    check();
    const start = now(), timestamp = String(Math.floor(start / 1000));
    const response = await fetcher('https://api.gateio.ws' + path + '?' + query, { method: 'GET',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...gateAuthHeaders(c, { method: 'GET', path, query, timestamp }) },
      redirect: 'manual', cache: 'no-store', signal });
    if (response.status !== 200 || response.redirected || response.headers.has('content-range')) {
      void response.body?.cancel().catch(() => {});
      if (!response.redirected && gateAccessDenied(response.status)) throw new PositionsPermissionError(GATE_DEPOSIT_UNAVAILABLE);
      if (response.status === 429) throw new GateDepositThrottle(GATE_DEPOSIT_UNAVAILABLE);
      throw invalid();
    }
    const raw: unknown = await readJsonResponse(response, { maxBytes: 64 * 1024, signal });
    check();
    if (isObject(raw) && Object.hasOwn(raw, 'label') && gateAccessDenied(response.status, raw.label)) throw new PositionsPermissionError(GATE_DEPOSIT_UNAVAILABLE);
    const age = response.headers.get('age'), date = Date.parse(response.headers.get('date') ?? '');
    // Age is in whole seconds. Round its uncertainty toward an older response, including after revocation.
    const earliest = age === null ? start : start - Number(age) * 1000 - 999;
    const at = Math.min(start, earliest, date);
    if ((age !== null && !/^\d{1,9}$/.test(age)) || !Number.isSafeInteger(at) || at <= 0 || at <= deniedAt
      || now() < start || date > now() + CHAIN_ARB_CLOCK_SKEW_MS || now() - at >= GATE_DEPOSIT_TTL) {
      throw invalid();
    }
    return { raw, at };
  }
  async function zeroFeeAt() {
    const { raw, at } = await get(FEE_PATH);
    if (!Array.isArray(raw) || raw.length !== 1 || !isObject(raw[0]) || raw[0].currency !== symbol
      || typeof raw[0].deposit !== 'string' || !/^0(?:\.0{1,18})?%?$/.test(raw[0].deposit)) throw invalid();
    return at;
  }
  try {
    const feeAt = await zeroFeeAt();
    const { raw, at } = await get(ADDRESS_PATH);
    return project(raw, symbol, Math.min(at, feeAt));
  } catch (error) {
    if (error instanceof PositionsPermissionError) throw new PositionsPermissionError(GATE_DEPOSIT_UNAVAILABLE);
    if (error instanceof GateDepositThrottle) throw new GateDepositThrottle(GATE_DEPOSIT_UNAVAILABLE);
    throw invalid();
  }
}
