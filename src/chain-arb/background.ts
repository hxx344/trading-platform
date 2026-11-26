import { randomBytes } from 'node:crypto';
import { anySignal } from '../any-signal.mjs';
import { untilAborted } from '../asset/sources/shared-reads.ts';
import { ContractError, exactKeys } from '../contracts.ts';
import type { LoopContext } from '../monitor/anthropic.ts';
import type { AlertHooks } from '../monitor/alerts.ts';
import type { MarketControl } from '../monitor/control.ts';
import type { MonitorStore } from '../monitor/store.ts';
import { DEFAULT_BACKGROUND_SETTINGS, parseBackgroundSettings, type BackgroundSettings, type BackgroundView } from './background-model.ts';
import { CHAIN_ARB_TTL_MS, VENUE_NAMES, isGateBaseSymbol, type ChainArbVenue } from './model.ts';
import { isDepositRow, SCAN_HISTORY_MS, type ScanRow, type ScanView } from './scan-model.ts';

const SETTINGS_KEY = 'chainArb.background';
const POLL_MS = 2_000;
const chainNames = { ethereum: 'Ethereum', arbitrum: 'Arbitrum One', bsc: 'BNB Smart Chain' };
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

interface Options {
  store: Pick<MonitorStore, 'readState' | 'writeState'>;
  scan(input: unknown, scope: string, signal: AbortSignal, awaitBatch?: boolean): Promise<ScanView>;
  control(): MarketControl;
  hooks?: Pick<AlertHooks, 'robot' | 'notifyRepeating'>;
  okxResultCurrent?: (view: ScanView) => boolean;
  gateResultCurrent?: (row: ScanRow) => boolean;
  okxDepositResultCurrent?: (row: ScanRow) => boolean;
  now?: () => number;
}

function checkSnapshot(snapshot: ScanView, venue: ChainArbVenue, chain: BackgroundSettings['chain']) {
  const matches = (row: ScanRow) => row && (row.venue ?? 'gate') === venue && Object.hasOwn(chainNames, row.chain)
    && (chain === 'all' || row.chain === chain) && isGateBaseSymbol(row.symbol) && /^0x[\da-f]{40}$/i.test(row.address)
    && (row.kind === 'spot' || row.kind === 'perp') && [row.netUsdt, row.netBps, row.dexPrice, row.gatePrice, row.at]
      .every(value => Number.isFinite(value) && value > 0) && Number.isFinite(row.gasUsdt) && row.gasUsdt >= 0
    && row.expiresAt > row.at && row.expiresAt <= row.at + CHAIN_ARB_TTL_MS;
  if (!snapshot || !Number.isFinite(snapshot.asOf) || !['loading', 'scanning', 'cooldown', 'error'].includes(snapshot.phase)
    || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.history) || !snapshot.rows.every(matches) || !snapshot.history.every(matches))
    throw new Error('行情快照格式或币种路线与本次扫描不符');
}

function currentSnapshot(snapshot: ScanView, at: number): ScanView {
  const live = (snapshot.phase === 'scanning' || snapshot.phase === 'cooldown') && snapshot.asOf <= at;
  const rows: ScanRow[] = [], samples = [...snapshot.history];
  for (const row of snapshot.rows) {
    if (live && row.at <= at && row.expiresAt > at) rows.push(row);
    else samples.push(row);
  }
  const history = samples.filter(row => row.at <= at && at - row.at < SCAN_HISTORY_MS && (row.execution?.depositExpiresAt ?? 0) > at)
    .sort((left, right) => right.at - left.at || right.netBps - left.netBps).slice(0, 50);
  return { ...snapshot, asOf: at, rows, history };
}

function failedSnapshot(at: number, message: string): ScanView {
  return { asOf: at, phase: 'error', cycle: 0, total: 0, checked: 0, failed: 0, message, rows: [], history: [] };
}

function notificationKey(venue: ChainArbVenue, row: ScanRow) {
  return ['chain-arb-deposit', venue, row.chain, row.address.toLowerCase(), row.kind].join(':');
}

function notifyMessage(venue: ChainArbVenue, row: ScanRow, settings: BackgroundSettings) {
  const route = row.kind === 'spot' ? '现货充值卖出' : '永续开空（基差收敛情景，充值后卖出现货并平空，未计资金费）';
  const fill = row.execution!;
  return ['【链上折价套利】' + row.symbol + ' · ' + chainNames[row.chain],
    '路线：链上买入 → ' + VENUE_NAMES[venue] + ' ' + route,
    '合约地址：' + row.address, '预算 ' + settings.amount + ' USDT，扣费后价差 ' + Number(row.netBps.toPrecision(8)) + ' bp（阈值 ' + settings.thresholdBps + ' bp）',
    '模拟买入实收 ' + Number(fill.receivedQuantity.toPrecision(8)) + ' ' + row.symbol + '，' + VENUE_NAMES[venue] + ' 充值地址模拟实收 ' + Number(fill.transferQuantity.toPrecision(8))
      + ' ' + row.symbol + '，整笔价格影响 ' + Number((fill.impactBps / 100).toPrecision(6)) + '%。实际入账以交易所确认为准',
    '预估净收益 ' + Number(row.netUsdt.toPrecision(8)) + ' USDT，报价时间 ' + new Date(row.at).toISOString(),
    '报价有效至 ' + new Date(row.expiresAt).toISOString() + '，过期请在平台重新复核。'].join('\n');
}

export function createChainArbBackground({ store, scan, control, hooks, okxResultCurrent, gateResultCurrent, okxDepositResultCurrent, now = Date.now }: Options) {
  let settings = DEFAULT_BACKGROUND_SETTINGS, revision = 0, loadError: string | null = null;
  try {
    const entry = store.readState(SETTINGS_KEY);
    if (entry) {
      const saved = exactKeys(entry.value, ['version', 'revision', 'settings']);
      if (saved.version !== 1 || !Number.isSafeInteger(saved.revision) || (saved.revision as number) < 0) throw new Error('设置版本无效');
      settings = parseBackgroundSettings(saved.settings);
      revision = saved.revision as number;
    }
  } catch (error) { loadError = '后台扫描设置读取失败，扫描已暂停，请重新保存：' + reason(error); }

  const results = new Map<ChainArbVenue, ScanView>(), queueErrors = new Map<ChainArbVenue, string>();
  let generation = randomBytes(12).toString('hex'), marketRevision = control().revision;
  const pending = new Map<ChainArbVenue, AbortController>();
  let nextVenue = 0, stopped = false;

  function reset() {
    for (const controller of pending.values()) controller.abort();
    pending.clear();
    generation = randomBytes(12).toString('hex');
    results.clear(); queueErrors.clear(); nextVenue = 0;
  }
  function observeControl() {
    const market = control();
    if (market.revision !== marketRevision) { marketRevision = market.revision; reset(); }
    return market.enabled;
  }
  function hasDepositEvidence(row: ScanRow) {
    const venue = row.venue ?? 'gate';
    return isDepositRow(row) && (venue === 'gate' ? gateResultCurrent?.(row) : okxDepositResultCurrent?.(row))
      && row.execution.depositExpiresAt > now();
  }
  function view(): BackgroundView {
    const on = observeControl(), at = now();
    return { revision, settings, robot: hooks?.robot() ?? null, error: loadError ?? ([...queueErrors.values()].join('；') || null),
      results: on ? Object.fromEntries([...results].map(([venue, snapshot]) => {
        if (venue === 'okx' && !okxResultCurrent?.(snapshot)) {
          const message = snapshot.phase === 'error' && snapshot.total === 0 && snapshot.checked === 0
            ? snapshot.message : null;
          return [venue, failedSnapshot(at, message ?? 'OKX 只读连接或币链目录待重新核验')];
        }
        const checked = { ...snapshot, rows: snapshot.rows.filter(hasDepositEvidence), history: snapshot.history.filter(hasDepositEvidence) };
        return [venue, currentSnapshot(checked, now())];
      })) : {} };
  }
  function update(input: unknown): BackgroundView {
    const body = exactKeys(input, ['revision', 'settings']);
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0) throw new ContractError(400, 'invalid_request', '设置版本号无效');
    let next: BackgroundSettings;
    try { next = parseBackgroundSettings(body.settings); }
    catch (error) { throw new ContractError(400, 'invalid_request', reason(error)); }
    if (!loadError && JSON.stringify(next) === JSON.stringify(settings)) return view();
    if (revision !== body.revision) throw new ContractError(409, 'conflict', '设置已被其他页面修改，请刷新后重试');
    try { store.writeState(SETTINGS_KEY, { version: 1, settings: next, revision: revision + 1 }); }
    catch { throw new ContractError(503, 'background_unsaved', '后台扫描设置未保存，请检查 monitor.sqlite 写权限后重试'); }
    settings = next; revision++; loadError = null; reset();
    return view();
  }

  function canNotify(venue: ChainArbVenue, snapshot: ScanView, row: ScanRow) {
    if ((snapshot.phase !== 'scanning' && snapshot.phase !== 'cooldown') || row.netBps <= settings.thresholdBps
      || (venue === 'okx' && !okxResultCurrent?.(snapshot)) || !hasDepositEvidence(row)) return false;
    const at = now(); // Checking the account evidence can take time, including a SQLite read.
    return snapshot.asOf <= at && row.at <= at && at < row.expiresAt;
  }
  // The durable outbox may retry after a new sample, a settings change, a credential revocation or a restart.
  function notificationsCurrent(key: string, text: string, onExpiry?: (expiresAt: number) => void): boolean {
    if (!observeControl() || stopped || !settings.enabled || loadError || !hooks?.robot()) return false;
    for (const [venue, snapshot] of results) {
      const row = snapshot.rows.find(candidate => notificationKey(venue, candidate) === key && canNotify(venue, snapshot, candidate)
        && notifyMessage(venue, candidate, settings) === text);
      if (row) { onExpiry?.(row.expiresAt); return true; }
    }
    return false;
  }

  // Each public scanner advances at most one batch when read. Rotate one venue per tick across the shared DEX budget.
  async function tick() {
    if (!observeControl() || stopped || !settings.enabled || loadError) return;
    const { enabled: _enabled, thresholdBps: _thresholdBps, venues, fees, ...params } = settings;
    const venue = venues[nextVenue++ % venues.length]!;
    if (pending.has(venue)) return;
    const started = generation, controller = new AbortController();
    pending.set(venue, controller);
    const signal = anySignal([controller.signal], 28_000);
    const current = () => observeControl() && !stopped && started === generation;
    try {
      const snapshot = await untilAborted(scan({ ...params, ...fees?.[venue], ...(venue === 'gate' ? {} : { venue }) }, generation + ':' + marketRevision, signal, true), signal);
      if (!current()) return;
      signal.throwIfAborted();
      checkSnapshot(snapshot, venue, settings.chain);
      if (venue === 'okx' && !okxResultCurrent?.(snapshot)) throw new Error('OKX 只读连接或币链目录待重新核验');
      results.set(venue, snapshot);
      if (!hooks?.robot() || !hooks.notifyRepeating || (snapshot.phase !== 'scanning' && snapshot.phase !== 'cooldown')) return;
      queueErrors.delete(venue);
      for (const row of snapshot.rows) {
        if (!canNotify(venue, snapshot, row)) continue;
        try { hooks.notifyRepeating(notificationKey(venue, row), notifyMessage(venue, row, settings)); }
        catch (error) { queueErrors.set(venue, VENUE_NAMES[venue] + ' 通知入队失败：' + reason(error)); break; }
      }
    } catch (error) {
      if (!current()) return;
      const previous = results.get(venue);
      const failure = failedSnapshot(now(), signal.aborted ? '后台行情读取超时，稍后重试' : reason(error));
      results.set(venue, venue !== 'okx' && venue !== 'gate' && previous ? { ...failure,
        cycle: previous.cycle, total: previous.total, checked: previous.checked, failed: previous.failed,
        history: [...previous.rows, ...previous.history] } : failure);
    } finally {
      controller.abort();
      if (pending.get(venue) === controller) pending.delete(venue);
    }
  }
  return {
    view, update, tick, notificationsCurrent,
    enabled: () => settings.enabled,
    async loop(context: LoopContext) {
      const reads = new Set<Promise<void>>();
      try {
        while (!stopped && !context.stopped()) {
          const read = tick();
          reads.add(read);
          void read.then(() => reads.delete(read), () => reads.delete(read));
          await context.pause(POLL_MS);
        }
      } finally {
        reset();
        await Promise.allSettled(reads);
      }
    },
    stop() { stopped = true; reset(); },
  };
}
