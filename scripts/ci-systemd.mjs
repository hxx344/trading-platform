// Select the real Ubuntu service checks. Only a main push can reuse a manual run of this exact workflow, on this commit
// or on a candidate commit that the plan job found to have identical deployment inputs.
import { appendFileSync } from 'node:fs';

const scenarios = ['migration', 'components', 'execution', 'port', 'topology', 'downgrade', 'reconcile'];
const { GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: token } = process.env;
// A hosted Ubuntu pool serves several VM image builds in one matrix, and those builds carry different Ubuntu patch
// revisions of the systemd package (255.4-1ubuntu8.18 next to 8.19), so a fresh run mixes them too. Compare the
// distribution, the architecture and the upstream systemd version each step actually exercised.
// The exact commit also pins the Node toolchain and dependency lockfile used by all jobs.
const { ImageOS: os, RUNNER_ARCH: arch, SYSTEMD_VERSION: systemd } = process.env;
const upstream = version => version.includes('-') ? version.slice(0, version.lastIndexOf('-')) : version;
const candidates = [...new Set((process.env.CANDIDATES || sha || '').split(/\s+/).filter(Boolean))].slice(0, 6);

async function read(path) {
  const response = await fetch(`${api}/repos/${repo}/actions/${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`GitHub Actions HTTP ${response.status}`);
  return response.json();
}

async function verifiedRun(commit) {
  const runs = await read(`workflows/ci.yml/runs?event=workflow_dispatch&status=success&head_sha=${commit}&per_page=1`);
  const run = runs.workflow_runs?.[0];
  if (run?.head_sha !== commit || run.path !== '.github/workflows/ci.yml' || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;

  const { jobs } = await read(`runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const passed = new Set(), versions = new Set();
  for (const job of jobs) {
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== commit
      || job.status !== 'completed' || job.conclusion !== 'success' || !job.labels?.includes('ubuntu-24.04')) continue;
    for (const step of job.steps ?? []) {
      const ran = /^Verify real systemd \(([^/()]+)\/([^/()]+)\/([^/()]+)\)$/.exec(step.name);
      if (!ran || step.status !== 'completed' || step.conclusion !== 'success') continue;
      if (ran[1] !== os || ran[2] !== arch || upstream(ran[3]) !== upstream(systemd)) continue;
      passed.add(job.name); versions.add(ran[3]);
    }
  }
  return scenarios.every(scenario => passed.has(`platform-systemd (${scenario})`)) ? { id: run.id, commit, versions: [...versions].sort() } : null;
}

const affected = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || process.env.AFFECTED !== 'false';
let verified = null;
if (affected && process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main'
  && [os, arch, systemd].every(part => part && /^[\w.:+~-]+$/.test(part)) && token && candidates[0] === sha && candidates.every(commit => /^[a-f0-9]{40}$/.test(commit))) {
  try {
    for (const commit of candidates) if ((verified = await verifiedRun(commit))) break;
  } catch (error) { verified = null; console.log(`无法核实既有验收，将重新运行：${error.message}`); }
}
const message = verified ? `提交 ${verified.commit.slice(0, 12)} 的 ${scenarios.length} 组真实 systemd 验收已在 ${os}/${arch}、systemd ${verified.versions.join(' 与 ')} 通过${
    verified.commit === sha ? '' : `，本次提交 ${sha.slice(0, 12)} 相对它没有改动部署及进程边界`}。[候选运行](${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${verified.id})`
  : affected ? '本次运行将在独立 Ubuntu runner 上执行全部真实 systemd 场景。' : '本次差异未涉及部署及进程边界。';
console.log(message);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `run=${affected && !verified}\nscenarios=${JSON.stringify(scenarios)}\n`);
