import type { Ledger } from '../../src/asset/types.ts';
import { EXCHANGE_NAMES } from '../../src/asset/views.ts';

const { 'dex-spread': _dexSpread, ...LEDGER_EXCHANGE_NAMES } = EXCHANGE_NAMES;
export type ConnectionExchange = keyof Ledger['connections'];
export const CONNECTION_NAMES: Record<ConnectionExchange, string> = { ...LEDGER_EXCHANGE_NAMES, bitget: 'Bitget' };
export type CardExchange = Exclude<ConnectionExchange, 'aster'>;
export type BitgetMode = NonNullable<Ledger['connections']['bitget']['accountMode']>;

type ConnectionForm = {
  key: string; secret: string; passphrase: string; accountMode: BitgetMode; region: string;
  walletAddress: string; vrToken: string;
};

export function connectionCredentials(exchange: CardExchange, form: ConnectionForm) {
  if (exchange === 'variational') return { exchange, vrToken: form.vrToken.trim() };
  if (exchange === 'hyperliquid' || exchange === 'rh-lighter') return { exchange, walletAddress: form.walletAddress.trim() };
  const credentials = { exchange, apiKey: form.key.trim(), apiSecret: form.secret.trim() };
  if (exchange === 'bybit') return { ...credentials, region: form.region };
  if (exchange === 'okx') return { ...credentials, passphrase: form.passphrase.trim() };
  if (exchange === 'bitget') return { ...credentials, accountMode: form.accountMode, passphrase: form.passphrase.trim() };
  return credentials;
}
