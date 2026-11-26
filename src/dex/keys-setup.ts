// 录入或去掉 DEX 价差实盘的场所账户（docs/dexspread.md 第 12.4 节）。install.sh 以 root 运行它（--set-dex-keys、
// --unset-dex-keys），随后重启 DEX 价差服务。文件所在目录归 root，服务账户写不了，所以这里可以按路径写（L201）。
//   --file <路径>   场所账户文件；标准输入给三行：Lighter 主网账户编号、Lighter RH 账户编号、Entropy 账户地址。
//                   空行沿用已保存的那一项，填 - 表示去掉那个场所。
//   --off           删除文件
// 这里打印的内容不带账户编号与地址。
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { KEY_VENUES, configuredVenues, decodeDexKeysFile, encodeDexKeys, parseEntropyAccount, parseLighterAccount, type DexAccounts, type KeyVenue } from './keys.ts';

const NAMES: Record<KeyVenue, string> = { lighter: 'Lighter', rh: 'Lighter RH', entropy: 'Entropy' };
const FILE_LIMIT = 16 * 1024;

/** 标准输入的三行；多出的内容视为输入有误，不猜。每项：null 沿用、'none' 去掉、其余为新值。 */
export function parseKeysInput(text: string): Record<KeyVenue, string | null | 'none'> {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.trim());
  if (lines.length > 3) throw new Error('标准输入须为三行：Lighter 主网账户编号、Lighter RH 账户编号、Entropy 账户地址');
  const item = (line = ''): string | null | 'none' => line === '-' ? 'none' : line || null;
  return { lighter: item(lines[0]), rh: item(lines[1]), entropy: item(lines[2]) };
}

const shape = (accounts: DexAccounts): string => JSON.stringify(KEY_VENUES.map(venue => accounts[venue] ?? null));

export function planKeys(existing: DexAccounts, input: Record<KeyVenue, string | null | 'none'>): { accounts: DexAccounts; changed: boolean; summary: string } {
  const accounts: DexAccounts = { ...existing };
  for (const venue of ['lighter', 'rh'] as const) {
    const value = input[venue];
    if (value === 'none') delete accounts[venue];
    else if (value !== null) accounts[venue] = parseLighterAccount(value, NAMES[venue]);
  }
  if (input.entropy === 'none') delete accounts.entropy;
  else if (input.entropy !== null) accounts.entropy = parseEntropyAccount(input.entropy);
  const venues = configuredVenues(accounts);
  return {
    accounts, changed: shape(existing) !== shape(accounts),
    summary: venues.length ? `DEX 价差实盘账户：已配置 ${venues.map(venue => NAMES[venue]).join('、')}` : 'DEX 价差实盘账户：没有配置任何场所',
  };
}

/** 只读本程序写出的普通文件：不跟随链接，按文件描述符核对类型与大小。没有文件时为 null。 */
export function readKeysFile(file: string): DexAccounts | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error(`打不开场所账户文件：${(error as NodeJS.ErrnoException).code ?? '未知错误'}`); }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > FILE_LIMIT) throw new Error('场所账户文件不是普通文件或过大');
    return decodeDexKeysFile(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}

/** 同目录临时文件写完落盘后改名；没有任何场所时删除文件。 */
export function writeKeysFile(file: string, accounts: DexAccounts): void {
  if (!configuredVenues(accounts).length) { rmSync(file, { force: true }); return; }
  const temp = join(dirname(file), `.keys.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    try { writeSync(fd, encodeDexKeys(accounts)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, file);
  } catch (error) { rmSync(temp, { force: true }); throw error; }
  try { const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* 目录不支持同步（Windows）时略过 */ }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { file: { type: 'string' }, off: { type: 'boolean' } } });
  if (!values.file || !isAbsolute(values.file)) throw new Error('需要绝对路径 --file');
  if (values.off) {
    // 不解析内容：文件坏了也要能去掉。
    const had = existsSync(values.file);
    rmSync(values.file, { force: true });
    process.stdout.write(had ? 'DEX 价差实盘账户已去掉\n' : 'DEX 价差实盘账户本来就没有配置\n');
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const plan = planKeys(readKeysFile(values.file) ?? {}, parseKeysInput(Buffer.concat(chunks).toString('utf8')));
  if (!plan.changed) { process.stdout.write(`${plan.summary}；与现有配置相同，未改动\n`); return; }
  writeKeysFile(values.file, plan.accounts);
  process.stdout.write(`${plan.summary}\n`);
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
