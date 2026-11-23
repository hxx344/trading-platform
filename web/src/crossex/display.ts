export function format(value: number | string | null | undefined, digits = 2) {
  if (value == null || typeof value === 'string' && !value.trim()) return '—';
  const number = Number(value);
  return !Number.isFinite(number) ? '—' : number.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '暂无时间';
export const venues: Record<string, string> = { binance: 'Binance', bybit: 'Bybit', okx: 'OKX', gate: 'Gate', kraken: 'Kraken', hyperliquid: 'Hyperliquid', lighter: 'Lighter', deribit: 'Deribit' };
export const venue = (name: string) => venues[name] || name;
export const direction = (row: { long: { exchange: string }; short: { exchange: string } }) => `${venue(row.long.exchange)} 做多 → ${venue(row.short.exchange)} 做空`;
export const signedClass = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'muted' : value < 0 ? 'negative' : 'positive';
