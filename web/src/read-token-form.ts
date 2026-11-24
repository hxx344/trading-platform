// What the 只读接口令牌 panel and the sidebar say about the tokens (docs/mcp.md 8.4), the new-token form's checks and the
// alias lookup's input. Pure, so the wording and the checks are tested without a browser.

export type ReadScope = 'public' | 'system' | 'portfolio';
export const READ_SCOPES: readonly ReadScope[] = ['public', 'system', 'portfolio'];
export const READ_SCOPE_TEXT: Record<ReadScope, { name: string; detail: string }> = {
  public: { name: '公开行情', detail: '行情监控报价、EQN 快讯与异动行情' },
  system: { name: '系统状态', detail: '运行状态（不含飞书消息原文与账户行情流）、服务器负载、在线更新' },
  portfolio: { name: '账户与策略', detail: '日志、执行器、划转与 ADL、原油、海力士、金油、告警、期权、CrossEx、Ondo、Var/Lighter' },
};

export interface ReadTokenItem {
  id: string; name: string; scopes: ReadScope[]; state: 'active' | 'expired';
  createdAt: number; expiresAt: number; lastUsedAt: number | null; requests24h: number; warn: boolean;
}
export interface ReadTokenView { tokens: ReadTokenItem[]; max: number; error: string | null }

const DAY_MS = 86_400_000;
const NAME_MAX = 40;
/** Read by the sidebar and the settings page (one shared subscription, same options). */
export const READ_TOKEN_PATH = '/api/read-token';
export const READ_TOKEN_REFRESH_MS = 60_000;

/** The alias as the lookup sends it, or null when it is not an alias the platform hands out. */
export function parseAlias(text: string): string | null {
  const alias = text.trim().toLowerCase();
  return /^(acct|addr|tx)-[0-9a-f]{8}$/.test(alias) ? alias : null;
}

/** The generate request from the form, or the reason it cannot be sent. */
export function generateBody(name: string, scopes: ReadonlySet<ReadScope>, view: ReadTokenView | null): { body: { name: string; scopes: ReadScope[] } } | { error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: '请填写名称，如「本机 Claude Code」' };
  if ([...trimmed].length > NAME_MAX) return { error: `名称最多 ${NAME_MAX} 个字` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { error: '名称不能含控制字符' };
  if (!scopes.size) return { error: '至少选一个范围' };
  if (view && view.tokens.length >= view.max) return { error: `最多 ${view.max} 个令牌，请先吊销不用的` };
  return { body: { name: trimmed, scopes: READ_SCOPES.filter(scope => scopes.has(scope)) } };
}

export const scopeText = (scopes: readonly ReadScope[]): string => scopes.map(scope => READ_SCOPE_TEXT[scope].name).join('、');

const expiredAt = (token: ReadTokenItem, now: number) => token.state === 'expired' || now >= token.expiresAt;
const daysLeft = (token: ReadTokenItem, now: number) => Math.max(1, Math.ceil((token.expiresAt - now) / DAY_MS));

/** The expiry notice: tokens already expired, and those within 7 days of expiry (nearest first); null when none. */
export function expiryNotice(view: ReadTokenView | null, now: number): string | null {
  const tokens = view?.tokens ?? [];
  const expired = tokens.filter(token => expiredAt(token, now));
  const soon = tokens.filter(token => !expiredAt(token, now) && token.warn).sort((a, b) => a.expiresAt - b.expiresAt);
  const parts: string[] = [];
  if (expired.length) parts.push(`${expired.map(token => `「${token.name}」`).join('')}已到期，用它的 MCP 客户端已无法读取`);
  for (const token of soon) parts.push(`「${token.name}」将在 ${daysLeft(token, now)} 天内到期`);
  return parts.length ? `${parts.join('；')}。请生成新令牌并更新客户端的令牌文件，再吊销旧的。` : null;
}

/** The sidebar's one-line hint under 设置, or null. */
export function navNotice(view: ReadTokenView | null, now: number): string | null {
  const tokens = view?.tokens ?? [];
  const expired = tokens.filter(token => expiredAt(token, now)).length;
  if (expired) return expired > 1 ? `${expired} 个只读令牌已到期` : '只读令牌已到期';
  const soon = tokens.filter(token => token.warn).sort((a, b) => a.expiresAt - b.expiresAt)[0];
  return soon ? `只读令牌 ${daysLeft(soon, now)} 天内到期` : null;
}

/**
 * The commands shown with a new token, run on the MCP client's computer. The token is pasted into `cat` rather than
 * written into a command, so it stays out of the shell history.
 */
export function setupCommands(origin: string): string {
  return [
    'mkdir -p -m 700 ~/.config/trading-platform',
    '(umask 077 && cat > ~/.config/trading-platform/read-token)   # 粘贴令牌，回车，再按 Ctrl-D',
    `claude mcp add trading-platform -e TP_MCP_URL=${origin} -e TP_MCP_TOKEN_FILE=$HOME/.config/trading-platform/read-token -- node <仓库目录>/tools/mcp/readonly.ts`,
  ].join('\n');
}
