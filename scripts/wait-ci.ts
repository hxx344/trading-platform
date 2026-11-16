// Release gate: waits until the ci workflow has passed on the tagged commit, so release.yml does not run those checks
// again. `node scripts/wait-ci.ts` reads GITHUB_REPOSITORY, GITHUB_SHA and GITHUB_TOKEN (actions: read) and exits 0
// only when a ci run on exactly that commit has succeeded; a failed run, no run, or an unreadable API all exit 1.
const APPEAR_MS = 180_000;
const LIMIT_MS = 25 * 60_000;
const INTERVAL_MS = 10_000;
const REQUEST_MS = 20_000;

export type Run = { id: number; event: string; status: string; conclusion: string | null };
export type Verdict = 'passed' | 'failed' | 'pending' | 'missing';

// Throws unless the answer is the complete list of runs on this commit: a page that is short of total_count, or a run
// on another commit (the head_sha filter ignored), proves nothing about it.
export function parseRuns(body: unknown, sha: string): Run[] {
  const list = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  const total = (body as { total_count?: unknown } | null)?.total_count;
  if (!Array.isArray(list) || typeof total !== 'number') throw new Error('应答不是运行列表');
  if (list.length < total) throw new Error(`只读到 ${list.length} / ${total} 个运行`);
  return list.map((item: unknown) => {
    const run = item as Record<string, unknown> | null;
    if (!run || typeof run.id !== 'number' || typeof run.event !== 'string' || typeof run.status !== 'string') throw new Error('运行缺少字段');
    if (run.head_sha !== sha) throw new Error(`运行 ${run.id} 不属于提交 ${sha}`);
    return { id: run.id, event: run.event, status: run.status, conclusion: typeof run.conclusion === 'string' ? run.conclusion : null };
  });
}

// Only runs that checked out this very commit count: a pull_request run tests the merge of the branch into its base,
// so its head_sha can equal a commit it never tested. One success is enough even beside a failed run: the code is the
// same, so the failure was not the commit's.
export function verdict(runs: readonly Run[]): Verdict {
  const counted = runs.filter(run => run.event === 'push' || run.event === 'workflow_dispatch');
  if (counted.some(run => run.status === 'completed' && run.conclusion === 'success')) return 'passed';
  if (counted.some(run => run.status !== 'completed')) return 'pending';
  return counted.length ? 'failed' : 'missing';
}

export async function readRuns(request: typeof fetch, api: string, repo: string, sha: string, token: string): Promise<Run[]> {
  const response = await request(`${api}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return parseRuns(await response.json(), sha);
}

export type WaitOptions = {
  read: () => Promise<Run[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
  // How long to wait for a run to show up at all; the tag usually arrives together with the push that starts ci.
  appearMs?: number;
  // How long to wait in total once a run has been seen queued or running.
  limitMs?: number;
  intervalMs?: number;
};

export async function waitForCi(options: WaitOptions): Promise<{ ok: boolean; reason: Verdict | 'unreadable'; runs: Run[] }> {
  const { read, sleep, now, log, appearMs = APPEAR_MS, limitMs = LIMIT_MS, intervalMs = INTERVAL_MS } = options;
  const started = now();
  let seen = false;
  for (;;) {
    let runs: Run[] = [];
    let state: Verdict | 'unreadable';
    try {
      runs = await read();
      state = verdict(runs);
    } catch (error) {
      state = 'unreadable';
      log(`读取 ci 运行失败：${(error as Error).message}`);
    }
    if (state === 'passed') return { ok: true, reason: state, runs };
    if (state === 'failed') return { ok: false, reason: state, runs };
    if (state === 'pending') seen = true;
    if (now() - started >= (seen ? limitMs : appearMs)) return { ok: false, reason: state, runs };
    if (state === 'pending') log(`ci 运行中：${runs.filter(run => run.status !== 'completed').map(run => `${run.id} ${run.status}`).join('，')}`);
    else if (state === 'missing') log('还没有该提交的 ci 运行');
    await sleep(intervalMs);
  }
}

if (import.meta.main) {
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const sha = process.env.GITHUB_SHA ?? '';
  const token = process.env.GITHUB_TOKEN ?? '';
  const api = process.env.GITHUB_API_URL || 'https://api.github.com';
  const ref = process.env.GITHUB_REF_NAME || sha;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[0-9a-f]{40}$/.test(sha) || !token) {
    process.stderr.write('需要 GITHUB_REPOSITORY（owner/name）、GITHUB_SHA（40 位）与 GITHUB_TOKEN\n');
    process.exit(2);
  }
  const result = await waitForCi({ read: () => readRuns(fetch, api, repo, sha, token), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => performance.now(), log: line => process.stdout.write(`${line}\n`) });
  const list = result.runs.map(run => `${run.id} ${run.event} ${run.status} ${run.conclusion ?? '-'}`).join('；') || '无';
  const retry = '之后重跑本次发布运行里失败的任务。';
  const messages = {
    passed: `提交 ${sha} 的 ci 已通过（${list}）`,
    failed: `提交 ${sha} 的 ci 没有通过（${list}）。在 Actions 里重跑该 ci 运行并通过，${retry}`,
    pending: `等到时限 ci 仍未结束（${list}）。等它通过，${retry}`,
    missing: `没有找到提交 ${sha} 的 ci 运行（${list}）：标签要打在推送到 main 的最新提交上。可先运行 gh workflow run ci.yml --ref ${ref} 并等它通过，${retry}`,
    unreadable: `读不到提交 ${sha} 的 ci 运行，不能确认已通过。${retry}`,
  };
  (result.ok ? process.stdout : process.stderr).write(`${messages[result.reason]}\n`);
  process.exit(result.ok ? 0 : 1);
}
