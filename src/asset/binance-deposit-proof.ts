import { BINANCE_DEPOSIT_TTL } from '../chain-arb/binance-deposit-proof.ts';
import type { Unseal } from './positions-service.ts';
import { binanceDepositUnavailable, readBinanceDepositAddress, readBinanceDepositNetworks } from './sources/binance-deposit.ts';
import { BinanceReadThrottle } from './sources/binance-wallet.ts';
import type { BinanceCredential } from './sources/exchanges.ts';
import { parseConnection } from './validation.ts';
import { createWalletDepositSource, type WalletConnection } from './wallet-deposit-source.ts';

export function createBinanceDepositSource(connection: () => WalletConnection | null, unseal: Unseal, fetcher: typeof fetch, now: () => number) {
  const source = createWalletDepositSource<BinanceCredential>({
    name: 'binance', ttl: BINANCE_DEPOSIT_TTL, invalid: binanceDepositUnavailable,
    parse(raw) {
      const c = parseConnection(raw);
      if (c.exchange !== 'binance') throw binanceDepositUnavailable();
      return c;
    },
    sameKey: (a, b) => a.apiKey === b.apiKey && a.apiSecret === b.apiSecret,
    throttleDelay: e => e instanceof BinanceReadThrottle ? e.delay : 0,
    networks: readBinanceDepositNetworks, address: readBinanceDepositAddress,
  }, connection, unseal, fetcher, now);
  return { binanceDepositProof: source.proof, binanceDepositCurrent: source.current, binanceDepositRecipient: source.recipient,
    watchReconnect: source.watchReconnect, reset: source.reset, close: source.close };
}
