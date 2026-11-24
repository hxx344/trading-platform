// MEV 套利页（docs/mev.md 第 5 节）不依赖 DOM 的部分：页签与地址、读数格式、风控参数表单到请求的转换、
// 开始实盘的确认文案。由 web/test/mev-form.test.mjs 覆盖。
import type { Settings } from '../../../src/mev/risk.ts';
import type { OpportunityOutcome, TxStatus } from '../../../src/mev/store.ts';
import type { MevSetupView, MevStateView } from '../../../src/mev/views.ts';
import type { MevTab } from '../route-parse.ts';

export const MEV_BASE = '/api/mev';
export type { MevTab };
export const MEV_TABS: readonly { id: MevTab; label: string }[] = [
  { id: 'overview', label: '概览' }, { id: 'opportunities', label: '机会' }, { id: 'transactions', label: '交易' }, { id: 'pools', label: '池子与代币' }, { id: 'settings', label: '设置' },
];
export const mevHref = (tab: MevTab): string => tab === 'overview' ? '#/mev' : `#/mev/${tab}`;

export const TX_STATUS_LABELS: Record<TxStatus, string> = {
  recorded: '已入库待发送', sent: '已发送', unknown: '结果不明', expired: '已过期未上链', success: '成功', reverted: '上链回滚', replaced: '被同 nonce 交易替换', lost: 'nonce 被占用',
};
export const txTone = (status: TxStatus): 'ok' | 'warn' | 'bad' | 'info' | '' =>
  status === 'success' ? 'ok' : status === 'reverted' || status === 'lost' ? 'bad' : status === 'unknown' || status === 'expired' ? 'warn' : status === 'replaced' ? '' : 'info';
export const OUTCOME_LABELS: Record<OpportunityOutcome, string> = { observed: '观察', sent: '已发送', blocked: '被风控拦下', thin: '净利不足' };
export const outcomeTone = (outcome: OpportunityOutcome): 'ok' | 'warn' | 'info' | '' => outcome === 'sent' ? 'ok' : outcome === 'blocked' ? 'warn' : outcome === 'observed' ? 'info' : '';

export const shortAddress = (address: string): string => address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
export const explorerTx = (hash: string): string => `https://basescan.org/tx/${hash}`;
export const explorerAddress = (address: string): string => `https://basescan.org/address/${address}`;

export function usd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function compactUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const size = Math.abs(value);
  return size >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : size >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : size >= 1e3 ? `$${(value / 1e3).toFixed(1)}k` : `$${value.toFixed(0)}`;
}
export const eth = (value: number | null | undefined, digits = 6): string => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)} ETH`;
export const bps = (value: number): string => Number.isFinite(value) ? value.toFixed(2) : '—';
export const feePercent = (ppm: number): string => `${(ppm / 10_000).toFixed(ppm % 100 ? 4 : 2)}%`;
/** 代币数量：最多 8 位有效小数，去掉尾零。 */
export function tokenAmount(value: string | null, symbol: string): string {
  if (value === null) return '—';
  const [whole, fraction = ''] = value.split('.');
  const kept = fraction.slice(0, 8).replace(/0+$/, '');
  return `${whole}${kept ? `.${kept}` : ''}${symbol ? ` ${symbol}` : ''}`;
}
export function age(at: number | null, now: number): string {
  if (at === null) return '—';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return seconds < 90 ? `${seconds} 秒前` : seconds < 5400 ? `${Math.round(seconds / 60)} 分钟前` : seconds < 172_800 ? `${Math.round(seconds / 3600)} 小时前` : `${Math.round(seconds / 86_400)} 天前`;
}

/** 表单里一项参数：`scale` 是页面数值与存储数值的比（百分比为 100）。 */
export interface SettingField { key: keyof Settings; label: string; unit: string; hint: string; scale: number; group: 'profit' | 'limits' | 'discovery' }
export const SETTING_FIELDS: readonly SettingField[] = [
  { key: 'minNetUsd', label: '最低净利', unit: '美元', hint: '扣掉 gas、L1 数据费与小费后至少赚这么多才发送', scale: 1, group: 'profit' },
  { key: 'gasMultiple', label: '净利对基础费用倍数', unit: '倍', hint: '净利至少是 L2 基础费加 L1 数据费的这么多倍', scale: 1, group: 'profit' },
  { key: 'tipShare', label: '小费占利润比例', unit: '%', hint: '预期利润里拿去做优先费的部分，越高越靠前、赚得越少', scale: 100, group: 'profit' },
  { key: 'minProfitRatio', label: '链上最低利润比例', unit: '%', hint: '合约里的 minProfit 取模拟利润的这个比例；实际低于它整笔回滚', scale: 100, group: 'profit' },
  { key: 'dailyGasBudgetEth', label: '每日 gas 预算', unit: 'ETH', hint: '每个 UTC 日的 gas 支出上限（含未结清交易的预留），用完当日不再发送', scale: 1, group: 'limits' },
  { key: 'minWalletEth', label: '钱包余额下限', unit: 'ETH', hint: '热钱包余额低于它即停实盘', scale: 1, group: 'limits' },
  { key: 'maxConsecutiveReverts', label: '连续回滚熔断笔数', unit: '笔', hint: '连续这么多笔上链回滚后停实盘', scale: 1, group: 'limits' },
  { key: 'maxGasLimit', label: '单笔 gas 上限', unit: 'gas', hint: '估算 gas 的 1.3 倍超过它的环路不发送', scale: 1, group: 'limits' },
  { key: 'maxNotionalUsd', label: '单笔名义上限', unit: '美元', hint: '闪电兑换第一跳的输入不超过它（本金来自池子，不占钱包资金）', scale: 1, group: 'limits' },
  { key: 'minEdgeBps', label: '粗筛毛收益门槛', unit: '基点', hint: '按现货价算的环路毛收益超过它才去模拟', scale: 1, group: 'discovery' },
  { key: 'minDepthUsd', label: '池子最小深度', unit: '美元', hint: '两侧虚拟储备合计低于它的池子不参与', scale: 1, group: 'discovery' },
  { key: 'maxSimulationsPerBlock', label: '每区块模拟条数', unit: '条', hint: '每个区块最多模拟多少条环路；越多越占节点配额', scale: 1, group: 'discovery' },
];
export const SETTING_GROUPS: readonly { id: SettingField['group']; label: string }[] = [{ id: 'profit', label: '利润门槛与出价' }, { id: 'limits', label: '额度与熔断' }, { id: 'discovery', label: '发现' }];

export type SettingsForm = Record<keyof Settings, string>;
/** 去掉浮点乘法的尾差（0.3 × 100 = 30.000000000000004）。 */
const tidy = (value: number): string => String(Number(value.toPrecision(12)));
export function settingsForm(settings: Settings): SettingsForm {
  return Object.fromEntries(SETTING_FIELDS.map(field => [field.key, tidy(settings[field.key] * field.scale)])) as SettingsForm;
}
/** 表单转成请求体；有填错的项时给出第一处的说明。范围由服务端校验。 */
export function settingsRequest(form: SettingsForm): { ok: true; body: { settings: Settings } } | { ok: false; message: string } {
  const settings = {} as Settings;
  for (const field of SETTING_FIELDS) {
    const text = form[field.key].trim(), value = Number(text);
    if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(value)) return { ok: false, message: `${field.label}须为不带符号的数字` };
    settings[field.key] = Number((value / field.scale).toPrecision(12));
  }
  return { ok: true, body: { settings } };
}
export const settingsChanged = (form: SettingsForm, settings: Settings): boolean => { const saved = settingsForm(settings); return SETTING_FIELDS.some(field => form[field.key].trim() !== saved[field.key]); };

/** 现在能不能开始实盘；不能时给出原因（服务端还会再核对一遍）。 */
export function startBlocker(view: MevStateView): string | null {
  if (!view.verification.ok) return view.verification.reason ?? '合约核对未通过';
  if (!view.head || !view.wallet) return '还没有读到链上状态';
  if (view.lagging) return '节点的最新区块落后';
  if (view.wallet.eth < view.settings.minWalletEth) return `热钱包余额 ${eth(view.wallet.eth)} 低于下限 ${view.settings.minWalletEth} ETH`;
  return null;
}
/** 开始实盘前给用户核对的内容。 */
export function startConfirmText(view: MevStateView): string {
  const lines = [
    '开始实盘后，模块会用热钱包自动签名并发送套利交易，花费真实的 gas。',
    `热钱包：${view.operator}（余额 ${eth(view.wallet?.eth)}）`,
    `执行合约：${view.executor}`,
    `利润收款（owner）：${view.owner}`,
    `每日 gas 预算 ${view.settings.dailyGasBudgetEth} ETH，最低净利 ${view.settings.minNetUsd} 美元，连续回滚 ${view.settings.maxConsecutiveReverts} 笔熔断。`,
  ];
  if (view.fault) lines.push(`上次的故障记录将被清除：${view.fault}`);
  else if (view.haltReason) lines.push(`上次停止的原因：${view.haltReason}`);
  lines.push('确认开始？');
  return lines.join('\n');
}

// ---- 启用向导（docs/mev.md 第 6 节）----
/** 与服务端 src/mev/setup.ts 的 REDEPLOY_AFTER_MS 一致：部署交易发出这么久没上链才能加价重发。 */
export const REDEPLOY_AFTER_MS = 5 * 60_000;
export interface SetupForm { privateKey: string; owner: string; rpcUrl: string }

/** 表单到请求。只做格式检查，地址与私钥是否相同等由服务端核对；报错里不带私钥。 */
export function setupRequest(form: SetupForm): { ok: true; body: { privateKey: string; owner: string; rpcUrl?: string } } | { ok: false; message: string } {
  const key = form.privateKey.trim().replace(/^0x/i, ''), owner = form.owner.trim(), rpcUrl = form.rpcUrl.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return { ok: false, message: '私钥须为 64 位十六进制（可带 0x）。助记词不行，请从钱包里导出这个地址的私钥' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) return { ok: false, message: '利润收款地址须为 0x 开头的 40 位十六进制地址' };
  if (rpcUrl && !/^https?:\/\/\S+$/i.test(rpcUrl)) return { ok: false, message: '节点地址须以 https:// 开头（本机或内网自建节点可用 http://）' };
  return { ok: true, body: { privateKey: `0x${key}`, owner, ...(rpcUrl ? { rpcUrl } : {}) } };
}

/** 页面经明文 http 打开且不是本机：录入私钥前要提醒。 */
export const insecurePage = (location: { protocol: string; hostname: string }): boolean =>
  location.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

export function deployBlocker(setup: MevSetupView): string | null {
  if (!setup.wallet) return setup.rpcError ? '读不到热钱包余额' : '正在读取热钱包余额';
  if (setup.wallet.eth <= 0) return '热钱包里还没有 ETH，先转入 gas';
  return null;
}

export function deployConfirmText(setup: MevSetupView): string {
  return [
    setup.deploy ? '在同一个 nonce 上加价重发部署交易？' : '由热钱包发出部署执行合约的交易？',
    `热钱包：${setup.operator}（余额 ${eth(setup.wallet?.eth)}）`,
    `利润收款地址（合约 owner，部署后不可更改）：${setup.owner}`,
    '部署费用从热钱包余额里出，发出后不能撤回。请再核对一遍收款地址。',
  ].join('\n');
}

export function resetConfirmText(setup: MevSetupView): string {
  const pending = setup.deploy ? '\n部署交易已经发出、还没有结果：它之后仍可能上链并花掉这笔 gas。服务器会记下合约地址，重新录入同一把私钥与收款地址时沿用；换了收款地址则需要重新部署。' : '';
  return `移除热钱包 ${setup.operator}？\n服务器上的私钥会被删除。链上的执行合约与钱包里的余额不受影响；余额要用你自己保存的私钥取回，移除前请确认私钥另有备份。${pending}`;
}
