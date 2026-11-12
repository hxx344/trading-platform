#!/usr/bin/env bash
# Builds the release files: trading-platform.tar.gz, install.sh and SHA256SUMS in the output directory (default dist/).
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
mkdir -p "$pkg/deploy" "$out"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$pkg/"
cp "$root/deploy/trading-platform.service" "$root/deploy/trading-platform-import.service" "$root/deploy/trading-platform-import.path" "$root/deploy/config.example.json" "$root/deploy/secrets.example.json" "$pkg/deploy/"
printf 'v%s %s\n' "$version" "$commit" >"$pkg/VERSION"
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner --mode='u+rwX,go+rX,go-w' -C "$stage" -cf - trading-platform \
  | gzip -n -9 >"$out/trading-platform.tar.gz"
cp "$root/deploy/install.sh" "$out/install.sh"
(cd "$out" && sha256sum trading-platform.tar.gz install.sh >SHA256SUMS)
printf '%s\n' "$out"
