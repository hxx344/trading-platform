// The root side of the page's workbench import, started by trading-platform-import.path when the service leaves a
// request. It reads the workbench (as import-workbench.ts does from install.sh), answers a preview with what each pair
// would bring, and for an import writes this service's two files, checks them as the service account, restarts the
// service and waits until it runs on them; a start that fails puts the files back and restarts again.
//
//   node import-helper.ts --dir /var/lib/trading-platform-import --config /etc/trading-platform/config.json
//                         --data-dir /var/lib/trading-platform --workbench-env /etc/project-aggregation.env
//                         [--workbench-data DIR] [--unit trading-platform.service] [--recover]
//
// Before writing, the helper leaves the files' previous text in an undo file next to config.json (root 600, in a
// directory the service cannot write). It is removed once the import is settled either way; one still there means the
// helper was stopped mid-import (its unit timed out), and the next start, or --recover (the unit's ExecStopPost), puts
// the files back and restarts the service.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { REQUEST_STALE_MS, readImportResult, takeImportRequest, writeImportResult, type ImportRequest, type ImportResult } from './import-channel.ts';
import { fileText, filesUnchanged, planImport, previewImport, readExisting, readWorkbench, readWorkbenchOil, readerIdentity, replaceOne, restoreFiles, writeBoth, WORKBENCH_ENV, type FileOwner, type OilSource } from './import-workbench.ts';
import { VENUE_NAMES } from '../contracts.ts';
import type { FetchLike } from '../live/http.ts';
import { readWorkbenchOptions, resolveOptionsAccount, type OptionsSource } from './import-options.ts';
import { connectionLines, readWorkbenchAsset, readWorkbenchMonitor, writeLedgerAsService, type AssetSource, type LedgerWrite, type WrittenLedger } from './import-modules.ts';

/** Requests handled in one start; one that arrives while the last is handled is still taken. */
const MAX_PER_START = 5;
/**
 * No new request is taken this long after the start: the lock wait (100 s), a recovery restart (about 125 s), this
 * window and a last import with its check and both restarts (about 310 s) stay within the unit's 720 s.
 */
const TAKE_WINDOW_MS = 60_000;
const HEALTH_WAIT_MS = 90_000;
const HEALTH_HOLD_MS = 5_000;

export interface HelperOptions {
  dir: string;
  configFile: string;
  /** The service's data directory: its owner is the service account, and a fresh access-url there means it started. */
  dataDir: string;
  workbenchEnv: string;
  workbenchData?: string;
  /** Restarts the service and resolves whether it came back healthy on the new files. */
  restart: () => Promise<boolean>;
  /** Checks the written files as the service account would at start; throws with the reason. */
  checkConfig?: (configFile: string, owner: { uid: number; gid: number }) => string;
  /** The Bybit requests of the options account read (tests); the network by default. */
  optionsFetch?: FetchLike;
  /** Tests: where the running workbench Greeks module is looked for (default /proc). */
  procDir?: string;
  /** Writes the asset ledger rows into asset.sqlite (tests); import-writer.ts as the data directory's owner by default. */
  writeLedger?: (dataDir: string, write: LedgerWrite) => Promise<WrittenLedger> | WrittenLedger;
  now?: () => number;
  log?: (line: string) => void;
}

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Where the files' previous text waits while an import is not settled. */
export const undoFile = (configFile: string): string => join(dirname(resolve(configFile)), '.import-undo.json');

interface Undo {
  requestId: string;
  /** The boot and time the import was written: later than the helper's own run, the service may have run on the new files. */
  bootId: string | null;
  at: number;
  configFile: string;
  secretsFile: string;
  text: { config: string | null; secrets: string | null };
  /** sha256 of what the import wrote, so files changed since (by install.sh, or by hand) are never rolled back. */
  written: { config: string; secrets: string };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const bootId = (): string | null => { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; } };
const currentText = (path: string): string | null => { try { return readFileSync(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };

function readUndo(path: string, configFile: string): Undo | null {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile()) throw new Error(`${path} 不是普通文件`);
  const undo = JSON.parse(readFileSync(path, 'utf8')) as Undo;
  const text = (value: unknown): value is string | null => value === null || typeof value === 'string';
  const hash = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const config = resolve(configFile);
  if (typeof undo?.requestId !== 'string' || undo.configFile !== config || typeof undo.secretsFile !== 'string' || dirname(resolve(undo.secretsFile)) !== dirname(config)
    || !text(undo.bootId) || !Number.isSafeInteger(undo.at) || !text(undo.text?.config) || !text(undo.text?.secrets) || !hash(undo.written?.config) || !hash(undo.written?.secrets)) throw new Error(`${path} 内容无效`);
  return undo;
}

export interface Recovered { requestId: string | null; message: string; restored: boolean; kept?: boolean }

/** Past the helper's own limit (TimeoutStartSec=720), an unsettled record is old news rather than an import in flight. */
const UNDO_FRESH_MS = 15 * 60_000;

/**
 * Settles an import the helper did not finish (it was stopped mid-way, or the host went down): the files go back only
 * while each still holds the text before or after that import; after a reboot, files the service accepts are kept
 * (it may have run on them since). Null when nothing was pending. The restart is left to the caller.
 */
export function recoverInterrupted(configFile: string, owner: FileOwner, check: (configFile: string, owner: FileOwner) => unknown = checkAsService, now = Date.now()): Recovered | null {
  const path = undoFile(configFile);
  let undo: Undo | null;
  try { undo = readUndo(path, configFile); }
  catch (error) {
    // Moved aside rather than retried on every start; nothing is rolled back from a record that cannot be trusted.
    let where = `已移到 ${path}.invalid`;
    try { renameSync(path, `${path}.invalid`); } catch {
      try { rmSync(path, { recursive: true, force: true }); where = '已删除'; } catch (again) { where = `无法移开（${message(again)}），请手动删除 ${path}`; }
    }
    return { requestId: null, restored: false, message: `上一次页面导入的撤销记录无效（${message(error)}），${where}，未改动配置` };
  }
  if (!undo) return null;
  const files = { config: currentText(undo.configFile), secrets: currentText(undo.secretsFile) };
  const ours = (name: 'config' | 'secrets'): boolean => files[name] === undo.text[name] || (files[name] !== null && sha256(files[name]) === undo.written[name]);
  const settled = (text: string, kept = false): Recovered => { rmSync(path, { force: true }); return { requestId: undo.requestId, restored: false, kept, message: text }; };
  if (!ours('config') || !ours('secrets')) return settled('上一次页面导入没有完成，但配置之后已被改动，保留现有配置');
  if (files.config === undo.text.config && files.secrets === undo.text.secrets) return settled('上一次页面导入没有完成，配置未改动');
  // An old record (another boot, or past the helper's limit) may sit under an import the service has run on since:
  // a complete import it accepts stays; a half-written one goes back.
  const complete = files.config !== null && files.secrets !== null && sha256(files.config) === undo.written.config && sha256(files.secrets) === undo.written.secrets;
  if (complete && (undo.bootId !== bootId() || now - undo.at > UNDO_FRESH_MS)) {
    try { check(undo.configFile, owner); return settled('上一次页面导入没有等到确认，但导入后的配置检查通过、可能已在使用，已保留导入结果', true); } catch { /* put back below */ }
  }
  restoreFiles(undo, owner);
  rmSync(path, { force: true });
  return { requestId: undo.requestId, restored: true, message: '上一次页面导入被中断，已恢复导入前的配置' };
}

/** Temporary files a stopped helper (or import) left next to the config: they may hold keys. */
/** Interruption answers cannot know whether a ledger was chosen; they say so. */
const LEDGER_NOTE = '（若勾选了资产账本，账本可能已写入并保留，请在资产页核对）';

/** Temporary files a stopped helper (or import) left next to the config: they may hold keys. */
function sweepLeftovers(configFile: string, log: (line: string) => void): void {
  const conf = dirname(resolve(configFile));
  for (const name of readdirSync(conf)) {
    if (!/\.json\.import(-old)?\.\d+$/.test(name) && name !== '.import-undo.json.settled') continue;
    try { rmSync(join(conf, name), { force: true }); log(`已删除残留的临时文件 ${name}`); } catch (error) { log(`无法删除 ${name}：${message(error)}`); }
  }
}

/** The import directory must be root's and not writable by others, under a parent only root may change. */
function checkImportDir(dir: string): void {
  if (process.getuid?.() !== 0) return;
  for (const [path, groupWritable] of [[dir, true], [dirname(dir), false]] as const) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o002) !== 0 || (!groupWritable && (stat.mode & 0o020) !== 0)) {
      throw new Error(`${path} 须为 root 所有、其他人不可写的目录${groupWritable ? '' : '（且组不可写）'}`);
    }
  }
}

/** `main.ts --check-config`, run as the service account (as install.sh does) on the files just written. */
export function checkAsService(configFile: string, owner: { uid: number; gid: number }): string {
  const main = join(dirname(import.meta.filename), 'main.ts');
  const run = spawnSync(process.execPath, [main, '--config', configFile, '--check-config'], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: 60_000, ...readerIdentity(owner, process.getuid?.()),
  });
  if (run.error || run.status !== 0) throw new Error((run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 500));
  return run.stdout.trim();
}

/** Handles the pending requests; returns how many were answered. */
export async function runImportHelper(options: HelperOptions): Promise<number> {
  const { dir, dataDir, now = Date.now, log = line => process.stderr.write(`${line}\n`) } = options;
  if (![dir, options.configFile, dataDir, options.workbenchEnv].every(isAbsolute)) throw new Error('目录与文件须为绝对路径');
  checkImportDir(dir);
  const stat = statSync(dataDir);
  const owner = { uid: stat.uid, gid: stat.gid };
  const started = now();
  sweepLeftovers(options.configFile, log);
  const recovered = recoverInterrupted(options.configFile, owner, options.checkConfig ?? checkAsService);
  if (recovered) {
    log(recovered.message);
    const healthy = !recovered.restored || await options.restart();
    // Answered under the interrupted request's id: a page waiting on a newer request is not told it failed.
    safeAnswer(dir, { id: recovered.requestId, action: 'import', at: now(), phase: recovered.kept ? 'done' : 'failed', message: `${recovered.message}${LEDGER_NOTE}${!recovered.restored ? '' : healthy ? '并重启了服务' : '，但服务重启后仍未正常运行；请查看 journalctl -u trading-platform'}` }, owner, log);
  }
  let handled = 0;
  for (; handled < MAX_PER_START && now() - started < TAKE_WINDOW_MS; handled++) {
    const taken = takeImportRequest(dir, owner);
    if (taken === null) break;
    if ('invalid' in taken) {
      log(`导入请求无效：${taken.invalid}`);
      safeAnswer(dir, { id: null, action: null, at: now(), phase: 'failed', message: `导入请求无效：${taken.invalid}` }, owner, log);
      continue;
    }
    // A request that waited past the page's patience (the install lock was held) is not run behind the user's back.
    if (now() - taken.at > REQUEST_STALE_MS) {
      safeAnswer(dir, { id: taken.id, action: taken.action, at: now(), phase: 'failed', message: '请求等待超过 2 分钟（安装脚本正在运行），已作废未执行；请重新操作' }, owner, log);
      continue;
    }
    await handle(taken, owner, options, now, log);
  }
  return handled;
}

/** A result that cannot be written is logged: the import itself goes on to a settled state either way. */
function safeAnswer(dir: string, result: ImportResult, owner: FileOwner, log: (line: string) => void): void {
  try { writeImportResult(dir, result, owner); } catch (error) { log(`无法写入导入结果：${message(error)}`); }
}

async function handle(request: ImportRequest, owner: FileOwner, options: HelperOptions, now: () => number, log: (line: string) => void): Promise<void> {
  const { dir } = options;
  const base = { id: request.id, action: request.action };
  const answer = (result: Omit<ImportResult, 'id' | 'action' | 'at'>): void => safeAnswer(dir, { ...base, at: now(), ...result }, owner, log);
  answer({ phase: 'running', message: '正在读取工作台' });
  // A preview always shows the oil and options accounts too; an import reads them only when they were ticked.
  const wantsOil = request.action === 'preview' || request.oil === true;
  const wantsOptions = request.action === 'preview' || request.options === true;
  const wantsMonitor = request.action === 'preview' || request.monitor === true;
  const wantsAsset = request.action === 'preview' || request.asset === true;
  const pairsWanted = request.action === 'preview' || (request.pairs?.length ?? 0) > 0;
  let source: ReturnType<typeof readWorkbench>, files: ReturnType<typeof readExisting>;
  try {
    source = readWorkbench(options.workbenchEnv, options.workbenchData, { asterOptional: wantsOil || wantsOptions || wantsMonitor || wantsAsset });
    files = readExisting(options.configFile);
  } catch (error) { answer({ phase: 'failed', message: message(error) }); return; }
  // The oil accounts' read failing does not hold the pairs back: the page shows why next to the oil choice.
  let oil: OilSource | undefined, oilError: string | undefined;
  if (wantsOil) { try { oil = readWorkbenchOil(source.data); } catch (error) { oilError = message(error); } }
  // Likewise the options account (its files, then one Bybit read of the key's UID).
  let optionsSource: OptionsSource | undefined, optionsError: string | undefined;
  if (wantsOptions) {
    try { optionsSource = await resolveOptionsAccount(readWorkbenchOptions(options.workbenchEnv, source.data, options.procDir), options.optionsFetch ? { fetchImpl: options.optionsFetch } : {}); }
    catch (error) { optionsError = message(error); }
  }
  // The ledger likewise; the monitor needs nothing read.
  const monitor = wantsMonitor ? readWorkbenchMonitor(source.data) : undefined;
  let asset: AssetSource | undefined, assetError: string | undefined;
  if (wantsAsset) { try { asset = readWorkbenchAsset(source.data, options.dataDir, request.assetOwner === undefined ? {} : { owner: request.assetOwner }); } catch (error) { assetError = message(error); } }
  const oilReport = { ...(oilError !== undefined ? { oilError } : {}), ...(optionsError !== undefined ? { optionsError } : {}), ...(assetError !== undefined ? { assetError } : {}) };
  const withOptions = { ...(optionsSource ? { options: optionsSource } : {}), ...(monitor ? { monitor } : {}), ...(asset ? { asset } : {}) };
  if (request.action === 'preview') {
    try {
      const { items, oil: oilItems, options: optionsItem, monitor: monitorItem, asset: assetItem, notes } = previewImport(source, files.existing, { secretsFile: files.secretsFile, ...(oil ? { oil } : {}), ...withOptions });
      const pairsLine = items.length ? `工作台有 ${items.length} 个配对，其中 ${items.filter(item => item.importable).length} 个可以导入` : '工作台里没有 ASTER 保证金平衡配对';
      const oilLine = oil ? `；原油执行账户 ${oilItems.length} 个，其中 ${oilItems.filter(item => item.status === 'added').length} 个可以导入` : '';
      const optionsLine = optionsItem ? `；期权账户${optionsItem.status === 'added' ? '可以导入' : '不能导入'}` : '';
      const monitorLine = monitorItem ? `；行情监控${monitorItem.status === 'added' ? '可以启用' : monitorItem.enabled ? '已启用' : '不能启用'}` : '';
      const ready = assetItem?.owners.filter(item => item.importable).length ?? 0;
      const assetLine = assetItem ? `；资产账本${ready ? `可以导入（${ready} 个用户）` : '不能导入'}` : '';
      answer({ phase: 'done', message: pairsLine + oilLine + optionsLine + monitorLine + assetLine, database: source.database, preview: items, ...(oil ? { oil: oilItems } : {}), ...(optionsItem ? { options: optionsItem } : {}),
        ...(monitorItem ? { monitor: monitorItem } : {}), ...(assetItem ? { asset: assetItem } : {}), ...oilReport, notes });
    } catch (error) { answer({ phase: 'failed', message: message(error), ...oilReport }); }
    return;
  }
  // Nothing to plan: no pair chosen and none of the ticked modules could be read.
  if (!pairsWanted && !oil && !optionsSource && !monitor && !asset) {
    const unread = [oilError !== undefined ? `原油执行账户（${oilError}）` : '', optionsError !== undefined ? `期权账户（${optionsError}）` : '', assetError !== undefined ? `资产账本（${assetError}）` : ''].filter(Boolean).join('；');
    answer({ phase: 'failed', message: `无法读取工作台的${unread || '所选内容'}，配置未改动` }); return;
  }
  let plan: ReturnType<typeof planImport>;
  try { plan = planImport(source, files.existing, { secretsFile: files.secretsFile, only: request.pairs ?? [], requireMargin: true, ...(oil ? { oil } : {}), ...withOptions, ...(request.assetOwner === undefined ? {} : { assetOwner: request.assetOwner }) }); }
  catch (error) { answer({ phase: 'failed', message: message(error), ...oilReport }); return; }
  const oilAdded = plan.oil.filter(item => item.status === 'added').map(item => VENUE_NAMES[item.venue]);
  const optionsAdded = plan.options?.status === 'added', monitorAdded = plan.monitor?.status === 'added', assetAdded = plan.asset?.status === 'added';
  const assetBefore = files.existing?.config.asset !== undefined;
  const notes = [...plan.notes, ...(oilError !== undefined ? [`原油执行账户未导入：${oilError}`] : []), ...(optionsError !== undefined ? [`期权账户未导入：${optionsError}`] : []), ...(assetError !== undefined ? [`资产账本未导入：${assetError}`] : [])];
  const report = { database: source.database, imported: plan.items, ...(request.oil ? { oil: plan.oil } : {}), ...(request.options && plan.options ? { options: plan.options } : {}),
    ...(request.monitor && plan.monitor ? { monitor: plan.monitor } : {}), ...(request.asset && plan.asset ? { asset: plan.asset } : {}), ...oilReport, notes };
  if (plan.added.length === 0 && oilAdded.length === 0 && !optionsAdded && !monitorAdded && !assetAdded) {
    const chosen = [pairsWanted ? '所选配对' : '', request.oil ? '原油执行账户' : '', request.options ? '期权账户' : '', request.monitor ? '行情监控' : '', request.asset ? '资产账本' : ''].filter(Boolean);
    answer({ phase: 'failed', message: `${chosen.join('与')}${chosen.length > 1 || pairsWanted ? '都' : ''}不能导入，配置未改动`, ...report });
    return;
  }
  const what = [plan.added.length ? `${plan.added.length} 个配对` : '', oilAdded.length ? `原油执行账户（${oilAdded.join('、')}）` : '', optionsAdded ? `期权账户（Bybit ${plan.options?.accountId ?? ''}）` : '',
    monitorAdded ? '行情监控' : '', assetAdded ? `资产账本（用户 ${plan.asset?.owner ?? ''}）` : ''].filter(Boolean).join('与');
  const after = [plan.added.length ? '配对登记为停用：先在旧工作台删除该配对，再在本页面启用' : '', oilAdded.length ? '原油执行账户已生效，页面出现「原油」标签' : '', optionsAdded ? '期权账户已生效，页面出现「期权」标签' : '',
    monitorAdded ? '行情监控已生效，页面出现「行情监控」标签' : '', assetAdded && !assetBefore ? '资产账本已生效，页面出现「资产」标签' : ''].filter(Boolean).join('；');
  // The ledger first (docs/module-import.md §3): when it fails nothing has changed; once written it is whole, and stays
  // whatever becomes of the config (without `asset` the service does not read it).
  let ledgerLine = '';
  if (plan.ledger) {
    try {
      const last = await (options.writeLedger ?? writeLedgerAsService)(options.dataDir, plan.ledger);
      ledgerLine = `资产账本（用户 ${last.owner}，资产 ${last.assets} 条、快照 ${last.snapshots} 条${last.connections.imported.length ? `、连接 ${last.connections.imported.length} 个` : ''}）`;
      log(`已写入${ledgerLine}`);
      // Names and reasons only; the page shows them with the other notes.
      for (const line of connectionLines(last.connections)) { notes.push(line); log(line); }
    } catch (error) { answer({ phase: 'failed', message: `${message(error)}；配置未改动，本次没有导入任何内容，可重试`, ...report }); return; }
  }
  if (filesUnchanged(plan, files.existing)) {
    answer({ phase: 'done', message: `已重新导入${ledgerLine}；配置未改动，未重启服务，资产页下次读取即是新账本`, ...report });
    return;
  }
  const kept = plan.ledger ? '。资产账本已写入并保留（配置已恢复时服务按原配置运行），重新勾选导入即可' : '';
  const undo = undoFile(files.configFile);
  const written = { config: fileText(plan.config), secrets: fileText(plan.secrets) };
  const record: Undo = { requestId: request.id, bootId: bootId(), at: now(), configFile: resolve(files.configFile), secretsFile: resolve(files.secretsFile), text: files.text, written: { config: sha256(written.config), secrets: sha256(written.secrets) } };
  try { replaceOne(undo, JSON.stringify(record)); }
  catch (error) { answer({ phase: 'failed', message: `无法记录导入前的配置，配置未改动：${message(error)}${kept}`, ...report }); return; }
  // A record left behind would undo this import on the next stop; one that cannot be removed is at least emptied of
  // its meaning by renaming it.
  let unsettled = false;
  const settle = (): void => {
    try { rmSync(undo, { force: true }); } catch (error) {
      log(`无法删除 ${undo}：${message(error)}`);
      try { renameSync(undo, `${undo}.settled`); } catch (again) { log(`也无法改名：${message(again)}`); unsettled = true; }
    }
  };
  const putBack = (): string | null => { try { restoreFiles(files, owner); settle(); return null; } catch (error) { return message(error); } };
  // Keys first, so the config never names a key file that lacks its accounts.
  try { writeBoth(files.secretsFile, written.secrets, files.configFile, written.config, owner); }
  catch (error) {
    const failed = putBack();
    answer({ phase: 'failed', message: (failed ? `写入配置失败（${message(error)}），恢复导入前的配置也失败了（${failed}），请手动检查 ${files.configFile}` : `写入配置失败，已保持导入前的配置：${message(error)}`) + kept, ...report });
    return;
  }
  try { (options.checkConfig ?? checkAsService)(files.configFile, owner); }
  catch (error) {
    const failed = putBack();
    answer({ phase: 'failed', message: `导入后的配置未通过服务检查（${message(error)}），${failed ? `恢复导入前的配置也失败了（${failed}），请手动检查 ${files.configFile}` : '已恢复导入前的配置'}${kept}`, ...report });
    return;
  }
  log(`已导入 ${what}，重启服务`);
  answer({ phase: 'restarting', message: `已写入 ${what}，正在重启服务`, ...report });
  if (await options.restart()) {
    settle();
    answer({ phase: 'done', message: `已导入 ${what}，服务已重启。${after}${unsettled ? `。注意：撤销记录 ${undo} 无法删除，请手动删除，否则助手下次停止时会撤销本次导入` : ''}`, ...report });
    return;
  }
  const failed = putBack();
  if (failed) { answer({ phase: 'failed', message: `服务在导入后的配置上没有正常启动，恢复导入前的配置也失败了（${failed}）；请查看 journalctl -u trading-platform 并手动检查 ${files.configFile}${kept}`, ...report }); return; }
  const back = await options.restart();
  answer({ phase: 'failed', message: (back ? '服务在导入后的配置上没有正常启动，已恢复导入前的配置并确认服务运行正常；请查看 journalctl -u trading-platform' : '服务在导入后的配置上没有正常启动，已恢复导入前的配置，但服务仍未正常运行；请查看 journalctl -u trading-platform') + kept, ...report });
}

/** systemctl restart, then the same health rule as install.sh: active, a new login link, and no restart for 5 s. */
export function systemdRestart(unit: string, dataDir: string, log: (line: string) => void): () => Promise<boolean> {
  const ctl = (...args: string[]) => spawnSync('systemctl', args, { encoding: 'utf8', timeout: 120_000 });
  const show = (property: string): string => ctl('show', '-p', property, '--value', unit).stdout?.trim() ?? '';
  return async () => {
    const marker = Math.floor(Date.now() / 1000);
    ctl('reset-failed', unit);
    const restarted = ctl('restart', unit);
    if (restarted.status !== 0) { log(`重启 ${unit} 失败：${(restarted.stderr ?? '').trim().slice(0, 200)}`); return false; }
    const deadline = Date.now() + HEALTH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(500);
      if (show('ActiveState') !== 'active') continue;
      let written = 0;
      try { written = Math.floor(statSync(join(dataDir, 'access-url')).mtimeMs / 1000); } catch { continue; }
      if (written < marker) continue;
      const restarts = show('NRestarts');
      await sleep(HEALTH_HOLD_MS);
      return show('ActiveState') === 'active' && show('NRestarts') === restarts;
    }
    return false;
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    dir: { type: 'string' }, config: { type: 'string' }, 'data-dir': { type: 'string' }, 'workbench-env': { type: 'string' }, 'workbench-data': { type: 'string' }, unit: { type: 'string' },
    recover: { type: 'boolean' },
  } });
  if (!values.dir || !values.config || !values['data-dir']) throw new Error('需要 --dir、--config 与 --data-dir');
  const log = (line: string): void => { process.stderr.write(`${line}\n`); };
  const unit = values.unit ?? 'trading-platform.service';
  if (values.recover) {
    // ExecStopPost: runs after every stop of the helper; acts only when an import was left unsettled.
    if (!isAbsolute(values.config) || !isAbsolute(values['data-dir'])) throw new Error('目录与文件须为绝对路径');
    checkImportDir(values.dir);
    const stat = statSync(values['data-dir']);
    const owner = { uid: stat.uid, gid: stat.gid };
    const latest = (() => { try { return readImportResult(values.dir!); } catch { return null; } })();
    const done = recoverInterrupted(values.config, owner);
    if (done) {
      log(done.message);
      if (done.restored) spawnSync('systemctl', ['restart', '--no-block', unit], { timeout: 30_000 });
      safeAnswer(values.dir, { id: done.requestId, action: 'import', at: Date.now(), phase: done.kept ? 'done' : 'failed', message: `${done.message}${LEDGER_NOTE}${done.restored ? '，正在重启服务；请稍后刷新页面' : ''}` }, owner, log);
    } else if (latest && (latest.phase === 'running' || latest.phase === 'restarting')) {
      // Cut short with nothing to put back (a stuck read, or the restart after putting the files back).
      safeAnswer(values.dir, { ...latest, at: Date.now(), phase: 'failed', message: latest.phase === 'restarting' ? '导入助手在重启服务时被中断，导入可能已生效，也可能已恢复；请点「读取工作台」核对，并查看 journalctl -u trading-platform' : '导入助手处理超时被中断，配置未改动（若勾选了资产账本，账本可能已写入并保留，请在资产页核对）；请稍后重试' }, owner, log);
    }
    sweepLeftovers(values.config, log);
    return;
  }
  await runImportHelper({
    dir: values.dir, configFile: values.config, dataDir: values['data-dir'], workbenchEnv: values['workbench-env'] ?? WORKBENCH_ENV,
    ...(values['workbench-data'] ? { workbenchData: values['workbench-data'] } : {}),
    restart: systemdRestart(unit, values['data-dir'], log), log,
  });
}

if (import.meta.main) main().catch(error => { process.stderr.write(`导入助手失败：${message(error)}\n`); process.exitCode = 1; });
