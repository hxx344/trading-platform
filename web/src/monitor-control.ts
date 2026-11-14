// M-3c: the market run switch on the monitor page (the workbench's monitor-hub.tsx 「运行监控」). DOM-free so it can be
// tested: reading the switches out of /api/monitor/state, what the button says and the body it sends.
export type MonitorControl = { enabled: boolean; revision: number; error: string | null };
export type MonitorControls = Record<string, MonitorControl>;

/** The `controls` of /api/monitor/state; an older service without them answers null (the page then shows no switch). */
export function parseControls(raw: unknown, markets: readonly string[]): MonitorControls | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('行情监控开关格式不正确');
  const controls: MonitorControls = {};
  for (const market of markets) {
    const value = (raw as Record<string, unknown>)[market];
    if (value === undefined) continue;
    controls[market] = parseControl(value);
  }
  return controls;
}

/** One switch, as in `controls` or the answer of POST /api/monitor/<market>/control. */
export function parseControl(raw: unknown): MonitorControl {
  const value = raw as { enabled?: unknown; revision?: unknown; error?: unknown } | null;
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || (value.error !== null && value.error !== undefined && typeof value.error !== 'string')) throw new Error('行情监控开关格式不正确');
  return { enabled: value.enabled, revision: value.revision as number, error: typeof value.error === 'string' ? value.error : null };
}

/** The body that flips the switch, carrying the revision the page last read (another page's change answers 409). */
export const toggleBody = (control: MonitorControl) => ({ enabled: !control.enabled, revision: control.revision });

/** The switch's label, as the workbench words it. */
export function switchLabel(control: MonitorControl | undefined, pending: boolean, failed: boolean): string {
  if (pending) return '保存中…';
  if (failed) return '重试切换';
  if (!control) return '读取中…';
  return control.enabled ? '已开启' : '已关闭';
}

const NAMES: Record<string, string> = { anthropic: 'Anthropic', oil: '原油', hynix: '海力士', perpetual: '合约价差' };
/** Shown in place of the market's panel while it is off. Anthropic has no automatic alerts. */
export function disabledNotice(market: string): string {
  // The perpetual quotes live in memory only (M-4a): nothing is kept while it is off.
  if (market === 'perpetual') return '合约价差监控已关闭，行情采集已暂停。报价只在内存中，不保留；可通过上方开关重新开启，开启后重新采集。';
  const paused = market === 'anthropic' ? '行情采集已暂停' : '行情采集、自动告警已暂停';
  return `${NAMES[market] ?? market}监控已关闭，${paused}。配置和历史数据已保留，可通过上方开关重新开启。`;
}

/** What a failed switch says: the server's message when it answered (status set), otherwise the outcome is unknown. */
export function switchFailure(status: number | null, code: string | undefined, message: string | null): string {
  if (status === null || message === null) return '切换结果未知，已重新读取开关状态；请核对后再操作。';
  if (code === 'control_conflict') return '开关已被其他页面修改，已重新读取最新状态；请核对后再操作。';
  return message;
}
