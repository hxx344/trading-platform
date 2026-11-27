import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('main reuses successful real service steps only for the same repository, a candidate commit, attempt and systemd runtime', async t => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'tp-ci-plan-'));
  t.after(() => dir.remove());
  const repo = 'owner/platform', sha = 'a'.repeat(40), parent = 'c'.repeat(40);
  const cases = ['migration', 'components', 'execution', 'port', 'topology', 'downgrade', 'reconcile'];
  const candidate = { id: 97, run_attempt: 2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: sha,
    path: '.github/workflows/ci.yml', repository: { full_name: repo }, head_repository: { full_name: repo } };
  const job = (name: string, runtime = 'ubuntu24/X64/255.4-1ubuntu8.12', commit = sha) => ({ name: `platform-systemd (${name})`, run_id: 97, run_attempt: 2, head_sha: commit,
    status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04'],
    steps: [{ name: `Verify real systemd (${runtime})`, status: 'completed', conclusion: 'success' }] });
  let runs: Record<string, object> = { [sha]: structuredClone(candidate) }, jobs = cases.map(name => job(name)), available = true;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); calls.push(url.pathname);
    if (!available) { res.writeHead(503).end(); return; }
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
    if (url.pathname === `/repos/${repo}/actions/workflows/ci.yml/runs`) {
      const run = runs[url.searchParams.get('head_sha') ?? ''];
      res.end(JSON.stringify({ workflow_runs: run ? [run] : [] }));
    } else if (url.pathname === `/repos/${repo}/actions/runs/97/attempts/2/jobs`) res.end(JSON.stringify({ jobs }));
    else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const api = `http://127.0.0.1:${address.port}`;
  const output = join(dir.path, 'outputs'), summary = join(dir.path, 'summary');
  async function plan(env = {}) {
    writeFileSync(output, ''); writeFileSync(summary, ''); calls.length = 0;
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/ci-systemd.mjs', import.meta.url))], { env: {
      ...process.env, GITHUB_API_URL: api, GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: 'fixture-token', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', AFFECTED: 'true', ImageOS: 'ubuntu24', SYSTEMD_VERSION: '255.4-1ubuntu8.12', RUNNER_ARCH: 'X64',
      CANDIDATES: sha, ...env,
    } });
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(JSON.parse(values.scenarios), cases);
    return values.run;
  }
  assert.equal(await plan(), 'false'); assert.match(readFileSync(summary, 'utf8'), /actions\/runs\/97/);
  assert.equal(await plan({ CANDIDATES: '' }), 'false');
  jobs.pop(); assert.equal(await plan(), 'true');
  for (const change of [
    { steps: [{ ...job('reconcile').steps[0], conclusion: 'skipped' }] }, { run_attempt: 1 }, { head_sha: 'b'.repeat(40) }, { conclusion: 'failure' },
    job('reconcile', 'ubuntu24/X64/256.1-1ubuntu1'), job('reconcile', 'ubuntu24/ARM64/255.4-1ubuntu8.12'), job('reconcile', 'ubuntu26/X64/255.4-1ubuntu8.12'),
    { steps: [{ ...job('reconcile').steps[0], name: 'Verify real systemd (ubuntu24/X64/255.4-1ubuntu8.12) again' }] },
  ]) {
    jobs = [...cases.slice(0, -1).map(name => job(name)), { ...job('reconcile'), ...change }];
    assert.equal(await plan(), 'true');
  }
  // One matrix lands on image builds with different Ubuntu patch revisions of the same upstream systemd.
  jobs = [...cases.slice(0, -1).map(name => job(name)), job('reconcile', 'ubuntu24/X64/255.4-1ubuntu8.13')];
  assert.equal(await plan(), 'false'); assert.match(readFileSync(summary, 'utf8'), /255\.4-1ubuntu8\.12 与 255\.4-1ubuntu8\.13/);
  jobs = cases.map(name => job(name));
  assert.equal(await plan({ ImageVersion: 'another-hosted-image-build' }), 'false');
  assert.equal(await plan({ SYSTEMD_VERSION: '255.4-1ubuntu8.13' }), 'false');
  for (const change of [{ SYSTEMD_VERSION: '256.1-1ubuntu8.12' }, { SYSTEMD_VERSION: '' }, { RUNNER_ARCH: 'ARM64' }, { ImageOS: 'ubuntu26' }]) {
    assert.equal(await plan(change), 'true');
  }
  for (const change of [{ head_repository: { full_name: 'other/platform' } }, { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { conclusion: 'failure' }]) {
    runs = { [sha]: { ...candidate, ...change } }; assert.equal(await plan(), 'true');
  }
  // The manual run sits on the parent of a release commit. It counts only when the plan job listed that parent.
  runs = { [parent]: { ...candidate, head_sha: parent } }; jobs = cases.map(name => job(name, undefined, parent));
  assert.equal(await plan(), 'true');
  assert.equal(await plan({ CANDIDATES: `${sha} ${parent}` }), 'false');
  assert.match(readFileSync(summary, 'utf8'), /提交 cccccccccccc 的 7 组.*本次提交 aaaaaaaaaaaa 相对它没有改动部署及进程边界.*actions\/runs\/97/);
  jobs = cases.map(name => job(name));
  assert.equal(await plan({ CANDIDATES: `${sha} ${parent}` }), 'true');
  for (const list of [`${parent} ${sha}`, `${sha} not-a-commit`]) {
    assert.equal(await plan({ CANDIDATES: list }), 'true'); assert.deepEqual(calls, []);
  }
  runs = { [sha]: candidate }; available = false; assert.equal(await plan(), 'true');
  for (const event of ['workflow_dispatch', 'pull_request']) {
    assert.equal(await plan({ GITHUB_EVENT_NAME: event }), 'true'); assert.deepEqual(calls, []);
  }
  assert.equal(await plan({ GITHUB_EVENT_NAME: 'workflow_dispatch', AFFECTED: 'false' }), 'true'); assert.deepEqual(calls, []);
  assert.equal(await plan({ AFFECTED: 'false' }), 'false'); assert.deepEqual(calls, []);
});
