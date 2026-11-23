// Stop hook: when the working tree has uncommitted TypeScript changes, run the same two tsc projects as `pnpm check` (and the
// ci "check" job). On errors, exit 2 so the agent keeps going and sees them. Skips when a stop hook already sent it back, when
// nothing TypeScript changed, or when dependencies are not installed in this checkout.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no input: still check */ }
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) process.exit(0);

const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
if (status.status !== 0) process.exit(0);
const changed = status.stdout.split('\n').some(line => /\.(ts|tsx|mts|cts)"?$/.test(line.trim()));
if (!changed) process.exit(0);

const failures = [];
for (const project of ['tsconfig.json', 'web/tsconfig.json']) {
  const run = spawnSync(process.execPath, [tsc, '-p', project], { cwd: root, encoding: 'utf8', timeout: 240_000 });
  if (run.status !== 0) failures.push(`tsc -p ${project}\n${`${run.stdout}${run.stderr}`.trim().split('\n').slice(0, 40).join('\n')}`);
}
if (!failures.length) process.exit(0);

process.stderr.write(`类型检查未通过（与 pnpm check 相同的两个项目），修好再结束：\n\n${failures.join('\n\n')}\n`);
process.exit(2);
