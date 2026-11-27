import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempDisposableSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('main reuses successful real service steps only for the same repository, an identical commit, attempt and systemd runtime', async t => {
  const dir = mkdtempDisposableSync(join(tmpdir(), 'tp-ci-plan-'));
  t.after(() => dir.remove());
  const repo = 'owner/platform', sha = 'a'.repeat(40);
  const cases = ['migration', 'components', 'execution', 'port', 'topology', 'downgrade', 'reconcile'];
  const candidate = { id: 97, run_attempt: 2, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', head_sha: sha,
    path: '.github/workflows/ci.yml', repository: { full_name: repo }, head_repository: { full_name: repo } };
  const job = (name: string, runtime = 'ubuntu24/X64/255.4-1ubuntu8.12', commit = sha) => ({ name: `platform-systemd (${name})`, run_id: 97, run_attempt: 2, head_sha: commit,
    status: 'completed', conclusion: 'success', labels: ['ubuntu-24.04'],
    steps: [{ name: `Verify real systemd (${runtime})`, status: 'completed', conclusion: 'success' }] });
  let runs: Record<string, object> = { [sha]: structuredClone(candidate) }, jobs = cases.map(name => job(name)), available = true, unreadable = '';
  const calls: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost'); calls.push(url.pathname);
    const commit = url.searchParams.get('head_sha') ?? '';
    if (!available || (unreadable && commit === unreadable)) { res.writeHead(503).end(); return; }
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
    if (url.pathname === `/repos/${repo}/actions/workflows/ci.yml/runs`) res.end(JSON.stringify({ workflow_runs: runs[commit] ? [runs[commit]] : [] }));
    else if (url.pathname === `/repos/${repo}/actions/runs/97/attempts/2/jobs`) res.end(JSON.stringify({ jobs }));
    else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const api = `http://127.0.0.1:${address.port}`;
  const output = join(dir.path, 'outputs'), summary = join(dir.path, 'summary');
  const outside = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  async function plan(env = {}, cwd?: string) {
    writeFileSync(output, ''); writeFileSync(summary, ''); calls.length = 0;
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../scripts/ci-systemd.mjs', import.meta.url))], { cwd, env: {
      ...outside, GITHUB_API_URL: api, GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: 'fixture-token', GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', AFFECTED: 'true', ImageOS: 'ubuntu24', SYSTEMD_VERSION: '255.4-1ubuntu8.12', RUNNER_ARCH: 'X64', ...env,
    } });
    const values = Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')));
    assert.deepEqual(JSON.parse(values.scenarios), cases);
    return values.run;
  }
  assert.equal(await plan(), 'false'); assert.match(readFileSync(summary, 'utf8'), /actions\/runs\/97/);
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
  runs = { [sha]: candidate }; available = false; assert.equal(await plan(), 'true');
  for (const event of ['workflow_dispatch', 'pull_request']) {
    assert.equal(await plan({ GITHUB_EVENT_NAME: event }), 'true'); assert.deepEqual(calls, []);
  }
  assert.equal(await plan({ GITHUB_EVENT_NAME: 'workflow_dispatch', AFFECTED: 'false' }), 'true'); assert.deepEqual(calls, []);
  assert.equal(await plan({ AFFECTED: 'false' }), 'false'); assert.deepEqual(calls, []);
  available = true;

  // The manual run of a release sits on the parent of the release commit, which only bumps the version.
  const work = join(dir.path, 'repo');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', ...args], { cwd: work, env: outside, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  execFileSync('git', ['init', '-q', work], { env: outside });
  let version = 0, start = 'node main.js';
  function commit(files: Record<string, string> = {}, scripts = start) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(work, name), content);
    start = scripts;
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'fixture', version: `0.0.${++version}`, scripts: { start: scripts } }));
    git('add', '-A'); git('commit', '-q', '-m', `v${version}`);
    return git('rev-parse', 'HEAD');
  }
  async function reuse(head: string, verifiedCommit: string) {
    runs = { [verifiedCommit]: { ...candidate, head_sha: verifiedCommit } }; jobs = cases.map(name => job(name, undefined, verifiedCommit));
    return plan({ GITHUB_SHA: head }, work);
  }
  const code = commit({ 'main.js': '1' }), release = commit(), second = commit();
  assert.equal(await reuse(release, code), 'false');
  assert.match(readFileSync(summary, 'utf8'), new RegExp(`提交 ${code.slice(0, 12)} 的 7 组.*本次提交 ${release.slice(0, 12)} 相对它只改了 package.json 的版本号.*actions/runs/97`));
  assert.equal(await reuse(second, code), 'false');
  // The first candidate has no run and the second cannot be read: run again.
  unreadable = release; assert.equal(await reuse(second, code), 'true'); unreadable = '';
  // Any other file, any other manifest field, or a version-only commit behind such a change ends the walk.
  const source = commit({ 'main.js': '2' });
  assert.equal(await reuse(source, second), 'true');
  const scripts = commit({}, 'node other.js');
  assert.equal(await reuse(scripts, source), 'true');
  const renamed = (git('mv', 'main.js', 'moved.js'), commit());
  assert.equal(await reuse(renamed, scripts), 'true');
  const after = commit();
  assert.equal(await reuse(after, scripts), 'true');
  assert.equal(await reuse(after, renamed), 'false');
  // Only the first parent counts, and only the five nearest ancestors.
  // The merge result equals its second parent, but the first parent lacks other.js.
  git('checkout', '-q', '-b', 'side', after); const side = commit({ 'other.js': '1' });
  git('checkout', '-q', '-'); git('merge', '-q', '--no-ff', '-m', 'merge', 'side');
  const merged = git('rev-parse', 'HEAD');
  assert.equal(git('diff', '--name-only', side, merged), '');
  assert.equal(await reuse(merged, side), 'true');
  const base = commit({ 'main2.js': '1' });
  let head = base; for (let i = 0; i < 5; i++) head = commit();
  assert.equal(await reuse(head, base), 'false');
  assert.equal(await reuse(commit(), base), 'true');
});
