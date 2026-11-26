import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from './api.ts';
import { useLiveResource } from './use-live-resource.ts';
import { normalizeCrossExBlockedBases, type CrossExFilterConfig } from '../../src/vendor/perpetual-crossex-config.ts';
import { indexSpotTransferPairs, parseCrossExSettings } from '../../src/vendor/perpetual-crossex-eligibility.ts';

const endpoint = '/api/monitor/perpetual/crossex-settings';

export function usePerpetualCrossExSettings(active: boolean, onExpired: () => void) {
  const live = useLiveResource(endpoint, { intervalMs: 15_000, parse: parseCrossExSettings, enabled: active, onExpired });
  const { data } = live;
  const error = live.error?.message ?? (live.status === 'offline' ? '网络已断开' : '');
  const [saveError, setSaveError] = useState(''), [actionBase, setActionBase] = useState('');
  const [saving, setSaving] = useState(false), [saved, setSaved] = useState(false);
  const savingRef = useRef(false);
  const blockedBases = useMemo(() => new Set(data?.config.blockedBases), [data?.config.blockedBases]);
  const spotTransferPairs = useMemo(() => indexSpotTransferPairs(data?.spotTransferPairs), [data?.spotTransferPairs]);
  function reportError(message: string, base = "") { setSaveError(message); setActionBase(base); setSaved(false); }
  const disabled = !data?.available || saving || Boolean(error);
  async function update(patch: Partial<CrossExFilterConfig>, base = ""): Promise<boolean> {
    if (!data || disabled || savingRef.current) return false;
    savingRef.current = true; setSaving(true); setSaved(false); setSaveError(""); setActionBase(base);
    try { live.commit(parseCrossExSettings(await api(endpoint, { method: "PUT", body: { revision: data.revision, config: { ...data.config, ...patch } }, timeoutMs: 10_000 }))); setSaved(true); return true; }
    catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "保存失败");
      // A timeout can occur after the server committed; reload the actual saved state.
      if (cause instanceof ApiError && cause.status === 401) onExpired();
      else await live.refresh();
      return false;
    } finally { savingRef.current = false; setSaving(false); }
  }
  async function setBaseBlocked(input: string, blocked: boolean): Promise<boolean> {
    if (!data || disabled || savingRef.current) return false;
    try {
      const base = normalizeCrossExBlockedBases([input])[0];
      const next = blocked ? [...blockedBases, base] : [...blockedBases].filter(item => item !== base);
      return await update({ blockedBases: normalizeCrossExBlockedBases(next) }, base);
    } catch (cause) { reportError(cause instanceof Error ? cause.message : "币种无效", input); return false; }
  }
  return { data, error, saveError, saving, saved, disabled, blockedBases, spotTransferPairs, actionBase, update, setBaseBlocked, reportError };
}

export type PerpetualCrossExController = ReturnType<typeof usePerpetualCrossExSettings>;
