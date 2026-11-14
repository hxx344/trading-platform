// The Var token form's data rules (MonitorVariationalSession.tsx, M-3d-1), copied from the project-aggregation workbench's
// modules/monitor/app/variational-session.tsx (8470785): the status labels, the answer check (parseView) and the status the
// form shows, which counts a token past its declared expiry as expired before the service's next read says so.
// Changed: the save goes through api() (POST with the page request header instead of PUT); a refused save keeps the
// service's message, an answer without the service's code counts as unknown; a 409 asks for a reload like the workbench.
import { ApiError } from './api.ts';

export const VARIATIONAL_SESSION_ENDPOINT = '/api/monitor/oil/exchanges/variational/session';
export type SessionStatus = 'missing' | 'ready' | 'expired' | 'rejected' | 'unavailable';
export type SessionView = { available: boolean; configured: boolean; revision: number; expiresAt: string | null; updatedAt: string | null; status: SessionStatus; error: string };

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = { missing: '尚未配置', ready: '已配置 · 有效性以后台采集结果为准', expired: '已过期，请更新 token', rejected: '会话已失效，请更新 token', unavailable: '认证行情暂不可用' };

export function parseSessionView(value: unknown): SessionView {
  const data = value as Partial<SessionView> | null;
  const date = (input: unknown) => input === null || (typeof input === 'string' && Number.isFinite(Date.parse(input)));
  if (!data || typeof data !== 'object' || typeof data.available !== 'boolean' || typeof data.configured !== 'boolean' || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 || !date(data.expiresAt) || !date(data.updatedAt) || typeof data.status !== 'string' || !Object.hasOwn(SESSION_STATUS_LABELS, data.status) || typeof data.error !== 'string') throw new Error('配置返回格式不正确，请刷新配置。');
  return { available: data.available, configured: data.configured, revision: data.revision!, expiresAt: data.expiresAt!, updatedAt: data.updatedAt!, status: data.status, error: data.error };
}

/** The status shown: a ready token whose declared expiry has passed is shown as expired. */
export const shownStatus = (view: SessionView, now: number): SessionStatus => view.status === 'ready' && view.expiresAt && Date.parse(view.expiresAt) <= now ? 'expired' : view.status;

/** What a failed save means for the form: the text to show and whether the state must be read again before another save. */
export function saveFailure(error: unknown): { message: string; reload: boolean } {
  // The service always answers a refused save with a code; an answer without one (a gateway's 502 / 504 page) says nothing
  // about whether the save went through.
  if (error instanceof ApiError && error.code) {
    if (error.status === 409) return { message: '配置已被其他页面更新，请先刷新配置，再确认后保存。', reload: true };
    return { message: error.message || '保存失败，请稍后重试。', reload: false };
  }
  // No answer (timeout, network), a gateway's answer, or one that cannot be checked: the outcome is unknown.
  return { message: '保存结果未确认，请刷新配置后再重试。', reload: true };
}
