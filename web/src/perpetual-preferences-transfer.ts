import { parsePerpetualPreferences } from '../../src/vendor/perpetual-spreads.ts';
import { parseQualityBudget } from '../../src/vendor/perpetual-fees.ts';
import { parseCapitalAssumptions } from '../../src/vendor/capital-metrics.mjs';
import { parseManualPairs } from './perpetual-manual-pairs.ts';
import { parseScannerPreferences, parseScannerPrincipal } from './perpetual-scanner.ts';
import { parseScannerRangeInputs } from './perpetual-scanner-filters.ts';
import { parseScannerSort } from './perpetual-scanner-sort.ts';

const labels = {
  'market-monitor:perpetual:v1': '自选、屏蔽组合与交易所筛选',
  'market-monitor:perpetual-manual-pairs:v1': '手动配对与换算倍数',
  'market-monitor:perpetual-scanner:v1': '显示列、资产类别与分组',
  'market-monitor:perpetual-scanner-ranges:v1': '数值筛选范围',
  'market-monitor:perpetual-scanner-sort:v1': '表头排序',
  'market-monitor:perpetual-capital-assumptions:v1': '杠杆、保证金与持有时间',
  'market-monitor:perpetual-principal:v1': '测算本金',
  'market-monitor:perpetual-quality-budget:v1': '手续费与滑点预算',
} as const;
type Key = keyof typeof labels;
const keys = Object.keys(labels) as Key[];
const format = 'perpetual-browser-preferences/v1';
export const preferenceBackupLimit = 8 * 1024 * 1024;
type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface PreferenceChange { key: Key; label: string; before: string | null; after: string; same: boolean }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function normalized(key: Key, raw: string): string {
  const data: unknown = JSON.parse(raw);
  if (key === 'market-monitor:perpetual-scanner-sort:v1') {
    const sort = parseScannerSort(data);
    if (data !== null && !sort) throw new Error('表头排序格式无效');
    return JSON.stringify(sort);
  }
  if (!record(data)) throw new Error(`${labels[key]}格式无效`);
  switch (key) {
    case 'market-monitor:perpetual:v1':
      if (data.version !== 1 && data.version !== 2) break;
      return JSON.stringify({ version: 2, ...parsePerpetualPreferences(raw) });
    case 'market-monitor:perpetual-manual-pairs:v1': {
      if (data.version !== 1 || !Array.isArray(data.pairs)) break;
      const pairs = parseManualPairs(raw);
      if (pairs.length !== data.pairs.length) break;
      return JSON.stringify({ version: 1, pairs });
    }
    case 'market-monitor:perpetual-scanner:v1':
      if (data.version !== undefined && data.version !== 1 && data.version !== 2 && data.version !== 3) break;
      return JSON.stringify(parseScannerPreferences(raw));
    case 'market-monitor:perpetual-scanner-ranges:v1':
      return JSON.stringify(parseScannerRangeInputs(data));
    case 'market-monitor:perpetual-capital-assumptions:v1':
      return JSON.stringify(parseCapitalAssumptions(raw));
    case 'market-monitor:perpetual-principal:v1':
      if (typeof data.principal !== 'number' || !Number.isFinite(data.principal)) break;
      return JSON.stringify({ version: 1, principal: parseScannerPrincipal(raw) });
    case 'market-monitor:perpetual-quality-budget:v1':
      if (data.version !== 1 && data.version !== 2) break;
      return JSON.stringify({ version: 2, ...parseQualityBudget(raw) });
  }
  throw new Error(`${labels[key]}的版本或内容无效`);
}

function checkSize(text: string) {
  if (text.length > preferenceBackupLimit || new TextEncoder().encode(text).length > preferenceBackupLimit) throw new Error('备份超过 8 MiB');
}

export function exportPreferences(storage: LocalStore): string {
  const entries: Partial<Record<Key, string>> = {};
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw !== null) entries[key] = raw;
  }
  if (!Object.keys(entries).length) throw new Error('当前浏览器没有已保存的合约价差偏好');
  const text = JSON.stringify({ format, entries });
  checkSize(text);
  return text;
}

// Chrome and Edge DevTools' copy() writes only the inspected origin's eight known preference keys.
export const workbenchPreferenceScript = `copy((() => {
  const keys = ${JSON.stringify(keys, null, 2)};
  const entries = {};
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) entries[key] = value;
  }
  if (!Object.keys(entries).length) throw Error("当前页面没有已保存的价差偏好，请选择行情监控所在的页面上下文");
  return JSON.stringify({ format: "${format}", entries });
})())`;

export function previewPreferences(text: string, storage: LocalStore): PreferenceChange[] {
  checkSize(text);
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { throw new Error('请输入完整的 JSON 备份'); }
  if (!record(payload) || payload.format !== format || !record(payload.entries) || Object.keys(payload).some(k => k !== 'format' && k !== 'entries')) throw new Error('无法识别合约价差偏好备份');
  const items = Object.entries(payload.entries);
  if (!items.length || items.some(([key, data]) => !Object.hasOwn(labels, key) || typeof data !== 'string')) throw new Error('备份为空，或包含不属于合约价差的键');
  return items.map(([name, raw]) => {
    const key = name as Key;
    let after: string;
    try { after = normalized(key, raw as string); } catch { throw new Error(`${labels[key]}格式无效，请重新导出`); }
    const before = storage.getItem(key);
    let same = before === after;
    if (!same && before !== null) { try { same = normalized(key, before) === after; } catch { /* A damaged local value is shown as a conflict. */ } }
    return { key, label: labels[key], before, after, same };
  });
}

export function importPreferences(changes: PreferenceChange[], replace: boolean, storage: LocalStore): PreferenceChange[] {
  const selected = changes.filter(item => !item.same && (item.before === null || replace));
  const written: PreferenceChange[] = [];
  try {
    for (const item of selected) {
      if (storage.getItem(item.key) !== item.before) throw new Error('本站偏好已在其他页面修改，请重新预览');
      storage.setItem(item.key, item.after);
      written.push(item);
    }
  } catch (error) {
    let incomplete = false;
    for (const item of written.reverse()) {
      try {
        if (storage.getItem(item.key) !== item.after) continue;
        if (item.before === null) storage.removeItem(item.key);
        else storage.setItem(item.key, item.before);
      } catch { incomplete = true; }
    }
    if (incomplete) throw new Error('浏览器存储不可写，部分偏好未能恢复，请重新预览核对');
    throw error;
  }
  return written;
}
