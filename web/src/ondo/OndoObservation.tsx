import { useEffect, useState } from 'react';
import { LoaderCircle, Play } from 'lucide-react';
import { TableEmpty } from '../StateViews.tsx';
import type { OndoObservationEarnings } from '../../../src/ondo/reward-types.ts';
import type { OndoMmSnapshot, OndoObservation } from './ondo-mm-types.ts';
import { capitalUsd, netAprPct, OBSERVATION_CAPITAL_KEY, readObservationCapital } from './observation-form.ts';
import { MAX_OBSERVE_MARKETS, observeStartRequest, type ObserveStartRequest } from './quote-form.ts';

const distances = [4, 8, 15] as const;
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const amount = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 15 });
const percent = (value: number | null) => value === null ? '—' : `${value !== 0 && Math.abs(value) < 0.01 ? value.toExponential(1) : number.format(value)}%`;
const dailyUsd = (value: number | null) => value === null ? '—' : value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const time = (ms: number | null) => ms === null ? '—' : new Date(ms).toLocaleString('zh-CN', { hour12: false });

function duration(ms: number) {
  if (ms < 1000) return ms > 0 ? '<1 秒' : '0 秒';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return (hours ? `${hours} 小时 ` : '') + (hours || minutes ? `${minutes} 分 ` : '') + `${seconds % 60} 秒`;
}

function Count({ count, perHour, sampled }: { count: number; perHour: number | null; sampled: boolean }) {
  const rate = perHour !== null && perHour > 0 && perHour < 0.01 ? '<0.01' : perHour === null ? null : number.format(perHour);
  return <td className="num">{sampled ? `${count} 次` : '—'}<small>{rate === null ? '—' : `${rate} 次/小时`}</small></td>;
}

function Apr({ net, capital }: { net?: number | null; capital: number | null }) {
  const apr = netAprPct(net, capital);
  return <span className={apr === null ? 'muted' : apr < 0 ? 'or-loss' : apr > 0 ? 'om-ok' : undefined}>{percent(apr)}</span>;
}

function useReferenceCapital(orderUsd: string, observation: OndoObservation | null) {
  const [saved, setSaved] = useState(() => {
    try { return readObservationCapital(localStorage.getItem(OBSERVATION_CAPITAL_KEY)); }
    catch { return readObservationCapital(null); }
  });
  const running = observation !== null && observation.endedAt === null;
  const nominalDefault = Number(orderUsd) * 2;
  const sampleDefault = observation?.earnings?.referenceCapitalUsd ?? nominalDefault;
  const formDefault = running ? sampleDefault : nominalDefault;
  const input = saved.input ?? String(formDefault);
  const usd = capitalUsd(input);
  const startedAt = observation?.startedAt;
  // Keep the denominator that this browser showed for the session, even across a reload or an edit for the next one.
  useEffect(() => {
    if (running && startedAt !== undefined) setSaved(prior => prior.session?.startedAt === startedAt && prior.session.usd === usd
      ? prior : { ...prior, session: { startedAt, usd } });
  }, [running, startedAt, usd]);
  useEffect(() => {
    try { localStorage.setItem(OBSERVATION_CAPITAL_KEY, JSON.stringify(saved)); } catch { /* 浏览器未允许持久化。 */ }
  }, [saved]);
  const historical = saved.session && saved.session.startedAt === startedAt ? saved.session.usd : sampleDefault;
  return { input, formDefault, custom: saved.input !== null, valid: usd !== null, denominator: running ? usd : historical,
    change: (value: string | null) => setSaved(prior => ({ ...prior, input: value })) };
}

function MarketPicker({ selected, configured, rewards, onChange }: {
  selected: string[]; configured: string[]; rewards: string[]; onChange: (next: string[]) => void;
}) {
  const options = [...new Set([...rewards, ...configured, ...selected])];
  const tooMany = rewards.length > MAX_OBSERVE_MARKETS;
  return <details className="oo-picker">
    <summary>选择观察市场 <strong>{selected.length} / {MAX_OBSERVE_MARKETS}</strong>
      <span className="muted">{selected.length ? selected.slice(0, 2).join('、') + (selected.length > 2 ? ' 等' : '') : '尚未选择'}</span></summary>
    <div className="or-actions">
      <button type="button" className="button secondary" disabled={!rewards.length || tooMany} onClick={() => onChange([...rewards])}>全选奖励市场{rewards.length ? `（${rewards.length}）` : ''}</button>
      <button type="button" className="button secondary" disabled={!selected.length} onClick={() => onChange([])}>清空选择</button>
    </div>
    {tooMany ? <p className="muted">奖励名单有 {rewards.length} 个市场，单次最多观察 {MAX_OBSERVE_MARKETS} 个，请分批勾选。</p> : null}
    <div className="oo-options" role="group" aria-label="本次观察市场">
      {options.map(market => <label className="checkbox-field" key={market}><input type="checkbox" checked={selected.includes(market)}
        disabled={!selected.includes(market) && selected.length >= MAX_OBSERVE_MARKETS}
        onChange={event => onChange(event.target.checked ? [...selected, market] : selected.filter(name => name !== market))} />{market}</label>)}
    </div>
  </details>;
}

function ObservationDetail({ rows, earnings, market, capital }: {
  rows: OndoObservation['rows']; earnings: OndoObservationEarnings | undefined; market: string; capital: number | null;
}) {
  const estimate = earnings?.markets.find(item => item.market === market);
  return <>
    {estimate && earnings ? <>
      <p className="muted oo-note">最近 {earnings.windowMin} 分钟有 {estimate.samples} 个奖励采样分钟、{estimate.returns} 个波动样本。最近奖励样本 {time(estimate.sampleAt)}。</p>
      <div className="om-table" role="region" aria-label={`${market} 收益明细`} tabIndex={0}><table>
        <thead><tr><th scope="col">目标距离</th><th scope="col" className="num">净 APR</th><th scope="col" className="num">净收益/日 USD</th>
          <th scope="col" className="num">奖励/日 USD</th><th scope="col" className="num">损失/日 USD</th><th scope="col" className="num">买 / 卖虚挂占比</th><th scope="col">样本状态</th></tr></thead>
        <tbody>{estimate.tiers.map(tier => <tr key={tier.distanceBps}><th scope="row">{tier.distanceBps} bps</th>
          <td className="num"><Apr net={tier.netDay} capital={capital} /></td><td className="num">{dailyUsd(tier.netDay)}</td>
          <td className="num">{dailyUsd(tier.rewardDay)}</td><td className="num">{dailyUsd(tier.lossDay)}</td>
          <td className="num">{percent(tier.buyUptime * 100)} / {percent(tier.sellUptime * 100)}</td><td>{tier.reason ?? '可估算'}</td></tr>)}</tbody>
      </table></div>
      <details className="oo-method"><summary>收益测算口径</summary>
        <p>每单 {number.format(earnings.orderUsd)} USD，每周奖池 {number.format(earnings.poolUsd)} USD，按 {earnings.eligible} 个市场分配。
          按各侧有效虚挂时长占会话时长、对应奖励档的盘口深度和衰减系数 {earnings.decayK} 估算日奖励。</p>
        <p>日损失按波动模型的预计成交次数、{earnings.reactionSec} 秒撤单反应时间、{earnings.holdSec} 秒平仓耗时和开平两次 Maker 手续费估算。
          本市场 Maker 费率 {estimate.makerFee === null ? '未知' : percent(estimate.makerFee * 100)}。IOC 的 Taker 费用、滑点和跳空会影响实际收益。</p>
      </details>
    </> : <p className="muted oo-note">本次记录缺少该市场的奖励估算。</p>}
    <h3 className="oo-subheading">观察触价统计</h3>
    {!rows.some(row => row.activeMs > 0 || row.touches > 0) ? <p className="muted oo-note">这个市场暂无有效虚挂样本。</p> : null}
    <div className="om-table" role="region" aria-label={`${market} 观察明细`} tabIndex={0}><table>
      <thead><tr><th scope="col">方向</th><th scope="col" className="num">目标距离</th><th scope="col" className="num">有效虚挂时长</th>
        <th scope="col" className="num">触价（含扫过）</th><th scope="col" className="num">扫过</th></tr></thead>
      <tbody>{rows.map(row => {
        const sampled = row.activeMs > 0 || row.touches > 0;
        return <tr key={`${row.side}-${row.distanceBps}`}><th scope="row">{row.side === 'buy' ? '买' : '卖'}</th>
          <td className="num">{row.distanceBps} bps</td><td className="num">{duration(row.activeMs)}</td>
          <Count count={row.touches} perHour={row.touchesPerHour} sampled={sampled} /><Count count={row.sweeps} perHour={row.sweepsPerHour} sampled={sampled} /></tr>;
      })}</tbody>
    </table></div>
    <p className="muted oo-note">对手方逐笔成交达到虚挂价记触价，严格越过还记扫过，每张虚拟单各最多记一次。各侧有效虚挂满 60 秒后显示小时频率。实际成交还取决于排队位置。</p>
  </>;
}

export function OndoObservationPanel({ snapshot, rewards, stale, busy, dirty, onStart }: {
  snapshot: OndoMmSnapshot; rewards: string[]; stale: boolean; busy: string; dirty: boolean; onStart: (body: ObserveStartRequest) => void;
}) {
  const data = snapshot.observation;
  const active = snapshot.phase !== 'stopped';
  const ended = data?.endedAt != null;
  const markets = [...new Set(data?.rows.map(row => row.market))];
  const [picked, setPicked] = useState<string[] | null>(null);
  const [detail, setDetail] = useState('');
  const selected = picked ?? (markets.length ? markets : snapshot.config.markets);
  const selectedDetail = markets.includes(detail) ? detail : markets[0];
  const capital = useReferenceCapital(snapshot.config.orderUsd, data);
  const earnings = data?.earnings;
  const body = observeStartRequest(snapshot.config.mode, snapshot.revision, selected);
  const block = dirty ? '请先保存挂单设置。' : snapshot.config.mode !== 'observe' ? '启动观察前，请在挂单设置中选择观察模式并保存。'
    : !selected.length ? '请至少勾选一个观察市场。' : !body ? `单次观察限 1–${MAX_OBSERVE_MARKETS} 个有效市场。` : '';
  const state = ended ? '观察已停止 · 本次结果已冻结' : !data ? '尚未启动' : stale ? '页面数据过期 · 保留上次读取'
    : !snapshot.stream?.publicReady ? '公开行情未连接 · 暂停计时' : '观察中';
  if (active && snapshot.live && !data) return null;
  return <section className="panel oo-panel" aria-label="并行观察与收益预览">
    <div className="panel-heading"><h2>并行观察与收益预览</h2><span className="muted">{state}{data ? ` · ${markets.length} 个市场` : ''}</span></div>
    {!active ? <div className="oo-setup">
      <MarketPicker selected={selected} configured={snapshot.config.markets} rewards={rewards} onChange={setPicked} />
      <button type="button" className="button primary" disabled={!!busy || !!block || stale || !body} title={block || undefined} onClick={() => { if (body) onStart(body); }}>
        {busy === 'start' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}启动观察</button>
      {block ? <p className="muted">{block}</p> : null}
    </div> : null}
    {(!active || !snapshot.live) ? <div className="oo-capital">
      <label className="wb-field"><span>{ended ? '下次观察的' : ''}每市场参考本金（USD）</span><input inputMode="decimal" maxLength={24} value={capital.input}
        aria-invalid={!capital.valid} onChange={event => capital.change(event.target.value)} /></label>
      <div><p className="muted">默认 {amount.format(capital.formDefault)} USD，按买卖各一单的名义金额估算。本金设置保存在本浏览器。</p>
        {capital.custom ? <button type="button" className="or-toggle" onClick={() => capital.change(null)}>恢复默认本金</button> : null}
        {!capital.valid ? <p className="om-hold" role="alert">参考本金须为大于 0 的美元金额。</p> : null}</div>
    </div> : null}
    {!data ? <TableEmpty>暂无观察记录。勾选市场后启动观察，可同时比较各市场的 4、8、15 bps 虚拟挂单。</TableEmpty> : <>
      <div className="oo-results-heading"><h3>每市场预估净 APR</h3>
        <span className="muted">{time(data.startedAt)} 至 {time(data.endedAt ?? earnings?.asOf ?? snapshot.serverNow)}</span></div>
      <p className="muted oo-note">各档净 APR = 净收益/日 ÷ 每市场参考本金 × 365 × 100%。本次每市场参考本金 {capital.denominator === null ? '无效' : `${amount.format(capital.denominator)} USD`}。</p>
      <div className="om-table oo-summary" role="region" aria-label="各市场预估净 APR" tabIndex={0}><table>
        <thead><tr><th scope="col">市场</th>{distances.map(distance => <th key={distance} scope="col" className="num">{distance} bps</th>)}</tr></thead>
        <tbody>{markets.map(market => {
          const tiers = earnings?.markets.find(item => item.market === market)?.tiers;
          const commonReason = tiers?.length && tiers.every(tier => tier.reason === tiers[0]!.reason) ? tiers[0]!.reason : null;
          return <tr key={market}><th scope="row"><button type="button" className="or-toggle" aria-pressed={market === selectedDetail} onClick={() => setDetail(market)}>{market}</button>
            {commonReason || !tiers ? <small>{commonReason ?? '缺少奖励资料'}</small> : null}</th>
            {distances.map(distance => { const tier = tiers?.find(item => item.distanceBps === distance);
              return <td key={distance} className="num"><Apr net={tier?.netDay} capital={capital.denominator} />
                {!commonReason && tier?.reason ? <small>{tier.reason}</small> : null}</td>; })}</tr>;
        })}</tbody>
      </table></div>
      {selectedDetail ? <>
        <div className="oo-results-heading"><h3>市场明细</h3><label className="or-window">查看市场<select value={selectedDetail} onChange={event => setDetail(event.target.value)}>
          {markets.map(market => <option key={market}>{market}</option>)}</select></label></div>
        <ObservationDetail rows={data.rows.filter(row => row.market === selectedDetail)} earnings={earnings} market={selectedDetail} capital={capital.denominator} />
      </> : null}
    </>}
  </section>;
}
