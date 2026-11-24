// MEV 套利页的启用向导与「热钱包与节点」卡片（docs/mev.md 第 6 节、docs/frontend.md《MEV 套利页》）。
// 私钥只在提交时离开这个输入框：提交成功后立刻从组件状态里清掉，页面之后读到的状态里没有它。
import { useState } from 'react';
import type React from 'react';
import { KeyRound, LoaderCircle, Rocket, Save, Trash2 } from 'lucide-react';
import { api } from '../api.ts';
import { Callout } from '../StateViews.tsx';
import type { useWrite } from '../varlighter/parts.tsx';
import type { MevSetupView } from '../../../src/mev/views.ts';
import { MEV_BASE, REDEPLOY_AFTER_MS, deployBlocker, deployConfirmText, eth, explorerAddress, explorerTx, insecurePage, resetConfirmText, setupRequest, shortAddress, type SetupForm } from './mev-form.ts';

type Write = ReturnType<typeof useWrite>;
type Changed = () => Promise<void>;
const EMPTY: SetupForm = { privateKey: '', owner: '', rpcUrl: '' };
const External = ({ href, children }: { href: string; children: string }) => <a className="mev-mono" href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
const Spin = () => <LoaderCircle size={14} className="spin" aria-hidden="true" />;

function remove(setup: MevSetupView, write: Write, onChanged: Changed): void {
  if (!setup.operator || !confirm(resetConfirmText(setup))) return;
  void write.run('reset', () => api(`${MEV_BASE}/setup/reset`, { body: { confirm: setup.operator } }), () => { void onChanged(); return '热钱包已移除，私钥已从服务器删除'; });
}

/** 还没有引擎可用时整页显示它：录入 → 转入 gas → 部署 → 等待上链。 */
export function SetupPanel({ setup, write, onChanged }: { setup: MevSetupView; write: Write; onChanged: Changed }) {
  if (setup.stage === 'none') return <SetupForm_ setup={setup} write={write} onChanged={onChanged} />;
  if (setup.stage === 'ready') return <section className="panel" aria-label="启用">
    <div className="panel-heading"><h2>正在启动</h2><span className="muted">热钱包 {setup.operator ? shortAddress(setup.operator) : '—'}</span></div>
    {setup.error ? <Callout tone="error">模块没有启动：{setup.error}</Callout> : <p className="vl-note">执行合约已就绪，引擎正在启动，几秒后自动显示。</p>}
  </section>;
  const blocker = deployBlocker(setup), deploy = setup.deploy, retry = !!deploy && setup.checkedAt - deploy.at >= REDEPLOY_AFTER_MS;
  const send = () => {
    if (!setup.operator || !confirm(deployConfirmText(setup))) return;
    void write.run('deploy', () => api(`${MEV_BASE}/setup/deploy`, { body: { confirm: setup.operator }, timeoutMs: 45_000 }), () => { void onChanged(); return '部署请求已提交，上链并核对后自动进入观察模式；发送结果不明时本页会写明'; });
  };
  return <>
    {setup.error ? <Callout tone="warning">{setup.error}</Callout> : null}
    {setup.rpcError ? <Callout tone="warning">读取链上状态失败：{setup.rpcError}。{setup.defaultRpc ? '公共节点有限速，持续失败时移除后重新录入并填自己的节点地址。' : ''}</Callout> : null}
    <section className="panel" aria-label="启用">
      <div className="panel-heading"><h2>{deploy ? '第 3 步：等待部署上链' : '第 2 步：转入 gas 并部署执行合约'}</h2><span className="muted">Base 主网</span></div>
      <dl className="mev-facts">
        <dt>热钱包</dt><dd>{setup.operator ? <External href={explorerAddress(setup.operator)}>{setup.operator}</External> : '—'}</dd>
        <dt>余额</dt><dd>{setup.wallet ? `${eth(setup.wallet.eth)} · nonce ${setup.wallet.nonce}` : '读取中…'}</dd>
        <dt>利润收款地址（owner）</dt><dd>{setup.owner ? <External href={explorerAddress(setup.owner)}>{setup.owner}</External> : '—'}</dd>
        <dt>节点</dt><dd>{setup.rpcHost ?? '—'}{setup.defaultRpc ? '（默认公共节点）' : ''}</dd>
        {deploy ? <><dt>部署交易</dt><dd><External href={explorerTx(deploy.hash)}>{deploy.hash}</External></dd>
          <dt>合约地址</dt><dd><External href={explorerAddress(deploy.address)}>{deploy.address}</External></dd></> : null}
      </dl>
      {deploy
        ? <p className="vl-note">部署交易已发出，通常几秒内上链；上链并核对代码后本页自动进入观察模式。{retry ? '已超过 5 分钟没有上链，可以加价重发（同一个 nonce，合约地址不变）。' : ''}</p>
        : <p className="vl-note">向上面的热钱包地址转入 0.01–0.02 ETH（Base 链，不是以太坊主网）。余额到账后点「部署执行合约」：由热钱包发一笔部署交易，花费从这笔余额里出。合约的 owner 是你填的收款地址，不可更改；热钱包只能调用套利，不能提走利润。</p>}
      <div className="vl-actions">
        {!deploy || retry ? <button type="button" className="button" disabled={write.busy !== null || blocker !== null} title={blocker ?? undefined} onClick={send}>{write.busy === 'deploy' ? <Spin /> : <Rocket size={14} aria-hidden="true" />}{deploy ? '加价重发部署交易' : '部署执行合约'}</button> : null}
        <button type="button" className="button secondary" disabled={write.busy !== null} onClick={() => remove(setup, write, onChanged)}><Trash2 size={14} aria-hidden="true" />移除热钱包，重新录入</button>
      </div>
      <NodeChange write={write} onChanged={onChanged} disabled={false} />
      {!deploy && blocker ? <p className="vl-note">暂不能部署：{blocker}</p> : null}
    </section>
  </>;
}

function SetupForm_({ setup, write, onChanged }: { setup: MevSetupView; write: Write; onChanged: Changed }) {
  const [form, setForm] = useState<SetupForm>(EMPTY);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (key: keyof SetupForm) => (event: { target: { value: string } }) => setForm(current => ({ ...current, [key]: event.target.value }));
  const submit = () => {
    const request = setupRequest(form);
    if (!request.ok) { setProblem(request.message); return; }
    setProblem(null);
    void write.run('setup', () => api(`${MEV_BASE}/setup`, { body: request.body }), () => { setForm(EMPTY); void onChanged(); return '热钱包已保存。下一步：转入 gas 并部署执行合约'; });
  };
  return <>
    {setup.error ? <Callout tone="warning">{setup.error}</Callout> : null}
    {insecurePage(window.location) ? <Callout tone="warning">当前页面不是 https：私钥会以明文经过网络。请在服务器本机、内网或 Tailscale 里打开本页，或先给站点配上 https 再录入。</Callout> : null}
    <section className="panel" aria-label="启用">
      <div className="panel-heading"><h2>第 1 步：录入热钱包</h2><span className="muted">只需填一次；之后的启动、停止与参数都在本页</span></div>
      <div className="vl-fields">
        <label className="vl-field">热钱包私钥
          <input type="password" autoComplete="off" spellCheck={false} value={form.privateKey} onChange={set('privateKey')} placeholder="64 位十六进制，可带 0x" />
          <small>用一个新建的、专门给本模块用的钱包，里面只放 gas（0.01–0.02 ETH）。不要填存有其他资产的钱包。私钥保存在服务器的数据目录里，页面与日志都不会再显示。</small>
        </label>
        <label className="vl-field">利润收款地址
          <input autoComplete="off" spellCheck={false} value={form.owner} onChange={set('owner')} placeholder="0x…" />
          <small>你自己保管的另一个钱包地址（只填地址）。每笔套利利润在同一笔交易里直接转到这里；它也是执行合约的 owner，部署后不可更改。</small>
        </label>
        <label className="vl-field">Base 节点地址（可不填）
          <input type="password" autoComplete="off" spellCheck={false} value={form.rpcUrl} onChange={set('rpcUrl')} placeholder="留空使用公共节点 mainnet.base.org" />
          <small>公共节点有限速，够启用与观察；实盘建议填自己的 https 节点，之后可在「设置」里更换。</small>
        </label>
      </div>
      <div className="vl-actions">
        {problem ? <Callout tone="error">{problem}</Callout> : null}
        <button type="button" className="button" disabled={write.busy !== null} onClick={submit}>{write.busy === 'setup' ? <Spin /> : <KeyRound size={14} aria-hidden="true" />}保存热钱包</button>
      </div>
      <p className="vl-note">这把私钥泄露或程序出错的最大损失是热钱包里的 gas 余额：本金来自池子的闪电兑换，利润不经过热钱包。保存后模块处于观察模式，实盘要在本页另行确认开始。</p>
    </section>
  </>;
}

/** 更换节点的输入与按钮；节点地址可能带服务商密钥，明文 http 时同样提醒。 */
function NodeChange({ write, onChanged, disabled, children }: { write: Write; onChanged: Changed; disabled: boolean; children?: React.ReactNode }) {
  const [rpcUrl, setRpcUrl] = useState('');
  const save = () => {
    void write.run('rpc', () => api(`${MEV_BASE}/setup/rpc`, { body: { rpcUrl: rpcUrl.trim() || null } }), () => { setRpcUrl(''); void onChanged(); return rpcUrl.trim() ? '节点已更换' : '已改回默认公共节点'; });
  };
  return <>
    <div className="vl-toolbar">
      <input type="password" autoComplete="off" spellCheck={false} value={rpcUrl} onChange={event => setRpcUrl(event.target.value)} placeholder="新的 https 节点地址；留空改回公共节点" aria-label="节点地址" size={46} />
      <button type="button" className="button secondary" disabled={write.busy !== null || disabled} onClick={save}>{write.busy === 'rpc' ? <Spin /> : <Save size={14} aria-hidden="true" />}更换节点</button>
      {children}
    </div>
    {insecurePage(window.location) ? <p className="vl-note">当前页面不是 https：带服务商密钥的节点地址会以明文经过网络。</p> : null}
  </>;
}

/** 设置页签里的卡片：看地址、换节点、移除热钱包。由配置文件管理时只读。 */
export function WalletCard({ setup, live, write, onChanged }: { setup: MevSetupView; live: boolean; write: Write; onChanged: Changed }) {
  return <section className="panel" aria-label="热钱包与节点">
    <div className="panel-heading"><h2>热钱包与节点</h2><span className="muted">{setup.managed ? '由服务器上的配置文件管理' : '在本页录入'}</span></div>
    <dl className="mev-facts">
      <dt>热钱包</dt><dd>{setup.operator ? <External href={explorerAddress(setup.operator)}>{setup.operator}</External> : '—'}</dd>
      <dt>利润收款地址（owner）</dt><dd>{setup.owner ? <External href={explorerAddress(setup.owner)}>{setup.owner}</External> : '—'}</dd>
      <dt>节点</dt><dd>{setup.rpcHost ?? '—'}{setup.defaultRpc ? '（默认公共节点）' : ''}</dd>
    </dl>
    {setup.managed
      ? <p className="vl-note">这套热钱包、节点与合约地址来自 <code>install.sh --set-mev</code>，不能在页面修改；要改用页面录入，先在服务器上执行 <code>sudo bash install.sh --unset-mev</code>。</p>
      : <>
        <NodeChange write={write} onChanged={onChanged} disabled={live}>
          <button type="button" className="button secondary" disabled={write.busy !== null || live} onClick={() => remove(setup, write, onChanged)}><Trash2 size={14} aria-hidden="true" />移除热钱包</button>
        </NodeChange>
        <p className="vl-note">{live ? '实盘进行中不能更换节点或移除热钱包，先停止实盘。' : '更换节点会让引擎重新启动（回到观察模式）。移除热钱包会从服务器删除私钥；链上的执行合约与钱包余额不受影响，服务器会记下合约地址（不含私钥），重新录入同一把私钥与收款地址时沿用它，不再部署。'}</p>
      </>}
  </section>;
}
