// 来源：project-aggregation 工作台 server/automation/ondo-mm.mjs（提交 7745181）。改动见文件内「本服务」注释与 docs/ondo.md §3。
// 本服务在工作台基础上增加严格保护、账户级断线撤单、成交退出和连续观察，详见 docs/ondo.md。
// - import 路径；atomicJson 与 HttpError 写在本文件（工作台 server/atomic-json.mjs、server/http-common.mjs 的同名导出）。
// - 本服务的逐笔撤单按 tpo- 识别。交易所断线撤单覆盖整个永续账户。
// - API Key 不在页面填写、不由本模块加密保存：由 readCredentials() 从 secrets.json 的 ondo 读取（docs/ondo.md §3），
//   去掉 setKey / clearKey；state().credentials 只报是否配置与尾号。
// - initialConfig：没有已保存的设置时用它（从工作台导入的设置，config.json ondo.initial）。
// - restingOrders()：本模块在交易所的挂单，奖励分析从盘口里扣掉它们（src/ondo/rewards.ts）。
// - close(waitMs)：服务停止时撤单的等待时间由调用方给（工作台固定 3 秒）。
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { compareDecimals, decimal, decimalUnits as units, formatDecimalUnits as fmt } from './decimal.mjs';
import { createOndoClient, OndoError, ONDO_MARKET } from './client.mjs';
import { createOndoStream, createOndoTopStream } from './stream.mjs';
import { createOndoObservation } from './observation.mjs';
import { createOndoLatency, sample } from './latency.mjs';
import { exitTrigger, iocLimit, EXIT_ATTEMPTS, EXIT_CONFIRM_MS } from './exit.mjs';
import { assessQuote, assessTop, closeMoves, closePrice, floorStep, frontNotional, notional, planQuote, quoteSize, withoutOrders } from './quote.mjs';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}
function atomicJson(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

const FILE_LIMIT = 64 * 1024;
// REST recovery selects this module's prefix. The venue's dead-man switch is account-wide.
const PREFIX = 'tpo-';
const SIDES = ['buy', 'sell'];
const MAX_MARKETS = 10, MAX_OBSERVE_MARKETS = 20;
const EVENT_LIMIT = 200, EVENT_VIEW = 60;
// Snapshots arrive about four a second; a quote 4 bps out must not be steered by an older book.
const BOOK_MAX_AGE_MS = 1500, SOURCE_MAX_AGE_MS = 10_000;
const RULES_REFRESH_MS = 60_000, RULES_MAX_AGE_MS = 300_000;
const SYNC_MS = 5000, SYNC_GAP_MS = 1000, SYNC_MAX_AGE_MS = 15_000;
const MIN_REST_MS = 1000;
const EARLY_NOTE_MS = 60_000, TOP_NOTES = 20;
const UNKNOWN_CHECKS = 3, UNKNOWN_GAP_MS = 2000, UNKNOWN_MISSES = 5;
const MAX_BACKOFF_MS = 60_000;
const STRAY_CANCELS = 5;
// A stop waits this long for the withdrawal to be confirmed, then keeps trying in the background.
const STOP_WAIT_MS = 20_000, PREPARE_WAIT_MS = 45_000, CLOSE_WAIT_MS = 3000, STOP_PAUSE_MS = 250, STOP_ROUNDS = 400;
const CLEANUP_ATTEMPTS = 3, CLEANUP_PAUSE_MS = 10_000;
// Reasons that also withdraw reduce-only closes: nothing of this module may rest.
const CANCEL_ALL = new Set(['stopping', 'maintenance', 'admission', 'auth_failed']);
const GONE = new Set(['order_not_found', 'order_already_canceled', 'order_already_cancelled', 'order_already_fully_filled', 'order_already_filled']);
const QUIET = new Set(['rate_limited', 'local_backlog', 'send_guard', 'closed', 'timeout', 'network']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const abs = value => (value < 0n ? -value : value);

const EXIT_DEFAULTS = Object.freeze({ maxHoldSec: 60, maxLossBps: '20', exitSlippageBps: '10', exitMode: 'makerThenIoc' });
export const ONDO_MM_DEFAULTS = Object.freeze({ ...EXIT_DEFAULTS, mode: 'observe', markets: Object.freeze(['NVDA-USD.P']), orderUsd: '100', targetBps: '4', minBps: '3', maxBps: '4.8',
  wallEnabled: true, wallUsd: '5000', maxPositionUsd: '100', maxTotalUsd: '500', dwellMs: 1500, rps: 4 });
const CONFIG_KEYS = Object.keys(ONDO_MM_DEFAULTS);

function number(value, name, min, max) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,4})?$/.test(value)) throw new Error(`${name}格式不正确`);
  const text = decimal(value);
  if (compareDecimals(text, min) < 0 || compareDecimals(text, max) > 0) throw new Error(`${name}需在 ${min} 至 ${max} 之间`);
  return text;
}
function integer(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name}需为 ${min} 至 ${max} 的整数`);
  return value;
}
function marketList(markets, max) {
  if (!Array.isArray(markets) || markets.length < 1 || markets.length > max
    || markets.some(market => typeof market !== 'string' || !ONDO_MARKET.test(market)) || new Set(markets).size !== markets.length) throw new Error(`市场需为 1 至 ${max} 个不重复的永续合约（如 NVDA-USD.P）`);
  return [...markets];
}
export function validateOndoMmConfig(value) {
  if (!object(value) || Object.keys(value).some(key => !CONFIG_KEYS.includes(key)) || CONFIG_KEYS.some(key => !Object.hasOwn(value, key))) throw new Error('配置字段不完整或包含未知字段');
  if (!['observe', 'live'].includes(value.mode)) throw new Error('运行模式无效');
  const markets = marketList(value.markets, MAX_MARKETS);
  if (value.wallEnabled !== true) throw new Error('挂单必须启用前方挂单量保护');
  if (!['makerThenIoc', 'makerThenManual'].includes(value.exitMode)) throw new Error('退出方式无效');
  const next = { mode: value.mode, markets, orderUsd: number(value.orderUsd, '每单金额', '1', '1000000'),
    targetBps: number(value.targetBps, '目标距离', '0.5', '25'), minBps: number(value.minBps, '最近距离', '0.1', '25'), maxBps: number(value.maxBps, '最远距离', '0.5', '25'),
    wallEnabled: true, wallUsd: number(value.wallUsd, '前方保护金额', '0.0001', '100000000'),
    maxHoldSec: integer(value.maxHoldSec, '最长持仓秒数', 1, 86400),
    maxLossBps: number(value.maxLossBps, '不利价格变动（bps）', '0.1', '10000'),
    exitSlippageBps: number(value.exitSlippageBps, '退出限价滑点（bps）', '0', '1000'), exitMode: value.exitMode,
    maxPositionUsd: number(value.maxPositionUsd, '单市场最大持仓', '1', '100000000'), maxTotalUsd: number(value.maxTotalUsd, '总名义上限', '1', '1000000000'),
    dwellMs: integer(value.dwellMs, '改价确认时间', 0, 60_000), rps: integer(value.rps, '每秒请求上限', 1, 10) };
  if (compareDecimals(next.minBps, next.targetBps) >= 0 || compareDecimals(next.targetBps, next.maxBps) >= 0) throw new Error('距离需满足 最近 < 目标 < 最远');
  if (compareDecimals(next.maxPositionUsd, next.orderUsd) < 0) throw new Error('单市场最大持仓不能小于每单金额');
  if (compareDecimals(next.maxTotalUsd, next.orderUsd) < 0) throw new Error('总名义上限不能小于每单金额');
  return next;
}
// Only historical inputs receive migration defaults. A malformed new configuration still fails validation.
export function readOndoMmConfig(value) {
  if (!object(value) || Object.keys(EXIT_DEFAULTS).some(key => Object.hasOwn(value, key))) return validateOndoMmConfig(value);
  const migrated = { ...EXIT_DEFAULTS, ...value };
  if (typeof value.wallEnabled === 'boolean') migrated.wallEnabled = true;
  if (typeof value.wallUsd === 'string' && /^0(?:\.0+)?$/.test(value.wallUsd)) migrated.wallUsd = ONDO_MM_DEFAULTS.wallUsd;
  return validateOndoMmConfig(migrated);
}
// Keep v0.61's on-disk config readable on rollback; the dedicated exit policy sits beside it.
export function splitOndoMmConfig({ maxHoldSec, maxLossBps, exitSlippageBps, exitMode, ...config }) {
  return { config, exit: { maxHoldSec, maxLossBps, exitSlippageBps, exitMode } };
}
export function validateCredentials(value) {
  const ok = (text, min) => typeof text === 'string' && text.length >= min && text.length <= 300 && /^[\x21-\x7e]+$/.test(text);
  if (!object(value) || !ok(value.keyId, 8) || !ok(value.secret, 16)) throw new Error('API Key ID 或 Secret 格式不正确');
  return { keyId: value.keyId, secret: value.secret };
}
function readBounded(file) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > FILE_LIMIT) throw new Error('invalid_ondo_mm_file');
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Two-sided resting quotes on Ondo Perps that follow the book to stay inside
// the liquidity-reward band only behind sufficient external size at better prices.
//
// Per market and side there is at most one post-only order. A quote is
// withdrawn at once when it gets closer than minBps, when the book is stale or
// one-sided, when the market stops trading, when the account can no longer be
// read, while the venue rate-limits this client, during update maintenance or
// quarantine recovery, and on stop. Any opening fill or position freezes new
// exposure across the session. REST and private events can both trip the lock.
// Confirmed positions first get a reduce-only maker close, then follow the
// saved bounded IOC or manual exit policy. Flat positions never rearm quotes.
// After a stop the positions still held are reported; nothing closes them.
//
// External calls (all through createOndoClient: 5 s timeout, no automatic
// resend, 429 cooldown): a placement with an unknown outcome is looked up by
// client id until the venue has said UNKNOWN_CHECKS times that it has none, or
// UNKNOWN_MISSES account reads have not listed it, and is never sent again; a refused placement backs its side off exponentially to 60 s; a failed
// cancel is retried each second. A restart never resumes a live session; it
// only withdraws what the previous one left.
export function createOndoMarketMaker({ dataDir, readCredentials = () => null, initialConfig = null, createObservationEstimator, closeWaitMs = CLOSE_WAIT_MS, readMaintenance = () => false, readAdmission = () => true, admit = operation => operation(), notifyRisk = () => {},
  log = console, now = Date.now, monotonicNow, intervalMs = 250, fetchImpl, WebSocketImpl, clientFactory = createOndoClient, streamFactory = createOndoStream,
  // An injected stream stands for the venue: only the real one is joined by the real top-of-book socket.
  topStreamFactory = streamFactory === createOndoStream ? createOndoTopStream : null,
  sleep = ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }) } = {}) {
  const directory = path.join(dataDir, 'ondo-mm');
  const configPath = path.join(directory, 'config.json'), sessionPath = path.join(directory, 'session.json');
  let config = structuredClone(ONDO_MM_DEFAULTS), revision = 0, loadError = null;
  let keyHint = null, keyError = null;
  let lastObservation = null, lastLatency = null;
  let session = null, recovery = null, cleaning = null, timer = null, closed = false, cooldownUntil = 0, events = [], lastError = null, leftPositions = [], starting = null;

  function event(market, kind, text) {
    events.unshift({ at: new Date(now()).toISOString(), market, kind, text });
    if (events.length > EVENT_LIMIT) events.length = EVENT_LIMIT;
  }
  function gate() {
    try { return readMaintenance() ? 'maintenance' : !readAdmission() ? 'admission' : null; } catch { return 'maintenance'; }
  }
  const gateText = reason => (reason === 'maintenance' ? '工作台正在更新维护，实盘挂单暂停' : '账户写入处于隔离恢复状态，实盘挂单暂停');
  // 本服务：the key is secrets.json `ondo`, checked when the service starts (src/service/ondo-config.ts).
  function credentials() {
    const saved = readCredentials();
    if (!saved) throw new HttpError(409, '没有配置 Ondo API Key：在设置页「从工作台导入」导入，或在 secrets.json 填写 ondo 后重启服务');
    return validateCredentials(saved);
  }
  const failure = error => (error instanceof OndoError ? error.code : 'internal');
  const clientOptions = extra => ({ ...(fetchImpl ? { fetchImpl } : {}), now, cooldownUntil, ...extra });

  function recoveryRecord({ startedAt = null, prefix = null, unconfirmed = [], positions = [], canceling = null, invalid = false, interrupted = false } = {}) {
    const named = name => typeof name === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(name);
    if (!Array.isArray(unconfirmed) || unconfirmed.some(name => !named(name))
      || !Array.isArray(positions) || positions.some(row => !object(row) || !named(row.market) || units(row.position) === 0n)
      || (canceling !== null && (!object(canceling) || !named(canceling.market) || !canceling.clientId?.startsWith(PREFIX)
        || !SIDES.includes(canceling.side) || typeof canceling.id !== 'string' || typeof canceling.reduceOnly !== 'boolean'))) throw new Error('invalid_recovery');
    return { startedAt, prefix, unconfirmed, positions, canceling, invalid, interrupted: interrupted !== false };
  }
  function liveRecord(current, interrupted = true) {
    const pending = new Set(current.awaiting.keys());
    for (const market of current.markets.values()) if (market.exit?.expected) pending.add(market.name);
    return recoveryRecord({ startedAt: new Date(current.startedAt).toISOString(), prefix: current.prefix,
      unconfirmed: [...pending].sort(), positions: current.accountPositions, interrupted });
  }
  function saveLiveEvidence(current) {
    if (!current.live || !current.incident) return;
    const record = liveRecord(current), encoded = JSON.stringify(record);
    if (current.savedEvidence === encoded) return;
    try { atomicJson(sessionPath, record); current.savedEvidence = encoded; }
    catch { notice(current, current.incident.market, 'recovery_store', '无法保存成交核对记录，请在交易所核对订单与仓位。'); }
  }
  function saveRecovery(next) {
    atomicJson(sessionPath, recoveryRecord(next));
    recovery = next;
  }
  let lastRecoveryAlert = null;
  function recoveryAlert(prior = false) {
    const { unconfirmed: pending, positions, canceling, invalid, interrupted } = recovery;
    const key = `ondo:recovery:${recovery.prefix ?? recovery.startedAt ?? 'unknown'}:${JSON.stringify([pending, positions, canceling?.id, invalid, interrupted])}`;
    if ((!pending.length && !positions.length && !canceling && !invalid && !interrupted) || lastRecoveryAlert === key) return;
    lastRecoveryAlert = key;
    const residual = positions.map(row => `${row.market} ${row.position}`).join('、');
    const text = `上次 Ondo 会话${prior ? '保存的待核对记录' : '核对结果'}。${interrupted ? '实盘在完成核对前中断。' : ''}${residual ? `仍有持仓：${residual}。` : ''}${pending.length ? `这些市场的成交或撤单仍未反映到已核实仓位：${pending.join('、')}。` : ''}${canceling ? `${canceling.market} 的撤单结果未知。` : ''}${invalid ? '原恢复记录不完整。' : ''}请在交易所核对订单和仓位。`;
    event(null, 'risk', text);
    try { Promise.resolve(notifyRisk(key, text)).catch(() => log.warn({ type: 'ondo-mm' }, 'Ondo 恢复通知发送失败')); }
    catch { log.warn({ type: 'ondo-mm' }, 'Ondo 恢复通知发送失败'); }
  }

  function markDirty(market) { market.dirty = true; market.dirtySeq += 1; }
  function markAllDirty(current) { for (const market of current.markets.values()) markDirty(market); }
  function notice(current, name, code, text) {
    const key = `${current.prefix}${name}-${code}`;
    if (current.notices.has(key)) return;
    current.notices.add(key);
    event(name, 'risk', text);
    try { Promise.resolve(notifyRisk(key, `${name} · ${text}`)).catch(() => log.warn({ type: 'ondo-mm' }, 'Ondo 风险通知发送失败')); }
    catch { log.warn({ type: 'ondo-mm' }, 'Ondo 风险通知发送失败'); }
  }
  function lockQuotes(current, name, reason) {
    if (current.incident) return;
    current.incident = { at: now(), market: name, reason };
    for (const item of current.markets.values()) for (const order of item.orders.values()) {
      if (order.role === 'quote') void cancelOrder(current, item, order, 'incident');
    }
  }
  function foreignOrder(current, name) {
    const reason = '专用账户出现其他永续挂单';
    lockQuotes(current, name, reason);
    if (!current.stopping) stopRenewal(current);
    notice(current, name, 'foreign', reason + '，已锁定开仓并停止续撤单心跳，请核对写入来源。');
  }
  function freeze(current, name, reason, venueTime, confirmedPosition = false) {
    if (!current.live || session !== current) return;
    const market = current.markets.get(name);
    const time = typeof venueTime === 'string' ? Date.parse(venueTime) : NaN;
    const since = Number.isFinite(time) ? Math.max(current.startedAt, Math.min(now(), time)) : now();
    if (market && !market.exit) market.exit = { since, seenPosition: false, entry: null, trigger: null, triggeredAt: 0, anchor: null,
      manual: null, attempts: 0, nextAt: 0, expected: null, recentCloses: new Map() };
    else if (market) market.exit.since = Math.min(market.exit.since, since);
    if (!confirmedPosition) current.awaiting.set(name, ++current.evidenceSeq);
    lockQuotes(current, name, reason);
    saveLiveEvidence(current);
    notice(current, name, 'incident', `${reason}。已锁定全会话开仓，正在撤销剩余开仓单。${market ? '平仓后需人工重新启用。' : '该市场不在配置内，请人工核对并处理仓位。'}`);
  }
  function manualExit(current, market, reason) {
    if (!market.exit || market.exit.manual) return;
    market.exit.manual = reason;
    notice(current, market.name, 'manual', `${reason}。请人工接手，核对交易所的挂单和剩余仓位。`);
  }
  const orderIdentity = (market, order) => ({ market: market.name, clientId: order.clientId, side: order.side,
    price: fmt(order.price), size: fmt(order.size), reduceOnly: order.role === 'close' });
  // A private fill/cancel can arrive before the public depth has removed our quantity.
  // Keep subtracting the decrease until a strictly newer venue snapshot. Without a
  // venue event time, cover the maximum exchange clock lead accepted by onBook.
  function reduceBookQuantity(market, order, remaining, venueTime) {
    if (market.orders.get(order.clientId) !== order || remaining >= order.remaining) return;
    const through = Math.max(market.sourceAt ?? 0, Number.isFinite(venueTime) ? venueTime : now() + BOOK_MAX_AGE_MS);
    market.bookDebits.push({ side: order.side, price: order.price, remaining: order.remaining - remaining, through });
    order.remaining = remaining;
  }
  function removeTrackedOrder(market, order, terminal) {
    if (market.orders.get(order.clientId) !== order) return;
    reduceBookQuantity(market, order, 0n, terminal?.status === 'canceled' ? terminal.canceledAt : terminal?.filledAt);
    market.orders.delete(order.clientId);
  }
  function observeOrder(current, market, order, report) {
    const filled = report.status === 'fullyfilled' ? order.size : units(report.filled);
    if (filled <= (order.reportedFill ?? 0n)) return;
    order.reportedFill = filled;
    reduceBookQuantity(market, order, order.size - filled, filled === order.size ? report.filledAt : undefined);
    if (order.role === 'quote') freeze(current, market.name, filled === order.size ? '开仓单已全部成交' : '开仓单部分成交');
    else if (market.exit && order.positionBefore != null) {
      const net = order.positionBefore;
      const expected = market.exit.expected, long = net > 0n, maximum = abs(net) > filled ? abs(net) - filled : 0n;
      if (!expected || (expected.long === long ? maximum < expected.maximum : (market.position > 0n) === long)) {
        market.exit.expected = { long, maximum, since: now() };
      }
    }
    markDirty(market);
  }
  function denied(current, error) {
    if (error instanceof OndoError && (error.status === 401 || error.status === 403) && !current.halt) {
      current.halt = 'auth_failed'; lastError = `Ondo 拒绝了凭据或访问（${error.code}），已停止挂单`;
      event(null, 'error', lastError);
    }
  }

  // --- account -------------------------------------------------------------
  function hint(current, channel, data) {
    const zero = value => value === undefined || (typeof value === 'string' && /^0(?:\.0+)?$/.test(value));
    for (const row of Array.isArray(data) ? data : [data]) {
      if (!object(row) || typeof row.market !== 'string' || !ONDO_MARKET.test(row.market)) {
        markAllDirty(current);
        if (channel === 'ordersPerps' && ['open', 'pending'].includes(row?.status)) foreignOrder(current, '账户');
        continue;
      }
      const market = current.markets.get(row.market);
      const recent = market?.exit?.recentCloses;
      const tracked = market?.orders.get(row.clientOrderId) ?? recent?.get(row.clientOrderId)
        ?? (row.orderId && [...(market?.orders.values() ?? []), ...(recent?.values() ?? [])].find(order => order.id === row.orderId));
      if (channel === 'fillsPerps') {
        const opening = ['openLong', 'openShort', 'flipLongToShort', 'flipShortToLong'].includes(row.direction);
        if (opening || tracked?.role === 'quote' || (tracked?.role !== 'close' && row.reduceOnly !== true && !['closeLong', 'closeShort'].includes(row.direction))) {
          freeze(current, row.market, '收到开仓或未能归属到平仓单的成交通知', row.time);
        } else if (tracked?.role === 'close' && typeof row.id === 'string' && row.id.length <= 128) {
          // Fill frames are individual trades; REST and order frames report cumulative quantities.
          // Deduplicate only within this order and keep the largest confirmed cumulative quantity.
          const ids = tracked.fillIds ??= new Set();
          if (!ids.has(row.id) && ids.size < 256) {
            try {
              const size = units(decimal(row.size, { positive: true }));
              ids.add(row.id); tracked.streamFilled = (tracked.streamFilled ?? 0n) + size;
              observeOrder(current, market, tracked, { filled: fmt(tracked.streamFilled > tracked.size ? tracked.size : tracked.streamFilled) });
            } catch { /* The next account read will reconcile this frame. */ }
          }
        }
        if (market) markDirty(market);
        current.totals.fills += 1;
        const safe = SIDES.includes(row.side) && [row.size, row.price].every(value => typeof value === 'string' && /^[0-9.]{1,24}$/.test(value));
        event(row.market, 'fill', safe ? `成交：${row.side === 'buy' ? '买入' : '卖出'} ${row.size} @ ${row.price}` : '收到成交通知');
      } else if (channel === 'ordersPerps') {
        if (row.status === 'open' || row.status === 'pending') {
          current.orderEpoch++;
          if (!market || (!tracked && !(typeof row.clientOrderId === 'string' && row.clientOrderId.startsWith(current.prefix)))) {
            markAllDirty(current);
            foreignOrder(current, row.market);
          }
        }
        if (row.status === 'fullyfilled' || !zero(row.filledSize)) {
          if (tracked) {
            try { observeOrder(current, market, tracked, { status: row.status, filled: row.filledSize }); } catch { markDirty(market); }
          } else if (row.reduceOnly !== true) freeze(current, row.market, '订单推送报告开仓成交', row.filledAt);
        }
        const plain = zero(row.filledSize) && (row.status === 'open' || (row.status === 'canceled' && !row.cancelReason));
        if (market && !plain) markDirty(market);
      } else {
        let size = null;
        try { size = units(String(row.netQuantity).replace(/^-/, '')) * (row.direction === 'short' ? -1n : 1n); } catch { /* reread */ }
        if (size !== null && size !== 0n) freeze(current, row.market, '持仓推送报告非零仓位', undefined,
          current.accountPositions.some(position => position.market === row.market && units(position.position) === size));
        if (market && (size === null || !market.positionKnown || size !== market.position)) markDirty(market);
      }
    }
  }
  // Orders are read before positions: a fill between the two reads then shows
  // as a position whose order still looks open, never as a vanished order
  // without its position, which would let the filled side be quoted again.
  async function sync(current) {
    if (current.syncing) return;
    expireStaleAccount(current);
    current.syncing = true; current.syncAttemptAt = now();
    const started = now(), stoppingAtStart = current.stopping, orderEpoch = current.orderEpoch;
    const seqs = new Map([...current.markets.values()].map(market => [market, market.dirtySeq]));
    const initialOrders = new Map([...current.markets.values()].flatMap(market => [...market.orders]));
    try {
      const open = await current.client.openOrders();
      if (session !== current) return;
      if (open.length) current.emptyEpoch = null;
      for (const order of open) {
        if (!current.markets.has(order.market) || !order.clientId?.startsWith(current.prefix)) foreignOrder(current, order.market);
      }
      // A second, slower REST read must not postpone the account-wide opening lock.
      for (const order of open) if (!order.reduceOnly && (order.status === 'fullyfilled' || units(order.filled) > 0n)) {
        freeze(current, order.market, '账户挂单报告开仓成交');
      }
      const beforePositions = new Map(current.awaiting);
      const positions = await current.client.positions({ details: true });
      if (session !== current) return;
      expireStaleAccount(current);
      if (now() - started >= SYNC_MAX_AGE_MS) throw new OndoError('account_read_stale');
      current.accountPositions = [...positions].filter(([, detail]) => units(detail.size) !== 0n)
        .map(([market, detail]) => ({ market, position: fmt(units(detail.size)) }));
      for (const { market: name } of current.accountPositions) {
        if (current.awaiting.get(name) === beforePositions.get(name)) current.awaiting.delete(name);
        freeze(current, name, '账户核对发现非零仓位', undefined, true);
      }
      const strays = [];
      let remote = 0;
      for (const order of open) {
        const ours = order.clientId?.startsWith(PREFIX) === true;
        if (ours) remote += 1;
        if (ours && !current.markets.has(order.market)) strays.push(order);
      }
      for (const market of current.markets.values()) {
        const listed = open.filter(order => order.market === market.name), seen = new Set();
        market.foreign = [];
        for (const order of listed) {
          const size = units(order.size), remaining = size - units(order.filled);
          if (order.clientId?.startsWith(PREFIX) !== true) { if (remaining > 0n) market.foreign.push({ side: order.side, price: units(order.price), remaining }); continue; }
          seen.add(order.clientId);
          let tracked = market.orders.get(order.clientId);
          // Its cancel or terminal placement completed after this snapshot began. The old row
          // still carries fill evidence, but cannot resurrect an already settled local order.
          if (!tracked && initialOrders.has(order.clientId)) {
            observeOrder(current, market, initialOrders.get(order.clientId), order); continue;
          }
          if (!tracked) {
            tracked = { clientId: order.clientId, id: order.id, side: order.side, role: order.reduceOnly ? 'close' : 'quote', price: units(order.price),
              size, remaining: size, state: 'open', since: started, attempts: 0, nextCheckAt: 0, nextCancelAt: 0, mode: null };
            market.orders.set(order.clientId, tracked);
            event(market.name, 'adopt', `接管已有挂单：${order.side === 'buy' ? '买' : '卖'} ${order.price}`);
          } else {
            if (Object.entries(orderIdentity(market, tracked)).some(([key, value]) => order[key] !== value) || (tracked.id && tracked.id !== order.id)) {
              freeze(current, market.name, '交易所的订单身份与本地记录不符'); manualExit(current, market, '请核对订单身份'); continue;
            }
            if (tracked.state === 'unknown' && tracked.since < started) { tracked.state = 'open'; tracked.id = order.id; }
          }
          observeOrder(current, market, tracked, order);
          if (current.incident && tracked.role === 'quote') void cancelOrder(current, market, tracked, 'incident');
        }
        for (const tracked of [...market.orders.values()]) {
          if (tracked.state === 'unknown' && !tracked.looking && !seen.has(tracked.clientId) && tracked.since < started && (tracked.missed = (tracked.missed ?? 0) + 1) >= UNKNOWN_MISSES) {
            retireUnknown(current, market, tracked);
            continue;
          }
          if (seen.has(tracked.clientId) || tracked.state !== 'open' || tracked.since >= started) continue;
          // Disappearance could be a fill even when an account snapshot still reports flat.
          tracked.state = 'unknown'; tracked.wasOpen = true; tracked.since = now(); tracked.nextCheckAt = now(); markDirty(market);
          event(market.name, 'gone', '挂单已不在盘口，正在按原订单号核对成交');
        }
        const detail = positions.get(market.name), position = units(detail?.size ?? '0');
        if (market.positionKnown && position !== market.position) event(market.name, 'position', `持仓 ${fmt(market.position)} → ${fmt(position)}`);
        market.position = position; market.positionKnown = true;
        if (market.dirtySeq === seqs.get(market)) {
          market.dirty = false;
          if (market.exit) {
            if (position !== 0n) market.exit.seenPosition = true;
            market.exit.entry = detail?.entryPrice ? units(detail.entryPrice) : null;
            const expected = market.exit.expected;
            if (expected && (position === 0n || (position > 0n) !== expected.long || abs(position) <= expected.maximum)) market.exit.expected = null;
          }
        }
      }
      saveLiveEvidence(current);
      current.remoteOurs = remote; current.verifiedAt = started; current.syncOkAt = started; current.syncError = null;
      if (orderEpoch === current.orderEpoch) current.accountStale = false;
      if (!open.length && orderEpoch === current.orderEpoch) current.emptyEpoch = orderEpoch;
      if (stoppingAtStart) current.verifiedOnStop = true;
      for (const order of strays.slice(0, STRAY_CANCELS)) {
        current.lastWriteAt = now();
        try {
          const result = await current.client.cancel(order.id, { market: order.market, side: order.side, clientId: order.clientId, reduceOnly: order.reduceOnly });
          if (!order.reduceOnly && result && (result.status === 'fullyfilled' || units(result.filled) > 0n)) freeze(current, order.market, '配置外的遗留开仓单在撤销时报告成交');
          event(order.market, 'cancel', '已撤销不在当前配置内的遗留挂单');
        } catch (error) {
          if (!order.reduceOnly && ['order_already_filled', 'order_already_fully_filled'].includes(failure(error))) freeze(current, order.market, '配置外的遗留开仓单已全部成交');
          denied(current, error);
        }
        current.lastWriteAt = now();
      }
    } catch (error) {
      current.syncError = failure(error); denied(current, error);
      if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 账户读取失败');
    } finally { current.syncing = false; }
  }
  async function refreshRules(current) {
    if (current.loadingRules) return;
    current.loadingRules = true; current.rulesAttemptAt = now();
    try {
      const rules = await current.client.markets();
      if (session !== current || closed) return;
      for (const market of current.markets.values()) {
        const rule = rules.get(market.name);
        market.rules = rule ? { tick: units(rule.tick), step: units(rule.step), trading: rule.trading } : null;
        market.listed = !!rule;
        if (!current.live) market.makerFee = rule?.makerFee ?? null;
      }
      current.rulesAt = now(); current.rulesError = null;
      current.subscribeListed?.();
    } catch (error) { current.rulesError = failure(error); } finally { current.loadingRules = false; }
  }

  // --- orders --------------------------------------------------------------
  async function placeOrder(current, market, side, role, price, size, mode, replacements) {
    const bookEpoch = market.bookEpoch;
    const clientId = `${current.prefix}${(current.seq++).toString(36)}`;
    const order = { clientId, id: null, side, role, price, size, remaining: size, state: 'sending', since: now(), attempts: 0, nextCheckAt: 0, nextCancelAt: 0, mode, positionBefore: market.position };
    market.orders.set(clientId, order); current.lastWriteAt = now();
    if (role === 'close' && market.exit) {
      const recent = market.exit.recentCloses;
      recent.set(clientId, order);
      if (recent.size > 32) recent.delete(recent.keys().next().value);
    }
    const canSend = () => {
      if (session !== current || market.orders.get(clientId) !== order || market.bookEpoch !== bookEpoch || order.protectionLost || holdOf(current, market) || market.dirty) return false;
      updateExit(current, market);
      const next = decide(current, market, side, order);
      return next.type === 'place' && next.role === role && next.price === price && next.size === size && next.mode === mode;
    };
    try {
      const placed = await current.client.place({ market: market.name, side, price: fmt(price), size: fmt(size), reduceOnly: role === 'close', clientOrderId: clientId,
        timeInForce: mode === 'ioc' ? 'IOC' : 'GTC', canSend });
      order.id = placed.id; order.since = now(); market.rejects[side] = 0; current.totals.placed += 1;
      observeOrder(current, market, order, placed);
      if (market.orders.get(clientId) === order) sample(current.latency.placed, replacements, order, placed);
      if (!['open', 'pending'].includes(placed.status)) { removeTrackedOrder(market, order, placed); markDirty(market); }
      else {
        order.state = 'open';
        if (role === 'quote' && (current.incident || order.protectionLost)) await cancelOrder(current, market, order, current.incident ? 'incident' : order.protectionLost);
        else if (mode === 'ioc') { order.state = 'unknown'; order.wasOpen = true; order.nextCheckAt = now() + SYNC_GAP_MS; markDirty(market); }
        else if (role === 'close' && (market.exit?.manual || market.exit?.trigger)) await cancelOrder(current, market, order, 'exit');
      }
    } catch (error) {
      if (error instanceof OndoError && error.uncertain) {
        order.state = 'unknown'; order.since = now(); order.nextCheckAt = now() + SYNC_GAP_MS; markDirty(market);
        event(market.name, 'unknown', `下单结果未知（${error.code}），正在按订单号核对，不会重发`);
      } else {
        market.orders.delete(clientId);
        const code = failure(error);
        if (code === 'post_only_has_match') { current.totals.postOnly += 1; market.backoff[side] = now() + 500; }
        else if (QUIET.has(code)) market.backoff[side] = now() + SYNC_GAP_MS;
        else {
          market.rejects[side] += 1; current.totals.rejected += 1;
          market.backoff[side] = now() + Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(market.rejects[side], 10));
          event(market.name, 'reject', `${role === 'close' ? '平仓单' : '挂单'}被拒：${code}`);
          // The position or margin behind a refusal may have changed.
          markDirty(market); denied(current, error);
          if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 下单失败');
        }
      }
    } finally {
      if (mode === 'ioc') {
        market.exit.attempts += 1; market.exit.nextAt = now() + 1000 * 2 ** (market.exit.attempts - 1);
        markDirty(market);
      }
      current.lastWriteAt = now();
    }
  }
  function stopRenewal(current) {
    current.orderEpoch++;
    current.stream.expireOrders(() => current.emptyEpoch === current.orderEpoch && current.verifiedAt > current.lastWriteAt
      && !current.syncError && accountFresh(current));
  }
  function accountFresh(current) {
    return !current.accountStale && now() - current.syncOkAt < SYNC_MAX_AGE_MS;
  }
  function expireStaleAccount(current) {
    if (current.stopping || current.accountStale || accountFresh(current)) return;
    current.accountStale = true;
    const reason = '整账户挂单和持仓已超过核对时限';
    lockQuotes(current, '账户', reason);
    stopRenewal(current);
    notice(current, '账户', 'account_read', reason + '，已停止开仓和续撤单心跳。');
  }
  function expireUnconfirmedOrder(current, market, order) {
    if (session !== current || current.stopping || order.expiryRequested) return;
    order.expiryRequested = true;
    freeze(current, market.name, '撤单未获确认');
    stopRenewal(current);
    notice(current, market.name, 'cancel', '撤单未获确认，已停止续交易所撤单心跳。正在核对全部余单，请检查账户和持仓。');
  }
  async function cancelOrder(current, market, order, reason, replacements) {
    if (order.state !== 'open' || (now() < order.nextCancelAt && !(current.stopping && order.nextCancelAt === Infinity))) return;
    order.state = 'canceling'; current.lastWriteAt = now();
    order.withdrawSince ??= current.lastWriteAt;
    const record = sample(current.latency.cancel, market.name, order, reason, replacements);
    let receipt;
    try {
      const result = await current.client.cancel(order.id, orderIdentity(market, order));
      if (!result) throw new OndoError('invalid_data', { uncertain: true });
      observeOrder(current, market, order, result);
      removeTrackedOrder(market, order, result); current.totals.canceled += 1; market.lastCancel = reason;
      if (order.role === 'close') markDirty(market);
      receipt = result;
    } catch (error) {
      const code = failure(error);
      if (code === 'order_already_filled' || code === 'order_already_fully_filled') {
        observeOrder(current, market, order, { status: 'fullyfilled' });
        removeTrackedOrder(market, order); markDirty(market);
      }
      else {
        if (GONE.has(code) || (error instanceof OndoError && error.uncertain)) {
          // Even "already canceled" can have a partial fill. Read the original order, then the position.
          order.state = 'unknown'; order.wasOpen = true; order.since = now(); order.nextCheckAt = now() + SYNC_GAP_MS; markDirty(market);
        } else order.state = 'open';
        order.cancelFailures = (order.cancelFailures ?? 0) + 1;
        order.nextCancelAt = now() + Math.min(MAX_BACKOFF_MS, SYNC_GAP_MS * 2 ** Math.min(order.cancelFailures - 1, 6));
        if (order.cancelFailures >= EXIT_ATTEMPTS) expireUnconfirmedOrder(current, market, order);
        denied(current, error);
        if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 撤单失败');
      }
    } finally { current.lastWriteAt = now(); sample(record, receipt); }
  }
  function retireUnknown(current, market, order) {
    removeTrackedOrder(market, order); markDirty(market);
    if (order.mode === 'ioc' || (order.role === 'close' && order.wasOpen)) {
      manualExit(current, market, '原平仓委托的终态无法核实，已停止自动减仓');
    } else if (order.wasOpen) freeze(current, market.name, '原开仓委托离开盘口，未能确认最终成交量');
    event(market.name, 'unknown', '多次核对未能找到原订单，正在重读仓位；原订单不会重发');
  }
  // Bounded lookup of placements whose outcome was not read. A failed lookup is
  // not an answer and does not count toward the bound.
  async function resolveUnknown(current, market) {
    for (const order of [...market.orders.values()]) {
      if (order.state !== 'unknown' || now() < order.nextCheckAt) continue;
      order.nextCheckAt = now() + UNKNOWN_GAP_MS;
      let found; order.looking = true;
      try { found = await current.client.orderByClientId(order.clientId, orderIdentity(market, order)); }
      catch (error) { denied(current, error); continue; }
      finally { order.looking = false; }
      if (session !== current) return;
      // REST sync or a cancellation can finish while this lookup is in flight. Its fill evidence still counts.
      if (found) observeOrder(current, market, order, found);
      if (order.state !== 'unknown' || market.orders.get(order.clientId) !== order) continue;
      if (found && ['open', 'pending', 'untriggered'].includes(found.status)) {
        order.id = found.id; order.state = 'open'; order.since = now(); order.missed = 0;
        if ((current.incident && order.role === 'quote') || order.mode === 'ioc') await cancelOrder(current, market, order, 'incident');
      } else if (found && ['fullyfilled', 'canceled'].includes(found.status)) { removeTrackedOrder(market, order, found); markDirty(market); }
      else if (!found && ++order.attempts >= UNKNOWN_CHECKS) {
        retireUnknown(current, market, order);
      }
    }
  }

  // --- decisions -----------------------------------------------------------
  // A brief loss between scheduler ticks still withdraws this specific opening order.
  function protectRestingQuotes(current, market, freshBook) {
    if (!freshBook) sample(current.latency.breakQuotes, market.name);
    const quotes = [...market.orders.values()].filter(order => order.role === 'quote' && !order.protectionLost);
    if (!quotes.length) return;
    const external = freshBook && withoutOrders(freshBook, [...market.orders.values(), ...market.foreign, ...market.bookDebits]);
    for (const order of quotes) {
      if (external && frontNotional(order.side, external, order.price) >= current.cfg.wallMin) continue;
      order.protectionLost = external ? 'unprotected' : 'stale_book';
      if (order.state === 'open') void cancelOrder(current, market, order, order.protectionLost);
    }
  }
  function freshBook(market, at) {
    const book = market.book;
    return book?.bids.length && book.asks.length && book.bids[0][0] < book.asks[0][0]
      && market.bookAt <= at && at - market.bookAt <= BOOK_MAX_AGE_MS && book.time <= at + BOOK_MAX_AGE_MS && at - book.time <= SOURCE_MAX_AGE_MS;
  }
  // 本服务：the best bid and ask arrive ahead of the depth snapshot. A top newer than the last
  // depth can only withdraw an opening order; prices and protection are still computed from depth
  // alone, so the withdrawn side waits for a depth at least as new as this top before quoting again.
  function protectFromTop(current, market, top, at) {
    // A top stamped by a clock too far from ours is not kept as the newest one seen.
    if (!top || Math.abs(at - top.time) > BOOK_MAX_AGE_MS || top.time <= market.topAt) return;
    market.topAt = top.time;
    if (current.stopping || !(top.time > (market.sourceAt ?? 0))) return;
    for (const order of market.orders.values()) {
      if (order.role !== 'quote' || order.protectionLost) continue;
      const reason = assessTop(order.side, order.price, top, current.cfg.min);
      if (!reason) continue;
      order.protectionLost = reason;
      market.topWait[order.side] = { time: top.time, until: at + BOOK_MAX_AGE_MS };
      if (order.state !== 'open' || at < order.nextCancelAt) continue;
      current.early += 1;
      if (at - market.earlyNotedAt >= EARLY_NOTE_MS) {
        market.earlyNotedAt = at;
        event(market.name, 'cancel', `最优价提前撤单：${order.side === 'buy' ? '买' : '卖'}单${reason === 'too_close' ? '离中间价太近' : '前方已没有更优价位的挂单'}（本会话第 ${current.early} 次）`);
      }
      void cancelOrder(current, market, order, reason);
    }
  }
  function holdOf(current, market) {
    if (current.stopping) return 'stopping';
    if (current.live) { const reason = gate(); if (reason) return reason; }
    if (current.halt) return current.halt;
    if (now() < current.client.cooldownUntil()) return 'rate_limited';
    if (!current.rulesAt || now() - current.rulesAt > RULES_MAX_AGE_MS) return 'no_rules';
    if (!market.rules) return 'unknown_market';
    if (!market.rules.trading) return 'market_closed';
    if (current.live && !accountFresh(current)) return 'account_unknown';
    if (current.live) {
      const stream = current.stream.status();
      if (!stream.privateReady) return 'private_stream';
      if (!stream.deadManReady) return 'dead_man_switch';
      if (!stream.publicReady) return 'stale_book';
    }
    if (!freshBook(market, now())) return 'stale_book';
    if ([...market.orders.values()].some(order => order.state === 'unknown' && (!current.incident || order.role === 'close'))) return 'unknown_order';
    return null;
  }
  // Resting quotes plus positions of the configured markets, or null when a
  // position is not known or has never had a price to value it with.
  function exposure(current, sending) {
    let total = 0n;
    for (const market of current.markets.values()) {
      for (const order of market.orders.values()) if (order.role === 'quote' && order !== sending) total += notional(order.price, order.remaining);
      if (!market.positionKnown) return null;
      if (market.position === 0n) continue;
      if (market.mid === null || !freshBook(market, now())) return null;
      total += notional(market.mid, abs(market.position));
    }
    return total;
  }
  const bpsOf = (price, mid) => Number(abs(price - mid) * 10_000_000n / mid) / 1000;
  function updateExit(current, market) {
    const exit = market.exit, at = now();
    if (!exit || exit.manual || current.stopping) return;
    if (exit.expected && at - exit.expected.since >= EXIT_CONFIRM_MS) return manualExit(current, market, '已确认的平仓成交尚未反映到仓位');
    if (!market.positionKnown || market.position === 0n) {
      if (!exit.seenPosition && at - exit.since >= current.config.maxHoldSec * 1000) notice(current, market.name, 'unseen', '至今未确认该成交对应的仓位，请核对专用账户；开仓继续锁定。');
      return;
    }
    const book = market.book;
    const valid = freshBook(market, at);
    const ext = valid ? withoutOrders(book, [...market.orders.values(), ...market.foreign, ...market.bookDebits]) : null;
    const touch = market.position > 0n ? ext?.bids[0]?.[0] : ext?.asks[0]?.[0];
    if (!market.dirty && exit.entry === null) notice(current, market.name, 'no-entry', '账户未给出有效入场均价，无法计算亏损阈值；最长持仓时间仍生效。');
    if (!exit.trigger) {
      exit.trigger = exitTrigger(market.position, market.dirty ? null : exit.entry, touch, current.config.maxLossBps, at - exit.since, current.config.maxHoldSec);
      if (!exit.trigger) return;
      exit.triggeredAt = at;
      if (current.config.exitMode === 'makerThenManual') return manualExit(current, market, `${exit.trigger}，正在撤销挂单平仓委托`);
      notice(current, market.name, 'ioc', `${exit.trigger}，正在撤销挂单平仓委托并核对仓位，随后按滑点上限限价 IOC 减仓。`);
    }
    if (exit.anchor === null && touch !== undefined && !market.dirty) exit.anchor = touch;
    if (exit.attempts >= EXIT_ATTEMPTS && !exit.expected && !market.dirty) return manualExit(current, market, '限价 IOC 已达次数上限，仍有剩余仓位');
    if (at - exit.triggeredAt >= EXIT_CONFIRM_MS && !exit.expected) manualExit(current, market, '限价 IOC 未能在确认窗口内完成，已停止自动减仓');
  }
  function exitStatus(market) {
    const exit = market.exit;
    if (!exit) return null;
    if (exit.seenPosition && !market.dirty && !exit.expected && market.position === 0n && market.orders.size === 0) return '仓位已归零，开仓继续锁定';
    if (exit.manual) return `请人工接手：${exit.manual}`;
    if (exit.expected) return '已收到平仓成交，正在核对剩余仓位';
    if (market.dirty || !market.positionKnown) return '正在核对订单和剩余仓位';
    if (market.position === 0n) return exit.seenPosition ? '仓位已归零，开仓继续锁定' : '暂未读到仓位，开仓继续锁定';
    if (exit.trigger) return `${exit.trigger}，限价 IOC 减仓中（已尝试 ${exit.attempts}/${EXIT_ATTEMPTS} 次）`;
    return '只减仓挂单平仓中';
  }
  // What one side should do now: { type: 'keep'|'cancel'|'place'|'none', ... } with its page view.
  function decide(current, market, side, sending = null) {
    const { book, rules: { tick, step } } = market, cfg = current.cfg, at = now();
    const mid = (book.bids[0][0] + book.asks[0][0]) / 2n;
    const orders = [...market.orders.values()].filter(order => order !== sending);
    const mine = orders.filter(order => order.side === side);
    const shown = order => ({ role: order.role, state: order.state, price: fmt(order.price), size: fmt(order.remaining), bps: bpsOf(order.price, mid), mode: order.mode });
    if (mine.some(order => order.state !== 'open')) return { type: 'none', view: { ...shown(mine.find(order => order.state !== 'open')), reason: 'in_flight' } };
    if (mine.length > 1) return { type: 'cancel', order: mine[1], reason: 'duplicate', view: { ...shown(mine[0]), reason: 'duplicate' } };
    const existing = mine[0] ?? null;
    if (existing?.protectionLost) return { type: 'cancel', order: existing, reason: existing.protectionLost, view: { ...shown(existing), reason: existing.protectionLost } };
    const own = [...orders.map(order => ({ side: order.side, price: order.price, remaining: order.remaining, ours: true })), ...market.foreign];
    const ext = withoutOrders(book, [...own, ...market.bookDebits]);
    const ref = withoutOrders(book, [...own.filter(order => order.ours && order.side === side), ...market.bookDebits]);
    let limit;
    for (const order of own) if (order.side !== side && order.remaining > 0n && (limit === undefined || (side === 'buy' ? order.price < limit : order.price > limit))) limit = order.price;
    const fresh = !market.dirty && market.positionKnown, position = market.position;
    const role = (position > 0n && side === 'sell') || (position < 0n && side === 'buy') ? 'close' : 'quote';
    const none = reason => ({ type: 'none', view: { role, state: 'none', reason } });
    // Until the account view is current an existing order is judged as what it is.
    const actual = existing && !fresh ? existing.role : role;
    if (existing && existing.role !== actual) return { type: 'cancel', order: existing, reason: 'role_change', view: { ...shown(existing), reason: 'role_change' } };
    if (actual === 'quote') {
      if (current.incident) return existing ? { type: 'cancel', order: existing, reason: 'incident', view: { ...shown(existing), reason: 'incident' } } : none('incident');
      const held = notional(mid, abs(position));
      if (existing) {
        const view = shown(existing);
        if (fresh && (held + notional(existing.price, existing.remaining)) * 100n > cfg.maxPosition * 105n) return { type: 'cancel', order: existing, reason: 'position_cap', view: { ...view, reason: 'position_cap' } };
        const verdict = assessQuote(side, existing.price, ref, ext, tick, cfg, limit);
        if (verdict.keep) { market.pending[side] = null; return { type: 'keep', view: { ...view, bps: verdict.bps, protection: fmt(verdict.protection) } }; }
        if (!verdict.urgent) {
          market.pending[side] ??= at;
          if (at - market.pending[side] < current.config.dwellMs || at - existing.since < MIN_REST_MS) return { type: 'keep', view: { ...view, reason: verdict.reason } };
        }
        market.pending[side] = null;
        return { type: 'cancel', order: existing, reason: verdict.reason, view: { ...view, reason: verdict.reason } };
      }
      if (!fresh) return none('syncing');
      const wait = market.topWait[side];
      if (wait) {
        if (market.sourceAt >= wait.time || at >= wait.until) market.topWait[side] = null;
        else return none('awaiting_depth');
      }
      if (at < market.backoff[side]) return none('backoff');
      if (held + cfg.orderUsd > cfg.maxPosition) return none('position_cap');
      const plan = planQuote(side, ref, ext, tick, cfg, limit);
      if (plan.price === null) return none(plan.reason);
      const size = quoteSize(cfg.orderUsd, plan.price, step);
      if (size <= 0n) return none('size_too_small');
      const total = exposure(current, sending);
      if (total === null) return none('total_unknown');
      if (total + notional(plan.price, size) > cfg.maxTotal) return none('total_cap');
      return { type: 'place', role: 'quote', price: plan.price, size, mode: plan.mode,
        view: { role: 'quote', state: 'planned', price: fmt(plan.price), size: fmt(size), bps: plan.bps, mode: plan.mode, protection: fmt(plan.protection) } };
    }
    const exit = market.exit;
    if (existing && (exit?.manual || exit?.trigger || existing.mode === 'ioc')) return { type: 'cancel', order: existing, reason: 'exit', view: { ...shown(existing), reason: 'exit' } };
    if (exit?.manual) return none('manual_exit');
    if (existing && !fresh) return { type: 'keep', view: shown(existing) };
    const size = floorStep(abs(position), step);
    if (exit?.expected) return existing ? { type: 'keep', view: shown(existing) } : none('syncing');
    if (exit?.trigger) {
      if (!fresh || orders.some(order => order.role === 'quote')) return none('syncing');
      if (at < exit.nextAt || at < market.backoff[side] || exit.attempts >= EXIT_ATTEMPTS) return none('backoff');
      if (size <= 0n) return none('dust_position');
      const touch = side === 'sell' ? ext.bids[0]?.[0] : ext.asks[0]?.[0];
      const price = iocLimit(side, touch, exit.anchor, current.config.exitSlippageBps, tick, limit);
      if (price === null) return none('no_price');
      return { type: 'place', role: 'close', price, size, mode: 'ioc', view: { role: 'close', state: 'planned', price: fmt(price), size: fmt(size), mode: 'ioc' } };
    }
    let price = closePrice(side, ext, tick);
    // A close must not reach this account's own resting order on the other side.
    if (price !== null && limit !== undefined && (side === 'sell' ? price <= limit : price >= limit)) price = side === 'sell' ? limit + tick : limit - tick;
    if (existing) {
      const view = shown(existing);
      if (existing.remaining !== size) return { type: 'cancel', order: existing, reason: 'close_size', view: { ...view, reason: 'close_size' } };
      if (price !== null && closeMoves(side, existing.price, price) && at - existing.since >= MIN_REST_MS) return { type: 'cancel', order: existing, reason: 'close_follow', view: { ...view, reason: 'close_follow' } };
      return { type: 'keep', view };
    }
    if (!fresh) return none('syncing');
    if (size <= 0n) return none('dust_position');
    if (price === null || price <= 0n) return none('no_price');
    if (at < market.backoff[side]) return none('backoff');
    return { type: 'place', role: 'close', price, size, mode: 'close', view: { role: 'close', state: 'planned', price: fmt(price), size: fmt(size), bps: bpsOf(price, mid), mode: 'close' } };
  }
  function restingView(market, reason) {
    for (const side of SIDES) {
      const order = [...market.orders.values()].find(item => item.side === side);
      market.view[side] = order ? { role: order.role, state: order.state, price: fmt(order.price), size: fmt(order.remaining), mode: order.mode, reason } : { role: 'quote', state: 'none', reason };
    }
  }
  async function run(current, market, replacements) {
    updateExit(current, market);
    // Withdrawals that are due together are requested together: the client sends them as one batch.
    const withdraw = (orders, reason) => Promise.all(orders.map(order => cancelOrder(current, market, order, reason)));
    if (market.exit?.manual || market.exit?.trigger) await withdraw([...market.orders.values()].filter(order => order.role === 'close'), 'exit');
    if (current.live) await resolveUnknown(current, market);
    if (session !== current) return;
    const hold = holdOf(current, market);
    market.hold = hold;
    if (hold) {
      if (current.live) {
        const all = CANCEL_ALL.has(hold);
        await withdraw([...market.orders.values()].filter(order => all || order.role === 'quote'), hold);
      }
      restingView(market, hold);
      return;
    }
    // Withdrawals of both sides go out before either side's new order.
    if (current.live) {
      const due = SIDES.map(side => decide(current, market, side)).filter(action => action.type === 'cancel');
      await Promise.all(due.map(action => cancelOrder(current, market, action.order, action.reason, replacements)));
      if (due.length && (session !== current || holdOf(current, market))) return;
    }
    for (const side of SIDES) {
      let action = decide(current, market, side);
      if (action.type === 'cancel' && current.live) {
        await cancelOrder(current, market, action.order, action.reason, replacements);
        if (session !== current || holdOf(current, market)) return;
        action = decide(current, market, side);
      }
      if (action.type === 'place' && current.live) {
        await placeOrder(current, market, side, action.role, action.price, action.size, action.mode, replacements);
        if (session !== current || holdOf(current, market)) return;
        if (!current.incident && !market.dirty) sample(current.latency.confirmReplace, market.name, side, replacements);
        action = decide(current, market, side);
        if (action.type !== 'keep') action = { type: 'none', view: action.view };
      }
      market.view[side] = action.view;
    }
  }
  async function step(current, market) {
    if (market.busy) return;
    market.busy = true;
    const replacements = current.live ? new Map() : null;
    try { await run(current, market, replacements); }
    catch (error) { market.error = failure(error); log.warn({ err: error, type: 'ondo-mm', market: market.name }, 'Ondo 挂单循环出错'); }
    finally { market.busy = false; if (replacements?.size) sample(current.latency.finishRound, market.name, replacements); }
  }

  // --- session -------------------------------------------------------------
  function observationSnapshot(current, ended = false) {
    const at = now(), result = current.observation.snapshot(at, ended);
    if (!current.estimateEarnings) return result;
    const ready = current.stream?.status().publicReady;
    const status = [...current.markets.values()].map(market => {
      const book = market.book;
      let issue = null;
      if (current.rulesError) issue = '公开交易规则读取失败';
      else if (!current.rulesAt || at < current.rulesAt || at - current.rulesAt >= RULES_MAX_AGE_MS) issue = '等待有效的公开交易规则';
      else if (!market.listed) issue = '交易所未上市该市场';
      else if (!market.rules.trading) issue = '该市场休市或暂停交易';
      else if (!ready) issue = '等待公开盘口和成交推送就绪';
      else if (!book?.bids.length || !book.asks.length || book.bids[0][0] >= book.asks[0][0] || at < market.bookAt
        || at - market.bookAt >= BOOK_MAX_AGE_MS || at - book.time >= BOOK_MAX_AGE_MS || book.time - at > BOOK_MAX_AGE_MS) issue = '等待新鲜的双边盘口';
      return { market: market.name, issue, makerFee: market.makerFee ?? null };
    });
    return { ...result, earnings: current.estimateEarnings(result, status, at) };
  }
  function finish(current) {
    if (session !== current) return;
    lastLatency = sample(current.latency.snapshot, true) ?? null;
    if (current.observation) lastObservation = observationSnapshot(current, true);
    cooldownUntil = Math.max(cooldownUntil, current.client.cooldownUntil());
    if (!current.stopping) current.stream?.close();
    current.client.close();
    session = null;
    if (current.live) {
      leftPositions = current.accountPositions;
      const record = liveRecord(current, false);
      if (leftPositions.length || record.unconfirmed.length) {
        recovery = { ...record, error: leftPositions.length ? 'positions_remain' : 'position_unconfirmed' };
        try { saveRecovery(recovery); }
        catch { log.warn({ type: 'ondo-mm' }, '停机时未能更新 Ondo 恢复记录'); }
        recoveryAlert();
      } else {
        try { rmSync(sessionPath, { force: true }); } catch (error) { log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 会话记录未能删除'); }
      }
    }
    event(null, 'session', !current.live ? '观察已停止' : leftPositions.length
      ? `实盘挂单已停止，挂单已确认撤销；仍有持仓未平：${leftPositions.map(item => `${item.market} ${item.position}`).join('、')}`
      : recovery ? '实盘挂单已停止，全部挂单已确认撤销，成交后的仓位仍须核实' : '实盘挂单已停止，全部挂单已确认撤销，没有持仓');
  }
  // A live session ends only when nothing of it is in flight or tracked and an
  // account read begun after its last write lists no order with its prefix.
  function settled(current) {
    return [...current.markets.values()].every(market => market.orders.size === 0 && !market.busy)
      && current.verifiedOnStop && !current.syncError && !current.syncing && current.remoteOurs === 0 && current.verifiedAt > current.lastWriteAt;
  }
  async function tick() {
    const current = session;
    if (!current || closed) return;
    const at = now(), work = [];
    if (!current.rulesAttemptAt || at - current.rulesAttemptAt >= RULES_REFRESH_MS) work.push(refreshRules(current));
    if (current.live) {
      if (!current.batchNoted && current.client.batchCancels?.() === false) {
        current.batchNoted = true;
        event(null, 'error', '交易所拒绝了批量撤单或应答格式不符，本会话改为逐笔撤单');
      }
      expireStaleAccount(current);
      // A lost cancellation can remain "unknown" without reaching another attempt during a REST outage.
      for (const market of current.markets.values()) for (const order of market.orders.values()) {
        if (order.withdrawSince !== undefined && at - order.withdrawSince >= SYNC_MAX_AGE_MS) expireUnconfirmedOrder(current, market, order);
      }
      const dirty = [...current.markets.values()].some(market => market.dirty);
      if (at - current.syncAttemptAt >= SYNC_GAP_MS && (current.stopping || current.accountStale || dirty || at - current.syncOkAt >= SYNC_MS) && at >= current.client.cooldownUntil()) work.push(sync(current));
    }
    for (const market of current.markets.values()) work.push(step(current, market));
    await Promise.all(work);
    if (session === current && current.stopping && settled(current)) finish(current);
  }
  function open(live, keys, markets = config.markets) {
    const tag = randomBytes(12).toString('hex');
    const current = { live, config: { ...structuredClone(config), markets: [...markets] }, prefix: `${PREFIX}${tag}-`, seq: 0, startedAt: now(), stopping: false, halt: null, incident: null, notices: new Set(),
      cfg: { target: units(config.targetBps), min: units(config.minBps), max: units(config.maxBps), wallEnabled: config.wallEnabled, wallMin: units(config.wallUsd),
        orderUsd: units(config.orderUsd), maxPosition: units(config.maxPositionUsd), maxTotal: units(config.maxTotalUsd) },
      markets: new Map(markets.map(name => [name, { name, rules: null, listed: false, book: null, bookAt: 0, bookEpoch: 0, mid: null, orders: new Map(), bookDebits: [], foreign: [], topAt: 0, topWait: { buy: null, sell: null }, earlyNotedAt: -Infinity, position: 0n, positionKnown: !live,
        dirty: live, dirtySeq: 0, pending: { buy: null, sell: null }, backoff: { buy: 0, sell: 0 }, rejects: { buy: 0, sell: 0 },
        view: { buy: { role: 'quote', state: 'none', reason: 'starting' }, sell: { role: 'quote', state: 'none', reason: 'starting' } }, hold: 'starting', busy: false, error: null, lastCancel: null }])),
      accountPositions: [], accountStale: false, orderEpoch: 0, emptyEpoch: null, awaiting: new Map(), evidenceSeq: 0, savedEvidence: null, syncing: false, syncAttemptAt: 0, syncOkAt: now(), syncError: null, remoteOurs: null, verifiedAt: 0, lastWriteAt: now(),
      loadingRules: false, rulesAttemptAt: 0, rulesAt: 0, rulesError: null, totals: { placed: 0, canceled: 0, rejected: 0, postOnly: 0, fills: 0 }, early: 0, topNotes: 0, batchNoted: false, client: null, stream: null };
    current.latency = createOndoLatency({ markets, mode: live ? 'live' : 'observe', startedAt: current.startedAt, prefix: current.prefix, now, monotonicNow });
    current.client = clientFactory(clientOptions({ credentials: keys, rps: config.rps, ...(live ? { latency: current.latency } : {}) }));
    current.observation = live ? null : createOndoObservation({
      markets, cfg: current.cfg, startedAt: current.startedAt, dwellMs: config.dwellMs, minRestMs: MIN_REST_MS,
      bookMaxAgeMs: BOOK_MAX_AGE_MS, rulesMaxAgeMs: RULES_MAX_AGE_MS,
      readRules: name => current.stream?.status().publicReady ? { ...current.markets.get(name).rules, at: current.rulesAt } : null,
    });
    if (!live) current.estimateEarnings = createObservationEstimator?.(current.config);
    let subscribed = live ? markets : [];
    const activeFeed = names => session === current && subscribed === names;
    const makeStream = names => streamFactory({ markets: names, credentials: keys, latency: current.latency, ...(WebSocketImpl ? { WebSocketImpl } : {}), now,
      ...(live ? { heartbeatAllowed: () => session === current && !current.stopping && accountFresh(current) } : {}),
      ...(current.observation ? { onTrade(name, trade, at) { if (activeFeed(names)) current.observation.trade(name, trade, at); } } : {}),
      onBook(name, book, at) {
        const market = current.markets.get(name);
        if (!market || !activeFeed(names)) return;
        current.observation?.book(name, book, at);
        const gap = market.bookAt > 0 && at - market.bookAt > BOOK_MAX_AGE_MS;
        const duplicate = book && market.book?.time === book.time;
        const valid = book?.bids.length && book.asks.length && book.time <= at + BOOK_MAX_AGE_MS && at - book.time <= SOURCE_MAX_AGE_MS
          && !(book.time < market.sourceAt);
        market.book = valid ? book : null;
        if (market.book) {
          market.sourceAt = market.book.time;
          if (market.bookDebits.length) market.bookDebits = market.bookDebits.filter(debit => market.sourceAt <= debit.through);
          if (!duplicate) market.bookAt = at;
          market.mid = (book.bids[0][0] + book.asks[0][0]) / 2n;
        } else { market.bookAt = 0; market.mid = null; market.bookEpoch++; }
        if (current.live) protectRestingQuotes(current, market, valid && !gap ? book : null);
        if (current.live && market.exit) updateExit(current, market);
      },
      onDown(reason) {
        if (!activeFeed(names)) return;
        current.observation?.down(now());
        for (const market of current.markets.values()) {
          market.book = null; market.bookAt = 0; market.mid = null; market.bookEpoch++;
          if (current.live) protectRestingQuotes(current, market, null);
        }
        if (current.live) {
          markAllDirty(current);
          // The separate public feed can fail while the account socket still confirms orders and protects the account.
          if (!current.stopping && reason !== 'public_feed_down') stopRenewal(current);
        }
      },
      onPrivate(channel, data) { if (session === current) hint(current, channel, data); } });
    if (live) {
      const main = makeStream(markets);
      let top = null;
      try {
        top = topStreamFactory?.({ markets, ...(WebSocketImpl ? { WebSocketImpl } : {}), now,
          onTop(name, book, at) { const market = current.markets.get(name); if (market && session === current) protectFromTop(current, market, book, at); },
          onState(ready) {
            if (session !== current || current.stopping || current.topNotes >= TOP_NOTES) return;
            current.topNotes += 1;
            event(null, 'session', `${ready ? '最优价连接已就绪，买一卖一变化可提前触发保护撤单' : '最优价连接断开，保护撤单暂时只由深度盘口触发'}${current.topNotes === TOP_NOTES ? '（本会话不再记录这条连接的状态）' : ''}`);
          } }) ?? null;
      } catch (error) { log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 最优价连接无法建立'); }
      // The top-of-book socket lives and dies with the session's stream and is never asked for status.
      current.stream = top ? { ...main, start() { main.start(); top.start(); }, close() { main.close(); top.close(); } } : main;
    } else {
      current.subscribeListed = () => {
        const listed = markets.filter(name => current.markets.get(name).rules?.trading);
        if (listed.length === subscribed.length && listed.every((name, i) => name === subscribed[i])) return;
        const next = listed.length ? makeStream(listed) : null;
        subscribed = listed;
        current.stream?.close();
        current.observation.down(now());
        for (const market of current.markets.values()) market.book = null;
        current.stream = next;
        current.stream?.start();
      };
    }
    return current;
  }
  async function halt(waitMs) {
    const current = session;
    if (!current) return;
    if (!current.live) { finish(current); return; }
    // An explicit stop also retries a previously backed-off withdrawal after reconciling its status.
    for (const market of current.markets.values()) for (const order of market.orders.values()) order.nextCancelAt = 0;
    if (!current.stopping) {
      current.stopping = true;
      markAllDirty(current);
      // Stop renewing the venue timer immediately. REST keeps cancelling and reconciling even if a response is lost.
      current.stream.close();
      event(null, 'session', '正在停止：撤销全部挂单并核对');
    }
    const begun = now();
    for (let round = 0; round < STOP_ROUNDS && session === current && !closed && now() - begun < waitMs; round++) {
      await tick();
      if (session !== current) return;
      await sleep(STOP_PAUSE_MS);
    }
  }
  // Withdraws what a previous process left resting. Cancels only orders with this module's prefix.
  const hasFill = report => report?.status === 'fullyfilled' || (report != null && units(report.filled) > 0n);
  function completeRecoveryCancel(report) {
    const { market } = recovery.canceling;
    const unconfirmed = report && !hasFill(report) ? recovery.unconfirmed : [...new Set([...recovery.unconfirmed, market])];
    saveRecovery({ ...recovery, canceling: null, unconfirmed });
  }
  async function lookupRecoveryCancel(client) {
    const { id, clientId, ...expected } = recovery.canceling;
    let report;
    try { report = await client.orderByClientId(clientId, { ...expected, id }); } catch { /* Keep the market pending if terminal history is unavailable. */ }
    if (report && !['fullyfilled', 'canceled'].includes(report.status)) throw new OndoError('orders_remain');
    completeRecoveryCancel(report);
  }
  async function cancelLeftovers(client, left) {
    const previous = recovery.canceling;
    if (previous) {
      const index = left.findIndex(order => order.clientId === previous.clientId && order.id === previous.id);
      if (index < 0) await lookupRecoveryCancel(client);
      else {
        if (Object.entries(previous).some(([key, value]) => left[index][key] !== value)) throw new OndoError('invalid_data');
        left.unshift(...left.splice(index, 1));
      }
    }
    for (const order of left) {
      const { id, clientId, market, side, price, size, reduceOnly } = order;
      const canceling = { id, clientId, market, side, price, size, reduceOnly };
      const unconfirmed = hasFill(order) ? [...new Set([...recovery.unconfirmed, market])] : recovery.unconfirmed;
      // A crash after DELETE but before its reply must leave an identifiable unresolved request on disk.
      saveRecovery({ ...recovery, unconfirmed, canceling });
      try {
        const report = await client.cancel(id, { clientId, market, side, price, size, reduceOnly });
        if (!report || !['fullyfilled', 'canceled'].includes(report.status)) throw new OndoError('invalid_data', { uncertain: true });
        completeRecoveryCancel(report);
      } catch (error) {
        const code = failure(error);
        if (code === 'order_already_filled' || code === 'order_already_fully_filled') completeRecoveryCancel(null);
        else if (GONE.has(code)) await lookupRecoveryCancel(client);
        else throw error;
      }
    }
  }
  async function checkRecoveryAccount(client) {
    if ((await client.openOrders()).some(order => order.clientId?.startsWith(PREFIX))) throw new OndoError('orders_remain');
    const positions = [...await client.positions()].filter(([, size]) => units(size) !== 0n)
      .map(([market, size]) => ({ market, position: fmt(units(size)) }));
    const held = new Set(positions.map(row => row.market));
    // Only a later observation of the same market can account for the opening fill.
    const unconfirmed = recovery.unconfirmed.filter(name => !held.has(name));
    if (positions.length || unconfirmed.length || recovery.invalid || recovery.interrupted) {
      saveRecovery({ ...recovery, positions, unconfirmed, error: positions.length ? 'positions_remain' : 'position_unconfirmed' });
      leftPositions = positions; recoveryAlert();
      return false;
    }
    return true;
  }
  async function cleanup(attempts) {
    if (cleaning) return cleaning;
    let keys;
    try { keys = credentials(); } catch { if (recovery) recovery = { ...recovery, error: 'no_credentials' }; return undefined; }
    const task = Promise.resolve().then(async () => {
      let client = null;
      try {
        client = clientFactory(clientOptions({ credentials: keys, rps: config.rps }));
        for (let attempt = 0; attempt < attempts && recovery && !session && !closed; attempt++) {
          if (attempt) await sleep(CLEANUP_PAUSE_MS);
          try {
            const left = (await client.openOrders()).filter(order => order.clientId?.startsWith(PREFIX));
            await cancelLeftovers(client, left);
            if (!await checkRecoveryAccount(client)) return;
            // Allow an exchange snapshot that lagged the final cancellation to catch up. A known
            // opening fill with no position evidence remains pending until explicit reconciliation.
            await sleep(SYNC_GAP_MS);
            if (closed || !await checkRecoveryAccount(client)) return;
            rmSync(sessionPath, { force: true }); recovery = null;
            leftPositions = [];
            event(null, 'session', left.length ? `已撤销上次实盘遗留的 ${left.length} 笔挂单` : '上次实盘没有遗留挂单');
          } catch (error) { recovery = { ...recovery, error: failure(error) }; recoveryAlert(); }
        }
      } catch (error) { if (recovery) recovery = { ...recovery, error: failure(error) }; }
      finally { if (client) { cooldownUntil = Math.max(cooldownUntil, client.cooldownUntil()); client.close(); } if (cleaning === task) cleaning = null; }
    });
    cleaning = task;
    return task;
  }

  function state() {
    const current = session, hold = gate();
    return { schema: 1, phase: !current ? 'stopped' : current.stopping ? 'stopping' : 'running', sessionId: current?.prefix ?? null, live: current?.live ?? false, startedAt: current ? new Date(current.startedAt).toISOString() : null,
      config: structuredClone(config), revision, activeConfig: current ? structuredClone(current.config) : null,
      credentials: { configured: !!keyHint, hint: keyHint, error: keyError },
      latency: current ? sample(current.latency.snapshot) ?? null : lastLatency,
      observation: current?.observation ? observationSnapshot(current) : lastObservation,
      paused: hold !== null, pauseReason: hold ? gateText(hold) : null, halt: current?.halt ?? null, incident: current?.incident ? { ...current.incident } : null, lastError,
      cooldownUntil: Math.max(cooldownUntil, current?.client.cooldownUntil() ?? 0) || null,
      stream: current?.stream?.status() ?? null, syncError: current?.syncError ?? null, rulesError: current?.rulesError ?? null, totals: current ? { ...current.totals } : null,
      markets: current ? [...current.markets.values()].map(market => {
        const book = market.book, bid = book?.bids[0]?.[0], ask = book?.asks[0]?.[0];
        return { market: market.name, hold: market.hold, listed: market.listed, trading: market.rules?.trading ?? null, tick: market.rules ? fmt(market.rules.tick) : null,
          bid: bid === undefined ? null : fmt(bid), ask: ask === undefined ? null : fmt(ask), bookAt: market.bookAt || null,
          position: market.positionKnown ? fmt(market.position) : null, exitStatus: exitStatus(market), synced: !market.dirty, buy: market.view.buy, sell: market.view.sell, lastCancel: market.lastCancel, error: market.error };
      }) : [],
      leftPositions: current?.live ? [] : leftPositions.map(item => ({ ...item })),
      recovery: recovery ? { startedAt: recovery.startedAt ?? null, error: recovery.error ?? null, cleaning: !!cleaning } : null,
      events: events.slice(0, EVENT_VIEW), loadError, serverNow: now() };
  }
  const checked = (validate, value) => { try { return validate(value); } catch (error) { throw new HttpError(400, error.message); } };

  return {
    state,
    tick,
    initialize() {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const saved = readBounded(configPath);
        if (saved) {
          if (saved.exit !== undefined && (!object(saved.exit) || Object.keys(saved.exit).some(key => !Object.hasOwn(EXIT_DEFAULTS, key))
            || Object.keys(EXIT_DEFAULTS).some(key => !Object.hasOwn(saved.exit, key)))) throw new Error('退出设置不完整');
          config = readOndoMmConfig(saved.exit === undefined ? saved.config : { ...saved.config, ...saved.exit });
          revision = Number.isSafeInteger(saved.revision) ? saved.revision : 0;
        }
        // 本服务：the imported workbench settings stand in until the page saves its own; never a live mode.
        else if (initialConfig) {
          try { config = readOndoMmConfig({ ...initialConfig, mode: 'observe' }); }
          catch (error) { loadError = '从工作台导入的挂单设置无法使用，已用默认值，保存后生效'; log.warn({ err: error, type: 'ondo-mm' }, loadError); }
        }
      }
      catch (error) { loadError = '已保存的挂单配置无法读取，已恢复默认值，保存后生效'; config = structuredClone(ONDO_MM_DEFAULTS); log.warn({ err: error, type: 'ondo-mm' }, loadError); }
      try { const saved = readCredentials(); if (saved) keyHint = validateCredentials(saved).keyId.slice(-4); }
      catch { keyError = 'secrets.json 里的 Ondo API Key 格式不正确'; }
      // A session record that outlived its process means orders may still rest.
      try {
        const saved = readBounded(sessionPath);
        if (saved) {
          if (!object(saved)) throw new Error('invalid_recovery');
          // Legacy markers also mean that the old process never proved a clean stop.
          const record = recoveryRecord({ interrupted: true, ...saved });
          leftPositions = record.positions;
          recovery = { ...record, error: record.positions.length ? 'positions_remain' : record.unconfirmed.length || record.invalid || record.interrupted ? 'position_unconfirmed' : null };
          recoveryAlert(true);
        }
      } catch {
        recovery = { ...recoveryRecord(), invalid: true, error: 'position_unconfirmed' };
        recoveryAlert(true);
      }
      if (recovery && keyHint) void cleanup(CLEANUP_ATTEMPTS);
      if (intervalMs > 0) { timer = setInterval(() => { void tick().catch(error => log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 挂单定时任务出错')); }, intervalMs); timer.unref?.(); }
    },
    save(value) {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '请先停止挂单再修改配置');
      const next = checked(validateOndoMmConfig, value);
      try { atomicJson(configPath, { revision: revision + 1, ...splitOndoMmConfig(next) }); }
      catch (error) { log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 挂单配置写入失败'); throw new HttpError(503, '配置无法保存，请恢复存储后重试'); }
      config = next; revision += 1; loadError = null;
      return state();
    },
    async start(input = {}, { signal } = {}) {
      if (closed) throw new HttpError(503, '服务正在关闭');
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单已在运行');
      if (input.revision !== revision) throw new HttpError(409, '配置已变化，请刷新后重新确认');
      if (config.mode !== 'live') {
        const markets = Object.hasOwn(input, 'observeMarkets') ? checked(value => marketList(value, MAX_OBSERVE_MARKETS), input.observeMarkets) : config.markets;
        const current = session = open(false, null, markets); lastError = null;
        event(null, 'session', '开始观察：只计算挂单位置，不下单');
        // An unknown symbol makes Ondo refuse the whole subscription. Start public depth/tape only after the rules resolve.
        await refreshRules(current);
        if (session !== current || closed) throw new HttpError(409, '观察启动期间会话已变化，请刷新后核对');
        await tick();
        return state();
      }
      if (Object.hasOwn(input, 'observeMarkets')) throw new HttpError(400, '实盘模式不能指定观察市场，请先保存观察模式');
      if (input.confirmLive !== true) throw new HttpError(400, '实盘挂单需要明确确认');
      if (input.confirmAccountWide !== true) throw new HttpError(400, '请确认使用专用账户：停止心跳后 Ondo 会撤销该账户的全部永续挂单');
      if (input.adoptPositions !== undefined && typeof input.adoptPositions !== 'boolean') throw new HttpError(400, '已有持仓的确认无效');
      if (cleaning) throw new HttpError(409, '正在清理上次实盘的遗留挂单，请稍后再试');
      if (recovery) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，请先完成清理');
      const keys = credentials();
      // Held until the start is decided: the positions are read before the session exists.
      const attempt = starting = { cancelled: false };
      return Promise.resolve().then(() => admit(async () => {
        const hold = gate();
        if (hold) throw new HttpError(409, gateText(hold));
        if (session) throw new HttpError(409, '挂单已在运行');
        if (recovery || cleaning) throw new HttpError(409, '上次实盘的遗留挂单尚未确认撤销，请先完成清理');
        const current = open(true, keys);
        // A position in a configured market would be closed as if this module had opened it.
        const refuse = (status, message) => { current.stream.close(); current.client.close(); throw new HttpError(status, message); };
        let held, outside, openOrders;
        try {
          openOrders = await current.client.openOrders();
          const positions = await current.client.positions();
          held = current.config.markets.filter(name => units(positions.get(name) ?? '0') !== 0n)
            .map(name => ({ name, size: positions.get(name) }));
          outside = [...positions].some(([name, size]) => !current.markets.has(name) && units(size) !== 0n);
        } catch (error) {
          cooldownUntil = Math.max(cooldownUntil, current.client.cooldownUntil());
          current.stream.close(); current.client.close();
          if (!(error instanceof OndoError)) log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 账户核对失败');
          throw new HttpError(503, `无法读取 Ondo 挂单或持仓（${failure(error)}），未开始挂单`);
        }
        if (openOrders.length) refuse(409, '启动前账户须无永续挂单。请先在 Ondo 核实并处理现有订单，再启用账户级断线撤单');
        if (outside) refuse(409, '专用账户在所选市场之外已有持仓，请先核实持仓或调整市场设置');
        if (held.length && input.adoptPositions !== true) refuse(409, `账户在这些市场已有持仓：${held.map(p => `${p.name} ${p.size}`).join('、')}。确认接管仓位并只减仓退出后再启动`);
        const later = gate();
        if (later) refuse(409, gateText(later));
        if (attempt.cancelled) refuse(409, '启动已被停止请求取消，未开始挂单');
        if (signal?.aborted) refuse(503, '请求已取消，未开始挂单');
        if (session || recovery || cleaning || closed) refuse(409, '挂单状态已变化，请刷新后重试');
        // The record is on disk before the first order, so a crash cannot leave unknown orders behind.
        try { atomicJson(sessionPath, liveRecord(current)); }
        catch (error) { current.stream.close(); current.client.close(); log.warn({ err: error, type: 'ondo-mm' }, 'Ondo 会话记录写入失败'); throw new HttpError(503, '会话记录无法保存，未开始挂单'); }
        session = current; lastError = null; leftPositions = [];
        event(null, 'session', `开始实盘挂单：${current.config.markets.join('、')}`);
        for (const { name } of held) freeze(current, name, '启动时已确认接管现有仓位');
        starting = null;
        current.stream.start(); await tick();
        return state();
      })).finally(() => { if (starting === attempt) starting = null; });
    },
    async stop(expected) {
      if (expected && (starting || (session && (expected.sessionId !== session.prefix || expected.live !== session.live)))) {
        throw new HttpError(409, '会话已变化，请刷新后核对当前会话再停止');
      }
      if (starting) starting.cancelled = true;
      await halt(STOP_WAIT_MS);
      return state();
    },
    async cleanup() {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单运行中，无需清理');
      if (!recovery) return state();
      await cleanup(1);
      return state();
    },
    // The user has checked the venue by hand (the saved key may no longer work): forget the old session.
    discardRecovery() {
      if (starting) throw new HttpError(409, '正在启动实盘挂单，请稍后再试');
      if (session) throw new HttpError(409, '挂单运行中，无需处理');
      if (cleaning) throw new HttpError(409, '正在清理上次实盘的遗留挂单，请稍后再试');
      if (recovery) {
        rmSync(sessionPath, { force: true }); recovery = null; leftPositions = [];
        event(null, 'session', '已按人工核对结果忽略上次实盘的遗留记录');
      }
      return state();
    },
    // Before an update stops the process: every order must be withdrawn and seen gone.
    async prepareStop() {
      if (starting) starting.cancelled = true;
      if (session?.live) await halt(PREPARE_WAIT_MS);
      else if (session) finish(session);
      if (session) throw new HttpError(409, 'Ondo 挂单尚未确认全部撤销，暂不能停机，请稍后重试');
      if (cleaning) await cleaning;
      if (recovery) throw new HttpError(409, 'Ondo 上次实盘的遗留挂单尚未确认撤销，暂不能停机，请先完成清理');
    },
    // 本服务：resting quotes of the live session, as decimal strings, for the reward view to take out of the book.
    restingOrders() {
      const current = session;
      if (!current?.live) return [];
      return [...current.markets.values()].flatMap(market => [...market.orders.values()]
        .filter(order => order.remaining > 0n)
        .map(order => ({ market: market.name, side: order.side, price: fmt(order.price), size: fmt(order.remaining) })));
    },
    async close(waitMs = closeWaitMs) {
      if (session?.live) await halt(waitMs).catch(() => {});
      else if (session) finish(session);
      closed = true; clearInterval(timer);
      if (session) { saveLiveEvidence(session); session.stream.close(); session.client.close(); }
    },
  };
}
