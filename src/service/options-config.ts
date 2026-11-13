// The optional options part of the service's operator files (docs/options.md §3): config.json `options` names the Bybit
// account (UID) and the risk limits, secrets.json `bybitOptions` holds its key. Defaults follow the workbench Greeks
// module. No message built here carries a key, a secret or a field name read from the key file.
import { ContractError, exactKeys } from '../contracts.ts';
import { decimal } from '../decimal.ts';
import { validCredentials, type LiveCredentials } from '../live/values.ts';
import { STRATEGY_MODES, type Estimates, type StrategyMode } from '../options/strategy.ts';

export interface OptionsConfig {
  accountId: string;
  limits: { maxRiskUsd: number; maxMarginUsd: number };
  legQty: string;
  strategyMode: StrategyMode;
  marginMode: Estimates['marginMode'];
  orderTimeoutSeconds: number;
  feeRate: number;
  marginBufferPct: number;
}

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';
function bounded(value: unknown, low: number, high: number, name: string, { integer = false, open = false }: { integer?: boolean; open?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value)) || (open ? value <= low : value < low) || value > high) throw new Error(`options.${name} 须为 ${open ? '大于' : ''}${low}${open ? '' : ' 及以上'}、不超过 ${high} 的${integer ? '整数' : '数字'}`);
  return value;
}

export function parseOptionsConfig(value: unknown): OptionsConfig {
  let raw: Record<string, unknown>, limits: Record<string, unknown>;
  try { raw = exactKeys(value, ['accountId', 'limits'], ['legQty', 'strategyMode', 'marginMode', 'orderTimeoutSeconds', 'feeRate', 'marginBufferPct']); } catch (error) { throw new Error(`options 无效：${reason(error)}`); }
  if (typeof raw.accountId !== 'string' || !/^[1-9]\d{0,19}$/.test(raw.accountId)) throw new Error('options.accountId 须为 Bybit 账户 UID（数字字符串）');
  try { limits = exactKeys(raw.limits, ['maxRiskUsd', 'maxMarginUsd']); } catch (error) { throw new Error(`options.limits 无效（须为 { maxRiskUsd, maxMarginUsd }）：${reason(error)}`); }
  let legQty = '1';
  if (raw.legQty !== undefined) {
    try { legQty = decimal(typeof raw.legQty === 'number' ? String(raw.legQty) : raw.legQty, 'positive'); } catch { throw new Error('options.legQty 须为正数'); }
    if (Number(legQty) > 1_000) throw new Error('options.legQty 不能超过 1000');
  }
  const strategyMode = raw.strategyMode ?? 'iron_condor';
  if (!STRATEGY_MODES.includes(strategyMode as StrategyMode)) throw new Error('options.strategyMode 须为 iron_condor 或 short_strangle');
  const marginMode = raw.marginMode ?? 'REGULAR_MARGIN';
  if (marginMode !== 'REGULAR_MARGIN' && marginMode !== 'PORTFOLIO_MARGIN') throw new Error('options.marginMode 须为 REGULAR_MARGIN 或 PORTFOLIO_MARGIN');
  return {
    accountId: raw.accountId,
    limits: { maxRiskUsd: bounded(limits.maxRiskUsd, 0, 10_000_000, 'limits.maxRiskUsd', { open: true }), maxMarginUsd: bounded(limits.maxMarginUsd, 0, 10_000_000, 'limits.maxMarginUsd', { open: true }) },
    legQty, strategyMode: strategyMode as StrategyMode, marginMode,
    orderTimeoutSeconds: raw.orderTimeoutSeconds === undefined ? 600 : bounded(raw.orderTimeoutSeconds, 60, 1_800, 'orderTimeoutSeconds', { integer: true }),
    feeRate: raw.feeRate === undefined ? 0.0003 : bounded(raw.feeRate, 0, 0.01, 'feeRate'),
    marginBufferPct: raw.marginBufferPct === undefined ? 0.10 : bounded(raw.marginBufferPct, 0, 1, 'marginBufferPct'),
  };
}

/** secrets.json `bybitOptions: { apiKey, apiSecret }`; field names are never echoed. */
export function parseOptionsSecrets(value: Record<string, unknown>): LiveCredentials {
  const entry = value.bybitOptions;
  if (entry === undefined) throw new Error('缺少 bybitOptions 的密钥（配置了 options）');
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'apiKey') || !Object.hasOwn(entry, 'apiSecret')) throw new Error('bybitOptions 的字段须恰好为 apiKey、apiSecret');
  const credentials = { apiKey: (entry as Record<string, unknown>).apiKey, apiSecret: (entry as Record<string, unknown>).apiSecret } as LiveCredentials;
  if (!validCredentials(credentials)) throw new Error('bybitOptions 的密钥不完整或格式无效');
  return credentials;
}

/** For --check-config: the account masked and the limits; empty without options so that output stays as it was. */
export function optionsSummary(options: OptionsConfig | undefined): string {
  if (!options) return '';
  const mode = options.strategyMode === 'iron_condor' ? '铁鹰' : '卖出宽跨';
  return `，期权账户 Bybit ***${options.accountId.slice(-4)}（${mode}，每腿 ${options.legQty}，最大亏损上限 ${options.limits.maxRiskUsd} / 保证金上限 ${options.limits.maxMarginUsd} USD）`;
}
