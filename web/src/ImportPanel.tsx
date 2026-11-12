import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

// The workbench import: the page leaves a request, a root helper on the host answers it (and restarts this service
// for an import); the answer is polled by request id, and polling carries on while the service restarts.
// The helper waits up to 100 s for a running install.sh and drops requests older than 2 minutes; an import that fails
// on start puts the files back and restarts again, all within its 12-minute limit.
const IMPORT_WAIT_MS = 760_000, IMPORT_PICKUP_MS = 135_000, IMPORT_SLOW_MS = 10_000;

interface PreviewItem { id: string; name?: string; marginEnabled: boolean; importable: boolean; detail: string }
interface ImportedItem { id: string; status: string; detail: string }
interface ImportResult {
  id: string | null; action: 'preview' | 'import' | null; at: number; phase?: string; message: string;
  preview?: PreviewItem[]; imported?: ImportedItem[]; notes?: string[]; database?: string;
}
type Message = { tone: 'ok' | 'err' | 'muted'; text: string } | null;

function Results({ result, picked, setPicked, onRun, busy }: { result: ImportResult; picked: Set<string>; setPicked: (value: Set<string>) => void; onRun: () => void; busy: boolean }) {
  const notes = (result.notes || []).map((note, index) => <p key={index} className="muted">{note}</p>);
  if (result.action === 'preview') {
    const rows = result.preview || [];
    return <>
      {rows.length ? <>
        <div className="table-wrap"><table className="data">
          <thead><tr><th></th><th>工作台配对</th><th>工作台保证金平衡</th><th>说明</th></tr></thead>
          <tbody>{rows.map(item => <tr key={item.id}>
            <td><input type="checkbox" data-import-pick={item.id} disabled={!item.importable} checked={picked.has(item.id)} onChange={event => {
              const next = new Set(picked);
              if (event.target.checked) next.add(item.id); else next.delete(item.id);
              setPicked(next);
            }} /></td>
            <td>{item.id}{item.name ? <><br /><span className="muted">{item.name}</span></> : null}</td>
            <td>{item.marginEnabled ? '已开启' : '未开启'}</td>
            <td className={item.importable ? 'ok' : 'muted'}>{item.importable ? '可导入：' : '不能导入：'}{item.detail}</td>
          </tr>)}</tbody>
        </table></div>
        <p><button type="button" id="importRunBtn" className="button primary" disabled={busy} onClick={onRun}>导入所选并重启服务</button></p>
      </> : null}
      {notes}
      {result.database ? <p className="muted">读取自 {result.database}（只读）</p> : null}
    </>;
  }
  const rows = result.imported || [];
  return <>
    {rows.length ? <div className="table-wrap"><table className="data">
      <thead><tr><th>配对</th><th>结果</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.id}><td>{item.id}</td><td className={item.status === 'added' ? 'ok' : 'err'}>{item.status === 'added' ? '已导入：' : '未导入：'}{item.detail}</td></tr>)}</tbody>
    </table></div> : null}
    {notes}
  </>;
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const statusOf = (error: unknown): number | undefined => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
};

/** Shown only where the service offers it (the ASTER service with the helper's directory); elsewhere the route is 404. */
export function ImportPanel({ onImported }: { onImported: () => void }) {
  const [offered, setOffered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const waiting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    api('/api/import').then(() => { if (mounted.current) setOffered(true); }).catch(() => {});
    return () => { mounted.current = false; };
  }, []);

  const show = (next: ImportResult) => {
    setResult(next);
    // Like the earlier page: the pairs with margin balance on are picked by default.
    if (next.action === 'preview') setPicked(new Set((next.preview || []).filter(item => item.importable && item.marginEnabled).map(item => item.id)));
  };

  async function request(body: { action: 'preview' } | { action: 'import'; pairs: string[] }, text: string): Promise<void> {
    if (waiting.current) return;
    waiting.current = true; setBusy(true);
    const started = Date.now();
    try {
      const { id, at } = await api<{ id?: unknown; at?: unknown }>('/api/import', { body });
      if (typeof id !== 'string' || typeof at !== 'number') throw new Error('请求已发出但应答无法解析，结果未知：请稍后点「读取工作台」核对');
      setMessage({ tone: 'muted', text: `${text}…` });
      let found = false, restarting = false;
      while (Date.now() - started < IMPORT_WAIT_MS) {
        await pause(1000);
        if (!mounted.current) return;
        let latest: ImportResult | null;
        try { latest = (await api<{ result: ImportResult | null }>('/api/import')).result; }
        catch (error) {
          const status = statusOf(error);
          if (status === 401) throw new Error('会话已失效（服务重启时更换了会话），请刷新页面重新登录（或用数据目录 access-url 里的登录链接）；导入结果可稍后点「读取工作台」核对');
          if (restarting || status === undefined || status >= 500) { setMessage({ tone: 'muted', text: '服务重启中…' }); continue; }
          throw error;
        }
        // An unreadable request is answered without an id; notices about an earlier, interrupted import carry that one's id.
        if (!found && latest && latest.id === null && latest.action === null && latest.at >= at) throw new Error(latest.message);
        if (!latest || latest.id !== id) {
          if (found) continue;
          if (Date.now() - started > IMPORT_PICKUP_MS) throw new Error('导入助手没有响应，请求已作废：请确认已用 sudo bash install.sh 安装本版本（systemctl status trading-platform-import.path）');
          if (Date.now() - started > IMPORT_SLOW_MS) setMessage({ tone: 'muted', text: `${text}…（等待导入助手接手；安装脚本正在运行时最多等 2 分钟）` });
          continue;
        }
        found = true;
        if (latest.phase === 'running' || latest.phase === 'restarting') {
          restarting = latest.phase === 'restarting';
          setMessage({ tone: 'muted', text: `${latest.message}…` });
          if (restarting) show(latest);
          continue;
        }
        setMessage({ tone: latest.phase === 'done' ? 'ok' : 'err', text: latest.message });
        show(latest);
        if (latest.action === 'import') onImported();
        return;
      }
      throw new Error('等待超时：结果未知，请稍后点「读取工作台」查看配置是否已导入');
    } catch (error) {
      if (mounted.current) setMessage({ tone: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      waiting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const run = () => {
    const pairs = (result?.preview || []).filter(item => item.importable && picked.has(item.id)).map(item => item.id);
    if (!pairs.length) { alert('请先勾选要导入的配对'); return; }
    if (!confirm(`导入 ${pairs.join('、')} 并重启本服务？重启约半分钟，期间已启用配对的划转与 ADL 暂停。导入的配对登记为停用。`)) return;
    void request({ action: 'import', pairs }, '正在导入');
  };

  if (!offered) return null;
  return <section className="panel" id="importBox">
    <div className="panel-heading"><h2><Download size={16} aria-hidden="true" />从工作台导入配对</h2></div>
    <div className="panel-body">
      <p className="muted">读取本机旧工作台的保证金平衡配对：划转设置、ADL 设置、主账户与子账户凭据、飞书机器人，写入本服务配置后自动重启本服务（约半分钟，期间已启用配对的划转与 ADL 暂停）。导入的配对登记为停用：先在旧工作台删除该配对，再到下方「启用」。</p>
      <div className="toolbar">
        <button type="button" id="importPreviewBtn" className="button secondary" disabled={busy} onClick={() => void request({ action: 'preview' }, '正在读取工作台')}>读取工作台</button>
        {message ? <span className={message.tone} role="status">{message.text}</span> : null}
      </div>
      {result ? <Results result={result} picked={picked} setPicked={setPicked} onRun={run} busy={busy} /> : null}
    </div>
  </section>;
}
