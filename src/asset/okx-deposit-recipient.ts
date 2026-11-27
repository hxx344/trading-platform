import { anySignal } from '../any-signal.mjs';
import { isObject } from '../contracts.ts';
import { OKX_DIRECTORY_TTL, type OkxDirectory, type OkxNetwork, type OkxRecipient } from '../chain-arb/okx-network.ts';
import type { Chain } from '../chain-arb/model.ts';
import { untilAborted } from './sources/shared-reads.ts';
import { OkxReadThrottle } from './sources/okx.ts';

const invalid = () => new Error('未核实 OKX 在此网络当前选中的充值地址');
type Answer = { rows: unknown[]; at: number };
type Selection = { recipients: Map<Chain, OkxRecipient>; at: number; expiresAt: number };
type Work = { controller: AbortController; promise: Promise<Selection>; users: number };
type Entry = { latest?: Selection; job?: Work; retryAt: number };
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

function selected(rows: unknown[], symbol: string, dir: OkxDirectory, networkNames: WeakMap<OkxNetwork, string>,
  chainOf: (label: string) => Chain | undefined, expiresAt: number) {
  if (rows.length > 512 || rows.some(r => !isObject(r) || r.ccy !== symbol || typeof r.chain !== 'string' || !r.chain)) throw invalid();
  const recipients = new Map<Chain, OkxRecipient>();
  for (const network of dir.rows) {
    if (network.symbol !== symbol || !network.depositEligible) continue;
    // The account response includes old addresses. Count all non-historical rows before trusting any of their fields.
    const matches = rows.filter(r => isObject(r) && typeof r.chain === 'string' && chainOf(r.chain) === network.chain && r.selected !== false);
    if (matches.length !== 1) continue;
    const r = matches[0];
    if (!isObject(r) || r.selected !== true || r.chain !== networkNames.get(network) || (r.to !== '6' && r.to !== '18')
      || typeof r.addr !== 'string' || !EVM_ADDRESS.test(r.addr) || /^0x0{40}$/i.test(r.addr)
      || typeof r.ctAddr !== 'string' || !/^[0-9a-f]{6}$/i.test(r.ctAddr) || !network.address.endsWith(r.ctAddr.toLowerCase())
      || ['tag', 'memo', 'pmtId'].some(key => Object.hasOwn(r, key) && r[key] !== '')
      || (Object.hasOwn(r, 'addrEx') && r.addrEx !== '' && !(isObject(r.addrEx) && !Object.keys(r.addrEx).length))) continue;
    // Keep even accidental IPC/JSON serialization from containing the account's deposit address.
    const address = r.addr.toLowerCase();
    recipients.set(network.chain, Object.freeze(Object.defineProperty({ expiresAt }, 'address', { value: address })) as OkxRecipient);
  }
  return recipients;
}

export function createOkxRecipients(now: () => number, current: (directory: OkxDirectory) => boolean,
  networkNames: WeakMap<OkxNetwork, string>, chainOf: (label: string) => Chain | undefined,
  load: (dir: OkxDirectory, symbol: string, signal: AbortSignal) => Promise<Answer>) {
  const entries = new WeakMap<OkxDirectory, Map<string, Entry>>();
  const issued = new WeakMap<OkxRecipient, { directory: OkxDirectory; entry: Entry; selection: Selection }>();
  const starts: number[] = [];
  let retryAt = 0, running = 0;
  function recipientCurrent(directory: OkxDirectory, recipient: OkxRecipient) {
    const proof = issued.get(recipient);
    if (!proof || proof.directory !== directory || proof.entry.latest !== proof.selection || !current(directory)) return false;
    const at = now();
    if (at >= proof.selection.at && at < recipient.expiresAt) return true;
    delete proof.entry.latest;
    return false;
  }
  function start(dir: OkxDirectory, symbol: string, entry: Entry): Work {
    const at = now();
    while (starts.length && at - starts[0]! >= 1000) starts.shift();
    if (at < Math.max(retryAt, entry.retryAt) || starts.length >= 6 || running >= 4) throw invalid();
    starts.push(at); running++;
    const controller = new AbortController(), signal = anySignal([controller.signal], 8_000);
    async function read() {
      try {
        const answer = await load(dir, symbol, signal);
        signal.throwIfAborted();
        const expiresAt = Math.min(dir.expiresAt, answer.at + OKX_DIRECTORY_TTL);
        if (!current(dir) || now() < at || now() >= expiresAt) throw invalid();
        const recipients = selected(answer.rows, symbol, dir, networkNames, chainOf, expiresAt);
        const selection = { recipients, expiresAt, at: answer.at };
        for (const proof of recipients.values()) issued.set(proof, { directory: dir, entry, selection });
        entry.latest = selection;
        return selection;
      } catch (error) {
        if (error instanceof OkxReadThrottle) retryAt = now() + 60_000;
        if (!signal.aborted) {
          entry.retryAt = now() + 3000;
        }
        throw invalid();
      }
    }
    const promise = untilAborted(read(), signal).finally(() => { running--; });
    promise.catch(() => {});
    return { controller, users: 0, promise };
  }
  async function recipient(dir: OkxDirectory, symbol: string, chain: Chain, contract: string, signal: AbortSignal) {
    try {
      signal.throwIfAborted();
      if (!current(dir) || !dir.rows.some(r => r.symbol === symbol && r.chain === chain && r.address === contract && r.depositEligible)) throw invalid();
      let coins = entries.get(dir);
      if (!coins) entries.set(dir, coins = new Map());
      let entry = coins.get(symbol);
      if (!entry) coins.set(symbol, entry = { retryAt: 0 });
      let value = entry.latest;
      if (!value || now() < value.at || now() >= value.expiresAt) {
        delete entry.latest;
        if (!entry.job || entry.job.controller.signal.aborted) entry.job = start(dir, symbol, entry);
        const job = entry.job;
        if (job.users >= 16) throw invalid();
        job.users++;
        try { value = await untilAborted(job.promise, signal); }
        finally {
          if (--job.users === 0) {
            job.controller.abort();
            if (entry.job === job) delete entry.job;
          }
        }
      }
      const proof = value.recipients.get(chain);
      signal.throwIfAborted();
      if (!proof || !recipientCurrent(dir, proof)) throw invalid();
      return proof;
    } catch { throw invalid(); }
  }
  return { okxDepositRecipient: recipient, okxDepositRecipientCurrent: recipientCurrent };
}
