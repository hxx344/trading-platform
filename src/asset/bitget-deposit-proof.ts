import { BITGET_DEPOSIT_TTL } from '../chain-arb/bitget-deposit-proof.ts';
import type { Unseal } from './positions-service.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { BitgetReadThrottle, bitgetDepositUnavailable, readBitgetAddress, readBitgetNetworks, verifyBitgetAccount, type BitgetCredential } from './sources/bitget-deposit.ts';
import { untilAborted } from './sources/shared-reads.ts';
import { parseConnection } from './validation.ts';
import { createWalletDepositSource, type WalletConnection } from './wallet-deposit-source.ts';

export function createBitgetDepositSource(connection: () => WalletConnection | null, unseal: Unseal, fetcher: typeof fetch, now: () => number) {
  const source = createWalletDepositSource<BitgetCredential>({
    name: 'bitget', ttl: BITGET_DEPOSIT_TTL, invalid: bitgetDepositUnavailable,
    parse(raw) {
      const c = parseConnection(raw);
      if (c.exchange !== 'bitget') throw bitgetDepositUnavailable();
      return c;
    },
    sameKey: (a, b) => a.apiKey === b.apiKey && a.apiSecret === b.apiSecret && a.passphrase === b.passphrase,
    throttleDelay: e => e instanceof BitgetReadThrottle ? e.delay : 0,
    networks: readBitgetNetworks, address: readBitgetAddress,
  }, connection, unseal, fetcher, now);
  return { bitgetDepositConnected: source.connected, bitgetDepositProof: source.proof, bitgetDepositCurrent: source.current, bitgetDepositRecipient: source.recipient,
    async verifyConnection(c: BitgetCredential) {
      const signal = AbortSignal.timeout(8_000);
      const check = () => {
        signal.throwIfAborted();
        const remaining = source.throttleRemaining();
        if (remaining > 0) throw new BitgetReadThrottle(remaining);
      };
      check();
      const deny = source.watchReconnect(c);
      const read = verifyBitgetAccount({ credential: c, fetcher, now, signal, deniedAt: source.revocationTime(c),
        check }).catch(error => {
          source.recordThrottle(error);
          if (error instanceof PositionsPermissionError) deny?.();
          throw error;
        });
      try {
        const at = await untilAborted(read, signal);
        if (at <= source.revocationTime(c) || now() < at || now() >= at + BITGET_DEPOSIT_TTL) throw bitgetDepositUnavailable();
        return at;
      } catch (error) {
        if (error instanceof PositionsPermissionError || error instanceof BitgetReadThrottle) throw error;
        throw bitgetDepositUnavailable();
      }
    },
    reset: source.reset, close: source.close };
}
