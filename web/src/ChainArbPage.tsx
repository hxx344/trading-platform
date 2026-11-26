import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ArbResult, ChainArbInput, ChainArbView } from '../../src/chain-arb/model.ts';
import { VENUE_NAMES } from '../../src/chain-arb/model.ts';
import type { ShellView } from '../../src/shell-view.ts';
import { api } from './api.ts';
import { chainArbQuery, chainNames, initialChainArbForm, readTimedChainArb, type ChainArbForm } from './chain-arb-form.ts';
import { reviewScanRow } from './chain-arb-scan-form.ts';
import { ChainArbScan, OkxConnectionHelp } from './ChainArbScan.tsx';
import { clock } from './labels.ts';
import { readFailure, type ResourceSnapshot } from './live-resource.ts';
import { Callout, StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';

const numbers = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 8 });
const amounts = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6, signDisplay: 'exceptZero' });
const gates = (enabled: boolean | null) => enabled === null ? '未核实' : enabled ? '开放' : '暂停';
type Query = ReturnType<typeof chainArbQuery>;

function RouteCard({ kind, result, input, gasMissing }: { kind: 'spot' | 'perp'; result: ArbResult; input: ChainArbInput; gasMissing: boolean }) {
  const spot = kind === 'spot';
  const venue = VENUE_NAMES[input.venue ?? 'gate'];
  return <section className="panel">
    <div className="section-head"><div>
      <h2>{spot ? '充值至 ' + venue + ' 卖出现货' : '在 ' + venue + ' 做空永续'}</h2>
      <p>{spot ? '按当前买盘估算，充值到账时价格可能变化。' : '按该市场的数量步长开空，测算现货与永续以相同价格离场时的收益。'}</p>
    </div></div>
    <div className="panel-body">{'error' in result
      ? <Callout tone="warning">{result.error}</Callout>
      : <>
        <dl className="facts">
          <dt>{spot ? '现货卖出均价' : '永续开空均价'}</dt><dd>{numbers.format(result.price)} USDT</dd>
          <dt>{spot ? '可卖出数量' : '对冲数量'}</dt><dd>{numbers.format(result.quantity)} {input.symbol}</dd>
          <dt>{spot ? '未卖出的尾差' : '未对冲的尾差'}</dt><dd>{numbers.format(result.remainder)} {input.symbol}</dd>
          <dt>{spot ? '现货溢价' : '开仓基差'}</dt><dd>{amounts.format(result.spreadBps)} bp</dd>
          <dt>{spot ? '现货毛差额' : '收敛情景毛差额'}</dt><dd>{amounts.format(result.grossUsdt)} USDT</dd>
          <dt>{spot ? '预计净差额' : '收敛情景净差额'}</dt>
          <dd><strong>{result.netUsdt === null ? gasMissing ? '缺少买入 Gas 估算' : '待补其他成本' : amounts.format(result.netUsdt) + ' USDT'}</strong></dd>
          {result.netBps != null ? <><dt>扣费后价差</dt><dd>{amounts.format(result.netBps)} bp</dd></> : null}
          <dt>盘口时间</dt><dd>{clock(result.at)}</dd>
        </dl>
        <p className="muted">{spot
          ? '净差额扣除一次现货卖出手续费及现货路线其他成本。按可卖出的数量分摊买入成本，尾差另列。转账前需核对账户最低充值额和代币转账税。'
          : '收敛情景按开仓均价计两次永续手续费，再扣除永续路线其他成本。估算未计资金费与未对冲尾差，实际收益取决于平仓价差。'}</p>
      </>}
    </div>
  </section>;
}

function Quote({ query, onExpired }: { query: Query; onExpired: () => void }) {
  const { path } = query;
  const load = useCallback((signal: AbortSignal) => readTimedChainArb(() =>
    api<ChainArbView>(path, { signal, timeoutMs: 15_000 })), [path]);
  const read = useLiveResource(path, { intervalMs: 10_000, read: load, onExpired });
  const data = read.data?.view;
  const deadline = read.data?.deadline ?? 0;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!deadline) return;
    const timer = setTimeout(() => tick(value => value + 1), Math.max(0, Math.ceil(deadline - performance.now())));
    return () => clearTimeout(timer);
  }, [deadline]);
  const failure = readFailure(read);
  if (failure) return <StatePanel kind="error" title="读取报价失败" detail={failure} />;
  if (read.status === 'paused') return <StatePanel kind="empty" title="报价刷新已暂停" />;
  if (!data) return <StatePanel kind="loading" title="正在读取链上报价和交易所盘口…" />;
  if (!(performance.now() < deadline)) return <StatePanel kind="empty" title="本次报价已过期" detail="正在等待新的链上报价和交易所盘口。" />;
  const { input } = query;
  const autoGas = input.swapGas === 'auto';
  const gasMissing = autoGas && data.dex.swapGasUsdt == null;
  return <>
    <section className="panel">
      <div className="section-head"><div><h2>{input.symbol} · KyberSwap 链上买入</h2>
        <p>{chainNames[input.chain]} · 买入预算 {numbers.format(Number(input.amount))} USDT</p></div></div>
      <div className="panel-body"><dl className="facts">
        <dt>预计买入数量</dt><dd>{numbers.format(data.dex.quantity)} {input.symbol}</dd>
        <dt>买入均价</dt><dd>{numbers.format(data.dex.price)} USDT</dd>
        {autoGas ? <><dt>路由估算买入 Gas</dt><dd>{data.dex.swapGasUsdt == null ? '未取得' : numbers.format(data.dex.swapGasUsdt) + ' USDT'}</dd></> : null}
        <dt>{VENUE_NAMES[input.venue ?? 'gate']} 网络状态</dt><dd>充值 {gates(data.deposit)} · 提现 {gates(data.withdraw)}</dd>
        <dt>链上报价时间</dt><dd>{clock(data.dex.at)} · 报价有效至 {clock(data.expiresAt)}</dd>
      </dl></div>
    </section>
    <div className="chain-arb-routes">
      <RouteCard kind="spot" result={data.spot} input={input} gasMissing={gasMissing} />
      <RouteCard kind="perp" result={data.perp} input={input} gasMissing={gasMissing} />
    </div>
  </>;
}

type ManualSetup = { form: ChainArbForm; autoGas: boolean };
function SingleEstimate({ initial, scopeKey, assetEnabled, onExpired }: { initial: ManualSetup; scopeKey: string; assetEnabled: boolean; onExpired: () => void }) {
  const [form, setForm] = useState(initial.form);
  const [query, setQuery] = useState<Query | null>(() => chainArbQuery(initial.form, initial.autoGas));
  const [autoGas, setAutoGas] = useState(initial.autoGas);
  const [error, setError] = useState('');
  const [request, setRequest] = useState(0);
  function edit(name: keyof ChainArbForm, value: string) {
    setQuery(null);
    setError('');
    setForm(previous => {
      const next = { ...previous, [name]: value };
      if (name === 'chain' || name === 'address' || name === 'symbol' || name === 'venue') delete next.source;
      return next;
    });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    try { setQuery(chainArbQuery(form, autoGas)); setRequest(previous => previous + 1); setError(''); }
    catch (failure) { setQuery(null); setError(failure instanceof Error ? failure.message : '查询参数无效'); }
  }
  const field = (name: Exclude<keyof ChainArbForm, 'chain'>, label: string, placeholder?: string) =>
    <label className={name === 'address' ? 'chain-arb-address' : undefined}>{label}
      <input data-slot="input" name={name} value={form[name]} onChange={event => edit(name, event.target.value)}
        inputMode={name === 'symbol' || name === 'address' ? 'text' : 'decimal'}
        placeholder={placeholder} autoComplete="off" spellCheck={false} />
    </label>;
  return <>
    <section className="panel">
      <div className="section-head"><div><h2>单币测算</h2><p>按买入预算比较链上买入、交易所现货卖出和永续开空的价格。</p></div></div>
      <form className="panel-body" onSubmit={submit}>
        <div className="chain-arb-fields">
          <label>网络<select data-slot="select-trigger" name="chain" value={form.chain} onChange={event => edit('chain', event.target.value)}>
            {Object.entries(chainNames).map(([chain, name]) => <option key={chain} value={chain}>{name}</option>)}
          </select></label>
          <label>交易所<select name="venue" data-slot="select-trigger" value={form.venue ?? 'gate'} onChange={event => edit('venue', event.target.value)}>
            {Object.entries(VENUE_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select></label>
          {field('symbol', '交易所币种代码')}
          {field('address', '链上代币合约地址')}
          {field('amount', '买入预算（USDT）')}
          {field('spotFeeBps', '现货单次费率（bp）')}
          {field('perpFeeBps', '永续单次费率（bp）')}
          <label>买入 Gas<select data-slot="select-trigger" name="swapGas" value={autoGas ? 'auto' : 'manual'}
            onChange={event => {
              setAutoGas(event.target.value === 'auto');
              setQuery(null); setError('');
              setForm(previous => ({ ...previous, spotCosts: '', perpCosts: '' }));
            }}>
            <option value="manual">计入手填成本</option><option value="auto">按路由报价自动扣除</option>
          </select></label>
        </div>
        {form.venue === 'okx' && <OkxConnectionHelp assetEnabled={assetEnabled} />}
        <div className="chain-arb-routes">
          {field('spotCosts', '现货路线其他成本（USDT）', autoGas ? '转账等额外成本' : 'Gas、转账等合计')}
          {field('perpCosts', '永续路线其他成本（USDT）', autoGas ? '现货离场等额外成本' : 'Gas、现货离场手续费等合计')}
        </div>
        {autoGas ? <Callout>沿用扫描口径，每次查询都按当前代币的路由报价扣除买入 Gas。其他成本只填 Gas 以外的开销。</Callout> : null}
        <p className="muted">费率按账户填写，1 bp = 0.01%。其他成本按整条路线填写，留空时仅显示毛差额，填 0 表示已确认没有其他成本。</p>
        {error ? <Callout tone="error">{error}</Callout> : null}
        <div className="toolbar"><button className="button primary" type="submit">{query ? '刷新报价' : '查询报价'}</button>
          {query ? <small className="muted">每 10 秒刷新</small> : <small className="muted">提交后按当前参数查询</small>}
        </div>
      </form>
    </section>
    {query ? <Quote key={scopeKey + '/' + request} query={query} onExpired={onExpired} /> : null}
  </>;
}

export function ChainArbPage({ shell, onExpired }: { shell: ResourceSnapshot<ShellView>; onExpired: () => void }) {
  const [mode, setMode] = useState<'scan' | 'single'>('scan');
  const [manual, setManual] = useState<ManualSetup>({ form: initialChainArbForm, autoGas: false });
  const failure = readFailure(shell);
  if (failure) return <StatePanel kind="error" title="无法核对行情开关" detail={failure} />;
  if (!shell.data) return <StatePanel kind="loading" title="正在核对行情开关…" />;
  const scope = shell.data.monitor?.perpetual;
  if (!scope) return <StatePanel kind="empty" title="尚未配置合约价差监控"
    detail="在设置的「从工作台导入」中点「读取工作台」，勾选「启用行情监控」并导入。服务重启后回到这里即可设置扫描。">
    <a className="button secondary" href="#/settings">打开设置</a></StatePanel>;
  if (!scope.enabled) return <StatePanel kind="empty" title="合约价差监控已关闭"
    detail="打开行情监控的「合约价差」页签，开启「运行监控」，即可在这里查看报价和配置扫描。">
    <a className="button secondary" href="?monitor=perpetual#/monitor">打开合约价差监控</a></StatePanel>;
  const scopeKey = [shell.data.generation, scope.revision].join('/');
  return <div className="chain-arb-page">
    <div className="toolbar" role="group" aria-label="链上折价套利视图">
      <button type="button" aria-pressed={mode === 'scan'} className={'button ' + (mode === 'scan' ? 'primary' : 'secondary')}
        onClick={() => setMode('scan')}>自动扫描</button>
      <button type="button" aria-pressed={mode === 'single'} className={'button ' + (mode === 'single' ? 'primary' : 'secondary')}
        onClick={() => setMode('single')}>单币测算</button>
    </div>
    {mode === 'scan' ? <ChainArbScan key={scopeKey} assetEnabled={shell.data.modules.asset} onExpired={onExpired}
      onReview={(form, row) => { setManual(reviewScanRow(form, row)); setMode('single'); }} />
      : <SingleEstimate initial={manual} scopeKey={scopeKey} assetEnabled={shell.data.modules.asset} onExpired={onExpired} />}
  </div>;
}
