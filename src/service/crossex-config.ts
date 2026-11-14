// The optional CrossEx part of the service's operator files (docs/crossex.md §3): config.json `crossex` names the Gate
// account (UID) and the hard caps, secrets.json `gate` holds its key. The caps bound what the page's settings may hold
// (crossex/store.ts clamps reads, the settings route refuses more). No message built here carries a key, a secret or a
// field name read from the key file.
import { ContractError, exactKeys } from '../contracts.ts';
import { validCredentials, type LiveCredentials } from '../live/values.ts';
import type { CrossexLimits } from '../crossex/store.ts';

export interface CrossexServiceConfig {
  /** The Gate account UID (digits); the start check and the runtime's connection must both show it. */
  accountUid: string;
  /** The workbench connection generation the key was imported with (informational). */
  credentialVersion?: number;
  limits: CrossexLimits;
}

/** The workbench model's own bounds (model.mjs configuration()), so a clamped config always passes it. */
export const CROSSEX_LIMIT_BOUNDS = { notionalPerLeg: [5, 100_000], maxOpen: [1, 20], maxTotalNotional: [10, 2_000_000] } as const;
export const LIMIT_NAMES: Record<keyof CrossexLimits, string> = { notionalPerLeg: '单腿名义额度', maxOpen: '最多同时持仓组数', maxTotalNotional: '总双腿名义额度' };

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';

export function parseCrossexLimits(value: unknown, name = 'crossex.limits'): CrossexLimits {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, ['notionalPerLeg', 'maxOpen', 'maxTotalNotional']); } catch (error) { throw new Error(`${name} 无效（须为 { notionalPerLeg, maxOpen, maxTotalNotional }）：${reason(error)}`); }
  const limits = {} as CrossexLimits;
  for (const key of ['notionalPerLeg', 'maxOpen', 'maxTotalNotional'] as const) {
    const [low, high] = CROSSEX_LIMIT_BOUNDS[key], item = raw[key];
    const integer = key === 'maxOpen';
    if (typeof item !== 'number' || !Number.isFinite(item) || item < low || item > high || (integer && !Number.isInteger(item))) throw new Error(`${name}.${key} 须为 ${low}–${high} 的${integer ? '整数' : '数'}`);
    limits[key] = item;
  }
  if (limits.maxTotalNotional < 2 * limits.notionalPerLeg) throw new Error(`${name}.maxTotalNotional 不得低于 notionalPerLeg 的两倍`);
  return limits;
}

export function parseCrossexConfig(value: unknown): CrossexServiceConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, ['accountUid', 'limits'], ['credentialVersion']); } catch (error) { throw new Error(`crossex 无效：${reason(error)}`); }
  if (typeof raw.accountUid !== 'string' || !/^[1-9]\d{0,19}$/.test(raw.accountUid)) throw new Error('crossex.accountUid 须为 Gate 账户 UID（数字字符串）');
  if (raw.credentialVersion !== undefined && (typeof raw.credentialVersion !== 'number' || !Number.isSafeInteger(raw.credentialVersion) || raw.credentialVersion < 1)) throw new Error('crossex.credentialVersion 须为正整数');
  return { accountUid: raw.accountUid, ...(raw.credentialVersion === undefined ? {} : { credentialVersion: raw.credentialVersion as number }), limits: parseCrossexLimits(raw.limits) };
}

/** secrets.json `gate: { apiKey, apiSecret }`; field names are never echoed. */
export function parseCrossexSecrets(value: Record<string, unknown>): LiveCredentials {
  const entry = value.gate;
  if (entry === undefined) throw new Error('缺少 gate 的密钥（配置了 crossex）');
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'apiKey') || !Object.hasOwn(entry, 'apiSecret')) throw new Error('gate 的字段须恰好为 apiKey、apiSecret');
  const credentials = { apiKey: (entry as Record<string, unknown>).apiKey, apiSecret: (entry as Record<string, unknown>).apiSecret } as LiveCredentials;
  if (!validCredentials(credentials)) throw new Error('gate 的密钥不完整或格式无效');
  return credentials;
}

/** For --check-config: the account masked and the caps; empty without crossex so that output stays as it was. */
export function crossexSummary(crossex: CrossexServiceConfig | undefined): string {
  if (!crossex) return '';
  const { limits } = crossex;
  return `，CrossEx 账户 Gate ***${crossex.accountUid.slice(-4)}（单腿上限 ${limits.notionalPerLeg} USDT，最多 ${limits.maxOpen} 组，总额上限 ${limits.maxTotalNotional} USDT）`;
}

/** The settings route: a value above its cap is refused with what the cap is; undefined when everything fits. */
export function limitProblem(input: unknown, limits: CrossexLimits): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const config = (input as Record<string, unknown>).config;
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined;
  for (const key of ['notionalPerLeg', 'maxOpen', 'maxTotalNotional'] as const) {
    const value = (config as Record<string, unknown>)[key];
    if (typeof value === 'number' && value > limits[key]) return `${LIMIT_NAMES[key]}不能超过服务配置的上限 ${limits[key]}${key === 'maxOpen' ? ' 组' : ' USDT'}（config.json crossex.limits）`;
  }
  return undefined;
}
