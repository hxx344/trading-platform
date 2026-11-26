import { useRef, useState } from 'react';
import { exportPreferences, importPreferences, preferenceBackupLimit, previewPreferences, workbenchPreferenceScript, type PreferenceChange } from './perpetual-preferences-transfer.ts';
import './perpetual-preferences-transfer.css';

export default function PerpetualPreferencesTransfer() {
  const [text, setText] = useState(''), [changes, setChanges] = useState<PreferenceChange[] | null>(null);
  const [replace, setReplace] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [backup, setBackup] = useState('');
  const exported = useRef<HTMLTextAreaElement>(null), command = useRef<HTMLTextAreaElement>(null);
  function clear() { setError(''); setMessage(''); }
  function input(value: string) { setText(value); setChanges(null); setReplace(false); clear(); }
  function preview() {
    clear(); setReplace(false);
    try { setChanges(previewPreferences(text, localStorage)); }
    catch (cause) { setChanges(null); setError(cause instanceof Error ? cause.message : '偏好读取失败'); }
  }
  function apply() {
    if (!changes) return;
    clear();
    try {
      const written = importPreferences(changes, replace, localStorage);
      for (const item of written) window.dispatchEvent(new StorageEvent('storage', { key: item.key, oldValue: item.before, newValue: item.after, storageArea: localStorage }));
      setMessage(`已导入 ${written.length} 项偏好，本页已生效。`); setChanges(null); setText(''); setReplace(false);
    } catch (cause) { setChanges(null); setError(cause instanceof Error ? cause.message : '浏览器未能保存偏好，请重新预览'); }
  }
  function exportLocal() {
    clear();
    try { setBackup(exportPreferences(localStorage)); } catch (cause) { setBackup(''); setError(cause instanceof Error ? cause.message : '浏览器存储不可用'); }
  }
  async function copy(value: string, field: HTMLTextAreaElement | null) {
    clear();
    try { await navigator.clipboard.writeText(value); setMessage('已复制'); }
    catch { field?.focus(); field?.select(); setMessage('文本已选中，可按 Ctrl+C 或使用系统复制。'); }
  }
  const conflicts = changes?.filter(item => !item.same && item.before !== null).length ?? 0;
  const count = changes?.filter(item => !item.same && (item.before === null || replace)).length ?? 0;
  return <details className="perp-preference-transfer">
    <summary>迁移浏览器偏好</summary>
    <details><summary>从原工作台复制偏好</summary>
      <p>在原工作台打开「合约价差」，按 F12 打开 Chrome 或 Edge 的控制台。若页面嵌在工作台内，选择行情监控所在的执行上下文。执行下面的语句后，返回此处粘贴备份。</p>
      <textarea aria-label="旧工作台导出语句" ref={command} readOnly rows={4} value={workbenchPreferenceScript}/>
      <button type="button" onClick={() => void copy(workbenchPreferenceScript, command.current)}>复制导出语句</button>
    </details>
    <label>偏好备份<textarea aria-label="偏好备份" rows={3} value={text} maxLength={preferenceBackupLimit} onChange={event => input(event.target.value)} placeholder="粘贴合约价差偏好的 JSON 备份"/></label>
    <div className="perp-preference-buttons"><button type="button" disabled={!text.trim()} onClick={preview}>预览导入</button><button type="button" onClick={exportLocal}>导出本站偏好</button></div>
    {changes ? <div><ul>{changes.map(item => <li key={item.key}>{item.label} · {item.same ? '相同' : item.before === null ? '新增' : '本站已有不同设置'}</li>)}</ul>
      {conflicts > 0 ? <label><input type="checkbox" checked={replace} onChange={event => setReplace(event.target.checked)}/>覆盖这 {conflicts} 项本站已有的设置</label> : null}
      <button type="button" disabled={!count} onClick={apply}>导入 {count} 项偏好</button>
    </div> : null}
    {backup ? <div><label>本站偏好备份<textarea aria-label="本站偏好备份" ref={exported} readOnly rows={3} value={backup}/></label><button type="button" onClick={() => void copy(backup, exported.current)}>复制本站备份</button></div> : null}
    {message ? <p role="status">{message}</p> : null}{error ? <p role="alert">{error}</p> : null}
  </details>;
}
