// MEV 套利页读到的状态（GET /api/mev/state）。只有类型，页面与引擎共用。
import type { Settings } from './risk.ts';
import type { OpportunityOutcome, TxStatus } from './store.ts';

export interface MevTokenView { address: string; symbol: string; decimals: number; start: boolean; priceUsd: number | null }
export interface MevPoolView { address: string; kind: string; token0: string; token1: string; feePpm: number; depthUsd: number; usable: boolean }
export interface MevOpportunityView {
  id: number; at: number; block: number; path: string; edgeBps: number; amountIn: string | null; symbol: string; profit: string | null;
  profitUsd: number; costUsd: number; netUsd: number; outcome: OpportunityOutcome; reason: string | null;
}
export interface MevTxView {
  hash: string; nonce: number; createdAt: number; deadlineBlock: number; status: TxStatus; path: string; symbol: string; expectedProfit: string | null;
  profit: string | null; profitUsd: number | null; feeEth: number | null; block: number | null; settledAt: number | null; error: string | null;
}
/** 启用进度（docs/mev.md 第 6 节）。不含私钥与节点地址原文。 */
export interface MevSetupView {
  /** none 还没录入；wallet 已录入、合约未部署；deploying 部署交易已发出；ready 引擎可以运行。 */
  stage: 'none' | 'wallet' | 'deploying' | 'ready';
  /** 由服务器上的配置文件管理（--set-mev），页面不能改。 */
  managed: boolean;
  operator: string | null; owner: string | null;
  rpcHost: string | null; defaultRpc: boolean;
  wallet: { eth: number; nonce: number; checkedAt: number } | null;
  rpcError: string | null;
  deploy: { hash: string; nonce: number; at: number; address: string } | null;
  error: string | null; checkedAt: number;
}
export interface MevStateView {
  checkedAt: number; chainId: number; executor: string; owner: string; operator: string;
  mode: 'live' | 'observe'; liveSince: number | null; haltReason: string | null; fault: string | null;
  verification: { ok: boolean; reason: string | null; checkedAt: number };
  head: { number: number; ageSec: number; baseFeeGwei: number } | null;
  lagging: boolean; rpcError: string | null; lastOkAt: number | null;
  wallet: { eth: number; nonce: number } | null;
  today: {
    gasSpentEth: number; reservedEth: number; budgetEth: number; success: number; reverted: number;
    profits: { symbol: string; amount: string | null; usd: number | null }[];
    observed: { count: number; netUsd: number };
  };
  totals: Record<string, number>; consecutiveReverts: number;
  counters: { blocks: number; candidates: number; simulated: number };
  settings: Settings;
  tokens: MevTokenView[];
  directory: { at: number | null; error: string | null; pools: number; usable: number; cycles: number };
  pools: MevPoolView[];
  opportunities: MevOpportunityView[];
  transactions: MevTxView[];
}
