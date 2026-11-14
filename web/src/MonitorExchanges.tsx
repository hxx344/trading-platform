import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DISPLAY_EXCHANGES, EXCHANGE_CONTRACTS, EXCHANGE_NAMES, EXCHANGE_REFRESH_MS, calculateExchangeSpread, exchangeDefinition, externalQuoteStale,
  supportsExchange, validateExchangeQuote, type Exchange, type ExchangeLeg, type ExchangeQuote, type SpreadMarket,
} from '../../src/vendor/exchange-comparison.mjs';
import { date } from './MonitorChart.tsx';
import { useLiveResource } from './use-live-resource.ts';

// The multi-exchange comparison under the oil and Hynix charts, laid out as the workbench's modules/monitor/app/
// exchange-comparison.tsx (568a20d) with its hook hooks/use-exchange-quotes.ts (8470785): every exchange is read on its own every 15 s
// (12 s timeout) from the service, which reads the venue on demand. Changed: times are UTC like the rest of this page; the
// annualized figures are plain text, since the settlement history behind them comes with M-2d; Variational needs a login
// session and shows as 未接入; the four-leg hedge simulation and the hub summary hand-off are left out.
const READ_TIMEOUT_MS = 12_000;
type RowState = { quote: ExchangeQuote | null; error: string };

const signed = (value: number | null | undefined, digits = 2, suffix = '') => { if (value == null) return '—'; const rounded = Number(value.toFixed(digits)); return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${Math.abs(rounded).toFixed(digits)}${suffix}`; };
const tone = (value: number | null | undefined) => value == null || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
const price = (value: number | undefined, digits: number) => value === undefined ? '—' : value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const rate = (value: number | null) => signed(value === null ? null : value * 100, 5, '%');
const fundingPriceLabels = { oracle: '预言机价格', index: '指数价格', mark: '标记价格' } as const;
const age = (fetchedAt: string, now: number) => { const seconds = Math.max(0, Math.round((now - Date.parse(fetchedAt)) / 1000)); return !Number.isFinite(seconds) ? '' : seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`; };
const utc = (value: string) => `${date(value, true)} ${new Date(value).toISOString().slice(11, 19)} UTC`;
const settlement = (leg: ExchangeLeg) => leg.nextFundingAt ? `${utc(leg.nextFundingAt)}${leg.nextFundingEstimated ? '（推算）' : ''}` : '—';
const readable = (error: Error | null) => !error ? '' : /[一-鿿]/.test(error.message) ? error.message : '本轮更新失败，保留上次数据';

export function ExchangeComparison({ market, onExpired }: { market: SpreadMarket; onExpired: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [states, setStates] = useState<Partial<Record<Exchange, RowState>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const refreshers = useRef(new Map<Exchange, () => Promise<void>>());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const report = useCallback((exchange: Exchange, state: RowState) => setStates(previous => ({ ...previous, [exchange]: state })), []);
  const register = useCallback((exchange: Exchange, refresh: (() => Promise<void>) | null) => { if (refresh) refreshers.current.set(exchange, refresh); else refreshers.current.delete(exchange); }, []);
  const refresh = () => {
    setRefreshing(true);
    void Promise.all([...refreshers.current.values()].map(read => read())).finally(() => setRefreshing(false));
  };
  const contracts = EXCHANGE_CONTRACTS[market], oil = market === 'oil';
  const exchanges = DISPLAY_EXCHANGES[market];
  const rightHeading = oil ? 'WTI' : '正股 ÷ 10';
  return <div className="hub-exchange-comparison"><section className="exchange-comparison" aria-label={`${oil ? '原油' : '海力士'}交易所实时对比`} data-exchange-market={market}>
    <div className="exchange-heading"><div><h2>交易所实时对比</h2><p>{oil ? '布伦特 − WTI · 资金费按等桶数' : 'ADR − 正股 ÷ 10 · 10 份 ADR 对 1 股正股'}</p></div><div><span>各平台每 15 秒更新</span><button type="button" className="refresh-button" onClick={refresh} disabled={refreshing} aria-label={`刷新${oil ? '原油' : '海力士'}交易所报价`}><RefreshCw size={14} className={refreshing ? 'spinning' : ''} aria-hidden="true" />{refreshing ? '更新中' : '刷新'}</button></div></div>
    <table className="exchange-table">
      <thead><tr><th>交易所 / 报价口径</th><th>{contracts.leftLabel} / {rightHeading}</th><th>{oil ? '价差 (USDT/桶)' : '价差'}</th>{!oil && <th>ADR 溢价率</th>}<th>做空价差年化</th><th>做多价差年化</th></tr></thead>
      <tbody>{exchanges.map(exchange => supportsExchange(market, exchange)
        ? <ExchangeRow key={exchange} market={market} exchange={exchange} now={now} onExpired={onExpired} onReport={report} onRegister={register} />
        : <UnconnectedRow key={exchange} market={market} exchange={exchange} />)}</tbody>
    </table>
    <p className="exchange-caption">正值收款，负值付款；按当前费率简单年化，以两腿总名义金额为分母。{oil ? '做空：空布伦特、多 WTI；做多反向。' : '做空：空 ADR、多正股；做多反向。'}</p>
    <details className="exchange-details"><summary>资金费周期与计算口径</summary><div className="exchange-details-body">
      {exchanges.map(exchange => {
        if (!supportsExchange(market, exchange)) return <article key={exchange}><strong>{EXCHANGE_NAMES[exchange]}</strong><p>需要登录会话读取标记价格，本服务暂未接入。</p></article>;
        const { quote, error } = states[exchange] ?? { quote: null, error: '' };
        return <article key={exchange}><strong>{EXCHANGE_NAMES[exchange]}</strong>{quote ? <><p>{quote.left.symbol}：{rate(quote.left.fundingRate)} / {quote.left.fundingIntervalHours ?? '—'} 小时；{quote.right.symbol}：{rate(quote.right.fundingRate)} / {quote.right.fundingIntervalHours ?? '—'} 小时。</p>{quote.fundingFetchedAt && <p>资金费名义金额使用{fundingPriceLabels[quote.fundingPriceBasis]}。</p>}{quote.fundingFetchedAt && <p>资金费采集：{utc(quote.fundingFetchedAt)}。</p>}<p>下次结算：{contracts.leftLabel} {settlement(quote.left)}；{contracts.rightLabel} {settlement(quote.right)}。</p>{quote.fundingError && <p className="exchange-stale">{quote.fundingError}</p>}</> : <p>尚未取得有效报价。</p>}{error && <p className="exchange-stale">{error}</p>}</article>;
      })}
      <p>净年化 =（空腿名义 × 空腿费率 ÷ 空腿周期小时 − 多腿名义 × 多腿费率 ÷ 多腿周期小时）÷ 两腿总名义 × 8,760。各腿按各自周期换算；费率或周期缺失时显示“—”，不按零费率计算。Hyperliquid 与 Lighter 每小时结算，下次结算时间按下一个整点推算。</p>
      <p>{oil ? '原油价差 = 布伦特价格 − WTI 价格，按各平台报价币种每桶计。USD、USDT 与 USDC 分别标注，不假定彼此严格等值。' : 'ADR 溢价率 =（ADR 价格 ÷（正股价格 ÷ 10）− 1）× 100%。USDT 接口报价已完成币种换算，不额外换算韩元；USD 与 USDT 不假定严格等值。'}各行只计算同一交易所内的两腿。{oil ? 'Hyperliquid 接口不带行情时间，显示服务收到应答的时间。' : 'Hyperliquid 沿用当前中间价，其余平台使用标记价；Gate 未提供行情时间戳，显示采集时间。'}</p>
      <p>本区为当前费率预估，实际结算费率可能变化。上方历史图表使用 {oil ? 'Binance' : 'Hyperliquid'}。</p>
      <div className="exchange-source-links"><a href="https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding" target="_blank" rel="noreferrer">Hyperliquid 规则 ↗</a><a href="https://www.bybit.com/en/help-center/article/Funding-fee-calculation" target="_blank" rel="noreferrer">Bybit 规则 ↗</a><a href="https://www.binance.com/en/support/faq/detail/360033525031" target="_blank" rel="noreferrer">Binance 规则 ↗</a>{oil && <a href="https://docs.lighter.xyz/trading/funding" target="_blank" rel="noreferrer">Lighter 规则 ↗</a>}<a href="https://www.okx.com/docs-v5/en/#public-data-rest-api-get-funding-rate" target="_blank" rel="noreferrer">OKX 资金费接口 ↗</a><a href="https://www.bitget.com/docs/catalog/classic-contract-market/classic-contract-market" target="_blank" rel="noreferrer">Bitget 资金费接口 ↗</a>{!oil && <a href="https://www.gate.com/docs/developers/apiv4/en/futures/" target="_blank" rel="noreferrer">Gate 资金费接口 ↗</a>}</div>
    </div></details>
  </section></div>;
}

function ExchangeRow({ market, exchange, now, onExpired, onReport, onRegister }: {
  market: SpreadMarket; exchange: Exchange; now: number; onExpired: () => void;
  onReport: (exchange: Exchange, state: RowState) => void; onRegister: (exchange: Exchange, refresh: (() => Promise<void>) | null) => void;
}) {
  const parse = useCallback((raw: unknown) => validateExchangeQuote(raw, exchange, market), [exchange, market]);
  const live = useLiveResource<ExchangeQuote>(`/api/monitor/${market}/exchanges/${exchange}`, { intervalMs: EXCHANGE_REFRESH_MS, timeoutMs: READ_TIMEOUT_MS, parse, onExpired });
  const quote = live.data, error = readable(live.error);
  const { refresh } = live;
  useEffect(() => { onRegister(exchange, refresh); return () => onRegister(exchange, null); }, [exchange, refresh, onRegister]);
  useEffect(() => { onReport(exchange, { quote, error }); }, [exchange, quote, error, onReport]);
  const definition = exchangeDefinition(exchange, market), contracts = EXCHANGE_CONTRACTS[market], oil = market === 'oil';
  let metrics: ReturnType<typeof calculateExchangeSpread> | null = null;
  try { metrics = quote ? calculateExchangeSpread(quote) : null; } catch { metrics = null; }
  const stale = Boolean(quote && (error || externalQuoteStale(quote, now)));
  const status = !quote ? error ? '暂不可用' : '等待首次采集' : stale ? '保留数据 · 待更新' : quote.fundingError ? '价格已更新 · 资金费缺失' : '已更新';
  const pairLabel = `${contracts.leftLabel} / ${oil ? 'WTI' : '正股 ÷ 10'}`;
  return <tr data-exchange={exchange} data-stale={stale}>
    <td className="exchange-identity"><strong>{EXCHANGE_NAMES[exchange]}</strong><span>{quote?.currency ?? definition.currency} · {(quote?.priceBasis ?? definition.priceBasis) === 'mid' ? '中间价' : '标记价'}</span><small className={stale || !quote || quote.fundingError ? 'exchange-stale' : ''}>{status}</small>{stale && quote ? <small className="exchange-old" title="报价超过有效期，仅供核对"><b>旧</b>{age(quote.fetchedAt, now)}</small> : null}{quote && <time dateTime={quote.fetchedAt}>{quote.timestampBasis === 'received' ? '采集时间：' : ''}{utc(quote.fetchedAt)}</time>}{quote?.timestampBasis === 'received' && <small>源未提供行情时间戳</small>}{quote?.fundingError && <small className="exchange-stale">{quote.fundingError}</small>}</td>
    <td data-label={pairLabel}><span className="exchange-prices"><span>{price(quote?.left.price, oil ? 3 : 2)}</span><span className="exchange-separator" aria-hidden="true">/</span><span>{price(metrics?.equivalent, oil ? 3 : 2)}</span></span><small className="exchange-pair-symbols">{quote ? `${quote.left.symbol} / ${quote.right.symbol}` : `${definition.left} / ${definition.right}`}</small></td>
    <td data-label={oil ? '价差 (USDT/桶)' : '价差'}><strong className={tone(metrics?.spread)}>{signed(metrics?.spread, oil ? 3 : 2, '')}</strong></td>
    {!oil && <td data-label="ADR 溢价率"><strong className={tone(metrics?.premium)}>{signed(metrics?.premium, 2, '%')}</strong></td>}
    <td data-label="做空价差年化"><strong className={tone(metrics?.shortAnnualized)}>{signed(metrics?.shortAnnualized == null ? null : metrics.shortAnnualized * 100, 2, '%')}</strong></td>
    <td data-label="做多价差年化"><strong className={tone(metrics?.longAnnualized)}>{signed(metrics?.longAnnualized == null ? null : metrics.longAnnualized * 100, 2, '%')}</strong></td>
  </tr>;
}

/** Variational: listed like the workbench, without a read. */
function UnconnectedRow({ market, exchange }: { market: SpreadMarket; exchange: Exchange }) {
  const definition = exchangeDefinition(exchange, market), contracts = EXCHANGE_CONTRACTS[market];
  const pairLabel = `${contracts.leftLabel} / ${market === 'oil' ? 'WTI' : '正股 ÷ 10'}`;
  return <tr data-exchange={exchange} data-stale="false">
    <td className="exchange-identity"><strong>{EXCHANGE_NAMES[exchange]}</strong><span>{definition.currency} · 标记价</span><small className="exchange-stale">未接入</small><small>需要登录会话，本服务暂不读取</small></td>
    <td data-label={pairLabel}><span className="exchange-prices"><span>—</span><span className="exchange-separator" aria-hidden="true">/</span><span>—</span></span><small className="exchange-pair-symbols">{definition.left} / {definition.right}</small></td>
    <td data-label={market === 'oil' ? '价差 (USDT/桶)' : '价差'}><strong>—</strong></td>
    {market !== 'oil' && <td data-label="ADR 溢价率"><strong>—</strong></td>}
    <td data-label="做空价差年化"><strong>—</strong></td>
    <td data-label="做多价差年化"><strong>—</strong></td>
  </tr>;
}
