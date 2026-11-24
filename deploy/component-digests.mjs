// Fingerprint the sources actually run by each installed unit. Node strips TS type imports before the resolver sees them.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2]);
const packagePath = file => relative(root, file).split(sep).join('/');
const imports = new Map();
const entries = { executor: 'src/service/main.ts', control: 'src/control/main.ts', market: 'src/market/main.ts' };
const hooks = registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.startsWith('file:')) {
    const child = packagePath(fileURLToPath(resolved.url));
    if (!child.startsWith('src/')) throw new Error('组件运行依赖不在程序包 src 中：' + child);
    const parent = context.parentURL?.startsWith('file:') ? packagePath(fileURLToPath(context.parentURL)) : undefined;
    if (!imports.has(parent)) imports.set(parent, new Set());
    imports.get(parent).add(child);
  }
  return resolved;
} });
for (const entry of Object.values(entries)) await import(pathToFileURL(join(root, entry)));
hooks.deregister();

// These imports provide the in-process readers for a checkout or simulation. In the installed executor those
// call sites always receive the market IPC implementation. Any other importer still adds the file and its children.
const localReaders = new Map([
  ['src/monitor/anthropic.ts', ['src/monitor/market-readers.ts']],
  ['src/monitor/hynix.ts', ['src/monitor/market-readers.ts']],
  ['src/monitor/oil.ts', ['src/monitor/market-readers.ts']],
  ['src/monitor/perpetual.ts', ['src/monitor/perpetual-feed.ts', 'src/vendor/perpetual-depth.mjs',
    'src/vendor/perpetual-price-reader.mjs', 'src/vendor/perpetual-funding-reader.mjs', 'src/vendor/perpetual-fundamentals.mjs']],
  ['src/vendor/perpetual-price-history-service.mjs', ['src/vendor/perpetual-price-reader.mjs']],
  ['src/vendor/perpetual-funding-history-service.mjs', ['src/vendor/perpetual-funding-reader.mjs']],
  ['src/vendor/perpetual-quality-service.mjs', ['src/vendor/perpetual-fundamentals.mjs']],
  ['src/vendor/crossex/terminal-market.mjs', ['src/vendor/crossex/terminal-feed.mjs', 'src/vendor/crossex/candle-reader.mjs']],
  ['src/vendor/crossex/market.mjs', ['src/vendor/crossex/funding-client.mjs']],
  ['src/vendor/crossex/clients.mjs', ['src/vendor/crossex/depth-reader.mjs']],
]);
function reachable(entry, installedExecutor = false) {
  const files = new Set([entry]);
  for (const parent of files) {
    for (const child of imports.get(parent) ?? []) {
      if (!installedExecutor || !localReaders.get(parent)?.includes(child)) files.add(child);
    }
  }
  return files;
}
const executor = reachable(entries.executor, true), control = reachable(entries.control), market = reachable(entries.market);
// Helpers run at import/installation time. The execution API's import-channel is a runtime dependency.
const helperOnly = new Set(['update-helper', 'take-handoff', 'watch-config', 'mev-setup', 'import-helper', 'import-workbench',
  'import-modules', 'import-options', 'import-crossex', 'import-ondo', 'import-monitor-alerts',
  'import-monitor-variational', 'import-monitor-paper'].map(name => 'src/service/' + name + '.ts'));
helperOnly.add('src/market/probe.ts');
for (const entry of readdirSync(join(root, 'src'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || /\.d\.(?:ts|mts|cts)$/.test(entry.name)) continue;
  const path = packagePath(join(entry.parentPath, entry.name));
  if (path.startsWith('src/control/') || ['src/web-assets.ts', 'src/service/update.ts', 'src/service/update-types.ts'].includes(path)) control.add(path);
  // Preserve the conservative executor default for sources whose runtime owner is unknown.
  else if (!market.has(path) && !helperOnly.has(path)) executor.add(path);
}
executor.add('scripts/variational-balance.py');
executor.add('scripts/variational-request.py');
if (market.has('src/monitor/variational-transport.ts')) market.add('scripts/variational-request.py');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtime = ['name', 'type', 'main', 'imports', 'exports', 'dependencies', 'optionalDependencies', 'engines'].map(key => [key, pkg[key]]);
for (const [name, files] of Object.entries({ control, executor, market })) {
  const hash = createHash('sha256').update(JSON.stringify(runtime) + '\n');
  for (const path of [...files].sort()) {
    hash.update(path + '\0').update(createHash('sha256').update(readFileSync(join(root, path))).digest());
  }
  writeFileSync(join(root, '.' + name + '-sha256'), hash.digest('hex') + '\n');
}
