// 开启、修改或关闭 MEV 套利模块（docs/mev.md 第 6 节），让运维不必手改 config.json 与密钥文件。
// install.sh 以 root 运行它（--set-mev、--unset-mev），随后用新程序校验两个文件并重启服务；校验不过时两个文件放回原样。
//   --executor <地址> --owner <地址>   执行合约与利润收款地址；标准输入给三行：节点地址、发送用节点地址、热钱包私钥。
//                                      空行沿用已保存的那一项；发送用节点地址填 - 表示去掉（发送也走第一个地址）。
//   --off                              去掉 config.json 与密钥文件里的 mev
// 这里打印的内容不带私钥和节点地址：节点地址可能含服务商密钥，只打印主机名。
import { parseArgs } from 'node:util';
import { addressOf } from '../mev/codec.ts';
import { loadServiceSecrets, parseServiceConfig } from './config.ts';
import { fileText, readExisting, writeBoth } from './import-workbench.ts';
import { parseMevConfig, parseMevSecrets } from './mev-config.ts';

type Json = Record<string, unknown>;
export type MevChange = { executor: string; owner: string; rpcUrl: string | null; sendRpcUrl: string | null | 'none'; privateKey: string | null } | 'off';
export interface MevPlan { config: Json; secrets: Json; changed: boolean; summary: string }

const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hostOf = (url: string): string => new URL(url).host;

/**
 * 两个文件改好后的内容。null 的项沿用已保存的值。结果在这里按服务启动时的规则完整校验一遍（含热钱包不与 ASTER 账户
 * 共用），服务会拒绝的内容不会写下去。
 */
export function planMev(existing: { config: Json; secrets: Json }, change: MevChange): MevPlan {
  const config = { ...existing.config }, secrets = { ...existing.secrets };
  if (change === 'off') {
    delete config.mev; delete secrets.mev;
    return { config, secrets, changed: Object.hasOwn(existing.config, 'mev') || Object.hasOwn(existing.secrets, 'mev'), summary: 'MEV 套利已关闭' };
  }
  const stored = isRecord(existing.secrets.mev) ? existing.secrets.mev : {};
  const rpcUrl = change.rpcUrl ?? stored.rpcUrl, privateKey = change.privateKey ?? stored.privateKey;
  const sendRpcUrl = change.sendRpcUrl === 'none' ? undefined : change.sendRpcUrl ?? stored.sendRpcUrl;
  if (rpcUrl === undefined) throw new Error('还没有保存过节点地址：第一次开启须给出 Base 节点的 https 地址');
  if (privateKey === undefined) throw new Error('还没有保存过热钱包私钥：第一次开启须给出专用热钱包的私钥');
  const mev = parseMevConfig({ executor: change.executor, owner: change.owner });
  const parsed = parseMevSecrets({ mev: { rpcUrl, privateKey, ...(sendRpcUrl === undefined ? {} : { sendRpcUrl }) } })!;
  config.mev = mev;
  secrets.mev = parsed;
  // 与服务启动时同一套检查：密钥文件齐全、热钱包专用。
  loadServiceSecrets(parseServiceConfig(config), () => fileText(secrets));
  const send = parsed.sendRpcUrl ? `，发送走 ${hostOf(parsed.sendRpcUrl)}` : '';
  return {
    config, secrets, changed: !same(existing.config.mev, config.mev) || !same(existing.secrets.mev, secrets.mev),
    summary: `MEV 套利：执行合约 ${mev.executor}，利润收款 ${mev.owner}，热钱包 ${addressOf(parsed.privateKey)}，节点 ${hostOf(parsed.rpcUrl)}${send}`,
  };
}

/** 标准输入的三行；多出的内容视为输入有误，不猜。 */
export function parseSetupInput(text: string): { rpcUrl: string | null; sendRpcUrl: string | null | 'none'; privateKey: string | null } {
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).map(line => line.trim());
  if (lines.length > 3) throw new Error('标准输入须为三行：节点地址、发送用节点地址、热钱包私钥');
  const [rpcUrl = '', sendRpcUrl = '', privateKey = ''] = lines;
  return { rpcUrl: rpcUrl || null, sendRpcUrl: sendRpcUrl === '-' ? 'none' : sendRpcUrl || null, privateKey: privateKey ? (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) : null };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, executor: { type: 'string' }, owner: { type: 'string' }, off: { type: 'boolean' } } });
  const { configFile, secretsFile, existing } = readExisting(values.config ?? '');
  if (!existing) throw new Error('尚无 config.json，先执行一次 sudo bash install.sh 完成安装');
  let change: MevChange;
  if (values.off) {
    if (values.executor !== undefined || values.owner !== undefined) throw new Error('--off 不与 --executor、--owner 同用');
    change = 'off';
  } else {
    if (values.executor === undefined || values.owner === undefined) throw new Error('需要 --executor 与 --owner，或 --off');
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    change = { executor: values.executor, owner: values.owner, ...parseSetupInput(Buffer.concat(chunks).toString('utf8')) };
  }
  const plan = planMev(existing, change);
  if (!plan.changed) { process.stdout.write(change === 'off' ? 'MEV 套利本来就没有开启，配置未改动\n' : `${plan.summary}；与现有配置相同，未改动\n`); return; }
  writeBoth(secretsFile, fileText(plan.secrets), configFile, fileText(plan.config));
  process.stdout.write(`${plan.summary}\n`);
  if (change !== 'off') process.stdout.write('模块启动后是观察模式；核对页面「MEV 套利」里的合约核对结果与热钱包余额后，在页面上开始实盘。\n');
}

if (import.meta.main) main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
