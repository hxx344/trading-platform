import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from './api.ts';
import { utc } from './MonitorFundingHistory.tsx';
import { SESSION_STATUS_LABELS, VARIATIONAL_SESSION_ENDPOINT, parseSessionView, saveFailure, shownStatus, type SessionView } from './monitor-variational.ts';

// The Var token form under the Variational row (M-3d-1), laid out as the workbench's modules/monitor/app/variational-session.tsx
// (8470785). Changed: times are UTC like the rest of this page; reads and the save go through api() (the save is a POST with
// the page request header); a 401 hands over to the login page. The token stays in the password field only: never in
// React state, browser storage or the URL, and the field is cleared after a save and when the form closes.
type Props = { id: string; now: number; onClose: () => void; onSaved: () => void; onExpired: () => void };

export function VariationalSessionForm({ id, now, onClose, onSaved, onExpired }: Props) {
  const [view, setView] = useState<SessionView | null>(null);
  const [busy, setBusy] = useState<'loading' | 'saving' | null>('loading');
  const [hasToken, setHasToken] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const pending = useRef<AbortController | null>(null);

  async function run(kind: 'loading' | 'saving', body?: unknown) {
    const controller = new AbortController(); pending.current = controller;
    setBusy(kind); setError(''); setSuccess(false);
    try {
      const data = parseSessionView(await api<unknown>(VARIATIONAL_SESSION_ENDPOINT, { signal: controller.signal, timeoutMs: kind === 'saving' ? 20_000 : 12_000, ...(body === undefined ? {} : { body }) }));
      if (controller.signal.aborted) return;
      if (kind === 'saving') {
        if (!data.available || !data.configured) throw new Error('保存结果未确认');
        setSuccess(true); setHasToken(false);
        if (input.current) input.current.value = '';
        onSaved();
      }
      setView(data); setNeedsReload(false);
    } catch (reason) {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) { onExpired(); return; }
      if (kind === 'loading') { setError('配置读取失败，请刷新配置后重试。'); setNeedsReload(true); return; }
      const failure = saveFailure(reason);
      setError(failure.message);
      if (failure.reload) setNeedsReload(true);
    } finally {
      if (!controller.signal.aborted && pending.current === controller) { pending.current = null; setBusy(null); }
    }
  }

  useEffect(() => {
    const field = input.current;
    void run('loading');
    const hide = () => { if (document.hidden) onClose(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      pending.current?.abort(); pending.current = null;
      if (field) field.value = '';
      document.removeEventListener('visibilitychange', hide);
    };
    // Read once when the form opens; run() only sets this form's state.
  }, [onClose]);

  const reload = () => { if (!pending.current && !document.hidden) void run('loading'); };
  const save = () => {
    if (pending.current || document.hidden || !view?.available || needsReload) return;
    const token = input.current?.value.trim() ?? '';
    if (!token) { setError('请填写 Cookie 中 vr-token 的值。'); input.current?.focus(); return; }
    void run('saving', { token, revision: view.revision });
  };

  const status = view ? shownStatus(view, now) : null;
  return <section id={id} className="variational-session" aria-labelledby={`${id}-heading`}>
    <div className="variational-session-heading"><div><h3 id={`${id}-heading`}>更新 Var token</h3><p id={`${id}-help`}>公开价格和资金费无需 token。需要认证报价时，可从已登录 Variational 的浏览器 Cookie 复制 vr-token 的值，不要粘贴整段 Cookie。</p></div><button type="button" className="variational-session-close" onClick={onClose} aria-label="收起 Var token 表单">收起</button></div>
    <div className="variational-session-status" aria-live="polite">
      {view && status ? <><p>{view.available ? SESSION_STATUS_LABELS[status] : '当前环境无法更新会话'}</p>{view.configured ? <p>{view.expiresAt ? `token 声明到期时间：${utc(view.expiresAt)}` : '到期时间未知'}{view.updatedAt ? `；最近保存：${utc(view.updatedAt)}` : ''}</p> : null}{view.error ? <p className="variational-session-warning">{view.error}</p> : null}</> : <p>{busy === 'loading' ? '正在读取配置…' : '尚未读取配置'}</p>}
    </div>
    <form className="variational-session-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <label htmlFor={`${id}-token`}>新的 vr-token</label>
      <div className="variational-session-fields"><input ref={input} id={`${id}-token`} name="variational-session-token" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={8192} required aria-describedby={`${id}-help`} disabled={busy !== null || !view?.available} onChange={event => { setHasToken(Boolean(event.currentTarget.value.trim())); setSuccess(false); }} /><button type="submit" disabled={busy !== null || !view?.available || !hasToken || needsReload}>{busy === 'saving' ? '保存中…' : '保存 token'}</button><button type="button" className="variational-session-reload" disabled={busy !== null} onClick={reload}>{busy === 'loading' ? '读取中…' : '刷新配置'}</button></div>
    </form>
    {error ? <p className="variational-session-warning" role="alert">{error}</p> : null}
    {success ? <p className="variational-session-success" role="status">已保存，后台会在下一轮采集时自动使用，通常在 15 秒内更新，无需重启。</p> : null}
  </section>;
}
