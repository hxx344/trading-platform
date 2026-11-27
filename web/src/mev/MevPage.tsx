// MEV 套利页（#/mev，docs/mev.md 第 5 节、docs/frontend.md《MEV 套利页》）。Base 同链 DEX 原子套利：闪电兑换借入、
// 不盈利整笔回滚。工作台没有对应页面，骨架与部件沿用 Var/Lighter 价差页（wb-heading、panel、callout、vl-*）。
// 五个页签在地址里：概览、机会、交易、池子与代币、设置。启动后是观察模式，实盘只能在这里确认后开始。
import '../varlighter/varlighter.css';
import './mev.css';
import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Play, Plus, Save, Square, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { useDialogGuard } from '../AppDialog.tsx';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import { Badge, Metric, useWrite } from '../varlighter/parts.tsx';
import type { MevSetupView, MevStateView } from '../../../src/mev/views.ts';
import { SetupPanel, WalletCard } from './MevSetup.tsx';
import {
  MEV_BASE, MEV_TABS, OUTCOME_LABELS, SETTING_FIELDS, SETTING_GROUPS, TX_STATUS_LABELS, age, bps, compactUsd, eth, explorerAddress, explorerTx, feePercent, mevHref, outcomeTone,
  settingsChanged, settingsForm, settingsRequest, shortAddress, startBlocker, startConfirmText, tokenAmount, txTone, usd, type MevTab, type SettingsForm,
} from './mev-form.ts';

const STATE_PATH = `${MEV_BASE}/state`;
type Write = ReturnType<typeof useWrite>;
type Changed = () => Promise<void>;

/** 引擎没在运行（还没启用、部署中、启动失败）时只有 setup。 */
type PageState = { setup: MevSetupView; engine: MevStateView | null };
function parseState(raw: unknown): PageState {
  const value = raw as (Partial<MevStateView> & { setup?: MevSetupView }) | null;
  if (!value || typeof value !== 'object' || !value.setup || typeof value.setup.stage !== 'string') throw new Error('应答格式不对');
  if (value.settings === undefined) return { setup: value.setup, engine: null };
  if (!value.today || !Array.isArray(value.transactions)) throw new Error('应答格式不对');
  return { setup: value.setup, engine: value as MevStateView };
}
const stamp = (at: number) => new Date(at).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const External = ({ href, children }: { href: string; children: string }) => <a className="mev-mono" href={href} target="_blank" rel="noreferrer noopener">{children}</a>;

export function MevPage({ tab, onExpired }: { tab: MevTab; onExpired: () => void }) {
  const live = useLiveResource<PageState>(STATE_PATH, { intervalMs: 3_000, timeoutMs: 10_000, parse: parseState, onExpired });
  const { data: page, error, status, receivedAt } = live, data = page?.engine ?? null;
  const write = useWrite();
  return <div className="vl-page" data-mev>
    <header className="wb-heading"><div><h1>MEV 套利</h1>
      <p>Base 链上同链 DEX 原子套利：两跳与三角环路，本金来自池子的闪电兑换，一笔交易内完成，不盈利整笔回滚。热钱包只放 gas，利润每笔直接转给 owner。</p></div>
      {data ? <Chips view={data} /> : null}</header>
    {data ? <nav className="vl-tabs" aria-label="MEV 套利页签">
      {MEV_TABS.map(item => <a key={item.id} href={mevHref(item.id)} aria-current={tab === item.id ? 'page' : undefined}>{item.label}</a>)}
    </nav> : null}
    {error && page ? <p className="vl-note err" role="status">刷新失败：{error.message}（数据停留在 {receivedAt ? new Date(receivedAt).toLocaleTimeString() : '—'}）</p> : null}
    {write.message ? <Callout tone={write.message.tone} action={{ label: '知道了', onClick: write.clear }}>{write.message.text}</Callout> : null}
    {!page
      ? status === 'error' || status === 'offline' ? <StatePanel kind="error" title="读取 MEV 套利模块失败" detail={error?.message ?? '网络离线'} /> : <StatePanel kind="loading" title="加载中…" />
      : !data ? <SetupPanel setup={page.setup} write={write} onChanged={live.refresh} />
      : tab === 'overview' ? <Overview view={data} write={write} onChanged={live.refresh} />
        : tab === 'opportunities' ? <Opportunities view={data} />
          : tab === 'transactions' ? <Transactions view={data} />
            : tab === 'pools' ? <Pools view={data} write={write} onChanged={live.refresh} />
              : <><SettingsTab view={data} write={write} onChanged={live.refresh} /><WalletCard setup={page.setup} live={data.mode === 'live'} write={write} onChanged={live.refresh} /></>}
  </div>;
}

function Chips({ view }: { view: MevStateView }) {
  const node = view.rpcError ? 'bad' : view.lagging || !view.head ? 'warn' : 'ok';
  return <div className="vl-sources" aria-label="运行状态">
    <span className={`vl-chip ${view.mode === 'live' ? 'ok' : ''}`}><i />{view.mode === 'live' ? '实盘中' : '观察模式'}</span>
    <span className={`vl-chip ${node}`} title={view.rpcError ?? undefined}><i />{view.head ? `区块 ${view.head.number} · ${view.head.ageSec} 秒前` : '节点未连接'}</span>
    <span className={`vl-chip ${view.verification.ok ? 'ok' : 'bad'}`} title={view.verification.reason ?? undefined}><i />{view.verification.ok ? '合约已核对' : '合约未通过核对'}</span>
  </div>;
}

function Overview({ view, write, onChanged }: { view: MevStateView; write: Write; onChanged: Changed }) {
  const dialog = useDialogGuard();
  const viewRef = useRef(view);
  viewRef.current = view;
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const live = view.mode === 'live', blocker = startBlocker(view), today = view.today;
  const open = view.transactions.filter(tx => ['recorded', 'sent', 'unknown', 'expired'].includes(tx.status)).length;
  const profitUsd = today.profits.reduce((sum, item) => sum + (item.usd ?? 0), 0);
  const start = async () => {
    const seen = viewRef.current;
    if (writeBusyRef.current !== null || seen.mode === 'live' || startBlocker(seen) !== null) return;
    if (!await dialog.confirm(startConfirmText(seen), { title: '确认开始实盘套利', confirmLabel: '确认开始', tone: 'danger' })) return;
    const latest = viewRef.current;
    if (!dialog.isAlive() || writeBusyRef.current !== null || latest.mode === 'live' || startBlocker(latest) !== null) return;
    const unchanged = latest.operator === seen.operator && latest.executor === seen.executor && latest.owner === seen.owner
      && (latest.fault ?? null) === (seen.fault ?? null) && (latest.haltReason ?? null) === (seen.haltReason ?? null)
      && latest.settings.dailyGasBudgetEth === seen.settings.dailyGasBudgetEth
      && latest.settings.minNetUsd === seen.settings.minNetUsd
      && latest.settings.maxConsecutiveReverts === seen.settings.maxConsecutiveReverts;
    if (!unchanged) {
      void dialog.alert('运行状态或风控参数在确认期间已发生变化，已取消开启实盘，请核对后再试', { title: '状态已变更', tone: 'warning' });
      return;
    }
    void write.run('start', () => api(`${MEV_BASE}/live/start`, { body: { confirm: seen.operator, fault: seen.fault, haltReason: seen.haltReason } }), () => { void onChanged(); return '实盘已开始'; });
  };
  const stop = () => { void write.run('stop', () => api(`${MEV_BASE}/live/stop`, { body: {} }), () => { void onChanged(); return '已停止实盘，回到观察模式；未结清的交易继续核对'; }); };
  return <>
    {view.fault ? <Callout tone="error">故障：{view.fault}</Callout> : null}
    {!live && view.haltReason && view.haltReason !== '用户停止' ? <Callout tone="warning">实盘已自动停止：{view.haltReason}</Callout> : null}
    {!view.verification.ok ? <Callout tone="warning">合约核对未通过：{view.verification.reason}。核对通过前只读取区块，不发现机会、不发送交易。</Callout> : null}
    {view.directory.error ? <Callout tone="warning">池子目录刷新失败，沿用上一份：{view.directory.error}</Callout> : null}
    <section className="panel" aria-label="运行模式">
      <div className="mev-mode">
        <strong>{live ? '实盘中' : '观察模式'}</strong>
        <span className="muted">{live ? `自 ${view.liveSince ? stamp(view.liveSince) : '—'} 起自动发送；服务重启后回到观察模式` : '只发现与模拟，不签名、不发送交易'}</span>
        <span className="grow" />
        {live
          ? <button type="button" className="button secondary" disabled={write.busy !== null} onClick={stop}>{write.busy === 'stop' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Square size={14} aria-hidden="true" />}停止实盘</button>
          : <button type="button" className="button" disabled={write.busy !== null || blocker !== null} title={blocker ?? undefined} onClick={() => void start()}>{write.busy === 'start' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}开始实盘</button>}
      </div>
      {!live && blocker ? <p className="vl-note">暂不能开始实盘：{blocker}</p> : null}
    </section>
    <section className="vl-metrics" aria-label="今日">
      <Metric label="今日利润（UTC）" value={today.profits.length ? usd(profitUsd) : '—'} tone={profitUsd > 0 ? 'up' : ''}
        foot={today.profits.length ? today.profits.map(item => tokenAmount(item.amount, item.symbol)).join(' · ') : `成功 ${today.success} 笔 · 回滚 ${today.reverted} 笔`} />
      <Metric label="今日 gas 支出" value={eth(today.gasSpentEth)} foot={`预算 ${today.budgetEth} ETH · 未结清预留 ${eth(today.reservedEth)}`} />
      <Metric label="热钱包余额" value={eth(view.wallet?.eth)} tone={view.wallet && view.wallet.eth < view.settings.minWalletEth ? 'down' : ''} foot={`下限 ${view.settings.minWalletEth} ETH · nonce ${view.wallet?.nonce ?? '—'}`} />
      <Metric label="今日可行机会" value={today.observed.count} foot={`模拟净利合计 ${usd(today.observed.netUsd)}（同一环路 30 秒记一次）`} />
      <Metric label="上链结果" value={`${view.totals.success ?? 0} 成功 / ${view.totals.reverted ?? 0} 回滚`} tone={view.consecutiveReverts ? 'warn' : ''} foot={`连续回滚 ${view.consecutiveReverts} / ${view.settings.maxConsecutiveReverts} · 未结清 ${open} 笔`} />
      <Metric label="本次启动以来" value={`${view.counters.blocks} 个区块`} foot={`过粗筛 ${view.counters.candidates} 条 · 模拟 ${view.counters.simulated} 次`} />
    </section>
    <div className="vl-columns">
      <section className="panel" aria-label="最近交易">
        <div className="panel-heading"><h2>最近交易</h2><a className="muted" href={mevHref('transactions')}>全部</a></div>
        <TxTable view={view} limit={6} />
      </section>
      <section className="panel" aria-label="链与合约">
        <div className="panel-heading"><h2>链与合约</h2><span className="muted">Base · 链号 {view.chainId}</span></div>
        <dl className="mev-facts">
          <dt>执行合约</dt><dd><External href={explorerAddress(view.executor)}>{view.executor}</External></dd>
          <dt>owner（利润收款）</dt><dd><External href={explorerAddress(view.owner)}>{view.owner}</External></dd>
          <dt>热钱包（operator）</dt><dd><External href={explorerAddress(view.operator)}>{view.operator}</External></dd>
          <dt>合约核对</dt><dd>{view.verification.ok ? '通过' : view.verification.reason}{view.verification.checkedAt ? `（${age(view.verification.checkedAt, view.checkedAt)}）` : ''}</dd>
          <dt>基础费</dt><dd>{view.head ? `${view.head.baseFeeGwei.toFixed(4)} gwei` : '—'}</dd>
          <dt>池子目录</dt><dd>{view.directory.pools} 个池子，深度达标 {view.directory.usable}，环路 {view.directory.cycles} 条（{age(view.directory.at, view.checkedAt)}刷新）</dd>
        </dl>
      </section>
    </div>
  </>;
}

function Opportunities({ view }: { view: MevStateView }) {
  return <section className="panel" aria-label="机会">
    <div className="panel-heading"><h2>机会</h2><span className="muted">最近 {view.opportunities.length} 条 · 模拟出正利润的环路，同一环路 30 秒记一次</span></div>
    {view.opportunities.length ? <div className="vl-table"><table>
      <thead><tr><th>时间 · 区块</th><th>路径</th><th className="num">现货毛收益</th><th className="num">输入</th><th className="num">模拟利润</th><th className="num">费用</th><th className="num">净利</th><th>处理</th></tr></thead>
      <tbody>{view.opportunities.map(item => <tr key={item.id}>
        <td>{stamp(item.at)}<small>{item.block}</small></td>
        <td className="mev-path">{item.path}</td>
        <td className="num">{bps(item.edgeBps)} 基点</td>
        <td className="num">{tokenAmount(item.amountIn, item.symbol)}</td>
        <td className="num">{usd(item.profitUsd, 4)}<small>{tokenAmount(item.profit, item.symbol)}</small></td>
        <td className="num">{usd(item.costUsd, 4)}</td>
        <td className={`num ${item.netUsd > 0 ? 'vl-up' : 'vl-dim'}`}>{usd(item.netUsd, 4)}</td>
        <td className="wrap"><Badge tone={outcomeTone(item.outcome)}>{OUTCOME_LABELS[item.outcome]}</Badge>{item.reason ? <small>{item.reason}</small> : null}</td>
      </tr>)}</tbody></table></div>
      : <TableEmpty>{view.verification.ok ? '还没有模拟出正利润的环路。大多数区块没有可做的价差，属正常' : '合约核对通过后才开始发现'}</TableEmpty>}
    <p className="vl-note">费用 = L2 gas 费 + L1 数据费 + 小费；净利 = 模拟利润 − 费用。「净利不足」是没过最低净利或费用倍数，「被风控拦下」是预算、余额、未结清交易等额度不允许。观察模式下可行的机会只记录。</p>
  </section>;
}

function TxTable({ view, limit }: { view: MevStateView; limit?: number }) {
  const rows = limit ? view.transactions.slice(0, limit) : view.transactions;
  if (!rows.length) return <TableEmpty>还没有发送过交易</TableEmpty>;
  return <div className="vl-table"><table>
    <thead><tr><th>时间</th><th>交易</th><th>路径</th><th>状态</th><th className="num">利润</th><th className="num">gas 费</th></tr></thead>
    <tbody>{rows.map(tx => <tr key={tx.hash}>
      <td>{stamp(tx.createdAt)}<small>nonce {tx.nonce} · 截止区块 {tx.deadlineBlock}</small></td>
      <td><External href={explorerTx(tx.hash)}>{shortAddress(tx.hash)}</External>{tx.block ? <small>区块 {tx.block}</small> : null}</td>
      <td className="mev-path">{tx.path}</td>
      <td className="wrap"><Badge tone={txTone(tx.status)}>{TX_STATUS_LABELS[tx.status]}</Badge>{tx.error ? <small>{tx.error}</small> : null}</td>
      <td className="num">{tx.profit !== null ? <>{tokenAmount(tx.profit, tx.symbol)}<small>{usd(tx.profitUsd, 4)}</small></> : <span className="vl-dim">预期 {tokenAmount(tx.expectedProfit, tx.symbol)}</span>}</td>
      <td className="num">{eth(tx.feeEth, 8)}</td>
    </tr>)}</tbody></table></div>;
}

function Transactions({ view }: { view: MevStateView }) {
  return <section className="panel" aria-label="交易">
    <div className="panel-heading"><h2>交易</h2><span className="muted">最近 {view.transactions.length} 笔 · 结论只来自回执、热钱包 nonce 与区块号</span></div>
    <TxTable view={view} />
    <p className="vl-note">交易先入库再发送。发送结果不明或被节点拒绝的不换 nonce 重发，等链上给结论；过了截止区块仍未上链的记为过期（此后上链只会回滚）。利润的美元值按当前价格折算。</p>
  </section>;
}

function Pools({ view, write, onChanged }: { view: MevStateView; write: Write; onChanged: Changed }) {
  const dialog = useDialogGuard();
  const tokensRef = useRef(view.tokens);
  tokensRef.current = view.tokens;
  const writeBusyRef = useRef(write.busy);
  writeBusyRef.current = write.busy;
  const [address, setAddress] = useState('');
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address.trim());
  const add = () => { void write.run('token:add', () => api(`${MEV_BASE}/tokens`, { body: { action: 'add', address: address.trim() } }), () => { setAddress(''); void onChanged(); return '代币已加入白名单，池子目录在下一个区块刷新'; }); };
  const remove = async (token: MevStateView['tokens'][number]) => {
    if (writeBusyRef.current !== null || token.start) return;
    if (!await dialog.confirm(`把 ${token.symbol}（${token.address}）移出白名单？经过它的环路不再参与。`, { title: '移出代币白名单', confirmLabel: '确认移除', tone: 'danger' })) return;
    if (!dialog.isAlive() || writeBusyRef.current !== null || !tokensRef.current.some(item => item.address === token.address && !item.start)) return;
    void write.run(`token:${token.address}`, () => api(`${MEV_BASE}/tokens`, { body: { action: 'remove', address: token.address } }), () => { void onChanged(); return `${token.symbol} 已移出白名单`; });
  };
  return <>
    <section className="panel" aria-label="代币白名单">
      <div className="panel-heading"><h2>代币白名单</h2><span className="muted">{view.tokens.length} 个 · 环路从起始代币出发并回到它，只经过白名单里的代币</span></div>
      <div className="vl-table"><table>
        <thead><tr><th>代币</th><th>地址</th><th className="num">精度</th><th className="num">价格</th><th /></tr></thead>
        <tbody>{view.tokens.map(token => <tr key={token.address}>
          <td><span className="vl-symbol">{token.symbol}</span>{token.start ? <Badge tone="info">起始</Badge> : null}</td>
          <td><External href={explorerAddress(token.address)}>{token.address}</External></td>
          <td className="num">{token.decimals}</td>
          <td className="num">{usd(token.priceUsd, token.priceUsd !== null && token.priceUsd < 10 ? 4 : 2)}</td>
          <td>{token.start ? null : <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => void remove(token)}><Trash2 size={14} aria-hidden="true" />移除</button>}</td>
        </tr>)}</tbody></table></div>
      <div className="vl-toolbar">
        <input value={address} onChange={event => setAddress(event.target.value)} placeholder="0x… 代币合约地址" aria-label="代币合约地址" size={46} />
        <button type="button" className="button secondary" disabled={!valid || write.busy !== null} onClick={add}>{write.busy === 'token:add' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}加入白名单</button>
      </div>
      <p className="vl-note">只加标准 ERC-20。转账扣税、会改余额（rebase）或可冻结的代币会让模拟与上链结果不一致，白白花 gas；加入前请在区块浏览器核对合约。</p>
    </section>
    <section className="panel" aria-label="池子">
      <div className="panel-heading"><h2>池子</h2><span className="muted">{view.directory.pools} 个，深度达标 {view.directory.usable} 个 · 目录每 10 分钟刷新，状态每个区块读取</span></div>
      {view.pools.length ? <div className="vl-table"><table>
        <thead><tr><th>交易对</th><th>类型</th><th className="num">费率</th><th className="num">深度</th><th>地址</th><th>参与</th></tr></thead>
        <tbody>{view.pools.map(pool => <tr key={pool.address}>
          <td><span className="vl-symbol">{pool.token0} / {pool.token1}</span></td>
          <td>{pool.kind}</td>
          <td className="num">{feePercent(pool.feePpm)}</td>
          <td className="num">{compactUsd(pool.depthUsd)}</td>
          <td><External href={explorerAddress(pool.address)}>{shortAddress(pool.address)}</External></td>
          <td>{pool.usable ? <Badge tone="ok">参与</Badge> : <span className="vl-dim">深度不足</span>}</td>
        </tr>)}</tbody></table></div> : <TableEmpty>{view.directory.at ? '白名单代币之间没有找到池子' : '正在读取池子目录…'}</TableEmpty>}
      <p className="vl-note">深度是两侧虚拟储备按美元价的合计（集中流动性池取当前价位的流动性），只用于粗筛；实际能做多大由模拟决定。Aerodrome v2 只取波动池。</p>
    </section>
  </>;
}

function SettingsTab({ view, write, onChanged }: { view: MevStateView; write: Write; onChanged: Changed }) {
  const [form, setForm] = useState<SettingsForm>(() => settingsForm(view.settings));
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = JSON.stringify(view.settings);
  const synced = useRef(saved);
  // 没在编辑且服务端值变化时再跟随（保存后刷新还在途时不拿旧服务端值盖回刚提交的新值）。
  useEffect(() => {
    if (!touched && synced.current !== saved) {
      synced.current = saved;
      setForm(settingsForm(JSON.parse(saved)));
    }
  }, [saved, touched]);
  const dirty = settingsChanged(form, view.settings);
  const save = () => {
    const request = settingsRequest(form);
    if (!request.ok) { setProblem(request.message); return; }
    setProblem(null);
    void write.run('settings', () => api(`${MEV_BASE}/settings`, { body: request.body }), () => {
      setForm(settingsForm(request.body.settings));
      setTouched(false);
      void onChanged();
      return '风控参数已保存，下一个区块起生效';
    });
  };
  return <section className="panel" aria-label="风控参数">
    <div className="panel-heading"><h2>风控参数</h2><span className="muted">保存整份，下一个区块起生效；实盘中也可以改</span></div>
    {SETTING_GROUPS.map(group => <div key={group.id}>
      <div className="mev-group">{group.label}</div>
      <div className="vl-fields">{SETTING_FIELDS.filter(field => field.group === group.id).map(field => <label className="vl-field" key={field.key}>
        {field.label}（{field.unit}）
        <input inputMode="decimal" value={form[field.key]} onChange={event => { setTouched(true); setForm(current => ({ ...current, [field.key]: event.target.value })); }} />
        <small>{field.hint}</small>
      </label>)}</div>
    </div>)}
    <div className="vl-actions">
      {problem ? <Callout tone="error">{problem}</Callout> : null}
      <button type="button" className="button" disabled={!dirty || write.busy !== null} onClick={save}>{write.busy === 'settings' ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}保存参数</button>
      <button type="button" className="button secondary" disabled={!dirty || write.busy !== null} onClick={() => { synced.current = saved; setTouched(false); setProblem(null); setForm(settingsForm(view.settings)); }}>撤销修改</button>
    </div>
  </section>;
}
