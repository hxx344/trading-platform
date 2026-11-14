// The page CSP has no style-src 'unsafe-inline', so the workbench's style={{ width }} bars (AccountOverview meter,
// TradingTerminal depth, PositionActionDialog quantity track) are drawn as an SVG rect instead; colours stay in CSS.
export function FillBar({ percent, className, anchor = 'left' }: { percent: number | string | null | undefined; className?: string; anchor?: 'left' | 'right' }) {
  const parsed = Number(String(percent ?? 0).replace('%', ''));
  const width = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
  return <svg className={'fill-bar' + (className ? ' ' + className : '')} viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <rect x={anchor === 'right' ? 100 - width : 0} y="0" width={width} height="1"/>
  </svg>;
}
