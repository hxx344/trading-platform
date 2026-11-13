// The optional monitor part of config.json: which read-only market monitors run (M-1: the Anthropic premium). No key is
// needed; the venues' public endpoints are read.
import { ContractError, exactKeys } from '../contracts.ts';
import { ANTHROPIC_SHARES, type AnthropicShares } from '../vendor/anthropic-market.mjs';

export interface MonitorConfig {
  /** Share counts in billions, the basis of every per-share comparison (anthropic-market.mjs). */
  anthropic: { shares: AnthropicShares };
}
export const MONITOR_MARKETS = ['anthropic'] as const;

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';
const billions = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`monitor.anthropic.shares.${name} 须为数字（十亿股）`);
  return value;
};

/** { anthropic: { shares?: { outstanding, diluted } } }; at least one market. The share bounds are the workbench's. */
export function parseMonitorConfig(value: unknown): MonitorConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, [], [...MONITOR_MARKETS]); } catch (error) { throw new Error(`monitor 无效：${reason(error)}`); }
  if (raw.anthropic === undefined) throw new Error('monitor 须至少配置一个市场（目前只有 anthropic）');
  let anthropic: Record<string, unknown>;
  try { anthropic = exactKeys(raw.anthropic, [], ['shares']); } catch (error) { throw new Error(`monitor.anthropic 无效：${reason(error)}`); }
  let shares: AnthropicShares = { outstanding: ANTHROPIC_SHARES.outstanding, diluted: ANTHROPIC_SHARES.diluted };
  if (anthropic.shares !== undefined) {
    let input: Record<string, unknown>;
    try { input = exactKeys(anthropic.shares, ['outstanding', 'diluted']); } catch (error) { throw new Error(`monitor.anthropic.shares 无效（须为 { outstanding, diluted }，十亿股）：${reason(error)}`); }
    shares = { outstanding: billions(input.outstanding, 'outstanding'), diluted: billions(input.diluted, 'diluted') };
    if (!(shares.outstanding >= 1 && shares.outstanding <= shares.diluted && shares.diluted <= 100)) throw new Error('monitor.anthropic.shares 须满足 1 ≤ outstanding ≤ diluted ≤ 100（十亿股）');
  }
  return { anthropic: { shares } };
}

/** For --check-config; empty without monitor so that output stays as it was. */
export function monitorSummary(monitor: MonitorConfig | undefined): string {
  if (!monitor) return '';
  const { outstanding, diluted } = monitor.anthropic.shares;
  return `，行情监控 Anthropic 价差（流通股 ${outstanding} 十亿、完全稀释 ${diluted} 十亿股）`;
}
