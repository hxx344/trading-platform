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
# The Lighter signer (WASM) is compiled from pinned sources, never committed; it ships with src/ and src/varlighter/lighter-signer.ts
# checks both files against src/varlighter/signer/SHA256SUMS before loading them.
for signer in lighter-signer.wasm wasm_exec.js; do
  [[ -f "$root/src/varlighter/signer/$signer" ]] || { echo "缺少 src/varlighter/signer/$signer：先运行 bash scripts/build-lighter-signer.sh" >&2; exit 1; }
done
mkdir -p "$pkg/deploy" "$pkg/web" "$pkg/scripts" "$out"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$pkg/"
# The Var helpers run as `python3 -I -B <release>/scripts/variational-*.py` (src/asset/sources/variational-python.ts and
# src/monitor/variational-transport.ts find them relative to their own files); import-workbook.py is the workbook converter
# the asset page's import panel names (A-6, run by hand on a computer with openpyxl, never by the service); the other
# scripts are development tools and stay out of the package.
cp "$root/scripts/variational-balance.py" "$root/scripts/variational-request.py" "$root/scripts/import-workbook.py" "$pkg/scripts/"
cp -R "$root/web/dist" "$pkg/web/"
cp "$root/deploy/trading-platform.service" "$root/deploy/trading-platform-control.service" "$root/deploy/trading-platform-market.service" "$root/deploy/trading-platform-dex.service" "$root/deploy/trading-platform-import.service" "$root/deploy/trading-platform-import.path" "$root/deploy/trading-platform-update.service" "$root/deploy/trading-platform-update.path" "$root/deploy/config.example.json" "$root/deploy/secrets.example.json" "$pkg/deploy/"
printf 'v%s %s\n' "$version" "$commit" >"$pkg/VERSION"
node "$root/deploy/component-digests.mjs" "$pkg"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' -C "$stage" -cf - trading-platform \
  | gzip -n -9 >"$out/trading-platform.tar.gz"
cp "$root/deploy/install.sh" "$out/install.sh"
# The second server's watchdog (docs/watch.md) is installed from these two release files, checked against SHA256SUMS.
cp "$root/deploy/install-watch.sh" "$out/install-watch.sh"
cp "$root/deploy/main-watch/main_watch.py" "$out/main_watch.py"
(cd "$out" && sha256sum trading-platform.tar.gz install.sh install-watch.sh main_watch.py >SHA256SUMS)
printf '%s\n' "$out"
