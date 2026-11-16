// 持仓页（#/positions，A-5）：资产账本已保存连接的全部交易所账户持仓，只读。排版、文案与状态规则照工作台
// src/TradingPositions.tsx（提交 7745181），样式见 positions.css。与工作台的差异：
// - 工作台汇总多个 Asset 项目（来源），本服务只有自己的资产账本：来源卡片只有一张，指向资产页；来源筛选去掉；
// - 读取用 use-live-resource.ts（每 5 秒，页面隐藏时暂停、失败保留上次结果并标为旧值、401 提示重新登录），
//   代替工作台的 positions-cache 与它自己的唤醒/离线处理；
// - 筛选只放在页面状态里（工作台写进地址栏查询参数，本服务的路由在 hash 里）；
// - 服务没有配置资产账本（404）时显示与资产页相同含义的空状态。
import { memo, useState } from 'react';
import { ArrowUpRight, ChevronDown, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Callout, StatePanel } from './StateViews.tsx';
import { useLiveResource } from './use-live-resource.ts';
import { ApiError } from './api.ts';
import { amount, beijingTime } from './positions-format.ts';
import type { HubPositions, Position, PositionsAccount, PositionsScope, PositionsStatus } from '../../src/asset/positions-types.ts';

export const POSITIONS_PATH = '/api/asset/positions';
export const POSITIONS_READ_TIMEOUT_MS = 15_000;
const POSITIONS_EVERY_MS = 5_000;
const staleAfterMs = 90_000;
const statusNames: Record<PositionsStatus, string> = { unconfigured: '未配置', loading: '首次读取中', live: '已同步', stale: '旧值', error: '读取失败', unsupported: '暂不支持' };
type Filters = { exchange: string; account: string };
const accountKey = (exchangeId: string, account: PositionsAccount) => JSON.stringify([exchangeId, account.id]);
const formatDate = (value: string | null) => beijingTime(value);
const oldTime = (value: string | null, now: number) => !value || !Number.isFinite(Date.parse(value)) || now - Date.parse(value) > staleAfterMs;

function Money({ value, currency, signed = false }: { value: string | null; currency: string | null; signed?: boolean }) {
  return <>{amount(value, signed)}{value !== null ? <small className="positions-unit">{currency || '币种未提供'}</small> : null}</>;
}
const PositionRow = memo(function PositionRow({ position }: { position: Position }) {
  const pnlClass = position.unrealizedPnl && /[1-9]/.test(position.unrealizedPnl) ? position.unrealizedPnl.startsWith('-') ? 'positions-negative' : 'positions-positive' : '';
  const quantityUnit = position.quantityUnit === 'contracts' ? '张' : position.quantityUnit;
  return <tr data-position-id={position.id}>
    <th scope="row"><strong>{position.symbol}</strong>{position.instrumentId !== position.symbol ? <small>{position.instrumentId}</small> : null}</th>
    <td><span className={`positions-side ${position.side}`}>{position.side === 'long' ? '做多' : '做空'}</span></td>
    <td>{amount(position.quantity)}<small className="positions-unit">{quantityUnit}</small></td>
    <td><Money value={position.entryPrice} currency={position.priceCurrency} /></td>
    <td><Money value={position.markPrice} currency={position.priceCurrency} /></td>
    <td><Money value={position.notional} currency={position.notionalCurrency} /></td>
    <td className={pnlClass}><Money value={position.unrealizedPnl} currency={position.pnlCurrency} signed /></td>
    <td><details className="positions-details"><summary>详情<ChevronDown size={13} /></summary><dl>
      <div><dt>合约</dt><dd>{position.instrumentId}</dd></div>
      <div><dt>保证金模式</dt><dd>{position.marginMode === 'cross' ? '全仓' : position.marginMode === 'isolated' ? '逐仓' : position.marginMode || '未提供'}</dd></div>
      <div><dt>杠杆</dt><dd>{amount(position.leverage)}{position.leverage !== null ? '×' : ''}</dd></div>
      {position.contractSize !== null ? <div><dt>合约乘数</dt><dd>{amount(position.contractSize)}</dd></div> : null}
      <div><dt>强平价</dt><dd><Money value={position.liquidationPrice} currency={position.priceCurrency} /></dd></div>
      <div><dt>交易所变更时间 · 北京时间</dt><dd>{position.sourceUpdatedAt ? formatDate(position.sourceUpdatedAt) : '未提供'}</dd></div>
    </dl></details></td>
  </tr>;
});
const ScopePositions = memo(function ScopePositions({ scope, stale, now, context }: { scope: PositionsScope; stale: boolean; now: number; context: string }) {
  const status = scope.status === 'live' && (stale || oldTime(scope.fetchedAt, now)) ? 'stale' : scope.status;
  const emptyText = status === 'live' ? '当前无持仓' : status === 'unconfigured' ? '在资产页配置此账户后显示仓位。' : status === 'unsupported' ? '资产账本暂不支持读取此产品范围。' : status === 'loading' ? '正在首次读取，尚未确认仓位。' : '尚无可确认的仓位数据。';
  return <section className="positions-scope" data-scope={scope.id}>
    <div className="positions-scope-heading"><div><h4>{scope.label}</h4><span className={`positions-status ${status}`}>{statusNames[status]}{status === 'error' && scope.positions.length ? ' · 旧值' : ''}</span>{scope.refreshing ? <span className="positions-muted">后台更新中</span> : null}</div><p>仓位读取：<time dateTime={scope.fetchedAt || undefined}>{formatDate(scope.fetchedAt)}</time>（北京时间）</p></div>
    {scope.error ? <p className="positions-warning"><CircleAlert size={15} />{scope.error}</p> : null}
    {scope.positions.length ? <div className="positions-table-scroll" role="region" tabIndex={0} aria-label={`${context} · ${scope.label}仓位`}><table className="positions-table"><thead><tr><th scope="col">合约</th><th scope="col">方向</th><th scope="col">数量 / 单位</th><th scope="col">开仓均价</th><th scope="col">标记价格</th><th scope="col">名义价值</th><th scope="col">未实现盈亏</th><th scope="col"><span className="visually-hidden">仓位详情</span></th></tr></thead><tbody>{scope.positions.map(position => <PositionRow key={position.id} position={position} />)}</tbody></table></div> : <p className={`positions-scope-empty ${status === 'live' ? 'confirmed' : ''}`}>{emptyText}</p>}
  </section>;
});

export function AssetPositions({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<HubPositions>(POSITIONS_PATH, { intervalMs: POSITIONS_EVERY_MS, timeoutMs: POSITIONS_READ_TIMEOUT_MS, onExpired });
  const [filters, setFilters] = useState<Filters>({ exchange: '', account: '' });
  const { data, status } = live;
  if (live.error instanceof ApiError && live.error.status === 404) return <StatePanel kind="empty" title="本服务没有配置资产账本" detail="在「设置」页「从工作台导入」启用资产账本后，这里显示各交易所账户的持仓。" />;
  const offline = status === 'offline';
  const reading = status === 'loading';
  const error = status === 'error' && live.error ? live.error.message : '';
  const changeFilter = (key: keyof Filters, value: string) => setFilters({ ...filters, [key]: value, ...(key === 'exchange' ? { account: '' } : {}) });
  const now = Date.now();
  const stale = offline || status === 'paused' || !!error || !!data && oldTime(data.generatedAt, now);
  const exchanges = data?.exchanges ?? [];
  const exchangeOptions = exchanges.map(exchange => [exchange.id, exchange.name] as const);
  const groups = exchanges.filter(exchange => !filters.exchange || exchange.id === filters.exchange);
  const accountOptions = groups.flatMap(exchange => exchange.accounts.map(account => ({ id: accountKey(exchange.id, account), label: `${exchange.name} · ${account.name}` })));
  const visibleGroups = groups.map(exchange => ({ exchange, accounts: exchange.accounts.filter(account => !filters.account || accountKey(exchange.id, account) === filters.account) })).filter(group => group.accounts.length);
  const invalidFilter = !!filters.exchange && !exchangeOptions.some(([id]) => id === filters.exchange) || !!filters.account && !accountOptions.some(account => account.id === filters.account);
  const issues = exchanges.some(exchange => exchange.accounts.some(account => account.scopes.some(scope => scope.status !== 'live' || oldTime(scope.fetchedAt, now))));
  return <div className="positions-page">
    <div className="trading-toolbar"><p className="positions-readonly"><ShieldCheck size={15} /><span>资产账本中全部交易所账户的持仓 · 只读查看，账户在资产页管理</span></p><button type="button" className="button secondary" onClick={() => void live.refresh()} disabled={reading || offline}>{reading ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}刷新仓位</button></div>
    {offline ? <Callout tone="warning" role="status">网络已断开，当前显示最后读取的旧值；连接恢复后自动更新。</Callout> : null}
    {error ? <Callout tone="warning">{error}{data ? ' 当前保留上次数据，已标记为旧值。' : ''}</Callout> : null}
    {data && reading ? <Callout tone="info">已显示上次读取的仓位，正在后台更新。</Callout> : null}
    {data ? <>
      <div className={`positions-overview ${stale || issues ? 'attention' : ''}`} role="status"><span>{stale ? '当前显示旧值' : issues ? '部分账户待核对' : '仓位状态已更新'}</span><small>服务读取：{formatDate(data.generatedAt)}（北京时间）· 每 5 秒检查更新</small></div>
      <div className="positions-sources" aria-label="资产账本数据来源"><section className="positions-source"><div><strong>本服务资产账本</strong><span className={`positions-status ${stale ? 'stale' : 'live'}`}>{stale ? '来源旧值' : '来源已连接'}</span></div><p>来源读取：{formatDate(data.generatedAt)}（北京时间）</p><a className="positions-project-link" href="#/asset" aria-label="在资产页管理账户">在资产页管理账户<ArrowUpRight size={15} /></a></section></div>
      <div className="positions-filters" role="group" aria-label="仓位筛选">
        <label>交易所<select value={filters.exchange} onChange={event => changeFilter('exchange', event.target.value)}><option value="">全部交易所</option>{filters.exchange && !exchangeOptions.some(([id]) => id === filters.exchange) ? <option value={filters.exchange}>交易所已变更</option> : null}{exchangeOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>账户<select value={filters.account} onChange={event => changeFilter('account', event.target.value)}><option value="">全部账户</option>{filters.account && !accountOptions.some(account => account.id === filters.account) ? <option value={filters.account}>账户已变更</option> : null}{accountOptions.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}</select></label>
        {filters.exchange || filters.account ? <button type="button" className="button secondary" onClick={() => setFilters({ exchange: '', account: '' })}>清除筛选</button> : null}
      </div>
      {invalidFilter ? <Callout tone="warning" role="status">所选交易所或账户已变更，请清除筛选后重新选择。</Callout> : null}
      {visibleGroups.map(({ exchange, accounts }) => <section className="positions-exchange" key={exchange.id} aria-label={exchange.name}><div className="positions-exchange-heading"><h2>{exchange.name}</h2><span>本服务资产账本</span></div>{accounts.map(account => <section className="positions-account" key={account.id}><div className="positions-account-heading"><h3>{account.name}</h3>{!account.configured ? <span className="positions-status unconfigured">未配置账户</span> : null}</div>{account.scopes.length ? account.scopes.map(scope => <ScopePositions key={scope.id} scope={scope} stale={stale} now={now} context={`${exchange.name} · ${account.name}`} />) : <p className="positions-scope-empty">{account.configured ? '资产账本尚未提供此账户的产品范围。' : '在资产页配置此账户后显示仓位。'}</p>}</section>)}</section>)}
      {!visibleGroups.length ? <StatePanel kind="empty" title={invalidFilter ? '没有符合筛选的账户' : '暂未取得账户目录'} detail={invalidFilter ? '清除筛选后查看当前可用账户。' : '可进入资产页检查连接与账户配置。'} /> : <p className="positions-footnote">数量和金额沿用交易所单位；不同币种分别显示。仅“已同步”的产品范围可确认空仓，旧值与读取失败不代表无持仓。</p>}
    </> : error ? <StatePanel kind="error" title="读取持仓失败" detail={error} /> : <StatePanel kind="loading" title="正在读取资产账本仓位目录…" />}
  </div>;
}
