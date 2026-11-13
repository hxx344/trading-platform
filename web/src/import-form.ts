// The workbench import panel's choices turned into the page's request (POST /api/import) and the question asked before
// it is sent. Kept free of the DOM so the server-side tests import it. The item shapes are those of
// src/service/import-modules.ts, restated here because the page does not build against node modules.

/** The market monitor in the helper's answer. */
export interface MonitorItem { status: 'added' | 'skipped'; enabled: boolean; shares: { outstanding: number; diluted: number }; workbench: boolean; detail: string }
/** One workbench user with an asset ledger. */
export interface LedgerOwner { owner: string; assets: number; snapshots: number; lastDaily: string | null; importable: boolean; detail: string }
/** The asset ledger in the helper's answer: the workbench's users and this service's last import. */
export interface AssetItem {
  status: 'added' | 'skipped'; enabled: boolean; owner: string | null; ledger: string; owners: LedgerOwner[]; more: number;
  last: { importedAt: string; owner: string; assets: number; snapshots: number } | null; lastProblem: string | null; detail: string;
}

/** What is ticked in the panel, already narrowed to what the preview said can come over. */
export interface ImportChoices {
  pairs: string[];
  /** The oil accounts that come over, as "Binance ***1234". */
  oil: string[];
  /** The options account, as "Bybit ***1234", or null. */
  options: string | null;
  monitor: boolean;
  /** The workbench user whose ledger comes over, or null. */
  assetOwner: string | null;
}
export type ImportBody = { action: 'import'; pairs: string[]; oil?: true; options?: true; monitor?: true; asset?: true; assetOwner?: string };

export const monitorAvailable = (item: MonitorItem | null | undefined): boolean => item?.status === 'added';
export const assetAvailable = (item: AssetItem | null | undefined): boolean => !!item && item.owners.some(owner => owner.importable);
/** Picked from the start only when exactly one user can come over; with several the user picks one. */
export function defaultAssetOwner(item: AssetItem | null | undefined): string | null {
  const ready = item?.owners.filter(owner => owner.importable) ?? [];
  return ready.length === 1 ? ready[0]!.owner : null;
}

/** The request for what is ticked; null when nothing is. */
export function importBody(choices: ImportChoices): ImportBody | null {
  const { pairs, oil, options, monitor, assetOwner } = choices;
  if (!pairs.length && !oil.length && options === null && !monitor && assetOwner === null) return null;
  return {
    action: 'import', pairs, ...(oil.length ? { oil: true as const } : {}), ...(options !== null ? { options: true as const } : {}),
    ...(monitor ? { monitor: true as const } : {}), ...(assetOwner !== null ? { asset: true as const, assetOwner } : {}),
  };
}

/** Whether the import rewrites the config and restarts the service: not when only the ledger of an enabled asset comes again. */
export function restarts(choices: ImportChoices, assetEnabled: boolean): boolean {
  return choices.pairs.length > 0 || choices.oil.length > 0 || choices.options !== null || choices.monitor || (choices.assetOwner !== null && !assetEnabled);
}

/** The question asked before the request is sent. */
export function confirmText(choices: ImportChoices, assetEnabled: boolean): string {
  const { pairs, oil, options, monitor, assetOwner } = choices;
  if (!restarts(choices, assetEnabled)) return `重新导入资产账本（用户 ${assetOwner ?? ''}）？整体替换本服务现有的资产账本；配置不变，不重启服务。`;
  const what = [pairs.length ? pairs.join('、') : '', oil.length ? `原油执行账户（${oil.join('、')}）` : '', options !== null ? `期权账户（${options}）` : '',
    monitor ? '行情监控' : '', assetOwner !== null ? `资产账本（用户 ${assetOwner}）` : ''].filter(Boolean).join(' 与 ');
  const after = [pairs.length ? '导入的配对登记为停用。' : '', oil.length ? '原油执行账户导入后即可在「原油」页面实盘下单；首次写入原油配置时名义金额上限取单笔 200、24 小时开仓 1000 USDT。' : '',
    options !== null ? '期权账户导入后即可在「期权」页面实盘手动开平仓，工作台期权模块此后不能再用这个账户下期权单。' : '',
    monitor ? '行情监控启用后服务器读取 Binance、Hyperliquid、Lighter RH 的公开行情（不需要密钥），股数取默认值。' : '',
    assetOwner !== null ? (assetEnabled ? '资产账本整体替换为该用户的最新账本。' : '资产账本先写入，再启用「资产」页面（只读）；配置检查或重启失败时配置恢复，已写入的账本保留。') : ''].join('');
  return `导入 ${what} 并重启本服务？重启约半分钟，期间已启用配对的划转与 ADL 暂停。${after}`;
}
