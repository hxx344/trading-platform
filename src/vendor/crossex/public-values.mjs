import { AppError } from './model.mjs';

export const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
export const positive = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) > 0;
export const failure = message => new AppError(message, 502);
export function sourceTime(value, now, maxAge = 10_000) {
  const at = Number(value);
  if (!positive(value) || at < 1e12 || at > now + 1000 || now - at > maxAge) throw failure('来源盘口已经过期或缺少有效时间');
  return at;
}
