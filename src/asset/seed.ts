// Copied from project_aggregation modules/asset/lib/seed.ts at 0014655: seedLedger only. Changes:
// - readSource() and the bundled example ledger are left out: the source ledger always comes from the imported
//   `source-ledger` setting, and a service without an import shows "not imported" instead of example data;
// - the SourceLedger type comes from the trimmed source-ledger.ts; imports carry .ts extensions.
import type { Ledger, Asset } from './types.ts';
import { EXAMPLE_SOURCE, isVariationalProject, isGateProject, isHyperliquidProject, type SourceLedger } from './source-ledger.ts';
import { embeddedWithdrawals } from './withdrawals.ts';
import { knownAssetValue, sumWorkbookValues } from './asset-values.ts';
export type { SourceLedger } from './source-ledger.ts';
export function seedLedger(raw: SourceLedger, includeHistory = true): Ledger {
  const base = raw.periods.find(p => p.id === raw.baselineId)!;
  return {
    asterAccounts: [],
    fxStatus: { source: 'saved', fetchedAt: null, rateDate: null, error: null },
    dataKind: raw.source === EXAMPLE_SOURCE ? 'example' : 'personal',
    assets: base.rows.map(row => {
      const asset = {...row, mode: row.project === 'virtual' ? 'market' : row.project === 'bybit' ? 'bybit' : row.project === 'aster' ? 'aster' : row.project.trim().toLowerCase() === 'binance' ? 'binance' : row.project.trim().toLowerCase() === 'okx' ? 'okx' : isGateProject(row.project) ? 'gate' : isVariationalProject(row.project) ? 'variational' : isHyperliquidProject(row.project) ? 'hyperliquid' : 'manual', updatedAt: base.date + 'T00:00:00+08:00', status: row.project === 'virtual' ? '待更新行情' : (['bybit','aster','binance','okx'].includes(row.project.trim().toLowerCase()) || isGateProject(row.project) || isVariationalProject(row.project) || isHyperliquidProject(row.project)) ? '待连接 · 表格值' : '手动估值' } as Asset;
      return {...asset, value: knownAssetValue(asset)};
    }),
    history: includeHistory ? raw.periods.map(({rows,...period}) => {
      const { missingValues } = sumWorkbookValues(rows);
      return {...period, withdrawn: embeddedWithdrawals(rows), ...(missingValues ? {partial:true,missingValues} : {})};
    }) : [], withdrawals: [], fx: raw.fx, baselineDate: raw.baselineDate, startedAt: raw.startedAt, baselineTotal: base.total,
    connections: { bybit: {configured:false,lastSync:null,error:null,scope:'统一账户 + 资金账户'}, aster: {configured:false,lastSync:null,error:null,scope:'合约账户'}, binance: {configured:false,lastSync:null,error:null,scope:'各钱包资产估值（USDT 折合 USD）'}, okx: {configured:false,lastSync:null,error:null,scope:'当前账户总资产估值（USD）'}, gate: {configured:false,lastSync:null,error:null,scope:'Gate 账户总资产估值（USDT 折合 USD，最多缓存 1 分钟）'}, variational: {configured:false,lastSync:null,error:null,scope:'Omni 真实账户净权益（USDC 折合 USD）'}, hyperliquid: {configured:false,lastSync:null,error:null,scope:'主账户总值（现货 + 全部永续 DEX + 金库 + 质押，USDC 折合 USD）'}, 'rh-lighter': {configured:false,lastSync:null,error:null,scope:'L1 地址下全部账户总值（含未实现盈亏，USDG 按 1:1 计 USD；现货代币不计入）'} }
  };
}
