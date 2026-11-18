import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { get } from 'node:http';
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { parseListenConfig } from '../service/listen-config.ts';
import { readInstalledVersion, type InstalledVersion } from '../service/update.ts';

export const PROBE_HEADER = 'x-trading-platform-probe';

/** Binds a loopback health response to this request, the loaded page release and the running control code. */
export function probeResponse(challenge: string, controlBuild: string, root: string, version: InstalledVersion): string {
  return createHash('sha256').update(JSON.stringify([challenge, controlBuild, root, version.version, version.commit])).digest('hex');
}

async function probe(): Promise<void> {
  const { values } = parseArgs({ options: { current: { type: 'string' }, 'listen-file': { type: 'string' } } });
  if (!values.current || !values['listen-file']) throw new Error('需要 --current 和 --listen-file');
  const { port } = parseListenConfig(JSON.parse(readFileSync(values['listen-file'], 'utf8')));
  const root = realpathSync(values.current);
  const challenge = randomBytes(24).toString('hex');
  const expected = probeResponse(challenge, readComponentBuild(root, 'control'), root, readInstalledVersion(root));
  // Use a direct loopback request even when the service's outbound GitHub/venue traffic uses a proxy.
  await new Promise<void>((resolve, reject) => {
    const req = get({ hostname: '127.0.0.1', port, path: '/api/ready', agent: false, headers: { [PROBE_HEADER]: challenge },
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
        if (res.headers[PROBE_HEADER] === expected && ((res.statusCode === 200 && body === '{"ready":true}') ||
            (res.statusCode === 503 && body === '{"ready":false}'))) resolve();
        else reject(new Error('页面、控制面或执行面尚未切换到目标版本'));
      });
    });
    req.on('error', reject);
  });
}

if (import.meta.main) probe().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
