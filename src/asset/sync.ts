// The connection writes and the exchange sync of A-3/A-4. Adapted from project_aggregation modules/asset/lib/store.ts at
// 0014655: connect, disconnect, asterStatements, connectAsterAccount, deleteAsterAccount and refresh. The rules, the
// statuses and the messages are the workbench's. Changes:
// - no owner; the caller (store.ts) parses the body and holds the sync lock (sync-lock.ts); every write goes through
//   lease.write, which also refuses once the ledger was imported again (the import replaces it without the lock);
// - a change and its daily snapshot are written in one transaction: the snapshot is computed from the ledger read
//   inside that transaction (currentLedger) after the change (the workbench commits the change, then reads the ledger
//   and commits the snapshot in a second transaction). The sync writes each source in its own transaction, as the
//   workbench does, and the snapshot last;
// - the credentials are sealed with this data directory's key (credentials.ts), the additional data being the
//   connection name alone;
// - the reads (exchanges, quotes, the yuan rate) come from an injected AssetSources (the copied src/asset/sources/*
//   functions with an injected fetch by default); each request times out after 12 s (Variational's python read 20 s,
//   23 s in all) and is not retried
//   (sources/http.ts); a failed read marks that row "同步失败 · 保留旧值" and its `<exchange>-status` error, the next
//   sync (the page asks every 60 s while open) reads again;
// - the timestamps come from the injected clock;
// - disconnect clears the fill cache of that connection in the same transaction (A-5), as the workbench does;
// - the daily snapshot carries the cached positions through the context's peek (A-5; writes.ts saveSnapshot);
// - a read that returns the quote it converted with (Hyperliquid's USDC/USD) stores it on the row as `quote`, so every
//   later daily snapshot of that row keeps the price, its source and times for the position attribution (issue #63);
// - an Aster account write needs the ledger's Aster row: without one it is refused with the connect message
//   '未找到交易所资产' before anything is read (the workbench would fail on the missing row while writing);
// - the market row is refreshed only when the ledger has one (the workbench assumes it);
// - a source's result and its failure are written by one statement list (the workbench writes the failure from the
//   catch around both the read and the write); a refusal of the write itself (lease lost, imported again, database
//   error) is not recorded as the source's failure but ends the sync with that refusal.
import type { AssetDb } from './db.ts';
import type { DexAccountsState } from '../dex/keys.ts';
import { historyGeneration } from './history-cache.ts';
import { revisionOf } from './positions-service.ts';
import { PositionsPermissionError } from './positions-values.ts';
import { AssetConflict, type SyncLease } from './sync-lock.ts';
import type { Asset, AsterAccount, Balance, FxStatus, Ledger, QuoteEvidence } from './types.ts';
import type { Vault } from './credentials.ts';
import { asterKey, aggregateAster, mergeAsterRefresh, readAsterAccounts, type AsterRefresh } from './aster-accounts.ts';
import { knownAssetValue, refreshMarketAsset } from './asset-values.ts';
import { isGateProject, isHyperliquidProject, isVariationalProject } from './source-ledger.ts';
import { saveSetting, saveSnapshot, type PositionsPeek } from './writes.ts';
import {
  aggregateDexSpread, DEX_DEDUP_IDENTITIES_KEY, DEX_SPREAD_ACCOUNTS_KEY, DEX_SPREAD_VENUE_NAMES, hashAddress,
  hashLighterIndex, hashRhIndex, nextRowAllocation, pruneDexSpreadOnConnect, readDedupIdentities, readDexSpreadState,
  readStoredSetting, updateDedupIdentity, type DexSpreadStoredAccount, type DexSpreadStoredState, type DexVenue,
} from './dex-spread.ts';
// store.ts imports this module too; the cycle is safe, nothing is called while the modules load.
import { currentLedger } from './store.ts';
import { parseConnection, type AsterAccountInput, type ConnectionExchange, type Credentials } from './validation.ts';
import { mapConcurrent, settleIndependent } from './sources/concurrency.ts';
import type { Fetcher } from './sources/http.ts';
import { sharePublicReads } from './sources/shared-reads.ts';
import type { Quote } from './sources/quotes.ts';
import { quotes } from './sources/quotes.ts';
import { syncBinance, syncBybit, type BinanceCredential, type BybitCredential } from './sources/exchanges.ts';
import { syncAster, validateAsterWallet, type AsterCredential, type AsterWallet } from './sources/aster.ts';
import { syncOkx, type OkxCredential } from './sources/okx.ts';
import type { BitgetCredential } from './sources/bitget-deposit.ts';
import { syncGate, type GateCredential } from './sources/gate.ts';
import { syncHyperliquid, type HyperliquidCredential } from './sources/hyperliquid.ts';
import { readRhLighterSnapshot, syncRhLighter, type RhLighterCredential } from './sources/rh-lighter.ts';
import { syncLighterAccount, syncRhLighterAccount, type LighterIndexRead } from './sources/lighter-account.ts';
import { syncVariational, type VariationalCredential } from './sources/variational.ts';
import { yuanQuote } from './sources/fx.ts';

type Prices = Record<string, Quote>;
type Read = { total: number; details: Balance[]; updatedAt?: string; quote?: QuoteEvidence };
type DatedRead = Read & { updatedAt: string };
/** The external reads, as the workbench's lib modules export them. */
export interface AssetSources {
  quotes(): Promise<Prices>;
  yuanQuote(now: number): Promise<{ rate: number; status: FxStatus }>;
  syncBinance(c: BinanceCredential, prices: Prices): Promise<Read>;
  syncBybit(c: BybitCredential, prices: Prices): Promise<Read>;
  syncAster(c: AsterCredential, prices: Prices): Promise<Read>;
  validateAsterWallet(c: AsterCredential): Pick<AsterWallet, 'address'>;
  syncOkx(c: OkxCredential): Promise<DatedRead>;
  syncGate(c: GateCredential): Promise<DatedRead>;
  syncVariational(c: VariationalCredential): Promise<DatedRead>;
  syncHyperliquid(c: HyperliquidCredential, options: { verifyRole?: boolean }): Promise<DatedRead>;
  syncRhLighter(c: RhLighterCredential): Promise<DatedRead>;
  syncLighterAccount?(accountIndex: number): Promise<LighterIndexRead>;
  syncRhLighterAccount?(accountIndex: number): Promise<LighterIndexRead>;
  rhLighterAccountIndices?(c: RhLighterCredential): Promise<number[]>;
}
/** The copied readers over `fetcher`; Variational reads its portfolio through python3 (sources/variational-python.ts). */
export function liveSources(source: Fetcher = fetch, shared = sharePublicReads(source)): AssetSources {
  // One wrapper for the life of the store, the one its positions service also reads through: the Hyperliquid readers
  // key their market and token-name caches by the fetcher they are given.
  const { fetcher } = shared;
  return {
    quotes: () => quotes(fetcher),
    yuanQuote: now => yuanQuote(fetcher, now),
    syncBinance: (c, prices) => syncBinance(c, prices, fetcher),
    syncBybit: (c, prices) => syncBybit(c, prices, fetcher),
    syncAster: (c, prices) => syncAster(c, prices, fetcher),
    validateAsterWallet,
    syncOkx: c => syncOkx(c, fetcher),
    syncGate: c => syncGate(c, fetcher),
    syncVariational: c => syncVariational(c, fetcher),
    syncHyperliquid: (c, options) => syncHyperliquid(c, fetcher, options),
    syncRhLighter: c => syncRhLighter(c, fetcher),
    syncLighterAccount: accountIndex => syncLighterAccount(accountIndex, fetcher),
    syncRhLighterAccount: accountIndex => syncRhLighterAccount(accountIndex, fetcher),
    rhLighterAccountIndices: c => readRhLighterSnapshot(c.walletAddress, fetcher).then(snapshot => snapshot.accounts.map(account => account.index)),
  };
}

export interface SyncContext {
  database: AssetDb;
  lease: SyncLease;
  vault: Vault;
  sources: AssetSources;
  now: () => number;
  /** The cached positions for the daily snapshot (A-5); none leaves `positions` out. */
  positions?: PositionsPeek;
  /** Read-only DEX spread account identifiers from the DEX service; omitted when DEX spread is disabled. */
  dexAccounts?: () => Promise<DexAccountsState>;
}
type Run = () => void;
const iso = (at: number) => new Date(at).toISOString();
/**
 * A read's values with the quote evidence of that same read (issue #63): a read without one drops the row's earlier
 * evidence, so a quote never stays with values it did not price. A failed read keeps the old values and their evidence.
 */
const withQuote = (asset: Asset, result: Pick<Read, 'quote'>): Asset => {
  const { quote: _previous, ...rest } = asset;
  return result.quote ? { ...rest, quote: result.quote } : rest;
};
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

const assetStatement = (database: AssetDb, asset: Asset): Run => () => { database.prepare('UPDATE assets SET data = ? WHERE id = ?').bind(JSON.stringify(asset), asset.id).run(); };
const upsertAsset = (database: AssetDb, asset: Asset): Run => () => { database.prepare('INSERT INTO assets(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(asset.id, JSON.stringify(asset)).run(); };
const settingStatement = (database: AssetDb, key: string, value: unknown): Run => () => { saveSetting(database, key, value); };
const saveConnection = (database: AssetDb, name: string, encrypted: string, at: number): Run => () => {
  database.prepare('DELETE FROM asset_history_windows WHERE account = ?').bind(name).run();
  database.prepare('DELETE FROM asset_position_snapshots WHERE account = ?').bind(name).run();
  database.prepare('INSERT INTO connections(exchange,encrypted,updated_at) VALUES(?,?,?) ON CONFLICT(exchange) DO UPDATE SET encrypted=excluded.encrypted,updated_at=excluded.updated_at').bind(name, encrypted, iso(at)).run();
};
const deleteConnection = (database: AssetDb, name: string): Run => () => { database.prepare('DELETE FROM connections WHERE exchange = ?').bind(name).run(); };
const storedConnection = (database: Pick<AssetDb, 'prepare'>, name: string) => database.prepare('SELECT encrypted FROM connections WHERE exchange = ?').bind(name).get<{ encrypted: string }>();
const asterConnections = (database: Pick<AssetDb, 'prepare'>) => database.prepare("SELECT exchange,encrypted FROM connections WHERE exchange = 'aster' OR exchange LIKE 'aster:%'").rows<{ exchange: string; encrypted: string }>();

/** Runs the statements and the daily snapshot of the ledger they leave, in one lease transaction. */
function commit(ctx: SyncContext, statements: Run[]): void {
  const at = ctx.now();
  ctx.lease.write(() => {
    for (const run of statements) run();
    snapshotNow(ctx, at);
  });
}
/** The workbench's snapshot(), inside a transaction already open. */
function snapshotNow(ctx: SyncContext, at: number): void { saveSnapshot(ctx.database, currentLedger(ctx.database, at), at, ctx.positions); }
const ledgerReader = currentLedger;

const MATCHED_BY_PROJECT: Partial<Record<ConnectionExchange, (project: string) => boolean>> = {
  variational: isVariationalProject, gate: isGateProject, hyperliquid: isHyperliquidProject,
  binance: project => project.trim().toLowerCase() === 'binance', okx: project => project.trim().toLowerCase() === 'okx',
};
const CREATABLE: readonly ConnectionExchange[] = ['binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'];

// This connection proves deposit routes only. Keep the balances, manually valued Bitget rows and daily snapshots intact.
export function saveBitgetConnection(ctx: SyncContext, c: BitgetCredential, verifiedAt: number) {
  const status = { configured: true, accountMode: c.accountMode, lastSync: iso(verifiedAt), error: null,
    scope: c.accountMode === 'uta' ? '统一账户充值核验' : '经典账户充值核验' };
  return ctx.lease.write(() => {
    const saved = storedConnection(ctx.database, 'bitget');
    let same = false;
    if (saved) {
      try {
        const prior = parseConnection(ctx.vault.unseal(saved.encrypted, 'bitget'));
        same = prior.exchange === 'bitget' && prior.accountMode === c.accountMode && prior.apiKey === c.apiKey &&
          prior.apiSecret === c.apiSecret && prior.passphrase === c.passphrase;
      } catch { /* A newly verified connection can replace damaged ciphertext. */ }
    }
    // Preserve the generation across verification of the same key, including explicit refusals still in flight.
    if (!same) saveConnection(ctx.database, 'bitget', ctx.vault.seal(c, 'bitget'), ctx.now())();
    saveSetting(ctx.database, 'bitget-status', status);
    return !same;
  });
}

export async function connect(ctx: SyncContext, input: Exclude<Credentials, BitgetCredential>): Promise<void> {
  if (input.exchange === 'aster') return connectAsterAccount(ctx, { ...input, id: 'default', name: '默认账号' }, 'legacy');
  const { database, sources, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now());
  const byProject = MATCHED_BY_PROJECT[input.exchange];
  const matches = ledger.assets.filter(a => a.mode === input.exchange || (a.mode === 'manual' && !!byProject?.(a.project)));
  if (matches.length > 1) throw new Error('已有多条交易所资产，请先合并重复记录');
  let asset = matches[0];
  if (!asset) {
    if (!CREATABLE.includes(input.exchange)) throw new Error('未找到交易所资产');
    const allocated = nextRowAllocation(ledger.assets);
    asset = { id: allocated.id, project: input.exchange === 'variational' ? 'var' : input.exchange === 'hyperliquid' ? 'Hyperliquid' : input.exchange === 'rh-lighter' ? 'Lighter RH' : input.exchange, kind: '资产', quantity: 0, price: 1, value: 0, cell: allocated.cell, mode: input.exchange, updatedAt: '', status: '' };
  }
  const encrypted = vault.seal(input, input.exchange);
  const result: Read & { updatedAt?: string } =
    input.exchange === 'variational' ? await sources.syncVariational(input)
      : input.exchange === 'okx' ? await sources.syncOkx(input)
        : input.exchange === 'gate' ? await sources.syncGate(input)
          : input.exchange === 'hyperliquid' ? await sources.syncHyperliquid(input, { verifyRole: true })
            : input.exchange === 'rh-lighter' ? await sources.syncRhLighter(input)
              : await (async () => {
                const prices = await sources.quotes();
                return input.exchange === 'binance' ? sources.syncBinance(input, prices) : sources.syncBybit(input, prices);
              })();
  const at = ctx.now(), now = iso(at);
  const updatedAt = result.updatedAt ?? now;
  const status = input.exchange === 'gate' || input.exchange === 'hyperliquid' ? '只读同步 · 估值时间' : input.exchange === 'variational' || input.exchange === 'rh-lighter' ? '只读同步 · 获取时间' : '只读同步';
  const next: Asset = { ...withQuote(asset, result), mode: input.exchange, quantity: result.total, price: 1, value: result.total, status, updatedAt, error: undefined, details: result.details };
  const label = input.exchange === 'variational' ? {} : { label: input.exchange === 'hyperliquid' || input.exchange === 'rh-lighter' ? input.walletAddress.slice(-4) : input.apiKey.slice(-4) };
  const connection = { configured: true, lastSync: now, error: null, scope: ledger.connections[input.exchange].scope, ...label };
  let rhIndexHashes: string[] | undefined;
  if (input.exchange === 'rh-lighter' && sources.rhLighterAccountIndices) {
    try { rhIndexHashes = (await sources.rhLighterAccountIndices(input)).map(hashRhIndex); } catch { rhIndexHashes = undefined; }
  }
  const extra = input.exchange === 'hyperliquid'
    ? [pruneDexSpreadOnConnect(database, 'hyperliquid', { walletHash: hashAddress(input.walletAddress) }, now)]
    : input.exchange === 'rh-lighter'
      ? [pruneDexSpreadOnConnect(database, 'rh-lighter', { walletHash: hashAddress(input.walletAddress), ...(rhIndexHashes ? { indexHashes: rhIndexHashes } : {}) }, now)]
      : [];
  // Persist a verified connection and its balance together; failed verification changes neither.
  commit(ctx, [saveConnection(database, input.exchange, encrypted, at), upsertAsset(database, next), settingStatement(database, input.exchange + '-status', connection), ...extra]);
}

export async function disconnect(ctx: SyncContext, exchange: ConnectionExchange): Promise<void> {
  if (exchange === 'bitget') {
    ctx.lease.write(() => {
      deleteConnection(ctx.database, exchange)();
      ctx.database.prepare("DELETE FROM settings WHERE key='bitget-status'").run();
    });
    return;
  }
  if (exchange === 'aster') return deleteAsterAccount(ctx, 'default', 'disconnect');
  const { database } = ctx;
  const ledger = ledgerReader(database, ctx.now()), asset = ledger.assets.find(a => a.mode === exchange);
  commit(ctx, [
    deleteConnection(database, exchange),
    () => { database.prepare('DELETE FROM fill_cache WHERE account = ?').bind(exchange).run(); },
    () => { database.prepare('DELETE FROM asset_history_windows WHERE account = ?').bind(exchange).run(); },
    () => { database.prepare('DELETE FROM asset_position_snapshots WHERE account = ?').bind(exchange).run(); },
    settingStatement(database, exchange + '-status', { configured: false, lastSync: ledger.connections[exchange].lastSync, error: null, scope: ledger.connections[exchange].scope }),
    ...(asset ? [assetStatement(database, { ...asset, status: '已断开 · 保留旧值', error: undefined })] : []),
  ]);
}

function asterStatements(database: AssetDb, accounts: AsterAccount[], asset: Asset, at: number, credential?: { key: string; encrypted?: string }): Run[] {
  const aggregate = aggregateAster(accounts, asset, iso(at));
  const statements = [settingStatement(database, 'aster-accounts', accounts), settingStatement(database, 'aster-status', aggregate.connection), assetStatement(database, aggregate.asset)];
  if (credential) statements.push(credential.encrypted === undefined ? deleteConnection(database, credential.key) : saveConnection(database, credential.key, credential.encrypted, at));
  return statements;
}
const asterAsset = (ledger: Ledger): Asset => {
  const asset = ledger.assets.find(a => a.mode === 'aster');
  if (!asset) throw new Error('未找到交易所资产');
  return asset;
};
const walletOf = (value: unknown): string | undefined => {
  const address = (value as { walletAddress?: unknown } | null)?.walletAddress;
  return typeof address === 'string' ? address : undefined;
};

export async function connectAsterAccount(ctx: SyncContext, input: AsterAccountInput, editing: boolean | 'legacy'): Promise<void> {
  const { database, sources, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now()), accounts = ledger.asterAccounts, existing = accounts.find(a => a.id === input.id);
  if (editing === true && !existing) throw new Error('未找到该 Aster 账号，请刷新页面');
  if (editing === false && existing) throw new Error('账号已存在，请使用更新连接');
  if (!existing && accounts.length >= 10) throw new Error('最多添加 10 个 Aster 账号');
  if (accounts.some(a => a.id !== input.id && a.name === input.name)) throw new Error('账号名称已存在');
  const asset = asterAsset(ledger);
  const credentials: AsterCredential & { exchange: 'aster' } = { exchange: 'aster', walletAddress: input.walletAddress, privateKey: input.privateKey, includeSpot: input.includeSpot };
  const wallet = sources.validateAsterWallet(credentials), key = asterKey(input.id);
  if (accounts.some(a => a.id !== input.id && a.walletAddress?.toLowerCase() === wallet.address.toLowerCase())) throw new Error('该 API 钱包已存在，请更新或移除已有账号');
  for (const row of asterConnections(database)) {
    if (row.exchange === key) continue;
    let other: string | undefined;
    try { other = walletOf(vault.unseal(row.encrypted, row.exchange)); } catch { throw new Error('已有 Aster 连接无法读取，请先更新或移除异常账号'); }
    if (other?.toLowerCase() === wallet.address.toLowerCase()) throw new Error('该 API 钱包已连接，请更新已有账号');
    const account = accounts.find(a => asterKey(a.id) === row.exchange);
    if (account) account.walletAddress = other;
  }
  const encrypted = vault.seal(credentials, key);
  const result = await sources.syncAster(credentials, await sources.quotes());
  const at = ctx.now(), now = iso(at);
  const account: AsterAccount = { id: input.id, name: input.name, includeSpot: input.includeSpot, walletAddress: wallet.address, configured: true, lastSync: now, updatedAt: result.updatedAt ?? now, error: null, scope: input.includeSpot ? 'API Pro · 合约 + 现货' : 'API Pro · 合约净权益', label: wallet.address.slice(-4), value: result.total, details: result.details };
  commit(ctx, asterStatements(database, existing ? accounts.map(a => a.id === input.id ? account : a) : [...accounts, account], asset, at, { key, encrypted }));
}

export async function deleteAsterAccount(ctx: SyncContext, id: string, action: 'disconnect' | 'remove'): Promise<void> {
  const { database, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now()), existing = ledger.asterAccounts.find(a => a.id === id);
  if (!existing) throw new Error('未找到该 Aster 账号，请刷新页面');
  const asset = asterAsset(ledger);
  if (action === 'disconnect' && !existing.walletAddress) {
    const row = storedConnection(database, asterKey(id));
    if (row) { try { existing.walletAddress = walletOf(vault.unseal(row.encrypted, asterKey(id))); } catch { /* A broken connection can still be disconnected. */ } }
  }
  const accounts = action === 'remove' ? ledger.asterAccounts.filter(a => a.id !== id) : ledger.asterAccounts.map(a => a.id === id ? { ...a, configured: false, error: null } : a);
  commit(ctx, asterStatements(database, accounts, asset, ctx.now(), { key: asterKey(id) }));
}

/** A sync within this long of the last attempt answers the ledger as it is (the workbench's refresh). */
export const SYNC_THROTTLE_MS = 30_000;
type Stored = { exchange: string; encrypted: string };
type DatedSource = 'okx' | 'gate' | 'variational' | 'hyperliquid' | 'rh-lighter';
/** Each dated source's asset-row message, valuation status and the prefix its own messages start with (others are hidden). */
const DATED: Record<DatedSource, { missing: string; status: string; prefix: string | null; hidden: string }> = {
  okx: { missing: '未找到交易所资产，请更新连接', status: '只读同步', prefix: null, hidden: '同步暂时失败' },
  gate: { missing: 'Gate 资产记录不存在，请更新连接', status: '只读同步 · 估值时间', prefix: 'Gate ', hidden: 'Gate 同步失败，请更新连接或稍后重试；已保留上次数据' },
  variational: { missing: '未找到 Var 资产，请更新连接', status: '只读同步 · 获取时间', prefix: 'Var ', hidden: 'Var 同步失败，请更新会话或稍后重试；已保留上次数据' },
  hyperliquid: { missing: 'Hyperliquid 资产记录不存在，请更新连接', status: '只读同步 · 估值时间', prefix: 'Hyperliquid ', hidden: 'Hyperliquid 同步失败，请更新连接或稍后重试；已保留上次数据' },
  'rh-lighter': { missing: 'Lighter RH 资产记录不存在，请更新连接', status: '只读同步 · 获取时间', prefix: 'Lighter RH ', hidden: 'Lighter RH 同步失败，请更新连接或稍后重试；已保留上次数据' },
};

/** The workbench's refresh(): false when it was skipped (an attempt less than 30 s ago). */
export async function refresh(ctx: SyncContext, refreshPositions?: () => Promise<void>): Promise<boolean> {
  const { database, lease, sources, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now());
  const last = database.prepare("SELECT value FROM settings WHERE key = 'last-attempt'").get<{ value: string }>();
  if (last && ctx.now() - Number(last.value) < SYNC_THROTTLE_MS) return false;
  lease.write(() => saveSetting(database, 'last-attempt', String(ctx.now())));
  const stored = database.prepare('SELECT exchange,encrypted FROM connections').rows<Stored>();
  const hlConn = stored.find(item => item.exchange === 'hyperliquid');
  const rhConn = stored.find(item => item.exchange === 'rh-lighter');
  const unsealWalletHash = (row: Stored | undefined, exchange: 'hyperliquid' | 'rh-lighter'): { status: 'none' } | { status: 'ok'; walletHash: string } | { status: 'error' } => {
    if (!row) return { status: 'none' };
    try {
      const cred = vault.unseal(row.encrypted, exchange) as { walletAddress?: unknown };
      return typeof cred?.walletAddress === 'string' && cred.walletAddress ? { status: 'ok', walletHash: hashAddress(cred.walletAddress) } : { status: 'error' };
    } catch {
      return { status: 'error' };
    }
  };
  const hlIdentity = unsealWalletHash(hlConn, 'hyperliquid');
  const rhIdentity = unsealWalletHash(rhConn, 'rh-lighter');
  type RhRoundInfo =
    | { status: 'none' }
    | { status: 'decrypt_error' }
    | { status: 'ok'; walletHash: string; indices?: number[] }
    | { status: 'failed'; walletHash: string };
  let resolveRhRound: ((info: RhRoundInfo) => void) | null = null;
  const rhRoundPromise: Promise<RhRoundInfo> = rhIdentity.status === 'none'
    ? Promise.resolve({ status: 'none' })
    : rhIdentity.status === 'error'
      ? Promise.resolve({ status: 'decrypt_error' })
      : new Promise<RhRoundInfo>(resolve => { resolveRhRound = resolve; });

  // A source result is written only while its credential is still the one read here; the check shares the lease transaction.
  const sourceWrite = (row: Stored, statements: Run[]) => lease.write(() => {
    if (storedConnection(database, row.exchange)?.encrypted === row.encrypted) for (const run of statements) run();
  });
  /** Reads one source and writes its result, or its failure with the old values kept. */
  async function source(exchange: ConnectionExchange, read: (row: Stored, asset: Asset) => Promise<{ asset: Asset }>, failure: (error: unknown) => string, extraOnSuccess: Run[] = []): Promise<void> {
    const row = stored.find(item => item.exchange === exchange);
    if (!row) return;
    const revision = revisionOf(row.encrypted);
    const permission = (exchange === 'binance' || exchange === 'bybit' || exchange === 'okx' || exchange === 'gate') && storedConnection(database, exchange)?.encrypted === row.encrypted
      ? historyGeneration(() => database, exchange, revision, ctx.now) : null;
    const asset = ledger.assets.find(a => a.mode === exchange);
    let outcome: { asset: Asset; at: number } | { error: string };
    try {
      if (!asset) throw new Error(exchange in DATED ? DATED[exchange as DatedSource].missing : '未找到交易所资产，请更新连接');
      outcome = { ...(await read(row, asset)), at: ctx.now() };
    } catch (error) {
      if (error instanceof PositionsPermissionError && permission && storedConnection(database, exchange)?.encrypted === row.encrypted) permission.deny(error);
      outcome = { error: failure(error) };
    }
    const connection = ledger.connections[exchange];
    sourceWrite(row, 'error' in outcome
      ? [...(asset ? [assetStatement(database, { ...asset, status: '同步失败 · 保留旧值', error: outcome.error })] : []), settingStatement(database, exchange + '-status', { ...connection, error: outcome.error })]
      : [assetStatement(database, outcome.asset), settingStatement(database, exchange + '-status', { ...connection, lastSync: iso(outcome.at), error: null }), ...extraOnSuccess]);
  }
  const dated = (exchange: DatedSource, read: (credentials: never) => Promise<DatedRead>, extraOnSuccess: Run[] = []) => source(exchange, async (row, asset) => {
    const credentials = vault.unseal(row.encrypted, exchange) as never;
    const result = await read(credentials);
    return { asset: { ...withQuote(asset, result), quantity: result.total, price: 1, value: result.total, details: result.details, updatedAt: result.updatedAt, status: DATED[exchange].status, error: undefined } };
  }, error => {
    const { prefix, hidden } = DATED[exchange];
    if (prefix === null) return message(error, hidden);
    // Neither transport nor decryption exceptions may expose session material.
    return error instanceof Error && error.message.startsWith(prefix) ? error.message : hidden;
  }, extraOnSuccess);

  await settleIndependent([async () => {
    const [marketResult] = await Promise.allSettled([sources.quotes()]);
    const prices = marketResult.status === 'fulfilled' ? marketResult.value : undefined;
    const marketError = marketResult.status === 'rejected' ? message(marketResult.reason, '无法获取行情') : undefined;
    const virtual = ledger.assets.find(a => a.mode === 'market');
    if (virtual) {
      const next = prices ? refreshMarketAsset(virtual, prices.VIRTUAL!) : { ...virtual, status: '行情失败 · 保留旧值', error: marketError };
      lease.write(assetStatement(database, next));
    }
    const walletSync = (exchange: 'bybit' | 'binance') => source(exchange, async (row, asset) => {
      if (!prices) throw new Error(marketError);
      const c = vault.unseal(row.encrypted, row.exchange);
      const result = await (exchange === 'binance' ? sources.syncBinance(c as BinanceCredential, prices) : sources.syncBybit(c as BybitCredential, prices));
      return { asset: { ...asset, quantity: result.total, price: 1, value: result.total, details: result.details, updatedAt: result.updatedAt ?? iso(ctx.now()), status: '只读同步', error: undefined } };
    }, error => message(error, '同步暂时失败'));
    const asterSync = async () => {
      if (!ledger.asterAccounts.length) return;
      const refreshed = await mapConcurrent(ledger.asterAccounts, 3, async (account): Promise<AsterRefresh | null> => {
        const row = stored.find(r => r.exchange === asterKey(account.id));
        if (!row) return null;
        try {
          if (!prices) throw new Error(marketError);
          const credentials = vault.unseal(row.encrypted, row.exchange) as AsterCredential;
          const result = await sources.syncAster(credentials, prices), now = iso(ctx.now());
          return { id: account.id, credential: row.encrypted, patch: { walletAddress: credentials.walletAddress, value: result.total, details: result.details, lastSync: now, updatedAt: result.updatedAt ?? now, error: null } };
        } catch (error) { return { id: account.id, credential: row.encrypted, patch: { error: message(error, '同步暂时失败') } }; }
      });
      const asterRow = ledger.assets.find(a => a.mode === 'aster');
      if (!asterRow) return;
      // Rebuild from the current account list, not the one read at the start, so removed, added or re-keyed accounts keep their newer state.
      lease.write(() => {
        const saved = database.prepare("SELECT value FROM settings WHERE key = 'aster-accounts'").get<{ value: string }>()?.value;
        const keys = asterConnections(database);
        const row = database.prepare('SELECT data FROM assets WHERE id = ?').bind(asterRow.id).get<{ data: string }>();
        if (!row) return;
        const parsed = JSON.parse(row.data) as Asset, asset = { ...parsed, value: knownAssetValue(parsed) };
        const current = readAsterAccounts(saved, keys.map(k => k.exchange), asset, ledger.connections.aster);
        const accounts = mergeAsterRefresh(current, refreshed.filter(r => r !== null), new Map(keys.map(k => [k.exchange, k.encrypted])));
        for (const run of asterStatements(database, accounts, asset, ctx.now())) run();
      });
    };
    const completed = await Promise.allSettled([walletSync('bybit'), walletSync('binance'), asterSync()]);
    for (const result of completed) if (result.status === 'rejected') throw result.reason;
  },
  () => dated('okx', c => sources.syncOkx(c)),
  () => dated('gate', c => sources.syncGate(c)),
  () => dated('variational', c => sources.syncVariational(c)),
  () => dated('hyperliquid', c => sources.syncHyperliquid(c, {}), hlIdentity.status === 'ok' ? [() => updateDedupIdentity(database, 'hyperliquid', { walletHash: hlIdentity.walletHash })] : []),
  async () => {
    if (rhIdentity.status !== 'ok') {
      await dated('rh-lighter', c => sources.syncRhLighter(c));
      return;
    }
    let outcome: RhRoundInfo = { status: 'failed', walletHash: rhIdentity.walletHash };
    let indexHashes: string[] | undefined;
    try {
      await source('rh-lighter', async (row, asset) => {
        const credentials = vault.unseal(row.encrypted, 'rh-lighter') as RhLighterCredential;
        const result = await sources.syncRhLighter(credentials);
        let indices: number[] | undefined;
        if (ctx.dexAccounts && sources.rhLighterAccountIndices) {
          try { indices = await sources.rhLighterAccountIndices(credentials); } catch { indices = undefined; }
        }
        if (indices) indexHashes = indices.map(hashRhIndex);
        outcome = { status: 'ok', walletHash: rhIdentity.walletHash, ...(indices ? { indices } : {}) };
        return { asset: { ...withQuote(asset, result), quantity: result.total, price: 1, value: result.total, details: result.details, updatedAt: result.updatedAt, status: DATED['rh-lighter'].status, error: undefined } };
      }, error => {
        const { prefix, hidden } = DATED['rh-lighter'];
        return prefix && error instanceof Error && error.message.startsWith(prefix) ? error.message : hidden;
      }, [() => updateDedupIdentity(database, 'rh-lighter', { walletHash: rhIdentity.walletHash, ...(indexHashes ? { indexHashes } : {}) })]);
    } finally {
      resolveRhRound?.(outcome);
    }
  },
  async () => {
    if (!ctx.dexAccounts) return;
    const safeDexServiceError = (error: unknown): string => {
      if (error instanceof Error && error.message.startsWith('DEX 价差')) return error.message.slice(0, 200);
      return '无法连接 DEX 价差服务，已保留上次数据';
    };
    const safeProblem = (text: string): string => text.replace(/(?:0x[0-9a-fA-F]{40,}|\b[0-9a-fA-F]{40,}\b)/g, '（已隐去）').slice(0, 200);
    const safeVenueError = (venue: DexVenue, error: unknown): string => {
      const prefix = venue === 'lighter' ? 'Lighter 主网 ' : venue === 'rh' ? 'Lighter RH ' : 'Hyperliquid ';
      const fallback = `${DEX_SPREAD_VENUE_NAMES[venue]} 同步失败，请稍后重试；已保留上次数据`;
      return error instanceof Error && error.message.startsWith(prefix) ? error.message.slice(0, 200) : fallback;
    };
    let dexState: DexAccountsState;
    try {
      dexState = await ctx.dexAccounts();
    } catch (error) {
      const reason = safeDexServiceError(error);
      lease.write(() => {
        const rows = database.prepare('SELECT data FROM assets').rows<{ data: string }>();
        const existing = rows.map(row => JSON.parse(row.data) as Asset).find(asset => asset.mode === 'dex-spread');
        if (existing) assetStatement(database, { ...existing, status: '同步失败 · 保留旧值', error: reason })();
      });
      return;
    }
    if (dexState.problem !== null) {
      const reason = safeProblem(dexState.problem);
      lease.write(() => {
        const rows = database.prepare('SELECT data FROM assets').rows<{ data: string }>();
        const existing = rows.map(row => JSON.parse(row.data) as Asset).find(asset => asset.mode === 'dex-spread');
        if (existing) assetStatement(database, { ...existing, status: '同步失败 · 保留旧值', error: reason })();
      });
      return;
    }

    const hlRetained = ledger.assets.some(asset => asset.mode === 'hyperliquid' && knownAssetValue(asset) !== null);
    const rhRetained = ledger.assets.some(asset => asset.mode === 'rh-lighter' && knownAssetValue(asset) !== null);
    const prevState = readDexSpreadState(readStoredSetting(database, DEX_SPREAD_ACCOUNTS_KEY));
    const savedIdentities = readDedupIdentities(readStoredSetting(database, DEX_DEDUP_IDENTITIES_KEY));
    const hlDedup = hlIdentity.status === 'error'
      ? { kind: 'error' as const, reason: '无法核对与 Hyperliquid 连接是否重复' }
      : hlIdentity.status === 'ok'
        ? { kind: 'active' as const, walletHash: hlIdentity.walletHash }
        : hlRetained && savedIdentities.hyperliquid?.walletHash
          ? { kind: 'retained' as const, walletHash: savedIdentities.hyperliquid.walletHash }
          : { kind: 'none' as const };

    type VenueOutcome =
      | { kind: 'none' }
      | { kind: 'deduped'; venue: DexVenue; discoveredRhIndexHash?: string }
      | { kind: 'keep'; record: DexSpreadStoredAccount };

    const lighterTask = async (): Promise<VenueOutcome> => {
      const entry = dexState.accounts.lighter;
      if (!entry) return { kind: 'none' };
      const accountHash = hashLighterIndex(entry.accountIndex);
      const prev = prevState.accounts.find(item => item.venue === 'lighter' && item.accountHash === accountHash);
      try {
        if (!sources.syncLighterAccount) throw new Error('missing source');
        const res = await sources.syncLighterAccount(entry.accountIndex);
        return { kind: 'keep', record: { venue: 'lighter', accountHash, value: res.total, details: res.details, updatedAt: res.updatedAt, error: null } };
      } catch (error) {
        const err = safeVenueError('lighter', error);
        return { kind: 'keep', record: prev ? { ...prev, error: err } : { venue: 'lighter', accountHash, value: null, details: [], updatedAt: '', error: err } };
      }
    };

    const entropyTask = async (): Promise<VenueOutcome> => {
      const entry = dexState.accounts.entropy;
      if (!entry) return { kind: 'none' };
      const accountHash = hashAddress(entry.address);
      const prev = prevState.accounts.find(item => item.venue === 'entropy' && item.accountHash === accountHash);
      if (hlDedup.kind === 'error') {
        return { kind: 'keep', record: { venue: 'entropy', accountHash, value: null, details: [], updatedAt: '', error: hlDedup.reason } };
      }
      if ((hlDedup.kind === 'active' || hlDedup.kind === 'retained') && accountHash === hlDedup.walletHash) {
        return { kind: 'deduped', venue: 'entropy' };
      }
      try {
        const res = await sources.syncHyperliquid({ walletAddress: entry.address }, {});
        return { kind: 'keep', record: { venue: 'entropy', accountHash, value: res.total, details: res.details, updatedAt: res.updatedAt, error: null } };
      } catch (error) {
        const err = safeVenueError('entropy', error);
        return { kind: 'keep', record: prev ? { ...prev, error: err } : { venue: 'entropy', accountHash, value: null, details: [], updatedAt: '', error: err } };
      }
    };

    let rhDedupInfo: { kind: 'none' } | { kind: 'error' } | { kind: 'known'; walletHash: string; indexHashes?: string[] } = { kind: 'none' };
    const rhTask = async (): Promise<VenueOutcome> => {
      const rhInfo = await rhRoundPromise;
      if (rhInfo.status === 'decrypt_error') {
        rhDedupInfo = { kind: 'error' };
      } else if (rhInfo.status === 'ok') {
        const indexHashes = rhInfo.indices
          ? rhInfo.indices.map(hashRhIndex)
          : savedIdentities['rh-lighter']?.walletHash === rhInfo.walletHash
            ? savedIdentities['rh-lighter'].indexHashes
            : undefined;
        rhDedupInfo = { kind: 'known', walletHash: rhInfo.walletHash, ...(indexHashes ? { indexHashes } : {}) };
      } else if (rhInfo.status === 'failed') {
        const indexHashes = savedIdentities['rh-lighter']?.walletHash === rhInfo.walletHash
          ? savedIdentities['rh-lighter'].indexHashes
          : undefined;
        rhDedupInfo = { kind: 'known', walletHash: rhInfo.walletHash, ...(indexHashes ? { indexHashes } : {}) };
      } else if (rhRetained && savedIdentities['rh-lighter']) {
        rhDedupInfo = {
          kind: 'known',
          walletHash: savedIdentities['rh-lighter'].walletHash,
          ...(savedIdentities['rh-lighter'].indexHashes ? { indexHashes: savedIdentities['rh-lighter'].indexHashes } : {}),
        };
      }

      const entry = dexState.accounts.rh;
      if (!entry) return { kind: 'none' };
      const accountHash = hashRhIndex(entry.accountIndex);
      const prev = prevState.accounts.find(item => item.venue === 'rh' && item.accountHash === accountHash);
      if (rhDedupInfo.kind === 'error') {
        return { kind: 'keep', record: { venue: 'rh', accountHash, value: null, details: [], updatedAt: '', error: '无法核对与 Lighter RH 连接是否重复' } };
      }
      if (rhDedupInfo.kind === 'known' && rhDedupInfo.indexHashes?.includes(accountHash)) {
        return { kind: 'deduped', venue: 'rh' };
      }
      try {
        if (!sources.syncRhLighterAccount) throw new Error('missing source');
        const res = await sources.syncRhLighterAccount(entry.accountIndex);
        const l1Hash = hashAddress(res.l1Address);
        if (rhDedupInfo.kind === 'known' && l1Hash === rhDedupInfo.walletHash) {
          return { kind: 'deduped', venue: 'rh', discoveredRhIndexHash: accountHash };
        }
        return { kind: 'keep', record: { venue: 'rh', accountHash, l1Hash, value: res.total, details: res.details, updatedAt: res.updatedAt, error: null } };
      } catch (error) {
        if (rhDedupInfo.kind === 'known' && prev?.l1Hash === rhDedupInfo.walletHash) {
          return { kind: 'deduped', venue: 'rh' };
        }
        const err = safeVenueError('rh', error);
        return { kind: 'keep', record: prev ? { ...prev, error: err } : { venue: 'rh', accountHash, value: null, details: [], updatedAt: '', error: err } };
      }
    };

    const [lighterOut, rhOut, entropyOut] = await Promise.all([lighterTask(), rhTask(), entropyTask()]);
    const hlEncryptedAtStart = hlConn?.encrypted ?? null;
    const rhEncryptedAtStart = rhConn?.encrypted ?? null;
    lease.write(() => {
      const currentHl = storedConnection(database, 'hyperliquid')?.encrypted ?? null;
      const currentRh = storedConnection(database, 'rh-lighter')?.encrypted ?? null;
      if (currentHl !== hlEncryptedAtStart || currentRh !== rhEncryptedAtStart) return;
      if (hlDedup.kind === 'active') updateDedupIdentity(database, 'hyperliquid', { walletHash: hlDedup.walletHash });
      else if (hlDedup.kind === 'none') updateDedupIdentity(database, 'hyperliquid', undefined);
      if (rhDedupInfo.kind === 'known') {
        const discovered = rhOut.kind === 'deduped' && rhOut.discoveredRhIndexHash ? [rhOut.discoveredRhIndexHash] : [];
        const merged = rhDedupInfo.indexHashes || discovered.length
          ? [...(rhDedupInfo.indexHashes ?? []), ...discovered]
          : undefined;
        updateDedupIdentity(database, 'rh-lighter', { walletHash: rhDedupInfo.walletHash, ...(merged ? { indexHashes: merged } : {}) });
      } else if (rhDedupInfo.kind === 'none') {
        updateDedupIdentity(database, 'rh-lighter', undefined);
      }
      const outcomes = [lighterOut, rhOut, entropyOut];
      const nextState: DexSpreadStoredState = {
        accounts: outcomes.flatMap(item => item.kind === 'keep' ? [item.record] : []),
        deduped: outcomes.flatMap(item => item.kind === 'deduped' ? [item.venue] : []),
      };
      saveSetting(database, DEX_SPREAD_ACCOUNTS_KEY, nextState);
      const assets = database.prepare('SELECT data FROM assets').rows<{ data: string }>().map(row => JSON.parse(row.data) as Asset);
      const existing = assets.find(asset => asset.mode === 'dex-spread');
      const nextAsset = aggregateDexSpread(nextState, existing, () => nextRowAllocation(assets), iso(ctx.now()));
      if (nextAsset === null) {
        if (existing) database.prepare('DELETE FROM assets WHERE id = ?').bind(existing.id).run();
      } else {
        upsertAsset(database, nextAsset)();
      }
    });
  },
  async () => {
    // A failed position read must not keep successful balance updates from being snapshotted.
    try { await refreshPositions?.(); } catch { /* peek records whatever is still available */ }
  },
  async () => {
    const [fxResult] = await Promise.allSettled([sources.yuanQuote(ctx.now())]);
    if (fxResult.status === 'fulfilled') lease.write(() => { saveSetting(database, 'fx', String(fxResult.value.rate)); saveSetting(database, 'fx-status', fxResult.value.status); });
    else lease.write(() => saveSetting(database, 'fx-status', { ...ledger.fxStatus, error: '人民币汇率更新失败，保留上次汇率' }));
  }]);
  const at = ctx.now();
  lease.write(() => snapshotNow(ctx, at));
  return true;
}
