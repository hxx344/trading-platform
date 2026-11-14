// canonicalBase 摘自工作台 server/asset-identity.mjs（提交 7745181），instrumentBase 复制自
// modules/crossex/src/opportunity-import.ts（同一提交）；其余导入相关函数没有搬（不接收 Monitor 机会导入）。
import type { Instrument } from './live-types.ts';

// Verified 1:1 crypto aliases only. Keep native symbols and quantity units intact.
const aliases = new Map([
  ['gate', new Map([['LUNA', 'LUNA2']])],
  ['okx', new Map([['LUNA', 'LUNA2']])],
  ['kraken', new Map([['XBT', 'BTC']])],
]);

export const canonicalBase = (exchange: string, nativeBase: string) => aliases.get(exchange)?.get(nativeBase) ?? nativeBase;

/** The catalog keeps native base names; the picker groups verified 1:1 aliases. */
export const instrumentBase = (instrument: Pick<Instrument, 'exchange' | 'base'>) => canonicalBase(instrument.exchange, instrument.base);
