import { isObject } from '../contracts.ts';
import { isGateBaseSymbol, type Chain } from './model.ts';
import { isSettlementOrNative } from './networks.ts';

export interface OkxNetwork {
  symbol: string; chain: Chain; address: string;
  deposit: boolean | null; withdraw: boolean | null; depositEligible: boolean; minDeposit: string;
}
export interface OkxDirectory { connection: string; at: number; expiresAt: number; rows: OkxNetwork[] }
export interface OkxDirectorySource {
  okxScanDirectory(signal: AbortSignal): Promise<OkxDirectory>;
  okxScanDirectoryCurrent(directory: OkxDirectory): boolean;
}
export const OKX_DIRECTORY_TTL = 60_000;

export function assertOkxDirectory(raw: unknown, now: number): asserts raw is OkxDirectory {
  const invalid = () => new Error('OKX 链目录格式无效或已过期');
  if (!isObject(raw) || Object.keys(raw).length !== 4 || typeof raw.connection !== 'string' || !/^[a-f0-9]{32}$/.test(raw.connection)
    || typeof raw.at !== 'number' || !Number.isSafeInteger(raw.at) || raw.at <= 0 || raw.at > now
    || typeof raw.expiresAt !== 'number' || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt <= now
    || raw.expiresAt - raw.at > OKX_DIRECTORY_TTL || !Array.isArray(raw.rows) || raw.rows.length > 4000) throw invalid();
  const symbols = new Set<string>(), addresses = new Set<string>();
  for (const row of raw.rows) {
    if (!isObject(row) || Object.keys(row).length !== 7 || !isGateBaseSymbol(row.symbol)
      || (row.chain !== 'ethereum' && row.chain !== 'arbitrum' && row.chain !== 'bsc')
      || typeof row.address !== 'string' || !/^0x[a-f0-9]{40}$/.test(row.address) || isSettlementOrNative(row.chain, row.address)
      || (row.deposit !== null && typeof row.deposit !== 'boolean') || (row.withdraw !== null && typeof row.withdraw !== 'boolean')
      || typeof row.depositEligible !== 'boolean' || (row.depositEligible && row.deposit !== true) || typeof row.minDeposit !== 'string'
      || !/^(?:0|[1-9]\d{0,77})(?:\.\d{1,78})?$/.test(row.minDeposit)) throw invalid();
    const symbol = row.chain + ':' + row.symbol, address = row.chain + ':' + row.address;
    if (symbols.has(symbol) || addresses.has(address)) throw invalid();
    symbols.add(symbol); addresses.add(address);
  }
}
