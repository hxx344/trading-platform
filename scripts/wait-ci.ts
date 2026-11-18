// release.yml waits for ci on the tagged commit. A candidate's manual preflight must not hide a pending or failed main push.
const APPEAR_MS = 180_000;
const LIMIT_MS = 25 * 60_000;
const INTERVAL_MS = 10_000;
const REQUEST_MS = 20_000;

export type Run = {
  id: number; number: number; attempt: number; event: string; branch: string | null;
  status: string; conclusion: string | null; createdAt: number; updatedAt: number;
};
export type Verdict = 'passed' | 'failed' | 'pending' | 'missing';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function timestamp(value: unknown): number {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new Error('运行缺少有效时间');
  return time;
}

// Throws unless the answer is the complete list of runs on this commit: a page that is short of total_count, or a run
// on another commit (the head_sha filter ignored), proves nothing about it.
export function parseRuns(body: unknown, sha: string): Run[] {
  const list = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  const total = (body as { total_count?: unknown } | null)?.total_count;
  if (!Array.isArray(list) || !Number.isSafeInteger(total)) throw new Error('应答不是运行列表');
  if (list.length !== total) throw new Error(`只读到 ${list.length} / ${total} 个运行`);
  return list.map((item: unknown) => {
    const run = item as Record<string, unknown> | null;
    if (!run || !positive(run.id) || !positive(run.run_number) || !positive(run.run_attempt) || typeof run.event !== 'string'
      || typeof run.status !== 'string' || (typeof run.head_branch !== 'string' && run.head_branch !== null)) throw new Error('运行缺少字段');
    if ((run.event === 'push' || run.event === 'workflow_dispatch') && !run.head_branch) throw new Error('运行缺少来源分支或标签');
    if (run.head_sha !== sha) throw new Error(`运行 ${run.id} 不属于提交 ${sha}`);
    const createdAt = timestamp(run.created_at), updatedAt = timestamp(run.updated_at);
    if (updatedAt < createdAt) throw new Error('运行更新时间早于创建时间');
    return { id: run.id, number: run.run_number, attempt: run.run_attempt, event: run.event, branch: run.head_branch,
      status: run.status, conclusion: typeof run.conclusion === 'string' ? run.conclusion : null, createdAt, updatedAt };
  });
}

function verdict(run?: Run): Verdict {
  if (!run) return 'missing';
  if (run.status !== 'completed') return 'pending';
  return run.conclusion === 'success' ? 'passed' : 'failed';
}

export function githubReads(request: typeof fetch, api: string, repo: string, sha: string, token: string, tag: string, releaseId: string) {
  async function get(path: string) {
    const response = await request(`${api}/repos/${repo}/${path}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  return {
    read: async () => parseRuns(await get(`actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`), sha),
    releaseCreatedAt: async () => {
      if (!/^\d+$/.test(releaseId) || !tag) throw new Error('无法识别本次标签发布运行');
      const run = await get(`actions/runs/${releaseId}`) as Record<string, unknown> | null;
      if (!run || !positive(run.id) || String(run.id) !== releaseId || run.event !== 'push' || run.head_branch !== tag || run.head_sha !== sha) {
        throw new Error('发布运行与标签提交不匹配');
      }
      return timestamp(run.created_at);
    },
    isHistorical: async () => {
      const ref = await get('git/ref/heads/main') as { ref?: unknown; object?: { type?: unknown; sha?: unknown } } | null;
      if (ref?.ref !== 'refs/heads/main' || ref.object?.type !== 'commit' || typeof ref.object.sha !== 'string'
        || !/^[0-9a-f]{40}$/.test(ref.object.sha)) throw new Error('无法确认 main 当前提交');
      return ref.object.sha !== sha;
    },
  };
}

export type WaitOptions = {
  read: () => Promise<Run[]>;
  tag: string;
  releaseCreatedAt: () => Promise<number>;
  isHistorical: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  wallNow?: () => number;
  log: (line: string) => void;
  // How long to wait for a run to show up at all; the tag usually arrives together with the push that starts ci.
  appearMs?: number;
  // How long to wait in total once a run has been seen queued or running.
  limitMs?: number;
  intervalMs?: number;
};

export async function waitForCi(options: WaitOptions): Promise<{ ok: boolean; reason: Verdict | 'unreadable'; runs: Run[] }> {
  const { read, sleep, now, wallNow = Date.now, log, appearMs = APPEAR_MS, limitMs = LIMIT_MS, intervalMs = INTERVAL_MS } = options;
  const started = now();
  let seen = false;
  let seenMain: Run | undefined;
  let releaseTime: number | undefined;
  let confirmManual: Run | undefined;
  for (;;) {
    const checkedManual = confirmManual;
    confirmManual = undefined;
    let runs: Run[] = [];
    let state: Verdict | 'unreadable';
    try {
      runs = await read();
      // run_number orders distinct invocations of this workflow; a rerun keeps its number and increments run_attempt.
      const ordered = runs.toSorted((a, b) => b.number - a.number || b.attempt - a.attempt);
      const main = ordered.find(run => run.event === 'push' && run.branch === 'main');
      const manual = ordered.find(run => run.event === 'workflow_dispatch');
      if (seenMain && (!main || main.number < seenMain.number || (main.number === seenMain.number && main.attempt < seenMain.attempt))) {
        throw new Error('先前已见的主线运行或重跑缺失');
      }
      state = verdict(main);
      if (main) {
        seenMain = main;
        // Compare creation with the end of the main attempt. Rerunning an old manual preflight keeps its creation time.
        if (state === 'failed' && manual && manual.createdAt > main.updatedAt) state = verdict(manual);
      } else if (manual && checkedManual) {
        if (manual.id !== checkedManual.id || manual.attempt !== checkedManual.attempt) throw new Error('补验期间最新手动运行已变化');
        state = verdict(manual);
      } else if (manual) {
        releaseTime ??= await options.releaseCreatedAt();
        const tagRecheck = manual.branch === options.tag && manual.createdAt > releaseTime;
        const registrationWindowOver = wallNow() - releaseTime >= appearMs || now() - started >= appearMs;
        // Give an atomic main/tag push time to register. Older manual results are usable only for a historical commit.
        if ((tagRecheck && registrationWindowOver) || ((tagRecheck || registrationWindowOver) && await options.isHistorical())) {
          state = verdict(manual);
          if (state === 'passed') {
            // A main push may have appeared during the release/ref lookups. Confirm the run list before publishing.
            confirmManual = manual;
            continue;
          }
        }
      }
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
  const result = await waitForCi({ ...githubReads(fetch, api, repo, sha, token, ref, process.env.GITHUB_RUN_ID ?? ''), tag: ref,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: () => performance.now(), log: line => process.stdout.write(`${line}\n`) });
  const list = result.runs.map(run => `${run.id}/${run.attempt} ${run.event} ${run.branch} ${run.status} ${run.conclusion ?? '-'}`).join('；') || '无';
  const retry = '之后重跑本次发布运行里失败的任务。';
  const messages = {
    passed: `提交 ${sha} 的 ci 已通过（${list}）`,
    failed: `提交 ${sha} 的 ci 没有通过（${list}）。可重跑主线 ci 或运行 gh workflow run ci.yml --ref ${ref}，等它通过，${retry}`,
    pending: `等到时限 ci 仍未结束（${list}）。等它通过，${retry}`,
    missing: `没有找到可用于提交 ${sha} 的 ci 运行（${list}）。可运行 gh workflow run ci.yml --ref ${ref} 并等它通过，${retry}`,
    unreadable: `读不到提交 ${sha} 的 ci 运行，不能确认已通过。${retry}`,
  };
  (result.ok ? process.stdout : process.stderr).write(`${messages[result.reason]}\n`);
  process.exit(result.ok ? 0 : 1);
}
