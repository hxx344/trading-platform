// The workbench import panel's choices turned into the page's request (POST /api/import) and the question asked before
// it is sent. Kept free of the DOM so the server-side tests import it. The item shapes are those of
// src/service/import-modules.ts, restated here because the page does not build against node modules.

/** The market monitor in the helper's answer. */
export interface MonitorItem { status: 'added' | 'skipped'; enabled: boolean; shares: { outstanding: number; diluted: number }; markets?: string[]; workbench: boolean; detail: string }
/** One market's tiers in the alert import (src/service/import-monitor-alerts.ts AlertMarketItem). */
export interface AlertMarketItem { market: 'oil' | 'hynix'; rules: number; enabledRules: number; enabled: boolean | null; problem: string | null; notes: string[] }
/** The monitor's alert tiers and robot in the helper's answer (M-3b). */
export interface MonitorAlertsItem { status: 'added' | 'skipped'; markets: AlertMarketItem[]; robot: { imported: boolean; problem: string | null; replaces: boolean; changes: boolean }; detail: string }
/** This service's Var token as the import saw it (src/monitor/variational-import-writer.ts ServiceVariational). */
export interface ServiceVariational { configured: boolean; expiresAt: string | null; revision: number; problem: string | null }
/** The workbench's Var token in the helper's answer (M-3d-2, src/service/import-monitor-variational.ts); never the token. */
export interface MonitorVariationalItem { status: 'added' | 'skipped'; workbenchExpiresAt: string | null; problem: string | null; current: ServiceVariational | null; replaces: boolean; detail: string }
/** The workbench's paper-position records in the helper's answer (M-5e2, src/service/import-monitor-paper.ts); counts only. */
export interface MonitorPaperItem { status: 'added' | 'skipped'; workbench: { active: number; closed: number } | null; problem: string | null; current: { active: number; closed: number; pending: number } | null; added: number; detail: string }
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
  /** The workbench's Var token (M-3d-2), with whether it replaces this service's; null when not ticked. */
  monitorVariational: { replaces: boolean } | null;
  /** The workbench's paper-position records (M-5e2), with how many come over; null or absent when not ticked. */
  monitorPaper?: { added: number } | null;
  /** The workbench user whose ledger comes over, or null. */
  assetOwner: string | null;
  /** The Gate CrossEx account, as "Gate ***1234"; null or absent when it does not come over. */
  crossex?: string | null;
  /** The Ondo maker-reward module, with the masked key id when the key comes over; null or absent when not ticked. */
  ondo?: { keyId: string | null } | null;
}
export type ImportBody = { action: 'import'; pairs: string[]; oil?: true; options?: true; monitor?: true; monitorAlerts?: true; monitorVariational?: true; monitorPaper?: true; asset?: true; assetOwner?: string; crossex?: true; ondo?: true };

export const monitorAvailable = (item: MonitorItem | null | undefined): boolean => item?.status === 'added';
/**
 * The alerts come over only with the monitor on. When the import would change the monitor (enable it, or add markets to
 * one enabled), that has to be ticked too: the request carries `monitor`, so the service applies the change and restarts.
 */
export const alertsAvailable = (item: MonitorAlertsItem | null | undefined, monitor: MonitorItem | null | undefined, monitorPicked: boolean): boolean =>
  item?.status === 'added' && (monitorAvailable(monitor) ? monitorPicked : monitor?.enabled === true);
/** The Var token likewise (the monitor's oil market holds its session). */
export const variationalAvailable = (item: MonitorVariationalItem | null | undefined, monitor: MonitorItem | null | undefined, monitorPicked: boolean): boolean =>
  item?.status === 'added' && (monitorAvailable(monitor) ? monitorPicked : monitor?.enabled === true);
/** The paper records likewise (the monitor's perpetual collector holds them). */
export const paperAvailable = (item: MonitorPaperItem | null | undefined, monitor: MonitorItem | null | undefined, monitorPicked: boolean): boolean =>
  item?.status === 'added' && (monitorAvailable(monitor) ? monitorPicked : monitor?.enabled === true);
export const assetAvailable = (item: AssetItem | null | undefined): boolean => !!item && item.owners.some(owner => owner.importable);
/** Picked from the start only when exactly one user can come over; with several the user picks one. */
export function defaultAssetOwner(item: AssetItem | null | undefined): string | null {
  const ready = item?.owners.filter(owner => owner.importable) ?? [];
  return ready.length === 1 ? ready[0]!.owner : null;
}

/** The request for what is ticked; null when nothing is. */
export function importBody(choices: ImportChoices): ImportBody | null {
  const { pairs, oil, options, monitor, monitorAlerts, monitorVariational, assetOwner } = choices, crossex = choices.crossex ?? null, monitorPaper = choices.monitorPaper ?? null, ondo = choices.ondo ?? null;
  if (!pairs.length && !oil.length && options === null && !monitor && monitorAlerts === null && monitorVariational === null && monitorPaper === null && assetOwner === null && crossex === null && ondo === null) return null;
  // The service takes the alerts, the token and the paper records only beside `monitor` (an enabled monitor is kept as it is).
  return {
    action: 'import', pairs, ...(oil.length ? { oil: true as const } : {}), ...(options !== null ? { options: true as const } : {}),
    ...(monitor || monitorAlerts !== null || monitorVariational !== null || monitorPaper !== null ? { monitor: true as const } : {}), ...(monitorAlerts !== null ? { monitorAlerts: true as const } : {}),
    ...(monitorVariational !== null ? { monitorVariational: true as const } : {}), ...(monitorPaper !== null ? { monitorPaper: true as const } : {}), ...(assetOwner !== null ? { asset: true as const, assetOwner } : {}),
    ...(crossex !== null ? { crossex: true as const } : {}), ...(ondo !== null ? { ondo: true as const } : {}),
  };
}

/**
 * Whether the import rewrites the config and restarts the service: not when only the ledger of an enabled asset comes
 * again, nor for alert tiers (the running monitor takes them within 10 s) with a robot already in place, nor for the Var
 * token (the running monitor takes it on its next read), nor for the paper records (merged on the monitor's next check).
 */
export function restarts(choices: ImportChoices, assetEnabled: boolean): boolean {
  return choices.pairs.length > 0 || choices.oil.length > 0 || choices.options !== null || choices.monitor || (choices.monitorAlerts?.robotChanges ?? false) || (choices.crossex ?? null) !== null || (choices.ondo ?? null) !== null
    || (choices.assetOwner !== null && !assetEnabled);
}

/** The question asked before the request is sent. */
export function confirmText(choices: ImportChoices, assetEnabled: boolean): string {
  const { pairs, oil, options, monitor, monitorAlerts, monitorVariational, assetOwner } = choices, crossex = choices.crossex ?? null, ondo = choices.ondo ?? null;
  const token = monitorVariational !== null ? `工作台的 Var token 写入本服务${monitorVariational.replaces ? '，替换现有的' : ''}，行情监控下一次读取即用它。` : '';
  const monitorPaper = choices.monitorPaper ?? null;
  const records = monitorPaper !== null ? `工作台的 ${monitorPaper.added} 条持仓记录写入待载入文件，${restarts(choices, assetEnabled) ? '服务启动时载入' : '行情监控下一次检查时载入（合约价差采集关闭时在下次开启时）'}，本服务已有的记录保留。` : '';
  const tiers = monitorAlerts !== null && monitorAlerts.tiers > 0 ? '导入的告警档位替换本服务现有的原油 / 海力士档位，行情监控 10 秒内换上；工作台的告警仍开着时两边都会发。' : '';
  if (!restarts(choices, assetEnabled)) {
    // "Again" only for what this service has already (the ledger, the alerts); the token is a plain import.
    const again = [assetOwner !== null ? `资产账本（用户 ${assetOwner}）` : '', monitorAlerts !== null ? '行情告警' : ''].filter(Boolean).join(' 与 ');
    // "Again" never for the records either: they are added to this service's own.
    const plain = [monitorVariational !== null ? 'Var token' : '', monitorPaper !== null ? '持仓记录' : ''].filter(Boolean).join(' 与 ');
    const what = [again ? `重新导入${again}` : '', plain ? `${again ? '并' : ''}导入 ${plain}` : ''].filter(Boolean).join('，');
    return `${what}？${assetOwner !== null ? '整体替换本服务现有的资产账本；' : ''}${tiers}${token}${records}配置不变，不重启服务。`;
  }
  const what = [pairs.length ? pairs.join('、') : '', oil.length ? `原油执行账户（${oil.join('、')}）` : '', options !== null ? `期权账户（${options}）` : '',
    monitor ? '行情监控' : '', monitorAlerts !== null ? `行情告警${monitorAlerts.robot ? '与机器人' : ''}` : '', monitorVariational !== null ? 'Var token' : '', monitorPaper !== null ? '持仓记录' : '', crossex !== null ? `CrossEx 账户（${crossex}）` : '', ondo !== null ? `Ondo 挂单奖励${ondo.keyId ? `（API Key ${ondo.keyId}）` : ''}` : '',
    assetOwner !== null ? `资产账本（用户 ${assetOwner}）` : ''].filter(Boolean).join(' 与 ');
  const after = [pairs.length ? '导入的配对登记为停用。' : '', oil.length ? '原油执行账户导入后即可在「原油」页面实盘下单，下单不设名义金额上限。' : '',
    options !== null ? '期权账户导入后即可在「期权」页面实盘手动开平仓，工作台期权模块此后不能再用这个账户下期权单。' : '',
    monitor ? '行情监控启用后服务器读取 Binance、Hyperliquid、Lighter RH 的公开行情（不需要密钥），股数取默认值。' : '',
    tiers, token, records, monitorAlerts?.robotChanges ? '行情告警改发工作台行情监控的机器人（secrets.json 的 feishuMonitor），ASTER 告警仍发 feishu。' : '',
    crossex !== null ? 'CrossEx 账户导入后即可在「CrossEx」页面实盘手动下单；导入后请在工作台 CrossEx 设置页断开账户，此后只在本服务交易。' : '',
    ondo !== null ? `Ondo 挂单奖励以观察模式启用，服务器读取 Ondo 公开盘口${ondo.keyId ? '；导入的 API Key 可在「Ondo 挂单奖励」页面切到实盘挂单，此后不要再在工作台启动 Ondo 实盘挂单' : '（未导入 API Key，只能观察）'}。` : '',
    assetOwner !== null ? (assetEnabled ? '资产账本整体替换为该用户的最新账本。' : '资产账本先写入，再启用「资产」页面（只读）；配置检查或重启失败时配置恢复，已写入的账本保留。') : ''].join('');
  return `导入 ${what} 并重启本服务？重启约半分钟，期间已启用配对的划转与 ADL 暂停。${after}`;
}
