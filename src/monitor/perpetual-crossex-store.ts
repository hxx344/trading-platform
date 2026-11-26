import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readBounded } from '../service/handoff-file.ts';
import { normalizeCrossExBlockedBases, type CrossExFilterConfig } from '../vendor/perpetual-crossex-config.ts';
import { isObject } from '../contracts.ts';

export const PERPETUAL_CROSSEX_FILE = 'perpetual-crossex-settings.json';
export const PERPETUAL_CROSSEX_IMPORT_FILE = 'perpetual-crossex-settings.import.json';
export interface SavedCrossExSettings { version: 1; revision: number; config: CrossExFilterConfig }
export const initialCrossExSettings = (): SavedCrossExSettings => ({ version: 1, revision: 0, config: { requireSpotTransfer: false, blockedBases: [] } });

export function validateCrossExConfig(value: unknown, previous = initialCrossExSettings().config): CrossExFilterConfig {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'requireSpotTransfer' && key !== 'blockedBases') || typeof value.requireSpotTransfer !== 'boolean') throw new Error('CrossEx 筛选配置无效');
  return { requireSpotTransfer: value.requireSpotTransfer, blockedBases: normalizeCrossExBlockedBases(Object.hasOwn(value, 'blockedBases') ? value.blockedBases : previous.blockedBases) };
}

export function validateCrossExState(value: unknown): SavedCrossExSettings {
  if (!isObject(value) || Object.keys(value).some(key => !['version', 'config', 'revision'].includes(key)) || value.version !== 1 || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('CrossEx 筛选设置版本无效');
  return { version: 1, revision: value.revision, config: validateCrossExConfig(value.config) };
}

const exists = (file: string) => lstatSync(file, { throwIfNoEntry: false }) !== undefined;
export function openCrossExSettingsStore(dir: string, log: (line: string) => void) {
  const file = join(dir, PERPETUAL_CROSSEX_FILE), pending = join(dir, PERPETUAL_CROSSEX_IMPORT_FILE);
  const claimed = pending + '.loading';
  const raw = readBounded(file, 16_384);
  let state = raw === null ? initialCrossExSettings() : validateCrossExState(JSON.parse(raw));
  let lastError = '';
  function save(next: SavedCrossExSettings) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try { writeFileSync(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 }); renameSync(temp, file); }
    finally { try { unlinkSync(temp); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    state = structuredClone(next);
  }
  function adoptPending(): SavedCrossExSettings | null {
    let next: SavedCrossExSettings | null = null;
    try {
      if (!exists(claimed)) {
        try { renameSync(pending, claimed); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
      }
      if (!exists(file)) {
        let incoming: SavedCrossExSettings;
        try {
          if (lstatSync(claimed).isSymbolicLink()) throw new Error('待载入文件是符号链接');
          const text = readBounded(claimed, 16_384, stat => {
            if (process.getuid && stat.uid !== process.getuid()) throw new Error('待载入文件不属于服务账户');
          });
          if (text === null) return null;
          incoming = validateCrossExState(JSON.parse(text));
        } catch (e) {
          renameSync(claimed, claimed + '.rejected');
          throw e;
        }
        // The workbench and platform have independent optimistic-concurrency counters.
        next = { ...incoming, revision: 1 };
        save(next);
        log('合约价差：已载入工作台的 CrossEx 筛选设置');
      }
      unlinkSync(claimed); lastError = '';
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (lastError !== message) log('合约价差：载入工作台 CrossEx 筛选设置失败：' + message);
      lastError = message;
    }
    return next && state.revision === next.revision ? structuredClone(state) : null;
  }
  adoptPending();
  return { get: () => structuredClone(state), save, adoptPending };
}
