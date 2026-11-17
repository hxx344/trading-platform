// The optional Ondo part of the service's operator files (docs/ondo.md §3): config.json `ondo` turns the module on and may
// carry the quoting settings imported from the workbench (`initial`, used until the page saves its own); secrets.json
// `ondo: { keyId, secret }` is the API key, optional because watching and the reward view need none. No message built
// here carries a key, a secret or a field name read from the key file.
import { ContractError, exactKeys } from '../contracts.ts';
import { validateCredentials, readOndoMmConfig, type OndoMmConfig } from '../vendor/ondo/mm.mjs';

export interface OndoServiceConfig {
  /** The workbench quoting settings imported once; the module saves the page's own in <data>/ondo-mm/config.json. */
  initial?: OndoMmConfig;
}
export interface OndoCredentials { keyId: string; secret: string }

const reason = (error: unknown): string => error instanceof ContractError || error instanceof Error ? error.message : '格式错误';

export function parseOndoConfig(value: unknown): OndoServiceConfig {
  let raw: Record<string, unknown>;
  try { raw = exactKeys(value, [], ['initial']); } catch (error) { throw new Error(`ondo 无效：${reason(error)}`); }
  if (raw.initial === undefined) return {};
  // Imported settings never start a live session by themselves.
  try { return { initial: { ...readOndoMmConfig(raw.initial), mode: 'observe' } }; } catch (error) { throw new Error(`ondo.initial 无效：${reason(error)}`); }
}

/** secrets.json `ondo: { keyId, secret }`, or undefined when absent; field names and values are never echoed. */
export function parseOndoSecrets(value: Record<string, unknown>): OndoCredentials | undefined {
  const entry = value.ondo;
  if (entry === undefined) return undefined;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, 'keyId') || !Object.hasOwn(entry, 'secret')) throw new Error('ondo 的字段须恰好为 keyId、secret');
  try { return validateCredentials(entry); } catch { throw new Error('ondo 的 API Key 不完整或格式无效'); }
}

/** For --check-config; empty without ondo so that output stays as it was. */
export function ondoSummary(ondo: OndoServiceConfig | undefined, key: OndoCredentials | undefined): string {
  if (!ondo) return '';
  return `，Ondo 挂单奖励（${key ? `API Key ***${key.keyId.slice(-4)}` : '未配置 API Key，只能观察'}）`;
}
