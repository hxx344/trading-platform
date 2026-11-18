#!/usr/bin/env bash
# Builds the release files: trading-platform.tar.gz, install.sh, install-watch.sh, main_watch.py and SHA256SUMS in the
# output directory (default dist/).
# The archive is deterministic (sorted names, fixed times and owners, gzip without a timestamp), so the same sources
# and commit give the same checksum and the installer can tell from SHA256SUMS alone whether anything changed.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/dist}
version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$root/package.json")
commit=$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
pkg="$stage/trading-platform"
# The page is built beforehand (pnpm build:web); a package without it would fail its config check on the server.
[[ -f "$root/web/dist/index.html" ]] || { echo "缺少 web/dist/index.html：先运行 pnpm build:web" >&2; exit 1; }
mkdir -p "$pkg/deploy" "$pkg/web" "$pkg/scripts" "$out"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$pkg/"
# The Var helpers run as `python3 -I -B <release>/scripts/variational-*.py` (src/asset/sources/variational-python.ts and
# src/monitor/variational-transport.ts find them relative to their own files); import-workbook.py is the workbook converter
# the asset page's import panel names (A-6, run by hand on a computer with openpyxl, never by the service); the other
# scripts are development tools and stay out of the package.
cp "$root/scripts/variational-balance.py" "$root/scripts/variational-request.py" "$root/scripts/import-workbook.py" "$pkg/scripts/"
cp -R "$root/web/dist" "$pkg/web/"
cp "$root/deploy/trading-platform.service" "$root/deploy/trading-platform-control.service" "$root/deploy/trading-platform-import.service" "$root/deploy/trading-platform-import.path" "$root/deploy/trading-platform-update.service" "$root/deploy/trading-platform-update.path" "$root/deploy/config.example.json" "$root/deploy/secrets.example.json" "$pkg/deploy/"
printf 'v%s %s\n' "$version" "$commit" >"$pkg/VERSION"
# Both processes run Node directly from the package. Include shared imports in the control digest, even when the
# dependency is several imports away. Unknown source files belong to the executor unless explicitly control-only.
(cd "$pkg" && node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.cwd();
const packagePath = file => relative(root, file).split(sep).join('/');
const control = new Set();
const executor = new Set();
// These programs are launched by root or the install CLI. The live executor imports import-channel for its API.
const helperOnly = new Set(['update-helper', 'watch-config', 'import-helper', 'import-workbench',
  'import-modules', 'import-options', 'import-crossex', 'import-ondo', 'import-monitor-alerts',
  'import-monitor-variational', 'import-monitor-paper'].map(name => 'src/service/' + name + '.ts'));
const hooks = registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.startsWith('file:')) {
    const path = packagePath(fileURLToPath(resolved.url));
    if (!path.startsWith('src/')) throw new Error('控制面运行依赖不在程序包 src 中：' + path);
    control.add(path);
  }
  return resolved;
} });
await import(pathToFileURL(root + '/src/control/main.ts'));
hooks.deregister();
for (const entry of readdirSync('src', { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const path = packagePath(entry.parentPath + '/' + entry.name);
  if (path.startsWith('src/control/') || ['src/web-assets.ts', 'src/service/update.ts', 'src/service/update-types.ts'].includes(path)) control.add(path);
  else if (!helperOnly.has(path)) executor.add(path);
}
for (const path of ['scripts/variational-balance.py', 'scripts/variational-request.py']) executor.add(path);
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const runtime = ['name', 'type', 'main', 'imports', 'exports', 'dependencies', 'optionalDependencies', 'engines'].map(k => [k, pkg[k]]);
for (const [name, files] of Object.entries({ control, executor })) {
  const hash = createHash('sha256').update(JSON.stringify(runtime) + '\n');
  for (const path of [...files].sort()) {
    hash.update(path + '\0').update(createHash('sha256').update(readFileSync(path)).digest());
  }
  writeFileSync('.' + name + '-sha256', hash.digest('hex') + '\n');
}
JS
)
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' -C "$stage" -cf - trading-platform \
  | gzip -n -9 >"$out/trading-platform.tar.gz"
cp "$root/deploy/install.sh" "$out/install.sh"
# The second server's watchdog (docs/watch.md) is installed from these two release files, checked against SHA256SUMS.
cp "$root/deploy/install-watch.sh" "$out/install-watch.sh"
cp "$root/deploy/main-watch/main_watch.py" "$out/main_watch.py"
(cd "$out" && sha256sum trading-platform.tar.gz install.sh install-watch.sh main_watch.py >SHA256SUMS)
printf '%s\n' "$out"
