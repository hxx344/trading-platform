// The release gate (scripts/wait-ci.ts): which ci runs let a tag be published, and that every other outcome refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubReads, parseRuns, waitForCi, type Run } from '../scripts/wait-ci.ts';

const sha = 'a'.repeat(40);
const tag = 'v1.0.0';
const epoch = Date.UTC(2026, 0, 1);
const run = (event: string, status: string, conclusion: string | null = null, id = 1, changes: Partial<Run> = {}): Run => ({
  id, number: id, attempt: 1, event, branch: event === 'push' ? 'main' : 'candidate', status, conclusion,
  createdAt: epoch + id, updatedAt: epoch + id, ...changes,
});

const item = {
  id: 7, run_number: 7, run_attempt: 1, head_branch: 'main', head_sha: sha, event: 'push', status: 'completed',
  conclusion: 'success', created_at: new Date(epoch + 7).toISOString(), updated_at: new Date(epoch + 7).toISOString(),
};

// Each entry answers one poll (the last one repeats); an Error is a failed read. Time only moves when the gate sleeps.
function scripted(polls: Array<Run[] | Error>, historical = false, releaseTime = epoch + 10) {
  let clock = 0, reads = 0;
  const lines: string[] = [];
  return {
    lines,
    reads: () => reads,
    elapsed: () => clock,
    options: {
      read: async () => { const poll = polls[Math.min(reads++, polls.length - 1)]; if (poll instanceof Error) throw poll; return poll; },
      tag, releaseCreatedAt: async () => releaseTime, isHistorical: async () => historical,
      sleep: async (ms: number) => { clock += ms; },
      now: () => clock,
      wallNow: () => epoch + 10 + clock,
      log: (line: string) => { lines.push(line); },
      appearMs: 30, limitMs: 100, intervalMs: 10,
    },
  };
}

test('发布门禁：只认同一提交的 main 推送和手动运行，按最新主线结果判定', async () => {
  const outcome = async (runs: Run[]) => (await waitForCi(scripted([runs], true).options)).reason;
  assert.equal(await outcome([run('push', 'completed', 'success')]), 'passed');
  assert.equal(await outcome([run('workflow_dispatch', 'completed', 'success')]), 'passed');
  assert.equal(await outcome([run('push', 'completed', 'success', 1, { branch: 'feature' })]), 'missing');
  assert.equal(await outcome([run('pull_request', 'completed', 'success')]), 'missing');
  assert.equal(await outcome([run('pull_request_target', 'completed', 'success'), run('schedule', 'completed', 'success')]), 'missing');
  assert.equal(await outcome([]), 'missing');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral', 'action_required', 'stale', null]) {
    assert.equal(await outcome([run('push', 'completed', conclusion)]), 'failed', String(conclusion));
  }
  for (const status of ['queued', 'in_progress', 'waiting', 'requested', 'pending']) {
    assert.equal(await outcome([run('push', status)]), 'pending', status);
  }
  assert.equal(await outcome([run('push', 'completed', 'failure', 1), run('workflow_dispatch', 'in_progress', null, 2)]), 'pending');
  assert.equal(await outcome([run('push', 'completed', 'failure', 1), run('workflow_dispatch', 'completed', 'success', 2)]), 'passed');
  assert.equal(await outcome([run('push', 'completed', 'success', 1), run('workflow_dispatch', 'completed', 'failure', 2)]), 'passed');
  assert.equal(await outcome([run('push', 'completed', 'failure', 1), run('pull_request', 'completed', 'success', 2)]), 'failed');
});

test('发布门禁：同一 SHA 的旧主线或手动成功不能覆盖最新推送及其重跑', async () => {
  const oldMain = run('push', 'completed', 'success', 1);
  const rerun = run('push', 'in_progress', null, 2, { attempt: 2, updatedAt: epoch + 10 });
  const oldManual = run('workflow_dispatch', 'completed', 'success', 7, { attempt: 3, updatedAt: epoch + 16 });
  const failed = { ...rerun, status: 'completed', conclusion: 'failure', updatedAt: epoch + 14 };
  const waiting = scripted([[oldManual, rerun, oldMain], [oldMain, failed, oldManual]]);
  assert.equal((await waitForCi(waiting.options)).reason, 'failed');
  assert.equal(waiting.reads(), 2);
  const tie = run('workflow_dispatch', 'completed', 'success', 14);
  assert.equal((await waitForCi(scripted([[failed, tie, oldManual]]).options)).reason, 'failed');

  const fresh = run('workflow_dispatch', 'in_progress', null, 15, { branch: tag });
  const recovered = scripted([[failed, oldManual, fresh], [{ ...fresh, status: 'completed', conclusion: 'success' }, failed]]);
  assert.equal((await waitForCi(recovered.options)).ok, true);
  assert.equal(recovered.reads(), 2);

  const staleAnswer = scripted([[rerun], [{ ...rerun, attempt: 1, status: 'completed', conclusion: 'success' }, oldManual]]);
  assert.equal((await waitForCi(staleAnswer.options)).reason, 'unreadable');
});

test('发布门禁：原子推送时旧预检先出现，仍等待最新 main；main 始终缺失也不放行', async () => {
  const candidate = run('workflow_dispatch', 'completed', 'success');
  const main = run('push', 'queued', null, 2);
  const waiting = scripted([[candidate], [candidate, main], [candidate, { ...main, status: 'completed', conclusion: 'success' }]]);
  assert.equal((await waitForCi(waiting.options)).ok, true);
  assert.equal(waiting.reads(), 3);

  const missed = scripted([[candidate]]);
  assert.equal((await waitForCi(missed.options)).reason, 'missing');
  assert.equal(missed.elapsed(), 30);
  const oldTag = scripted([[{ ...candidate, branch: tag }]]);
  assert.equal((await waitForCi(oldTag.options)).reason, 'missing');
  const lost = scripted([[candidate, main], [candidate]], true);
  assert.equal((await waitForCi(lost.options)).reason, 'unreadable');
  const registeredDuringLookup = scripted([[candidate], [candidate, { ...main, status: 'completed', conclusion: 'failure' }]], true, epoch - 100);
  assert.equal((await waitForCi(registeredDuringLookup.options)).reason, 'failed');
});

test('发布门禁：历史提交复用已有手动结果，标签上明确补验后可直接恢复', async () => {
  const candidate = run('workflow_dispatch', 'completed', 'success');
  const historical = scripted([[candidate]], true);
  assert.equal((await waitForCi(historical.options)).ok, true);
  assert.equal(historical.elapsed(), 30);

  const recheck = run('workflow_dispatch', 'completed', 'success', 11, { branch: tag });
  const direct = scripted([[recheck]], true);
  assert.equal((await waitForCi(direct.options)).ok, true);
  assert.equal(direct.elapsed(), 0);
  const retry = scripted([[recheck]], false, epoch - 100);
  assert.equal((await waitForCi(retry.options)).ok, true);
  assert.equal(retry.elapsed(), 0);

  const delayedMain = scripted([[recheck], [recheck, run('push', 'completed', 'failure', 12)]]);
  assert.equal((await waitForCi(delayedMain.options)).reason, 'failed');
  const unreadable = scripted([[candidate]], true);
  unreadable.options.isHistorical = async () => { throw new Error('HTTP 403'); };
  assert.equal((await waitForCi(unreadable.options)).reason, 'unreadable');
});

test('发布门禁：按提交查询 ci 工作流，校验发布事件与 main 引用；不可读的证据拒绝', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const answer = (status: number, body: unknown) => (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  const reads = (status: number, body: unknown) => githubReads(answer(status, body), 'https://api.example', 'owner/name', sha, 'token-1', tag, '99');
  assert.deepEqual(await reads(200, { total_count: 1, workflow_runs: [item] }).read(), [run('push', 'completed', 'success', 7)]);
  assert.equal(calls[0].url, `https://api.example/repos/owner/name/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  assert.equal(calls[0].headers.authorization, 'Bearer token-1');
  for (const status of [401, 403, 404, 500]) {
    await assert.rejects(reads(status, { total_count: 1, workflow_runs: [item] }).read(), new RegExp(`HTTP ${status}`));
  }
  await assert.rejects(reads(200, { total_count: 3, workflow_runs: [item] }).read(), /1 \/ 3/);
  const release = { ...item, id: 99, head_branch: tag };
  assert.equal(await reads(200, release).releaseCreatedAt(), epoch + 7);
  assert.equal(calls.at(-1)?.url, 'https://api.example/repos/owner/name/actions/runs/99');
  for (const mutation of [{ id: 3 }, { head_sha: 'b'.repeat(40) }, { event: 'workflow_dispatch' }, { head_branch: 'main' }]) {
    await assert.rejects(reads(200, { ...release, ...mutation }).releaseCreatedAt(), /不匹配/);
  }
  const ref = { ref: 'refs/heads/main', object: { type: 'commit', sha } };
  assert.equal(await reads(200, ref).isHistorical(), false);
  assert.equal(calls.at(-1)?.url, 'https://api.example/repos/owner/name/git/ref/heads/main');
  assert.equal(await reads(200, { ...ref, object: { type: 'commit', sha: 'b'.repeat(40) } }).isHistorical(), true);
  for (const invalid of [null, {}, { ...ref, ref: 'refs/heads/candidate' }, { ...ref, object: { type: 'tag', sha } }, { ...ref, object: { type: 'commit', sha: '???' } }]) {
    await assert.rejects(reads(200, invalid).isHistorical(), /无法确认/);
  }
});

test('发布门禁：应答不完整或混入别的提交时算读取失败', () => {
  assert.deepEqual(parseRuns({ total_count: 1, workflow_runs: [item] }, sha), [run('push', 'completed', 'success', 7)]);
  assert.deepEqual(parseRuns({ total_count: 1, workflow_runs: [{ ...item, status: 'queued', conclusion: null }] }, sha), [run('push', 'queued', null, 7)]);
  assert.deepEqual(parseRuns({ total_count: 0, workflow_runs: [] }, sha), []);
  assert.throws(() => parseRuns({ total_count: 2, workflow_runs: [item] }, sha), /1 \/ 2/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, head_sha: 'b'.repeat(40) }] }, sha), /不属于/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, head_sha: undefined }] }, sha), /不属于/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, status: undefined }] }, sha), /缺少字段/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, run_attempt: 0 }] }, sha), /缺少字段/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, head_branch: null }] }, sha), /来源/);
  assert.throws(() => parseRuns({ total_count: 1, workflow_runs: [{ ...item, created_at: null }] }, sha), /有效时间/);
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
