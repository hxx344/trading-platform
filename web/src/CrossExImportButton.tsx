// 来自 project-aggregation 工作台提交 7745181，接口与导航适配独立交易平台。
import { useId, useState } from 'react';
import type { PerpetualSpread } from '../../src/vendor/perpetual-spreads.ts';
import { prepareCrossExImport, createCrossExImportId, type CrossExImportOptions } from './crossex-import.ts';
import { withoutMonitorLink } from './monitor-link.ts';
export type { CrossExImportOptions } from './crossex-import.ts';

export function CrossExImportButton({ row, pairLabel, options, readNow }: { row: PerpetualSpread; pairLabel: string; options: CrossExImportOptions; readNow: () => number }) {
  const reasonId = useId();
  const [clickFailure, setClickFailure] = useState<{ reason: string; at: number } | null>(null);
  const selection = prepareCrossExImport(row, options);
  const reason = selection.reason ?? (clickFailure && options.now < clickFailure.at ? clickFailure.reason : null);
  return <div className="scanner-crossex-import" data-crossex-import="">
    <button type="button" disabled={Boolean(reason)} aria-label={`导入 CrossEx：${pairLabel}`} aria-describedby={reason ? reasonId : undefined} onClick={event => {
      event.stopPropagation();
      // A retained detail row can expire between the last render and this click.
      const at = readNow(), current = prepareCrossExImport(row, { ...options, now: at });
      if (!current.query) { setClickFailure({ reason: current.reason, at }); return; }
      setClickFailure(null);
      const url = new URL(withoutMonitorLink(location.href));
      url.hash = '#/crossex/hedge';
      history.pushState({ crossexImport: { ...current.query, importId: createCrossExImportId() } }, '', url);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    }}>导入 CrossEx</button>
    {reason ? <small id={reasonId}>{reason}</small> : null}
  </div>;
}
