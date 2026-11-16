// The H2 two-leg balance panel of the SK hynix page (docs/hynix.md section 7): reading GET /api/hynix/state's balance,
// formatting it, checking the threshold form and building the rebalance preview intent. Kept free of the DOM so the tests
// import it.
import type { HynixBalanceLeg, HynixBalanceRow, HynixBalanceSettings, HynixBalanceView, HynixRebalancePreview, RebalanceMethod, RebalanceSuggestion } from './oil-types.ts';

export const REBALANCE_TIMEOUT_MS = 60_000;
const NAME: Record<string, string> = { SKHYUSDT: 'ADR', SKHYNIXUSDT: '正股' };
/** How a quantity of each contract is counted: ADR in units (份), the ordinary share in shares (股). */
const UNIT: Record<string, string> = { SKHYUSDT: '份 ADR', SKHYNIXUSDT: '股正股' };
const VENUE: Record<string, string> = { binance: 'Binance', bybit: 'Bybit' };
export const contractName = (symbol: string | undefined): string => symbol ? NAME[symbol] ?? symbol : '—';
export const venueLabel = (venue: string | undefined): string => venue ? VENUE[venue] ?? venue : '—';
export const sideName = (side: string | null | undefined): string => side === 'long' ? '多头' : side === 'short' ? '空头' : '—';
export const METHOD_LABEL: Record<RebalanceMethod, string> = { reduce: '减仓调平', add: '加仓调平' };

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;
/**
 * A USDT amount or a percent at two decimals, rounded half away from zero on the decimal string itself (the same rule as
 * the Feishu balance alert), so a large amount keeps every digit. Anything that is not a plain decimal gives '—'.
 */
export function fixed2(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  const match = DECIMAL.exec(text);
  if (!match) return '—';
  const [, sign, whole, fraction = ''] = match;
  const cents = BigInt(whole! + (fraction + '00').slice(0, 2)) + (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  const digits = String(cents).padStart(3, '0');
  return `${sign && cents !== 0n ? '-' : ''}${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`;
}
export const percent2 = (value: string | null | undefined): string => { const text = fixed2(value); return text === '—' ? text : `${text}%`; };
export const usdt2 = (value: string | null | undefined): string => { const text = fixed2(value); return text === '—' ? text : `${text} USDT`; };

export type BalanceLevel = 'ok' | 'rebalance' | 'hard';
export const LEVEL_LABEL: Record<BalanceLevel, string> = { ok: '正常', rebalance: '建议调平', hard: '尽快处理' };
/** The trading-status pill each level wears: green, amber, red. */
export const LEVEL_TONE: Record<BalanceLevel, 'live' | 'stale' | 'error'> = { ok: 'live', rebalance: 'stale', hard: 'error' };
const isLevel = (value: unknown): value is BalanceLevel => value === 'ok' || value === 'rebalance' || value === 'hard';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' ? value : null;
function leg(value: unknown): HynixBalanceLeg | null {
  if (!isObject(value) || typeof value.symbol !== 'string') return null;
  return { symbol: value.symbol, side: value.side === 'short' ? 'short' : 'long', quantity: text(value.quantity) ?? '—', price: text(value.price) ?? '—', notional: text(value.notional) ?? '—' };
}
function suggestion(value: unknown): RebalanceSuggestion {
  if (!isObject(value)) return { error: '没有建议' };
  if (typeof value.error === 'string') return { error: value.error };
  if (typeof value.symbol !== 'string' || typeof value.quantity !== 'string' || (value.side !== 'long' && value.side !== 'short')) return { error: '建议不完整' };
  return { symbol: value.symbol, side: value.side, action: value.action === 'close' ? 'close' : 'open', quantity: value.quantity };
}

/**
 * The balance block of the hynix state, or null when the service sends none (an older version) or something unreadable.
 * Rows are checked one by one: a row whose shape is off is shown as unavailable instead of failing the page.
 */
export function readBalance(raw: unknown): HynixBalanceView | null {
  if (!isObject(raw) || !isObject(raw.settings) || !Array.isArray(raw.venues)) return null;
  const s = raw.settings;
  const settings: HynixBalanceSettings = { rebalancePercent: text(s.rebalancePercent) ?? '', hardPercent: text(s.hardPercent) ?? '', minGapUsdt: text(s.minGapUsdt) ?? '' };
  const venues = raw.venues.filter(isObject).map((row): HynixBalanceRow => {
    const base = { venue: text(row.venue) ?? '—', positionsAt: typeof row.positionsAt === 'number' ? row.positionsAt : null, quotesAt: typeof row.quotesAt === 'number' ? row.quotesAt : null };
    const level = isLevel(row.level) ? row.level : 'hard';
    if (row.status === 'none') return { ...base, status: 'none', level: isLevel(row.level) ? row.level : 'ok' };
    if (row.status === 'unpaired') return { ...base, status: 'unpaired', reason: text(row.reason) ?? '两腿不成对', legs: Array.isArray(row.legs) ? row.legs.map(leg).filter((item): item is HynixBalanceLeg => item !== null) : [], level: 'hard' };
    if (row.status === 'paired') {
      const long = leg(row.long), short = leg(row.short);
      if (long && short) return {
        ...base, status: 'paired', long, short, gap: text(row.gap) ?? '—', netSide: row.netSide === 'long' || row.netSide === 'short' ? row.netSide : null, percent: text(row.percent) ?? '—', level,
        ...(isObject(row.suggest) ? { suggest: { reduce: suggestion(row.suggest.reduce), add: suggestion(row.suggest.add) } } : {}),
      };
      return { ...base, status: 'unavailable', reason: '读数不完整' };
    }
    return { ...base, status: 'unavailable', reason: text(row.reason) ?? '读数不可用' };
  });
  return { settings, settingsAvailable: raw.settingsAvailable !== false, settingsError: text(raw.settingsError), venues };
}

/** "0.9 股正股 · 360.18 USDT"-style parts of one leg. */
export const legParts = (item: HynixBalanceLeg): { name: string; quantity: string; notional: string } => ({ name: contractName(item.symbol), quantity: item.quantity, notional: usdt2(item.notional) });

/** The net exposure: "52.02 USDT · 净空", or "两腿相等" when the legs match. */
export function netText(gap: string, netSide: 'long' | 'short' | null): string {
  if (netSide === null) return `${usdt2(gap)} · 两腿相等`;
  return `${usdt2(gap)} · 净${netSide === 'long' ? '多' : '空'}`;
}

/** "减仓调平：平 1.26 份 ADR 空头", or the reason it is not offered. */
export function suggestionText(method: RebalanceMethod, item: RebalanceSuggestion | undefined): string {
  if (!item) return `${METHOD_LABEL[method]}：不提供`;
  if ('error' in item) return `${METHOD_LABEL[method]}：不提供（${item.error}）`;
  return `${METHOD_LABEL[method]}：${item.action === 'close' ? '平' : '加'} ${item.quantity} ${UNIT[item.symbol] ?? item.symbol}${item.symbol === 'SKHYNIXUSDT' ? '' : ' '}${sideName(item.side)}`;
}
export const suggestionUsable = (item: RebalanceSuggestion | undefined): boolean => !!item && !('error' in item);

/** The preview body (docs/hynix.md 7.3): no contract, side or quantity, the executor works them out; its default slippage. */
export function rebalanceIntent(venue: string, method: RebalanceMethod): { market: 'hynix'; preset: 'rebalance'; venue: string; method: RebalanceMethod; timeoutMs: number } {
  return { market: 'hynix', preset: 'rebalance', venue, method, timeoutMs: REBALANCE_TIMEOUT_MS };
}

/** The confirm dialog of a rebalance preview: venue, contract, side, quantity, the notional and the time allowed. */
export function rebalanceConfirmText(preview: Pick<HynixRebalancePreview, 'intent' | 'legs' | 'notional'>): string {
  const method = preview.intent?.method === 'add' ? 'add' : 'reduce';
  const item = preview.legs?.[0];
  const order = item ? `${method === 'reduce' ? '平' : '加'} ${venueLabel(item.venue)} ${contractName(item.symbol)} ${sideName(item.side)} ${item.quantity}${item.reduceOnly ? '（只减仓）' : ''}` : '调平委托';
  const seconds = Math.round((preview.intent?.timeoutMs ?? REBALANCE_TIMEOUT_MS) / 1000);
  const bound = item?.priceBound ? `，以价格保护界限 ${item.priceBound} 为 IOC 限价、未成交部分撤销` : '';
  return `实盘${METHOD_LABEL[method]}：${order}${bound}，名义金额约 ${preview.notional ?? '—'} USDT，${seconds} 秒内完成。确定发送到交易所？`;
}

export interface SettingsForm { rebalancePercent: string; hardPercent: string; minGapUsdt: string }
const PERCENT = /^(0|[1-9]\d?)(\.\d{1,2})?$/, USDT = /^(0|[1-9]\d{0,5})(\.\d{1,2})?$/;
/** The same rules as the service (0.1 ≤ rebalance line < hard limit ≤ 50, minimum gap 0–100000, two decimals at most). */
export function settingsFormError(form: SettingsForm): { settings: HynixBalanceSettings } | { error: string } {
  const rebalancePercent = form.rebalancePercent.trim(), hardPercent = form.hardPercent.trim(), minGapUsdt = form.minGapUsdt.trim();
  if (!PERCENT.test(rebalancePercent)) return { error: '调平线须为 0.1–50 之间的数，最多两位小数' };
  if (!PERCENT.test(hardPercent)) return { error: '硬上限须为 0.1–50 之间的数，最多两位小数' };
  if (!USDT.test(minGapUsdt)) return { error: '最小差额须为 0–100000 USDT，最多两位小数' };
  if (Number(rebalancePercent) < 0.1) return { error: '调平线不能低于 0.1%' };
  if (Number(hardPercent) > 50) return { error: '硬上限不能高于 50%' };
  if (Number(rebalancePercent) >= Number(hardPercent)) return { error: '调平线须低于硬上限' };
  if (Number(minGapUsdt) > 100000) return { error: '最小差额不能高于 100000 USDT' };
  return { settings: { rebalancePercent, hardPercent, minGapUsdt } };
}
export const sameSettings = (a: SettingsForm, b: SettingsForm): boolean => a.rebalancePercent === b.rebalancePercent && a.hardPercent === b.hardPercent && a.minGapUsdt === b.minGapUsdt;

/**
 * Whether the form follows the server's thresholds: only without unsaved edits, and after a save only once a read taken
 * after it has arrived, so an older poll answering late cannot put the old values back (L089). receivedAt is when a read
 * arrived, not when it was asked: the save must also refresh the state in the same tick (BalancePanel's onSaved), which
 * discards reads already in flight; without that refresh a read asked before the save could still pass this test.
 */
export const followsServer = (dirty: boolean, savedAt: number | null, receivedAt: number | null): boolean =>
  !dirty && (savedAt === null || (receivedAt !== null && receivedAt > savedAt));
