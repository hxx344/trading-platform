// 改编自工作台 modules/crossex/src/SettingsForm.tsx（提交 7745181）。差异：本服务不在页面填写或移除 API 密钥（密钥只在
// secrets.json，经“设置 → 从工作台导入”或配置文件管理），连接区块改为只读显示账户信息与 config.json 的硬上限；
// 没有 Market Monitor 地址、用户名与密码（机会列表等行情监控 M-4）。额度表单的字段、文案与保存方式不变。
import { useState } from 'react';
import type { Config } from './types.ts';
import type { CrossexLimits, LiveView } from './live-types.ts';
import { liveStatus } from './live-display.ts';
import { time } from './display.ts';

export type LiveConfig = Pick<Config, 'entryPaused' | 'notionalPerLeg' | 'maxOpen' | 'maxTotalNotional' | 'feeBps' | 'feeSchedule' | 'slippageBps' | 'minNetBps' | 'cooldownSeconds'>;
const numericFields = [
  ['notionalPerLeg', '单腿名义额上限（非保证金）', 'USDT'], ['maxTotalNotional', '总名义额上限', 'USDT'],
  ['maxOpen', '持仓组数上限', '组'], ['slippageBps', '价格偏离上限', 'bp'],
  ['minNetBps', '机会最低预算净价差', 'bp'], ['feeBps', '默认手续费预算', 'bp'],
  ['cooldownSeconds', '同币种操作冷却', '秒'],
] as const;
const permission = (value: string) => ({ verified: '已校验', denied: '无权限', unknown: '待首次写入确认' } as Record<string, string>)[value] || value;
const positionMode = (value: string | null) => value === 'SINGLE' ? '单向持仓' : value === 'DUAL' ? '双向持仓' : '持仓模式待查询';

export default function SettingsForm({ config, connection, limits, ready, loading, loadError, retry, busy, save }: {
  config: LiveConfig | null; connection: LiveView['connection'] | null; limits: CrossexLimits | null; ready: boolean; loading: boolean; loadError: string; retry: () => void; busy: boolean;
  save: (input: object) => Promise<boolean>;
}) {
  const configured = connection ? connection.configured : null;
  return <div className="settings-layout">
    <section className="panel settings-panel" aria-label="Gate CrossEx 实盘连接">
      <h2>Gate CrossEx 实盘连接</h2>
      <p className="muted">API 密钥只保存在本服务的 secrets.json，在“设置 → 从工作台导入”导入 CrossEx 账户，或手写配置文件后重启服务；本页不填写、不回显密钥。</p>
      <p className="muted" role="status">连接配置：{configured == null ? '待读取' : configured ? '已有账户连接' : '尚未配置账户'}</p>
      {loadError ? <div className="notice warning" role="alert"><span>{loadError}{ready ? ' 已保留先前读取的连接信息。' : ''}</span><button type="button" disabled={busy || loading} onClick={retry}>{loading ? '正在重试…' : '重试连接信息'}</button></div> : !ready ? <div className="notice" role="status"><span>正在读取连接与授权信息…</span><button type="button" disabled={busy || loading} onClick={retry}>重试连接信息</button></div> : null}
      {connection && <dl className="ticket-details">
        <div><dt>账户 UID</dt><dd>{connection.accountId || '—'}</dd></div>
        <div><dt>API Key</dt><dd>{connection.keySuffix ? '•••• ' + connection.keySuffix : '—'}</dd></div>
        <div><dt>连接状态</dt><dd className={connection.connected && !connection.error ? 'positive' : 'warning'}>{liveStatus(connection.status)}</dd></div>
        <div><dt>读取权限</dt><dd>{permission(connection.permissions.read)}</dd></div>
        <div><dt>交易权限</dt><dd className={connection.permissions.trade === 'denied' ? 'negative' : undefined}>{permission(connection.permissions.trade)}</dd></div>
        <div><dt>持仓模式</dt><dd>{positionMode(connection.positionMode)}</dd></div>
        <div><dt>最近校验</dt><dd>{connection.lastVerifiedAt ? time(connection.lastVerifiedAt) : '—'}</dd></div>
        {connection.error && <div><dt>连接错误</dt><dd className="warning">{connection.error}</dd></div>}
      </dl>}
      <div className="disconnect-row">
        <span>硬上限（config.json 的 crossex.limits，页面不能修改；保存的额度不得超过它）</span>
        {limits ? <dl className="ticket-details">
          <div><dt>单腿名义额</dt><dd>{String(limits.notionalPerLeg)} USDT</dd></div>
          <div><dt>持仓组数</dt><dd>{String(limits.maxOpen)} 组</dd></div>
          <div><dt>总名义额</dt><dd>{String(limits.maxTotalNotional)} USDT</dd></div>
        </dl> : <span className="muted">{ready ? '服务未返回硬上限。' : '待读取'}</span>}
      </div>
    </section>
    {config ? <SettingsPreferences config={config} ready={ready} busy={busy} save={save}/> : <section className="panel settings-panel"><h2>手动开仓额度与检查</h2><p className="muted">{loadError ? '配置读取失败。重试连接信息后，已有额度设置会显示在这里。' : '正在读取已保存的额度设置…'}</p></section>}
  </div>;
}

/** Keep the user's draft stable across bootstrap refreshes and normal account polling. */
function SettingsPreferences({ config, ready, busy, save }: { config: LiveConfig; ready: boolean; busy: boolean; save: (input: object) => Promise<boolean> }) {
  const [draft, setDraft] = useState(config);
  const [saved, setSaved] = useState(false);
  return <form aria-label="手动开仓额度与检查" onChange={() => setSaved(false)} onSubmit={async e => {
      e.preventDefault(); if (busy || !ready) return; setSaved(false);
      // The workbench sent its whole config minus the Monitor password flag; the Monitor fields do not exist here.
      const { monitorUrl: _url, monitorUsername: _user, hasMonitorPassword: _password, ...editable } = draft as LiveConfig & Partial<Pick<Config, 'monitorUrl' | 'monitorUsername' | 'hasMonitorPassword'>>;
      if (await save({ config: editable })) setSaved(true);
    }}>
      <section className="panel settings-panel">
        <h2>手动开仓额度与检查</h2>
        <p className="muted">保存后用于下一次订单预览；具体数量、价格与限制以核对页为准。1 bp = 0.01%。</p>
        <label className="check"><input type="checkbox" checked={draft.entryPaused} onChange={e => setDraft(value => ({ ...value, entryPaused: e.target.checked }))}/>暂停新开仓，保留手动平仓与撤单</label>
        <div className="form-grid">{numericFields.map(([key, label, unit]) => <label key={key}>{label}<div className="input-unit"><input required type="number" min="0" step={key === 'maxOpen' ? '1' : 'any'} value={draft[key]} onChange={e => setDraft(value => ({ ...value, [key]: Number(e.target.value) }))}/><span>{unit}</span></div></label>)}</div>
        <p className="muted">持仓额度按每组两条持仓腿计算，已有单腿也占用额度。</p>
        <div className="save-row"><button className="primary" disabled={busy || !ready} type="submit">{busy ? '正在保存…' : '保存额度设置'}</button>{saved && <span role="status" className="positive">已保存</span>}</div>
      </section>
    </form>;
}
