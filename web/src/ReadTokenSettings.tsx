// 只读接口令牌 (docs/mcp.md 8.4): the list of tokens (name, scopes, dates, use), generating one with a name and scopes,
// revoking each, and the alias lookup. The workbench has no such panel; it is put together from the settings page's own
// parts (panel, section-head, settings form, data table, Callout).
import { useState } from 'react';
import { api } from './api.ts';
import { stamp } from './labels.ts';
import { Callout } from './StateViews.tsx';
import { expiryNotice, generateBody, parseAlias, READ_SCOPE_TEXT, READ_SCOPES, scopeText, setupCommands, type ReadScope, type ReadTokenView } from './read-token-form.ts';
import type { LiveResource } from './use-live-resource.ts';

type Message = { tone: 'ok' | 'err'; text: string } | null;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function ReadTokenSettings({ resource }: { resource: LiveResource<ReadTokenView> }) {
  const view = resource.data;
  const [issued, setIssued] = useState<{ id: string; name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ReadonlySet<ReadScope>>(new Set(READ_SCOPES));
  const [alias, setAlias] = useState('');
  const [found, setFound] = useState<Message>(null);
  if (!view) return null;
  const now = Date.now();
  const notice = expiryNotice(view, now);
  const full = view.tokens.length >= view.max;
  const generate = async () => {
    const request = generateBody(name, scopes, view);
    if ('error' in request) { setMessage({ tone: 'err', text: request.error }); return; }
    setBusy(true); setMessage(null); setIssued(null); setCopied(false);
    try {
      const { token, id } = await api<{ token: string; id: string }>('/api/read-token/generate', { body: request.body });
      setIssued({ id, name: request.body.name, token });
      setName('');
      setMessage({ tone: 'ok', text: '已生成。令牌只显示这一次，请现在保存到客户端电脑上。' });
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); void resource.refresh(); }
  };
  const revoke = async (id: string, label: string) => {
    if (!window.confirm(`吊销「${label}」后它立即失效，用它的 MCP 客户端将无法读取。确定吊销？`)) return;
    setBusy(true); setMessage(null);
    try {
      await api('/api/read-token/revoke', { body: { id } });
      if (issued?.id === id) setIssued(null);
      setMessage({ tone: 'ok', text: `已吊销「${label}」，立即失效。` });
    } catch (error) { setMessage({ tone: 'err', text: errorText(error) }); }
    finally { setBusy(false); void resource.refresh(); }
  };
  const toggle = (scope: ReadScope, on: boolean) => {
    const next = new Set(scopes);
    if (on) next.add(scope); else next.delete(scope);
    setScopes(next);
  };
  const lookup = async () => {
    const value = parseAlias(alias);
    if (!value) { setFound({ tone: 'err', text: '别名格式应为 acct-、addr- 或 tx- 加 8 位十六进制，如 addr-1a2b3c4d' }); return; }
    setFound(null);
    try {
      const { original } = await api<{ original: string | null }>('/api/read-token/lookup', { body: { alias: value } });
      setFound(original === null ? { tone: 'err', text: '没有找到：全部令牌吊销后别名随之失效' } : { tone: 'ok', text: original });
    } catch (error) { setFound({ tone: 'err', text: errorText(error) }); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(issued?.token ?? ''); setCopied(true); }
    catch { setMessage({ tone: 'err', text: '无法写入剪贴板，请手动选中复制' }); }
  };
  return <section className="panel" aria-label="只读接口令牌" data-read-token>
    <div className="section-head"><h2>只读接口令牌</h2><span className="small-note">供 MCP 客户端只读访问，90 天有效，最多 {view.max} 个</span></div>
    <div className="execution-live-state form-stack">
      {view.error ? <Callout tone="error">令牌文件无法读取，当前不接受任何令牌：{view.error}。生成新令牌即可替换。</Callout> : null}
      {notice ? <Callout tone="warning">{notice}</Callout> : null}
      {view.tokens.length ? <div className="table-wrap"><table className="data" data-read-token-list>
        <thead><tr><th>名称 · 编号</th><th>范围</th><th>状态</th><th>生成 · 到期</th><th>最近使用 · 近 24 小时</th><th></th></tr></thead>
        <tbody>{view.tokens.map(token => {
          const expired = token.state === 'expired' || now >= token.expiresAt;
          return <tr key={token.id} data-read-token-row={token.id}>
            <td>{token.name}<br /><span className="muted">{token.id}</span></td>
            <td>{scopeText(token.scopes)}</td>
            <td className={expired ? 'amber' : token.warn ? 'amber' : 'ok'}>{expired ? '已到期' : token.warn ? '即将到期' : '有效'}</td>
            <td>{stamp(token.createdAt)}<br /><span className="muted">{stamp(token.expiresAt)}</span></td>
            <td>{stamp(token.lastUsedAt)}<br /><span className="muted">{token.requests24h} 次</span></td>
            <td><button type="button" className="button secondary" data-slot="button" data-read-token-revoke={token.id} disabled={busy} onClick={() => void revoke(token.id, token.name)}>吊销</button></td>
          </tr>;
        })}</tbody>
      </table></div> : <p className="muted" data-read-token-empty>还没有令牌。</p>}
      <p className="muted">令牌只能读取所选范围内的接口，不含资产账本，不能下单、划转或改设置；应答里的账户与地址在服务器上替换为别名，所有令牌的别名一致。每次使用都记入「日志」。要改范围就生成新令牌，再吊销旧的。</p>
      {issued ? <div className="form-stack" data-read-token-issued>
        <Callout tone="warning">「{issued.name}」的令牌只显示这一次，离开或刷新页面后无法再看到。</Callout>
        <label htmlFor="read-token-value">令牌<input id="read-token-value" data-slot="input" type="text" readOnly value={issued.token} onFocus={event => event.currentTarget.select()} /></label>
        <p className="muted">在运行 Claude Code 的电脑上执行（地址用本页的访问地址）：</p>
        <pre className="read-token-commands">{setupCommands(window.location.origin)}</pre>
        <div className="form-actions"><button type="button" className="button secondary" data-slot="button" onClick={() => void copy()}>{copied ? '已复制' : '复制令牌'}</button></div>
      </div> : null}
      <form className="pair-settings-form" onSubmit={event => { event.preventDefault(); void generate(); }} data-read-token-form>
        <fieldset className="settings-form-grid">
          <legend>生成令牌</legend>
          <label htmlFor="read-token-name">名称 <span>1–40 个字，用来区分客户端</span>
            <input id="read-token-name" data-slot="input" type="text" maxLength={40} placeholder="本机 Claude Code" value={name} onChange={event => setName(event.target.value)} data-read-token-name />
          </label>
          <div className="read-token-scopes" role="group" aria-label="范围">
            {READ_SCOPES.map(scope => <label key={scope} className="checkbox-label"><input type="checkbox" checked={scopes.has(scope)} onChange={event => toggle(scope, event.target.checked)} data-read-token-scope={scope} />{READ_SCOPE_TEXT[scope].name}<span className="muted">{READ_SCOPE_TEXT[scope].detail}</span></label>)}
          </div>
        </fieldset>
        {message?.tone === 'err' ? <p className="message message-error" role="alert">{message.text}</p> : null}
        <div className="form-actions">
          <button type="submit" className="button primary" data-slot="button" data-read-token-generate disabled={busy || full}>生成令牌</button>
          {full ? <span className="amber">已有 {view.max} 个令牌，请先吊销不用的</span> : null}
          {message?.tone === 'ok' ? <span className="mint" role="status">{message.text}</span> : null}
        </div>
      </form>
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
