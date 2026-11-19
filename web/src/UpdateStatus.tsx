// 系统更新: the sidebar button and dialog of the online update (docs/update.md). Layout and wording follow the workbench's
// src/UpdateStatus.tsx (project-aggregation c03c83f): the nav button with a one-line state, the dialog with a summary,
// warnings, the job's progress, current → latest version with the release notes, a confirm step and the footer buttons.
// Left out (docs/update.md 本次不做): the GitHub token, the deploy mode, the event stream, download progress, the
// new-version popup and stage timings. The page reads GET /api/update through use-live-resource (one read in flight,
// a write's answer voids older reads) every minute, every 2 s while an update runs. While the page follows an update the
// reads go on in a hidden tab, so the reload after success does not wait for the tab to come back; a service found on
// another version than the page loaded with (an update from elsewhere) reloads the page too.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, ChevronRight, CircleAlert, Download, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { api, ApiError } from './api.ts';
import { blockedReason, dateTime, jobLabels, jobPhase, nextWatched, parseUpdateView, readsInBackground, reloading, stepLabels, summaryOf, toneOf, updating, type UpdateJob, type UpdatePageState, type UpdateView } from './update-view.ts';
import { useLiveResource } from './use-live-resource.ts';
import './updates.css';

const IDLE_MS = 60_000;
const ACTIVE_MS = 2_000;
const READ_TIMEOUT_MS = 10_000;
const RELOAD_DELAY = 1_500;

function JobProgress({ job }: { job: UpdateJob }) {
  const phase = jobPhase(job);
  return <section className={`update-progress ${phase === 'done' ? 'succeeded' : phase}`} aria-labelledby="update-progress-title">
    <div className="update-progress-heading"><h3 id="update-progress-title">{phase === 'running' ? <LoaderCircle size={18} className="spin" /> : phase === 'done' ? <Check size={18} /> : <CircleAlert size={18} />}{jobLabels[phase]}{job.version ? ` ${job.version}` : ''}</h3><span>{dateTime(job.at)}</span></div>
    <p role="status">{phase === 'interrupted' ? '更新助手超过时限仍未结束，可能已被中断；请在服务器上查看 journalctl -u trading-platform-update。' : job.message}</p>
    {phase === 'running' && job.step ? <p className="update-job-step">当前步骤：{stepLabels[job.step]}</p> : null}
    {job.output.length ? <details className="update-output" open={phase !== 'done'}><summary>安装脚本输出（最近 {job.output.length} 行）</summary><pre>{job.output.join('\n')}</pre></details> : null}
    {phase === 'failed' || phase === 'interrupted' ? <p className="update-progress-note">此处保留上次更新结果，当前版本见下方。</p> : null}
    {phase === 'running' ? <small className="update-progress-note">关闭面板后更新会继续。页面连接恢复后可查看进度。</small> : null}
  </section>;
}

function Versions({ view }: { view: UpdateView }) {
  const { current, latest } = view;
  const tag = view.error ? ['unavailable', '检查未完成'] : !latest ? ['', '尚未检查'] : view.available ? ['available', '可更新'] : ['current', '已是最新'];
  return <ul className="update-modules"><li className="update-module">
    <div className="update-module-heading"><h3>统一交易平台</h3><span className={`update-tag ${tag[0]}`}>{tag[1]}</span></div>
    <div className="update-versions">
      <div><span>当前版本</span><span className="update-version"><strong>{current.version}</strong>{current.commit ? <small>{current.commit.slice(0, 8)}</small> : null}</span></div>
      {latest ? <><ArrowRight size={16} aria-hidden="true" /><div><span>最新正式版</span><span className="update-version"><strong>{latest.version}</strong>{latest.publishedAt ? <small>{dateTime(Date.parse(latest.publishedAt))} 发布</small> : null}</span></div></> : null}
    </div>
    {!current.packaged ? <p className="update-module-note">本机不是用安装脚本装的程序包（开发环境），不能在页面更新。</p> : null}
    {latest ? latest.notes ? <details className="update-release-notes"><summary>更新内容</summary><p>{latest.notes}</p></details> : <p className="update-module-note">该版本未提供更新说明。</p> : null}
  </li></ul>;
}

export function UpdateStatus({ onExpired, onOpen }: { onExpired: () => void; onOpen?: () => void }) {
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null);
  const [watched, setWatched] = useState<string | null>(null);
  // The service's version when this page load first read it; a later view on another version reloads the page.
  const [loaded, setLoaded] = useState<string | null>(null);
  // When a confirm went out without an answer; a read received after it settles what the server has.
  const [uncertainAt, setUncertainAt] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [background, setBackground] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const reviewElement = useRef<HTMLElement>(null);

  const live = useLiveResource<UpdateView>('/api/update', { intervalMs: active ? ACTIVE_MS : IDLE_MS, timeoutMs: READ_TIMEOUT_MS, parse: parseUpdateView, enabled: !missing, background, onExpired });
  const view = live.data;
  const offline = live.status === 'error' || live.status === 'offline';
  const uncertain = uncertainAt !== null && (live.receivedAt === null || live.receivedAt <= uncertainAt);
  // A service without the update answers 404: the button goes away and the reads stop.
  useEffect(() => { if (live.error instanceof ApiError && live.error.status === 404) setMissing(true); }, [live.error]);
  useEffect(() => { if (view) setWatched(current => nextWatched(current, view)); }, [view]);
  useEffect(() => { if (view) setLoaded(current => current ?? view.current.version); }, [view]);
  useEffect(() => { if (uncertainAt !== null && !uncertain) setUncertainAt(null); }, [uncertainAt, uncertain]);

  const state: UpdatePageState = { view, offline, busy, watched, uncertain, loaded };
  const reload = reloading(state);
  const wantActive = updating(view) || busy !== null || uncertain || !!view?.checking || (watched !== null && !reload);
  useEffect(() => { setActive(wantActive); }, [wantActive]);
  const wantBackground = readsInBackground(state);
  useEffect(() => { setBackground(wantBackground); }, [wantBackground]);

  // A full page load picks up the activated bundle, including after a page-only release.
  useEffect(() => {
    if (!reload) return;
    const timer = setTimeout(() => location.reload(), RELOAD_DELAY);
    return () => clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); };
  }, [open]);
  useEffect(() => {
    if (!review) return;
    reviewElement.current?.focus({ preventScroll: true });
    reviewElement.current?.scrollIntoView({ block: 'nearest' });
  }, [review]);

  if (missing) return null;

  const failed = (error: unknown): boolean => {
    if (error instanceof ApiError && error.status === 401) { onExpired(); return true; }
    return false;
  };
  const check = async () => {
    setBusy('check'); setNotice(''); setReview(null);
    try { live.commit(parseUpdateView(await api<unknown>('/api/update/check', { body: {}, timeoutMs: 30_000 }))); }
    catch (error) { if (!failed(error)) { setNotice(error instanceof Error ? error.message : String(error)); void live.refresh(); } }
    finally { setBusy(null); }
  };
  const apply = async () => {
    if (!review || blockedReason(state) !== null) return;
    setBusy('apply'); setNotice('');
    let answered = false;
    try {
      const raw = await api<unknown>('/api/update/apply', { body: { version: review } });
      answered = true;
      const next = parseUpdateView(raw);
      if (next.pending) setWatched(next.pending.id);
      live.commit(next);
      setReview(null);
      closeButton.current?.focus();
    } catch (error) {
      if (failed(error)) return;
      if (error instanceof ApiError) setNotice(error.message);
      else {
        // No usable answer: the request may have been written. Confirming stays blocked until a read shows what the server has.
        setUncertainAt(Date.now());
        setNotice(`${answered ? '确认已被接受，但应答无法识别' : error instanceof Error ? error.message : String(error)}；正在读取服务器记录`);
      }
      void live.refresh();
    } finally { setBusy(null); }
  };
  const show = () => { onOpen?.(); setOpen(true); void live.refresh(); };
  const close = () => {
    setOpen(false); setReview(null);
    // On a phone the button sat in the closed drawer: focus the menu button instead.
    requestAnimationFrame(() => {
      const mobileMenu = document.querySelector<HTMLButtonElement>('.mobile-menu');
      (mobileMenu?.getClientRects().length ? mobileMenu : trigger.current)?.focus();
    });
  };

  const summary = summaryOf(state);
  const tone = toneOf(state);
  const blocked = blockedReason(state);
  const running = updating(view) || busy === 'apply' || uncertain;
  const checking = !!view?.checking || busy === 'check';
  const needsSetup = view !== null && !view.enabled;
  const reviewInvalid = review !== null && view?.latest?.version !== review;
  const icon = running || checking || !view ? <LoaderCircle size={22} className="spin" /> : tone === 'attention' ? <CircleAlert size={22} /> : view.available ? <Download size={22} /> : <Check size={22} />;

  return <>
    <button ref={trigger} type="button" className={`nav-item update-nav ${tone}`} aria-label={`系统更新：${summary}`} aria-haspopup="dialog" onClick={show}>
      {running || checking ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Download size={17} aria-hidden="true" />}<span>系统更新<small>{summary}</small></span><ChevronRight size={15} aria-hidden="true" />
    </button>
    {open ? createPortal(<dialog ref={dialog} className="update-dialog" aria-labelledby="update-title" aria-describedby="update-description" onCancel={event => { event.preventDefault(); close(); }}><div className="update-dialog-content">
      <header className="update-header"><div><h2 id="update-title">系统更新</h2><p id="update-description">统一交易平台 · 仅正式版本</p></div><button ref={closeButton} type="button" className="icon-button" aria-label="关闭系统更新" onClick={close}><X size={21} /></button></header>
      <div className="update-body">
        {needsSetup ? <div className="update-message setup"><CircleAlert size={20} /><div><strong>先启用在线更新</strong><p>请在服务器上重新运行一次一键部署命令（README「部署（Linux 服务器，root）」），升级后即可在这里更新。</p></div></div>
          : <div className={`update-summary ${tone}`}><span className="update-summary-icon">{icon}</span><div><strong>{summary}</strong><p>{view?.checkedAt ? `上次检查 ${dateTime(view.checkedAt)}` : '检查本机可用的正式版本'}</p></div></div>}
        {offline ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>暂时无法连接页面服务</strong><p>恢复连接后会自动读取服务器记录。</p><button type="button" className="text-button" onClick={() => void live.refresh()}>重新连接</button></div></div> : null}
        {view?.error ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>版本检查未完成</strong><p>{view.error}</p><p>目前无法确认是否为最新正式版本，请稍后重新检查。</p></div></div> : null}
        {view?.pending?.stale ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><div><strong>更新请求没有被执行</strong><p>服务器上的更新助手 2 分钟内没有取走请求。请确认 trading-platform-update.path 在运行（systemctl status trading-platform-update.path），或重新运行一次一键部署命令。</p></div></div> : null}
        {view?.jobError ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><p>{view.jobError}</p></div> : null}
        {notice ? <div className="update-message warning" role="alert"><CircleAlert size={18} /><p>{notice}</p></div> : null}
        {reload ? <div className="update-message setup" role="status"><RefreshCw size={18} className="spin" /><p>更新已完成，正在刷新页面以载入新版本。</p></div> : null}
        {view?.job ? <JobProgress job={view.job} /> : null}
        {view ? <section aria-labelledby="update-modules-title"><div className="update-section-heading"><h3 id="update-modules-title">版本</h3><span>GitHub 正式版</span></div><Versions view={view} /></section> : null}
        {review ? <section ref={reviewElement} tabIndex={-1} className="update-review" aria-labelledby="update-review-title"><h3 id="update-review-title">确认本次更新</h3>
          <p>将从 {view?.current.version} 更新到 {review}。服务器会校验程序包和配置，按组件更新。更新结果和回退情况可在此查看。</p>
          <p>只更新页面或控制面时，交易、划转和 ADL 会继续运行。执行面需要重启时，任务会短暂停顿，随后按已保存的进度恢复。</p>
          {reviewInvalid ? <p role="alert">最新版本已变化，请返回重新查看。</p> : null}
        </section> : view?.available && !running ? <p className="update-footnote">可在这里升级到最新正式版。</p> : null}
      </div>
      <footer className="update-footer">{review ? <>
        <button type="button" className="button secondary" disabled={busy === 'apply'} onClick={() => setReview(null)}>返回</button>
        <button type="button" className="button primary" disabled={blocked !== null || reviewInvalid} onClick={() => void apply()}>{busy === 'apply' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}确认更新到 {review}</button>
      </> : <>
        <button type="button" className="button secondary" disabled={busy !== null || checking || running || needsSetup || !view} onClick={() => void check()}><RefreshCw size={16} className={checking ? 'spin' : ''} />{checking ? '正在检查' : '检查更新'}</button>
        {view?.available && view.latest ? <button type="button" className="button primary" disabled={blocked !== null} title={blocked ?? undefined} onClick={() => { if (view.latest) setReview(view.latest.version); }}>{running ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{running ? '正在更新' : '查看更新'}</button> : <span className="update-channel">正式版本</span>}
      </>}</footer>
    </div></dialog>, document.body) : null}
  </>;
}
