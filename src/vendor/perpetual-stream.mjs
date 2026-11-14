// 摘自 project-aggregation 工作台 modules/monitor/server/perpetual-service.mjs（提交 c84ba27）第 21–169 行：报价合并
// （mergePerpetualQuote）、目录元数据（withMarketMetadata）与 SSE 增量帧（createPerpetualPatch / createPerpetualChangedPatch /
// createPerpetualDelta）。只放数据规则，本服务的采集器（src/monitor/perpetual.ts）与页面共用。与原文件不同的地方：
// - MAX_FUTURE_MS 与 withMarketMetadata 改为导出（原文件只在模块内用）；
// - perpetualPriceIdentity 原从 lib/perpetual-price-history.ts 导入（该文件另引入页面的读取节流），这里只抄这一行函数。

export const perpetualPriceIdentity = (market) => JSON.stringify([market.exchange, market.symbol, market.base, market.quoteCurrency, market.marketId ?? null, market.multiplier ?? 1, market.contractUnit ?? null, market.collateralCurrency ?? null]);

export const PERPETUAL_STALE_MS = 30_000;
export const MAX_FUTURE_MS = 5_000;
const fields = ['bid', 'ask', 'mark', 'last', 'fundingRate', 'fundingIntervalHours', 'nextFundingAt'];
const priceFields = new Set(['bid', 'ask', 'mark', 'last']);
const feeFields = ['takerFeeRate', 'takerFeeAt', 'takerFeeSource'];
const identityFields = ['assetClass', 'identitySource', 'identityVerified'];
const catalogFields = new Set(['delisting', 'delistingAt', ...feeFields, ...identityFields]);
const streamValueFields = [...fields, 'base', 'quoteCurrency', 'multiplier', 'displayBase', 'contractUnit', 'collateralCurrency', 'historyIdentity', 'comparable', 'transport', ...catalogFields];
const streamTimeFields = ['bidAt', 'askAt', 'bidAskAt', 'markAt', 'lastAt', 'fundingAt', 'fundingIntervalHoursUpdatedAt', 'nextFundingAtUpdatedAt', 'receivedAt', 'sourceTime'];
const historyIdentities = new WeakMap();

/** Only changed fields cross the wire. The retained baseline is exactly what readers received. */
export function createPerpetualPatch(snapshot, previous, freshnessMs = 5_000) {
  const patches = [], seen = new Set();
  for (const quote of snapshot.quotes) {
    const key = `${quote.exchange}:${quote.symbol}`, old = previous.get(key);
    seen.add(key);
    if (old === quote) continue;
    if (!old) { patches.push([key, quote]); previous.set(key, quote); continue; }
    const changes = {};
    for (const field of streamValueFields) if (old[field] !== quote[field]) changes[field] = quote[field] ?? null;
    const confirmed = Math.floor(quote.receivedAt / freshnessMs) > Math.floor(old.receivedAt / freshnessMs);
    // A price change includes its own original timestamp. Unchanged book/mark/rate
    // confirmations stay paced even when an unrelated last-trade price changes.
    for (const field of streamTimeFields) {
      const valueField = field === 'fundingAt' ? 'fundingRate' : field.endsWith('UpdatedAt') ? field.slice(0, -9) : field.slice(0, -2);
      const changed = Object.hasOwn(changes, valueField) || (field === 'bidAskAt' && (Object.hasOwn(changes, 'bid') || Object.hasOwn(changes, 'ask')));
      if ((confirmed || changed) && old[field] !== quote[field]) changes[field] = quote[field] ?? null;
    }
    if (!Object.keys(changes).length) continue;
    // Receipt time is transport metadata, never a substitute for field timestamps.
    changes.receivedAt = quote.receivedAt;
    if (old.sourceTime !== quote.sourceTime) changes.sourceTime = quote.sourceTime;
    patches.push([key, changes]); previous.set(key, { ...old, ...changes });
  }
  const removed = [];
  for (const key of previous.keys()) if (!seen.has(key)) { removed.push(key); previous.delete(key); }
  const metadata = { ...snapshot }; delete metadata.quotes;
  return { ...metadata, type: 'patch', patches, removed };
}

/** Visit only changed identities. Unchanged quote confirmations retain the same pacing. */
export function createPerpetualChangedPatch(metadata, quotes, previous, keys, freshnessMs = 5_000) {
  const changed = [], baseline = new Map(), removed = [];
  for (const key of keys) {
    const quote = quotes.get(key);
    if (!quote) { if (previous.delete(key)) removed.push(key); continue; }
    changed.push(quote);
    if (previous.has(key)) baseline.set(key, previous.get(key));
  }
  const frame = createPerpetualPatch({ ...metadata, quotes: changed }, baseline, freshnessMs);
  for (const [key, quote] of baseline) previous.set(key, quote);
  frame.removed = removed;
  return frame;
}

/** Shared incremental frame, preserving actual field times while pacing unchanged price confirmations. */
export function createPerpetualDelta(snapshot, previous, freshnessMs = 5_000) {
  const updates = [], seen = new Set();
  for (const quote of snapshot.quotes) {
    const key = `${quote.exchange}:${quote.symbol}`, old = previous.get(key);
    seen.add(key);
    if (!old || streamValueFields.some(field => old[field] !== quote[field]) || Math.floor(quote.receivedAt / freshnessMs) > Math.floor(old.receivedAt / freshnessMs)) {
      updates.push(quote); previous.set(key, quote);
    }
  }
  const removed = [];
  for (const key of previous.keys()) if (!seen.has(key)) { removed.push(key); previous.delete(key); }
  const metadata = { ...snapshot }; delete metadata.quotes;
  return { ...metadata, type: 'delta', updates, removed };
}

/** Merge sparse ticker messages without letting funding updates refresh old prices. */
export function mergePerpetualQuote(previous, update, now = Date.now()) {
  if (!update || typeof update.exchange !== 'string' || typeof update.symbol !== 'string' || typeof update.base !== 'string' || !['USD', 'USDT', 'USDC', 'USD1', 'USDG'].includes(update.quoteCurrency)) return previous;
  const sourceTime = Number.isFinite(update.sourceTime) ? update.sourceTime : null;
  if (sourceTime !== null && sourceTime > now + MAX_FUTURE_MS) return previous;
  const time = sourceTime === null ? now : Math.min(now, sourceTime);
  const multiplier = Number.isFinite(update.multiplier) && update.multiplier > 0 ? update.multiplier : 1;
  const identityChanged = previous && (previous.base !== update.base || previous.quoteCurrency !== update.quoteCurrency || (previous.multiplier ?? 1) !== multiplier || (typeof update.contractUnit === 'string' && previous.contractUnit !== update.contractUnit));
  const next = previous && !identityChanged ? { ...previous } : {
    exchange: update.exchange, symbol: update.symbol, base: update.base, quoteCurrency: update.quoteCurrency,
    multiplier,
    bid: null, ask: null, mark: null, last: null, fundingRate: null, fundingIntervalHours: null, nextFundingAt: null,
    receivedAt: now, sourceTime, transport: 'ws',
  };
  let changed = false, rateUpdated = false;
  for (const field of fields) {
    if (!Object.hasOwn(update, field)) continue;
    const value = update[field];
    if (value !== null && (!Number.isFinite(value) || (priceFields.has(field) && value <= 0) || (field === 'fundingIntervalHours' && value <= 0))) continue;
    const stamp = priceFields.has(field) ? `${field}At` : field === 'fundingRate' ? 'fundingAt' : `${field}UpdatedAt`;
    if (Number.isFinite(next[stamp]) && time < next[stamp]) continue;
    // A delayed rate must not revive a value from before the current interval.
    if (field === 'fundingRate' && Number.isFinite(next.fundingIntervalHoursUpdatedAt) && time < next.fundingIntervalHoursUpdatedAt) continue;
    if (field === 'fundingIntervalHours' && next[field] !== null && value !== next[field] && !rateUpdated) next.fundingRate = null;
    next[field] = value; next[stamp] = time; changed = true;
    if (field === 'fundingRate') rateUpdated = true;
  }
  if (!changed) return previous;
  for (const field of ['displayBase', 'contractUnit', 'collateralCurrency']) if (typeof update[field] === 'string') next[field] = update[field];
  if (typeof update.comparable === 'boolean') next.comparable = update.comparable;
  next.bidAskAt = Number.isFinite(next.bidAt) && Number.isFinite(next.askAt) ? Math.min(next.bidAt, next.askAt) : undefined;
  next.receivedAt = now;
  next.sourceTime = sourceTime;
  next.transport = update.transport === 'rest' ? 'rest' : 'ws';
  return next;
}

export function withMarketMetadata(quote, market) {
  // Directory classification is display metadata, not a new price confirmation or
  // permission to compare contracts. Old subscription contexts cannot override it.
  let classified = quote;
  for (const field of identityFields) {
    const candidate = market?.[field];
    const valid = field === 'identityVerified' ? typeof candidate === 'boolean' : typeof candidate === 'string' && candidate.trim().length > 0;
    const value = valid ? candidate : quote[field] === undefined ? undefined : null;
    if (value === quote[field]) continue;
    if (classified === quote) classified = { ...quote };
    classified[field] = value;
  }
  // History must match the current directory's complete contract identity,
  // without copying collateral/channel metadata into comparison eligibility.
  let historyIdentity = null;
  if (market && market.exchange === quote.exchange && market.symbol === quote.symbol
    && market.base === quote.base && market.quoteCurrency === quote.quoteCurrency
    && (market.multiplier ?? 1) === (quote.multiplier ?? 1)
    && (market.contractUnit ?? null) === (quote.contractUnit ?? null)) {
    historyIdentity = historyIdentities.get(market);
    if (!historyIdentity) { historyIdentity = perpetualPriceIdentity(market); historyIdentities.set(market, historyIdentity); }
  }
  if (historyIdentity !== quote.historyIdentity) {
    if (classified === quote) classified = { ...quote };
    classified.historyIdentity = historyIdentity;
  }
  quote = classified;
  const delisting = market?.delisting === true;
  const delistingAt = delisting && Number.isSafeInteger(market.delistingAt) && market.delistingAt > 0 && market.delistingAt <= 8.64e15 ? market.delistingAt : null;
  const sameLifecycle = quote.delisting === delisting && quote.delistingAt === delistingAt;
  // Fee metadata has its own age. It must propagate without a new ticker and
  // never confirm an old book. The normal per-tick path allocates nothing.
  if (market?.takerFeeRate === undefined && market?.takerFeeAt === undefined && market?.takerFeeSource === undefined
    && quote.takerFeeRate === undefined && quote.takerFeeAt === undefined && quote.takerFeeSource === undefined) return sameLifecycle ? quote : { ...quote, delisting, delistingAt };
  const takerFeeRate = Number.isFinite(market?.takerFeeRate) && market.takerFeeRate >= 0 && market.takerFeeRate <= 0.1 ? market.takerFeeRate : null;
  const takerFeeAt = takerFeeRate !== null && Number.isSafeInteger(market?.takerFeeAt) && market.takerFeeAt > 0 && market.takerFeeAt <= 8.64e15 ? market.takerFeeAt : null;
  const takerFeeSource = typeof market?.takerFeeSource === 'string' ? market.takerFeeSource : null;
  return sameLifecycle && quote.takerFeeRate === takerFeeRate && quote.takerFeeAt === takerFeeAt && quote.takerFeeSource === takerFeeSource
    ? quote : { ...quote, delisting, delistingAt, takerFeeRate, takerFeeAt, takerFeeSource };
}
