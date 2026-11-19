// What the 只读接口令牌 panel and the sidebar say about the token (docs/mcp.md), and the alias lookup's input. Pure, so the
// wording and the checks are tested without a browser.

export interface ReadTokenView {
  state: 'none' | 'active' | 'expired';
  id: string | null; createdAt: number | null; expiresAt: number | null; lastUsedAt: number | null;
  requests24h: number; warn: boolean; error: string | null;
}

const DAY_MS = 86_400_000;
/** Read by the sidebar and the settings page (one shared subscription, same options). */
export const READ_TOKEN_PATH = '/api/read-token';
export const READ_TOKEN_REFRESH_MS = 60_000;

/** The alias as the lookup sends it, or null when it is not an alias the platform hands out. */
export function parseAlias(text: string): string | null {
  const alias = text.trim().toLowerCase();
  return /^(acct|addr|tx)-[0-9a-f]{8}$/.test(alias) ? alias : null;
}

/** The expiry notice: from 7 days before expiry, and once expired; null otherwise. */
export function expiryNotice(view: ReadTokenView | null, now: number): string | null {
  if (!view || view.state === 'none' || view.expiresAt === null) return null;
  if (view.state === 'expired' || now >= view.expiresAt) return `只读接口令牌（编号 ${view.id}）已到期，MCP 客户端已无法读取；请重新生成并更新客户端的令牌文件。`;
  if (!view.warn) return null;
  const days = Math.max(1, Math.ceil((view.expiresAt - now) / DAY_MS));
  return `只读接口令牌（编号 ${view.id}）将在 ${days} 天内到期；到期前请重新生成并更新客户端的令牌文件。`;
}

/** The sidebar's one-line hint under 设置, or null. */
export function navNotice(view: ReadTokenView | null, now: number): string | null {
  if (!view || view.state === 'none' || view.expiresAt === null) return null;
  if (view.state === 'expired' || now >= view.expiresAt) return '只读令牌已到期';
  return view.warn ? `只读令牌 ${Math.max(1, Math.ceil((view.expiresAt - now) / DAY_MS))} 天内到期` : null;
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
