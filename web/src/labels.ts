// Labels and formatting shared by the panels; the wording is the earlier page's.
export const SIDE: Record<string, string> = { long: '多侧', short: '空侧' };
export const DIRECTION: Record<string, string> = { long: '多', short: '空' };
export const TRANSFER_STATE: Record<string, string> = { prepared: '已落盘', sending: '发送中', acknowledged: '已回执，待刷新余额', unknown: '结果未知，待到期结算', confirmed: '已执行', rejected: '被拒绝', 'not-sent': '未发送', 'expired-not-executed': '到期结算：未执行', 'expired-unverified': '到期结算：是否执行未能确认' };
export const ADL_STATUS: Record<string, string> = { active: '处理中', blocked: '受阻（保留现场）', halted: '已停止自动减仓', watching: '已平衡，观察未知原单', completed: '已结束' };
export const ADL_PROGRESS: Record<string, string> = { balanced: '已平衡', residual: '残差（容差内或不足一手，记为完成）', reducing: '本批减仓', pending: '待减仓', blocked: '受阻', held: '暂停', manual: '待手工平衡' };
export const ADL_BATCH: Record<string, string> = { prepared: '已落盘', sending: '发送中', open: '交易所挂单中', unknown: '结果未知，核对中', 'unknown-verified': '多次核对无回执，观察中', done: '已结束', rejected: '被拒绝', 'not-sent': '未发送', 'unknown-closed': '观察期满，结果未知' };
export const POSITION_STATE: Record<string, string> = { pending: '尚未读取', fresh: '最新', retained: '最近一次读取失败，显示上次结果', unavailable: '不可用' };

export const label = (map: Record<string, string>, key: string | null | undefined): string => (key == null ? '' : map[key] ?? key);
export const clock = (at: number | null | undefined): string => (at ? new Date(at).toLocaleTimeString() : '—');
export const seconds = (ms: number): number => Math.round(ms / 1000);
