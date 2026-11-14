import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { fullStamp } from './asset-format.ts';
import { alertsAvailable, assetAvailable, confirmText, defaultAssetOwner, importBody, monitorAvailable, restarts, type AssetItem, type ImportBody, type ImportChoices, type MonitorAlertsItem, type MonitorItem } from './import-form.ts';

// The workbench import: the page leaves a request, a root helper on the host answers it (and restarts this service
// for an import); the answer is polled by request id, and polling carries on while the service restarts.
// The helper waits up to 100 s for a running install.sh and drops requests older than 2 minutes; an import that fails
// on start puts the files back and restarts again, all within its 12-minute limit.
const IMPORT_WAIT_MS = 760_000, IMPORT_PICKUP_MS = 135_000, IMPORT_SLOW_MS = 10_000;

interface PreviewItem { id: string; name?: string; marginEnabled: boolean; importable: boolean; detail: string }
interface ImportedItem { id: string; status: string; detail: string }
/** A workbench Binance/Bybit execution account for the oil module; the id comes masked. */
interface OilItem { venue: string; accountMode: string | null; accountId: string | null; blockedBy: string[]; status: 'added' | 'skipped'; detail: string }
/** The workbench Greeks module's Bybit account for the options module; the UID comes masked. */
interface OptionsItem { accountId: string | null; status: 'added' | 'skipped'; detail: string }
interface ImportResult {
  id: string | null; action: 'preview' | 'import' | null; at: number; phase?: string; message: string;
  preview?: PreviewItem[]; imported?: ImportedItem[]; oil?: OilItem[]; oilError?: string; options?: OptionsItem; optionsError?: string;
  monitor?: MonitorItem; monitorAlerts?: MonitorAlertsItem; monitorAlertsError?: string; asset?: AssetItem; assetError?: string; notes?: string[]; database?: string;
}
const VENUE: Record<string, string> = { binance: 'Binance', bybit: 'Bybit' };

function OilRows({ items, preview }: { items: OilItem[]; preview: boolean }) {
  return <div className="table-wrap"><table className="data" id="importOilTable">
    <thead><tr><th>原油执行账户</th><th>账户模式</th><th>账户</th><th>工作台原油自动规则</th><th>{preview ? '说明' : '结果'}</th></tr></thead>
    <tbody>{items.map(item => <tr key={item.venue}>
      <td>{VENUE[item.venue] ?? item.venue}</td><td>{item.accountMode ?? '—'}</td><td className="mono">{item.accountId ?? '—'}</td>
      <td className={item.blockedBy.length ? 'err' : 'muted'}>{item.blockedBy.length ? `实盘启用：${item.blockedBy.join('、')}` : '无实盘启用的规则'}</td>
      <td className={item.status === 'added' ? 'ok' : preview ? 'muted' : 'err'}>{item.status === 'added' ? (preview ? '可导入：' : '已导入：') : (preview ? '不能导入：' : '未导入：')}{item.detail}</td>
    </tr>)}</tbody>
  </table></div>;
}
function OptionsRow({ item, preview }: { item: OptionsItem; preview: boolean }) {
  return <div className="table-wrap"><table className="data" id="importOptionsTable">
    <thead><tr><th>期权账户</th><th>账户</th><th>{preview ? '说明' : '结果'}</th></tr></thead>
    <tbody><tr>
      <td>Bybit 期权</td><td className="mono">{item.accountId ?? '—'}</td>
      <td className={item.status === 'added' ? 'ok' : preview ? 'muted' : 'err'}>{item.status === 'added' ? (preview ? '可导入：' : '已导入：') : (preview ? '不能导入：' : '未导入：')}{item.detail}</td>
    </tr></tbody>
  </table></div>;
}
const MARKET_NAMES: Record<string, string> = { anthropic: 'Anthropic 价差', oil: '原油价差', hynix: '海力士溢价' };
function MonitorRow({ item, preview }: { item: MonitorItem; preview: boolean }) {
  return <div className="table-wrap"><table className="data" id="importMonitorTable">
    <thead><tr><th>行情监控</th><th>本项目</th><th>工作台 Monitor</th><th>{preview ? '说明' : '结果'}</th></tr></thead>
    <tbody><tr>
      <td>{item.markets === undefined ? 'Anthropic 价差、原油价差、海力士溢价' : item.markets.length ? item.markets.map(market => MARKET_NAMES[market] ?? market).join('、') : '—'}</td><td>{item.enabled ? '已启用' : '未启用'}</td><td className="muted">{item.workbench ? '有（本地行情记录不导入）' : '无'}</td>
      <td className={item.status === 'added' ? 'ok' : preview || item.enabled ? 'muted' : 'err'}>{item.status === 'added' ? (preview ? '可启用：' : '已启用：') : (preview || item.enabled ? '' : '未启用：')}{item.detail}</td>
    </tr></tbody>
  </table></div>;
}
const ALERT_MARKET_NAMES: Record<string, string> = { oil: '原油', hynix: '海力士' };
/** The workbench monitor's alert tiers per market and its robot (M-3b). */
function AlertsRows({ item, preview }: { item: MonitorAlertsItem; preview: boolean }) {
  const robot = item.robot.imported ? `${preview ? '可导入' : '已导入'}为 secrets.json 的 feishuMonitor${item.robot.replaces ? '（替换原有的）' : item.robot.changes ? '' : '（与本服务现有的相同）'}` : `不导入：${item.robot.problem ?? '—'}`;
  return <>
    <div className="table-wrap"><table className="data" id="importAlertsTable">
      <thead><tr><th>行情告警</th><th>档位</th><th>总开关</th><th>{preview ? '说明' : '结果'}</th></tr></thead>
      <tbody>{item.markets.map(entry => <tr key={entry.market}>
        <td>{ALERT_MARKET_NAMES[entry.market] ?? entry.market}</td>
        <td>{entry.problem ? '—' : `${entry.rules} 档（启用 ${entry.enabledRules}）`}</td>
        <td>{entry.enabled === null ? '—' : entry.enabled ? '开' : '关'}</td>
        <td className={entry.problem ? (preview ? 'muted' : 'err') : 'ok'}>{entry.problem ? `不能导入：${entry.problem}` : `${preview ? '可导入，替换本服务现有档位' : '已导入'}${entry.notes.length ? `；${entry.notes.join('；')}` : ''}`}</td>
      </tr>)}
      <tr><td>飞书机器人</td><td>—</td><td>—</td><td className={item.robot.imported ? 'ok' : preview ? 'muted' : 'err'}>{robot}</td></tr></tbody>
    </table></div>
    {item.status === 'skipped' ? <p className={preview ? 'muted' : 'err'}>{preview ? '' : '未导入：'}{item.detail}</p> : null}
  </>;
}
/** The workbench's ledger users; in a preview, the one to import is picked here. */
function AssetRows({ item, preview, owner, setOwner }: { item: AssetItem; preview: boolean; owner?: string | null; setOwner?: (value: string) => void }) {
  const last = item.last ? `上次导入：用户 ${item.last.owner}，${fullStamp(item.last.importedAt)}，资产 ${item.last.assets} 条、快照 ${item.last.snapshots} 条` : '尚未导入过账本';
  return <>
    <p className="muted">资产账本：本项目{item.enabled ? '已启用' : '未启用'}，{last}。工作台账本 <span className="mono">{item.ledger}</span>（只读，不读交易所凭据）</p>
    {item.lastProblem ? <p className="err">{item.lastProblem}</p> : null}
    {item.owners.length ? <div className="table-wrap"><table className="data" id="importAssetTable">
      <thead><tr>{preview ? <th></th> : null}<th>工作台用户</th><th>资产</th><th>快照</th><th>最近的日快照</th><th>说明</th></tr></thead>
      <tbody>{item.owners.map(entry => <tr key={entry.owner}>
        {preview ? <td><input type="radio" name="importAssetOwner" data-import-owner={entry.owner} disabled={!entry.importable} checked={owner === entry.owner} onChange={() => setOwner?.(entry.owner)} /></td> : null}
        <td>{entry.owner}</td><td>{entry.assets}</td><td>{entry.snapshots}</td><td>{entry.lastDaily ?? '—'}</td>
        <td className={entry.importable ? 'ok' : 'muted'}>{entry.importable ? '可导入：' : '不能导入：'}{entry.detail}</td>
      </tr>)}</tbody>
    </table></div> : null}
    {item.more ? <p className="muted">另有 {item.more} 个用户未列出；请用命令行 sudo bash install.sh --import-workbench --asset --asset-owner &lt;用户&gt; 导入。</p> : null}
    {!preview || !item.owners.length || item.status === 'added' ? <p className={item.status === 'added' ? 'ok' : preview ? 'muted' : 'err'}>{item.status === 'added' ? (preview ? '可导入：' : '已导入：') : (preview ? '不能导入：' : '未导入：')}{item.detail}</p> : null}
  </>;
}
type Message = { tone: 'ok' | 'err' | 'muted'; text: string } | null;
/** The module choices of the preview (live accounts and modules are never ticked by default). */
interface ModulePicks { oil: boolean; options: boolean; monitor: boolean; monitorAlerts: boolean; asset: boolean; assetOwner: string | null }

function Results({ result, picked, setPicked, picks, setPicks, onRun, busy }: { result: ImportResult; picked: Set<string>; setPicked: (value: Set<string>) => void; picks: ModulePicks; setPicks: (value: ModulePicks) => void; onRun: () => void; busy: boolean }) {
  const notes = (result.notes || []).map((note, index) => <p key={index} className="muted">{note}</p>);
  const oilError = result.oilError ? <p className="err">原油执行账户无法读取：{result.oilError}</p> : null;
  const optionsError = result.optionsError ? <p className="err">期权账户无法读取：{result.optionsError}</p> : null;
  const assetError = result.assetError ? <p className="err">资产账本无法读取：{result.assetError}</p> : null;
  const alertsError = result.monitorAlertsError ? <p className="err">行情告警设置无法读取：{result.monitorAlertsError}</p> : null;
  if (result.action === 'preview') {
    const rows = result.preview || [], oil = result.oil || [], options = result.options ?? null, monitor = result.monitor ?? null, asset = result.asset ?? null;
    const oilImportable = oil.some(item => item.status === 'added'), optionsImportable = options?.status === 'added';
    const oilPicked = picks.oil, optionsPicked = picks.options;
    const setOilPicked = (value: boolean) => setPicks({ ...picks, oil: value }), setOptionsPicked = (value: boolean) => setPicks({ ...picks, options: value });
    const monitorImportable = monitorAvailable(monitor), assetImportable = assetAvailable(asset);
    const alerts = result.monitorAlerts ?? null, alertsImportable = alertsAvailable(alerts, monitor, picks.monitor);
    return <>
      {rows.length ? <>
        <div className="table-wrap"><table className="data">
          <thead><tr><th></th><th>工作台配对</th><th>工作台保证金平衡</th><th>说明</th></tr></thead>
          <tbody>{rows.map(item => <tr key={item.id}>
            <td><input type="checkbox" data-import-pick={item.id} disabled={!item.importable} checked={picked.has(item.id)} onChange={event => {
              const next = new Set(picked);
              if (event.target.checked) next.add(item.id); else next.delete(item.id);
              setPicked(next);
            }} /></td>
            <td>{item.id}{item.name ? <><br /><span className="muted">{item.name}</span></> : null}</td>
            <td>{item.marginEnabled ? '已开启' : '未开启'}</td>
            <td className={item.importable ? 'ok' : 'muted'}>{item.importable ? '可导入：' : '不能导入：'}{item.detail}</td>
          </tr>)}</tbody>
        </table></div>
      </> : null}
      {oil.length ? <>
        <OilRows items={oil} preview />
        <label className="pair-pick"><input type="checkbox" id="importOilPick" disabled={!oilImportable} checked={oilPicked && oilImportable} onChange={event => setOilPicked(event.target.checked)} />导入原油执行账户（可导入的交易所一起导入，本项目已配置的交易所保留现有设置）</label>
      </> : null}
      {oilError}
      {options ? <>
        <OptionsRow item={options} preview />
        <label className="pair-pick"><input type="checkbox" id="importOptionsPick" disabled={!optionsImportable} checked={optionsPicked && optionsImportable} onChange={event => setOptionsPicked(event.target.checked)} />导入期权账户（工作台期权模块的 Bybit 密钥与风险上限；本项目已配置期权时保留现有设置）</label>
      </> : null}
      {optionsError}
      {monitor ? <>
        <MonitorRow item={monitor} preview />
        <label className="pair-pick"><input type="checkbox" id="importMonitorPick" disabled={!monitorImportable} checked={picks.monitor && monitorImportable} onChange={event => setPicks({ ...picks, monitor: event.target.checked, ...(event.target.checked ? {} : { monitorAlerts: false }) })} />启用行情监控（Anthropic 价差，只读公开行情，不需要密钥；股数取默认值，本项目已启用时保留现有设置）</label>
        {alerts ? <>
          <AlertsRows item={alerts} preview />
          <label className="pair-pick"><input type="checkbox" id="importAlertsPick" disabled={!alertsImportable} checked={picks.monitorAlerts && alertsImportable} onChange={event => setPicks({ ...picks, monitorAlerts: event.target.checked })} />同时导入告警档位与机器人（替换本服务现有的原油 / 海力士档位；{monitorAvailable(monitor) ? (monitor.enabled ? '须同时勾选补全行情监控' : '须同时勾选启用行情监控') : monitor.enabled ? '行情监控已启用' : '须先在本服务启用行情监控'}）</label>
        </> : null}
      </> : null}
      {alertsError}
      {asset ? <>
        <AssetRows item={asset} preview owner={picks.assetOwner} setOwner={owner => setPicks({ ...picks, assetOwner: owner, asset: true })} />
        <label className="pair-pick"><input type="checkbox" id="importAssetPick" disabled={!assetImportable} checked={picks.asset && assetImportable} onChange={event => setPicks({ ...picks, asset: event.target.checked })} />导入资产账本（所选用户的账本整体替换本项目现有账本；本项目已启用资产账本时只重新导入、不重启服务）</label>
      </> : null}
      {assetError}
      {rows.length || oil.length || options || monitor || asset ? <p><button type="button" id="importRunBtn" className="button primary" disabled={busy} onClick={onRun}>{restarts(choicesOf(result, picked, picks), asset?.enabled ?? false) ? '导入所选并重启服务' : '导入所选'}</button></p> : null}
      {notes}
      {result.database ? <p className="muted">读取自 {result.database}（只读）</p> : null}
    </>;
  }
  const rows = result.imported || [];
  return <>
    {rows.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>配对</th><th>结果</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.id}><td>{item.id}</td><td className={item.status === 'added' ? 'ok' : 'err'}>{item.status === 'added' ? '已导入：' : '未导入：'}{item.detail}</td></tr>)}</tbody>
    </table></div> : null}
    {result.oil?.length ? <OilRows items={result.oil} preview={false} /> : null}
    {oilError}
    {result.options ? <OptionsRow item={result.options} preview={false} /> : null}
    {optionsError}
    {result.monitor ? <MonitorRow item={result.monitor} preview={false} /> : null}
    {result.monitorAlerts ? <AlertsRows item={result.monitorAlerts} preview={false} /> : null}
    {alertsError}
    {result.asset ? <AssetRows item={result.asset} preview={false} /> : null}
    {assetError}
    {notes}
  </>;
}

/** What would be sent: the ticked parts the preview said can come over. */
function choicesOf(result: ImportResult | null, picked: Set<string>, picks: ModulePicks): ImportChoices {
  const pairs = (result?.preview || []).filter(item => item.importable && picked.has(item.id)).map(item => item.id);
  const oil = picks.oil ? (result?.oil || []).filter(item => item.status === 'added').map(item => `${VENUE[item.venue] ?? item.venue} ${item.accountId ?? ''}`) : [];
  const options = picks.options && result?.options?.status === 'added' ? `Bybit ${result.options.accountId ?? ''}` : null;
  const owner = picks.asset && result?.asset?.owners.some(item => item.importable && item.owner === picks.assetOwner) ? picks.assetOwner : null;
  const alerts = result?.monitorAlerts;
  const monitorAlerts = picks.monitorAlerts && alerts && alertsAvailable(alerts, result?.monitor, picks.monitor)
    ? { tiers: alerts.markets.filter(entry => entry.problem === null).length, robot: alerts.robot.imported, robotChanges: alerts.robot.changes } : null;
  return { pairs, oil, options, monitor: picks.monitor && monitorAvailable(result?.monitor), monitorAlerts, assetOwner: owner };
}
const NO_PICKS: ModulePicks = { oil: false, options: false, monitor: false, monitorAlerts: false, asset: false, assetOwner: null };

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Shown only where the service offers it (the ASTER service with the helper's directory); elsewhere the route is 404. */
export function ImportPanel({ onImported }: { onImported: () => void }) {
  const [offered, setOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Live trading accounts and the modules: never ticked by default.
  const [picks, setPicks] = useState<ModulePicks>(NO_PICKS);
  const waiting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api('/api/import').then(() => { if (mounted.current) setOffered(true); }).catch(() => {});
    return () => { mounted.current = false; };
  }, []);

  const show = (next: ImportResult) => {
    setResult(next);
    // Like the earlier page: the pairs with margin balance on are picked by default.
    if (next.action === 'preview') { setPicked(new Set((next.preview || []).filter(item => item.importable && item.marginEnabled).map(item => item.id))); setPicks({ ...NO_PICKS, assetOwner: defaultAssetOwner(next.asset) }); }
  };

  async function request(body: { action: 'preview' } | ImportBody, text: string): Promise<void> {
    if (waiting.current) return;
    waiting.current = true; setBusy(true);
    const started = Date.now();
    try {
      const { id, at } = await api<{ id?: unknown; at?: unknown }>('/api/import', { body });
      if (typeof id !== 'string' || typeof at !== 'number') throw new Error('请求已发出但应答无法解析，结果未知：请稍后点「读取工作台」核对');
      setMessage({ tone: 'muted', text: `${text}…` });
      let found = false, restarting = false;
      while (Date.now() - started < IMPORT_WAIT_MS) {
        await pause(1000);
        if (!mounted.current) return;
        let latest: ImportResult | null;
        try { latest = (await api<{ result: ImportResult | null }>('/api/import')).result; }
        catch (error) {
          const status = statusOf(error);
          if (status === 401) throw new Error('会话已失效（服务重启时更换了会话），请刷新页面重新登录（或用数据目录 access-url 里的登录链接）；导入结果可稍后点「读取工作台」核对');
          if (restarting || status === undefined || status >= 500) { setMessage({ tone: 'muted', text: '服务重启中…' }); continue; }
          throw error;
        }
        // An unreadable request is answered without an id; notices about an earlier, interrupted import carry that one's id.
        if (!found && latest && latest.id === null && latest.action === null && latest.at >= at) throw new Error(latest.message);
        if (!latest || latest.id !== id) {
          if (found) continue;
          if (Date.now() - started > IMPORT_PICKUP_MS) throw new Error('导入助手没有响应，请求已作废：请确认已用 sudo bash install.sh 安装本版本（systemctl status trading-platform-import.path）');
          if (Date.now() - started > IMPORT_SLOW_MS) setMessage({ tone: 'muted', text: `${text}…（等待导入助手接手；安装脚本正在运行时最多等 2 分钟）` });
          continue;
        }
        found = true;
        if (latest.phase === 'running' || latest.phase === 'restarting') {
          restarting = latest.phase === 'restarting';
          setMessage({ tone: 'muted', text: `${latest.message}…` });
          if (restarting) show(latest);
          continue;
        }
        setMessage({ tone: latest.phase === 'done' ? 'ok' : 'err', text: latest.message });
        show(latest);
        if (latest.action === 'import') onImported();
        return;
      }
      throw new Error('等待超时：结果未知，请稍后点「读取工作台」查看配置是否已导入');
    } catch (error) {
      if (mounted.current) setMessage({ tone: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      waiting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const run = () => {
    if (picks.asset && assetAvailable(result?.asset) && picks.assetOwner === null) { alert('请先在资产账本表里选择要导入的工作台用户'); return; }
    const choices = choicesOf(result, picked, picks), body = importBody(choices);
    if (!body) { alert('请先勾选要导入的配对、原油执行账户、期权账户、行情监控或资产账本'); return; }
    if (!confirm(confirmText(choices, result?.asset?.enabled ?? false))) return;
    void request(body, '正在导入');
  };

  if (!offered) return null;
  return <section className="panel" id="importBox">
    <div className="section-head"><h2>从工作台导入</h2></div>
    <div className="panel-body">
      <p className="muted">读取本机旧工作台的保证金平衡配对：划转设置、ADL 设置、主账户与子账户凭据、飞书机器人，写入本服务配置后自动重启本服务（约半分钟，期间已启用配对的划转与 ADL 暂停）。导入的配对登记为停用：先在旧工作台删除该配对，再到「配对组」点「启用配对」。也可勾选导入工作台的原油执行账户（Binance / Bybit）；工作台有实盘启用的原油自动规则时，先在工作台停用。期权账户（工作台期权模块的 Bybit 密钥与风险上限）须先在工作台关闭自动开仓、处理完订单 / 任务 / RFQ 并平掉跟踪中的策略。行情监控（Anthropic 价差，只读公开行情，不需要密钥）与资产账本（工作台某个用户的只读账本，整体替换本项目现有账本）也在这里启用，不用手改配置；只重新导入资产账本时不重启服务。</p>
      <div className="toolbar">
        <button type="button" id="importPreviewBtn" className="button secondary" disabled={busy} onClick={() => void request({ action: 'preview' }, '正在读取工作台')}>读取工作台</button>
        {message ? <span className={message.tone} role="status">{message.text}</span> : null}
      </div>
      {result ? <Results result={result} picked={picked} setPicked={setPicked} picks={picks} setPicks={setPicks} onRun={run} busy={busy} /> : null}
    </div>
  </section>;
}
