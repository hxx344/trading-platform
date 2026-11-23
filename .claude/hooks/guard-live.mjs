// PreToolUse hook for Bash and PowerShell: commands that reach real accounts or servers need the user's approval. Matches
// running the probes (signed requests, --live moves funds), the Variational credential bridges, the real service entry
// points, and ssh/scp to a server. Reading those files is not matched.
// Normal modes: the user is asked. bypassPermissions may not show that prompt, so there the command is refused until the
// agent has the user's yes in chat and reruns it with the TP_LIVE_CONFIRMED=1 marker.
import { readFileSync } from 'node:fs';

const RULES = [
  [/\b(node|tsx|bun|deno|python3?|py)(\.exe)?\b[^\n|;&]*\bprobes[\\/]/i, '运行 probes/ 下的探针：会用真实账户签名请求，带 --live 时会真实划转'],
  [/\bscripts[\\/]variational-(request|balance)\.py\b/i, '运行 Variational 凭据桥：会用真实凭据请求 Var'],
  [/\bpnpm\s+(run\s+)?(start|service)\b/i, '启动真实服务入口（按 config.json 连接真实账户）'],
  [/\bnode(\.exe)?\b[^\n|;&]*\bsrc[\\/](main|service[\\/]main)\.ts\b/i, '启动真实服务入口（按 config.json 连接真实账户）'],
  [/(^|[;&|(\n])\s*(ssh|scp)(\.exe)?\s/i, '连接服务器（ssh / scp）'],
];
const CONFIRMED = /\bTP_LIVE_CONFIRMED\s*=\s*['"]?1\b/;

let input;
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const command = typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';
const hit = RULES.find(([pattern]) => pattern.test(command));
if (!hit) process.exit(0);

const bypass = input.permission_mode === 'bypassPermissions';
if (bypass && CONFIRMED.test(command)) process.exit(0);

const decision = bypass
  ? {
      permissionDecision: 'deny',
      permissionDecisionReason: `${hit[1]}。先在聊天里把完整命令告诉用户并得到明确同意，再在命令前加 TP_LIVE_CONFIRMED=1（PowerShell 用 $env:TP_LIVE_CONFIRMED=1;）重新执行。不要未经同意加这个标记。`,
    }
  : { permissionDecision: 'ask', permissionDecisionReason: `${hit[1]}。确认是你要执行的再放行。` };
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } }));
