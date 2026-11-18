// Select the real Ubuntu service checks. Only a main push can reuse a manual run of this exact workflow and commit.
import { appendFileSync } from 'node:fs';

const scenarios = ['migration', 'components', 'execution', 'topology', 'reconcile'];
const { GITHUB_API_URL: api, GITHUB_REPOSITORY: repo, GITHUB_SHA: sha, GITHUB_TOKEN: token } = process.env;
// A hosted Ubuntu pool can serve several VM image builds in one matrix. Compare the systemd package actually exercised.
// The exact commit also pins the Node toolchain and dependency lockfile used by all five jobs.
const runtime = [process.env.ImageOS, process.env.RUNNER_ARCH, process.env.SYSTEMD_VERSION];

async function read(path) {
  const response = await fetch(`${api}/repos/${repo}/actions/${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`GitHub Actions HTTP ${response.status}`);
  return response.json();
}

async function verifiedRun() {
  if (!runtime.every(part => part && /^[\w.:+~-]+$/.test(part)) || !token || !/^[a-f0-9]{40}$/.test(sha)) return null;
  const runs = await read(`workflows/ci.yml/runs?event=workflow_dispatch&status=success&head_sha=${sha}&per_page=1`);
  const run = runs.workflow_runs?.[0];
  if (run?.head_sha !== sha || run.path !== '.github/workflows/ci.yml' || run.repository?.full_name !== repo || run.head_repository?.full_name !== repo
    || run.event !== 'workflow_dispatch' || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isSafeInteger(run.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) return null;

  const { jobs } = await read(`runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
  const stepName = `Verify real systemd (${runtime.join('/')})`;
  const passed = new Set(jobs.filter(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === sha
    && job.status === 'completed' && job.conclusion === 'success' && job.labels?.includes('ubuntu-24.04')
    && job.steps?.some(step => step.name === stepName && step.status === 'completed' && step.conclusion === 'success')).map(job => job.name));
  return scenarios.every(scenario => passed.has(`platform-systemd (${scenario})`)) ? run.id : null;
}

const affected = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' || process.env.AFFECTED !== 'false';
let verified = null;
if (affected && process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') {
  try { verified = await verifiedRun(); }
  catch (error) { console.log(`无法核实既有验收，将重新运行：${error.message}`); }
}
const message = verified ? `提交 ${sha.slice(0, 12)} 的五组真实 systemd 验收已在 ${runtime.join('/')} 通过。[候选运行](${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${verified})`
  : affected ? '本次运行将在独立 Ubuntu runner 上执行全部真实 systemd 场景。' : '本次差异未涉及部署及进程边界。';
console.log(message);
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
appendFileSync(process.env.GITHUB_OUTPUT, `run=${affected && !verified}\nscenarios=${JSON.stringify(scenarios)}\n`);
