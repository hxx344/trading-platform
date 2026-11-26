import { isObject } from '../contracts.ts';
import type { createChainArbMarket } from '../chain-arb/read.ts';
import { parseChainArb } from '../chain-arb/model.ts';
import { parseChainArbScan, type ScanView } from '../chain-arb/scan-model.ts';
import { assertOkxDirectory, type OkxDirectory, type OkxDirectorySource } from '../chain-arb/okx-network.ts';

type Market = Pick<ReturnType<typeof createChainArbMarket>, 'chainArb' | 'scanChainArb'>;
const unavailable = (message: string) => Object.assign(new Error(message), { status: 503 });

/** The executor alone can ask the ledger for a directory. HTTP callers supply ordinary quote settings only. */
export function withChainArbLedger(market: Market, ledger?: OkxDirectorySource, now = Date.now) {
  const evidence = new WeakMap<ScanView, OkxDirectory>();
  async function verified<T>(signal: AbortSignal, read: (directory: OkxDirectory) => Promise<T>) {
    if (!ledger) throw unavailable('请启用资产账本并连接 OKX 只读账户');
    const directory = await ledger.okxScanDirectory(signal);
    signal.throwIfAborted();
    assertOkxDirectory(directory, now());
    const current = () => {
      if (!ledger.okxScanDirectoryCurrent(directory)) throw unavailable('OKX 只读连接或币链目录已变更，请重新核验');
    };
    current();
    const value = await read(directory);
    signal.throwIfAborted();
    current();
    return { value, directory };
  }
  return {
    async chainArb(raw: unknown, signal: AbortSignal) {
      if (!isObject(raw) || raw.venue !== 'okx') return market.chainArb(raw, signal);
      parseChainArb(raw);
      return (await verified(signal, dir => market.chainArb(raw, signal, dir))).value;
    },
    async scanChainArb(raw: unknown, scope: string, signal: AbortSignal, awaitBatch = false) {
      if (!isObject(raw) || raw.venue !== 'okx') return market.scanChainArb(raw, scope, signal, awaitBatch);
      parseChainArbScan(raw);
      const { value, directory } = await verified(signal, dir => market.scanChainArb(raw, scope, signal, awaitBatch, dir));
      evidence.set(value, directory);
      return value;
    },
    okxResultCurrent(view: ScanView) {
      const directory = evidence.get(view);
      return !!directory && !!ledger?.okxScanDirectoryCurrent(directory);
    },
  };
}
