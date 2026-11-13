// 复制自 project-aggregation 工作台 modules/aster/dashboard/lib/number-format.ts（提交 b2fae14），只取 formatNumber 与 formatPercent，未改动。
const formatters = new Map<number, Intl.NumberFormat>();

export function formatNumber(value?: string | number | null, digits = 2) {
  if (
    value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    !Number.isFinite(Number(value))
  )
    return '—';
  let formatter = formatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-US', {
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    });
    formatters.set(digits, formatter);
  }
  return formatter.format(Number(value));
}


export function formatPercent(value?: string | number | null) {
  if (formatNumber(value) === '—') return '—';
  const percent = formatNumber(Number(value) * 100);
  return percent === '—' ? '—' : `${percent}%`;
}
