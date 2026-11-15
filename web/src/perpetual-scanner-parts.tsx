// 摘自 project-aggregation 工作台 modules/monitor/app/perpetual-scanner-parts.tsx（提交 c84ba27）：只取
// scannerPercent、scannerPolarity、ScannerMenu、ScannerLeg、ScannerFundingRate，内容未改；改了导入路径，
// 去掉依赖资金费历史与市场指标的部分（M-5）。
import type { ReactNode } from 'react';
import type { PerpetualQuote } from './perpetual-types.ts';
import { normalizedFunding8h } from './perpetual-spreads.ts';


const dateFormat = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export const scannerPercent = (value: number | null, digits = 4) => value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(digits)}%`;
export const scannerPolarity = (value: number | null) => value !== null && value > 0 ? "positive" : value !== null && value < 0 ? "negative" : "";
const exchangeMarks: Record<string, string> = { binance: "B", bybit: "By", okx: "OK", bitget: "Bg", gate: "G", kraken: "Kr", lighter: "L", "rh-lighter": "RH", hyperliquid: "H", aster: "A", entropy: "E" };

export function ScannerMenu({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <details name="perpetual-scanner-menu" className={`scanner-menu ${className}`} onKeyDown={event => {
    if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); }
  }}><summary>{label}</summary><div className="scanner-menu-content">{children}</div></details>;
}

export function ScannerLeg({ quote, name, side, now }: { quote: PerpetualQuote; name: string; side: "long" | "short"; now: number }) {
  const delistingAt = quote.delistingAt;
  const notice = quote.delisting ? delistingAt && Number.isFinite(delistingAt) ? `${now >= delistingAt ? "已到下架时间" : "即将下架"}：${dateFormat.format(delistingAt)} 北京时间` : "即将下架，时间待公布" : "";
  return <div className={`scanner-leg perp-${side}`}>
    <span className={`scanner-side ${side}`} title={side === "long" ? "做多 · 买入" : "做空 · 卖出"}>{side === "long" ? "多" : "空"}</span>
    <span className="scanner-venue-mark" data-exchange={quote.exchange} aria-hidden="true">{exchangeMarks[quote.exchange] ?? name.slice(0, 2)}</span>
    <strong>{name}</strong><small className="scanner-symbol" title={quote.symbol}>{quote.symbol}</small>
    {notice ? <span className="scanner-delisting" title={notice}>下架<small>{notice}</small></span> : null}
  </div>;
}

export function ScannerFundingRate({ quote, now }: { quote: PerpetualQuote; now: number }) {
  const valid = normalizedFunding8h(quote, now) !== null;
  const rate = valid ? quote.fundingRate! * 100 : null;
  const next = quote.nextFundingAt;
  const remaining = next && Number.isFinite(next) && next > now ? Math.ceil((next - now) / 60_000) : null;
  const until = remaining === null ? "待更新" : remaining >= 60 ? `${Math.floor(remaining / 60)}h${String(remaining % 60).padStart(2, "0")}m` : `${remaining}m`;
  return <div className="scanner-funding-rate">
    <span className={`scanner-value ${scannerPolarity(rate)}`} title={valid ? "当前资金费率，按交易所原周期" : "资金费缺失或超过 5 分钟未更新"}>{scannerPercent(rate)}</span>
    <small>{quote.fundingIntervalHours && Number.isFinite(quote.fundingIntervalHours) ? `${quote.fundingIntervalHours}h` : "—"}</small>
    <time dateTime={remaining === null ? undefined : new Date(next!).toISOString()} title={remaining === null ? "下次结算时间待更新" : `下次结算 ${dateFormat.format(next!)} 北京时间`}>{until}</time>
  </div>;
}
