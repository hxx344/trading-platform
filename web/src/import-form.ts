// The workbench import panel's choices turned into the page's request (POST /api/import) and the question asked before
// it is sent. Kept free of the DOM so the server-side tests import it. The item shapes are those of
// src/service/import-modules.ts, restated here because the page does not build against node modules.

/** The market monitor in the helper's answer. */
export interface MonitorItem { status: 'added' | 'skipped'; enabled: boolean; shares: { outstanding: number; diluted: number }; markets?: string[]; workbench: boolean; detail: string }
/** One market's tiers in the alert import (src/service/import-monitor-alerts.ts AlertMarketItem). */
export interface AlertMarketItem { market: 'oil' | 'hynix'; rules: number; enabledRules: number; enabled: boolean | null; problem: string | null; notes: string[] }
/** The monitor's alert tiers and robot in the helper's answer (M-3b). */
export interface MonitorAlertsItem { status: 'added' | 'skipped'; markets: AlertMarketItem[]; robot: { imported: boolean; problem: string | null; replaces: boolean; changes: boolean }; detail: string }
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
  /** The alert tiers and robot (M-3b), with whether secrets.json changes for the robot; null when not ticked. */
  monitorAlerts: { tiers: number; robot: boolean; robotChanges: boolean } | null;
  /** The workbench user whose ledger comes over, or null. */
  assetOwner: string | null;
}
export type ImportBody = { action: 'import'; pairs: string[]; oil?: true; options?: true; monitor?: true; monitorAlerts?: true; asset?: true; assetOwner?: string };

export const monitorAvailable = (item: MonitorItem | null | undefined): boolean => item?.status === 'added';
/**
 * The alerts come over only with the monitor on. When the import would change the monitor (enable it, or add markets to
 * one enabled), that has to be ticked too: the request carries `monitor`, so the service applies the change and restarts.
 */
export const alertsAvailable = (item: MonitorAlertsItem | null | undefined, monitor: MonitorItem | null | undefined, monitorPicked: boolean): boolean =>
  item?.status === 'added' && (monitorAvailable(monitor) ? monitorPicked : monitor?.enabled === true);
export const assetAvailable = (item: AssetItem | null | undefined): boolean => !!item && item.owners.some(owner => owner.importable);
/** Picked from the start only when exactly one user can come over; with several the user picks one. */
export function defaultAssetOwner(item: AssetItem | null | undefined): string | null {
  const ready = item?.owners.filter(owner => owner.importable) ?? [];
  return ready.length === 1 ? ready[0]!.owner : null;
}

/** The request for what is ticked; null when nothing is. */
export function importBody(choices: ImportChoices): ImportBody | null {
  const { pairs, oil, options, monitor, monitorAlerts, assetOwner } = choices;
  if (!pairs.length && !oil.length && options === null && !monitor && monitorAlerts === null && assetOwner === null) return null;
  // The service takes the alerts only beside `monitor` (an enabled monitor is kept as it is).
  return {
    action: 'import', pairs, ...(oil.length ? { oil: true as const } : {}), ...(options !== null ? { options: true as const } : {}),
    ...(monitor || monitorAlerts !== null ? { monitor: true as const } : {}), ...(monitorAlerts !== null ? { monitorAlerts: true as const } : {}), ...(assetOwner !== null ? { asset: true as const, assetOwner } : {}),
  };
}

/**
 * Whether the import rewrites the config and restarts the service: not when only the ledger of an enabled asset comes
 * again, nor for alert tiers (the running monitor takes them within 10 s) with a robot already in place.
 */
export function restarts(choices: ImportChoices, assetEnabled: boolean): boolean {
  return choices.pairs.length > 0 || choices.oil.length > 0 || choices.options !== null || choices.monitor || (choices.monitorAlerts?.robotChanges ?? false) || (choices.assetOwner !== null && !assetEnabled);
}

/** The question asked before the request is sent. */
export function confirmText(choices: ImportChoices, assetEnabled: boolean): string {
  const { pairs, oil, options, monitor, monitorAlerts, assetOwner } = choices;
  const tiers = monitorAlerts !== null && monitorAlerts.tiers > 0 ? '导入的告警档位替换本服务现有的原油 / 海力士档位，行情监控 10 秒内换上；工作台的告警仍开着时两边都会发。' : '';
  if (!restarts(choices, assetEnabled)) {
    const what = [assetOwner !== null ? `资产账本（用户 ${assetOwner}）` : '', monitorAlerts !== null ? '行情告警' : ''].filter(Boolean).join(' 与 ');
    return `重新导入${what}？${assetOwner !== null ? '整体替换本服务现有的资产账本；' : ''}${tiers}配置不变，不重启服务。`;
  }
  const what = [pairs.length ? pairs.join('、') : '', oil.length ? `原油执行账户（${oil.join('、')}）` : '', options !== null ? `期权账户（${options}）` : '',
    monitor ? '行情监控' : '', monitorAlerts !== null ? `行情告警${monitorAlerts.robot ? '与机器人' : ''}` : '', assetOwner !== null ? `资产账本（用户 ${assetOwner}）` : ''].filter(Boolean).join(' 与 ');
  const after = [pairs.length ? '导入的配对登记为停用。' : '', oil.length ? '原油执行账户导入后即可在「原油」页面实盘下单；首次写入原油配置时名义金额上限取单笔 200、24 小时开仓 1000 USDT。' : '',
    options !== null ? '期权账户导入后即可在「期权」页面实盘手动开平仓，工作台期权模块此后不能再用这个账户下期权单。' : '',
    monitor ? '行情监控启用后服务器读取 Binance、Hyperliquid、Lighter RH 的公开行情（不需要密钥），股数取默认值。' : '',
    tiers, monitorAlerts?.robotChanges ? '行情告警改发工作台行情监控的机器人（secrets.json 的 feishuMonitor），ASTER 告警仍发 feishu。' : '',
    assetOwner !== null ? (assetEnabled ? '资产账本整体替换为该用户的最新账本。' : '资产账本先写入，再启用「资产」页面（只读）；配置检查或重启失败时配置恢复，已写入的账本保留。') : ''].join('');
  return `导入 ${what} 并重启本服务？重启约半分钟，期间已启用配对的划转与 ADL 暂停。${after}`;
}
