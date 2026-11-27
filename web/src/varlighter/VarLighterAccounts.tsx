// 账户资产页签（#/varlighter/accounts，docs/dexspread.md 第 14 节）：
// 展示各实盘场所的实时权益、保证金、可用余额、现货资产、当前持仓、30 天成交与资金费记录、权益走势与策略实盘对照。
// 仅限浏览器会话访问，页面与接口不返回账户编号、地址、API 密钥编号或私钥。
import { useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { api } from '../api.ts';
import { Callout, StatePanel, TableEmpty } from '../StateViews.tsx';
import { useLiveResource } from '../use-live-resource.ts';
import type { AccountsRefreshResult, AccountsView, VenueAccountView } from '../../../src/varlighter/views.ts';
import { Badge, EquityLineChart, Metric, stampText, useWrite } from './parts.tsx';
import {
  ACCOUNT_VENUE_FILTERS, VARLIGHTER_BASE, accountActivityFoot, accountHealthBadge, accountPnlTone, age, directionLabel, duration, filterAccountFunding, filterAccountPositions,
  filterAccountTrades, formatCurrencyAmount, formatRatePct, marginModeLabel, pairLabel, percent, plain, price, selectedEquitySeries, selectedVenuePnlCurve,
  signedCurrencyAmount, signedUsd, tradeDirLabel, usd, varLighterHref, venueShort, type AccountVenueFilter,
} from './varlighter-form.ts';

const ACCOUNTS_PATH = `${VARLIGHTER_BASE}/accounts`;
const ACCOUNTS_REFRESH_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
type RecordsTab = 'trades' | 'funding' | 'live';
type ChartKind = 'equity' | 'pnl';

function parseAccounts(raw: unknown): AccountsView {
  const value = raw as AccountsView | null;
  if (!value || typeof value !== 'object' || !Array.isArray(value.venues) || !value.totals || !Array.isArray(value.positions)) {
    throw new Error('账户资产应答格式不对');
  }
  return value;
}

export function VarLighterAccounts({ onExpired }: { onExpired: () => void }) {
  const live = useLiveResource<AccountsView>(ACCOUNTS_PATH, { intervalMs: ACCOUNTS_REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, parse: parseAccounts, onExpired });
  const data = live.data;
  const write = useWrite();
  const [filter, setFilter] = useState<AccountVenueFilter>('all');
  const [recordsTab, setRecordsTab] = useState<RecordsTab>('trades');
  const [chartKind, setChartKind] = useState<ChartKind>('equity');
  const refresh = live.refresh;

  // 手动触发后台刷新后每 2 秒自动拉一次，直到刷新完成。
  useEffect(() => {
    if (!data?.refreshing) return;
    const timer = setTimeout(() => { void refresh(); }, 2_000);
    return () => clearTimeout(timer);
  }, [data?.refreshing, data?.now, refresh]);

  // 切回「全部场所」时只展示组合权益曲线。
  useEffect(() => {
    if (filter === 'all' && chartKind === 'pnl') setChartKind('equity');
  }, [filter, chartKind]);

  if (!data) {
    return live.error
      ? <StatePanel kind="error" title="读取账户资产失败" detail={live.error.message} />
      : <StatePanel kind="loading" title="加载账户资产中…" />;
  }

  const triggerRefresh = () => {
    void write.run(
      'refresh',
      () => api<AccountsRefreshResult>(`${ACCOUNTS_PATH}/refresh`, { body: {} }),
      result => {
        void refresh();
        if (result.triggered) return '已触发后台刷新，稍等数秒自动更新';
        if (result.refreshing) return '后台正在拉取最新账户与历史数据…';
        return `操作过于频繁，请 ${Math.max(1, Math.ceil(result.cooldownMs / 1000))} 秒后再试`;
      },
    );
  };

  const selectedVenue = filter === 'all' ? null : data.venues.find(item => item.venue === filter) ?? null;
  const visibleVenues = selectedVenue ? [selectedVenue] : data.venues;
  const positions = filterAccountPositions(data.positions, filter);
  const trades = filterAccountTrades(data.trades, filter);
  const funding = filterAccountFunding(data.funding, filter);
  const equitySeries = selectedEquitySeries(data, filter);
  const pnlSeries = selectedVenuePnlCurve(data, filter);
  const activeChart = chartKind === 'pnl' && pnlSeries ? pnlSeries : null;
  const busy = write.busy !== null || data.refreshing;

  const summary = selectedVenue
    ? {
        currency: selectedVenue.collateralAsset,
        equity: selectedVenue.equity,
        collateral: selectedVenue.collateral,
        available: selectedVenue.available,
        marginUsed: selectedVenue.marginUsed,
        unrealized: selectedVenue.unrealizedPnl,
        positionsCount: selectedVenue.positionsCount,
        positionsNotional: positions.reduce((sum, item) => sum + item.valueUsd, 0),
        equityFoot: !selectedVenue.configured
          ? '还没有配置该场所账户'
          : selectedVenue.stale
            ? '读数已过期'
            : `更新于 ${age(selectedVenue.at, data.now)}`,
        realized: selectedVenue.summary.realizedPnlUsd,
        funding: selectedVenue.summary.fundingUsd,
      }
    : {
        currency: 'USD',
        equity: data.totals.equityUsd,
        collateral: data.totals.collateralUsd,
        available: data.totals.availableUsd,
        marginUsed: data.totals.marginUsedUsd,
        unrealized: data.totals.unrealizedPnlUsd,
        positionsCount: data.totals.positionsCount,
        positionsNotional: data.totals.positionsNotionalUsd,
        equityFoot: data.totals.configured === 0
          ? '还没有配置实盘场所账户'
          : data.totals.complete
            ? `已齐备 ${data.totals.fresh} / ${data.totals.configured} 个场所（RH 按 1 USDG = 1 USD 折算）`
            : `仅汇总已读到场所（${data.totals.fresh} / ${data.totals.configured} 个最新）`,
        realized: data.totals.realizedPnlUsd30d,
        funding: data.totals.fundingUsd30d,
      };

  const authPromptVenues = visibleVenues.filter(item => item.configured && item.authRequired);
  const tradesTruncatedVenues = visibleVenues.filter(item => item.configured && item.tradesTruncated);
  const fundingTruncatedVenues = visibleVenues.filter(item => item.configured && item.fundingTruncated);
  const anyLighterConfigured = data.venues.some(item => (item.venue === 'lighter' || item.venue === 'rh') && item.configured);

  return <>
    {live.error ? <p className="vl-note err" role="status">刷新失败：{live.error.message}（停留在 {live.receivedAt ? new Date(live.receivedAt).toLocaleTimeString() : '—'}）</p> : null}
    {data.keysProblem ? <Callout tone="error">{data.keysProblem}</Callout> : null}
    {!data.keysProblem && data.totals.configured === 0
      ? <Callout tone="info">还没有配置 DEX 实盘场所账户。前往 <a href={varLighterHref('ready')}>实盘准备</a> 按场所录入账户与 API 私钥（或在服务器执行 <code>--set-dex-keys</code> 录入只读账户）。Var 没有公开账户接口，不在此页展示。</Callout>
      : null}
    {data.signerProblem && anyLighterConfigured
      ? <Callout tone="warning">Lighter 签名器不可用：{data.signerProblem}。Lighter 主网与 RH 的成交、资金费及盈亏历史暂时不可拉取。</Callout>
      : null}

    <div className="panel">
      <div className="vl-toolbar">
        <div className="vl-seg" role="group" aria-label="筛选场所">
          {ACCOUNT_VENUE_FILTERS.map(item => (
            <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>
          ))}
        </div>
        <span className="grow" />
        <a className="button secondary" href={varLighterHref('ready')}>管理凭据</a>
        <button type="button" className="button primary" aria-busy={busy || undefined} disabled={busy || data.totals.configured === 0} onClick={triggerRefresh}>
          {busy ? <LoaderCircle size={14} className="spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          {data.refreshing ? '刷新中…' : data.cooldownMs > 0 ? `刷新账户（${Math.ceil(data.cooldownMs / 1000)}s）` : '刷新账户'}
        </button>
      </div>
      {write.message ? <div className="vl-actions vl-pause"><Callout tone={write.message.tone}>{write.message.text}</Callout></div> : null}
    </div>

    <section className="vl-metrics" aria-label="账户资产汇总">
      <Metric
        label={selectedVenue ? `${selectedVenue.name} 账户权益` : '账户总权益'}
        value={formatCurrencyAmount(summary.equity, summary.currency)}
        foot={summary.equityFoot}
      />
      <Metric
        label="可用余额"
        value={formatCurrencyAmount(summary.available, summary.currency)}
        foot={`保证金 ${formatCurrencyAmount(summary.collateral, summary.currency)} · 已用 ${formatCurrencyAmount(summary.marginUsed, summary.currency)}`}
      />
      <Metric
        label="当前未实现盈亏"
        value={signedCurrencyAmount(summary.unrealized, summary.currency)}
        tone={accountPnlTone(summary.unrealized)}
        foot={`活跃持仓 ${summary.positionsCount} 个 · 名义 ${usd(summary.positionsNotional, 0)}`}
      />
      <Metric
        label={`近 ${data.windowDays} 天资金费 / 已实现`}
        value={summary.funding !== null ? signedCurrencyAmount(summary.funding, summary.currency) : summary.realized !== null ? signedCurrencyAmount(summary.realized, summary.currency) : '—'}
        tone={accountPnlTone(summary.funding ?? summary.realized)}
        foot={accountActivityFoot(data, filter)}
      />
    </section>

    <section className="vl-acc-grid" aria-label="各场所账户详情">
      {visibleVenues.map(venue => <VenueCard key={venue.venue} venue={venue} now={data.now} />)}
    </section>

    <div className="vl-columns">
      <section className="panel" aria-label="权益与盈亏走势">
        <div className="panel-heading">
          <h2>{activeChart ? activeChart.title : selectedVenue ? `${selectedVenue.name} 账户权益走势` : '合计账户权益走势'}</h2>
          {pnlSeries ? <div className="vl-seg" role="group" aria-label="走势口径">
            <button type="button" aria-pressed={chartKind === 'equity'} onClick={() => setChartKind('equity')}>权益快照</button>
            <button type="button" aria-pressed={chartKind === 'pnl'} onClick={() => setChartKind('pnl')}>交易所盈亏</button>
          </div> : <span className="muted">近 {data.windowDays} 天快照（5 分钟采样）</span>}
        </div>
        {activeChart
          ? activeChart.error
            ? <TableEmpty>{activeChart.error}</TableEmpty>
            : activeChart.points.length >= 2
              ? <div className="vl-chart small"><EquityLineChart points={activeChart.points} label={activeChart.title} valueLabel="盈亏" formatValue={v => signedCurrencyAmount(v, activeChart.currency)} currency={activeChart.currency} zeroRef /></div>
              : <TableEmpty>至少需要 2 个盈亏数据点才可绘制曲线</TableEmpty>
          : equitySeries.points.length >= 2
            ? <div className="vl-chart small"><EquityLineChart points={equitySeries.points} label="账户权益走势" valueLabel="账户权益" formatValue={v => formatCurrencyAmount(v, equitySeries.currency)} currency={equitySeries.currency} /></div>
            : <TableEmpty>{filter === 'all' && data.totals.configured > 1 && !equitySeries.complete ? '需要所有已配置场所至少 2 次同轮快照才绘制合计权益曲线（可点上方单个场所查看）' : '至少 2 个账户快照后显示走势曲线（服务每 5 分钟记录一次）'}</TableEmpty>}
      </section>

      <section className="panel" aria-label="交易与盈亏汇总">
        <div className="panel-heading"><h2>近 {data.windowDays} 天交易与盈亏汇总</h2><span className="muted">按场所口径</span></div>
        {data.venues.some(item => item.configured) ? <div className="vl-table"><table>
          <thead><tr><th>场所</th><th className="num">成交笔数</th><th className="num">成交额</th><th className="num">手续费</th><th className="num">已实现盈亏</th><th className="num">资金费净额</th></tr></thead>
          <tbody>{visibleVenues.filter(item => item.configured).map(venue => <tr key={venue.venue}>
            <td><span className="vl-symbol">{venue.name}</span><small>{venue.collateralAsset}</small></td>
            <td className="num">{venue.historyAt === null || venue.tradesError ? '—' : venue.summary.tradeCount}</td>
            <td className="num">{venue.historyAt === null || venue.tradesError ? '—' : usd(venue.summary.volumeUsd, 0)}</td>
            <td className="num">{venue.summary.feeUsd === null ? '—' : formatCurrencyAmount(venue.summary.feeUsd, venue.collateralAsset, 2)}</td>
            <td className={`num vl-${accountPnlTone(venue.summary.realizedPnlUsd) || 'dim'}`}>{signedCurrencyAmount(venue.summary.realizedPnlUsd, venue.collateralAsset)}</td>
            <td className={`num vl-${accountPnlTone(venue.summary.fundingUsd) || 'dim'}`}>{signedCurrencyAmount(venue.summary.fundingUsd, venue.collateralAsset)}</td>
          </tr>)}</tbody>
        </table></div> : <TableEmpty>暂无已配置场所</TableEmpty>}
        <p className="vl-note">
          策略双腿实盘对照：累计 {data.totals.liveTrades} 笔，净盈亏 {signedUsd(data.totals.liveNetUsd)}，今日（UTC）{signedUsd(data.totals.liveTodayNetUsd)}，当前在持 {data.totals.liveOpenCount} 笔。
          已实现盈亏汇总来自提供逐笔已实现盈亏回报的场所（如 Entropy）；Lighter 非零手续费在实测单位前留空；资金费正数为净收到、负数为净支付。
        </p>
      </section>
    </div>

    <section className="panel" aria-label="当前交易所持仓">
      <div className="panel-heading"><h2>交易所当前持仓</h2><span className="muted">{positions.length} 个活跃持仓 · 含未实现盈亏与强平价</span></div>
      {positions.length ? <div className="vl-table"><table>
        <thead><tr><th>场所 · 标的</th><th>方向 · 模式</th><th className="num">持仓量</th><th className="num">名义市值</th><th className="num">开仓均价</th><th className="num">标记价</th><th className="num">未实现盈亏</th><th className="num">持仓已实现</th><th className="num">强平价</th></tr></thead>
        <tbody>{positions.map(pos => <tr key={`${pos.venue}:${pos.symbol}`}>
          <td><span className="vl-symbol">{pos.symbol}</span><small>{pos.venueName} · {pos.collateralAsset}</small></td>
          <td><Badge tone={pos.side === 'long' ? 'ok' : 'bad'}>{pos.side === 'long' ? '多' : '空'}</Badge>{pos.leverage ? <Badge>{pos.leverage}x</Badge> : null}<small>{marginModeLabel(pos.marginMode)}</small></td>
          <td className="num">{price(Math.abs(pos.size))}</td>
          <td className="num">{usd(pos.valueUsd)}</td>
          <td className="num">{price(pos.entryPrice)}</td>
          <td className="num">{price(pos.markPrice)}{pos.markEstimated ? <small>估算</small> : null}</td>
          <td className={`num vl-${accountPnlTone(pos.unrealizedPnl) || 'dim'}`}>
            {signedCurrencyAmount(pos.unrealizedPnl, pos.collateralAsset)}
            {pos.unrealizedPnlPct !== null ? <small>{percent(pos.unrealizedPnlPct, 2)}</small> : null}
          </td>
          <td className={`num vl-${accountPnlTone(pos.realizedPnl) || 'dim'}`}>{signedCurrencyAmount(pos.realizedPnl, pos.collateralAsset)}</td>
          <td className="num">{price(pos.liquidationPrice)}</td>
        </tr>)}</tbody>
      </table></div> : <TableEmpty>{data.totals.configured === 0 ? '配置账户后显示各交易所真实持仓' : '当前没有活跃持仓'}</TableEmpty>}
    </section>

    <section className="panel" aria-label="交易与资金费记录">
      <div className="panel-heading">
        <h2>交易与资金费记录</h2>
        <div className="vl-seg" role="group" aria-label="记录类型">
          <button type="button" aria-pressed={recordsTab === 'trades'} onClick={() => setRecordsTab('trades')}>成交记录（{trades.length}）</button>
          <button type="button" aria-pressed={recordsTab === 'funding'} onClick={() => setRecordsTab('funding')}>资金费记录（{funding.length}）</button>
          <button type="button" aria-pressed={recordsTab === 'live'} onClick={() => setRecordsTab('live')}>策略实盘成交（{data.liveTrades.length}）</button>
        </div>
      </div>

      {recordsTab !== 'live' && authPromptVenues.length ? (
        <div className="vl-actions vl-pause">
          <Callout tone="info">{authPromptVenues.map(item => item.name).join('、')} 仅配置了只读账户；在 <a href={varLighterHref('ready')}>实盘准备</a> 录入 API 凭据后可拉取成交与资金费记录。</Callout>
        </div>
      ) : null}

      {recordsTab === 'trades' ? <>
        {tradesTruncatedVenues.length ? <p className="vl-note">注意：{tradesTruncatedVenues.map(item => item.name).join('、')} 的近 {data.windowDays} 天成交已触及分页上限，仅显示最新部分及对应汇总。</p> : null}
        {trades.length ? <div className="vl-table"><table>
          <thead><tr><th>时间</th><th>场所 · 标的</th><th>方向 · 角色</th><th className="num">成交价</th><th className="num">数量</th><th className="num">成交额</th><th className="num">手续费</th><th className="num">已实现盈亏</th></tr></thead>
          <tbody>{trades.map(trade => {
            const currency = data.venues.find(item => item.venue === trade.venue)?.collateralAsset ?? 'USDC';
            return <tr key={trade.id}>
              <td>{stampText(trade.at)}</td>
              <td><span className="vl-symbol">{trade.symbol}</span><small>{venueShort(trade.venue)}</small></td>
              <td><Badge tone={trade.side === 'buy' ? 'ok' : 'bad'}>{tradeDirLabel(trade)}</Badge>{trade.role ? <Badge>{trade.role === 'taker' ? 'Taker' : 'Maker'}</Badge> : null}</td>
              <td className="num">{price(trade.price)}</td>
              <td className="num">{price(trade.qty)}</td>
              <td className="num">{usd(trade.notionalUsd)}</td>
              <td className="num">{formatCurrencyAmount(trade.feeUsd, currency, 4)}</td>
              <td className={`num vl-${accountPnlTone(trade.realizedPnlUsd) || 'dim'}`}>{signedCurrencyAmount(trade.realizedPnlUsd, currency)}</td>
            </tr>;
          })}</tbody>
        </table></div> : <TableEmpty>近 {data.windowDays} 天暂无交易所成交记录</TableEmpty>}
      </> : recordsTab === 'funding' ? <>
        {fundingTruncatedVenues.length ? <p className="vl-note">注意：{fundingTruncatedVenues.map(item => item.name).join('、')} 的资金费记录已触及分页上限，仅显示最新部分。</p> : null}
        {funding.length ? <div className="vl-table"><table>
          <thead><tr><th>时间</th><th>场所 · 标的</th><th>方向</th><th className="num">持仓量</th><th className="num">费率</th><th className="num">资金费净额</th></tr></thead>
          <tbody>{funding.map(item => {
            const currency = data.venues.find(row => row.venue === item.venue)?.collateralAsset ?? 'USDC';
            return <tr key={item.id}>
              <td>{stampText(item.at)}</td>
              <td><span className="vl-symbol">{item.symbol}</span><small>{venueShort(item.venue)}</small></td>
              <td>{item.side ? <Badge tone={item.side === 'long' ? 'ok' : 'bad'}>{item.side === 'long' ? '多' : '空'}</Badge> : <span className="vl-dim">—</span>}</td>
              <td className="num">{item.positionSize !== null ? price(Math.abs(item.positionSize)) : '—'}</td>
              <td className="num">{formatRatePct(item.rate)}</td>
              <td className={`num vl-${accountPnlTone(item.amountUsd) || 'dim'}`}>{signedCurrencyAmount(item.amountUsd, currency, 4)}</td>
            </tr>;
          })}</tbody>
        </table></div> : <TableEmpty>近 {data.windowDays} 天暂无资金费结算记录</TableEmpty>}
      </> : data.liveTrades.length ? <div className="vl-table"><table>
        <thead><tr><th>标的 · 方向</th><th>结束时间</th><th className="num">A 腿 开 / 平</th><th className="num">B 腿 开 / 平</th><th className="num">净盈亏</th><th>原因</th></tr></thead>
        <tbody>{data.liveTrades.map(trade => {
          const label = pairLabel(trade.symbol);
          const avg = (quote: number, qty: number) => qty > 0 ? quote / qty : null;
          return <tr key={trade.id}>
            <td><a className="vl-symbol" href={varLighterHref('detail', trade.symbol)}>{label.symbol}</a><small>{label.short} · {directionLabel(trade.direction, label.a, label.b)}{trade.singleLeg ? ' · 单腿' : ''}</small></td>
            <td>{trade.closedAt ? stampText(trade.closedAt) : '—'}<small>持有 {duration((trade.closedAt ?? trade.updatedAt) - trade.openedAt)}</small></td>
            <td className="num">{price(avg(trade.a.entryQuote, trade.a.qty))} / {price(avg(trade.a.exitQuote, trade.a.exitQty))}<small>{price(trade.a.qty)}</small></td>
            <td className="num">{price(avg(trade.b.entryQuote, trade.b.qty))} / {price(avg(trade.b.exitQuote, trade.b.exitQty))}<small>{price(trade.b.qty)}</small></td>
            <td className={`num vl-${accountPnlTone(trade.netUsd) || 'dim'}`}>{signedUsd(trade.netUsd)}{trade.a.estimated || trade.b.estimated ? <small>含估算价</small> : null}</td>
            <td className="wrap">{trade.closeReason ?? '—'}{trade.note ? <small>{trade.note}</small> : null}</td>
          </tr>;
        })}</tbody>
      </table></div> : <TableEmpty>还没有策略双腿实盘成交</TableEmpty>}
    </section>
  </>;
}

function VenueCard({ venue, now }: { venue: VenueAccountView; now: number }) {
  const health = accountHealthBadge(venue);
  const currency = venue.collateralAsset;
  const errors = [venue.error, venue.authRequired ? null : venue.tradesError, venue.authRequired ? null : venue.fundingError].filter((item, index, list): item is string => Boolean(item) && list.indexOf(item) === index);
  return <section className="panel vl-acc-card" aria-label={`${venue.name} 账户`}>
    <div className="panel-heading">
      <h2>{venue.name} <Badge>{currency}</Badge></h2>
      <span>
        {venue.configured ? <Badge tone={venue.hasTradingKey ? 'info' : ''}>{venue.hasTradingKey ? '已录 API 密钥' : '只读账户'}</Badge> : null}
        <Badge tone={health.tone}>{health.label}</Badge>
      </span>
    </div>
    {!venue.configured
      ? <p className="vl-note">未配置该场所账户。前往 <a href={varLighterHref('ready')}>实盘准备</a> 录入后即可读取资产与持仓。</p>
      : <>
          <dl className="vl-acc-facts">
            <div><dt>账户权益</dt><dd>{formatCurrencyAmount(venue.equity, currency)}</dd></div>
            <div><dt>保证金</dt><dd>{formatCurrencyAmount(venue.collateral, currency)}</dd></div>
            <div><dt>可用余额</dt><dd>{formatCurrencyAmount(venue.available, currency)}</dd></div>
            <div><dt>已用保证金</dt><dd>{formatCurrencyAmount(venue.marginUsed, currency)}</dd></div>
            <div><dt>未实现盈亏</dt><dd className={accountPnlTone(venue.unrealizedPnl) ? `vl-${accountPnlTone(venue.unrealizedPnl)}` : undefined}>{signedCurrencyAmount(venue.unrealizedPnl, currency)}</dd></div>
            <div><dt>活跃持仓</dt><dd>{venue.positionsCount} 个</dd></div>
            {venue.positionRealizedPnl !== null ? <div><dt>持仓已实现</dt><dd className={accountPnlTone(venue.positionRealizedPnl) ? `vl-${accountPnlTone(venue.positionRealizedPnl)}` : undefined}>{signedCurrencyAmount(venue.positionRealizedPnl, currency)}</dd></div> : null}
            <div><dt>更新</dt><dd title={venue.at ? new Date(venue.at).toLocaleString() : undefined}>余额 {age(venue.at, now)} · 历史 {age(venue.historyAt, now)}</dd></div>
          </dl>
          {venue.assets.length ? <div className="vl-table"><table>
            <thead><tr><th>现货/其他资产</th><th className="num">余额</th><th className="num">冻结</th></tr></thead>
            <tbody>{venue.assets.map(asset => <tr key={asset.symbol}>
              <td>{asset.symbol}</td>
              <td className="num">{plain(asset.balance, 4)}</td>
              <td className="num">{plain(asset.locked, 4)}</td>
            </tr>)}</tbody>
          </table></div> : null}
          {errors.length ? <p className="vl-note err">{errors.join('；')}</p> : null}
          {venue.authRequired ? <p className="vl-note">当前为只读账户编号；录入 API 私钥后可查看成交、资金费与盈亏。</p> : null}
        </>}
  </section>;
}
