// 复制自 project-aggregation 工作台 modules/monitor/app/perpetual-panel.tsx（提交 c84ba27）的 QualityCell、PositioningOverviewCard、
// QualityEvidence 三个组件（第 139–197 行）与它们用到的格式化常量（第 61–74 行）；只给两个组件加 export、改导入；本仓库面板文件已较长，单独成文件。
import { ChevronDown } from "lucide-react";
import { pairQualityHistory, type OpportunityQuality, type PerpetualQualityReport } from "../../src/vendor/perpetual-quality.ts";
import type { PerpetualSpread } from "./perpetual-spreads.ts";
import type { PerpetualExchange } from "./perpetual-types.ts";

const positioningVenues = [{ id: "binance", name: "Binance" }, { id: "bybit", name: "Bybit" }, { id: "okx", name: "OKX" }, { id: "bitget", name: "Bitget" }, { id: "gate", name: "Gate" }];
const positioningStatusLabels = { fresh: "已纳入", stale: "未纳入", pending: "采集中", unsupported: "不支持", unavailable: "暂无资料", error: "更新失败", "rate-limited": "请求限流" };
const clockFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const delistingFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const stamp = (value: number | null | undefined) => value && Number.isFinite(value) ? clockFormat.format(value) : "—";
const percent = (value: number | null, digits = 3) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
const usdFormat = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);
const share = (value: number | null | undefined, digits = 1) => finite(value) ? `${(value * 100).toFixed(digits)}%` : "—";
const usd = (value: number | null | undefined) => finite(value) && value > 0 ? usdFormat.format(value) : "—";
const deviation = (value: number | null | undefined) => finite(value) ? `${value.toFixed(4)} 百分点` : "—";

export function QualityCell({ quality, pairLabel, onInspect }: { quality: OpportunityQuality; pairLabel: string; onInspect: () => void }) {
  return <button type="button" className={`perp-quality-grade ${quality.grade}`} aria-label={`查看 ${pairLabel} 聚合质量依据：${quality.label}${quality.score === null ? "" : `，${quality.score} 分`}，数据覆盖 ${quality.coverage}%`} onClick={onInspect}>
    <strong>{quality.label}<b>{quality.score === null ? "—" : quality.score}<small>{quality.score === null ? "" : "/100"}</small></b></strong>
    <span>数据覆盖 {quality.coverage}%</span>
    <span className="perp-quality-signals">{Object.entries(quality.profiles).map(([key, profile]) => <span key={key} className={profile.status} title={profile.detail}>{profile.label}</span>)}</span>
  </button>;
}

function PositioningOverviewCard({ base, report, venues, now }: { base: string; report: PerpetualQualityReport | null; venues: Map<string, PerpetualExchange>; now: number }) {
  const overview = report?.positioningOverview?.[base];
  const stale = Boolean(overview?.observedAt && now - overview.observedAt > 900_000);
  const ready = Boolean(overview && overview.availableExchanges >= 2 && finite(overview.longRatio) && finite(overview.shortRatio) && overview.longRatio >= 0 && overview.longRatio <= 1 && overview.shortRatio >= 0 && overview.shortRatio <= 1 && Math.abs(overview.longRatio + overview.shortRatio - 1) <= 0.001);
  return <section className={`perp-positioning-overview${stale ? " is-stale" : ""}`} aria-label={`${base} 跨所账户多空概览`}>
    <div className="perp-positioning-overview-heading"><h4>{base} 跨所账户多空概览<small>USDT 合约全体持仓账户比例 · 5 分钟</small></h4><span className={stale || !ready ? "perp-positioning-state is-warning" : "perp-positioning-state"}>{stale ? "资料过期 · 保留上次值" : ready ? "免费跨所汇总" : overview ? "资料不足" : "资料采集中"}</span></div>
    {ready ? <div className="perp-positioning-composition"><div className="perp-positioning-overview-values"><strong>多 <b>{share(overview!.longRatio)}</b></strong><strong>空 <b>{share(overview!.shortRatio)}</b></strong></div><div className="perp-positioning-bar" aria-hidden="true"><span style={{ width: `${overview!.longRatio! * 100}%` }}/><span style={{ width: `${overview!.shortRatio! * 100}%` }}/></div></div> : <p className="perp-positioning-insufficient">{overview ? "资料不足，至少需要 2 家有效官方数据" : "等待交易所官方账户比例"}</p>}
    <div className="perp-positioning-coverage"><strong>{stale ? "上次有效覆盖" : "有效覆盖"} {overview?.availableExchanges ?? "—"} / {overview?.totalExchanges ?? 5} 家</strong><span>{overview ? `当前发现 ${overview.eligibleExchanges} 家有对应 USDT 市场` : "对应 USDT 市场待核对"}</span><span>数据时间 {stamp(overview?.observedAt)} 北京时间</span></div>
    <p className="perp-positioning-method">每家交易所等权：对有效的多头账户比例取平均，空头比例为 100% 减去多头比例；缺失数据不补 50%。这是跨所比例概览，不是全网真实人数，不参与两腿质量评分。</p>
    <details className="perp-positioning-breakdown"><summary>查看五家交易所明细 <ChevronDown size={14} aria-hidden="true"/></summary><ul>{positioningVenues.map(venue => {
      const item = overview?.constituents.find(entry => entry.exchange === venue.id);
      const ratio = item?.key ? report?.positioning[item.key] : undefined;
      const error = item?.key ? report?.positioningErrors[item.key] : undefined;
      const status = item?.status ?? "pending";
      const sourceStale = stale || Boolean(ratio && now - ratio.observedAt > 900_000);
      const statusLabel = status === "fresh" && sourceStale ? "资料过期" : status === "fresh" && error ? "已纳入 · 更新失败" : positioningStatusLabels[status];
      const reason = item?.reason || error;
      return <li key={venue.id}><div className="perp-positioning-venue-heading"><strong>{venues.get(venue.id)?.name ?? venue.name}</strong><span className={status === "fresh" && !sourceStale && !error ? "perp-positioning-state" : "perp-positioning-state is-warning"}>{statusLabel}</span></div><small>{item?.symbol ?? (item ? "无对应 USDT 合约" : "对应合约待核对")}</small>{ratio ? <><p className="perp-positioning-venue-values">{status === "fresh" && !sourceStale ? "官方值" : "上次官方值"} · 多 {share(ratio.longRatio)} / 空 {share(ratio.shortRatio)}</p><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方来源</a> : "官方来源"} · {stamp(ratio.observedAt)} 北京时间</small></> : null}{reason ? <p className="perp-positioning-reason">{reason}</p> : status === "pending" ? <p className="perp-positioning-reason">官方账户比例采集中</p> : sourceStale ? <p className="perp-positioning-reason">资料过期，保留上次值供核对</p> : null}</li>;
    })}</ul></details>
  </section>;
}

export function QualityEvidence({ row, report, quality, venues, now, slippagePercent }: { row: PerpetualSpread; report: PerpetualQualityReport | null; quality: OpportunityQuality; venues: Map<string, PerpetualExchange>; now: number; slippagePercent: number }) {
  const asset = report?.assets[row.base];
  const history = pairQualityHistory(row, report);
  const spread = history?.spread, funding = history?.funding;
  const dilution = asset && finite(asset.marketCapUsd) && asset.marketCapUsd > 0 && finite(asset.fdvUsd) && asset.fdvUsd > 0 ? asset.marketCapUsd / asset.fdvUsd : null;
  const reportDelayed = Boolean(report && now - report.generatedAt > 180_000);
  const legs = [{ label: "做多腿", quote: row.long }, { label: "做空腿", quote: row.short }];
  return <div className="perp-quality-evidence">
    <div className="perp-quality-evidence-heading"><strong>聚合质量依据 <span>{quality.label}{quality.score === null ? "" : ` · ${quality.score} / 100`}</span></strong><span>{report ? `${reportDelayed ? "上次读取" : "最近读取"} ${stamp(report.generatedAt)} 北京时间` : "资料采集中"}</span></div>
    <div className="perp-quality-profiles">{Object.entries(quality.profiles).map(([key, profile]) => <section key={key} className={profile.status}><small>{key === "persistence" ? "价差持续性" : key === "convergence" ? "报价收窄证据" : "资金费收支方向"}</small><h4>{profile.label}</h4><p>{profile.detail}</p></section>)}</div>
    <section className="perp-convergence" aria-label="报价收窄历史"><h4>报价价差减半记录 <small>近 24h · 每 5 分钟真实采样</small></h4><p>以固定 UTC 时段的起点为基准，起始价差至少 0.05%；观察是否曾降至一半。各持有时长分别使用互不重叠的窗口；报价缺口整窗排除，尚未结束的窗口不计结果。</p>{history?.convergence ? <><div className="perp-convergence-scroll"><table><thead><tr><th>窗口</th><th>曾减半 / 完整窗口</th><th>减半占比</th><th>中位耗时</th><th>最大反向扩大</th><th>缺口 / 未结束</th></tr></thead><tbody>{history.convergence.horizons.map(item => <tr key={item.hours}><th>{item.hours}h</th><td>{item.successful} / {item.completed}</td><td>{share(item.successRatio)}</td><td>{item.medianMinutesToTarget === null ? "—" : `${item.medianMinutesToTarget} 分钟`}</td><td>{deviation(item.maxAdverseExpansionPercent)}</td><td>{item.incomplete} / {item.pending}</td></tr>)}</tbody></table></div><p>{history.convergence.samples} / 288 个样本 · 最近 {stamp(history.convergence.lastAt)}{history.convergence.lastAt && now - history.convergence.lastAt > 600_000 ? " · 已过期" : ""}。4h / 8h 窗口样本较少，仅展示记录。</p></> : <p>正在积累收窄历史；至少需要 12 小时采样与 6 个完整的 1h 窗口才参与评分。</p>}<p className="perp-quality-warning">这里衡量开仓报价的历史变化，未计退出买卖价、费用和成交容量，不是回测收益或盈利概率。</p></section>
    <PositioningOverviewCard base={row.base} report={report} venues={venues} now={now}/>
    <div className="perp-quality-grid">
      <section><h4>市值与 FDV <small>USD</small></h4><dl><div><dt>市值</dt><dd>{usd(asset?.marketCapUsd)}</dd></div><div><dt>完全稀释估值 / FDV</dt><dd>{usd(asset?.fdvUsd)}</dd></div><div><dt>市值 / FDV</dt><dd>{share(dilution)}</dd></div></dl><p>{asset ? <><a href={`https://www.coingecko.com/en/coins/${encodeURIComponent(asset.coinId)}`} target="_blank" rel="noopener noreferrer">{asset.name}</a> · CoinGecko · {stamp(asset.updatedAt)}</> : report?.assetErrors[row.base] || "市值资料采集中"}</p>{asset && (!asset.updatedAt || now - asset.updatedAt > 3_600_000) ? <p className="perp-quality-warning">市值资料已过期，未计入评分</p> : null}</section>
      <section><h4>交易所官方多空比例</h4>{legs.map(({ label, quote }) => {
        const key = `${quote.exchange}:${quote.symbol}`, ratio = report?.positioning[key], error = report?.positioningErrors[key];
        return <div className="perp-positioning-leg" key={key}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}</strong><small>{quote.symbol}</small>{ratio ? <><p className="perp-positioning-values">多 {share(ratio.longRatio)} <span>/</span> 空 {share(ratio.shortRatio)}</p><small>{ratio.kind === "accounts" ? "账户人数占比" : "持仓量占比"} · 范围：{ratio.scope}</small><small>{ratio.source.startsWith("https://") ? <a href={ratio.source} target="_blank" rel="noopener noreferrer">官方数据</a> : "官方数据"} · {stamp(ratio.observedAt)}{now - ratio.observedAt > 900_000 ? " · 已过期" : ""}</small>{error ? <p className="perp-quality-warning">保留上次值 · {error}</p> : null}</> : <p>{error || "官方多空资料采集中"}</p>}</div>;
      })}<p>账户人数与持仓量口径不混算。</p></section>
      <section><h4>盘口价差稳定度 <small>近 1h</small></h4><p className="perp-quality-samples">{spread?.samples ? `${spread.samples} / ${spread.expectedSamples} 个样本 · 覆盖 ${share(spread.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>价差均值</dt><dd>{percent(spread?.mean ?? null, 4)}</dd></div><div><dt>标准差</dt><dd>{deviation(spread?.stddev)}</dd></div><div><dt>正价差占比</dt><dd>{share(spread?.positiveRatio)}</dd></div></dl><p>{spread?.lastAt ? `最近有效样本 ${stamp(spread.lastAt)}${now - spread.lastAt > 180_000 ? " · 已过期" : ""}` : "等待同一平台组合的有效盘口"}{spread?.samples && spread.samples < 30 ? " · 尚未满 30 个有效点" : ""}</p></section>
      <section><h4>资金费稳定度 <small>近 24h · 折算 / 8h</small></h4><p className="perp-quality-samples">{funding?.samples ? `${funding.samples} / ${funding.expectedSamples} 个样本 · 覆盖 ${share(funding.coverage)}` : "采集中 · 暂无有效样本"}</p><dl><div><dt>做多腿标准差</dt><dd>{deviation(funding?.longStddev)}</dd></div><div><dt>做空腿标准差</dt><dd>{deviation(funding?.shortStddev)}</dd></div><div><dt>两腿费差均值</dt><dd>{percent(funding?.mean ?? null, 4)}</dd></div></dl><p>{funding?.lastAt ? `最近有效样本 ${stamp(funding.lastAt)}${now - funding.lastAt > 600_000 ? " · 已过期" : ""} · ` : ""}采样为实时预估费率，非已结算资金费。</p></section>
    </div>
    <div className="perp-quality-rubric">{quality.dimensions.map(dimension => <details key={dimension.id}><summary>{dimension.label}<span>{dimension.score === null ? "缺失 / 未评分" : `${dimension.score} / 100`} · 权重 {dimension.weight}%</span></summary><p>{dimension.detail}</p></details>)}</div>
    <section className="perp-taker-evidence" aria-label="双腿 taker 手续费"><h4>双腿 taker 手续费 <small>单次成交 · 按名义本金</small></h4><div>{legs.map(({ label, quote }, index) => {
      const fee = index === 0 ? quality.fees.long : quality.fees.short;
      return <div key={label}><strong>{label} · {venues.get(quote.exchange)?.name ?? quote.exchange}<b>{fee.percent === null ? "—" : `${fee.percent.toFixed(4)}%`}</b></strong><small>{quote.symbol} · {fee.basis === "account" ? "账户覆盖" : fee.basis === "public" ? "公开普通费率" : "费率待核实"}</small><p>{fee.detail}</p>{fee.source ? <small><a href={fee.source} target="_blank" rel="noopener noreferrer">官方来源</a>{fee.checkedAt ? ` · 核对 ${delistingFormat.format(fee.checkedAt)} 北京时间` : ""}</small> : null}</div>;
    })}</div><p>往返手续费 <strong>{quality.fees.roundTripPercent === null ? "—" : `${quality.fees.roundTripPercent.toFixed(4)}%`}</strong> · 双腿往返滑点 <strong>{slippagePercent.toFixed(2)}%</strong></p><p>每腿开、平仓各计一次 taker；以每腿相同名义本金估算，平仓成交额变化后实际费用也会变化。</p></section>
    <div className="perp-quality-conclusion"><p>扣 taker 手续费与滑点后价差 <strong>{percent(quality.netSpreadPercent)}</strong>；未计持有期资金费与实际成交差异。</p>{quality.reasons.length ? <ul>{quality.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : null}<p>分数是筛选参考，不代表盈利概率；数据覆盖按可评分维度权重计算，缺失项未补零。</p></div>
  </div>;
}
