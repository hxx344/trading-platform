// Turns the heartbeat for the second server's main-watch on or off in this service's two files (docs/watch.md), so the
// operator does not edit config.json by hand. install.sh runs it as root for --watch-url, --watch-import and --watch-off,
// then checks the files with the new program and restarts the service; a failure there puts both files back.
//   --url <address>      the receiver's address; the token comes on stdin (one line). Without one the stored token stays.
//   --from-sender <file> the address and token of the workbench's sender on this machine (/etc/main-watch/sender)
//   --off                removes both
// Nothing printed here carries the token.
import { lstatSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileText, readExisting, writeBoth } from './import-workbench.ts';
import { parseWatchConfig, parseWatchSecret } from './watch.ts';

type Json = Record<string, unknown>;
const MAX_SENDER_BYTES = 16 * 1024;

/** HEARTBEAT_URL and HEARTBEAT_TOKEN of main-watch's sender file (KEY=VALUE lines; other keys are not ours). */
export function parseSenderFile(text: string): { url: string; token: string } {
  const found = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const at = line.indexOf('=');
    if (!line || line.startsWith('#') || at < 1) continue;
    let value = line.slice(at + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    found.set(line.slice(0, at).trim(), value);
  }
  const url = found.get('HEARTBEAT_URL'), token = found.get('HEARTBEAT_TOKEN');
  if (!url || !token) throw new Error('推送端配置里没有 HEARTBEAT_URL 或 HEARTBEAT_TOKEN');
  return { url, token };
}

export type WatchChange = { url: string; token: string | null } | 'off';

/**
 * Both files with the change applied, and whether anything differs. A null token keeps the stored one. The result is
 * validated here, so nothing the service would refuse is written.
 */
export function planWatch(existing: { config: Json; secrets: Json }, change: WatchChange): { config: Json; secrets: Json; changed: boolean; url: string | null } {
  const config = { ...existing.config }, secrets = { ...existing.secrets };
  if (change === 'off') {
    delete config.watch; delete secrets.watch;
    return { config, secrets, changed: Object.hasOwn(existing.config, 'watch') || Object.hasOwn(existing.secrets, 'watch'), url: null };
  }
  const stored = existing.secrets.watch;
  const token = change.token ?? (stored !== null && typeof stored === 'object' ? (stored as Json).token : undefined);
  if (token === undefined) throw new Error('还没有保存过心跳令牌：请同时给出 --watch-token（副服务器 /etc/main-watch/config 的 HEARTBEAT_TOKEN）');
  config.watch = parseWatchConfig({ url: change.url });
  secrets.watch = parseWatchSecret({ token });
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  return { config, secrets, changed: !same(existing.config.watch, config.watch) || !same(existing.secrets.watch, secrets.watch), url: change.url };
}

function readSender(path: string): { url: string; token: string } {
  let stat;
  try { stat = lstatSync(path); } catch { throw new Error(`没有找到工作台心跳推送端的配置 ${path}；请改用 --watch-url 与 --watch-token`); }
  if (!stat.isFile() || stat.size > MAX_SENDER_BYTES) throw new Error(`${path} 不是普通文件或过大，未读取`);
  return parseSenderFile(readFileSync(path, 'utf8'));
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, url: { type: 'string' }, 'from-sender': { type: 'string' }, off: { type: 'boolean' } } });
  if ([values.url !== undefined, values['from-sender'] !== undefined, values.off === true].filter(Boolean).length !== 1) throw new Error('需要 --url、--from-sender、--off 之一');
  const { configFile, secretsFile, existing } = readExisting(values.config ?? '');
  if (!existing) throw new Error('尚无 config.json，先执行一次 sudo bash install.sh 完成安装');
  let change: WatchChange;
  if (values.off) change = 'off';
  else if (values['from-sender'] !== undefined) { const sender = readSender(values['from-sender']); change = { url: sender.url, token: sender.token }; }
  else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const token = Buffer.concat(chunks).toString('utf8').trim();
    change = { url: values.url!, token: token || null };
  }
  const plan = planWatch(existing, change);
  if (!plan.changed) { process.stdout.write(plan.url ? `巡检心跳已是推送到 ${plan.url}，配置未改动\n` : '巡检心跳本来就没有开启，配置未改动\n'); return; }
  writeBoth(secretsFile, fileText(plan.secrets), configFile, fileText(plan.config));
  process.stdout.write(plan.url ? `巡检心跳：每 30 秒推送到 ${plan.url}\n` : '巡检心跳已关闭\n');
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
