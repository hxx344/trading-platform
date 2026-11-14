// The optional monitor part of config.json: which read-only market monitors run (M-1: the Anthropic premium, M-2a: the oil
// spread). No key is needed; the venues' public endpoints are read.
import { ContractError, exactKeys } from '../contracts.ts';
import { ANTHROPIC_SHARES, type AnthropicShares } from '../vendor/anthropic-market.mjs';

export interface MonitorConfig {
  /** Share counts in billions, the basis of every per-share comparison (anthropic-market.mjs). */
  anthropic?: { shares: AnthropicShares };
  /** Brent − WTI on Binance; takes no settings. */
  oil?: Record<string, never>;
}
export const MONITOR_MARKETS = ['anthropic', 'oil'] as const;
export type MonitorMarket = typeof MONITOR_MARKETS[number];
export const MONITOR_LABELS: Record<MonitorMarket, string> = { anthropic: 'Anthropic 价差', oil: '原油价差' };
/** The configured markets, in MONITOR_MARKETS order. */
export const monitorMarkets = (config: MonitorConfig): MonitorMarket[] => MONITOR_MARKETS.filter(market => config[market] !== undefined);

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';
const billions = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`monitor.anthropic.shares.${name} 须为数字（十亿股）`);
  return value;
};

/** { anthropic?: { shares?: { outstanding, diluted } }, oil?: {} }; at least one market. The share bounds are the workbench's. */
export function parseMonitorConfig(value: unknown): MonitorConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, [], [...MONITOR_MARKETS]); } catch (error) { throw new Error(`monitor 无效：${reason(error)}`); }
  if (MONITOR_MARKETS.every(market => raw[market] === undefined)) throw new Error(`monitor 须至少配置一个市场（${MONITOR_MARKETS.join('、')}）`);
  const config: MonitorConfig = {};
  if (raw.anthropic !== undefined) config.anthropic = { shares: parseAnthropic(raw.anthropic) };
  if (raw.oil !== undefined) {
    try { exactKeys(raw.oil, []); } catch (error) { throw new Error(`monitor.oil 无效（不带设置，写 {}）：${reason(error)}`); }
    config.oil = {};
  }
  return config;
}

function parseAnthropic(value: unknown): AnthropicShares {
  let anthropic: Record<string, unknown>;
  try { anthropic = exactKeys(value, [], ['shares']); } catch (error) { throw new Error(`monitor.anthropic 无效：${reason(error)}`); }
  if (anthropic.shares === undefined) return { outstanding: ANTHROPIC_SHARES.outstanding, diluted: ANTHROPIC_SHARES.diluted };
  let input: Record<string, unknown>;
  try { input = exactKeys(anthropic.shares, ['outstanding', 'diluted']); } catch (error) { throw new Error(`monitor.anthropic.shares 无效（须为 { outstanding, diluted }，十亿股）：${reason(error)}`); }
  const shares = { outstanding: billions(input.outstanding, 'outstanding'), diluted: billions(input.diluted, 'diluted') };
  if (!(shares.outstanding >= 1 && shares.outstanding <= shares.diluted && shares.diluted <= 100)) throw new Error('monitor.anthropic.shares 须满足 1 ≤ outstanding ≤ diluted ≤ 100（十亿股）');
  return shares;
}

/** For --check-config; empty without monitor so that output stays as it was. */
export function monitorSummary(monitor: MonitorConfig | undefined): string {
  if (!monitor) return '';
  const parts: string[] = [];
  if (monitor.anthropic) parts.push(`Anthropic 价差（流通股 ${monitor.anthropic.shares.outstanding} 十亿、完全稀释 ${monitor.anthropic.shares.diluted} 十亿股）`);
  if (monitor.oil) parts.push('原油价差（Binance 布伦特 − WTI）');
  return `，行情监控 ${parts.join('、')}`;
}
