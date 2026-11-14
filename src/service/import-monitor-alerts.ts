// M-3b: the market monitor's alert tiers and robot from the workbench (docs/monitor.md M-3b, docs/module-import.md §3).
// The three files under <workbench data>/modules/monitor/ (oil/monitor.json, hynix/alerts.json, notifications.json) are
// read by a child running as the owner of that directory with no environment, and handed back as text; converting them
// (src/monitor/alert-import.ts) happens here. The tiers go into this service's monitor.sqlite through
// src/monitor/import-writer.ts run as the data directory's owner (root writes nothing there); the robot goes into the
// planned secrets.json as `feishuMonitor`. Only counts, names and reasons leave this file as text, never the webhook.
import { lstatSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { convertHynixAlerts, convertOilAlerts, convertRobot, type AlertImport, type Converted, type RobotRead } from '../monitor/alert-import.ts';
import { ALERT_SPECS, type AlertMarket } from '../monitor/alerts.ts';
import { parseServiceSecrets } from './config.ts';
import { readerIdentity } from './import-workbench.ts';

type Json = Record<string, unknown>;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const printable = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]/gu, '');
const WRITER = join(dirname(import.meta.filename), '..', 'monitor', 'import-writer.ts');
const TIMEOUT_MS = 30_000;
/** Each file is a few KiB; anything past this is not the workbench's. */
const MAX_FILE_BYTES = 1024 * 1024;
const FILES = { oil: join('oil', 'monitor.json'), hynix: join('hynix', 'alerts.json'), robot: 'notifications.json' } as const;

export interface MonitorAlertsSource { oil: Converted; hynix: Converted; robot: RobotRead }
export interface AlertMarketItem {
  market: AlertMarket;
  /** Tiers that come over, of them enabled, and the master switch; zeros and null when the market's file did not convert. */
  rules: number; enabledRules: number; enabled: boolean | null;
  problem: string | null; notes: string[];
}
export interface MonitorAlertsItem {
  status: 'added' | 'skipped';
  markets: AlertMarketItem[];
  /**
   * Whether the workbench's robot comes over (as secrets.json `feishuMonitor`), why not, whether it replaces another one,
   * and whether secrets.json changes for it (not when the same robot is already there: then no restart is needed for it).
   */
  robot: { imported: boolean; problem: string | null; replaces: boolean; changes: boolean };
  detail: string;
}

// Run as the owner of the monitor directory: each file must be a plain file (not followed when a link) of at most 1 MiB.
const DUMP_FILES = `import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, ...names] = process.argv.slice(1);
const out = {};
for (const name of names) {
  const path = join(dir, name);
  let stat;
  try { stat = lstatSync(path); } catch (error) { out[name] = error && error.code === 'ENOENT' ? { missing: true } : { refused: 'unreadable' }; continue; }
  if (!stat.isFile()) { out[name] = { refused: 'not_file' }; continue; }
  if (stat.size > ${MAX_FILE_BYTES}) { out[name] = { refused: 'large' }; continue; }
  try { out[name] = { text: readFileSync(path, 'utf8') }; } catch { out[name] = { refused: 'unreadable' }; }
}
process.stdout.write(JSON.stringify(out));`;

const REFUSED: Record<string, string> = { not_file: '不是普通文件（符号链接等），不读取', large: '超过 1 MiB，不是工作台的文件', unreadable: '读不出' };

/** Reads and converts the workbench's alert files; throws when the monitor directory cannot be read at all. */
export function readWorkbenchAlerts(data: string): MonitorAlertsSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const dir = join(data, 'modules', 'monitor');
  let stat;
  try { stat = lstatSync(dir); }
  catch (error) {
    // No monitor module on the workbench: nothing to import, not an error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { const problem = '工作台没有 Monitor 模块'; return { oil: { config: null, problem }, hynix: { config: null, problem }, robot: { robot: null, problem } }; }
    throw new Error(`工作台的 Monitor 模块数据目录 ${dir} 读不出：${reason(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`${dir} 不是目录（符号链接等），不读取`);
  if (process.getuid?.() === 0 && stat.uid === 0 && statSync(dirname(dir)).uid !== 0) throw new Error(`${dir} 归 root，但所在目录归其他账户，不读取；请确认来源`);
  const identity = readerIdentity(stat, process.getuid?.());
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', DUMP_FILES, '--', dir, ...Object.values(FILES)], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 8 * MAX_FILE_BYTES, ...identity,
  });
  const as = 'uid' in identity ? `（以目录属主 uid ${identity.uid} 读取，不带附加组）` : '';
  if (read.error || read.status !== 0) throw new Error(`读取工作台告警设置 ${dir} 失败${as}：${printable(read.error?.message ?? (read.stderr.trim() || `退出码 ${read.status ?? read.signal}`)).slice(0, 200)}`);
  let dumped: Record<string, { missing?: true; refused?: string; text?: string }>;
  try { dumped = JSON.parse(read.stdout) as typeof dumped; } catch { throw new Error(`读取工作台告警设置 ${dir} 失败${as}：输出无法解析`); }
  /** The parsed file, or why there is none (the parser's message is not passed on: it may quote the file). */
  const parsed = (name: string): { value: unknown } | { problem: string } => {
    const entry = dumped?.[name];
    if (!entry || typeof entry !== 'object') return { problem: `${name} 读取结果缺失` };
    if (entry.missing) return { problem: `工作台没有 ${name}` };
    if (typeof entry.text !== 'string') return { problem: `${name} ${REFUSED[String(entry.refused)] ?? REFUSED.unreadable}` };
    try { return { value: JSON.parse(entry.text) as unknown }; } catch { return { problem: `${name} 不是有效的 JSON` }; }
  };
  const market = (name: string, convert: (file: unknown) => Converted): Converted => {
    const file = parsed(name);
    return 'problem' in file ? { config: null, problem: file.problem } : convert(file.value);
  };
  const robotFile = parsed(FILES.robot);
  return {
    oil: market(FILES.oil, convertOilAlerts),
    hynix: market(FILES.hynix, convertHynixAlerts),
    robot: 'problem' in robotFile ? { robot: null, problem: robotFile.problem } : convertRobot(robotFile.value),
  };
}

/** The same address and signing secret, whatever the key order or an explicit null secret in a hand-written file. */
const sameRobot = (current: unknown, candidate: { webhook: string; secret?: string }): boolean => {
  if (!current || typeof current !== 'object') return false;
  const { webhook, secret, ...rest } = current as Record<string, unknown>;
  return !Object.keys(rest).length && webhook === candidate.webhook && (secret ?? null) === (candidate.secret ?? null);
};

/**
 * The tiers to write and the robot put into `secrets` (in place) as `feishuMonitor`, replacing one already there. Nothing
 * comes over while config.json has no `monitor` after the monitor's own plan: the tiers would wait for a monitor that
 * does not run.
 */
export function planMonitorAlerts(source: MonitorAlertsSource, config: Json, secrets: Json, notes: string[]): { item: MonitorAlertsItem; write: AlertImport | null } {
  const markets: AlertMarketItem[] = (['oil', 'hynix'] as const).map(market => {
    const converted = source[market];
    return converted.config
      ? { market, rules: converted.config.rules.length, enabledRules: converted.config.rules.filter(rule => rule.enabled).length, enabled: converted.config.enabled, problem: null, notes: converted.notes }
      : { market, rules: 0, enabledRules: 0, enabled: null, problem: converted.problem, notes: [] };
  });
  const robot: MonitorAlertsItem['robot'] = { imported: false, problem: source.robot.robot ? null : source.robot.problem, replaces: false, changes: false };
  const item: MonitorAlertsItem = { status: 'skipped', markets, robot, detail: '' };
  const monitor = config.monitor;
  if (!monitor || typeof monitor !== 'object') { item.detail = '行情监控未启用，告警不导入'; return { item, write: null }; }
  // A market the config does not run gets no tiers: they would wait under the pending key for a service that is not there.
  for (const entry of markets) {
    if (entry.problem === null && (monitor as Json)[entry.market] === undefined) Object.assign(entry, { rules: 0, enabledRules: 0, enabled: null, problem: `本服务的行情监控没有${ALERT_SPECS[entry.market].title}，档位不导入`, notes: [] });
  }
  const write: AlertImport = {};
  if (source.oil.config && markets[0]!.problem === null) write.oil = source.oil.config;
  if (source.hynix.config && markets[1]!.problem === null) write.hynix = source.hynix.config;
  if (source.robot.robot) {
    const candidate = { webhook: source.robot.robot.webhook, ...(source.robot.robot.secret ? { secret: source.robot.robot.secret } : {}) };
    try {
      parseServiceSecrets({ accounts: {}, feishuMonitor: candidate }, []);
      if (!sameRobot(secrets.feishuMonitor, candidate)) {
        robot.replaces = secrets.feishuMonitor !== undefined && secrets.feishuMonitor !== null;
        robot.changes = true;
        secrets.feishuMonitor = candidate;
      }
      robot.imported = true;
    } catch { robot.problem = '工作台的机器人地址不是飞书或 Lark 自定义机器人的 https 地址（或签名密钥格式不符），未导入'; }
  }
  const tiers = markets.filter(entry => entry.problem === null).map(entry => `${ALERT_SPECS[entry.market].title} ${entry.rules} 档（启用 ${entry.enabledRules}，总开关${entry.enabled ? '开' : '关'}）`);
  if (!tiers.length && !robot.imported) {
    item.detail = `没有可导入的告警：${[...markets.map(entry => `${ALERT_SPECS[entry.market].title}：${entry.problem}`), `机器人：${robot.problem}`].join('；')}`;
    return { item, write: null };
  }
  item.status = 'added';
  item.detail = [tiers.length ? `替换本服务的${tiers.join('、')}` : '', robot.imported ? `机器人写入 secrets.json 的 feishuMonitor${robot.replaces ? '（替换原有的）' : ''}` : ''].filter(Boolean).join('；');
  if (tiers.length) notes.push('导入的档位替换本服务现有档位，越线状态从头算：单向档若导入时已在越线中会提醒一次，双向档按“已提醒过”起算；工作台的告警仍开着时两边都会发，确认后关掉工作台的总开关');
  if (robot.imported) notes.push('行情告警改发工作台行情监控的机器人（secrets.json 的 feishuMonitor），ASTER 告警仍发 feishu；回滚到更早版本前须先删掉 feishuMonitor');
  return { item, write: tiers.length ? write : null };
}

/** Writes the tiers into monitor.sqlite (alerts.<market>.import) as the data directory's owner; the markets written. */
export function writeMonitorAlertsAsService(dataDir: string, write: AlertImport): { market: AlertMarket; rules: number; enabled: boolean }[] {
  if (!isAbsolute(dataDir)) throw new Error(`本服务数据目录须为绝对路径：${dataDir}`);
  const identity = readerIdentity(statSync(dataDir), process.getuid?.());
  const run = spawnSync(process.execPath, [WRITER, 'write', '--data-dir', dataDir], {
    cwd: '/', env: {}, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024, input: JSON.stringify(write), ...identity,
  });
  const as = 'uid' in identity ? `（以数据目录属主 uid ${identity.uid} 运行）` : '';
  if (run.error || run.status !== 0) throw new Error(`写入告警档位失败，已有档位未改动：${printable(run.error?.message ?? (run.stderr.trim() || `退出码 ${run.status ?? run.signal}`)).slice(0, 300)}${as}`);
  let answer: { markets?: { market: AlertMarket; rules: number; enabled: boolean }[] };
  try { answer = JSON.parse(run.stdout) as typeof answer; } catch { throw new Error(`写入告警档位后输出无法解析${as}`); }
  if (!Array.isArray(answer.markets)) throw new Error(`写入告警档位后输出格式错误${as}`);
  return answer.markets;
}

/** One line for the result and the log. */
export const alertsLine = (markets: readonly { market: AlertMarket; rules: number }[]): string => `告警档位（${markets.map(entry => `${ALERT_SPECS[entry.market].title} ${entry.rules} 档`).join('、')}）`;
