// The optional asset part of config.json: `"asset": {}` turns on the read-only asset ledger (src/asset). This batch has no
// options and no keys in secrets.json; the data comes from src/asset/import.ts.
import { ContractError, exactKeys } from '../contracts.ts';

export type AssetConfig = Record<string, never>;

export function parseAssetConfig(value: unknown): AssetConfig {
  try { exactKeys(value, []); } catch (error) { throw new Error(`asset 无效（本版本只接受空对象 {}）：${error instanceof ContractError || error instanceof Error ? error.message : '格式错误'}`); }
  return {};
}

/** For --check-config; empty without asset so that output stays as it was. */
export function assetSummary(asset: AssetConfig | undefined): string {
  return asset ? '，资产账本已启用（只读，数据来自 src/asset/import.ts 导入）' : '';
}
