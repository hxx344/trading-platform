// The release gate (scripts/wait-ci.ts): which ci runs let a tag be published, and that every other outcome refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuns, readRuns, verdict, waitForCi, type Run } from '../scripts/wait-ci.ts';

const sha = 'a'.repeat(40);
const run = (event: string, status: string, conclusion: string | null = null, id = 1): Run => ({ id, event, status, conclusion });

// Each entry answers one poll (the last one repeats); an Error is a failed read. Time only moves when the gate sleeps.
function scripted(polls: Array<Run[] | Error>) {
  let clock = 0, reads = 0;
  const lines: string[] = [];
  return {
    lines,
    reads: () => reads,
    elapsed: () => clock,
    options: {
      read: async () => { const poll = polls[Math.min(reads++, polls.length - 1)]; if (poll instanceof Error) throw poll; return poll; },
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      log: (line: string) => { lines.push(line); },
      appearMs: 30, limitMs: 100, intervalMs: 10,
    },
  };
}

test('发布门禁：只认在该提交上跑过的 ci，合并请求的运行不算', () => {
  assert.equal(verdict([run('push', 'completed', 'success')]), 'passed');
  assert.equal(verdict([run('workflow_dispatch', 'completed', 'success')]), 'passed');
  assert.equal(verdict([run('pull_request', 'completed', 'success')]), 'missing');
  assert.equal(verdict([run('pull_request_target', 'completed', 'success'), run('schedule', 'completed', 'success')]), 'missing');
  assert.equal(verdict([]), 'missing');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale', null]) {
    assert.equal(verdict([run('push', 'completed', conclusion)]), 'failed', String(conclusion));
  }
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.equal(verdict([run('push', status)]), 'pending', status);
  }
  assert.equal(verdict([run('push', 'completed', 'failure', 1), run('workflow_dispatch', 'in_progress', null, 2)]), 'pending');
  assert.equal(verdict([run('push', 'completed', 'failure', 1), run('workflow_dispatch', 'completed', 'success', 2)]), 'passed');
  assert.equal(verdict([run('push', 'completed', 'success', 1), run('workflow_dispatch', 'completed', 'failure', 2)]), 'passed');
  assert.equal(verdict([run('push', 'completed', 'failure', 1), run('pull_request', 'completed', 'success', 2)]), 'failed');
});

test('发布门禁：按提交查询 ci 工作流的运行，非 2xx 算读取失败', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const answer = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const item = { id: 7, event: 'push', status: 'completed', conclusion: 'success', head_sha: sha };
  assert.deepEqual(await readRuns(answer(200, { total_count: 1, workflow_runs: [item] }), 'https://api.example', 'owner/name', sha, 'token-1'), [run('push', 'completed', 'success', 7)]);
  assert.equal(calls[0].url, `https://api.example/repos/owner/name/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  assert.equal(calls[0].headers.authorization, 'Bearer token-1');
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(readRuns(answer(status, { total_count: 1, workflow_runs: [item] }), 'https://api.example', 'owner/name', sha, 'token-1'), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(readRuns(answer(200, { total_count: 3, workflow_runs: [item] }), 'https://api.example', 'owner/name', sha, 'token-1'), /1 \/ 3/);
});

test('发布门禁：应答不完整或混入别的提交时算读取失败', () => {
  const item = { id: 7, event: 'push', status: 'completed', conclusion: 'success', head_sha: sha };
  assert.deepEqual(parseRuns({ total_count: 1, workflow_runs: [item] }, sha), [run('push', 'completed', 'success', 7)]);
  assert.deepEqual(parseRuns({ total_count: 1, workflow_runs: [{ ...item, status: 'queued', conclusion: null }] }, sha), [run('push', 'queued', null, 7)]);
  assert.deepEqual(parseRuns({ total_count: 0, workflow_runs: [] }, sha), []);
  assert.throws(() => parseRuns({ total_count: 2, workflow_runs: [item] }, sha), /1 \/ 2/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, head_sha: 'b'.repeat(40) }] }, sha), /不属于/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, head_sha: undefined }] }, sha), /不属于/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, status: undefined }] }, sha), /缺少字段/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [null] }, sha), /缺少字段/);
  for (const body of [null, 'x', [], {}, { workflow_runs: [] }, { total_count: 1, workflow_runs: {} }, { message: 'Not Found' }]) {
    assert.throws(() => parseRuns(body, sha), /不是运行列表/, JSON.stringify(body));
  }
});

test('发布门禁：等到 ci 通过才放行，失败立即拒绝', async () => {
  const waiting = scripted([[], [run('push', 'queued')], [run('push', 'in_progress')], [run('push', 'completed', 'success')]]);
  assert.deepEqual(await waitForCi(waiting.options), { ok: true, reason: 'passed', runs: [run('push', 'completed', 'success')] });
  assert.equal(waiting.reads(), 4);

  const failing = scripted([[run('push', 'in_progress')], [run('push', 'completed', 'failure')], [run('push', 'completed', 'success')]]);
  const failed = await waitForCi(failing.options);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'failed');
  assert.equal(failing.reads(), 2);

  // A read error in between neither passes nor fails the gate.
  const flaky = scripted([new Error('HTTP 502'), [run('push', 'in_progress')], new Error('HTTP 502'), [run('push', 'completed', 'success')]]);
  assert.equal((await waitForCi(flaky.options)).ok, true);
  assert.deepEqual(flaky.lines.filter(line => line.includes('HTTP 502')).length, 2);
});

test('发布门禁：等待有上限，到时限一律拒绝', async () => {
  const missing = scripted([[]]);
  assert.deepEqual(await waitForCi(missing.options), { ok: false, reason: 'missing', runs: [] });
  assert.equal(missing.elapsed(), 30);

  const onlyPullRequest = scripted([[run('pull_request', 'completed', 'success')]]);
  assert.equal((await waitForCi(onlyPullRequest.options)).reason, 'missing');
  assert.equal(onlyPullRequest.elapsed(), 30);

  const unreadable = scripted([new Error('HTTP 403')]);
  assert.deepEqual(await waitForCi(unreadable.options), { ok: false, reason: 'unreadable', runs: [] });
  assert.equal(unreadable.elapsed(), 30);

  // Once a run has been seen the longer limit applies, also when it shows up after the first limit's halfway point.
  const stuck = scripted([[], [], [run('push', 'in_progress')]]);
  const result = await waitForCi(stuck.options);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'pending');
  assert.equal(stuck.elapsed(), 100);

  // A run that was seen and then cannot be read any more still stops at the longer limit, refused.
  const lost = scripted([[run('push', 'in_progress')], new Error('HTTP 500')]);
  assert.deepEqual(await waitForCi(lost.options), { ok: false, reason: 'unreadable', runs: [] });
  assert.equal(lost.elapsed(), 100);
});
