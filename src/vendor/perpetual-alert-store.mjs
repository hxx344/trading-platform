// 移植自 project-aggregation 的 modules/monitor/server/perpetual-alert-store.mjs（7745181）。
import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readBounded } from '../service/handoff-file.ts';
import { join } from 'node:path';
import { initialPerpetualAlertState, validatePerpetualAlertConfig } from './perpetual-alert-engine.mjs';
import { boundedPerpetualAlertState, PERPETUAL_ALERT_FILE_BYTES } from './perpetual-alert-limits.mjs';

export const PERPETUAL_ALERT_FILE = 'opportunity-alerts.json';
export const PERPETUAL_ALERT_IMPORT = 'perpetual-alerts.import.json';

export function parsePerpetualAlertState(input) {
  if (!input || input.version !== 1 || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !input.ruleStates || typeof input.ruleStates !== 'object' || Array.isArray(input.ruleStates) || !Array.isArray(input.history)) {
    throw new Error('机会提醒文件格式无效');
  }
  const config = validatePerpetualAlertConfig(input.config);
  const ruleStates = Object.fromEntries(config.rules.map(rule => {
    const saved = input.ruleStates[rule.id];
    if (saved && (typeof saved.armed !== 'boolean' || [saved.lastSentAt, saved.lastAttemptAt].some(at => at !== null && (!Number.isFinite(at) || at < 0)))) throw new Error('提醒触发状态无效');
    return [rule.id, saved ? { armed: saved.armed, lastSentAt: saved.lastSentAt, lastAttemptAt: saved.lastAttemptAt } : { armed: true, lastSentAt: null, lastAttemptAt: null }];
  }));
  const history = input.history.slice(0, 100).map(item => {
    if (!item || !Number.isFinite(item.time) || item.time <= 0 || !Number.isFinite(item.netSpreadPercent)
      || !['sending', 'sent', 'failed'].includes(item.status)
      || ![['id', 64], ['ruleId', 64], ['name', 80], ['base', 100], ['longKey', 160], ['shortKey', 160], ['error', 200]]
        .every(([key, length]) => typeof item[key] === 'string' && item[key].length <= length)) throw new Error('提醒历史记录无效');
    const { id, ruleId, name, time, status, base, longKey, shortKey, netSpreadPercent, error } = item;
    const event = { id, ruleId, name, time, status, base, longKey, shortKey, netSpreadPercent, error };
    if (typeof item.uncertain === 'boolean') event.uncertain = item.uncertain;
    if (item.stages !== undefined) {
      if (!Array.isArray(item.stages) || item.stages.some(stage => !stage || !['generated', 'sending', 'confirmed', 'failed', 'unknown'].includes(stage.status)
        || !Number.isFinite(stage.at))) throw new Error('提醒投递阶段无效');
      event.stages = item.stages.map(({ status, at }) => ({ status, at }));
    }
    return event;
  });
  // Only channel facts travel with an event. Imported text must never be interpreted as a platform outbox id.
  const deliveryReviews = input.deliveryReviews;
  if (deliveryReviews !== undefined && (!deliveryReviews || typeof deliveryReviews !== 'object' || Array.isArray(deliveryReviews))) throw new Error('提醒核对记录无效');
  return boundedPerpetualAlertState({ version: 1, revision: input.revision, config, ruleStates, history,
    ...(deliveryReviews === undefined ? {} : { deliveryReviews }) }).state;
}

function readState(file) {
  if (lstatSync(file).isSymbolicLink()) throw new Error('机会提醒文件不能是符号链接');
  const raw = readBounded(file, PERPETUAL_ALERT_FILE_BYTES, stat => {
    if (process.getuid && stat.uid !== process.getuid()) throw new Error('机会提醒文件不属于服务账户');
  });
  if (raw === null) throw Object.assign(new Error('机会提醒文件已移走'), { code: 'ENOENT' });
  return parsePerpetualAlertState(JSON.parse(raw));
}

// The executor owns the live file. Import helpers can only publish a separate pending file.
export function openPerpetualAlertStore(directory, pendingFile) {
  const file = join(directory, PERPETUAL_ALERT_FILE);
  const claimed = pendingFile?.replace(/\.json$/, '.loading.json');
  const rejected = pendingFile?.replace(/\.json$/, '.rejected.json');
  let state = initialPerpetualAlertState(), saved = false;
  try { state = readState(file); saved = true; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('机会提醒文件无法读取，请修复或恢复 opportunity-alerts.json。', { cause: error }); }
  async function save(next) {
    const { state: copy, body } = boundedPerpetualAlertState(next);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, body, { mode: 0o600, flag: 'wx' }); await rename(temporary, file); saved = true; state = copy; }
    finally { await unlink(temporary).catch(() => {}); }
  }
  return {
    get: () => structuredClone(state), save,
    pending: () => Boolean(pendingFile && (existsSync(claimed) || existsSync(pendingFile))),
    async adoptPending() {
      if (!pendingFile) return;
      if (!existsSync(claimed)) {
        try { await rename(pendingFile, claimed); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
      }
      if (saved) { await unlink(claimed); return; }
      let incoming;
      try { incoming = readState(claimed); }
      catch { await rename(claimed, rejected); throw new Error('待载入的机会提醒文件无效，已保留供核对'); }
      // Revision zero is the empty platform state; importing installs its first local revision.
      incoming.revision = 1;
      await save(incoming);
      // If cleanup fails, the next pass sees the durable local state and only removes the stale claim.
      await unlink(claimed).catch(() => {});
      return structuredClone(incoming);
    },
  };
}
