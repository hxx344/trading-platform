// The Ondo part of the workbench import (docs/ondo.md §8, docs/module-import.md): turns the module on (config.json `ondo`),
// brings the workbench Ondo quoting settings over as `ondo.initial` (always in observe mode) and its API key into
// secrets.json `ondo`. It reads <data>/ondo-mm/{config.json,credentials.json,session.json} and <data>/credentials.key as
// the directory's owner, in a child process with no environment, under the rules of the other workbench reads (regular
// files only, no root-owned file in another account's directory). The key is refused while the workbench may still be
// quoting on it: its session record (session.json) exists while a live session runs and after one that did not confirm
// its quotes withdrawn. Without a workbench Ondo directory or key the module still comes on, for watching.
// Only the masked key id, settings and reasons leave this file; the secret never does.
import { isAbsolute, join } from 'node:path';
import { validateCredentials, readOndoMmConfig, splitOndoMmConfig, type OndoMmConfig } from '../vendor/ondo/mm.mjs';
import { optionalSourceBytes, optionalSourceText, sourceEntry, workbenchIdentity } from './workbench-source.ts';
import { decryptCredential } from './import-workbench.ts';
import { parseOndoConfig, parseOndoSecrets, type OndoCredentials } from './ondo-config.ts';

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value);
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);
const mask = (id: string | null): string | null => id === null ? null : `***${id.slice(-4)}`;

/** The workbench's Ondo module as found. */
export interface OndoSource {
  /** The workbench has an ondo-mm directory. */
  present: boolean;
  credentials: OndoCredentials | null;
  /** The workbench's saved quoting settings, in observe mode; null when none or they did not pass. */
  initial: OndoMmConfig | null;
  /** Why the key cannot come over (session still recorded, undecryptable…); null when it can or there is none. */
  problem: string | null;
  /** Why the saved settings did not come over. */
  settingsProblem: string | null;
}
/** What the plan did with the module; the key id is masked. */
export interface OndoItem { keyId: string | null; status: 'added' | 'skipped'; detail: string; warning?: string }

export const SESSION_PROBLEM = '工作台 Ondo 挂单仍在实盘或有未确认撤销的挂单记录（ondo-mm/session.json），API Key 未导入；先在工作台停止并撤单，再重新导入';
export const LIVE_WARNING = '导入后不要再在工作台启动 Ondo 实盘挂单，避免两边用同一账户挂单';
const MAX_BYTES = 64 * 1024;

export interface OndoDump { config: string | null; credentials: string | null; session: boolean; key: Buffer | null }

/** The source from the dumped files (pure: the tests drive it directly). */
export function ondoCandidate(dump: OndoDump): OndoSource {
  const source: OndoSource = { present: true, credentials: null, initial: null, problem: null, settingsProblem: null };
  if (dump.config !== null) {
    try {
      const saved = JSON.parse(dump.config) as unknown;
      if (!isRecord(saved)) throw new Error('format');
      source.initial = { ...readOndoMmConfig(saved.config), mode: 'observe' };
    } catch { source.settingsProblem = '工作台 Ondo 挂单设置无法解析或本服务不接受，按默认值'; }
  }
  if (dump.credentials !== null) {
    try {
      let saved: unknown;
      try { saved = JSON.parse(dump.credentials); } catch { throw new Error('工作台 Ondo 的 API Key 记录格式错误'); }
      if (!isRecord(saved) || typeof saved.value !== 'string' || !dump.key) throw new Error('工作台 Ondo 的 API Key 记录格式错误');
      let plain: unknown;
      try { plain = decryptCredential(dump.key, saved.value); } catch { throw new Error('API Key 无法解密（credentials.key 与 ondo-mm/credentials.json 不匹配，或记录已损坏）'); }
      try { source.credentials = validateCredentials(plain); } catch { throw new Error('工作台 Ondo 的 API Key 不完整或格式无效'); }
      if (dump.session) { source.credentials = null; throw new Error(SESSION_PROBLEM); }
    } catch (error) { source.problem = reason(error); }
  }
  return source;
}

/** Reads the workbench Ondo module without writing to it; the secret never leaves this call except in the source. */
export function readWorkbenchOndo(data: string): OndoSource {
  if (!isAbsolute(data)) throw new Error(`工作台数据目录须为绝对路径：${data}`);
  const dir = join(data, 'ondo-mm');
  const folder = sourceEntry(data, dir);
  if (!folder) return { present: false, credentials: null, initial: null, problem: null, settingsProblem: null };
  if (!folder.isDirectory()) throw new Error('工作台的 Ondo 目录不是普通目录（符号链接等），不读取');
  workbenchIdentity(data, dir);
  const config = optionalSourceText(data, join(dir, 'config.json'), MAX_BYTES);
  const credentials = optionalSourceText(data, join(dir, 'credentials.json'), MAX_BYTES);
  const session = optionalSourceText(data, join(dir, 'session.json'), MAX_BYTES) !== null;
  const key = credentials !== null ? optionalSourceBytes(data, join(data, 'credentials.key'), 32) : null;
  if (credentials !== null && !key) throw new Error('没有找到工作台的凭据密钥');
  if (key && key.length !== 32) throw new Error('工作台凭据密钥长度不是 32 字节');
  try { return ondoCandidate({ config, credentials, session, key }); }
  finally { key?.fill(0); }
}

/**
 * Adds config.json `ondo` and secrets.json `ondo` in place, or says why not. An `ondo` block already there is kept; its
 * missing key is added when the workbench has one that may come over. A key in secrets.json is never overwritten.
 */
export function planOndo(source: OndoSource, config: Json, secrets: Json, fits: (candidate: Json) => void, notes: string[]): OndoItem {
  const key = source.credentials;
  const item: OndoItem = { keyId: mask(key?.keyId ?? null), status: 'skipped', detail: '' };
  const keyNote = source.problem ?? (source.present ? '工作台没有保存 Ondo API Key' : '工作台没有 Ondo 挂单模块的数据');
  if (config.ondo !== undefined) {
    if (secrets.ondo !== undefined) { item.detail = '已在本项目配置中（含 API Key），保留现有设置'; return item; }
    if (!key) { item.detail = `已在本项目配置中，保留现有设置；API Key 未导入：${keyNote}`; return item; }
    try { parseOndoSecrets({ ondo: key }); } catch (error) { item.detail = `API Key 本服务不接受（${reason(error)}）`; return item; }
    secrets.ondo = { keyId: key.keyId, secret: key.secret };
    item.status = 'added';
    item.detail = `已在本项目配置中，补入 API Key ${item.keyId}`;
    item.warning = LIVE_WARNING;
    notes.push(`Ondo：${LIVE_WARNING}`);
    return item;
  }
  if (secrets.ondo !== undefined) { item.detail = '现有密钥文件里已有 ondo 但 config.json 没有 ondo，不覆盖；请先确认并移走它'; return item; }
  // Only the workbench's quoting fields are imported. The exit policy belongs to this service.
  const ondo: Json = source.initial ? { initial: splitOndoMmConfig(source.initial).config } : {};
  try {
    fits({ ...config, ondo });
    parseOndoConfig(ondo);
    if (key) parseOndoSecrets({ ondo: key });
  } catch (error) {
    // Messages built by these checks never carry a key (ondo-config.ts).
    item.detail = `加入后本服务不接受（${reason(error)}）`;
    return item;
  }
  config.ondo = ondo;
  if (key) secrets.ondo = { keyId: key.keyId, secret: key.secret };
  item.status = 'added';
  const settings = source.initial ? `沿用工作台挂单设置（${source.initial.markets.join('、')}，每单 ${source.initial.orderUsd} USD），以观察模式启动` : '挂单设置用默认值';
  item.detail = `Ondo 挂单奖励（${key ? `API Key ${item.keyId}` : `未导入 API Key：${keyNote}，只能观察`}；${settings}）`;
  if (source.settingsProblem) notes.push(source.settingsProblem);
  if (key) { item.warning = LIVE_WARNING; notes.push(`Ondo：${LIVE_WARNING}`); }
  return item;
}
