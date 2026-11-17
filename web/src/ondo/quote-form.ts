import type { OndoMmConfig } from './ondo-mm-types.ts';

const decimalIn = (value: string, min: number, max: number) =>
  /^\d{1,9}(?:\.\d{1,4})?$/.test(value) && Number(value) >= min && Number(value) <= max;

export function quoteConfigRequest(config: OndoMmConfig): { body: { config: OndoMmConfig } } | { error: string } {
  if (!config.wallEnabled || !decimalIn(config.wallUsd, 0.0001, 100_000_000)) return { error: '开仓前方保护量须为 0.0001 至 100000000 USD，最多四位小数。' };
  if (!Number.isInteger(config.maxHoldSec) || config.maxHoldSec < 1 || config.maxHoldSec > 86_400) return { error: '最长持仓时间须为 1 至 86400 秒的整数。' };
  if (!decimalIn(config.maxLossBps, 0.1, 10_000)) return { error: '不利价格变动须为 0.1 至 10000 bps，最多四位小数。' };
  if (!decimalIn(config.exitSlippageBps, 0, 1000)) return { error: 'IOC 滑点限幅须为 0 至 1000 bps，最多四位小数。' };
  return { body: { config } };
}

export function quoteStartRequest(mode: OndoMmConfig['mode'], revision: number, confirmedRevision: number | null, adoptPositions: boolean) {
  if (mode === 'observe') return { revision };
  if (confirmedRevision !== revision) return null;
  return { revision, confirmLive: true, confirmAccountWide: true, adoptPositions };
}

export const ACCOUNT_WIDE_CONFIRMATION = '我使用专用永续账户。账户任一市场已有外部挂单时拒绝启动。交易所连续 30 秒收不到本服务的心跳，将撤销这个账户的全部永续挂单。';

export function exitSummary(config: OndoMmConfig) {
  const trigger = `先挂只减仓 Maker 单。持仓满 ${config.maxHoldSec} 秒，或价格相对入场不利移动 ${config.maxLossBps} bps 时，`;
  return trigger + (config.exitMode === 'makerThenIoc'
    ? `改用只减仓限价 IOC，滑点限幅 ${config.exitSlippageBps} bps，可能吃单并产生 Taker 手续费。`
    : '撤掉平仓挂单，余仓交由人工处理。');
}
