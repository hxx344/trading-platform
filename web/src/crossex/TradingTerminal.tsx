// Terminal layout follows your-quantguy/gate-crossex, commit 423356d89e5c8f41d9d9033f4db1f40299774ec0.
import { memo, useEffect, useMemo, useState } from 'react';
import Decimal from './decimal.mjs';
import { CandlestickChart, Search } from 'lucide-react';
import type { Instrument, LiveView, MarketData, PreviewInput } from './live-types.ts';
import { useMarket } from './live-market.ts';
import { exact, formatDecimal, amountClass, positiveQuantity, signedAmount, liveStatus } from './live-display.ts';
import DecimalValue from './DecimalValue.tsx';
import { decimalField, percentage, instrumentFees } from './position-view.ts';
import { time, venue } from './display.ts';
import OpenCapacityPanel from './OpenCapacityPanel.tsx';
import type { CapacityContext } from './use-open-capacity.ts';
import type { OpenCapacityInput } from './open-capacity.ts';
import { FillBar } from './FillBar.tsx';
import { INTERVALS } from '../../../src/vendor/crossex/terminal-intervals.ts';
import { visibleTerminalCandles } from './terminal-candles.ts';

const D = Decimal.clone({ precision: 100 });
const SELECTION_KEY = 'crossex-terminal-selection-v1';
function initialSelection(): { symbol: string; interval: string } {
  try {
    const value = JSON.parse(sessionStorage.getItem(SELECTION_KEY) ?? 'null');
    if (typeof value?.symbol === 'string' && typeof value.interval === 'string' && Object.hasOwn(INTERVALS, value.interval)) return value;
  } catch { /* Storage is optional. */ }
  return { symbol: '', interval: '5m' };
}
export function MarketSelector({ instruments, value, onChange, label = '交易合约' }: { instruments: Instrument[]; value: string; onChange: (symbol: string) => void; label?: string }) {
  const [query, setQuery] = useState(''), [exchange, setExchange] = useState('');
  const choices = useMemo(() => instruments.filter(i => (!exchange || i.exchange === exchange) && `${i.base} ${i.symbol}`.toUpperCase().includes(query.trim().toUpperCase())), [instruments, exchange, query]);
  const exchanges = useMemo(() => Array.from(new Set(instruments.map(i => i.exchange))), [instruments]);
  const current = instruments.find(i => i.symbol === value), shown = choices.slice(0, 160);
  return <div className="market-selector"><div className="market-select-filters"><label className="search-field"><Search size={13}/><input aria-label={`${label}搜索`} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索合约"/></label><select aria-label={`${label}交易所筛选`} value={exchange} onChange={e => setExchange(e.target.value)}><option value="">全部交易所</option>{exchanges.map(id => <option key={id} value={id}>{venue(id)}</option>)}</select></div><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}><option value="">选择合约</option>{current && !shown.some(i => i.symbol === value) && <option value={value}>{venue(current.exchange)} · {current.base}/{current.quoteCurrency}</option>}{shown.map(i => <option value={i.symbol} key={i.symbol}>{venue(i.exchange)} · {i.base}/{i.quoteCurrency} · {i.symbol}</option>)}</select>{choices.length > 160 && <small className="muted">显示前 160 项，可搜索缩小范围</small>}</div>;
}

export default function TradingTerminal({ instruments, catalogError, live, budget, active, background, disabled, preview, capacityContext }: { instruments: Instrument[]; catalogError: string; live: LiveView; budget: number; active: boolean; background: boolean; disabled: boolean; preview: (input: PreviewInput) => Promise<boolean>; capacityContext: CapacityContext }) {
  const [initial] = useState(initialSelection), [symbol, setSymbol] = useState(initial.symbol), [interval, setInterval] = useState(initial.interval);
  const instrument = instruments.find(i => i.symbol === symbol);
  useEffect(() => {
    if (!symbol && instruments.length) setSymbol((instruments.find(i => i.base === 'BTC' && i.exchange === 'gate') || instruments.find(i => i.base === 'BTC') || instruments[0]).symbol);
    if (instrument) try { sessionStorage.setItem(SELECTION_KEY, JSON.stringify({ symbol, interval })); } catch { /* Optional preference. */ }
  }, [instruments, instrument, symbol, interval]);
  const { data, chart, marketIdentity, error } = useMarket(instrument, interval, active, background, 'blocks');
  const current = Math.floor(capacityContext.now / INTERVALS[interval]) * INTERVALS[interval];
  const candles = useMemo(() => visibleTerminalCandles(chart, interval, current, active && !background), [chart, interval, current, active, background]);
  return <div className="terminal-view"><section className="market-heading panel"><MarketSelector instruments={instruments} value={symbol} onChange={setSymbol}/><div className="market-current"><span>{instrument ? `${instrument.base} / ${instrument.quoteCurrency}` : '选择交易合约'}</span><strong><DecimalValue value={data?.ticker?.lastPrice} kind="price"/></strong><small>{instrument ? venue(instrument.exchange) + ' 永续' : 'CrossEx 合约目录'}</small></div><div className="market-stat"><span>标记价格</span><strong><DecimalValue value={data?.ticker?.markPrice} kind="price"/></strong><small>{instrument?.quoteCurrency || '—'}</small></div><div className="market-stat"><span>24h 涨跌</span><strong className={amountClass(data?.ticker?.change24h)}>{percentage(data?.ticker?.change24h)}</strong><small>交易所返回值</small></div><div className="market-stat"><span>资金费率</span><strong>{percentage(data?.ticker?.fundingRate)}</strong><small>下次 {time(data?.ticker?.nextFundingAt)}</small></div><div className="market-stat market-freshness"><span className={data?.status === 'live' ? 'positive' : 'warning'}>{liveStatus(data?.status || 'connecting')}</span><small>{time(data?.asOf)}</small></div></section>
    {(catalogError || error || data?.error) && <p className="inline-state warning">{catalogError || error || data?.error}</p>}
    <div className="terminal-grid"><section className="panel chart-panel"><div className="panel-tabs"><span className="active tab-label"><CandlestickChart size={15}/>价格图表</span><span className="panel-unit">{chart?.quote || instrument?.quoteCurrency || '原计价币'}</span></div><div className="chart-toolbar">{['1m', '5m', '15m', '1h', '4h', '1d'].map(value => <button key={value} className={interval === value ? 'active' : ''} onClick={() => setInterval(value)}>{value}</button>)}<span>真实交易所 K 线</span></div><CandleChart candles={candles} base={chart?.base || instrument?.base || ''} quote={chart?.quote || instrument?.quoteCurrency || ''} error={chart?.error} asOf={chart?.asOf} interval={interval}/></section>
      <OrderTicket key={marketIdentity} instrument={instrument} data={data} live={live} budget={budget} disabled={disabled} preview={preview} capacityContext={capacityContext}/>
    </div><section className="panel recent-prints"><div className="section-heading"><h2>最新市场成交</h2><span className="muted">{instrument ? venue(instrument.exchange) : '—'} · {symbol || '未选择合约'}</span></div>{data?.trades.length ? <div className="prints-grid">{data.trades.slice(0, 15).map((trade, index) => <div key={trade.id || index}><span className={trade.side.toUpperCase() === 'BUY' ? 'positive' : 'negative'}><DecimalValue value={trade.price} kind="price"/> <small>{instrument?.quoteCurrency}</small></span><span><DecimalValue value={trade.quantity}/> <small>{trade.quantityUnit === 'contracts' ? '张' : instrument?.base}</small></span><small>{time(trade.at)}</small></div>)}</div> : <p className="empty compact">等待真实市场成交；连接后产生的成交将在这里显示。</p>}</section>
  </div>;
}

function OrderTicket({ instrument: i, data, live, budget, disabled, preview, capacityContext }: { instrument?: Instrument; data: MarketData | null; live: LiveView; budget: number; disabled: boolean; preview: (input: PreviewInput) => Promise<boolean>; capacityContext: CapacityContext }) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY'), [orderType, setOrderType] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [quantity, setQuantity] = useState(''), [price, setPrice] = useState(''), [timeInForce, setTimeInForce] = useState<'GTC' | 'IOC' | 'FOK' | 'POC'>('GTC');
  const referencePrice = orderType === 'LIMIT' ? price : side === 'BUY' ? data?.ticker?.askPrice : data?.ticker?.bidPrice;
  const notional = positiveQuantity(quantity) && referencePrice && positiveQuantity(referencePrice) ? new D(quantity).mul(referencePrice).toFixed() : null;
  const ready = !!i && positiveQuantity(quantity) && (orderType === 'MARKET' || positiveQuantity(price));
  const current = capacityContext.active && !capacityContext.background && data?.status === 'live', tradable = data?.tradingAvailable !== false && data?.candleIdentity !== null;
  const bookAt = data?.book?.at;
  const freshBook = typeof bookAt === 'number' && bookAt <= capacityContext.now + 1000 && capacityContext.now - bookAt <= 10_000;
  const canPick = current && tradable && freshBook;
  const pickPrice = useMemo(() => canPick ? (value: string) => { setPrice(value); setOrderType('LIMIT'); } : undefined, [canPick]);
  const fee = instrumentFees(live.fees, i?.symbol);
  const capacityInput: OpenCapacityInput | null = i && (!quantity || positiveQuantity(quantity)) && (orderType === 'MARKET' || !price || positiveQuantity(price))
    ? { order: { symbol: i.symbol, side, orderType, timeInForce: orderType === 'MARKET' ? 'IOC' : timeInForce,
      ...(quantity ? { quantity } : {}), ...(orderType === 'LIMIT' && price ? { price } : {}) } } : null;
  return <><OrderBook data={data} base={i?.base || ''} quote={i?.quoteCurrency || ''}
    pick={pickPrice}/>
    <section className="panel order-ticket"><div className="ticket-heading"><h2>手动委托</h2><span className="tag live-tag">实盘</span></div><form onSubmit={e => { e.preventDefault(); if (ready && !disabled && current && tradable) void preview({ kind: 'open', order: { symbol: i!.symbol, ...(data?.candleIdentity ? { expectedMarketIdentity: data.candleIdentity } : {}), side, quantity, orderType, ...(orderType === 'LIMIT' ? { price } : {}), timeInForce: orderType === 'MARKET' ? 'IOC' : timeInForce } }); }}>
    <div className="side-toggle"><button type="button" className={side === 'BUY' ? 'active buy' : ''} onClick={() => setSide('BUY')}>买入 / 做多</button><button type="button" className={side === 'SELL' ? 'active sell' : ''} onClick={() => setSide('SELL')}>卖出 / 做空</button></div>
    <div className="ticket-types">{(['LIMIT', 'MARKET'] as const).map(value => <button type="button" className={orderType === value ? 'active' : ''} key={value} onClick={() => setOrderType(value)}>{value === 'LIMIT' ? '限价' : '市价'}</button>)}</div>
    {orderType === 'LIMIT' && <label>委托价格<div className="input-unit"><input inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} placeholder="输入价格或点击盘口" required/><span>{i?.quoteCurrency || '—'}</span></div></label>}
    <label>委托数量<div className="input-unit"><input inputMode="decimal" value={quantity} onChange={e => setQuantity(e.target.value)} placeholder={i ? '最小 ' + exact(i.min_size) : '输入基础币数量'} required/><span>{i?.base || '—'}</span></div></label>
    {orderType === 'LIMIT' && <label>有效方式<select value={timeInForce} onChange={e => setTimeInForce(e.target.value as typeof timeInForce)}><option value="GTC">GTC · 持续有效</option><option value="IOC">IOC · 即时成交剩余撤销</option><option value="FOK">FOK · 全部成交否则撤销</option><option value="POC">POC · 只做 Maker</option></select></label>}
    <OpenCapacityPanel input={capacityInput} context={capacityContext} base={i?.base || ''}/>
    <dl className="ticket-details"><div><dt>参考名义额</dt><dd><DecimalValue value={notional} kind="amount"/> <small>{i?.quoteCurrency}</small></dd></div><div><dt>单腿名义额上限</dt><dd><DecimalValue value={String(budget)} kind="amount"/> USDT</dd></div>{live.account?.account_mode === 'CROSS_EXCHANGE' && <div><dt>共享可用保证金 (USDT)</dt><dd><DecimalValue value={decimalField(live.account, 'available_margin')} kind="amount"/></dd></div>}<div><dt>数量步长</dt><dd><DecimalValue value={i?.lot_size} full/> {i?.base}</dd></div><div><dt>价格步长</dt><dd><DecimalValue value={i?.tick_size} kind="price" full/> {i?.quoteCurrency}</dd></div><div><dt>最小名义额</dt><dd><DecimalValue value={i?.min_notional} kind="amount" full/> {i?.quoteCurrency}</dd></div><div><dt>手续费 Maker / Taker</dt><dd>{percentage(fee.maker)} / {percentage(fee.taker)}</dd></div></dl>
    <button type="submit" className={'submit-order ' + (side === 'BUY' ? 'buy' : 'sell')} disabled={disabled || !ready || !current || !tradable}>{disabled ? '当前不可开仓' : !tradable ? '合约暂不可交易' : !current ? '等待有效行情' : '预览' + (side === 'BUY' ? '买入' : '卖出') + '委托'}</button>{data?.tradingReason && <p className="inline-state warning">{data.tradingReason}</p>}<p className="ticket-note">上限约束名义额，不是保证金。参考金额未计入保护价格、盘口深度与汇率影响，以预览中的 USDT 校验金额为准。</p>
  </form></section></>;
}

export const OrderBook = memo(function OrderBook({ data, base, quote, pick }: { data: MarketData | null; base: string; quote: string; pick?: (price: string) => void }) {
  const unit = data?.book?.quantityUnit === 'contracts' ? '张' : base || '—';
  const { bids, asks, maximum } = useMemo(() => {
    const build = (side: 'bids' | 'asks') => {
      let total = new D(0); return (data?.book?.[side] || []).slice(0, 9).map(([price, quantity]) => { total = total.add(quantity); return { price, quantity, total: total.toFixed() }; });
    };
    const nextBids = build('bids'), nextAsks = build('asks');
    return { bids: nextBids, asks: nextAsks, maximum: Decimal.max(nextBids.at(-1)?.total || '0', nextAsks.at(-1)?.total || '0') };
  }, [data?.book]);
  const spread = useMemo(() => data?.ticker?.askPrice && data.ticker.bidPrice ? new D(data.ticker.askPrice).sub(data.ticker.bidPrice).toFixed() : null, [data?.ticker?.askPrice, data?.ticker?.bidPrice]);
  const draw = (list: typeof bids, side: string) => list.map((row, index) => <button className={'book-row ' + side} key={`${row.price}:${index}`} disabled={!pick} onClick={() => pick?.(row.price)} title={`使用价格 ${row.price} ${quote}`}><FillBar className="book-depth" anchor="right" percent={maximum.gt(0) ? new D(row.total).div(maximum).mul(100).toNumber() : 0}/><span><DecimalValue value={row.price} kind="price"/></span><span><DecimalValue value={row.quantity}/></span><span><DecimalValue value={row.total}/></span></button>);
  return <section className="panel book-panel"><div className="panel-tabs"><span className="active tab-label">订单簿</span><span className={'panel-unit ' + (data?.status === 'live' ? 'positive' : 'warning')}>{liveStatus(data?.status || 'connecting')}</span></div><div className="book-columns"><span>价格 ({quote || '—'})</span><span>数量 ({unit})</span><span>累计 ({unit})</span></div>{asks.length || bids.length ? <><div className="book-asks">{draw(asks.slice().reverse(), 'sell')}</div><div className="book-mid"><strong><DecimalValue value={data?.ticker?.lastPrice} kind="price"/></strong><small>价差 <DecimalValue value={spread} kind="price"/> {quote}</small></div><div className="book-bids">{draw(bids, 'buy')}</div></> : <div className="empty">等待真实盘口</div>}<div className="book-time">来源时间 {time(data?.book?.at)}</div></section>;
});

const chartTimestamp = (stamp: number) => new Date(stamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

const CandleChart = memo(function CandleChart({ candles, base, quote, error, asOf, interval }: { candles: MarketData['candles']; base: string; quote: string; error?: string | null; asOf?: number | null; interval: string }) {
  const computed = useMemo(() => {
    const valid = candles.filter(c => Number.isFinite(c.time) && [c.open, c.high, c.low, c.close, c.volume].every(value => { try { return new D(value).isFinite(); } catch { return false; } })).sort((a, b) => a.time - b.time).slice(-90);
    if (!valid.length) return null;
    const low = Decimal.min(...valid.map(c => c.low)), high = Decimal.max(...valid.map(c => c.high));
    const padding = high.sub(low).gt(0) ? high.sub(low).mul('0.08') : high.abs().mul('0.01').add('0.00000001');
    const min = low.sub(padding), max = high.add(padding), range = max.sub(min), maxVolume = Decimal.max(...valid.map(c => c.volume), '1');
    const duration = INTERVALS[interval];
    const gaps = valid.filter((c, index) => index > 0 && c.time - valid[index - 1].time > duration * 1.5).length;
    const w = 820, h = 358, left = 12, right = 78, top = 12, priceBottom = 266, volumeTop = 285, bottom = 329, plotWidth = w - left - right;
    const firstTime = valid[0].time - duration / 2, span = valid.at(-1)!.time - valid[0].time + duration;
    const step = plotWidth * duration / span, xAt = (stamp: number) => left + (stamp - firstTime) / span * plotWidth;
    const y = (value: string | Decimal) => top + max.sub(value).div(range).mul(priceBottom - top).toNumber();
    const ticks = [0, 1, 2, 3, 4].map(index => { const value = max.sub(range.mul(index).div(4)); return { index, py: y(value), label: formatDecimal(value.toFixed(), 'price') }; });
    const bars = valid.map(c => {
      const x = xAt(c.time), up = new D(c.close).gte(c.open), openY = y(c.open), closeY = y(c.close);
      const height = new D(c.volume).div(maxVolume).mul(bottom - volumeTop).toNumber();
      return { time: c.time, up, x, highY: y(c.high), lowY: y(c.low), openY, closeY, height, step };
    });
    const xLabels = [0, Math.floor(valid.length / 2), valid.length - 1].map((index, sequence) => ({ sequence, x: xAt(valid[index].time), text: chartTimestamp(valid[index].time) }));
    return { valid, gaps, w, h, left, right, top, bottom, plotWidth, firstTime, span, xAt, ticks, bars, xLabels };
  }, [candles, interval]);
  const [hover, setHover] = useState<number | null>(null);
  if (!computed) return <div className="empty chart-empty"><CandlestickChart size={32}/><h3>{error ? '历史 K 线暂不可用' : '等待真实 K 线'}</h3><p>{error || '选择合约后加载交易所返回的价格与成交量。'}</p></div>;
  const { valid, gaps, w, h, left, right, top, bottom, plotWidth, firstTime, span, xAt, ticks, bars, xLabels } = computed;
  const active = valid[Math.min(hover ?? valid.length - 1, valid.length - 1)];
  return <>{error && <p className="inline-state warning">{error}</p>}{gaps > 0 && <p className="chart-gap warning">检测到 {gaps} 处历史缺口，图表保留缺失时间区间。</p>}<div className="ohlc"><span>{base} <small>{chartTimestamp(active.time)}</small></span>{[['开', active.open], ['高', active.high], ['低', active.low], ['收', active.close]].map(([label, value]) => <span key={label}>{label} <b><DecimalValue value={value} kind="price"/></b></span>)}</div><div className="candle-chart" tabIndex={0} aria-label={`${base} 真实K线，左右方向键查看各根K线`} onKeyDown={e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); setHover(index => Math.max(0, Math.min(valid.length - 1, (index ?? valid.length - 1) + (e.key === 'ArrowLeft' ? -1 : 1)))); } }}><svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${base}/${quote} 价格与成交量`} onMouseMove={e => { const bounds = e.currentTarget.getBoundingClientRect(); const stamp = firstTime + (((e.clientX - bounds.left) / bounds.width * w - left) / plotWidth) * span; setHover(valid.reduce((closest, candle, index) => Math.abs(candle.time - stamp) < Math.abs(valid[closest].time - stamp) ? index : closest, 0)); }} onMouseLeave={() => setHover(null)}>
    {ticks.map(tick => <g key={tick.index}><line x1={left} y1={tick.py} x2={w - right} y2={tick.py} className="chart-grid-line"/><text x={w - right + 8} y={tick.py + 4} className="axis-label">{tick.label}</text></g>)}
    {bars.map(bar => <g key={bar.time} className={bar.up ? 'candle-up' : 'candle-down'}><line x1={bar.x} x2={bar.x} y1={bar.highY} y2={bar.lowY}/><rect x={bar.x - Math.max(1, bar.step * .3)} y={Math.min(bar.openY, bar.closeY)} width={Math.max(2, bar.step * .6)} height={Math.max(1, Math.abs(bar.openY - bar.closeY))}/><rect className="volume-bar" x={bar.x - bar.step * .3} y={bottom - bar.height} width={Math.max(1, bar.step * .6)} height={bar.height}/></g>)}
    {xLabels.map(label => <text className="axis-label" key={label.sequence} x={label.x} y={h - 8} textAnchor={label.sequence === 0 ? 'start' : label.sequence === 2 ? 'end' : 'middle'}>{label.text}</text>)}
    {hover != null && <line x1={xAt(valid[Math.min(hover, valid.length - 1)].time)} x2={xAt(valid[Math.min(hover, valid.length - 1)].time)} y1={top} y2={bottom} className="crosshair"/>}
  </svg></div><div className="chart-caption"><span>成交量 <DecimalValue value={active.volume}/> {base}</span><span>北京时间 · {quote} · 来源 {time(asOf)}</span></div></>;
});

export const nativeSpread = (longPrice: string | null | undefined, shortPrice: string | null | undefined): string | null => {
  if (!longPrice || !shortPrice || !positiveQuantity(longPrice) || !positiveQuantity(shortPrice)) return null;
  return new D(shortPrice).sub(longPrice).div(longPrice).mul(10000).toSignificantDigits(8).toFixed();
};
export { signedAmount };
