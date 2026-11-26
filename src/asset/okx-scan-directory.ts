import { randomBytes } from 'node:crypto';
import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { isSettlementOrNative } from '../chain-arb/networks.ts';
import { isGateBaseSymbol, type Chain } from '../chain-arb/model.ts';
import { OKX_DIRECTORY_TTL, assertOkxDirectory, type OkxDirectory, type OkxNetwork } from '../chain-arb/okx-network.ts';
import type { AssetDb } from './db.ts';
import { historyGeneration } from './history-cache.ts';
import { revisionOf, type Unseal } from './positions-service.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { parseConnection } from './validation.ts';
import { readOkxCurrencies } from './sources/okx.ts';
import { untilAborted } from './sources/shared-reads.ts';

const UNAVAILABLE = 'OKX 币链目录不可用，请核对资产账本连接和只读权限';
const NETWORKS: ReadonlyMap<string, Chain> = new Map([
  ['ERC20', 'ethereum'], ['Ethereum', 'ethereum'], ['Arbitrum One', 'arbitrum'],
  ['BSC', 'bsc'], ['BEP20', 'bsc'], ['BNB Smart Chain', 'bsc'], ['Binance Smart Chain', 'bsc'],
]);
const ADDRESS = /^0x[\da-f]{40}$/i;
const AMOUNT = /^(?:0|[1-9]\d{0,77})(?:\.\d{1,78})?$/;
const zero = (value: unknown) => value === '' || (typeof value === 'string' && /^0+(?:\.0+)?$/.test(value));

function depositAllowed(row: Record<string, unknown>, minimum: string | undefined) {
  // needTag and burningFeeRate in Get currencies apply to withdrawals. Only deposit conditions affect this route.
  return row.canDep === true && minimum !== undefined
    && row.depQuotaFixed === '' && row.usedDepQuotaFixed === '' && row.depQuoteDailyLayer2 === '' && row.depEstOpenTime === ''
    && ['depFee', 'depFeeRate', 'depositFee', 'depositFeeRate'].every(key => !Object.hasOwn(row, key) || zero(row[key]))
    && ['tag', 'memo', 'pmtId', 'addrEx', 'depTag', 'depMemo'].every(key => !Object.hasOwn(row, key) || row[key] === '');
}

function networks(raw: unknown[]): OkxNetwork[] {
  if (!raw.length || raw.length > 12_000) throw new Error(UNAVAILABLE);
  const bySymbol = new Map<string, OkxNetwork | null>(), addresses = new Set<string>(), conflicts = new Set<string>();
  for (const row of raw) {
    if (!isObject(row) || typeof row.ccy !== 'string' || !row.ccy || typeof row.chain !== 'string' || !row.chain) throw new Error(UNAVAILABLE);
    const split = row.chain.lastIndexOf('-');
    const chain = split < 1 ? undefined : NETWORKS.get(row.chain.slice(split + 1));
    if (!chain) continue;
    const symbol = row.ccy, chainSymbol = row.chain.slice(0, split), key = chain + ':' + symbol;
    const address = typeof row.ctAddr === 'string' && ADDRESS.test(row.ctAddr) ? row.ctAddr.toLowerCase() : undefined;
    if (address) {
      const identity = chain + ':' + address;
      if (addresses.has(identity)) conflicts.add(identity);
      addresses.add(identity);
    }
    // Record conflicting evidence even when the second row has no usable address, or its ticker is ineligible.
    if (chainSymbol !== symbol) bySymbol.set(chain + ':' + chainSymbol, null);
    if (bySymbol.has(key) || chainSymbol !== symbol || !isGateBaseSymbol(symbol) || !address || isSettlementOrNative(chain, address)
      || ((chain === 'arbitrum' || chain === 'ethereum') && symbol === 'ETH') || (chain === 'bsc' && symbol === 'BNB')) {
      bySymbol.set(key, null);
      continue;
    }
    const minimum = typeof row.minDep === 'string' && AMOUNT.test(row.minDep) ? row.minDep : undefined;
    bySymbol.set(key, { symbol, chain, address, deposit: typeof row.canDep === 'boolean' ? row.canDep : null,
      withdraw: typeof row.canWd === 'boolean' ? row.canWd : null, depositEligible: depositAllowed(row, minimum), minDeposit: minimum ?? '0' });
  }
  return [...bySymbol.values()].filter((row): row is OkxNetwork => !!row && !conflicts.has(row.chain + ':' + row.address));
}

type Connection = { database: AssetDb; importedAt: string; encrypted: string };
type Job = { controller: AbortController; work: Promise<OkxDirectory>; waiters: number };
type Scope = Connection & { id: string; stop: AbortController; permission: ReturnType<typeof historyGeneration>; latest?: OkxDirectory; job?: Job };

export function createOkxScanDirectory(connection: () => Connection | null, unseal: Unseal, fetcher: typeof fetch, now: () => number) {
  let scope: Scope | undefined, closed = false;
  function reset() {
    const old = scope;
    scope = undefined;
    old?.stop.abort();
  }
  function observed() {
    if (closed) return;
    let found: Connection | null;
    try { found = connection(); } catch { reset(); throw new Error(UNAVAILABLE); }
    if (scope && (found?.database !== scope.database || found.encrypted !== scope.encrypted || found.importedAt !== scope.importedAt
      || !scope.permission.current())) reset();
    if (!scope && found) {
      scope = { ...found, id: randomBytes(16).toString('hex'), stop: new AbortController(),
        permission: historyGeneration(() => found.database, 'okx', revisionOf(found.encrypted), now) };
    }
    return scope;
  }
  function current(directory: OkxDirectory): boolean {
    try {
      const saved = observed(), at = now();
      if (saved?.latest && (at < saved.latest.at || at >= saved.latest.expiresAt)) delete saved.latest;
      return !!saved?.latest && saved.latest === directory;
    } catch { reset(); return false; }
  }
  function start(saved: Scope): Job {
    delete saved.latest;
    const controller = new AbortController(), started = now();
    const signal = anySignal([saved.stop.signal, saved.permission.signal, controller.signal], 12_000);
    function check() {
      signal.throwIfAborted();
      if (observed() !== saved || now() < started) throw new Error(UNAVAILABLE);
    }
    const read = async () => {
      const c = parseConnection(unseal(saved.encrypted, 'okx'));
      if (c.exchange !== 'okx') throw new Error(UNAVAILABLE);
      const value = await readOkxCurrencies(c, fetcher, { signal, now, deniedAt: saved.permission.deniedAt }, check).catch(error => {
        // A permission denial also revokes the ledger's position and fill evidence for this exact credential.
        if (error instanceof PositionsPermissionError) { check(); saved.permission.deny(); }
        throw error;
      });
      check();
      const directory = { connection: saved.id, at: value.at, expiresAt: value.at + OKX_DIRECTORY_TTL, rows: networks(value.rows) };
      assertOkxDirectory(directory, now());
      for (const row of directory.rows) Object.freeze(row);
      Object.freeze(directory.rows);
      saved.latest = Object.freeze(directory);
      return directory;
    };
    return { controller, work: untilAborted(read(), signal), waiters: 0 };
  }
  return {
    okxScanDirectoryCurrent: current,
    async okxScanDirectory(signal: AbortSignal): Promise<OkxDirectory> {
      try {
        signal.throwIfAborted();
        const saved = observed();
        if (!saved) throw new Error(UNAVAILABLE);
        if (saved.latest && current(saved.latest)) return saved.latest;
        if (!saved.job || saved.job.controller.signal.aborted) saved.job = start(saved);
        const job = saved.job;
        job.waiters++;
        try {
          const directory = await untilAborted(job.work, signal);
          signal.throwIfAborted();
          if (!current(directory)) throw new Error(UNAVAILABLE);
          return directory;
        } finally {
          if (--job.waiters === 0) {
            job.controller.abort();
            if (saved.job === job) delete saved.job;
          }
        }
      } catch (error) {
        if (error instanceof PositionsPermissionError) throw new Error('OKX 连接未能确认只读权限');
        throw new Error(UNAVAILABLE);
      }
    },
    reset,
    close() { closed = true; reset(); },
  };
}
