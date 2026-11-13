// The settings page's transfer form: what the operator typed, turned into the body of POST
// /api/transfer-pairs/<pair>/config. The two times are typed in seconds and sent in milliseconds; everything else is
// sent as typed, and the server checks it (parseTransferConfig). Kept free of the DOM so the server-side tests can import it.
import type { TransferConfig } from './types.ts';

export type TransferKey = keyof TransferConfig;
export type TransferDraft = Record<TransferKey, string>;
export interface TransferField { key: TransferKey; label: string; unit: string; hint: string }

/** The server's defaults (DEFAULT_TRANSFER_CONFIG in src/contracts.ts; a test keeps the two equal). */
export const TRANSFER_DEFAULTS: Readonly<TransferConfig> = Object.freeze({ threshold: '10', minTransfer: '1', maxTransfer: '1000', bufferRatio: '0.05', longReserve: '0', shortReserve: '0', cooldownMs: 30_000, checkIntervalMs: 5_000 });

export const TRANSFER_FIELDS: readonly TransferField[] = [
  { key: 'threshold', label: '差额门槛', unit: 'USD1', hint: '两侧可用余额之差严格大于它才划转' },
  { key: 'minTransfer', label: '最小划转额', unit: 'USD1', hint: '算出的金额低于它就不划' },
  { key: 'maxTransfer', label: '单次划转上限', unit: 'USD1', hint: '一次最多划这么多' },
  { key: 'bufferRatio', label: '现金保留比例', unit: '', hint: '转出侧至少留下权益的这个比例，小于 1' },
  { key: 'longReserve', label: '多侧固定保留额', unit: 'USD1', hint: '多侧转出时至少留下的金额，与比例取大' },
  { key: 'shortReserve', label: '空侧固定保留额', unit: 'USD1', hint: '空侧转出时至少留下的金额，与比例取大' },
  { key: 'cooldownMs', label: '划转冷却', unit: '秒', hint: '一笔划转后至少等这么久再划' },
  { key: 'checkIntervalMs', label: '检查间隔', unit: '秒', hint: '多久读一次两侧余额；越短占用的请求权重越多' },
];

const TIME_KEYS = new Set<TransferKey>(['cooldownMs', 'checkIntervalMs']);
const SECONDS = /^\d+(\.\d{1,3})?$/;

const shown = (key: TransferKey, value: string | number): string => TIME_KEYS.has(key) ? String(Number(value) / 1000) : String(value);

/** The form's fields filled from the stored settings. */
export function transferDraft(config: TransferConfig): TransferDraft {
  return Object.fromEntries(TRANSFER_FIELDS.map(({ key }) => [key, shown(key, config[key])])) as TransferDraft;
}

/** The default as the form shows it. */
export const defaultText = (key: TransferKey): string => shown(key, TRANSFER_DEFAULTS[key]);

/** The request body, or why the input cannot be sent (only the seconds are checked here; the server checks the rest). */
export function transferBody(draft: TransferDraft): { config: TransferConfig } | { error: string } {
  const config = {} as Record<TransferKey, string | number>;
  for (const { key, label } of TRANSFER_FIELDS) {
    const value = draft[key].trim();
    if (TIME_KEYS.has(key)) {
      if (!SECONDS.test(value)) return { error: `${label}须为秒数（最多三位小数）` };
      config[key] = Math.round(Number(value) * 1000);
    } else config[key] = value;
  }
  return { config: config as unknown as TransferConfig };
}

/** The fields that differ, as "label old → new", for the confirmation. */
export function transferChanges(before: TransferConfig, after: TransferConfig): string[] {
  return TRANSFER_FIELDS.filter(({ key }) => String(before[key]) !== String(after[key]))
    .map(({ key, label, unit }) => `${label} ${shown(key, before[key])} → ${shown(key, after[key])}${unit ? ` ${unit}` : ''}`);
}
