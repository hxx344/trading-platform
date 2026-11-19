// 只读接口令牌 (docs/mcp.md): generate, revoke, the token's dates and use, and the alias lookup. The workbench has no such
// panel; it is put together from the settings page's own parts (panel, section-head, settings form, Callout).
import { useState } from 'react';
import { api } from './api.ts';
import { stamp } from './labels.ts';
import { Callout } from './StateViews.tsx';
import { expiryNotice, parseAlias, setupCommands, type ReadTokenView } from './read-token-form.ts';
import type { LiveResource } from './use-live-resource.ts';

type Message = { tone: 'ok' | 'err'; text: string } | null;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const STATE_TEXT: Record<ReadTokenView['state'], string> = { none: '未生成', active: '有效', expired: '已到期' };

export function ReadTokenSettings({ resource }: { resource: LiveResource<ReadTokenView> }) {
  const view = resource.data;
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [alias, setAlias] = useState('');
  const [found, setFound] = useState<Message>(null);
  if (!view) return null;
  const notice = expiryNotice(view, Date.now());
  const act = async (path: '/api/read-token/generate' | '/api/read-token/revoke') => {
    const replacing = view.state !== 'none';
    const question = path.endsWith('revoke') ? '吊销后令牌立即失效，MCP 客户端将无法读取。确定吊销？'
      : replacing ? '重新生成会让当前令牌立即失效，别名也会全部改变。确定重新生成？' : null;
    if (question && !window.confirm(question)) return;
    setBusy(true); setMessage(null); setIssued(null); setCopied(false);
    try {
      if (path.endsWith('generate')) {
        const { token } = await api<{ token: string }>(path, { body: {} });
        setIssued(token);
        setMessage({ tone: 'ok', text: '已生成。令牌只显示这一次，请现在保存到客户端电脑上。' });
      } else {
        await api(path, { body: {} });
        setMessage({ tone: 'ok', text: '已吊销，令牌立即失效。' });
      }
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); void resource.refresh(); }
  };
  const lookup = async () => {
    const value = parseAlias(alias);
    if (!value) { setFound({ tone: 'err', text: '别名格式应为 acct-、addr- 或 tx- 加 8 位十六进制，如 addr-1a2b3c4d' }); return; }
    setFound(null);
    try {
      const { original } = await api<{ original: string | null }>('/api/read-token/lookup', { body: { alias: value } });
      setFound(original === null ? { tone: 'err', text: '没有找到：别名只对当前令牌有效，换过令牌后旧别名失效' } : { tone: 'ok', text: original });
    } catch (error) { setFound({ tone: 'err', text: errorText(error) }); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(issued ?? ''); setCopied(true); }
    catch { setMessage({ tone: 'err', text: '无法写入剪贴板，请手动选中复制' }); }
  };
  return <section className="panel" aria-label="只读接口令牌" data-read-token>
    <div className="section-head"><h2>只读接口令牌</h2><span className="small-note">供 MCP 客户端只读访问，90 天有效</span></div>
    <div className="execution-live-state form-stack">
      {view.error ? <Callout tone="error">令牌文件无法读取，当前不接受任何令牌：{view.error}。重新生成即可替换。</Callout> : null}
      {notice ? <Callout tone="warning">{notice}</Callout> : null}
      <dl className="execution-review-settings" data-read-token-view>
        <div><dt>状态</dt><dd>{STATE_TEXT[view.state]}{view.id ? ` · 编号 ${view.id}` : ''}</dd></div>
        <div><dt>生成时间</dt><dd>{stamp(view.createdAt)}</dd></div>
        <div><dt>到期时间</dt><dd>{stamp(view.expiresAt)}</dd></div>
        <div><dt>最近使用 · 近 24 小时请求</dt><dd>{stamp(view.lastUsedAt)} · {view.requests24h} 次</dd></div>
      </dl>
      <p className="muted">令牌只能读取运行状态、日志与各模块记录（不含资产账本），不能下单、划转或改设置；应答里的账户与地址在服务器上替换为别名。每次使用都记入「日志」。</p>
      {issued ? <div className="form-stack" data-read-token-issued>
        <Callout tone="warning">令牌只显示这一次，离开或刷新页面后无法再看到。</Callout>
        <label htmlFor="read-token-value">令牌<input id="read-token-value" data-slot="input" type="text" readOnly value={issued} onFocus={event => event.currentTarget.select()} /></label>
        <p className="muted">在运行 Claude Code 的电脑上执行（地址用本页的访问地址）：</p>
        <pre className="read-token-commands">{setupCommands(window.location.origin)}</pre>
      </div> : null}
      {message?.tone === 'err' ? <p className="message message-error" role="alert">{message.text}</p> : null}
      <div className="form-actions">
        <button type="button" className="button primary" data-slot="button" data-read-token-generate disabled={busy} onClick={() => void act('/api/read-token/generate')}>{view.state === 'none' ? '生成令牌' : '重新生成'}</button>
        {issued ? <button type="button" className="button secondary" data-slot="button" onClick={() => void copy()}>{copied ? '已复制' : '复制令牌'}</button> : null}
        {view.state !== 'none' ? <button type="button" className="button secondary" data-slot="button" data-read-token-revoke disabled={busy} onClick={() => void act('/api/read-token/revoke')}>吊销</button> : null}
        {message?.tone === 'ok' ? <span className="mint" role="status">{message.text}</span> : null}
      </div>
      <form className="pair-settings-form" onSubmit={event => { event.preventDefault(); void lookup(); }}>
        <fieldset className="settings-form-grid">
          <legend>别名查询</legend>
          <label htmlFor="read-token-alias">别名 <span>查回原账户或地址，只在登录后的页面可用</span>
            <input id="read-token-alias" data-slot="input" type="text" placeholder="addr-1a2b3c4d" value={alias} onChange={event => { setAlias(event.target.value); setFound(null); }} data-read-token-alias />
          </label>
        </fieldset>
        <div className="form-actions">
          <button type="submit" className="button secondary" data-slot="button" disabled={!alias.trim()}>查询</button>
          {found ? <span className={found.tone === 'ok' ? 'read-token-original' : 'amber'} role="status" data-read-token-found>{found.text}</span> : null}
        </div>
      </form>
    </div>
  </section>;
}
