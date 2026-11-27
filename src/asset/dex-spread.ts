// Deduplication and aggregation of DEX spread accounts (Lighter mainnet, Lighter RH, Entropy) into the asset ledger.
// Plaintext addresses and account indices are never written to asset.sqlite settings, asset details or logs: only
// domain-tagged SHA-256 fingerprints (`accountHash`, `l1Hash`, `walletHash`, `indexHashes`) are stored for deduplication.
import { createHash } from 'node:crypto';
import type { KeyVenue } from '../dex/keys.ts';
import type { AssetDb } from './db.ts';
import { sumKnownValues } from './asset-values.ts';
import type { Asset, Balance } from './types.ts';
import { saveSetting } from './writes.ts';

export type DexVenue = KeyVenue;
export const DEX_SPREAD_ACCOUNTS_KEY = 'dex-spread-accounts';
export const DEX_DEDUP_IDENTITIES_KEY = 'dex-dedup-identities';
export const DEX_SPREAD_VENUE_NAMES: Record<DexVenue, string> = {
  lighter: 'Lighter 主网',
  rh: 'Lighter RH',
  entropy: 'Entropy（Hyperliquid）',
};

const VALID_VENUES = new Set<string>(['lighter', 'rh', 'entropy']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const digest = (tag: string, text: string): string => createHash('sha256').update(`${tag}:${text}`).digest('hex');
export const hashAddress = (address: string): string => digest('addr', address.trim().toLowerCase());
export const hashRhIndex = (accountIndex: number): string => digest('rh', String(accountIndex));
export const hashLighterIndex = (accountIndex: number): string => digest('lighter', String(accountIndex));

export interface DexSpreadStoredAccount {
  venue: DexVenue;
  accountHash: string;
  l1Hash?: string;
  value: number | null;
  details: Balance[];
  updatedAt: string;
  error: string | null;
}

export interface DexSpreadStoredState {
  accounts: DexSpreadStoredAccount[];
  deduped: DexVenue[];
}

export interface DexDedupIdentities {
  hyperliquid?: { walletHash: string };
  'rh-lighter'?: { walletHash: string; indexHashes?: string[] };
}

function validBalance(item: unknown): item is Balance {
  return isRecord(item) && typeof item.coin === 'string' && typeof item.account === 'string' &&
    typeof item.quantity === 'number' && Number.isFinite(item.quantity) &&
    typeof item.value === 'number' && Number.isFinite(item.value) &&
    typeof item.price === 'number' && Number.isFinite(item.price);
}

export function readDexSpreadState(raw: string | undefined): DexSpreadStoredState {
  if (!raw) return { accounts: [], deduped: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { accounts: [], deduped: [] }; }
  if (!isRecord(parsed)) return { accounts: [], deduped: [] };
  const accounts: DexSpreadStoredAccount[] = [];
  if (Array.isArray(parsed.accounts)) {
    for (const item of parsed.accounts) {
      if (!isRecord(item) || typeof item.venue !== 'string' || !VALID_VENUES.has(item.venue)) continue;
      if (typeof item.accountHash !== 'string' || !item.accountHash) continue;
      if (item.value !== null && (typeof item.value !== 'number' || !Number.isFinite(item.value))) continue;
      if (!Array.isArray(item.details) || !item.details.every(validBalance)) continue;
      if (typeof item.updatedAt !== 'string') continue;
      if (item.error !== null && typeof item.error !== 'string') continue;
      accounts.push({
        venue: item.venue as DexVenue,
        accountHash: item.accountHash,
        ...(typeof item.l1Hash === 'string' && item.l1Hash ? { l1Hash: item.l1Hash } : {}),
        value: item.value,
        details: item.details,
        updatedAt: item.updatedAt,
        error: item.error,
      });
    }
  }
  const deduped = Array.isArray(parsed.deduped)
    ? [...new Set(parsed.deduped.filter((item): item is DexVenue => typeof item === 'string' && VALID_VENUES.has(item)))]
    : [];
  return { accounts, deduped };
}

export function readDedupIdentities(raw: string | undefined): DexDedupIdentities {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!isRecord(parsed)) return {};
  const result: DexDedupIdentities = {};
  if (isRecord(parsed.hyperliquid) && typeof parsed.hyperliquid.walletHash === 'string' && parsed.hyperliquid.walletHash) {
    result.hyperliquid = { walletHash: parsed.hyperliquid.walletHash };
  }
  const rh = parsed['rh-lighter'];
  if (isRecord(rh) && typeof rh.walletHash === 'string' && rh.walletHash) {
    const indexHashes = Array.isArray(rh.indexHashes)
      ? [...new Set(rh.indexHashes.filter((item): item is string => typeof item === 'string' && item.length > 0))]
      : undefined;
    result['rh-lighter'] = { walletHash: rh.walletHash, ...(indexHashes ? { indexHashes } : {}) };
  }
  return result;
}

export function rowOrder(id: string): number {
  return /^row-(\d+)$/.test(id) ? Number(id.slice(4)) : Number.MAX_SAFE_INTEGER;
}

export function nextRowAllocation(assets: readonly Pick<Asset, 'id'>[]): { id: string; cell: string } {
  let max = 0;
  for (const asset of assets) {
    const match = /^row-(\d+)$/.exec(asset.id);
    if (!match) continue;
    const num = Number(match[1]);
    if (Number.isSafeInteger(num) && num > max) max = num;
  }
  const next = max + 1;
  if (assets.length >= 1000 || !Number.isSafeInteger(next) || next > 999999) throw new Error('资产条目已达到上限');
  return { id: 'row-' + next, cell: 'E' + next };
}

export function aggregateDexSpread(
  state: DexSpreadStoredState,
  existingAsset: Asset | undefined,
  allocateId: () => { id: string; cell: string },
  nowIso: string,
): Asset | null {
  if (!state.accounts.length) return null;
  const values = sumKnownValues(state.accounts);
  const value = values.partial ? null : values.total;
  const errors = state.accounts
    .filter(account => account.error || account.value === null || !Number.isFinite(account.value))
    .map(account => `${DEX_SPREAD_VENUE_NAMES[account.venue]}：${account.error || '估值缺失'}`);
  const updatedAt = state.accounts.reduce((oldest, account) => {
    const t = Date.parse(account.updatedAt), o = Date.parse(oldest);
    return Number.isFinite(t) && (!Number.isFinite(o) || t < o) ? account.updatedAt : oldest;
  }, nowIso);
  const details: Balance[] = state.accounts.flatMap(account =>
    account.details.map(line => ({ ...line, account: `${DEX_SPREAD_VENUE_NAMES[account.venue]} / ${line.account}` }))
  );
  if (state.deduped.length > 0) {
    const names = [...new Set(state.deduped)].map(venue => DEX_SPREAD_VENUE_NAMES[venue]).join('、');
    details.push({ coin: '—', account: `已去重（已在资产连接中计入）：${names}`, quantity: 0, price: 0, value: 0 });
  }
  const status = values.partial
    ? '部分账号估值缺失'
    : errors.length
      ? '部分账号未更新 · 保留旧值'
      : `只读同步 · ${state.accounts.length} 个账号`;
  const identity = existingAsset ? { id: existingAsset.id, cell: existingAsset.cell } : allocateId();
  return {
    id: identity.id,
    project: existingAsset?.project ?? 'DEX 价差',
    kind: existingAsset?.kind ?? '资产',
    quantity: value,
    price: 1,
    value,
    cell: identity.cell,
    mode: 'dex-spread',
    updatedAt,
    status,
    error: errors.join('；') || undefined,
    details,
  };
}

type Database = Pick<AssetDb, 'prepare'>;
export function readStoredSetting(database: Database, key: string): string | undefined {
  return database.prepare('SELECT value FROM settings WHERE key = ?').bind(key).get<{ value: string }>()?.value;
}

export function updateDedupIdentity(
  database: Database,
  exchange: 'hyperliquid' | 'rh-lighter',
  identity: { walletHash: string; indexHashes?: string[] } | undefined,
): void {
  const current = readDedupIdentities(readStoredSetting(database, DEX_DEDUP_IDENTITIES_KEY));
  if (identity === undefined) {
    delete current[exchange];
  } else if (exchange === 'hyperliquid') {
    current.hyperliquid = { walletHash: identity.walletHash };
  } else {
    const preserved = current['rh-lighter']?.walletHash === identity.walletHash ? current['rh-lighter'].indexHashes : undefined;
    const merged = identity.indexHashes ?? preserved;
    current['rh-lighter'] = { walletHash: identity.walletHash, ...(merged ? { indexHashes: [...new Set(merged)] } : {}) };
  }
  saveSetting(database, DEX_DEDUP_IDENTITIES_KEY, current);
}

/** Updates dedup identities and atomically strips newly duplicated DEX spread accounts inside the connect transaction. */
export function pruneDexSpreadOnConnect(
  database: Database,
  exchange: 'hyperliquid' | 'rh-lighter',
  identity: { walletHash: string; indexHashes?: string[] },
  nowIso: string,
): () => void {
  return () => {
    updateDedupIdentity(database, exchange, identity);
    const state = readDexSpreadState(readStoredSetting(database, DEX_SPREAD_ACCOUNTS_KEY));
    if (!state.accounts.length) return;
    const venue: DexVenue = exchange === 'hyperliquid' ? 'entropy' : 'rh';
    const indexSet = identity.indexHashes ? new Set(identity.indexHashes) : null;
    const matches = (item: DexSpreadStoredAccount) => {
      if (item.venue !== venue) return false;
      if (venue === 'entropy') return item.accountHash === identity.walletHash;
      return item.l1Hash === identity.walletHash || (indexSet !== null && indexSet.has(item.accountHash));
    };
    const kept = state.accounts.filter(item => !matches(item));
    if (kept.length === state.accounts.length) return;
    const nextState: DexSpreadStoredState = {
      accounts: kept,
      deduped: state.deduped.includes(venue) ? state.deduped : [...state.deduped, venue],
    };
    saveSetting(database, DEX_SPREAD_ACCOUNTS_KEY, nextState);
    const rows = database.prepare('SELECT id, data FROM assets').rows<{ id: string; data: string }>();
    const existing = rows.map(row => JSON.parse(row.data) as Asset).find(asset => asset.mode === 'dex-spread');
    if (!existing) return;
    const aggregated = aggregateDexSpread(nextState, existing, () => ({ id: existing.id, cell: existing.cell }), nowIso);
    if (aggregated === null) {
      database.prepare('DELETE FROM assets WHERE id = ?').bind(existing.id).run();
    } else {
      database.prepare('UPDATE assets SET data = ? WHERE id = ?').bind(JSON.stringify(aggregated), aggregated.id).run();
    }
  };
}
