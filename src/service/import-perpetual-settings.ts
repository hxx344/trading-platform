import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { readBounded } from './handoff-file.ts';
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
function worker(mode: string, dir: string, input: Sources) {
  const details: string[] = [], states: Sources = {};
  let available = false;
  for (const kind of kinds) {
    const spec = files[kind];
    if (mode === 'read') {
      try {
        const path = join(dir, spec.source);
        if (!exists(path)) { details.push('工作台没有' + spec.label + '文件'); continue; }
        if (!lstatSync(path).isFile()) throw new Error();
        const text = readBounded(path, spec.limit, stat => {
          if (process.getuid?.() === 0 && stat.uid !== 0) throw new Error('文件所有者与目录不符');
        });
        if (text !== null) states[kind] = spec.parse(JSON.parse(text));
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

function run(mode: 'read' | 'inspect' | 'write', dir: string, input: Sources = {}) {
  if (!isAbsolute(dir)) throw new Error('导入目录须为绝对路径');
  const chain = [dir];
  while (dirname(chain[0]!) !== chain[0]) chain.unshift(dirname(chain[0]!));
  // Establish the reader/writer identity at the first non-root ancestor. A workbench owner
  // can rename its descendants, so none of them can nominate another UID for this worker.
  let identity: { uid: number; gid: number } | undefined;
  const privileged = process.getuid?.() === 0;
  for (const path of chain) {
    const stat = lstatSync(path);
    if (!stat.isDirectory()) throw new Error('导入路径包含符号链接或非目录');
    if (!privileged) continue;
    if (identity && stat.uid !== identity.uid) throw new Error('导入目录所有者与上级目录不符');
    if (!identity && stat.uid !== 0) identity = { uid: stat.uid, gid: stat.gid };
    if (!identity && (stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) throw new Error('目录权限无法确认');
  }
  const reply = spawnSync(process.execPath, [import.meta.filename, mode, dir], {
    input: JSON.stringify(input), cwd: dirname(import.meta.filename), env: {}, encoding: 'utf8', timeout: 30_000, maxBuffer: 2_100_000,
    ...(identity ?? {}),
  });
  if (reply.status !== 0 || reply.error) throw new Error(mode === 'write' ? '合约价差设置写入未确认，请重新读取导入预览' : '合约价差设置无法读取');
  return JSON.parse(reply.stdout) as { states: Sources; available?: boolean; details: string[] };
}

export function inspectPerpetualImport(workbench: string, dataDir: string): { preview: PerpetualImportPreview; states: Sources } {
  const monitorDir = join(workbench, 'modules', 'monitor');
  if (!exists(monitorDir)) return { states: {}, preview: { available: false, details: ['工作台没有行情监控数据'] } };
  const sourceDir = join(monitorDir, 'perpetual');
  if (!lstatSync(monitorDir).isDirectory() || !lstatSync(sourceDir, { throwIfNoEntry: false })?.isDirectory()) {
    return { states: {}, preview: { available: false, details: ['工作台没有可读取的合约价差目录'] } };
  }
  const source = run('read', sourceDir);
  const target = Object.keys(source.states).length ? run('inspect', dataDir, source.states) : { available: false, details: [] };
  return { states: source.states, preview: { available: target.available === true, details: [...source.details, ...target.details] } };
}
export function stagePerpetualImport(dataDir: string, states: Sources): string[] {
  return run('write', dataDir, states).details;
}

if (import.meta.main) {
  try {
    const [, , mode, dir] = process.argv;
    if (!dir || !isAbsolute(dir) || !mode || !['read', 'inspect', 'write'].includes(mode)) throw new Error('导入参数无效');
    process.stdout.write(JSON.stringify(worker(mode, dir, JSON.parse(readFileSync(0, 'utf8')) as Sources)));
  } catch { process.stderr.write('合约价差设置处理失败\n'); process.exitCode = 1; }
}
