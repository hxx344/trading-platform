// 移植自 project-aggregation 的 modules/monitor/server/perpetual-alert-service.mjs（7745181）。
import { randomUUID } from 'node:crypto';
import { initialPerpetualAlertState, validatePerpetualAlertConfig, evaluatePerpetualAlertQuote, createPerpetualConditionTracker } from './perpetual-alert-engine.mjs';
import { boundedPerpetualAlertState } from './perpetual-alert-limits.mjs';

const freshState = () => ({ armed: true, lastAttemptAt: null, lastSentAt: null });
const emptyProgress = enabled => ({ state: enabled ? 'observing' : 'disabled', checkedAt: null, netSpreadPercent: null, continuousSeconds: 0, hitRatio: 0, coverage: 0, reason: enabled ? '等待下一次后台观察' : '观察已关闭', lastAttemptAt: null, lastSentAt: null });
const day = 86_400_000;
const publicReviews = value => Array.isArray(value) ? value.slice(-5).filter(item => item && typeof item.id === 'string' && Number.isFinite(item.at)
  && typeof item.note === 'string' && item.note.length <= 500 && typeof item.source === 'string' && item.source.length <= 200)
  .map(({ id, at, note, source }) => ({ id, at, actor: 'authenticated_admin', note, source })) : [];

/** No market fetches: twenty saved pairs, one-second bounded observations, event-only writes. */
export function createPerpetualAlertService({ store, getQuote, isVenueLive, notifications, clock = Date.now, marketHealthy = () => true, unavailableReason = '', onImportError } = {}) {
  let state = store?.get() ?? initialPerpetualAlertState(), queue = Promise.resolve(), deliveryTask = null, pendingWrite = null;
  let running = false, storageError = '', needsPersist = false, sendingRuleId = null;
  const trackers = new Map(), progress = new Map(), candidates = new Set();
  // An interrupted sending row is evidence of uncertainty, never a reason to resend.
  let interrupted = new Set(state.history.filter(item => item.status === 'sending').map(item => item.id));
  const persist = async () => {
    pendingWrite = boundedPerpetualAlertState(state).state;
    if (state.deliveryReviews !== undefined) state.deliveryReviews = pendingWrite.deliveryReviews;
    needsPersist = false;
    try { await store.save(pendingWrite); pendingWrite = null; storageError = ''; }
    catch { storageError = '机会提醒保存失败，暂停发送；请检查磁盘空间与目录权限。'; throw Object.assign(new Error(storageError), { status: 503 }); }
  };
  // A rejected page edit must not later become effective because an unrelated observation retries its disk write.
  async function saveEdit(next) {
    try { await store.save(next); storageError = ''; }
    catch (error) {
      if (error?.status === 413) throw error;
      storageError = '机会提醒保存失败，请检查磁盘空间与目录权限。';
      throw Object.assign(new Error(storageError), { status: 503 });
    }
  }
  const serial = work => {
    const task = queue.then(async () => {
      if (pendingWrite) { try { await store.save(pendingWrite); pendingWrite = null; storageError = ''; } catch { throw Object.assign(new Error(storageError), { status: 503 }); } }
      return work();
    });
    queue = task.catch(() => {}); return task;
  };
  const view = () => ({ available: Boolean(store), generatedAt: clock(), revision: state.revision, config: structuredClone(state.config),
    webhookConfigured: notifications?.configured() ?? false, running, error: unavailableReason || storageError || (!marketHealthy() ? '行情缓存保存失败，暂停提醒。' : ''),
    progress: Object.fromEntries(state.config.rules.map(rule => [rule.id, { ...(progress.get(rule.id) ?? emptyProgress(rule.enabled)), ...(state.ruleStates[rule.id] ? { lastAttemptAt: state.ruleStates[rule.id].lastAttemptAt, lastSentAt: state.ruleStates[rule.id].lastSentAt } : {}) }])),
    history: structuredClone(state.history.filter(item => item.time <= clock() && item.time > clock() - day).slice(0, 100).map(item => ({ ...item,
      deliveryStage: interrupted.has(item.id) || item.uncertain || /结果不确定/.test(item.error) ? 'unknown' : item.status === 'sent' ? 'confirmed' : item.status,
      reviews: publicReviews(state.deliveryReviews?.[item.id]) }))),
  });
  let importing = null, nextImportAt = 0;
  function adopt() {
    if (importing) return importing;
    if (clock() < nextImportAt || !store?.pending?.()) return null;
    importing = serial(async () => {
      const loaded = await store.adoptPending();
      if (!loaded) return;
      state = loaded;
      interrupted = new Set(state.history.filter(item => item.status === 'sending').map(item => item.id));
      trackers.clear(); progress.clear(); candidates.clear();
    }).catch(error => {
      nextImportAt = clock() + 30_000;
      onImportError?.(error instanceof Error ? error.message : '读取失败');
    }).finally(() => { importing = null; });
    return importing;
  }
  const canSend = (rule, now) => {
    const condition = progress.get(rule.id), currentRule = state.config.rules.find(item => item.id === rule.id);
    return running && state.config.enabled && rule.enabled && marketHealthy() && condition?.state === 'triggered'
      && currentRule && JSON.stringify(currentRule) === JSON.stringify(rule) && now >= condition.checkedAt
      && now - condition.checkedAt <= 2000 && evaluatePerpetualAlertQuote(rule, getQuote, now, isVenueLive).hit;
  };
  function drain() {
    if (deliveryTask) return deliveryTask;
    if (!candidates.size && !needsPersist && !pendingWrite) return Promise.resolve();
    deliveryTask = (async () => {
      while (running && candidates.size) {
        const id = candidates.values().next().value; candidates.delete(id);
        sendingRuleId = id;
        // Hold the configuration queue only for disk transactions, never during network delivery.
        const pending = await serial(async () => {
          const rule = state.config.rules.find(item => item.id === id), now = clock(), saved = state.ruleStates[id];
          if (!rule || !saved?.armed || !notifications?.configured() || !canSend(rule, now) || saved.lastAttemptAt !== null && now - saved.lastAttemptAt < rule.cooldownSeconds * 1000) return null;
          const condition = progress.get(id), result = evaluatePerpetualAlertQuote(rule, getQuote, now, isVenueLive);
          saved.armed = false; saved.lastAttemptAt = now;
          const event = { id: randomUUID(), ruleId: id, name: rule.name, time: now, status: 'sending', base: rule.base, longKey: rule.longKey, shortKey: rule.shortKey, netSpreadPercent: result.netSpreadPercent, error: '', stages: [{ status: 'generated', at: now }, { status: 'sending', at: now }] };
          state.history.unshift(event); state.history = state.history.slice(0, 100);
          await persist();
          return { rule, now, condition, result, event, saved };
        });
        if (!pending) { sendingRuleId = null; continue; }
        const { rule, now, condition, result, event, saved } = pending;
        try {
          await notifications.send(`合约机会告警 · ${rule.name}\n${rule.base}：做多 ${rule.longKey} / 做空 ${rule.shortKey}\n扣 taker 与滑点预算后价差 ${result.netSpreadPercent.toFixed(4)}%（阈值 ${rule.thresholdPercent}%）\n持续 ${condition.continuousSeconds} 秒；近 ${rule.windowSeconds} 秒达标 ${(condition.hitRatio * 100).toFixed(1)}%\n仅为入场筛选，未计退出价差、持有期资金费及实际成交差异。\n时间：${new Date(now).toISOString()}`, () => {
            if (!canSend(rule, clock())) throw new Error('发送前条件或报价已变化，取消本次提醒');
          });
          saved.lastSentAt = clock(); event.status = 'sent';
        } catch (error) {
          event.status = 'failed'; event.error = error?.uncertain ? '飞书投递结果不确定（可能已发出），不再重发；条件回落后再次达标才会提醒' : error instanceof Error ? error.message.slice(0, 200) : '提醒发送失败';
          event.uncertain = error?.uncertain === true;
          // A definite non-delivery re-arms after the cooldown; an uncertain one is never resent.
          // A possibly posted message counts as sent for the cooldown.
          if (!error?.uncertain) saved.armed = true; else saved.lastSentAt = clock();
        }
        event.stages.push({ status: event.uncertain ? 'unknown' : event.status === 'sent' ? 'confirmed' : 'failed', at: clock() });
        await serial(persist);
        sendingRuleId = null;
      }
      if (needsPersist || pendingWrite) await serial(async () => { if (needsPersist) await persist(); });
    })().finally(() => { deliveryTask = null; sendingRuleId = null; });
    return deliveryTask;
  }
  function check() {
    if (!running || !store) return Promise.resolve();
    const adoption = adopt();
    if (adoption) return adoption;
    const now = clock(), retained = state.history.filter(item => item.time > now - day && item.time <= now).slice(0, 100);
    if (retained.length !== state.history.length) { state.history = retained; needsPersist = true; }
    // Observe every rule before doing any I/O. Slow notification delivery cannot freeze another pair.
    for (const rule of state.config.rules) {
      if (!rule.enabled) { progress.set(rule.id, emptyProgress(false)); trackers.delete(rule.id); candidates.delete(rule.id); continue; }
      const result = marketHealthy() ? evaluatePerpetualAlertQuote(rule, getQuote, now, isVenueLive) : { valid: false, hit: false, netSpreadPercent: null, reason: '行情缓存保存失败，暂停提醒' };
      if (!trackers.has(rule.id)) trackers.set(rule.id, createPerpetualConditionTracker(rule));
      const condition = trackers.get(rule.id).observe(result, now);
      progress.set(rule.id, { state: condition.ready ? 'triggered' : 'observing', checkedAt: now, netSpreadPercent: result.netSpreadPercent,
        continuousSeconds: condition.continuousSeconds, hitRatio: condition.hitRatio, coverage: condition.coverage,
        reason: !result.valid ? result.reason : condition.ready ? '持续时间与窗口占比均达标' : result.hit ? '当前达标，继续积累持续时间与窗口覆盖' : result.reason });
      const saved = state.ruleStates[rule.id] ??= freshState();
      // Missing/stale observations interrupt duration but cannot prove a price re-entry.
      if (result.valid && !result.hit && !saved.armed) { saved.armed = true; needsPersist = true; }
      if (rule.id !== sendingRuleId && condition.ready && state.config.enabled && notifications?.configured() && saved.armed && (saved.lastAttemptAt === null || now - saved.lastAttemptAt >= rule.cooldownSeconds * 1000)) candidates.add(rule.id);
      else candidates.delete(rule.id);
    }
    return drain();
  }
  return {
    view, check, healthy: () => !storageError,
    review(input) {
      return serial(async () => {
        if (!store) throw Object.assign(new Error(unavailableReason || '机会提醒存储不可用'), { status: 503 });
        if (!input || Object.keys(input).some(key => !['id', 'note', 'source'].includes(key)) || typeof input.id !== 'string'
          || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 500
          || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 200) throw Object.assign(new Error('请填写核对说明（最多500字）和证据来源（最多200字）'), { status: 400 });
        if (/(?:private.?key|secret|signature|authorization|password)\s*[:=]|\/bot\/v2\/hook\//i.test(`${input.note} ${input.source}`)) throw Object.assign(new Error('核对说明不可包含凭据或完整签名'), { status: 400 });
        if (!state.history.some(item => item.id === input.id && item.time > clock() - day)) throw Object.assign(new Error('投递记录不存在或已超出保留范围'), { status: 404 });
        const retained = new Set(state.history.map(item => item.id));
        const reviews = Object.fromEntries(Object.entries(state.deliveryReviews ?? {}).filter(([id]) => retained.has(id)));
        reviews[input.id] = [...(reviews[input.id] ?? []).slice(-4), { id: randomUUID(), actor: 'authenticated_admin', at: clock(), note: input.note.trim(), source: input.source.trim() }];
        // Reject before changing the live state or pending write. Every later
        // persistence path uses the same byte budget and retains channel facts.
        const next = boundedPerpetualAlertState({ ...state, deliveryReviews: reviews }).state;
        await saveEdit(next);
        state.deliveryReviews = next.deliveryReviews;
        return view();
      });
    },
    update(input) {
      return serial(async () => {
        if (!store) throw Object.assign(new Error(unavailableReason || '机会提醒存储不可用'), { status: 503 });
        if (!Number.isSafeInteger(input?.revision) || input.revision !== state.revision) throw Object.assign(new Error('提醒配置已被另一页面修改，请重载后再保存。'), { status: 409 });
        const revision = state.revision + 1;
        if (!Number.isSafeInteger(revision)) throw Object.assign(new Error('本机提醒设置修订号已达上限，无法保存'), { status: 409 });
        let config;
        try { config = validatePerpetualAlertConfig(input); } catch (error) { throw Object.assign(error, { status: 400 }); }
        const nextStates = {}, reset = new Set(trackers.keys());
        for (const rule of config.rules) {
          const old = state.config.rules.find(item => item.id === rule.id);
          if (old && JSON.stringify(old) === JSON.stringify(rule)) {
            nextStates[rule.id] = state.ruleStates[rule.id] ?? freshState(); reset.delete(rule.id);
          } else { nextStates[rule.id] = freshState(); reset.add(rule.id); }
        }
        await saveEdit({ ...state, config, ruleStates: nextStates, revision });
        for (const id of reset) { trackers.delete(id); progress.delete(id); candidates.delete(id); }
        state.config = config; state.ruleStates = nextStates; state.revision = revision;
        return view();
      });
    },
    start() { running = true; void adopt(); },
    async stop() { running = false; candidates.clear(); trackers.clear(); progress.clear(); await deliveryTask?.catch(() => {}); await queue; },
    metrics: () => ({ rules: state.config.rules.length, enabled: state.config.enabled, observedRules: trackers.size, observationPoints: [...trackers.values()].reduce((sum, tracker) => sum + tracker.size(), 0), pendingCandidates: candidates.size, events: state.history.length, storageError }),
  };
}
