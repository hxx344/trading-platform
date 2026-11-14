// 改编自 project-aggregation 工作台 modules/monitor/app/alert-settings.tsx（提交 ef09438）的告警梯度面板，样式见 monitor.css 末段。
// 改动：读取走 useLiveResource（每 10 秒，草稿未保存时不被覆盖），写入走 api.ts 的 POST（带 revision，回答直接成为当前值，L089）；
// 档位字段用本服务的 label / operator；去掉「打开统一设置」（机器人在 secrets.json 的 feishu），加「发送测试消息」；
// 记录多出排队、重试、过期等出站队列状态。
import { Bell, ChevronDown, Layers, Plus, Save, Send, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { applyAlertGrid, gridDefaults, gridPreview, type AlertGrid } from './alert-grid.ts';
import { api, ApiError } from './api.ts';
import { ALERT_MARKETS, STATUS_LABELS, alertViewFor, historyText, newRule, type AlertConfig, type AlertMarket, type AlertRule, type AlertView } from './monitor-alerts.ts';
import { useLiveResource } from './use-live-resource.ts';

const ALERTS_MS = 10_000, READ_TIMEOUT_MS = 10_000, WRITE_TIMEOUT_MS = 25_000;
// The test message waits for the robot (10 s in the service) on top of the request.
const TEST_TIMEOUT_MS = 20_000;
const time = (value: string | null) => value == null ? '尚无记录' : `${new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间`;
const numberValue = (value: number) => Number.isFinite(value) ? value : '';
const directionOptions = <><option value="gte">向上 ≥</option><option value="lte">向下 ≤</option><option value="both">双向穿越</option></>;
const failure = (error: unknown, unknown: string) => error instanceof ApiError
  ? (error.code === 'stale_revision' ? '另一页面已更新配置。你的修改仍保留，请放弃修改并重载后再编辑。' : error.message)
  : unknown;

export function AlertSettings({ market, onExpired }: { market: AlertMarket; onExpired: () => void }) {
  const spec = ALERT_MARKETS[market];
  const path = `/api/monitor/${market}/alerts`;
  const parse = useMemo(() => alertViewFor(market), [market]);
  const live = useLiveResource<AlertView>(path, { intervalMs: ALERTS_MS, timeoutMs: READ_TIMEOUT_MS, parse, onExpired });
  const view = live.data;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AlertConfig>({ enabled: false, rules: [] });
  const [revision, setRevision] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [grid, setGrid] = useState<AlertGrid | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // A read follows the service until the draft is edited; an unsaved draft and the revision it started from stay.
  useEffect(() => {
    if (view && !dirtyRef.current) { setDraft(view.config); setRevision(view.revision); }
  }, [view]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  const adapter = { ...spec, newRule: (config: AlertConfig) => newRule(market, config) };
  const edit = (next: AlertConfig) => { setDirty(true); setMessage(''); setError(''); setDraft(next); };
  const editRule = (id: string, values: Partial<AlertRule>) => edit({ ...draft, rules: draft.rules.map(rule => rule.id === id ? { ...rule, ...values } : rule) });
  const apply = (next: AlertView) => { live.commit(next); setDraft(next.config); setRevision(next.revision); setDirty(false); };

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } finally { setBusy(false); }
  }
  const save = () => run(async () => {
    if (revision === null) return;
    try {
      apply(await api<AlertView>(path, { body: { revision, config: draft }, timeoutMs: WRITE_TIMEOUT_MS }).then(parse));
      setMessage('配置已保存，下一轮后台检查（10 秒内）生效。');
    } catch (cause) {
      setError(failure(cause, '保存结果未知，草稿已保留；请放弃修改并重载核对后再保存。'));
      void live.refresh();
    }
  });
  const discard = () => run(async () => {
    setDirty(false); dirtyRef.current = false;
    if (view) { setDraft(view.config); setRevision(view.revision); }
    await live.refresh();
  });
  const test = () => run(async () => {
    try {
      live.commit(await api<AlertView>(`${path}/test`, { body: {}, timeoutMs: TEST_TIMEOUT_MS }).then(parse));
      setMessage('测试消息已发送，请在飞书群核对。');
    } catch (cause) {
      setError(failure(cause, '测试消息结果未知，请在飞书群核对；一分钟后可再试。'));
      void live.refresh();
    }
  });

  const editGrid = (values: Partial<AlertGrid>) => setGrid(current => current && { ...current, ...values });
  let gridLevels: number[] = [], gridError = '';
  if (grid) { try { gridLevels = gridPreview(draft, grid, adapter); } catch (cause) { gridError = cause instanceof Error ? cause.message : '范围无效。'; } }
  const gridMetric = spec.metrics.find(metric => metric.id === grid?.metric) ?? spec.metrics[0]!;
  const generate = () => {
    if (!grid) return;
    try {
      edit(applyAlertGrid(draft, grid, adapter));
      setMessage(`已生成 ${gridLevels.length} 档${gridMetric.label}梯度，保存配置后生效。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '生成失败，草稿未改变。'); }
  };

  const readError = live.error && !(live.error instanceof ApiError && live.error.status === 401) ? '无法刷新告警后台状态，现有配置与草稿已保留，10 秒后自动重试。' : '';
  const summary = !view ? (live.error ? '连接异常' : '连接后台中…') : view.config.enabled ? `已启用 · ${view.config.rules.filter(rule => rule.enabled).length} 档` : '未启用';
  const bodyId = `monitor-alerts-${market}-body`;
  return <section className="alert-panel monitor-alerts" aria-label={`${spec.title}飞书告警梯度`} data-alert-monitor={market}>
    <button type="button" className="alert-heading" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
      <span><Bell size={18} aria-hidden="true" /><strong>飞书告警梯度</strong><span className="alert-summary">{spec.title} · {summary}{dirty ? ' · 未保存' : ''}</span></span><span>设置<ChevronDown size={16} className={open ? 'rotated' : ''} aria-hidden="true" /></span>
    </button>
    {open && <div id={bodyId} className="alert-body">
      <div className="alert-definitions"><p><strong>冷却</strong>两次成功提醒之间的最短间隔。</p><p><strong>回差</strong>再次允许提醒前，需要离开阈值的幅度。</p></div>
      <p className="alert-help">持续满足阈值只提醒一次；再次提醒须同时满足重新越过阈值和冷却结束。{spec.example}</p>
      <p className="alert-help">双向穿越：向上穿过阈值或向下穿过阈值都会提醒。保存后需先离开阈值超过回差，才开始判断穿越，不会因为当前已在阈值某一侧而立即提醒。</p>
      {!view ? <p className="alert-help" role="status">{readError || '正在连接告警后台…'}</p> : <>
        <p className="alert-help">{view.robot === 'feishuMonitor' ? '使用 secrets.json 的 feishuMonitor 行情告警机器人（从工作台导入，原油与海力士共用）。' : view.robot === 'feishu' ? '使用 secrets.json 的 feishu 告警机器人（与运行通知共用）。' : '尚未配置飞书告警机器人，可先保存梯度。'}关闭网页后，后台仍会检查并发送告警；发送失败时自动重试，最多保留 7 天。</p>
        {view.notice && <p className="alert-feedback failure" role="status">{view.notice}</p>}
        {/* Outside the save form: unapplied generator inputs must not block saving the draft. */}
        <fieldset disabled={busy} className="alert-fields">
          <details className="monitor-alert-grid" onToggle={event => { if (event.currentTarget.open && !grid) setGrid(gridDefaults(draft, adapter)); }}>
            <summary><Layers size={15} aria-hidden="true" />按范围批量生成档位</summary>
            {grid && <>
              <p className="alert-help">从下限到上限每隔一个步长生成一档，替换该指标现有的档位；其他指标的档位保留。阈值相同且方向相同的档位沿用原编号和发送状态。</p>
              <div className="monitor-alert-rule-fields">
                <label>监控指标<select aria-label="批量生成的监控指标" value={grid.metric} onChange={event => editGrid({ metric: event.target.value })}>{spec.metrics.map(metric => <option value={metric.id} key={metric.id}>{metric.label}</option>)}</select></label>
                <label>触发方向<select aria-label="批量生成的触发方向" value={grid.direction} onChange={event => editGrid({ direction: event.target.value as AlertGrid['direction'] })}>{directionOptions}</select></label>
                <label>下限（{gridMetric.unit}）<input type="number" step="any" aria-label="批量生成的下限" value={numberValue(grid.from)} onChange={event => editGrid({ from: event.target.valueAsNumber })} /></label>
                <label>上限（{gridMetric.unit}）<input type="number" step="any" aria-label="批量生成的上限" value={numberValue(grid.to)} onChange={event => editGrid({ to: event.target.valueAsNumber })} /></label>
                <label>步长（{gridMetric.hysteresisUnit}）<input type="number" step="any" min="0" aria-label="批量生成的步长" value={numberValue(grid.step)} onChange={event => editGrid({ step: event.target.valueAsNumber })} /></label>
                <label>冷却（分钟）<input type="number" step="any" min="0" max={spec.cooldownMax} aria-label="批量生成的冷却" value={numberValue(grid.cooldownMinutes)} onChange={event => editGrid({ cooldownMinutes: event.target.valueAsNumber })} /></label>
                <label>回差（{gridMetric.hysteresisUnit}）<input type="number" step="any" min="0" max={spec.hysteresisMax} aria-label="批量生成的回差" value={numberValue(grid.hysteresis)} onChange={event => editGrid({ hysteresis: event.target.valueAsNumber })} /></label>
              </div>
              <div className="monitor-alert-grid-actions">
                <span className={gridError ? 'negative' : 'alert-summary'} role="status">{gridError || `将生成 ${gridLevels.length} 档：${gridLevels.join('、')}`}</span>
                <button type="button" className="alert-button" disabled={Boolean(gridError)} onClick={generate}><Layers size={14} aria-hidden="true" />生成并替换该指标档位</button>
              </div>
            </>}
          </details>
        </fieldset>
        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy} className="alert-fields">
            <div className="alert-rules-heading"><h3>梯度设置 <span className="alert-summary">{draft.rules.length} / {spec.maxRules} 档</span></h3><button type="button" className="alert-button" disabled={draft.rules.length >= spec.maxRules} onClick={() => edit({ ...draft, rules: [...draft.rules, adapter.newRule(draft)] })}><Plus size={15} aria-hidden="true" />添加梯度</button></div>
            <div className="monitor-alert-rules">{draft.rules.map((rule, index) => {
              const metric = spec.metrics.find(item => item.id === rule.metric) ?? spec.metrics[0]!;
              return <div className="monitor-alert-rule" key={rule.id} role="group" aria-label={`第 ${index + 1} 档`}>
                <div className="monitor-alert-rule-top"><span>第 {index + 1} 档</span><div><label className="alert-checkbox"><input type="checkbox" checked={rule.enabled} onChange={event => editRule(rule.id, { enabled: event.target.checked })} />启用</label><button type="button" className="alert-delete" aria-label={`删除第 ${index + 1} 档`} onClick={() => edit({ ...draft, rules: draft.rules.filter(item => item.id !== rule.id) })}><Trash2 size={16} aria-hidden="true" /></button></div></div>
                <div className="monitor-alert-rule-fields">
                  <label>档位名称<input value={rule.label} required maxLength={spec.labelMax} onChange={event => editRule(rule.id, { label: event.target.value })} /></label>
                  <label>监控指标<select aria-label="监控指标" value={rule.metric} onChange={event => editRule(rule.id, { metric: event.target.value })}>{spec.metrics.map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>
                  <label>触发方向<select aria-label="触发方向" value={rule.operator} onChange={event => editRule(rule.id, { operator: event.target.value as AlertRule['operator'] })}>{directionOptions}</select></label>
                  <label>阈值（{metric.unit}）<input type="number" step="any" min={metric.min} max={metric.max} required placeholder="输入阈值" value={numberValue(rule.threshold)} onChange={event => editRule(rule.id, { threshold: event.target.valueAsNumber })} /></label>
                  <label>冷却（分钟）<input type="number" step="any" min="0" max={spec.cooldownMax} required value={numberValue(rule.cooldownMinutes)} onChange={event => editRule(rule.id, { cooldownMinutes: event.target.valueAsNumber })} /></label>
                  <label>回差（{metric.hysteresisUnit}）<input type="number" step="any" min="0" max={spec.hysteresisMax} required value={numberValue(rule.hysteresis)} onChange={event => editRule(rule.id, { hysteresis: event.target.valueAsNumber })} /></label>
                </div>
              </div>;
            })}</div>
            {!draft.rules.length && <p className="alert-help">添加一档或多档阈值，每档可独立设置冷却、回差和开关。</p>}
            <div className="alert-actions"><label className="alert-checkbox"><input type="checkbox" checked={draft.enabled} onChange={event => edit({ ...draft, enabled: event.target.checked })} />启用飞书告警</label><div>
              <button type="button" className="alert-button" disabled={!view.robotConfigured} onClick={() => void test()}><Send size={14} aria-hidden="true" />发送测试消息</button>
              {dirty && <button type="button" className="alert-button" onClick={() => void discard()}>放弃修改并重载</button>}
              <button type="submit" className="alert-button primary"><Save size={14} aria-hidden="true" />{busy ? '处理中…' : '保存配置'}</button>
            </div></div>
          </fieldset>
        </form>
        {dirty && <p className="alert-help">有未保存的修改，后台按已保存的配置继续检查。</p>}
        {message && <p className="alert-feedback" role="status">{message}</p>}
        {error && <p className="alert-feedback failure" role="alert">{error}</p>}
        {readError && <p className="alert-feedback failure" role="alert">{readError}</p>}
        <div className="alert-monitor"><span>最近后台检查：{time(view.checkedAt)}</span><span>最近有效报价：{time(view.lastValidAt)}</span></div>
        <p className="alert-help alert-server-market">{spec.market(view.values)}</p>
        {view.error && <p className="alert-feedback failure" role="alert">{view.error}</p>}
        <details className="monitor-alert-history"><summary>最近发送记录（{view.history.length} 条）</summary>{view.history.length ? view.history.map(item => <div key={item.id}><div><time>{time(item.time)}</time><strong className={item.status === 'sent' || item.status === 'applied' ? 'positive' : item.status === 'failed' || item.status === 'retrying' || item.status === 'unqueued' ? 'negative' : ''}>{STATUS_LABELS[item.status]}</strong></div><p>{historyText(market, item)}{item.error && ` · ${item.error}`}</p></div>) : <p className="alert-help">尚无发送记录。</p>}</details>
      </>}
    </div>}
  </section>;
}
