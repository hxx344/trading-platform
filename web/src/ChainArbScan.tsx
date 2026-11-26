import { useEffect, useState, type FormEvent } from 'react';
import { CHAIN_ARB_MAX_IMPACT_BPS, VENUE_NAMES, type ChainArbVenue } from '../../src/chain-arb/model.ts';
import { ALL_SCAN_VENUES, type BackgroundView } from '../../src/chain-arb/background-model.ts';
import type { ScanRow, ScanView } from '../../src/chain-arb/scan-model.ts';
import { api, ApiError } from './api.ts';
import { chainNames } from './chain-arb-form.ts';
import { backgroundBands, backgroundDraft, HISTORY_DISPLAY_LIMIT, readTimedScan, saveBackgroundDraft, venueScanForm,
  type BackgroundDraft, type ScanForm, type VerifiedScanRow } from './chain-arb-scan-form.ts';
import { clock } from './labels.ts';
import { readFailure } from './live-resource.ts';
import { Callout, StatePanel, TableEmpty } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';

const path = '/api/monitor/perpetual/chain-arb-background';
const load = (signal: AbortSignal) => readTimedScan(() => api<BackgroundView>(path, { signal }));
const signed = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 5, signDisplay: 'exceptZero' });
const price = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 7 });
const phases: Record<ScanView['phase'], string> = {
  loading: '加载目录', scanning: '扫描中', cooldown: '上游限频', error: '扫描失败',
};
type Review = (form: ScanForm, row: ScanRow) => void;
type Rate = 'spotFeeBps' | 'perpFeeBps';
const rateLabels = { spotFeeBps: '现货单次费率（bp）', perpFeeBps: '永续单次费率（bp）' };

function ScanTable({ rows, history, review }: { rows: VerifiedScanRow[]; history?: boolean; review: (row: ScanRow) => void }) {
  return <div className="table-wrap"><table className="data chain-arb-ranking" aria-label={history ? '最近采样' : '有效机会'}>
    <thead><tr><th>币种 / 网络</th><th>交易所 / 路线</th><th>预计净收益</th><th>模拟损耗</th>
      <th>买入 / 交易所均价（USDT）</th><th>链上 Gas（USDT）</th><th>报价时间</th><th>操作</th></tr></thead>
    <tbody>{rows.map(row => <tr key={[row.venue ?? 'gate', row.chain, row.address, row.kind, row.at].join('/')}>
      <td><strong>{row.symbol}</strong><small>{chainNames[row.chain]}</small></td>
      <td>{VENUE_NAMES[row.venue ?? 'gate']}<small>{row.kind === 'spot' ? '充值卖出' : '永续对冲 · 基差收敛'}</small></td>
      <td className="num"><strong className={history ? undefined : 'ok'}>{signed.format(row.netBps)} bp</strong><small>{signed.format(row.netUsdt)} USDT</small></td>
      <td className="num">价格冲击 {price.format(row.execution.impactBps / 100)}%<small>转账扣量 {price.format(row.execution.receivedQuantity - row.execution.transferQuantity)} {row.symbol}</small></td>
      <td className="num">{price.format(row.dexPrice)} / {price.format(row.gatePrice)}</td>
      <td className="num">{price.format(row.gasUsdt)}</td><td className="num">{clock(row.at)}</td>
      <td><button className="button secondary" type="button" onClick={() => review(row)}>单币复核</button></td>
    </tr>)}</tbody>
  </table></div>;
}

export function LedgerConnectionHelp({ venues, assetEnabled }: { venues: ChainArbVenue[]; assetEnabled: boolean }) {
  const accounts = venues.filter(venue => venue === 'gate' || venue === 'okx').map(venue => VENUE_NAMES[venue]).join('、');
  if (!accounts) return null;
  return <div className="toolbar">
    <span className="muted">{assetEnabled ? '可在资产账本的「交易所连接」中管理 ' + accounts + ' 只读账户。'
      : '请先在设置的「从工作台导入」中启用资产账本，再到资产页的「交易所连接」添加 ' + accounts + ' 只读账户。'}
      {venues.includes('gate') && 'Gate 使用账本连接核对所选网络的充值资格和最低充值额，无法核实时不列入机会。查询时 Gate 可能生成该币种的充值地址。'}</span>
    <a className="button secondary" href={assetEnabled ? '#/asset' : '#/settings'}>{assetEnabled ? '打开资产账本' : '打开设置'}</a>
  </div>;
}

function ScanSettings({ view, assetEnabled, saving, form, edit, apply, reset, changed, conflict, error, saved }: {
  view: BackgroundView; assetEnabled: boolean; saving: boolean; form: BackgroundDraft; edit: (patch: Partial<BackgroundDraft>) => void;
  apply: (event: FormEvent) => void; reset: () => void; changed: boolean; conflict: boolean; error: string; saved: boolean;
}) {
  function field(key: Exclude<keyof ScanForm, 'chain'> | 'thresholdBps', label: string) {
    return <label>{label}<input data-slot="input" name={key} value={form[key]} inputMode="decimal" autoComplete="off"
      onChange={e => edit({ [key]: e.target.value })} /></label>;
  }
  function toggleRates(venue: ChainArbVenue) {
    const fees = { ...form.fees };
    if (fees[venue]) delete fees[venue];
    else fees[venue] = { spotFeeBps: form.spotFeeBps, perpFeeBps: form.perpFeeBps };
    edit({ fees });
  }
  function rateField(venue: ChainArbVenue, key: Rate) {
    const override = form.fees?.[venue];
    if (!override) return null;
    return <label>{rateLabels[key]}<input name={venue + '-' + key} aria-label={VENUE_NAMES[venue] + rateLabels[key]}
      data-slot="input" value={override[key]} inputMode="decimal" autoComplete="off"
      onChange={e => edit({ fees: { ...form.fees, [venue]: { ...override, [key]: e.target.value } } })} /></label>;
  }
  const robot = view.robot === 'feishuMonitor' ? '行情监控飞书机器人' : view.robot === 'feishu' ? '通用飞书机器人' : '未配置飞书机器人';
  return <section className="panel">
    <div className="section-head"><div><h2>后台扫描</h2><p>服务器持续分批询价，关闭页面后仍按已保存的条件运行。</p></div>
      <span className="status-line">{view.settings.enabled ? '已启用' : '已关闭'}</span></div>
    <form className="panel-body" onSubmit={apply}>
      <fieldset className="chain-arb-config" disabled={saving}>
        <label className="chain-arb-check"><input type="checkbox" name="enabled" checked={form.enabled}
          onChange={e => edit({ enabled: e.target.checked })} />启用后台扫描</label>
        <fieldset className="chain-arb-venues"><legend>扫描交易所</legend><div className="toolbar">{ALL_SCAN_VENUES.map(venue =>
          <label className="chain-arb-check" key={venue}><input type="checkbox" name={'venue-' + venue}
            checked={form.venues.includes(venue)} onChange={e => edit({ venues: e.target.checked ? [...form.venues, venue] : form.venues.filter(v => v !== venue) })} />
            {VENUE_NAMES[venue]}</label>)}</div></fieldset>
        <LedgerConnectionHelp venues={form.venues} assetEnabled={assetEnabled} />
        <div className="chain-arb-fields">
          <label>网络<select data-slot="select-trigger" name="chain" value={form.chain} onChange={e => edit({ chain: e.target.value })}>
            <option value="all">全部网络（3 条链）</option>
            {Object.entries(chainNames).map(([chain, name]) => <option key={chain} value={chain}>{name}</option>)}
          </select></label>
          {field('amount', '买入预算（USDT）')}{field('thresholdBps', '飞书通知阈值（bp）')}
        </div>
        <p className="muted">{robot}。预计净收益率超过阈值才通知，1 bp = 0.01%。同一交易所、网络、合约地址和路线每 30 分钟最多提醒一次。</p>
        <details className="chain-arb-fees"><summary>费率与额外成本</summary>
          <div className="chain-arb-fields">{field('spotFeeBps', rateLabels.spotFeeBps)}{field('perpFeeBps', rateLabels.perpFeeBps)}
            {field('spotCosts', '现货额外成本（USDT）')}{field('perpCosts', '永续额外成本（USDT）')}</div>
          {ALL_SCAN_VENUES.filter(v => form.venues.includes(v)).map(venue => <div key={venue} className="chain-arb-override">
            <label className="chain-arb-check"><input name={'fees-' + venue} type="checkbox" checked={!!form.fees?.[venue]}
              onChange={() => toggleRates(venue)} />为 {VENUE_NAMES[venue]} 单独设置费率</label>
            {form.fees?.[venue] ? <div className="chain-arb-routes">{rateField(venue, 'spotFeeBps')}{rateField(venue, 'perpFeeBps')}</div> : null}
          </div>)}
        </details>
        {conflict ? <Callout tone="warning">其他页面已更新扫描条件。载入最新设置后可重新编辑。</Callout> : null}
        {error ? <Callout tone="error">{error}</Callout> : null}
        <div className="toolbar">
          <button className="button primary" disabled={saving || conflict} type="submit">{saving ? '正在保存…'
            : form.enabled === view.settings.enabled ? '保存设置' : form.enabled ? '保存并启动扫描' : '保存并停止扫描'}</button>
          {changed || conflict ? <button className="button secondary" type="button" onClick={reset}>{conflict ? '载入最新设置' : '放弃修改'}</button> : null}
          <small className="muted" role="status">{changed ? '有未保存的修改' : saved ? '设置已保存' : ''}</small>
        </div>
      </fieldset>
    </form>
  </section>;
}

export function ChainArbScan({ assetEnabled, onReview, onExpired }: { assetEnabled: boolean; onReview: Review; onExpired: () => void }) {
  const read = useLiveResource(path, { intervalMs: 2_000, read: load, onExpired });
  const [draft, setDraft] = useState<{ revision: number; form: BackgroundDraft } | null>(null);
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const failure = readFailure(read), view = read.data?.view;
  const { live, history, nextDeadline } = backgroundBands(read.data, !!failure || read.status === 'paused', performance.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(nextDeadline)) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, Math.ceil(nextDeadline - performance.now())));
    return () => clearTimeout(timer);
  }, [nextDeadline]);
  if (!view) return <StatePanel kind={failure ? 'error' : 'loading'} title={failure ? '无法读取后台扫描' : '正在读取后台扫描…'} detail={failure ?? undefined} />;
  const current = view, form = draft?.form ?? backgroundDraft(current.settings);
  const conflict = draft !== null && draft.revision !== current.revision;
  function edit(patch: Partial<BackgroundDraft>) {
    setDraft(previous => ({ revision: previous?.revision ?? current.revision, form: { ...(previous?.form ?? backgroundDraft(current.settings)), ...patch } }));
    setError(''); setSaved(false);
  }
  async function apply(event: FormEvent) {
    event.preventDefault();
    if (saving || conflict) return;
    setError(''); setSaved(false);
    let settings;
    try { settings = saveBackgroundDraft(form); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '扫描参数无效'); return; }
    try {
      setSaving(true);
      const updated = await api<BackgroundView>(path, { body: { revision: draft?.revision ?? current.revision, settings } });
      if (!updated.settings || !Number.isSafeInteger(updated.revision)) throw new Error('保存应答不完整，请核对重新读取的设置');
      read.commit({ startedAt: performance.now(), view: { ...updated, results: {} } });
      setDraft(null); setSaved(true);
      await read.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存后台扫描设置失败');
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else await read.refresh();
    } finally { setSaving(false); }
  }
  const review = (row: ScanRow) => onReview(venueScanForm(current.settings, row.venue ?? 'gate'), row);
  return <>
    <ScanSettings view={current} assetEnabled={assetEnabled} form={form} saving={saving} edit={edit} changed={draft !== null} conflict={conflict} saved={saved}
      apply={apply} reset={() => { setDraft(null); setError(''); setSaved(false); }} error={error} />
    {failure ? <Callout tone="error">扫描读取失败 · {failure}。恢复前仅显示最近采样。</Callout> : null}
    {view.error ? <Callout tone="warning">{view.error}</Callout> : null}
    <section className="panel">
      <div className="section-head"><div><h2>有效机会{live.length ? ' · ' + live.length : ''}</h2>
        <p>按整笔买入预算的预计净收益率排序。两条路线都要求该网络充值开放、现货买盘足额，永续对冲还须有足额合约买盘。</p></div></div>
      <div className="panel-body">
        {view.settings.enabled ? <ul className="chain-arb-progress" aria-label="各交易所扫描进度">{view.settings.venues.map(venue => {
          const progress = view.results[venue];
          return <li key={venue}><strong>{VENUE_NAMES[venue]}</strong> {progress
            ? <>{phases[progress.phase]} · 第 {progress.cycle} 轮 · 已检查 {progress.checked} / {progress.total} · 失败 {progress.failed}
              {progress.message ? <small>{progress.message}</small> : null}</> : '等待扫描'}</li>;
        })}</ul> : null}
        {live.length ? <ScanTable rows={live} review={review} /> : <TableEmpty>
          {view.settings.enabled ? '暂无仍在有效期内、通过整笔模拟的正收益机会。' : '后台扫描已关闭。'}</TableEmpty>}
        <p className="muted">整笔模拟的价格冲击上限为 {CHAIN_ARB_MAX_IMPACT_BPS / 100}%。收益按普通转账实收量估算，扣除链上 Gas、现货卖出费和路线额外成本。永续路线另扣开平仓费，按基差收敛测算，资金费另计。</p>
      </div>
    </section>
    <section className="panel">
      <div className="section-head"><div><h2>最近采样</h2><p>近 5 分钟的历史行情，最多 {HISTORY_DISPLAY_LIMIT} 条。单币复核将重新询价。</p></div></div>
      {history.length ? <ScanTable rows={history} history review={review} /> : <TableEmpty>暂无历史采样。</TableEmpty>}
    </section>
  </>;
}
