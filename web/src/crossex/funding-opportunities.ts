// 摘自工作台 modules/crossex/src/funding-opportunities.ts（提交 7745181），只保留类型：机会列表（C5）等行情监控 M-4，
// 资金费机会表、资本效率与导入函数没有搬。
export type FundingLeg = {
  exchange: string; symbol: string; quoteCurrency: string;
  rate: number; intervalHours: number; normalized8hBps: number;
  nextFundingAt: number | null; fundingAt: number;
};
export type FundingOpportunity = {
  id: string; base: string; long: FundingLeg; short: FundingLeg;
  equivalent8hBps: number; grossBps: number | null;
  asOf: number; expiresAt: number; eligible: boolean; reason: string;
};
