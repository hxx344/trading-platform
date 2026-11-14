// The asset page's 交易所连接 view: project_aggregation modules/asset/app/dashboard.tsx (connections view, 连接 dialog)
// and aster-accounts-panel.tsx at 0014655. Changes: the dialogs became panels opened in place, like the A-2 forms; the
// writes go to this service (/api/asset/connections*, /api/asset/aster-accounts/*, docs/asset.md A-3) and share the
// page's one-write-at-a-time writer; Var's 测试访问 diagnostic is left out (docs/asset.md lists it).
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { newRequestId } from './request-ids.ts';
import { money, stamp } from './asset-format.ts';
import { EXCHANGE_NAMES, type Exchange } from '../../src/asset/views.ts';
import type { AsterAccount, Connection } from '../../src/asset/types.ts';
import type { Writer } from './AssetPage.tsx';

export const CONNECTIONS_PATH = '/api/asset/connections';
export const CONNECTIONS_DELETE_PATH = '/api/asset/connections/delete';
export const ASTER_ADD_PATH = '/api/asset/aster-accounts/add';
export const ASTER_EDIT_PATH = '/api/asset/aster-accounts/edit';
export const ASTER_DELETE_PATH = '/api/asset/aster-accounts/delete';
const ASTER_LIMIT = 10;

/** The exchanges with one connection each; Aster has its accounts panel instead. */
export const CARD_EXCHANGES = ['bybit', 'binance', 'okx', 'gate', 'variational', 'hyperliquid', 'rh-lighter'] as const;
export type CardExchange = typeof CARD_EXCHANGES[number];
/** The side panel's order, Aster included (dashboard.tsx 数据连接). */
export const SIDE_EXCHANGES = ['bybit', 'binance', 'okx', 'gate', 'aster', 'variational', 'hyperliquid', 'rh-lighter'] as const satisfies readonly Exchange[];

const DESCRIPTIONS: Record<CardExchange, string> = {
  bybit: '统一账户净权益与资金账户余额；包含未实现盈亏，不重复累加保证金。',
  binance: '国际站钱包资产估值，读取各钱包折合 USDT 的余额并换算为美元；范围以 Binance 接口返回为准。',
  okx: '当前账户总资产的美元估值，查看交易、资金和理财账户分项；范围以 OKX 接口返回为准，不自动汇总子账户。',
  gate: '国际站账户总资产按 USDT/USD 汇率换算美元，提供各账户估值分项；范围以 Gate 接口返回为准，不自动汇总子账户，接口数据最多缓存 1 分钟。',
  variational: 'Omni 账户的 USDC 净权益按 USDC/USD 换算为美元；包含未实现盈亏，不重复累加保证金或持仓名义价值。',
  hyperliquid: '主账户总值（现货、全部永续 DEX，含 Anthropic 套利使用的 io / xyz 市场及未实现盈亏，以及金库存款与质押 HYPE）按 USDC/USD 换算美元；只读公开接口，仅需主账户地址。',
  'rh-lighter': 'Lighter on Robinhood Chain（与 Lighter 主网账户不互通）L1 地址下全部账户的账户总值（抵押 USDG 加未实现盈亏），USDG 按 1:1 计为美元；同时读取永续持仓。只读公开接口，仅需 L1 钱包地址，每个地址最多每 30 秒读取一次。',
};

const PANEL_INTRO: Record<CardExchange, string> = {
  bybit: '验证只读权限与余额，成功后加密保存。', binance: '验证只读权限与余额，成功后加密保存。', okx: '验证只读权限与余额，成功后加密保存。',
  gate: '验证账户余额可读，成功后加密保存；无法自动验证密钥只读权限。',
  variational: '通过 Omni 网页会话读取账户净权益，成功后加密保存令牌。',
  hyperliquid: '通过公开接口读取主账户总值，无需 API Key 或私钥；验证地址与账户总值后保存。',
  'rh-lighter': '通过公开接口读取该 L1 地址下全部账户的总值与持仓，无需 API Key 或私钥；验证地址可读后保存。',
};

const PANEL_HELP: Record<CardExchange, string> = {
  bybit: 'HMAC 类型只读 API，需要账户与资产读取权限；不读取子账户及理财产品。',
  binance: '仅支持 Binance 国际站 HMAC API。开启读取权限，关闭交易、划转和提现等写入权限；首次验证成功后才保存连接与资产估值。',
  okx: '仅支持 OKX 国际站实盘 API。只开启读取权限，关闭交易与提现权限；验证账户总资产成功后保存。',
  gate: '仅支持 Gate 国际站 API v4 Key（HMAC 签名）。请仅开启钱包读取权限，关闭交易、提现等写入权限；本程序仅向 Gate 发送 GET 请求。权限或 IP 白名单变更最多需 5 分钟生效。',
  variational: 'vr-token 是网页会话凭据，并非只读 API Key。本账本仅通过 GET 请求读取资产；会话过期后需重新登录 Omni 并更新令牌。若提示 Cloudflare 浏览器验证，表示服务器请求被拦截，不能据此判断令牌失效。',
  hyperliquid: '仅向 Hyperliquid 官方 info 接口发送只读查询，地址本身不是凭据；统一账户、组合保证金与普通模式均以官方账户总值为准，不重复累加各 DEX 余额。',
  'rh-lighter': '仅向 api.rh.lighter.xyz 发送只读 GET 查询，地址本身不是凭据。该接口按 IP 与地址每分钟限 60 次，并与监控、交易模块共用；遇到限流会暂停 60 秒并保留上次数据。',
};

const REGIONS = [['global', '国际站'], ['nl', '荷兰'], ['tr', '土耳其'], ['kz', '哈萨克斯坦'], ['ge', '格鲁吉亚'], ['ae', '阿联酋'], ['eu', '欧洲']] as const;
const ADDRESS_PATTERN = '\\s*0x[0-9a-fA-F]{40}\\s*';

/** The side panel's line for a connection that is not set up yet (dashboard.tsx 数据连接). */
export function pendingText(exchange: Exchange): string {
  return exchange === 'variational' ? '待连接 Omni 会话' : exchange === 'hyperliquid' ? '待填写主账户地址' : exchange === 'rh-lighter' ? '待填写 L1 钱包地址' : exchange === 'gate' ? '待连接资产读取接口' : '待连接只读接口';
}

type Props = { connections: Record<Exchange, Connection>; accounts: AsterAccount[]; now: number; writer: Writer; opened: CardExchange | null; onOpen: (exchange: CardExchange | null) => void };

export function ConnectionsView({ connections, accounts, now, writer, opened, onOpen }: Props) {
  return <div className="connections-grid">
    {opened ? <ConnectPanel key={opened} exchange={opened} configured={connections[opened].configured} writer={writer} onClose={() => onOpen(null)} /> : null}
    {CARD_EXCHANGES.map(name => {
      const connection = connections[name];
      return <section className="panel connection-card" key={name}>
        <div className="connection-card-title"><div className={'exchange-mark ' + name} aria-hidden="true">{EXCHANGE_NAMES[name][0]}</div><h2>{EXCHANGE_NAMES[name]}</h2><span className={'status ' + (connection.configured ? 'live' : 'amber')}>{connection.configured ? '已连接' : '未连接'}</span></div>
        <p className="help">{DESCRIPTIONS[name]}</p>
        <p className="help sync-time">最近成功同步：{stamp(connection.lastSync)}</p>
        {connection.error ? <p className="error-text">{connection.error}</p> : null}
        <div className="form-actions"><button type="button" className="button primary" disabled={writer.busy} aria-expanded={opened === name} onClick={() => { writer.clear(); onOpen(name); }}>{connection.configured ? '更新连接' : '连接账户'}</button></div>
      </section>;
    })}
    <AsterAccounts accounts={accounts} now={now} writer={writer} />
  </div>;
}

/** The workbench's 连接 dialog: the fields this exchange needs, sent once to be verified and saved encrypted. */
function ConnectPanel({ exchange, configured, writer, onClose }: { exchange: CardExchange; configured: boolean; writer: Writer; onClose: () => void }) {
  const [key, setKey] = useState(''), [secret, setSecret] = useState(''), [passphrase, setPassphrase] = useState('');
  const [region, setRegion] = useState('global'), [walletAddress, setWalletAddress] = useState(''), [vrToken, setVrToken] = useState('');
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const address = exchange === 'hyperliquid' || exchange === 'rh-lighter';
  const submit = () => {
    const credentials = exchange === 'variational' ? { exchange, vrToken: vrToken.trim() }
      : address ? { exchange, walletAddress: walletAddress.trim() }
      : { exchange, apiKey: key.trim(), apiSecret: secret.trim(), ...(exchange === 'bybit' ? { region } : exchange === 'okx' ? { passphrase: passphrase.trim() } : {}) };
    void writer.run(CONNECTIONS_PATH, credentials, onClose);
  };
  const error = writer.errorOf(CONNECTIONS_PATH, CONNECTIONS_DELETE_PATH);
  const secretInput = { autoComplete: 'new-password', spellCheck: false, autoCapitalize: 'none' } as const;
  return <section ref={panel} className="panel edit-panel connect-panel" aria-label={'连接 ' + EXCHANGE_NAMES[exchange]}>
    <h2>连接 {EXCHANGE_NAMES[exchange]}</h2>
    <p className="help">{PANEL_INTRO[exchange]}</p>
    <form className="form-grid" onSubmit={event => { event.preventDefault(); submit(); }}>
      {exchange === 'variational' ? <label>vr-token<input type="password" {...secretInput} required minLength={5} maxLength={4096} value={vrToken} onChange={event => setVrToken(event.target.value)} /><span className="help">登录 Omni 网页后，从浏览器 Cookie 中复制 vr-token 的值；只填写值，不带 vr-token= 或完整 Cookie，无需钱包私钥。</span></label>
        : exchange === 'hyperliquid' ? <label>主账户地址<input autoComplete="off" spellCheck={false} autoCapitalize="none" required pattern={ADDRESS_PATTERN} placeholder="0x…" value={walletAddress} onChange={event => setWalletAddress(event.target.value)} /><span className="help">填写套利执行账户的主账户地址（交易所显示的钱包地址），不要填写 API 钱包（agent）地址，无需私钥。</span></label>
        : exchange === 'rh-lighter' ? <label>L1 钱包地址<input autoComplete="off" spellCheck={false} autoCapitalize="none" required pattern={ADDRESS_PATTERN} placeholder="0x…" value={walletAddress} onChange={event => setWalletAddress(event.target.value)} /><span className="help">填写在 Lighter on Robinhood Chain 注册账户所用的以太坊 L1 钱包地址，该地址下的主账户与子账户一并汇总；无需私钥或 API Key。</span></label>
        : <>
          <label>API Key<input autoComplete="off" spellCheck={false} autoCapitalize="none" required value={key} onChange={event => setKey(event.target.value)} /></label>
          <label>API Secret<input type="password" {...secretInput} required value={secret} onChange={event => setSecret(event.target.value)} /></label>
        </>}
      {exchange === 'okx' ? <label>Passphrase<input type="password" {...secretInput} required maxLength={256} value={passphrase} onChange={event => setPassphrase(event.target.value)} /><span className="help">创建 OKX API 时设置的口令。</span></label> : null}
      {exchange === 'bybit' ? <label>账户地区<select aria-label="账户地区" value={region} onChange={event => setRegion(event.target.value)}>{REGIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
      <p className="help">{PANEL_HELP[exchange]}</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" disabled={writer.busy} onClick={onClose}>取消</button>
        {configured ? <button type="button" className="button" disabled={writer.busy} onClick={() => void writer.run(CONNECTIONS_DELETE_PATH, { exchange }, onClose)}>断开并保留估值</button> : null}
        <button className="button primary" disabled={writer.busy}>{writer.busy ? '验证中…' : '验证并连接'}</button>
      </div>
    </form>
  </section>;
}

type Editing = { id: string; existing: boolean };

/** aster-accounts-panel.tsx: each account has its own API Pro wallet, synced apart and summed. */
function AsterAccounts({ accounts, now, writer }: { accounts: AsterAccount[]; now: number; writer: Writer }) {
  const [editing, setEditing] = useState<Editing | null>(null), [removing, setRemoving] = useState<AsterAccount | null>(null);
  const open = (account?: AsterAccount) => { writer.clear(); setRemoving(null); setEditing({ id: account?.id ?? newRequestId(), existing: !!account }); };
  const ask = (account: AsterAccount) => { writer.clear(); setEditing(null); setRemoving(account); };
  const edited = editing ? accounts.find(account => account.id === editing.id) : undefined;
  return <section className="panel connection-card aster-accounts-panel">
    <div className="aster-heading"><div className="connection-card-title"><div className="exchange-mark aster" aria-hidden="true">A</div><h2>Aster</h2><span className="status">{accounts.length} 个账号</span></div>
      <button type="button" className="button primary" disabled={writer.busy || accounts.length >= ASTER_LIMIT} onClick={() => open()}><Plus size={16} aria-hidden="true" />新增 Aster 账号</button></div>
    <p className="help">每个账号使用自己的 API Pro 钱包地址和私钥，分别同步后汇总。最多 {ASTER_LIMIT} 个账号；每个实际账户只添加一次，更换 API 钱包请使用“更新连接”。</p>
    {editing ? <AsterForm key={editing.id} editing={editing} account={edited} writer={writer} onClose={() => setEditing(null)} /> : null}
    {removing ? <section className="edit-panel aster-remove" aria-label={'移除 ' + removing.name}>
      <h3>移除 {removing.name}</h3>
      <p className="help">删除此账号的连接和已保存私钥，其资产将不再计入当前汇总。过往日期的快照保留，今天的快照会更新。</p>
      {writer.errorOf(ASTER_DELETE_PATH) ? <p className="error-text" role="alert">{writer.errorOf(ASTER_DELETE_PATH)}</p> : null}
      <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={() => setRemoving(null)}>取消</button><button type="button" className="button primary" disabled={writer.busy} onClick={() => void writer.run(ASTER_DELETE_PATH, { id: removing.id, action: 'remove' }, () => setRemoving(null))}>确认移除</button></div>
    </section> : null}
    {accounts.length === 0 ? <p className="help section-note">尚未添加账号。首次连接成功后，以账户余额替换原表 Aster 估值。</p> : <div className="aster-account-list">{accounts.map(account => {
      const unknown = account.value === null;
      const stale = unknown || !!account.error || !account.configured || now - Date.parse(account.updatedAt) > 300_000;
      return <article className="aster-account" key={account.id}>
        <div className="aster-heading"><h3>{account.name}</h3><span className={'status ' + (stale ? 'amber' : 'live')}>{!account.configured ? '已断开 · ' + (unknown ? '估值缺失' : '保留旧值') : unknown ? '估值缺失' : account.error ? '同步失败 · 保留旧值' : stale ? '数据已过期 · 保留旧值' : '已连接'}</span></div>
        <strong className="aster-account-value">{account.value === null ? '—' : '$ ' + money(account.value)} <small>USD</small></strong>
        <p className="help">{account.scope}{account.label ? ' · 钱包尾号 ' + account.label : ''}<br />最近成功同步：{stamp(account.lastSync)}</p>
        {account.error ? <p className="error-text" role="status">{account.error}</p> : null}
        <div className="form-actions"><button type="button" className="button" disabled={writer.busy} onClick={() => open(account)}><Pencil size={14} aria-hidden="true" />{account.configured ? '更新连接' : '重新连接'}</button><button type="button" className="button" disabled={writer.busy} onClick={() => ask(account)}><Trash2 size={14} aria-hidden="true" />移除账号</button></div>
      </article>;
    })}</div>}
  </section>;
}

function AsterForm({ editing, account, writer, onClose }: { editing: Editing; account: AsterAccount | undefined; writer: Writer; onClose: () => void }) {
  const [name, setName] = useState(account?.name ?? ''), [address, setAddress] = useState(''), [secret, setSecret] = useState(''), [includeSpot, setIncludeSpot] = useState(account?.includeSpot ?? false);
  const panel = useRef<HTMLElement | null>(null);
  useEffect(() => { panel.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const path = editing.existing ? ASTER_EDIT_PATH : ASTER_ADD_PATH;
  const error = writer.errorOf(path, ASTER_DELETE_PATH);
  return <section ref={panel} className="edit-panel aster-form" aria-label={editing.existing ? '更新 Aster 账号' : '新增 Aster 账号'}>
    <h3>{editing.existing ? '更新 Aster 账号' : '新增 Aster 账号'}</h3>
    <p className="help">验证钱包与余额后加密保存。私钥仅用于服务端签名，程序仅查询余额。</p>
    <form className="form-grid" onSubmit={event => { event.preventDefault(); void writer.run(path, { id: editing.id, name: name.trim(), walletAddress: address.trim(), privateKey: secret.trim(), includeSpot }, onClose); }}>
      <label>账号名称<input maxLength={40} required value={name} onChange={event => setName(event.target.value)} placeholder="例如：主账号、备用账号" /></label>
      <label>API 钱包地址<input autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="0x…" required value={address} onChange={event => setAddress(event.target.value)} /></label>
      <label>API 钱包私钥<input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" required value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={includeSpot} onChange={event => setIncludeSpot(event.target.checked)} />同时同步现货账户</label>
      <p className="help">填写 Aster「API Pro」生成的 API 钱包地址和私钥；不需要主钱包私钥。范围不含质押资产。</p>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button type="button" className="button" disabled={writer.busy} onClick={onClose}>取消</button>
        {editing.existing && account?.configured ? <button type="button" className="button" disabled={writer.busy} onClick={() => void writer.run(ASTER_DELETE_PATH, { id: editing.id, action: 'disconnect' }, onClose)}>断开并保留估值</button> : null}
        <button className="button primary" disabled={writer.busy}>{writer.busy ? '验证中…' : '验证并保存'}</button>
      </div>
    </form>
  </section>;
}
