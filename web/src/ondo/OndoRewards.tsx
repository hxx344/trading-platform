// 奖励市场盘口与收益模拟（本服务新增，docs/ondo.md §5–§6）：每个奖励市场前 5 bps 的各档挂单量，以及按波动率、
// 挂单量与奖励公式估算的每日收益。数据来自 GET /api/ondo/rewards（服务每分钟采样一次），模拟在页面里算。
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, LoaderCircle, Save } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import { BANDS, simulate, sweep, SWEEP_BPS, type SimMarket, type SimParams, type SimResult } from '../../../src/ondo/reward-sim.ts';
import type { OndoLevel, OndoRewardMarket, OndoRewardsView } from '../../../src/ondo/reward-types.ts';
import type { OndoMmConfig } from './ondo-mm-types.ts';
import { defaultSimForm, readSimForm, rewardConfigForm, rewardConfigRequest, SIM_STORAGE_KEY, simParams, type RewardConfigForm, type SimForm } from './reward-form.ts';

const ROOT = '/api/ondo/rewards';
const WINDOWS = [15, 60, 360] as const;
const readStored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 存不下时参数只在本次打开有效。 */ } };

const usd = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—'
  : Math.abs(value) >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : Math.abs(value) >= 1e4 ? `${(value / 1e3).toFixed(1)}k` : value.toFixed(0);
const money = (value: number | null | undefined) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
const fixed = (value: number | null | undefined, digits: number) => value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits);
const sum5 = (buckets: readonly number[]) => buckets.slice(0, 10).reduce((total, value) => total + value, 0);
const time = (ms: number | null) => ms ? new Date(ms).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const fee = (text: string | null) => { const value = text === null ? NaN : Number(text); return Number.isFinite(value) ? value : null; };
const simMarket = (market: OndoRewardMarket): SimMarket => ({ bid: market.avg.bid, ask: market.avg.ask, sigma1m: market.sigma1m, makerFee: fee(market.makerFee) });
const tone = (value: number | null) => value === null ? undefined : value >= 0 ? 'om-ok' : 'or-loss';

function Levels({ title, levels }: { title: string; levels: OndoLevel[] }) {
  return <div className="or-levels"><h3>{title}</h3>
    {!levels.length ? <TableEmpty>5 bps 内没有挂单</TableEmpty> : <table>
      <thead><tr><th scope="col" className="num">价格</th><th scope="col" className="num">数量</th><th scope="col" className="num">金额 USD</th><th scope="col" className="num">距中间价 bps</th><th scope="col" className="num">累计 USD</th></tr></thead>
      <tbody>{levels.map(level => <tr key={level.price}>
        <td className="num">{level.price}</td><td className="num">{level.size}</td><td className="num">{usd(level.usd)}</td><td className="num">{level.bps.toFixed(2)}</td>
        <td className="num">{usd(level.cumUsd)}{level.oursUsd > 0 ? <small>含本模块 {usd(level.oursUsd)}（已扣除）</small> : null}</td>
      </tr>)}</tbody></table>}
  </div>;
}

function Detail({ market, params, onExpired }: { market: OndoRewardMarket; params: SimParams | null; onExpired: () => void }) {
  // 展开时每 5 秒重读这个市场的盘口；服务对同一市场最多 2 秒读一次交易所。
  const book = useLiveResource<OndoRewardMarket>(`${ROOT}/book?market=${encodeURIComponent(market.market)}`, { intervalMs: 5000, timeoutMs: 10_000, onExpired });
  const shown = book.data ?? market;
  const rows = useMemo(() => params ? sweep(simMarket(market), params, SWEEP_BPS) : [], [market, params]);
  return <div className="or-detail">
    <p className="muted">盘口 {time(shown.at)}{book.error && !(book.error instanceof ApiError && book.error.status === 401) ? `（刷新失败：${book.error.message}）` : ''} · 中间价 {fixed(shown.mid, 4)} · 买一 {shown.bid ?? '—'} / 卖一 {shown.ask ?? '—'} · 金额已扣除本模块自己的挂单</p>
    {shown.levels ? <div className="or-books"><Levels title="买盘（前 5 bps）" levels={shown.levels.bid} /><Levels title="卖盘（前 5 bps）" levels={shown.levels.ask} /></div> : <TableEmpty>还没有盘口数据</TableEmpty>}
    {params ? <div className="or-levels"><h3>不同挂单距离的估算（最近距离与挂单距离保持当前差值）</h3><table>
      <thead><tr><th scope="col" className="num">距离 bps</th><th scope="col">档位</th><th scope="col" className="num">份额 买 / 卖</th><th scope="col" className="num">奖励/日</th><th scope="col" className="num">成交/日</th><th scope="col" className="num">亏损/日</th><th scope="col" className="num">净收益/日</th></tr></thead>
      <tbody>{rows.map(({ distanceBps, result }) => <tr key={distanceBps}>
        <td className="num">{distanceBps}</td><td>{result.band === null ? '无奖励' : `${BANDS[result.band].from}–${BANDS[result.band].to} bps（${BANDS[result.band].weight * 100}%）`}</td>
        <td className="num">{(result.share.bid * 100).toFixed(1)}% / {(result.share.ask * 100).toFixed(1)}%</td>
        <td className="num">{money(result.rewardDay)}</td><td className="num">{fixed(result.fillsDay, 1)}</td><td className="num">{money(result.lossDay)}</td>
        <td className={`num ${tone(result.netDay) ?? ''}`}>{money(result.netDay)}</td>
      </tr>)}</tbody></table></div> : null}
  </div>;
}

function Field({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (value: string) => void }) {
  return <label className="wb-field"><span>{label}</span><input inputMode="decimal" value={value} onChange={event => onChange(event.target.value)} /><small>{hint}</small></label>;
}

export function OndoRewards({ mmConfig, onExpired }: { mmConfig: OndoMmConfig | null; onExpired: () => void }) {
  const [windowMin, setWindowMin] = useState<number>(60);
  const resource = useLiveResource<OndoRewardsView>(`${ROOT}?window=${windowMin}`, { intervalMs: 15_000, timeoutMs: 10_000, onExpired });
  const view = resource.data;
  const [form, setForm] = useState<SimForm | null>(() => readSimForm(readStored(SIM_STORAGE_KEY)));
  // 第一次打开时按已保存的挂单设置给出默认参数；之后以本浏览器记住的为准。
  useEffect(() => { if (!form && mmConfig) setForm(defaultSimForm(mmConfig)); }, [form, mmConfig]);
  const shownForm = form ?? defaultSimForm(mmConfig);
  const change = (next: Partial<SimForm>) => { const merged = { ...shownForm, ...next }; setForm(merged); store(SIM_STORAGE_KEY, merged); };
  const parsed = view ? simParams(shownForm, view.config) : null;
  const params = parsed && 'params' in parsed ? parsed.params : null;
  const [byNet, setByNet] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState<RewardConfigForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const rows = useMemo(() => {
    if (!view) return [];
    const list = view.markets.map(market => ({ market, result: params ? simulate(simMarket(market), params) : null as SimResult | null }));
    if (byNet) list.sort((a, b) => (b.result?.netDay ?? -Infinity) - (a.result?.netDay ?? -Infinity));
    return list;
  }, [view, params, byNet]);
  const positive = rows.filter(row => row.result?.netDay !== null && row.result?.netDay !== undefined && row.result.netDay > 0);
  const total = { reward: positive.reduce((sum, row) => sum + row.result!.rewardDay, 0), net: positive.reduce((sum, row) => sum + row.result!.netDay!, 0) };

  const saveSettings = async () => {
    if (!settings) return;
    const request = rewardConfigRequest(settings);
    if ('error' in request) { setSaveError(request.error); return; }
    setSaving(true); setSaveError('');
    try { await api<OndoRewardsView>(`${ROOT}/config`, { method: 'PUT', body: request.body }); setSettings(null); await resource.refresh(); }
    catch (reason) { if (reason instanceof ApiError && reason.status === 401) onExpired(); else setSaveError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setSaving(false); }
  };

  const loadError = resource.error && !(resource.error instanceof ApiError && resource.error.status === 401) ? resource.error.message : '';
  return <section className="panel wb-section or-panel" aria-label="奖励市场盘口与收益模拟">
    <div className="panel-heading"><h2>奖励市场盘口与收益模拟</h2>
      <div className="or-heading-tools">
        <label className="or-window">统计窗口<select value={windowMin} onChange={event => setWindowMin(Number(event.target.value))}>{WINDOWS.map(minutes => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</option>)}</select></label>
        <span className="muted">{view ? `更新 ${time(view.serverNow)} · 每市场每分钟采样` : ''}</span>
      </div></div>
    {loadError ? <Callout tone="warning">奖励数据读取失败：{loadError}。保留最后读取的数据，稍后自动重试。</Callout> : null}
    {view?.rulesError ? <Callout tone="warning">{view.rulesError}</Callout> : null}
    {view?.loadError ? <Callout tone="warning">{view.loadError}</Callout> : null}
    {!view ? <StatePanel kind="loading" title="正在读取奖励市场" /> : <>
      <div className="om-form or-sim">
        <p className="muted or-note">奖励按 Ondo 公布的规则估算：每次随机快照按 挂单金额 × e^(−k·距中间价) 打分，0–5 / 5–10 / 10–25 bps 分别分 85% / 10% / 5%，
          每周奖池 {Number(view.config.poolUsd).toLocaleString()} USD 由 {view.config.eligible} 个市场均分，买卖两侧各算一半。成交按测得的 1 分钟波动率估算：撤单反应时间内中间价走过最近距离就算成交，
          每笔亏损 = 平仓耗时内的平均波动 + 两次 Maker 手续费。k、奖池均为假设，结果只作比较。</p>
        <div className="wb-grid or-grid">
          <Field label="每单金额（USD）" hint="每侧一单" value={shownForm.sizeUsd} onChange={value => change({ sizeUsd: value })} />
          <Field label="挂单距离（bps）" hint="决定档位与得分" value={shownForm.distanceBps} onChange={value => change({ distanceBps: value })} />
          <Field label="最近距离（bps）" hint="比这更近就撤单重挂" value={shownForm.minBps} onChange={value => change({ minBps: value })} />
          <Field label="撤单反应时间（秒）" hint="行情移动到撤单完成" value={shownForm.reactionSec} onChange={value => change({ reactionSec: value })} />
          <Field label="平仓耗时（秒）" hint="成交后到平掉的时间" value={shownForm.holdSec} onChange={value => change({ holdSec: value })} />
          <Field label="衰减系数 k（每 bps）" hint="Ondo 未公布；0 表示同档不论远近" value={shownForm.decayK} onChange={value => change({ decayK: value })} />
          <Field label="在线比例（%）" hint="被快照到的比例" value={shownForm.uptimePct} onChange={value => change({ uptimePct: value })} />
          <label className="wb-field"><span>挂单方向</span><select value={shownForm.sides} onChange={event => change({ sides: event.target.value === '1' ? '1' : '2' })}><option value="2">买卖双边</option><option value="1">只挂买单</option></select><small>双边与挂单模块一致</small></label>
        </div>
        <div className="or-actions">
          <label className="checkbox-field"><input type="checkbox" checked={byNet} onChange={event => setByNet(event.target.checked)} />按净收益排序</label>
          <button type="button" className="button secondary" onClick={() => { const next = defaultSimForm(mmConfig); setForm(next); store(SIM_STORAGE_KEY, next); }}>按挂单设置重置</button>
          <button type="button" className="button secondary" onClick={() => { setSettings(settings ? null : rewardConfigForm(view.config)); setSaveError(''); }}>{settings ? '收起奖励设置' : '奖励设置'}</button>
        </div>
        {parsed && 'error' in parsed ? <Callout tone="warning">{parsed.error}</Callout> : null}
        {settings ? <div className="or-settings">
          <div className="wb-grid or-grid">
            <label className="wb-field wide"><span>观察的市场</span><input value={settings.markets} onChange={event => setSettings({ ...settings, markets: event.target.value })} /><small>逗号分隔，最多 40 个。奖励市场名单每周可能变化，以 Ondo 公告为准。</small></label>
            <Field label="每周奖池（USD）" hint="以 Ondo 当周公告为准" value={settings.poolUsd} onChange={value => setSettings({ ...settings, poolUsd: value })} />
            <Field label="参与分配的市场数" hint="奖池在这些市场间均分" value={settings.eligible} onChange={value => setSettings({ ...settings, eligible: value })} />
          </div>
          {saveError ? <Callout tone="error">{saveError}</Callout> : null}
          <button type="button" className="button primary" disabled={saving} onClick={() => void saveSettings()}>{saving ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存奖励设置</button>
        </div> : null}
      </div>
      {!rows.length ? <TableEmpty>没有观察的市场</TableEmpty> : <div className="om-table or-table"><table>
        <thead><tr>
          <th scope="col">市场</th><th scope="col" className="num">中间价</th><th scope="col" className="num">价差 bps</th><th scope="col" className="num">1 分钟波动</th>
          <th scope="col" className="num">前 5 bps 买 / 卖（当前）</th><th scope="col" className="num">前 5 bps 买 / 卖（平均）</th>
          <th scope="col" className="num">份额 买 / 卖</th><th scope="col" className="num">奖励/日</th><th scope="col" className="num">成交/日</th><th scope="col" className="num">亏损/日</th><th scope="col" className="num">净收益/日</th>
        </tr></thead>
        <tbody>{rows.map(({ market, result }) => {
          const expanded = open === market.market;
          const thin = (market.avg.cover.bid !== null && market.avg.cover.bid < 25) || (market.avg.cover.ask !== null && market.avg.cover.ask < 25);
          return <Fragment key={market.market}>
            <tr>
              <th scope="row"><button type="button" className="or-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : market.market)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{market.market}</button>
                {market.error ? <small className="om-hold">{market.error}</small> : market.listed === false ? <small className="om-hold">交易所没有这个市场</small> : market.trading === false ? <small className="om-hold">休市或暂停交易</small> : null}</th>
              <td className="num">{fixed(market.mid, 4)}</td>
              <td className="num">{fixed(market.spreadBps, 2)}</td>
              <td className="num">{market.sigma1m === null ? <span className="muted">样本 {market.returns}/10</span> : `${(market.sigma1m * 1e4).toFixed(2)} bps`}</td>
              <td className="num">{market.depth5 ? `${usd(market.depth5.bid)} / ${usd(market.depth5.ask)}` : '—'}</td>
              <td className="num">{market.avg.samples ? `${usd(sum5(market.avg.bid))} / ${usd(sum5(market.avg.ask))}` : '—'}<small>{market.avg.samples} 次采样{thin ? ` · 盘口只覆盖到 ${fixed(Math.min(market.avg.cover.bid ?? 25, market.avg.cover.ask ?? 25), 1)} bps` : ''}</small></td>
              <td className="num">{result && market.avg.samples ? `${(result.share.bid * 100).toFixed(1)}% / ${(result.share.ask * 100).toFixed(1)}%` : '—'}</td>
              <td className="num">{result && market.avg.samples ? money(result.rewardDay) : '—'}</td>
              <td className="num">{fixed(result?.fillsDay, 1)}</td>
              <td className="num">{money(result?.lossDay)}</td>
              <td className={`num ${tone(result?.netDay ?? null) ?? ''}`}>{money(result?.netDay)}</td>
            </tr>
            {expanded ? <tr className="or-detail-row"><td colSpan={11}><Detail market={market} params={params} onExpired={onExpired} /></td></tr> : null}
          </Fragment>;
        })}</tbody>
        {params ? <tfoot><tr><th scope="row" colSpan={7}>只挂净收益为正的 {positive.length} 个市场合计</th><td className="num">{money(total.reward)}</td><td /><td /><td className={`num ${tone(total.net) ?? ''}`}>{money(total.net)}</td></tr></tfoot> : null}
      </table></div>}
    </>}
  </section>;
}
