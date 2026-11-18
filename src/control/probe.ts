import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { get, type IncomingHttpHeaders, type RequestOptions } from 'node:http';
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { CONFIG_CHECK_HEADER, CONFIG_MATCH_HEADER, EXECUTION_HEADER } from '../http-public.ts';
import { parseListenConfig } from '../service/listen-config.ts';
import { readInstalledVersion, type InstalledVersion } from '../service/update.ts';

export const PROBE_HEADER = 'x-trading-platform-probe';

/** Binds a loopback health response to this request, the loaded page release and the running control code. */
export function probeResponse(challenge: string, controlBuild: string, root: string, version: InstalledVersion): string {
  return createHash('sha256').update(JSON.stringify([challenge, controlBuild, root, version.version, version.commit])).digest('hex');
}

function readyHeaders(options: RequestOptions): Promise<IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const req = get({ ...options, path: '/api/ready', agent: false,
      signal: AbortSignal.timeout(2500) }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('error', reject);
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > 128) res.destroy(new Error('就绪应答过大'));
      });
      res.on('end', () => {
        // The execution loops can still be warming up. Both answers must come through the expected components.
        if ((res.statusCode === 200 && body === '{"ready":true}') || (res.statusCode === 503 && body === '{"ready":false}')) resolve(res.headers);
        else reject(new Error('执行器没有返回目标版本的就绪状态'));
      });
    });
    req.on('error', reject);
  });
}

async function probe(): Promise<void> {
  const { values } = parseArgs({ options: { current: { type: 'string' }, 'listen-file': { type: 'string' }, socket: { type: 'string' }, 'config-check': { type: 'string' } } });
  if (!values.current) throw new Error('需要 --current');
  const root = realpathSync(values.current);
  if (values.socket && values['config-check'] && /^[a-f0-9]{64}$/.test(values['config-check'])) {
    const build = readComponentBuild(root, 'executor');
    const headers = await readyHeaders({ socketPath: values.socket, headers: { host: 'localhost', [EXECUTION_HEADER]: build, [CONFIG_CHECK_HEADER]: values['config-check'] } });
    if (headers[EXECUTION_HEADER] !== build || !['0', '1'].includes(String(headers[CONFIG_MATCH_HEADER]))) throw new Error('无法核对执行器生效配置');
    if (headers[CONFIG_MATCH_HEADER] === '0') process.exitCode = 3;
    return;
  }
  if (!values['listen-file'] || values.socket || values['config-check']) throw new Error('需要 --listen-file，或 --socket 与 --config-check');
  const { port } = parseListenConfig(JSON.parse(readFileSync(values['listen-file'], 'utf8')));
  const challenge = randomBytes(24).toString('hex');
  const expected = probeResponse(challenge, readComponentBuild(root, 'control'), root, readInstalledVersion(root));
  const headers = await readyHeaders({ hostname: '127.0.0.1', port, headers: { [PROBE_HEADER]: challenge } });
  if (headers[PROBE_HEADER] !== expected) throw new Error('页面、控制面或执行面尚未切换到目标版本');
}

if (import.meta.main) probe().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
