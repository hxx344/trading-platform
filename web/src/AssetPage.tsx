// The asset page: the workbench ledger's overview, history and withdrawals views (project_aggregation
// modules/asset/app/dashboard.tsx and withdrawals-panel.tsx at 0014655), read-only. Changes: the data is what
// src/asset/import.ts imported and the service computes the figures (/api/asset/*); nothing syncs, refreshes prices or
// rates, or writes, so the refresh button, the edit, fx and connection dialogs, the import dialog, the withdrawal form and
// the connections view are left out; dialogs became panels opened in place; the connections side panel lists the
// exchange totals instead.
import { Eye, Info, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api.ts';
import { StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';
import { AssetTrend } from './AssetTrend.tsx';
import { isExchangeMode, EXCHANGE_NAMES, type AssetHistoryView, type AssetLedgerView, type AssetPeriodView, type AssetState, type AssetWithdrawalsView, type HistoryRow } from '../../src/asset/views.ts';
import type { Asset } from '../../src/asset/types.ts';
import {
  IMPORT_COMMAND, badge, detailHeads, detailLine, detailNote, detailSubtitle, detailTitle, fullStamp, fxView, money, periodFxTitle, periodKind, periodSource,
  priceText, quantityText, stamp, staleRow, statusTone, zhMoney,
} from './asset-format.ts';

export const ASSET_STATE_PATH = '/api/asset/state';
export const ASSET_READ_TIMEOUT_MS = 10_000;
/** The data only changes with a new import; the minute is how soon one shows. */
const REFRESH_MS = 60_000;

type View = 'overview' | 'history' | 'withdrawals';
const VIEWS: { id: View; label: string }[] = [{ id: 'overview', label: '资产总览' }, { id: 'history', label: '历史记录' }, { id: 'withdrawals', label: '出金记录' }];
type Filter = 'all' | 'auto' | 'manual';
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: '全部资产' }, { id: 'auto', label: '自动更新' }, { id: 'manual', label: '手动维护' }];

export function AssetPage({ onExpired }: { onExpired: () => void }) {
  const [view, setView] = useState<View>('overview');
  const state = useLiveResource<AssetState>(ASSET_STATE_PATH, { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, onExpired });
  const imported = state.data?.imported === true;
  const ledger = useLiveResource<AssetLedgerView>('/api/asset/ledger', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported, onExpired });
  const history = useLiveResource<AssetHistoryView>('/api/asset/history', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported && view !== 'withdrawals', onExpired });
  const withdrawals = useLiveResource<AssetWithdrawalsView>('/api/asset/withdrawals', { intervalMs: REFRESH_MS, timeoutMs: ASSET_READ_TIMEOUT_MS, enabled: imported && view === 'withdrawals', onExpired });
  const version = state.data?.importedAt ?? '';
  // A new import shows up in the state first; the views follow at once instead of at their next minute.
  const seen = useRef(version);
  const { refresh: refreshLedger } = ledger, { refresh: refreshHistory } = history, { refresh: refreshWithdrawals } = withdrawals;
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    void refreshLedger(); void refreshHistory(); void refreshWithdrawals();
  }, [version, refreshLedger, refreshHistory, refreshWithdrawals]);

  const failed = (status: string) => status === 'error' || status === 'offline';
  if (!state.data) return <div className="asset-desk"><div className="page">{failed(state.status)
    ? <StatePanel kind="error" title="读取资产账本失败" detail={state.error?.message ?? '网络离线'} />
    : <StatePanel kind="loading" title="加载中…" />}</div></div>;
  if (!state.data.imported) return <div className="asset-desk"><div className="page">
    <StatePanel kind="empty" title="尚未导入资产账本" detail="本服务的资产页只读，数据来自工作台资产账本的一次导入。在服务器上运行下面的命令（参数见 README 的 asset 一节），导入完成后本页一分钟内显示。">
      <code className="import-command">{IMPORT_COMMAND}</code>
    </StatePanel>
  </div></div>;

  const info = state.data, data = ledger.data?.imported ? ledger.data : null;
  const refresh = () => { void state.refresh(); void ledger.refresh(); if (view !== 'withdrawals') void history.refresh(); else void withdrawals.refresh(); };
  const navigate = (next: View) => { setView(next); window.scrollTo({ top: 0 }); };
  const counts: Partial<Record<View, string>> = { history: history.data?.imported ? String(history.data.periods.length) : undefined, withdrawals: data?.ledger ? String(data.ledger.withdrawals.length) : undefined };
  const readErrors = [state, ledger, view === 'withdrawals' ? withdrawals : history].filter(item => failed(item.status) && item.error).map(item => item.error!.message);
  const alerts: { key: string; role: 'alert' | 'status'; text: string; tone: 'error' | 'warn' }[] = [
    ...[...new Set(readErrors)].map(text => ({ key: 'read:' + text, role: 'alert' as const, text: '读取失败：' + text + '。当前显示上次读取的数据。', tone: 'error' as const })),
    ...(data?.ledger?.fxStatus.error ? [{ key: 'fx', role: 'status' as const, text: data.ledger.fxStatus.error + '，人民币折算暂用 1 USD = ' + money(data.ledger.fx, 4) + ' CNY。', tone: 'warn' as const }] : []),
    ...(data?.summary?.valuation.partial ? [{ key: 'valuation', role: 'status' as const, text: data.summary.valuation.missingValues + ' 项资产估值缺失，汇总仅包含已知金额，当前为部分估值。', tone: 'warn' as const }] : []),
    ...(data?.ledger?.assets ?? []).filter(asset => asset.error).map(asset => ({ key: 'asset-' + asset.id, role: 'status' as const, text: asset.project + '：' + asset.error, tone: 'warn' as const })),
  ];
  const example = data?.ledger?.dataKind === 'example'
    ? <div className="notice import-notice"><Info size={15} aria-hidden="true" /><div><strong>当前为示例数据，工作台尚未导入原表</strong><p>这里的资产和金额是演示内容。在工作台导入原表后重新运行导入命令，才会显示真实持仓和历史。</p></div></div> : null;
  return <div className="asset-desk">
    <div className="ledger-head">
      <nav className="ledger-tabs" aria-label="资产账本">{VIEWS.map(({ id, label }) => <button type="button" key={id} aria-current={view === id ? 'page' : undefined} onClick={() => navigate(id)}>{label}{counts[id] ? <span className="count-chip">{counts[id]}</span> : null}</button>)}</nav>
      <div className="ledger-head-meta">
        <span className="workspace-date">导入于 {fullStamp(info.importedAt)} · 北京时间</span>
        <button type="button" className="button" onClick={refresh}><RefreshCw size={15} aria-hidden="true" />重新读取</button>
      </div>
    </div>
    {alerts.length ? <div className="ledger-strip"><span className="strip-title"><TriangleAlert size={14} aria-hidden="true" />{alerts.length} 项提醒</span>{alerts.map(item => <span key={item.key} className={'strip-item ' + item.tone} role={item.role}>{item.text}</span>)}</div> : null}
    <div className="page">
      <div className="notice info" role="status"><Info size={15} aria-hidden="true" /><div>只读：数据停留在导入时刻（{fullStamp(info.importedAt)}，工作台用户 {info.source?.owner ?? '—'}，资产 {info.assets} 行、日快照 {info.snapshots.count} 份）。交易所同步、行情与汇率更新、编辑与出金登记尚未接入；要看新数据，请在工作台更新后重新导入。</div></div>
      {!data?.ledger || !data.summary ? (failed(ledger.status) ? <StatePanel kind="error" title="读取资产明细失败" detail={ledger.error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />)
        : <>
          {view !== 'overview' ? example : null}
          {view === 'overview' ? <Overview data={data as LoadedLedger} history={history.data?.imported ? history.data : null} historyError={failed(history.status) ? history.error?.message ?? '网络离线' : null} version={version} example={example} onHistory={() => navigate('history')} onWithdrawals={() => navigate('withdrawals')} onExpired={onExpired} />
            : view === 'history' ? <History history={history.data?.imported ? history.data : null} error={failed(history.status) ? history.error?.message ?? '网络离线' : null} />
            : <Withdrawals view={withdrawals.data?.imported ? withdrawals.data : null} error={failed(withdrawals.status) ? withdrawals.error?.message ?? '网络离线' : null} />}
          <footer className="page-footer">{data.ledger.dataKind === 'example' ? '示例账本 · 尚未导入原表' : '源自《资产统计.xlsx》'} · 起始持仓 {data.ledger.baselineDate} · 自 {data.ledger.startedAt} 开始更新 · 本页只读</footer>
        </>}
    </div>
  </div>;
}

type LoadedLedger = AssetLedgerView & { ledger: NonNullable<AssetLedgerView['ledger']>; summary: NonNullable<AssetLedgerView['summary']> };

function Overview({ data, history, historyError, version, example, onHistory, onWithdrawals, onExpired }: { data: LoadedLedger; history: AssetHistoryView | null; historyError: string | null; version: string; example: ReactNode; onHistory: () => void; onWithdrawals: () => void; onExpired: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const { ledger, summary } = data, { measures, valuation } = summary;
  const now = Date.now(), fx = fxView(ledger.fxStatus, now);
  const rows = data.rows.filter(asset => filter === 'all' || (filter === 'manual' ? asset.mode === 'manual' : asset.mode !== 'manual'));
  return <>
    <section className="panel ledger-kpis" aria-label="资产汇总">
      <div className="kpi hero"><div className="kpi-label">表内总额 <span>USD · 含累计出金{valuation.partial ? ' · 部分估值' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.adjusted)}</div><p className="kpi-sub">= 剔除出金影响（实际持有资产 + 累计出金）· 折合人民币 ¥ {money(measures.adjusted * ledger.fx)}</p></div>
      <div className="kpi"><div className="kpi-label">实际持有资产 <span>USD{valuation.partial ? ' · 部分估值' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.held)}</div><p className="kpi-sub">表内总额减去累计出金</p></div>
      <div className="kpi"><div className="kpi-label">累计出金 <span>USD{summary.withdrawals.partial ? ' · 部分金额' : ''}</span></div><div className="kpi-value"><span className="cur">$</span>{money(measures.withdrawn)}</div><p className="kpi-sub"><button type="button" className="text-button" onClick={onWithdrawals}>查看出金记录</button></p></div>
      <div className="kpi"><div className="kpi-label">交易所资产{summary.exchanges.partial ? <span>部分估值</span> : null}</div><div className="kpi-value"><span className="cur">$</span>{money(summary.exchanges.total)}</div><p className="kpi-sub">折合人民币 ¥ {money(summary.exchanges.total * ledger.fx)} · <span className="warn-text">导入时的估值，同步尚未接入</span></p></div>
      <div className="kpi"><div className="kpi-label">积分预估价值{summary.points.partial ? <span>部分估值</span> : null}</div><div className="kpi-value"><span className="cur">$</span>{money(summary.points.total)}</div><p className="kpi-sub">折合人民币 ¥ {money(summary.points.total * ledger.fx)} · 沿用表格估值</p></div>
      <div className="kpi"><div className="kpi-label">USD / CNY</div><div className="kpi-value">{money(ledger.fx, 4)}{fx.stale ? <span className="old" title="汇率未在 5 分钟内更新">旧</span> : null}</div><p className="kpi-sub"><span className={fx.stale ? 'warn-text' : 'good-text'}>1 USD = {money(ledger.fx, 4)} CNY · {fx.state}</span><br />{fx.source} · {fx.when}</p></div>
    </section>
    {example}
    <div className="overview-grid">
      <div className="overview-main">
        {history ? <AssetTrend history={history} version={version} onHistory={onHistory} onExpired={onExpired} />
          : historyError ? <StatePanel kind="error" title="读取资产变化失败" detail={historyError} /> : <StatePanel kind="loading" title="读取资产变化…" />}
        <section className="panel holdings">
          <div className="holdings-heading"><h2>资产明细 <span className="count-chip">{rows.length}</span></h2>
            <div data-slot="tabs-list" role="group" aria-label="筛选资产">{FILTERS.map(item => <button type="button" key={item.id} data-slot="tabs-trigger" data-state={filter === item.id ? 'active' : 'inactive'} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
            <span className="panel-h-right">单价、估值单位 USD · 北京时间</span></div>
          <AssetTable assets={rows} current now={now} data={data} />
          <p className="panel-foot">交易所行显示账户估值口径，不重复累加保证金或持仓名义价值；点查看可见分账户明细 · 缺失显示 —，不计 0</p>
        </section>
      </div>
      <div className="overview-side">
        <section className="panel sync-panel"><div className="panel-h"><h2>分交易所合计</h2><span className="panel-h-right">USD</span></div>
          {summary.byExchange.length ? summary.byExchange.map(item => {
            const connection = ledger.connections[item.mode];
            return <div className="connection-row" key={item.mode}><div className={'exchange-mark ' + item.mode} aria-hidden="true">{EXCHANGE_NAMES[item.mode][0]}</div>
              <div><strong>{item.name}</strong><small>{item.rows} 行 · 最近同步 {stamp(connection.lastSync)}{connection.error ? <span className="warn-text"> · 同步失败</span> : null}</small></div>
              <span className="exchange-total">$ {money(item.total)}{item.partial ? <small className="warn-text">部分估值</small> : null}</span></div>;
          }) : <p className="help exchange-empty">导入的账本没有交易所资产行。</p>}
          <p className="panel-foot">交易所资产合计 $ {money(summary.exchanges.total)}{summary.exchanges.partial ? '（部分估值）' : ''} · 估值停留在导入时刻 · 交易所连接与同步尚未接入</p>
        </section>
      </div>
    </div>
  </>;
}

/** The workbench's renderTable: `current` is the live ledger (marks, status, detail); a recorded period shows the bare rows. */
function AssetTable({ assets, current, now, data }: { assets: Asset[]; current: boolean; now: number; data?: LoadedLedger }) {
  const [detail, setDetail] = useState<string | null>(null);
  const columns = current ? 7 : 5;
  return <div data-slot="table-container"><table data-slot="table">
    <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">项目 / 资产</th><th data-slot="table-head">类型</th><th data-slot="table-head" className="numeric">数量</th><th data-slot="table-head" className="numeric">单价 / USD</th><th data-slot="table-head" className="numeric">估值 / USD</th>{current ? <><th data-slot="table-head">数据来源 / 更新时间</th><th data-slot="table-head" className="numeric">分项</th></> : null}</tr></thead>
    <tbody data-slot="table-body">{assets.map(a => {
      const label = badge(a, now), stale = current && staleRow(a, label), open = detail === a.id && !!a.details;
      const original = data?.ledger.assets.find(row => row.id === a.id);
      return <Fragment key={a.id}>
        <tr data-slot="table-row" className={stale ? 'stale-row' : undefined}>
          <td data-slot="table-cell"><div className="asset-cell">{current && isExchangeMode(a.mode) ? <span className={'exchange-mark ' + a.mode} aria-hidden="true">{EXCHANGE_NAMES[a.mode][0]}</span> : null}<div><strong className="asset-name">{a.project}</strong>
            {current && a.mode === 'aster' && data && data.ledger.asterAccounts.length > 0 ? <small className="ticker">{data.ledger.asterAccounts.length} 个账号</small> : null}
            {current && a.project.trim() === '出金' && data && data.summary.measures.recorded > 0 ? <small className="ticker">{a.id === 'recorded-withdrawals' ? '新增出金记录' : original?.value !== a.value ? '含新增出金记录' : ''}</small> : null}
            {a.project === 'virtual' ? <small className="ticker">VIRTUAL</small> : null}</div></div></td>
          <td data-slot="table-cell"><span className="kind">{a.kind}</span></td>
          <td data-slot="table-cell" className="numeric">{quantityText(a, current)}</td>
          <td data-slot="table-cell" className="numeric">{priceText(a, current)}</td>
          <td data-slot="table-cell" className="numeric asset-value">{a.value === null ? '—' : money(a.value)}</td>
          {current ? <>
            <td data-slot="table-cell"><span title={a.error} className={'status ' + statusTone(a, label)}>{label}</span><small className="ticker">{stamp(a.updatedAt)}</small></td>
            <td data-slot="table-cell" className="numeric">{isExchangeMode(a.mode) && a.details ? <button type="button" className="icon-button" aria-expanded={open} aria-label={(open ? '收起 ' : '查看 ') + a.project + ' 资产'} onClick={() => setDetail(open ? null : a.id)}>{open ? <X size={15} /> : <Eye size={15} />}</button> : '—'}</td>
          </> : null}
        </tr>
        {open ? <tr data-slot="table-row" className="detail-row"><td data-slot="table-cell" colSpan={columns}><AccountDetail asset={a} /></td></tr> : null}
      </Fragment>;
    })}</tbody>
  </table></div>;
}

function AccountDetail({ asset }: { asset: Asset }) {
  const [account, amount] = detailHeads(asset.mode);
  return <section className="account-detail" aria-label={asset.project + ' ' + detailTitle(asset.mode)}>
    <h3>{asset.project} {detailTitle(asset.mode)}</h3><p className="help">{detailSubtitle(asset)}</p>
    <div data-slot="table-container"><table data-slot="table">
      <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">{account}</th><th data-slot="table-head" className="numeric">{amount}</th><th data-slot="table-head" className="numeric">美元价值</th></tr></thead>
      <tbody data-slot="table-body">{asset.details!.map((balance, index) => { const line = detailLine(asset.mode, balance); return <tr data-slot="table-row" key={index}>
        <td data-slot="table-cell">{balance.account}{line.coin !== null ? <small className="ticker">{line.coin}</small> : null}</td>
        <td data-slot="table-cell" className="numeric">{line.quantity}</td><td data-slot="table-cell" className="numeric">{line.value}</td></tr>; })}</tbody>
    </table></div>
    <p className="help">{detailNote(asset.mode)}</p>
  </section>;
}

function History({ history, error }: { history: AssetHistoryView | null; error: string | null }) {
  const [period, setPeriod] = useState<HistoryRow | null>(null);
  const [rows, setRows] = useState<{ id: string; rows: Asset[] } | { id: string; error: string } | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const open = (p: HistoryRow) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPeriod(p); setRows(null);
    api<AssetPeriodView>('/api/asset/period?id=' + encodeURIComponent(p.id), { signal: controller.signal, timeoutMs: ASSET_READ_TIMEOUT_MS })
      .then(data => { if (!controller.signal.aborted) setRows({ id: p.id, rows: data.rows }); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setRows({ id: p.id, error: reason instanceof Error ? reason.message : '无法读取历史明细' }); });
  };
  const close = () => { request.current?.abort(); setPeriod(null); setRows(null); };
  if (!history) return error ? <StatePanel kind="error" title="读取历史记录失败" detail={error} /> : <StatePanel kind="loading" title="加载中…" />;
  const loaded = rows && period && rows.id === period.id ? rows : null;
  return <>
    <div className="notice info">原表未来预填和导入前示例不计入曲线。同日多份记录在此保留；曲线优先采用日快照，其次采用最后一份原表记录。此处“原始表内总额”保留历史原值；总览表内总额与当前明细已加入新增出金。</div>
    {period ? <section className="panel holdings period-detail" aria-label={period.date + ' 资产快照'}>
      <div className="holdings-heading"><h2>{period.date} 资产快照</h2><span className="help">{periodKind(period)} · 总额 $ {money(period.total)}{period.missingValues ? ' · 部分估值，仅含已知金额' : ''}</span>
        <button type="button" className="button" onClick={close}><X size={15} aria-hidden="true" />关闭</button></div>
      {period.difference !== 0 ? <p className="notice">行估值之和与原合计相差 $ {money(period.difference)}。保留原合计，未修改历史。</p> : null}
      {!loaded ? <p className="help period-state" role="status">读取快照…</p> : 'error' in loaded ? <p className="error-text period-state" role="alert">{loaded.error}</p>
        : loaded.rows.length ? <AssetTable assets={loaded.rows} current={false} now={0} /> : <p className="help period-state">这份记录没有保存资产明细。</p>}
    </section> : null}
    <section className="panel holdings">
      {history.periods.length ? <div data-slot="table-container"><table data-slot="table">
        <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">日期（北京时间）</th><th data-slot="table-head">来源</th><th data-slot="table-head" className="numeric">原始表内总额 / USD</th><th data-slot="table-head" className="numeric">实际持有 / USD</th><th data-slot="table-head" className="numeric">累计出金 / USD</th><th data-slot="table-head" className="numeric">剔除出金影响 / USD</th><th data-slot="table-head" className="numeric">汇率</th><th data-slot="table-head" className="numeric">原总额 / CNY</th><th data-slot="table-head">核对 / 明细</th></tr></thead>
        <tbody data-slot="table-body">{history.periods.map(p => <tr data-slot="table-row" key={p.id}>
          <td data-slot="table-cell">{p.date}</td>
          <td data-slot="table-cell"><span className={'status ' + (p.future || p.partial ? 'amber' : '')}>{periodSource(p)}</span></td>
          <td data-slot="table-cell" className="numeric">{money(p.total)}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.held) : '—'}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.withdrawn) : '—'}</td>
          <td data-slot="table-cell" className="numeric">{p.included ? money(p.adjusted) : '—'}</td>
          <td data-slot="table-cell" className="numeric" title={periodFxTitle(p)}>{p.fx}{p.fxStatus?.error ? <small className="ticker">沿用旧汇率</small> : null}</td>
          <td data-slot="table-cell" className="numeric">{money(p.cny)}</td>
          <td data-slot="table-cell"><button type="button" className="text-button" aria-pressed={period?.id === p.id} onClick={() => open(p)}>{p.difference ? '合计差异 $ ' + money(p.difference) : '查看明细'}</button></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state">导入的账本没有历史记录。</div>}
      <p className="panel-foot">日快照由工作台在刷新或编辑时保存；页面关闭期间不补造记录。部分估值快照仅汇总已知金额。入金未剔除，资产变化不等于投资收益。本页的记录停留在导入时刻。</p>
    </section>
  </>;
}

function Withdrawals({ view, error }: { view: AssetWithdrawalsView | null; error: string | null }) {
  if (!view) return error ? <StatePanel kind="error" title="读取出金记录失败" detail={error} /> : <StatePanel kind="loading" title="加载中…" />;
  return <>
    <div className="notice info">原表“出金”已作为累计出金计入，当前{view.embedded.partial ? '已知金额（部分）' : '金额'}为 $ {zhMoney(view.embedded.total)}。下表是工作台登记的原表基准日 {view.baselineDate ?? '—'} 之后新增的出金，已自动加入总览表内总额及资产明细的出金数量和估值。本页只读，登记、修改与删除尚未接入。</div>
    <section className="panel holdings">
      <div className="holdings-heading"><h2>新增出金记录 <span className="count-chip">{view.withdrawals.length}</span></h2><p className="help">金额使用出金时的美元价值；账户间内部转账不记出金。</p></div>
      {view.withdrawals.length ? <div data-slot="table-container"><table data-slot="table">
        <thead data-slot="table-header"><tr data-slot="table-row"><th data-slot="table-head">日期（北京时间）</th><th data-slot="table-head" className="numeric">金额 / USD</th><th data-slot="table-head">备注</th></tr></thead>
        <tbody data-slot="table-body">{view.withdrawals.map(row => <tr data-slot="table-row" key={row.id}><td data-slot="table-cell">{row.date}</td><td data-slot="table-cell" className="numeric">{zhMoney(row.amount)}</td><td data-slot="table-cell" className="withdrawal-note">{row.note || '—'}</td></tr>)}</tbody>
      </table></div> : <div className="empty-state">没有登记新增出金。原表中的累计出金已自动纳入统计。</div>}
      <p className="panel-foot">登记不会改动持仓或再次扣减账户余额。补录、修改或删除出金后，对应日期起的调整曲线会重新计算，原始历史总额保持不变。</p>
    </section>
  </>;
}
