import { ChevronDown, ChevronLeft, ChevronRight, RefreshCw, Search, X } from 'lucide-react';
import { Fragment, useDeferredValue, useEffect, useMemo, useState } from 'react';
// perpetual.css first: the detail components' own styles load after it, as in the workbench (they are lazy chunks there).
import './perpetual.css';
import { usePerpetualFeed } from './use-perpetual-feed.ts';
import { usePerpetualFx } from './use-perpetual-fx.ts';
import { usePerpetualMarketMetrics } from './use-perpetual-market-metrics.ts';
import { scannerCapitalMetrics } from './perpetual-capital.ts';
import { nextScannerSort, parseScannerSort, scannerSortRequirements, sortScannerRows, type ScannerSort, type ScannerSortColumn } from './perpetual-scanner-sort.ts';
import { normalizeCapitalAssumptions, parseCapitalAssumptions, type CapitalAssumptions } from '../../src/vendor/capital-metrics.mjs';
import { defaultQualityBudget } from './perpetual-fees.ts';
import { PerpetualExecution } from './PerpetualExecution.tsx';
import PerpetualExit from './PerpetualExit.tsx';
import PerpetualManualPairs from './PerpetualManualPairs.tsx';
import { classifyPerpetualQuote, createPerpetualQuoteSelector, createPerpetualRankingSelector, defaultPerpetualFilters, normalizedFunding8h, parsePerpetualPreferences, perpetualSpreadKey, quotePriceTime, type PerpetualFilters, type PerpetualSpread } from './perpetual-spreads.ts';
import type { PerpetualExchange, PerpetualPairMode, PerpetualPriceMode, PerpetualQuote, PerpetualSnapshot } from './perpetual-types.ts';
import { SCANNER_CATEGORIES, SCANNER_COLUMNS, annualizedFundingPercent, defaultScannerPreferences, parseScannerPreferences, scannerPairCategory, scannerQuoteCategory, type ScannerCategoryId, type ScannerColumnId, type ScannerPreferences } from './perpetual-scanner.ts';
import { ScannerFundingRate, ScannerLeg, ScannerMarketMetric, ScannerMenu, scannerPercent, scannerPolarity } from './perpetual-scanner-parts.tsx';

// The perpetual spread panel, laid out as the workbench's "发现机会" workspace (modules/monitor/app/perpetual-panel.tsx,
// commit c84ba27; styles copied in perpetual.css). Only what the quotes alone give is here: the three views, the exchange,
// search and category filters, the ranking with the columns computable from quotes, the quote table, paging and the sort,
// price-mode and pair-mode settings. M-5a adds the expanded pair details (the feed pauses on the frozen snapshot; tabs 成交与持有
// with the depth check, 平仓与跟踪 with the exit estimate only, 各平台报价), cross-currency ranking on spot FX, and manual pairs.
// M-5b1 adds column choice, the 24h volume and open-interest columns (read for the rows on the page), required capital and
// ROC with their settings, and header sorting over the columns the quotes alone can rank.
// Left out until later M-5 batches: settled funding history (its columns and details), range filters and the full-set sorts
// they enable (volume, open interest, history), quality (its tab and column), holding and trend estimates, the chart and
// paper workspaces, position registration, favourites and blocking, CrossEx, health, alerts, fee settings and push toggles.
const scannerPreferencesKey = 'market-monitor:perpetual-scanner:v1';
const preferencesKey = 'market-monitor:perpetual:v1';
const scannerSortKey = 'market-monitor:perpetual-scanner-sort:v1';
const capitalAssumptionsKey = 'market-monitor:perpetual-capital-assumptions:v1';
// The columns built so far; stored choices of later batches' columns stay in storage untouched and are not offered.
const builtColumns = new Set<ScannerColumnId>(['type', 'pair', 'funding', 'fundingSpread', 'annualized', 'volume', 'openInterest', 'quote', 'spread', 'capital', 'roc', 'time']);
const AVAILABLE_COLUMNS = SCANNER_COLUMNS.filter(column => builtColumns.has(column.id));
// Sorts the quotes alone can compute; a stored sort by a later batch's column shows the default order and stays stored.
const sortableScannerColumns = new Set<string>(['fundingSpread', 'annualized', 'quote', 'spread', 'capital', 'roc']);
const pageSize = 30;
const emptyQuotes: PerpetualQuote[] = [];
const emptyExchanges: PerpetualExchange[] = [];
const exchangeLabels = { connecting: '连接中', live: '实时', stale: '已过期', error: '连接异常', disabled: '未启用' };
const clockFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const delistingFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const stamp = (value: number | null | undefined) => value && Number.isFinite(value) ? clockFormat.format(value) : '—';
const percent = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`;
const age = (time: number, now: number) => `${Math.max(0, Math.floor((now - time) / 1000))} 秒前`;
const priceFormats = [2, 4, 6, 12].map(maximumFractionDigits => new Intl.NumberFormat('en-US', { maximumFractionDigits }));
function price(value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return '—';
  if (value < 0.00000001) return value.toExponential(4);
  return priceFormats[value >= 1000 ? 0 : value >= 1 ? 1 : value >= 0.01 ? 2 : 3]!.format(value);
}
const readStored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const store = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Filtering remains available with storage disabled. */ } };

// 5 s ahead of the page clock: the service judges by its own clock on arrival, a moment after the page's last tick.
const delistingDue = (quote: PerpetualQuote, now: number) => typeof quote.delistingAt === 'number' && quote.delistingAt > 0 && quote.delistingAt <= now + 5_000;

function DelistingNotice({ quote, now }: { quote: PerpetualQuote; now: number }) {
  if (!quote.delisting) return null;
  const at = typeof quote.delistingAt === 'number' && Number.isFinite(quote.delistingAt) && quote.delistingAt > 0 ? quote.delistingAt : null;
  const due = at !== null && now >= at;
  return <div className={`perp-delisting${due ? ' is-due' : ''}`}>
    <span className="perp-delisting-label">{due ? '已到下架时间' : '即将下架'}</span>
    <span className="perp-delisting-time">{at === null ? '下架时间待公布' : <><time dateTime={new Date(at).toISOString()}>{delistingFormat.format(at)}</time> <span className="perp-delisting-zone">北京时间</span></>}</span>
  </div>;
}

function QuoteDetails({ quotes, venues, mode, now, staleAfterMs }: { quotes: PerpetualQuote[]; venues: Map<string, PerpetualExchange>; mode: PerpetualPriceMode; now: number; staleAfterMs: number }) {
  return <div className="perp-detail perp-all-quotes">
    <div className="perp-detail-scroll"><table><thead><tr><th>币种 / 交易所 / 合约</th><th>买一 / 卖一</th><th>标记价</th><th>资金费 / 原周期</th><th>折算 / 8h</th><th>下次结算</th><th>价格状态</th></tr></thead>
      <tbody>{quotes.map(quote => {
        const venue = venues.get(quote.exchange);
        const freshness = classifyPerpetualQuote(quote, mode, now, staleAfterMs);
        const fresh = venue?.status === 'live' && freshness === 'fresh';
        const priceTime = quotePriceTime(quote, mode);
        const normalized = normalizedFunding8h(quote, now);
        return <tr key={`${quote.exchange}:${quote.symbol}:${quote.quoteCurrency}`} className={fresh ? undefined : 'perp-quote-stale'}>
          <th scope="row" className="perp-quote-identity"><strong>{quote.displayBase ?? quote.base}</strong><span>{venue?.name ?? quote.exchange}</span><small>{quote.symbol} · {quote.quoteCurrency}</small>{quote.comparable === false ? <small className="perp-unit-note">独立合约 · 不参与跨所排行</small> : null}{quote.contractUnit || quote.collateralCurrency ? <small>{quote.contractUnit ? `单位 ${quote.contractUnit}` : ''}{quote.collateralCurrency ? ` · 抵押 ${quote.collateralCurrency}` : ''}</small> : null}<DelistingNotice quote={quote} now={now} /></th>
          <td data-label="买一 / 卖一">{price(quote.bid)} / {price(quote.ask)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="标记价">{price(quote.mark)}<small>{quote.quoteCurrency}</small></td>
          <td data-label="资金费 / 原周期">{normalized === null ? '—' : percent(quote.fundingRate! * 100, 4)}<small>{quote.fundingIntervalHours ? `每 ${quote.fundingIntervalHours}h` : '周期未知'}</small></td>
          <td data-label="折算 / 8h">{normalized === null ? '—' : percent(normalized * 100, 4)}</td>
          <td data-label="下次结算">{stamp(quote.nextFundingAt)}<small>北京时间</small></td>
          <td data-label="价格状态">{fresh ? '有效' : freshness === 'stale' ? '已过期' : freshness === 'unavailable' ? mode === 'book' ? '暂无有效盘口' : '暂无标记价' : '平台未在线'}<small>{stamp(priceTime)} · {quote.transport.toUpperCase()}</small></td>
        </tr>;
      })}</tbody></table></div>
  </div>;
}

type DetailTab = 'execution' | 'exit' | 'quotes';
const DETAIL_TABS: { id: DetailTab; label: string }[] = [{ id: 'execution', label: '成交与持有' }, { id: 'exit', label: '平仓与跟踪' }, { id: 'quotes', label: '各平台报价' }];
const fxCurrencies = ['USDC', 'USD1', 'USDG', 'USD'];

export function PerpetualPanel({ onExpired }: { onExpired: () => void }) {
  // Expanding a pair freezes the snapshot, ranking and page it was opened from; the feed stops until it is closed.
  const [inspection, setInspection] = useState<{ key: string; base: string; snapshot: PerpetualSnapshot; ranking: PerpetualSpread[]; page: number } | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('execution');
  const paused = inspection !== null;
  const { data: liveData, connection, error, now, refresh } = usePerpetualFeed(onExpired, paused);
  const data = paused ? inspection.snapshot : liveData;
  const [filters, setFilters] = useState<PerpetualFilters>(() => parsePerpetualPreferences(readStored(preferencesKey)));
  const [scanner, setScanner] = useState<ScannerPreferences>(() => parseScannerPreferences(readStored(scannerPreferencesKey)));
  const [scannerSort, setScannerSort] = useState<ScannerSort | null>(() => parseScannerSort(readStored(scannerSortKey)));
  const [capitalAssumptions, setCapitalAssumptions] = useState<CapitalAssumptions>(() => parseCapitalAssumptions(readStored(capitalAssumptionsKey)));
  const [view, setView] = useState<'rank' | 'quotes'>('rank');
  const [page, setPage] = useState(1);
  const [toolsOpen, setToolsOpen] = useState(false);
  // The whole stored object is written back, so the fields this page does not use (a later page's) survive.
  useEffect(() => { store(preferencesKey, { version: 2, ...filters }); }, [filters]);
  useEffect(() => { store(scannerPreferencesKey, scanner); }, [scanner]);
  useEffect(() => { store(scannerSortKey, scannerSort); }, [scannerSort]);
  useEffect(() => { store(capitalAssumptionsKey, capitalAssumptions); }, [capitalAssumptions]);
  const search = useDeferredValue(filters.search);
  const exchanges = data?.exchanges ?? emptyExchanges;
  const quotes = data?.quotes ?? emptyQuotes;
  const venues = useMemo(() => new Map(exchanges.map(exchange => [exchange.id, exchange])), [exchanges]);
  const selected = useMemo(() => filters.exchanges === null ? null : new Set(filters.exchanges), [filters.exchanges]);
  const categorySet = useMemo(() => new Set(scanner.categories), [scanner.categories]);
  const expired = Boolean(data && now - data.generatedAt > data.staleAfterMs);
  const netSort = filters.sortBy === 'net';
  const fundingSort = filters.sortBy === 'funding';
  const effectiveSort = scannerSort && sortableScannerColumns.has(scannerSort.column) ? scannerSort : null;
  const activeSort = useMemo<ScannerSort>(() => effectiveSort ?? { column: fundingSort ? 'fundingSpread' : 'spread', direction: 'desc' }, [effectiveSort, fundingSort]);
  const sortRequirements = useMemo(() => scannerSortRequirements(effectiveSort), [effectiveSort]);
  const visibleColumns = useMemo(() => AVAILABLE_COLUMNS.filter(column => scanner.columns.includes(column.id)), [scanner.columns]);
  const staleAfterMs = data?.staleAfterMs ?? 30_000;
  const selectRanking = useMemo(() => createPerpetualRankingSelector(), []);
  const selectQuotes = useMemo(() => createPerpetualQuoteSelector(), []);
  const { data: fx, error: fxError } = usePerpetualFx((filters.crossCurrency || (view === 'rank' && sortRequirements.needsFx)) && !paused, onExpired);
  // Favourites and blocking belong to a later M-5 batch: they stay off here whatever is stored.
  const rankingFilters = useMemo(() => ({ ...filters, search, applyNumericThresholds: false, favoritesOnly: false, blockedPairs: [] }), [filters, search]);
  const fullRanking = useMemo(() => paused ? inspection.ranking : view === 'rank' && data && now ? selectRanking(data, rankingFilters, now, defaultQualityBudget, fx) : [], [paused, inspection, view, data, rankingFilters, now, selectRanking, fx]);
  const categoryRanking = useMemo(() => fullRanking.filter(row => categorySet.has(scannerPairCategory(row))), [fullRanking, categorySet]);
  // Frozen rows keep their order while details are open; sorting covers every matching row before the page is cut.
  const ranking = useMemo(() => paused || !effectiveSort ? categoryRanking : sortScannerRows(categoryRanking, effectiveSort, {
    fx, now, net: netSort, priceMode: filters.priceMode, staleAfterMs, capital: capitalAssumptions,
  }), [paused, effectiveSort, categoryRanking, fx, now, netSort, filters.priceMode, staleAfterMs, capitalAssumptions]);
  if (paused && !ranking.some(row => perpetualSpreadKey(row) === inspection.key)) setInspection(null);
  const expanded = paused ? inspection.key : null;
  const expandedBase = paused ? inspection.base : null;
  const categoryQuotes = useMemo(() => quotes.filter(quote => categorySet.has(scannerQuoteCategory(quote))), [quotes, categorySet]);
  const quoteSelection = useMemo(() => selectQuotes(categoryQuotes, rankingFilters), [categoryQuotes, rankingFilters, selectQuotes]);
  const liveExchanges = exchanges.filter(exchange => exchange.status === 'live').length;
  const totalItems = view === 'rank' ? ranking.length : quoteSelection.keys.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const visiblePage = Math.max(1, Math.min(paused ? inspection.page : page, totalPages));
  const rows = useMemo(() => ranking.slice((visiblePage - 1) * pageSize, visiblePage * pageSize), [ranking, visiblePage]);
  const quoteRows = view === 'quotes' ? quoteSelection.keys.slice((visiblePage - 1) * pageSize, visiblePage * pageSize).map(key => quoteSelection.byKey.get(key)!) : emptyQuotes;
  // The service rejects a whole batch with a leg past its delisting time (the workbench's rule), so such rows are not asked
  // for: their cells say 已下架 instead of the whole page failing.
  const metricPairs = useMemo(() => rows.filter(row => !delistingDue(row.long, now) && !delistingDue(row.short, now)).map(row => ({ base: row.base, longKey: `${row.long.exchange}:${row.long.symbol}`, shortKey: `${row.short.exchange}:${row.short.symbol}` })), [rows, now]);
  const { report: marketMetricsReport, error: marketMetricsError } = usePerpetualMarketMetrics(metricPairs, view === 'rank' && (scanner.columns.includes('volume') || scanner.columns.includes('openInterest')), onExpired);
  const detailQuotes = useMemo(() => expandedBase ? quotes.filter(quote => quote.base === expandedBase && (!selected || selected.has(quote.exchange))) : emptyQuotes, [quotes, expandedBase, selected]);

  function inspect(row: PerpetualSpread) {
    const key = perpetualSpreadKey(row);
    if (expanded === key) { setInspection(null); return; }
    setDetailTab('execution');
    if (data) setInspection(previous => previous ? { ...previous, key, base: row.base } : { key, base: row.base, snapshot: data, ranking, page: visiblePage });
    requestAnimationFrame(() => { const table = document.querySelector('.scanner-table-wrap'); if (table) table.scrollLeft = 0; });
  }
  function updateFilters(update: Partial<PerpetualFilters>) {
    setInspection(null); setFilters(previous => ({ ...previous, ...update })); setPage(1);
    if (Object.hasOwn(update, 'sortBy')) setScannerSort(null);
  }
  function changeScannerSort(column: ScannerSortColumn, leg?: 'long' | 'short') {
    setInspection(null); setPage(1); setScannerSort(nextScannerSort(activeSort, column, leg));
  }
  function changeCapitalAssumption(update: Partial<CapitalAssumptions>) {
    setInspection(null); setPage(1);
    setCapitalAssumptions(previous => normalizeCapitalAssumptions({ ...previous, ...update }));
  }
  function toggleColumn(id: ScannerColumnId) {
    setScanner(previous => ({ ...previous, columns: previous.columns.includes(id) ? previous.columns.filter(value => value !== id) : [...previous.columns, id] }));
  }
  function changeView(next: 'rank' | 'quotes') { setInspection(null); setView(next); setPage(1); }
  function changePage(next: number) { setInspection(null); setPage(next); }
  function changeOpportunityMode(funding: boolean) { changeView('rank'); updateFilters({ sortBy: funding ? 'funding' : fundingSort ? 'gross' : filters.sortBy }); }
  function toggleExchange(id: string) {
    const ids = exchanges.map(exchange => exchange.id);
    const next = new Set(filters.exchanges ?? ids);
    if (next.has(id)) next.delete(id); else next.add(id);
    // Stored ids of venues no longer listed must not make a partial choice count as "all" (the workbench compares sizes).
    updateFilters({ exchanges: ids.every(value => next.has(value)) ? null : [...next] });
  }
  function toggleCategory(id: ScannerCategoryId) {
    setInspection(null); setPage(1);
    setScanner(previous => ({ ...previous, categories: previous.categories.includes(id) ? previous.categories.filter(value => value !== id) : [...previous.categories, id] }));
  }
  function toggleRwa(checked: boolean) {
    setInspection(null); setPage(1);
    const rwa: ScannerCategoryId[] = ['equity', 'commodity', 'forex', 'index'];
    setScanner(previous => ({ ...previous, categories: checked ? [...new Set([...previous.categories, ...rwa])] : previous.categories.filter(id => !rwa.includes(id)) }));
  }
  function resetFilters() { setScanner(previous => ({ ...previous, categories: defaultScannerPreferences.categories })); updateFilters({ ...defaultPerpetualFilters, favorites: filters.favorites, favoritePairs: filters.favoritePairs, blockedPairs: filters.blockedPairs }); }

  const statusText = paused ? '查看详情 · 行情刷新已暂停' : connection === 'paused' ? '已暂停更新' : !data ? error ? '行情连接异常' : '正在连接行情' : data.status === 'unavailable' ? '采集服务未就绪' : expired ? '快照已过期' : connection === 'error' ? '更新中断' : data.status === 'snapshot' ? '保留快照' : data.status === 'connecting' ? '等待首批报价' : data.status === 'partial' ? '部分平台在线' : '行情自动更新';
  const transportText = paused ? '收起后恢复' : connection === 'stream' ? '自动刷新 / 20 秒' : connection === 'polling' || connection === 'error' ? '快照 / 20 秒' : connection === 'paused' ? '切回后恢复' : '正在建立连接';
  const problem = error || (expired ? '行情快照已过期，过期报价不参与排名。' : '');
  const emptyMessage = !scanner.categories.length ? '请选择至少一种资产类别。' : fullRanking.length > 0 && !ranking.length ? '当前类别下没有可比较组合；未核验类别可在“类别”中启用“未分类”。' : !data ? '正在获取交易所与合约报价…' : data.status === 'unavailable' ? '采集服务启动后，这里会显示实时合约价差。' : quotes.length === 0 ? '交易所正在连接，收到首批有效报价后自动更新。' : selected && selected.size < 2 ? '请至少选择两家交易所。' : fundingSort ? '当前筛选下没有可比较的资金费组合，可调整交易所。' : netSort && filters.priceMode === 'mark' ? '标记价仅供参考。切换买卖盘口可查看净价差排名。' : netSort ? '当前筛选下没有可比较的净价差组合，可切换毛价差核对。' : '当前筛选下没有有效价差。可以增加平台或切换报价口径。';

  return <section className={`perpetual-panel perp-scanner${fundingSort && view === 'rank' ? ' is-funding-mode' : ''}`} aria-label="CEX 与 DEX 合约价差监控">
    <header className="perp-heading"><div><h2>合约价差套利</h2></div><div className="perp-heading-actions"><button className="perp-refresh" type="button" onClick={() => paused ? setInspection(null) : refresh()} disabled={!paused && connection === 'paused'}><RefreshCw size={15} />{paused ? '收起并恢复' : '刷新'}</button></div></header>
    <div className="scanner-toolbar">
      <div className="perp-view-tabs" role="group" aria-label="行情视图">
        <button type="button" aria-pressed={view === 'rank' && !fundingSort} onClick={() => changeOpportunityMode(false)}>价格套利</button>
        <button type="button" aria-pressed={view === 'rank' && fundingSort} onClick={() => changeOpportunityMode(true)}>资金费套利</button>
        <button type="button" aria-pressed={view === 'quotes'} onClick={() => changeView('quotes')}>全部报价</button>
      </div>
      <ScannerMenu label={`交易所（${exchanges.filter(exchange => !selected || selected.has(exchange.id)).length} / ${exchanges.length}）`} className="scanner-exchange-menu">
        <div className="scanner-menu-actions"><button type="button" onClick={() => updateFilters({ exchanges: null })}>全选</button><button type="button" onClick={() => updateFilters({ exchanges: [] })}>清空</button></div>
        {exchanges.map(exchange => <label key={exchange.id}><input type="checkbox" checked={!selected || selected.has(exchange.id)} onChange={() => toggleExchange(exchange.id)} /><span>{exchange.name}</span><small className={exchange.status === 'live' && !expired ? 'positive' : ''}>{expired ? '快照过期' : exchangeLabels[exchange.status]}</small></label>)}
        {!exchanges.length ? <p>正在读取交易所…</p> : null}
      </ScannerMenu>
      <label className="perp-search"><Search size={14} aria-hidden="true" /><input aria-label="搜索币种" placeholder="筛选币种…" value={filters.search} maxLength={40} onChange={event => updateFilters({ search: event.target.value.toUpperCase() })} />{filters.search ? <button type="button" aria-label="清空搜索" onClick={() => updateFilters({ search: '' })}><X size={13} /></button> : null}</label>
      {view === 'rank' ? <ScannerMenu label={`显示列（${visibleColumns.length} / ${AVAILABLE_COLUMNS.length}）`}>
        <div className="scanner-menu-actions"><button type="button" onClick={() => setScanner(previous => ({ ...previous, columns: defaultScannerPreferences.columns }))}>恢复默认列</button></div>
        {AVAILABLE_COLUMNS.map(column => <label key={column.id}><input type="checkbox" checked={scanner.columns.includes(column.id)} onChange={() => toggleColumn(column.id)} />{column.label}</label>)}
      </ScannerMenu> : null}
      <label className="scanner-asset-toggle"><input type="checkbox" checked={['equity', 'commodity', 'forex', 'index'].every(id => scanner.categories.includes(id as ScannerCategoryId))} onChange={event => toggleRwa(event.target.checked)} />RWA</label>
      <label className="scanner-asset-toggle"><input type="checkbox" checked={categorySet.has('crypto')} onChange={() => toggleCategory('crypto')} />加密</label>
      <ScannerMenu label={`类别（${scanner.categories.length} / ${SCANNER_CATEGORIES.length}）`}>
        <div className="scanner-menu-actions"><button type="button" onClick={() => { setInspection(null); setPage(1); setScanner(previous => ({ ...previous, categories: defaultScannerPreferences.categories })); }}>全部类别</button></div>
        {SCANNER_CATEGORIES.map(category => <label key={category.id}><input type="checkbox" checked={categorySet.has(category.id)} onChange={() => toggleCategory(category.id)} />{category.label}</label>)}
        <p>按交易所已核验分类；未知或两腿分类不一致归入未分类。</p>
      </ScannerMenu>
    </div>
    <div className="scanner-status"><div className={`perp-connection ${expired || error || data?.status === 'unavailable' ? 'is-warning' : ''}`} role="status"><i aria-hidden="true" />{statusText}<span>{transportText}</span></div><span>{totalItems} {view === 'rank' ? '组合' : '报价'} · {liveExchanges} / {exchanges.length} 平台在线 · 更新 {stamp(data?.generatedAt)} 北京时间</span><span className="scanner-direction-key"><i className="positive">多</i> 做多腿在上 <i className="negative">空</i> 做空腿在下</span></div>
    {problem ? <div className="perp-notice" role="status">{problem}</div> : null}
    {view === 'rank' && effectiveSort ? <div className="scanner-filter-progress" role="status" aria-label="全量排序状态"><span>排序：{SCANNER_COLUMNS.find(column => column.id === effectiveSort.column)?.label}{effectiveSort.leg ? ` · ${effectiveSort.leg === 'long' ? '多腿' : '空腿'}` : ''} · {effectiveSort.direction === 'desc' ? '从高到低' : '从低到高'}</span><span>{sortRequirements.needsFx ? '按 USDT 等值比较，显示保留原币；' : ''}缺失或过期置后</span></div> : null}
    {view === 'rank' && sortRequirements.needsFx && fxError && !filters.crossCurrency ? <p className="perp-quality-notice" role="status">排序所需汇率暂不可用，缺失汇率的组合排在末尾。</p> : null}
    {view === 'rank' && marketMetricsError ? <p className="perp-quality-notice" role="status">{marketMetricsError}</p> : null}
    {filters.crossCurrency ? <p className="perp-currency-warning">{fxError || (fx ? `汇率快照 ${stamp(fx.generatedAt)} · 仅纳入有新鲜买卖汇率的组合；USD 等缺失汇率不假定等于 1。换汇手续费另计。` : '正在读取现货汇率，缺失汇率的跨币组合暂不参与排名。')}</p> : null}
    {filters.crossCurrency && fx ? <details className="perp-fx-details"><summary>查看每条汇率的来源时间与买卖价</summary><div>{fxCurrencies.map(currency => { const rate = fx.rates[currency]; return <p key={currency}><strong>{currency} / USDT</strong> · {rate ? <>买 {rate.bid.toFixed(6)} / 卖 {rate.ask.toFixed(6)} · 源时间 {stamp(rate.at)}{now - rate.at > fx.staleAfterMs ? ' · 已过期' : ''}</> : '未纳入'}{fx.reasons?.[currency] ? <span> · {fx.reasons[currency]}</span> : null}</p>; })}</div></details> : null}
    {view === 'quotes' ? <><p className="perp-quotes-caption">平台组合与价差阈值仅影响排名。此处保留原始合约单位，独立合约不参与跨所比较。</p><div className="perp-table-wrap"><QuoteDetails quotes={quoteRows} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={staleAfterMs} />{!quoteRows.length ? <div className="perp-empty"><strong>暂无符合条件的报价</strong><p>{!data || !quotes.length ? emptyMessage : '可以调整币种搜索或交易所筛选。'}</p></div> : null}</div></> : <div className="perp-table-wrap scanner-table-wrap" tabIndex={0} role="region" aria-label="套利组合表格，可横向滚动"><table className="perp-table perp-scanner-table"><thead><tr><th scope="col">币种</th>{visibleColumns.map(column => {
      const sortable = sortableScannerColumns.has(column.id) ? column.id as ScannerSortColumn : null;
      const sorted = activeSort.column === column.id;
      const dualLeg = column.id === 'volume' || column.id === 'openInterest' || column.id === 'quote';
      const label = column.id === 'spread' ? netSort ? '净价差' : filters.priceMode === 'mark' ? '标记价差' : column.label : column.label;
      const nextDirection = (leg?: 'long' | 'short') => sorted && activeSort.direction === 'desc' && (!dualLeg || activeSort.leg === (leg ?? 'long')) ? '升序' : '降序';
      const arrow = sorted ? activeSort.direction === 'desc' ? '↓' : '↑' : '↕';
      return <th scope="col" key={column.id} data-column={column.id} aria-sort={sortable && sorted ? activeSort.direction === 'desc' ? 'descending' : 'ascending' : undefined}>
        {sortable ? <button type="button" className="scanner-sort-column" aria-label={`${label}，${dualLeg ? '多腿，' : ''}点击按${nextDirection()}排序`} onClick={() => changeScannerSort(sortable, dualLeg ? 'long' : undefined)}>{label}<span aria-hidden="true">{arrow}</span></button> : label}
        {dualLeg && sortable ? <div className="scanner-sort-legs">{(['long', 'short'] as const).map(leg => <button type="button" key={leg} data-sort-leg={leg} aria-pressed={sorted && activeSort.leg === leg} aria-label={`${label}，${leg === 'long' ? '多腿' : '空腿'}，点击按${nextDirection(leg)}排序`} onClick={() => changeScannerSort(sortable, leg)}>{leg === 'long' ? '多' : '空'}{sorted && activeSort.leg === leg ? <span aria-hidden="true">{arrow}</span> : null}</button>)}</div> : null}
        {column.id === 'fundingSpread' ? <small>/ 8h</small> : column.id === 'annualized' ? <small>当前费率估算</small> : column.id === 'capital' ? <small>占多腿名义</small> : column.id === 'roc' ? <small>{capitalAssumptions.holdingHours}h 情景</small> : column.id === 'quote' ? <small>{filters.priceMode === 'book' ? '多卖一 / 空买一' : '标记价 · 仅供参考'}</small> : null}
      </th>;
    })}<th scope="col"><span className="perp-sr-only">展开组合详情</span></th></tr></thead>
      <tbody>{rows.map(row => {
        const rowKey = perpetualSpreadKey(row), isExpanded = expanded === rowKey;
        const detailId = `perp-detail-${rows.indexOf(row)}`;
        const pairLabel = `${row.base} 多 ${venues.get(row.long.exchange)?.name ?? row.long.exchange} / 空 ${venues.get(row.short.exchange)?.name ?? row.short.exchange}`;
        const primarySpread = netSort ? row.netSpreadPercent ?? null : row.spreadPercent;
        const longFunding = normalizedFunding8h(row.long, now), shortFunding = normalizedFunding8h(row.short, now);
        const fundingSpread = longFunding === null || shortFunding === null ? null : shortFunding - longFunding;
        const category = scannerPairCategory(row);
        const categoryLabel = SCANNER_CATEGORIES.find(item => item.id === category)?.label ?? '未分类';
        const annualized = annualizedFundingPercent(fundingSpread);
        const { capital: rowCapital, roc: rowRoc } = scannerCapitalMetrics(row, capitalAssumptions, { now, priceMode: filters.priceMode, staleAfterMs });
        const rowDelisted = delistingDue(row.long, now) || delistingDue(row.short, now);
        const longMetric = marketMetricsReport?.legs[`${row.long.exchange}:${row.long.symbol}`];
        const shortMetric = marketMetricsReport?.legs[`${row.short.exchange}:${row.short.symbol}`];
        const cells: Partial<Record<ScannerColumnId, React.ReactNode>> = {
          type: <span className="scanner-type-tag" title={categoryLabel} aria-label={categoryLabel}>{category === 'crypto' ? 'C' : category === 'unknown' ? '?' : 'R'}</span>,
          pair: <div className="scanner-pair"><ScannerLeg quote={row.long} name={venues.get(row.long.exchange)?.name ?? row.long.exchange} side="long" now={now} /><ScannerLeg quote={row.short} name={venues.get(row.short.exchange)?.name ?? row.short.exchange} side="short" now={now} /></div>,
          funding: <><ScannerFundingRate quote={row.long} now={now} /><ScannerFundingRate quote={row.short} now={now} /></>,
          fundingSpread: <span className={scannerPolarity(fundingSpread)}>{scannerPercent(fundingSpread === null ? null : fundingSpread * 100)}</span>,
          annualized: <span className={scannerPolarity(annualized)} title="当前 8h 资金费差 × 3 × 365；按单腿等名义本金简单外推，未扣费用，不复利">{scannerPercent(annualized, 1)}</span>,
          volume: rowDelisted ? <span className="scanner-metric-state">已下架</span> : <ScannerMarketMetric long={longMetric} short={shortMetric} metricName="volume24h" now={now} />,
          openInterest: rowDelisted ? <span className="scanner-metric-state">已下架</span> : <ScannerMarketMetric long={longMetric} short={shortMetric} metricName="openInterest" now={now} />,
          quote: <div className="scanner-stack"><div title={String(row.buyPrice)}>{price(row.buyPrice)} <small>{row.long.quoteCurrency}</small></div><div title={String(row.sellPrice)}>{price(row.sellPrice)} <small>{row.short.quoteCurrency}</small></div>{now - row.updatedAt > staleAfterMs ? <small className="scanner-stale">报价已过期</small> : null}</div>,
          spread: <div className={scannerPolarity(primarySpread)}><strong>{percent(primarySpread)}</strong><small className="secondary">{netSort ? '毛' : '净'} {percent(netSort ? row.spreadPercent : row.netSpreadPercent ?? null)}</small></div>,
          capital: <span title={rowCapital.capitalPercent === null ? rowCapital.reason : `按多腿 ${capitalAssumptions.longLeverage}x、空腿 ${capitalAssumptions.shortLeverage}x、缓冲 ${capitalAssumptions.marginBufferPercent}% 估算；资本占做多腿名义 ${rowCapital.capitalPercent.toFixed(1)}%`}>{rowCapital.capitalPercent === null ? '—' : `${rowCapital.capitalPercent.toFixed(1)}%`}</span>,
          roc: rowRoc.rocPercent === null ? <span title={rowCapital.reason || rowRoc.reason}>—</span> : <div className={scannerPolarity(rowRoc.rocPercent)} title={`ROC =（净价差 + ${capitalAssumptions.holdingHours}h 资金费）÷ 所需资本；按同数量双腿名义金额加权，连续外推当前费率，假设退出价差归零。${rowRoc.reason}`}><strong>{scannerPercent(rowRoc.rocPercent, 2)}</strong><small className="secondary">{rowRoc.fundingAvailable ? `资金费年化 ${scannerPercent(rowRoc.fundingRocAnnualizedPercent, 1)}` : '资金费缺失或过期 · 仅价差'}</small></div>,
          time: <div className="scanner-time"><time dateTime={new Date(row.updatedAt).toISOString()}>{stamp(row.updatedAt)}</time><small>{age(row.updatedAt, now)}{paused ? now - row.updatedAt > staleAfterMs ? ' · 已过期' : ' · 已暂停' : ''}</small></div>,
        };
        const delisting = row.long.delisting || row.short.delisting;
        return <Fragment key={rowKey}><tr className={isExpanded ? 'perp-row-expanded' : undefined}>
          <th scope="row" className="perp-base-cell"><div><strong>{row.base}</strong><small>{row.crossCurrency ? `${row.long.quoteCurrency} / ${row.short.quoteCurrency}` : row.long.quoteCurrency}{row.fxAdjusted ? ' · 已换汇' : ''}</small></div></th>
          {visibleColumns.map(column => <td key={column.id} data-column={column.id} className="scanner-number">{cells[column.id]}</td>)}
          <td className="perp-expand-cell"><button type="button" aria-label={`${isExpanded ? '收起' : '展开'} ${pairLabel} 盘口校验与各平台报价`} aria-expanded={isExpanded} aria-controls={detailId} onClick={() => inspect(row)}><ChevronDown size={16} /></button></td>
        </tr>{isExpanded ? <tr className="perp-detail-row" id={detailId}><td colSpan={visibleColumns.length + 2}>
          <div className="perp-inspection-bar"><p role="status"><strong>行情已暂停</strong> · 保留 {stamp(data?.generatedAt)} 的排名与报价{now - row.updatedAt > staleAfterMs ? ' · 报价已过期，仅供核对' : ''}</p><button type="button" onClick={() => setInspection(null)}>收起并恢复</button></div>
          <div className="scanner-detail-evidence">{delisting ? <><DelistingNotice quote={row.long} now={now} /><DelistingNotice quote={row.short} now={now} /></> : null}<p>所需资本 {rowCapital.capitalPercent === null ? '—' : `${rowCapital.capitalPercent.toFixed(1)}%`} 多腿名义 · ROC（{capitalAssumptions.holdingHours}h）{scannerPercent(rowRoc.rocPercent, 2)} · 资金费年化 ROC {scannerPercent(rowRoc.fundingRocAnnualizedPercent, 1)}{rowRoc.reason ? ` · ${rowRoc.reason}` : ''}</p></div>
          <div className="perp-detail-navigation"><div role="tablist" aria-label="组合详情" onKeyDown={event => { const ids = DETAIL_TABS.map(tab => tab.id); const index = ids.indexOf(detailTab); const next = event.key === 'ArrowRight' ? ids[(index + 1) % ids.length] : event.key === 'ArrowLeft' ? ids[(index + ids.length - 1) % ids.length] : event.key === 'Home' ? ids[0] : event.key === 'End' ? ids[ids.length - 1] : null; if (next) { event.preventDefault(); setDetailTab(next); document.getElementById(`${detailId}-tab-${next}`)?.focus(); } }}>{DETAIL_TABS.map(tab => <button type="button" role="tab" key={tab.id} id={`${detailId}-tab-${tab.id}`} aria-selected={detailTab === tab.id} tabIndex={detailTab === tab.id ? 0 : -1} aria-controls={`${detailId}-content`} onClick={() => setDetailTab(tab.id)}>{tab.label}</button>)}</div></div>
          <div role="tabpanel" id={`${detailId}-content`} aria-labelledby={`${detailId}-tab-${detailTab}`} className="perp-detail-content">
            {detailTab === 'execution' ? <PerpetualExecution long={row.long} short={row.short} active now={now} onExpired={onExpired} /> : detailTab === 'exit' ? <PerpetualExit long={row.long} short={row.short} budget={defaultQualityBudget} active now={now} onExpired={onExpired} /> : <QuoteDetails quotes={detailQuotes} venues={venues} mode={filters.priceMode} now={now} staleAfterMs={staleAfterMs} />}
          </div>
        </td></tr> : null}</Fragment>;
      })}</tbody></table>
      {!rows.length ? <div className="perp-empty"><span aria-hidden="true">—</span><strong>{!data || data.status === 'connecting' ? '等待实时报价' : fundingSort ? '暂无符合条件的资金费机会' : '暂无符合条件的价差'}</strong><p>{emptyMessage}</p>{quotes.length > 0 ? <button type="button" onClick={resetFilters}>重置筛选</button> : null}</div> : null}
    </div>}
    <div className="perp-pagination"><span>{totalItems ? `${(visiblePage - 1) * pageSize + 1}–${Math.min(visiblePage * pageSize, totalItems)} / ${totalItems} ${view === 'rank' ? '组合' : '报价'}` : `0 ${view === 'rank' ? '组合' : '报价'}`}<small>每页 {pageSize} 条</small></span><div><button type="button" aria-label="上一页" disabled={visiblePage <= 1} onClick={() => changePage(visiblePage - 1)}><ChevronLeft size={16} /></button><span>{visiblePage} / {totalPages}</span><button type="button" aria-label="下一页" disabled={visiblePage >= totalPages} onClick={() => changePage(visiblePage + 1)}><ChevronRight size={16} /></button></div></div>
    {view === 'rank' ? <p className="scanner-data-note">资金费差统一折算 / 8h；年化按当前费率简单外推。净价差 = 毛价差 − 两腿开平共四次公开 taker 费 − 0.10% 滑点预算；费率待核实的平台显示 —。</p> : null}
    <details className="scanner-tools" open={toolsOpen} onToggle={event => setToolsOpen(event.currentTarget.open)}><summary>监控工具与设置<ChevronDown size={14} /></summary><div className="scanner-tools-content">
      <details className="scanner-advanced-filters" open><summary>更多筛选与排序设置</summary>
        <div className="perp-filter-fields">
          <label>价差排序<select aria-label="价差排序" value={filters.sortBy ?? 'gross'} onChange={event => updateFilters({ sortBy: event.target.value as PerpetualFilters['sortBy'] })}><option value="gross">毛价差从高到低</option><option value="net">净价差从高到低</option><option value="funding">资金费差从高到低 / 8h</option></select></label>
          <label>报价口径<select value={filters.priceMode} onChange={event => updateFilters({ priceMode: event.target.value as PerpetualPriceMode })}><option value="book">买卖盘口</option><option value="mark">标记价格 · 仅供参考</option></select></label>
          <label>平台组合<select value={filters.pairMode} onChange={event => updateFilters({ pairMode: event.target.value as PerpetualPairMode })}><option value="all">全部组合</option><option value="cex-dex">CEX ↔ DEX</option><option value="cex-cex">CEX ↔ CEX</option><option value="dex-dex">DEX ↔ DEX</option></select></label>
          <label>计价币范围<select value={filters.crossCurrency ? 'cross' : 'same'} onChange={event => updateFilters({ crossCurrency: event.target.value === 'cross' })}><option value="same">仅相同计价币</option><option value="cross">跨计价币 · 按现货汇率校正</option></select></label>
        </div>
        <div className="perp-filter-fields">
          <label>ROC 杠杆 / 倍<input aria-label="ROC 杠杆" type="number" min={1} max={20} step="0.1" value={capitalAssumptions.longLeverage} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) changeCapitalAssumption({ longLeverage: value, shortLeverage: value }); }} /></label>
          <label>ROC 保证金缓冲 / %<input aria-label="ROC 保证金缓冲" type="number" min={0} max={100} step="1" value={capitalAssumptions.marginBufferPercent} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) changeCapitalAssumption({ marginBufferPercent: value }); }} /></label>
          <label>ROC 持有 / 小时<input aria-label="ROC 持有小时" type="number" min={1} max={168} step="1" value={capitalAssumptions.holdingHours} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value)) changeCapitalAssumption({ holdingHours: value }); }} /></label>
        </div>
        <p className="scanner-data-note">ROC 假设仅用于估算所需资本与资本回报，不改变交易所实际保证金；默认按两腿 3x、20% 缓冲、24 小时连续外推；资金费按同数量双腿的各自名义金额加权，假设退出价差归零。与按实际结算时点计数的 24h 估算口径不同。</p>
        <div className="perp-filter-footer"><span>筛选与排序保存在当前浏览器</span><button type="button" onClick={resetFilters}>重置全部筛选</button></div>
      </details>
      <PerpetualManualPairs snapshot={data} mode={filters.priceMode} now={now} budget={defaultQualityBudget} active={toolsOpen} paused={paused} onExpired={onExpired} />
    </div></details>
  </section>;
}
