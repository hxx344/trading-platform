import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ScanRow, ScanView } from '../../src/chain-arb/scan-model.ts';
import { api } from './api.ts';
import { chainNames } from './chain-arb-form.ts';
import { HISTORY_DISPLAY_LIMIT, readTimedScan, scanBands, scanQuery, type ScanForm, type TimedScan } from './chain-arb-scan-form.ts';
import { clock } from './labels.ts';
import { readFailure } from './live-resource.ts';
import { Callout, StatePanel, TableEmpty } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';

const signed = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 5, signDisplay: 'exceptZero' });
const price = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 7 });
const phases: Record<ScanView['phase'], string> = {
  loading: '正在加载候选币种', scanning: '正在扫描', cooldown: '上游限频，等待恢复', error: '扫描暂时失败',
};
type ScanQuery = ReturnType<typeof scanQuery>;
type Review = (form: ScanForm, row: ScanRow) => void;

function ScanTable({ rows, history, review }: { rows: ScanRow[]; history?: boolean; review: (row: ScanRow) => void }) {
  return <div className="table-wrap"><table className="data chain-arb-ranking" aria-label={history ? '最近采样' : '有效机会'}>
    <thead><tr><th>币种 / 网络</th><th>Gate 路线</th><th>扣费后价差（bp）</th><th>净差额（USDT）</th>
      <th>买入 / 卖出均价（USDT）</th><th>买入 Gas（USDT）</th><th>来源时间</th><th>操作</th></tr></thead>
    <tbody>{rows.map(row => <tr key={[row.chain, row.address, row.kind, row.at].join('/')}>
      <td><strong>{row.symbol}</strong><small>{chainNames[row.chain]}</small></td>
      <td>{row.kind === 'spot' ? '现货卖出' : '永续开空'}</td>
      <td className="num"><strong className={history ? undefined : 'ok'}>{signed.format(row.netBps)}</strong></td>
      <td className="num">{signed.format(row.netUsdt)}</td>
      <td className="num">{price.format(row.dexPrice)} / {price.format(row.gatePrice)}</td>
      <td className="num">{price.format(row.gasUsdt)}</td><td className="num">{clock(row.at)}</td>
      <td><button className="button secondary" type="button" onClick={() => review(row)}>单币复核</button></td>
    </tr>)}</tbody>
  </table></div>;
}

export function ChainArbScan({ initial, onApply, onReview, onExpired }: {
  initial: ScanForm; onApply: (form: ScanForm) => void; onReview: Review; onExpired: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [query, setQuery] = useState<ScanQuery | null>(() => scanQuery(initial));
  const [error, setError] = useState('');
  // Pausing cancels the subscription. Keep its last sample only for this query and monitor generation.
  const [pause, setPause] = useState<{ sample: TimedScan | null } | null>(null);
  const path = query?.path ?? '';
  const load = useCallback((signal: AbortSignal) => readTimedScan(() => api<ScanView>(path, { signal })), [path]);
  const read = useLiveResource(path, { intervalMs: 2_000, enabled: !!query && !pause, read: load, onExpired });
  const sample = pause ? pause.sample : read.data;
  const view = sample?.view;
  const failure = readFailure(read);
  const paused = !!pause || read.status === 'paused';
  const { live, history, nextDeadline } = scanBands(sample, paused || !!failure, performance.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(nextDeadline)) return;
    const timer = setTimeout(() => tick(n => n + 1), Math.max(0, Math.ceil(nextDeadline - performance.now())));
    return () => clearTimeout(timer);
  }, [nextDeadline]);

  function edit(name: keyof ScanForm, value: string) {
    setQuery(null);
    setPause(null);
    setError('');
    setForm(previous => ({ ...previous, [name]: value }));
  }
  function apply(event: FormEvent) {
    event.preventDefault();
    try {
      const next = scanQuery(form);
      setQuery(next); setPause(null); setError('');
      onApply(next.input);
    } catch (failure) {
      setQuery(null); setError(failure instanceof Error ? failure.message : '扫描参数无效');
    }
  }
  const numberField = (name: Exclude<keyof ScanForm, 'chain'>, label: string) => <label>{label}
    <input data-slot="input" name={name} value={form[name]} inputMode="decimal" autoComplete="off"
      onChange={event => edit(name, event.target.value)} /></label>;
  const review = (row: ScanRow) => { if (query) onReview(query.input, row); };

  return <>
    <section className="panel">
      <div className="section-head"><div><h2>扫描条件</h2><p>从 Gate 市场自动匹配链上代币，按同一预算比较现货和永续路线。</p></div></div>
      <form className="panel-body" onSubmit={apply}>
        <div className="chain-arb-scan-controls">
          <label>网络<select data-slot="select-trigger" name="chain" value={form.chain} onChange={event => edit('chain', event.target.value)}>
            <option value="all">全部网络（3 条链）</option>
            {Object.entries(chainNames).map(([chain, name]) => <option key={chain} value={chain}>{name}</option>)}
          </select></label>
          {numberField('amount', '买入预算（USDT）')}
          {query ? <button type="button" className="button secondary" onClick={() => setPause(pause ? null : { sample: read.data })}>
            {pause ? '继续扫描' : '暂停扫描'}</button> : <button type="submit" className="button primary">应用参数并扫描</button>}
        </div>
        <details className="chain-arb-fees">
          <summary>费率与额外成本</summary><div className="chain-arb-fields">
            {numberField('spotFeeBps', '现货单次费率（bp）')}{numberField('perpFeeBps', '永续单次费率（bp）')}
            {numberField('spotCosts', '现货额外成本（USDT）')}{numberField('perpCosts', '永续额外成本（USDT）')}
          </div>
        </details>
        {error ? <Callout tone="error">{error}</Callout> : null}
      </form>
    </section>
    {query ? <>
      <section className="panel">
        <div className="section-head"><div><h2>有效机会{live.length ? ' · ' + live.length : ''}</h2>
          <p>按扣费后价差从高到低排列。价差为正净差额占已覆盖买入成本的比例，1 bp = 0.01%。</p></div></div>
        <div className="panel-body">
          {failure ? <Callout tone="error">扫描读取失败 · {failure}。恢复前仅显示最近采样。</Callout>
            : paused ? <Callout>扫描已暂停，最近采样仅供复核。</Callout>
            : view ? <>
              <p className="status-line" role="status">{phases[view.phase]} · 第 {view.cycle} 轮 · 已检查 {view.checked} / {view.total} 个候选 · 失败 {view.failed} · 更新 {clock(view.asOf)}</p>
              {view.message ? <Callout tone={view.phase === 'error' || view.phase === 'cooldown' ? 'warning' : 'info'}>{view.message}</Callout> : null}
            </> : <p className="status-line" role="status">正在读取扫描进度…</p>}
          {live.length ? <ScanTable rows={live} review={review} />
            : <TableEmpty>{paused || failure || view?.phase === 'error' || view?.phase === 'cooldown' ? '当前行情待重新核实。'
              : !view || view.phase === 'loading' ? '正在准备市场目录和报价。'
              : view.total === 0 ? '当前网络没有可扫描的候选币种。' : '已检查的报价中暂无有效正净差。'}</TableEmpty>}
          <p className="muted">净差额已扣 KyberSwap 买入 Gas、所填账户费率及各路线额外成本（默认 0 USDT）。现货按到账后卖出测算；永续假设基差收敛，按开仓名义计开平两次费用，未计资金费与未对冲尾差。</p>
        </div>
      </section>
      {view ? <section className="panel">
        <div className="section-head"><div><h2>最近采样</h2><p>近 5 分钟内的历史或暂停采样，最多 {HISTORY_DISPLAY_LIMIT} 条。复核时重新请求实时价格。</p></div></div>
        {history.length ? <ScanTable rows={history} history review={review} /> : <TableEmpty>暂无历史采样。</TableEmpty>}
      </section> : null}
    </> : <StatePanel kind="empty" title="扫描参数已更改" detail="应用参数后重新扫描。" />}
  </>;
}
