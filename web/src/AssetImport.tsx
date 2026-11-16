// The workbook import panel (A-6). Copied from project_aggregation modules/asset/app/import-ledger-dialog.tsx at 7745181
// (texts, summary lines, buttons and the 5 MB check are the workbench's). Changes:
// - a panel opened in place under the example-data notice instead of a dialog (this page's dialogs are all panels);
// - the requests go through the page writer (AssetPage.tsx useWriter), so no other write or sync runs meanwhile, and
//   the answer, the conflicts and a lost session are handled as for the other writes; the toasts are its status line;
// - apply sends the fingerprint the preview returned, and the server refuses a file that differs from the previewed one;
// - the help text also says where the JSON file comes from (scripts/import-workbook.py in the install directory).
import { useEffect, useRef, useState } from 'react';
import type { ImportReply, ImportSummary } from '../../src/asset/views.ts';
import { money } from './asset-format.ts';
import type { Writer } from './AssetPage.tsx';

export const IMPORT_PATH = '/api/asset/import';
/** The workbench's limit (lib/source-ledger.ts IMPORT_MAX_BYTES); the server refuses a larger body too. */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Where install.sh puts the converter (its default APP_DIR) and how it is run; the service never runs it. */
export const IMPORT_SCRIPT_PATH = '/opt/trading-platform/current/scripts/import-workbook.py';
export const IMPORT_SCRIPT = 'python3 import-workbook.py 资产统计.xlsx';

/** What the workbench's preview() shows for a file it cannot use, before anything is sent. */
export async function readImportFile(file: File): Promise<unknown> {
  if (file.size > IMPORT_MAX_BYTES) throw new Error('导入文件不能超过 5 MB');
  try { return JSON.parse(await file.text()) as unknown; }
  catch (cause) { throw cause instanceof SyntaxError ? new Error('请选择从原表生成的 JSON 导入文件') : new Error('无法读取导入文件'); }
}

/** The workbench's summary block. */
export function summaryLines(summary: ImportSummary): string[] {
  return [
    `${summary.rows} 条资产 · ${summary.periods} 期原表记录`, `起始持仓：${summary.baselineDate}`, `原表合计：$ ${money(summary.baselineTotal)}`,
    `导入后共 ${summary.resultingRows} 条资产`, ...(summary.retained.length ? ['保留：' + summary.retained.join('、')] : []),
  ];
}

export function ImportPanel({ writer, onClose }: { writer: Writer; onClose: () => void }) {
  const [source, setSource] = useState<unknown>(), [preview, setPreview] = useState<{ summary: ImportSummary; fingerprint: string } | null>(null);
  const [fileError, setFileError] = useState('');
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }); }, []);
  async function choose(file?: File) {
    setSource(undefined); setPreview(null); setFileError(''); writer.clear();
    if (!file) return;
    let data: unknown;
    try { data = await readImportFile(file); } catch (cause) { setFileError((cause as Error).message); return; }
    await writer.run<Partial<ImportReply>>(IMPORT_PATH, { source: data, apply: false }, reply => {
      if (reply.preview === true && reply.summary && reply.fingerprint) { setSource(data); setPreview({ summary: reply.summary, fingerprint: reply.fingerprint }); return; }
      // The same file was imported before: the workbench closes the dialog and keeps the ledger as it is.
      if (reply.preview === false) { onClose(); return; }
      setFileError('未收到预览结果，请重新选择文件');
    }, { preview: true, saved: () => '这份原表已导入，保留当前修改' });
  }
  // An answer without the result (api.ts answers {}): the ledger is read again and the workbench's message says to check it.
  const apply = () => { if (preview) void writer.run<Partial<ImportReply>>(IMPORT_PATH, { source, apply: true, fingerprint: preview.fingerprint }, onClose, { saved: reply => reply.preview === false ? '原表已导入，旧数据已自动备份' : '未收到导入结果，请重新打开账本核实' }); };
  const error = fileError || writer.errorOf(IMPORT_PATH);
  return <section ref={panel} className="panel edit-panel import-panel" aria-label="导入原表数据">
    <h2>导入原表数据</h2>
    <p className="help">选择从《资产统计.xlsx》生成的 JSON 文件，先核对内容，再导入到当前账本。</p>
    <div className="form-grid">
      <label>原表导入文件（JSON）<input type="file" accept=".json,application/json" disabled={writer.busy} onChange={event => void choose(event.target.files?.[0])} /></label>
      {preview ? <div className="import-summary"><strong>{preview.summary.source}</strong>{summaryLines(preview.summary).map(line => <p key={line}>{line}</p>)}</div> : null}
      <p className="help">已有手动修改、只读 API 连接及同步余额会保留。导入前自动备份；旧示例快照保留在历史记录，不参与真实资产曲线。当前估值会随实时行情变化。</p>
      <p className="help">导入文件由随本服务安装的 <code>{IMPORT_SCRIPT_PATH}</code> 生成：复制到装有 openpyxl 的电脑上运行 <code>{IMPORT_SCRIPT}</code>，得到 imported-ledger.json。</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={onClose}>取消</button><button type="button" className="button primary" disabled={writer.busy || !preview} onClick={apply}>{writer.busy ? '正在处理…' : '导入并保留已有修改'}</button></div>
    </div>
  </section>;
}
