import { VENUE_NAMES, type ChainArbVenue } from './model.ts';
import { parseChainArbScan, type ScanInput, type ScanView } from './scan-model.ts';

export interface BackgroundSettings extends Omit<ScanInput, 'venue'> {
  enabled: boolean;
  venues: ChainArbVenue[];
  thresholdBps: number;
  fees?: Partial<Record<ChainArbVenue, { spotFeeBps: string; perpFeeBps: string }>>;
}

export interface BackgroundView {
  revision: number;
  settings: BackgroundSettings;
  robot: 'feishuMonitor' | 'feishu' | null;
  results: Partial<Record<ChainArbVenue, ScanView>>;
  error: string | null;
}

export const ALL_SCAN_VENUES = Object.keys(VENUE_NAMES) as ChainArbVenue[];
export const DEFAULT_BACKGROUND_SETTINGS: BackgroundSettings = {
  enabled: false, venues: ['gate', 'binance', 'bitget'], thresholdBps: 100,
  chain: 'all', amount: '1000', spotFeeBps: '10', perpFeeBps: '5', spotCosts: '0', perpCosts: '0',
};

export function parseBackgroundSettings(value: unknown): BackgroundSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('后台扫描设置无效');
  const { enabled, venues, thresholdBps, fees, ...params } = value as Record<string, unknown>;
  if (typeof enabled !== 'boolean') throw new Error('请选择后台扫描的启停状态');
  const supported = ALL_SCAN_VENUES;
  if (!Array.isArray(venues) || !venues.length || venues.length > supported.length || new Set(venues).size !== venues.length
    || !venues.every(venue => supported.includes(venue))) throw new Error('请选择有效的交易所，且不能重复');
  if (typeof thresholdBps !== 'number' || !Number.isFinite(thresholdBps) || thresholdBps < 0 || thresholdBps > 1_000_000)
    throw new Error('通知阈值须在 0 至 1000000 bp 之间');
  if ('venue' in params) throw new Error('后台扫描请使用交易所列表');
  const { chain, amount, spotFeeBps, perpFeeBps, spotCosts, perpCosts } = parseChainArbScan(params);
  const overrides: NonNullable<BackgroundSettings['fees']> = {};
  if (fees !== undefined) {
    if (!fees || typeof fees !== 'object' || Array.isArray(fees) || Object.keys(fees).some(key => !supported.includes(key as ChainArbVenue)))
      throw new Error('交易所费率设置无效');
    for (const venue of supported) {
      if (!Object.hasOwn(fees, venue)) continue;
      const entry = (fees as Record<string, unknown>)[venue];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
        || !Object.hasOwn(entry, 'spotFeeBps') || !Object.hasOwn(entry, 'perpFeeBps')) throw new Error('请填写该交易所两条路线的费率');
      const rates = parseChainArbScan({ ...params, ...entry });
      overrides[venue] = { spotFeeBps: rates.spotFeeBps, perpFeeBps: rates.perpFeeBps };
    }
  }
  return { enabled, venues: supported.filter(venue => venues.includes(venue)), thresholdBps,
    chain, amount, spotFeeBps, perpFeeBps, spotCosts, perpCosts, ...(Object.keys(overrides).length ? { fees: overrides } : {}) };
}
