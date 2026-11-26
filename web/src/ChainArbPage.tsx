import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ArbResult, ChainArbInput, ChainArbView } from '../../src/chain-arb/model.ts';
import { CHAIN_ARB_MAX_IMPACT_BPS, VENUE_NAMES } from '../../src/chain-arb/model.ts';
import { isDepositExecution } from '../../src/chain-arb/scan-model.ts';
import type { ShellView } from '../../src/shell-view.ts';
import { api } from './api.ts';
import { chainArbQuery, chainNames, initialChainArbForm, readTimedChainArb, type ChainArbForm } from './chain-arb-form.ts';
import { reviewScanRow } from './chain-arb-scan-form.ts';
import { ChainArbScan, LedgerConnectionHelp } from './ChainArbScan.tsx';
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
      <h2>{spot ? '充值至 ' + venue + ' 卖出现货' : venue + ' 永续对冲后卖出现货'}</h2>
      <p>{spot ? '按充值地址的模拟实收量逐档卖入当前买盘，充值到账前价格可能变化。' : '买币时开空永续，充值到账后逐档卖出现货。假设基差收敛，以本次现货买一价平空。'}</p>
    </div></div>
    <div className="panel-body">{'error' in result
      ? <Callout tone="warning">{result.error}</Callout>
      : <>
        <dl className="facts">
          <dt>{spot ? '现货卖出均价' : '永续开空均价'}</dt><dd>{numbers.format(result.price)} USDT</dd>
          <dt>{spot ? '可卖出数量' : '对冲数量'}</dt><dd>{numbers.format(result.quantity)} {input.symbol}</dd>
          <dt>{spot ? '未卖出的尾差' : '未对冲的尾差'}</dt><dd>{numbers.format(result.remainder)} {input.symbol}</dd>
          <dt>{spot ? '预计毛收益率' : '收敛情景毛收益率'}</dt><dd>{amounts.format(result.spreadBps)} bp</dd>
          <dt>{spot ? '现货毛差额' : '收敛情景毛差额'}</dt><dd>{amounts.format(result.grossUsdt)} USDT</dd>
          <dt>{spot ? '预计净差额' : '收敛情景净差额'}</dt>
          <dd><strong>{result.netUsdt === null ? gasMissing ? '缺少链上 Gas 估算' : '待补其他成本' : amounts.format(result.netUsdt) + ' USDT'}</strong></dd>
          {result.netBps != null ? <><dt>预计净收益率</dt><dd>{amounts.format(result.netBps)} bp</dd></> : null}
          <dt>盘口时间</dt><dd>{clock(result.at)}</dd>
        </dl>
        <p className="muted">{spot
          ? '按整笔买入预算计成本，尾差按零计。净差额再扣除一次现货卖出手续费和本路线成本。'
          : '按整笔买入预算计成本，尾差按零计。净差额再扣除一次现货卖出费、永续开仓和平仓费及本路线成本，资金费另计。'}</p>
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
  const execution = data.dex.execution;
  if (!execution) return <StatePanel kind="empty" title="缺少整笔链上模拟结果" detail="需要核实买入与转账实收量，才能测算两条路线的收益。" />;
  const { input } = query;
  const autoGas = input.swapGas === 'auto';
  const gasMissing = autoGas && data.dex.swapGasUsdt == null;
  const venue = VENUE_NAMES[input.venue ?? 'gate'];
  const eligible = data.deposit === true && isDepositExecution(execution, input.venue ?? 'gate')
    && data.expiresAt <= execution.depositExpiresAt && data.manualEstimateOnly !== true;
  const received = eligible ? execution.transferQuantity : null;
  const blockedReason = data.deposit === false ? venue + ' 此网络充值暂停' : venue + ' 实际充值地址的转账实收量尚未核实';
  function checked(result: ArbResult): ArbResult {
    return eligible || 'error' in result ? result : { error: blockedReason };
  }
  return <>
    <section className="panel">
      <div className="section-head"><div><h2>{input.symbol} · KyberSwap 链上买入</h2>
        <p>{chainNames[input.chain]} · 买入预算 {numbers.format(Number(input.amount))} USDT</p></div></div>
      <div className="panel-body"><dl className="facts">
        <dt>路由预计买入</dt><dd>{numbers.format(execution.quotedQuantity)} {input.symbol}</dd>
        <dt>模拟买入实收</dt><dd>{numbers.format(execution.receivedQuantity)} {input.symbol}</dd>
        <dt>按实收的买入均价</dt><dd>{numbers.format(data.dex.price)} USDT</dd>
        <dt>整笔价格冲击</dt><dd>{numbers.format(execution.impactBps / 100)}%（上限 {CHAIN_ARB_MAX_IMPACT_BPS / 100}%）</dd>
        <dt>{venue} 充值地址模拟实收</dt><dd>{received === null ? '未核实' : numbers.format(received) + ' ' + input.symbol}</dd>
        <dt>转账扣量</dt><dd>{received === null ? '未核实' : numbers.format(execution.receivedQuantity - received) + ' ' + input.symbol}</dd>
        {autoGas ? <><dt>预计链上 Gas</dt><dd>{!eligible || data.dex.swapGasUsdt == null ? '未取得' : numbers.format(data.dex.swapGasUsdt) + ' USDT'}</dd></> : null}
        <dt>{venue} 网络状态</dt><dd>充值 {gates(data.deposit)} · 提现 {gates(data.withdraw)}</dd>
        <dt>模拟区块</dt><dd>{execution.blockNumber}</dd>
        <dt>链上报价时间</dt><dd>{clock(data.dex.at)} · 报价有效至 {clock(data.expiresAt)}</dd>
      </dl><p className="muted">价格冲击按同一区块内，整笔买入相对 1% 预算买入时每 USDT 实收量的降幅计算。充值地址模拟实收取该地址转账前后的代币余额差。实际入账以交易所确认为准。</p></div>
    </section>
    <div className="chain-arb-routes">
      <RouteCard kind="spot" result={checked(data.spot)} input={input} gasMissing={gasMissing} />
      <RouteCard kind="perp" result={checked(data.perp)} input={input} gasMissing={gasMissing} />
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
      <div className="section-head"><div><h2>单币测算</h2><p>按整笔预算模拟链上买入和转账，再按交易所盘口估算现货卖出和永续对冲收益。</p></div></div>
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
          <label>链上 Gas<select data-slot="select-trigger" name="swapGas" value={autoGas ? 'auto' : 'manual'}
            onChange={event => {
              setAutoGas(event.target.value === 'auto');
              setQuery(null); setError('');
              setForm(previous => ({ ...previous, spotCosts: '', perpCosts: '' }));
            }}>
            <option value="manual">计入手填成本</option><option value="auto">按路由报价自动扣除</option>
          </select></label>
        </div>
        <LedgerConnectionHelp venues={[form.venue ?? 'gate']} assetEnabled={assetEnabled} />
        <div className="chain-arb-routes">
          {field('spotCosts', '现货路线其他成本（USDT）', autoGas ? '已估 Gas 以外的成本' : '链上 Gas 与其他成本合计')}
          {field('perpCosts', '永续路线其他成本（USDT）', autoGas ? '已估 Gas 以外的成本' : '链上 Gas 与其他成本合计')}
        </div>
        {autoGas ? <Callout>按本次路由的 Gas 单价估算授权、买入和转账费用。其他成本只填已估 Gas 以外的开销。</Callout> : null}
        <p className="muted">费率按账户填写，1 bp = 0.01%。核实充值地址模拟实收后，其他成本留空时仅显示毛差额，填 0 表示已确认没有其他成本。</p>
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
