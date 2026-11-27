import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { sourceBytes, sourceEntry, workbenchIdentity } from './workbench-source.ts';
import { validateCrossExState, PERPETUAL_CROSSEX_FILE, PERPETUAL_CROSSEX_IMPORT_FILE } from '../monitor/perpetual-crossex-store.ts';
import { parsePerpetualAlertState, PERPETUAL_ALERT_FILE, PERPETUAL_ALERT_IMPORT } from '../vendor/perpetual-alert-store.mjs';

const files = {
  alerts: { label: '机会提醒', source: PERPETUAL_ALERT_FILE, current: join('perpetual', PERPETUAL_ALERT_FILE), pending: PERPETUAL_ALERT_IMPORT, limit: 1_000_000, parse: parsePerpetualAlertState },
  filter: { label: '币种屏蔽与充提筛选', source: 'crossex-settings.json', current: PERPETUAL_CROSSEX_FILE, pending: PERPETUAL_CROSSEX_IMPORT_FILE, limit: 16_384, parse: validateCrossExState },
};
type Kind = keyof typeof files;
type Sources = Partial<Record<Kind, unknown>>;
export interface PerpetualImportPreview { available: boolean; details: string[] }
const kinds = Object.keys(files) as Kind[];
const exists = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;
function targetExists(dir: string, kind: Kind) {
  const { current, pending } = files[kind];
  const claimed = kind === 'alerts' ? pending.replace(/\.json$/, '.loading.json') : pending + '.loading';
  return [current, pending, claimed].some(name => exists(join(dir, name)));
}

/** This worker only sees fixed filenames and runs as the owner of the respective data directory. */
function worker(mode: string, root: string, dir: string, input: Sources) {
  const details: string[] = [], states: Sources = {};
  let available = false;
  for (const kind of kinds) {
    const spec = files[kind];
    if (mode === 'read') {
      try {
        const path = join(dir, spec.source);
        if (!sourceEntry(root, path)) { details.push('工作台没有' + spec.label + '文件'); continue; }
        const text = sourceBytes(root, path, spec.limit).toString('utf8');
        states[kind] = spec.parse(JSON.parse(text));
      } catch { details.push(spec.label + '文件无法读取或格式无效'); }
      continue;
    }
    if (!Object.hasOwn(input, kind)) continue;
    if (targetExists(dir, kind)) { details.push(spec.label + '已在本服务保存或待载入，保留现有设置'); continue; }
    const content = spec.parse(input[kind]);
    if (mode === 'inspect') { available = true; details.push(spec.label + '可导入'); continue; }
    const body = JSON.stringify(content);
    if (Buffer.byteLength(body) > spec.limit) throw new Error(spec.label + '超出文件上限');
    const temporary = join(dir, '.' + spec.pending + '.' + randomUUID());
    writeFileSync(temporary, body, { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporary, join(dir, spec.pending));
      details.push(spec.label + '已写入待载入文件'); available = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      details.push(spec.label + '已等待载入');
    } finally { unlinkSync(temporary); }
  }
  return { states, available, details };
}

function run(mode: 'read' | 'inspect' | 'write', dir: string, input: Sources = {}, root = dir) {
  if (!isAbsolute(dir)) throw new Error('导入目录须为绝对路径');
  let identity;
  try { identity = workbenchIdentity(root, dir); }
  catch (error) { throw new Error('导入路径包含符号链接或非目录，或目录所有者不符', { cause: error }); }
  const reply = spawnSync(process.execPath, [import.meta.filename, mode, dir, root], {
    input: JSON.stringify(input), cwd: dirname(import.meta.filename), env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_100_000,
    ...(identity ?? {}),
  });
  if (reply.status !== 0 || reply.error) throw new Error(mode === 'write' ? '合约价差设置写入未确认，请重新读取导入预览' : '合约价差设置无法读取');
  return JSON.parse(reply.stdout) as { states: Sources; available?: boolean; details: string[] };
}

export function inspectPerpetualImport(workbench: string, dataDir: string): { preview: PerpetualImportPreview; states: Sources } {
  const monitorDir = join(workbench, 'modules', 'monitor');
  const sourceDir = join(monitorDir, 'perpetual');
  let monitor;
  try { monitor = sourceEntry(workbench, monitorDir); }
  catch (error) { throw new Error('导入路径包含符号链接或非目录，或目录所有者不符', { cause: error }); }
  if (!monitor) return { states: {}, preview: { available: false, details: ['工作台没有行情监控数据'] } };
  if (!monitor.isDirectory() || !sourceEntry(workbench, sourceDir)?.isDirectory()) return { states: {}, preview: { available: false, details: ['工作台没有可读取的合约价差目录'] } };
  const source = run('read', sourceDir, {}, workbench);
  const target = Object.keys(source.states).length ? run('inspect', dataDir, source.states) : { available: false, details: [] };
  return { states: source.states, preview: { available: target.available === true, details: [...source.details, ...target.details] } };
}
export function stagePerpetualImport(dataDir: string, states: Sources): string[] {
  return run('write', dataDir, states).details;
}

if (import.meta.main) {
  try {
    const [, , mode, dir, root] = process.argv;
    if (!root || !dir || !isAbsolute(dir) || !mode || !['read', 'inspect', 'write'].includes(mode)) throw new Error('导入参数无效');
    process.stdout.write(JSON.stringify(worker(mode, root, dir, JSON.parse(readFileSync(0, 'utf8')) as Sources)));
  } catch { process.stderr.write('合约价差设置处理失败\n'); process.exitCode = 1; }
}
