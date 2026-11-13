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
//   functions with an injected fetch by default); each request times out after 12 s and is not retried
//   (sources/http.ts); a failed read marks that row "同步失败 · 保留旧值" and its `<exchange>-status` error, the next
//   sync (the page asks every 60 s while open) reads again;
// - the timestamps come from the injected clock;
// - disconnect has no fill cache to clear (positions and fills are A-5);
// - an Aster account write needs the ledger's Aster row: without one it is refused with the connect message
//   '未找到交易所资产' before anything is read (the workbench would fail on the missing row while writing);
// - the market row is refreshed only when the ledger has one (the workbench assumes it);
// - a source's result and its failure are written by one statement list (the workbench writes the failure from the
//   catch around both the read and the write); a refusal of the write itself (lease lost, imported again, database
//   error) is not recorded as the source's failure but ends the sync with that refusal.
import type { AssetDb } from './db.ts';
import { AssetConflict, type SyncLease } from './sync-lock.ts';
import type { Asset, AsterAccount, Balance, FxStatus, Ledger } from './types.ts';
import type { Vault } from './credentials.ts';
import { asterKey, aggregateAster, mergeAsterRefresh, readAsterAccounts, type AsterRefresh } from './aster-accounts.ts';
import { knownAssetValue, refreshMarketAsset } from './asset-values.ts';
import { isGateProject, isHyperliquidProject, isVariationalProject } from './source-ledger.ts';
import { saveSetting, saveSnapshot } from './writes.ts';
// store.ts imports this module too; the cycle is safe, nothing is called while the modules load.
import { currentLedger } from './store.ts';
import type { AsterAccountInput, ConnectionExchange, Credentials } from './validation.ts';
import { mapConcurrent, settleIndependent } from './sources/concurrency.ts';
import type { Fetcher } from './sources/http.ts';
import type { Quote } from './sources/quotes.ts';
import { quotes } from './sources/quotes.ts';
import { syncBinance, syncBybit, type BinanceCredential, type BybitCredential } from './sources/exchanges.ts';
import { syncAster, validateAsterWallet, type AsterCredential, type AsterWallet } from './sources/aster.ts';
import { syncOkx, type OkxCredential } from './sources/okx.ts';
import { syncGate, type GateCredential } from './sources/gate.ts';
import { syncHyperliquid, type HyperliquidCredential } from './sources/hyperliquid.ts';
import { syncRhLighter, type RhLighterCredential } from './sources/rh-lighter.ts';
import { syncVariational, type VariationalCredential } from './sources/variational.ts';
import { yuanQuote } from './sources/fx.ts';

type Prices = Record<string, Quote>;
type Read = { total: number; details: Balance[] };
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
}
/** The copied readers over `fetcher`; Variational reads its portfolio through python3 (sources/variational-python.ts). */
export function liveSources(fetcher: Fetcher = fetch): AssetSources {
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
  };
}

export interface SyncContext {
  database: AssetDb;
  lease: SyncLease;
  vault: Vault;
  sources: AssetSources;
  now: () => number;
}
type Run = () => void;
const iso = (at: number) => new Date(at).toISOString();
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

const assetStatement = (database: AssetDb, asset: Asset): Run => () => { database.prepare('UPDATE assets SET data = ? WHERE id = ?').bind(JSON.stringify(asset), asset.id).run(); };
const upsertAsset = (database: AssetDb, asset: Asset): Run => () => { database.prepare('INSERT INTO assets(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').bind(asset.id, JSON.stringify(asset)).run(); };
const settingStatement = (database: AssetDb, key: string, value: unknown): Run => () => { saveSetting(database, key, value); };
const saveConnection = (database: AssetDb, name: string, encrypted: string, at: number): Run => () => {
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
function snapshotNow(ctx: SyncContext, at: number): void { saveSnapshot(ctx.database, currentLedger(ctx.database, at), at); }
const ledgerReader = currentLedger;

const MATCHED_BY_PROJECT: Partial<Record<ConnectionExchange, (project: string) => boolean>> = {
  variational: isVariationalProject, gate: isGateProject, hyperliquid: isHyperliquidProject,
  binance: project => project.trim().toLowerCase() === 'binance', okx: project => project.trim().toLowerCase() === 'okx',
};
const CREATABLE: readonly ConnectionExchange[] = ['binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'];

export async function connect(ctx: SyncContext, input: Credentials): Promise<void> {
  if (input.exchange === 'aster') return connectAsterAccount(ctx, { ...input, id: 'default', name: '默认账号' }, 'legacy');
  const { database, sources, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now());
  const byProject = MATCHED_BY_PROJECT[input.exchange];
  const matches = ledger.assets.filter(a => a.mode === input.exchange || (a.mode === 'manual' && !!byProject?.(a.project)));
  if (matches.length > 1) throw new Error('已有多条交易所资产，请先合并重复记录');
  let asset = matches[0];
  if (!asset) {
    if (!CREATABLE.includes(input.exchange)) throw new Error('未找到交易所资产');
    const nextId = Math.max(0, ...ledger.assets.map(a => Number(a.id.slice(4)))) + 1;
    if (ledger.assets.length >= 1000 || !Number.isSafeInteger(nextId) || nextId > 999999) throw new Error('资产条目已达到上限');
    asset = { id: 'row-' + nextId, project: input.exchange === 'variational' ? 'var' : input.exchange === 'hyperliquid' ? 'Hyperliquid' : input.exchange === 'rh-lighter' ? 'Lighter RH' : input.exchange, kind: '资产', quantity: 0, price: 1, value: 0, cell: 'E' + nextId, mode: input.exchange, updatedAt: '', status: '' };
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
  const next: Asset = { ...asset, mode: input.exchange, quantity: result.total, price: 1, value: result.total, status, updatedAt, error: undefined, details: result.details };
  const label = input.exchange === 'variational' ? {} : { label: input.exchange === 'hyperliquid' || input.exchange === 'rh-lighter' ? input.walletAddress.slice(-4) : input.apiKey.slice(-4) };
  const connection = { configured: true, lastSync: now, error: null, scope: ledger.connections[input.exchange].scope, ...label };
  // Persist a verified connection and its balance together; failed verification changes neither.
  commit(ctx, [saveConnection(database, input.exchange, encrypted, at), upsertAsset(database, next), settingStatement(database, input.exchange + '-status', connection)]);
}

export async function disconnect(ctx: SyncContext, exchange: ConnectionExchange): Promise<void> {
  if (exchange === 'aster') return deleteAsterAccount(ctx, 'default', 'disconnect');
  const { database } = ctx;
  const ledger = ledgerReader(database, ctx.now()), asset = ledger.assets.find(a => a.mode === exchange);
  commit(ctx, [
    deleteConnection(database, exchange),
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
  const account: AsterAccount = { id: input.id, name: input.name, includeSpot: input.includeSpot, walletAddress: wallet.address, configured: true, lastSync: now, updatedAt: now, error: null, scope: input.includeSpot ? 'API Pro · 合约 + 现货' : 'API Pro · 合约净权益', label: wallet.address.slice(-4), value: result.total, details: result.details };
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
export async function refresh(ctx: SyncContext): Promise<boolean> {
  const { database, lease, sources, vault } = ctx;
  const ledger = ledgerReader(database, ctx.now());
  const last = database.prepare("SELECT value FROM settings WHERE key = 'last-attempt'").get<{ value: string }>();
  if (last && ctx.now() - Number(last.value) < SYNC_THROTTLE_MS) return false;
  lease.write(() => saveSetting(database, 'last-attempt', String(ctx.now())));
  const stored = database.prepare('SELECT exchange,encrypted FROM connections').rows<Stored>();
  // A source result is written only while its credential is still the one read here; the check shares the lease transaction.
  const sourceWrite = (row: Stored, statements: Run[]) => lease.write(() => {
    if (storedConnection(database, row.exchange)?.encrypted === row.encrypted) for (const run of statements) run();
  });
  /** Reads one source and writes its result, or its failure with the old values kept. */
  async function source(exchange: ConnectionExchange, read: (row: Stored, asset: Asset) => Promise<{ asset: Asset }>, failure: (error: unknown) => string): Promise<void> {
    const row = stored.find(item => item.exchange === exchange);
    if (!row) return;
    const asset = ledger.assets.find(a => a.mode === exchange);
    let outcome: { asset: Asset; at: number } | { error: string };
    try {
      if (!asset) throw new Error(exchange in DATED ? DATED[exchange as DatedSource].missing : '未找到交易所资产，请更新连接');
      outcome = { ...(await read(row, asset)), at: ctx.now() };
    } catch (error) { outcome = { error: failure(error) }; }
    const connection = ledger.connections[exchange];
    sourceWrite(row, 'error' in outcome
      ? [...(asset ? [assetStatement(database, { ...asset, status: '同步失败 · 保留旧值', error: outcome.error })] : []), settingStatement(database, exchange + '-status', { ...connection, error: outcome.error })]
      : [assetStatement(database, outcome.asset), settingStatement(database, exchange + '-status', { ...connection, lastSync: iso(outcome.at), error: null })]);
  }
  const dated = (exchange: DatedSource, read: (credentials: never) => Promise<DatedRead>) => source(exchange, async (row, asset) => {
    const credentials = vault.unseal(row.encrypted, exchange) as never;
    const result = await read(credentials);
    return { asset: { ...asset, quantity: result.total, price: 1, value: result.total, details: result.details, updatedAt: result.updatedAt, status: DATED[exchange].status, error: undefined } };
  }, error => {
    const { prefix, hidden } = DATED[exchange];
    if (prefix === null) return message(error, hidden);
    // Neither transport nor decryption exceptions may expose session material.
    return error instanceof Error && error.message.startsWith(prefix) ? error.message : hidden;
  });

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
      return { asset: { ...asset, quantity: result.total, price: 1, value: result.total, details: result.details, updatedAt: iso(ctx.now()), status: '只读同步', error: undefined } };
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
          return { id: account.id, credential: row.encrypted, patch: { walletAddress: credentials.walletAddress, value: result.total, details: result.details, lastSync: now, updatedAt: now, error: null } };
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
  () => dated('hyperliquid', c => sources.syncHyperliquid(c, {})),
  () => dated('rh-lighter', c => sources.syncRhLighter(c)),
  async () => {
    const [fxResult] = await Promise.allSettled([sources.yuanQuote(ctx.now())]);
    if (fxResult.status === 'fulfilled') lease.write(() => { saveSetting(database, 'fx', String(fxResult.value.rate)); saveSetting(database, 'fx-status', fxResult.value.status); });
    else lease.write(() => saveSetting(database, 'fx-status', { ...ledger.fxStatus, error: '人民币汇率更新失败，保留上次汇率' }));
  }]);
  const at = ctx.now();
  lease.write(() => snapshotNow(ctx, at));
  return true;
}

/** A refusal of the ledger's state (lease lost, imported again) must end the sync, never be recorded as a source's error. */
export const isConflict = (error: unknown): error is AssetConflict => error instanceof AssetConflict;
