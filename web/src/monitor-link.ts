// M-5c: the pair-chart link (the workbench's chart URL, ?monitor=perpetual&perpView=chart…) next to this page's hash route
// (#/monitor). The workbench keeps ?monitor= as its hub tab; here the tab is saved locally, so the parameter only marks a
// chart link: it opens its market over the saved tab, and is dropped with the chart parameters when the chart is left or
// another market is chosen. The hash is kept as it is.
export const MONITOR_LINK_PARAMS = ['monitor', 'perpView', 'chartBase', 'chartLong', 'chartShort', 'chartDays'] as const;

/** The market a link names (?monitor=), or null. */
export function linkedMonitorTab(href: string): string | null {
  try { return new URL(href).searchParams.get('monitor'); } catch { return null; }
}

/** `href` without the chart link's parameters; other parameters and the hash stay. */
export function withoutMonitorLink(href: string): string {
  const url = new URL(href);
  for (const key of MONITOR_LINK_PARAMS) url.searchParams.delete(key);
  return url.href;
}
