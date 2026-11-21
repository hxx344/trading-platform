import { chmodSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readComponentBuild } from '../component-build.ts';
import { createBookOperations } from './books.ts';
import { createMonitorData } from './monitor-data.ts';
import { createOptionData } from './options-data.ts';
import { createVenueFeeds } from './venue-feeds.ts';
import { createMarketServer } from './server.ts';
import { installCrashGuard } from '../crash-guard.ts';

function main(): void {
  const { values } = parseArgs({ options: { socket: { type: 'string' } } });
  if (!values.socket || !isAbsolute(values.socket)) throw new Error('需要绝对路径 --socket');
  const socket = values.socket;
  const build = readComponentBuild(fileURLToPath(new URL('../..', import.meta.url)), 'market');
  const venues = createVenueFeeds();
  const service = createMarketServer({ books: createBookOperations(), options: createOptionData(), monitor: createMonitorData(), ondo: venues, crossex: venues }, build);
  const fail = (error: Error) => { process.stderr.write(`行情服务监听失败：${error.message}\n`); process.exitCode = 1; service.close(); };
  service.server.on('error', fail);
  service.server.listen({ path: socket }, () => {
    try { if (process.platform !== 'win32') chmodSync(socket, 0o660); }
    catch (error) { fail(error as Error); return; }
    process.stdout.write('公开行情服务已就绪\n');
  });
  process.once('SIGTERM', service.close);
  process.once('SIGINT', service.close);
}

if (import.meta.main) {
  installCrashGuard('行情服务');
  try { main(); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : '行情服务启动失败'}\n`); process.exitCode = 1; }
}
