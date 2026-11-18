#!/usr/bin/env bash
# Actual systemd services, public HTTP and a single private writer, in the empty GitHub-hosted Linux runner only.
set -Eeuo pipefail
[[ ${TP_PLATFORM_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 && $(cat /proc/1/comm) == systemd ]] ||
  { echo 'Requires a disposable GitHub Linux runner with systemd as PID 1.' >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd -P)
app=/opt/trading-platform
conf=/etc/trading-platform
data=/var/lib/trading-platform
handoff=/var/lib/trading-platform-import
unitdir=/etc/systemd/system
service=trading-platform
control=trading-platform-control
units=("$service.service" "$control.service" "$service-import.path" "$service-import.service" "$service-update.path" "$service-update.service")
for path in "$app" "$conf" "$data" "$handoff" /run/trading-platform "${units[@]/#/$unitdir/}"; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Fixture target already exists: $path" >&2; exit 1; }
done
if getent passwd "$service" >/dev/null || getent group "$service" >/dev/null; then echo 'Fixture account already exists' >&2; exit 1; fi
fixture=$(mktemp -d /opt/trading-platform-ci-XXXXXXXX)
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then
    [[ ! -f "$fixture/out" ]] || tail -n 20 "$fixture/out"
    journalctl -u "$service" -u "$control" --no-pager -n 40 || true
  fi
  systemctl disable --now "$service-update.path" "$service-import.path" "$control" "$service" >/dev/null 2>&1 || true
  rm -f "${units[@]/#/$unitdir/}"
  systemctl daemon-reload || true
  userdel "$service" >/dev/null 2>&1 || true
  groupdel "$service" >/dev/null 2>&1 || true
  rm -rf "$app" "$conf" "$data" "$handoff" "$fixture"
  exit "$result"
}
trap cleanup EXIT
umask 022
mkdir "$fixture/old" "$fixture/source"
# The genuine last single-process release and its verified installer establish the migration baseline.
old="$fixture/old"
for asset in SHA256SUMS trading-platform.tar.gz install.sh; do
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 180 \
    "https://github.com/hxx344/trading-platform/releases/download/v0.63.0/$asset" -o "$old/$asset"
done
(cd "$old" && awk '$2 == "install.sh" || $2 == "trading-platform.tar.gz"' SHA256SUMS >required && [[ $(wc -l <required) == 2 ]] && sha256sum -c --quiet required)
bash "$old/install.sh" --package "$old" >"$fixture/out" 2>&1
pid() { local value; value=$(systemctl show -p MainPID --value "$1"); [[ "$value" =~ ^[1-9][0-9]*$ ]] && printf '%s\n' "$value"; }
legacy_pid=$(pid "$service")
[[ ! -e "$unitdir/$control.service" ]]
# Build all candidates with the production packager. Their independently changed files exercise component selection.
source="$fixture/source"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$root/deploy" "$root/scripts" "$source/"
mkdir "$source/web"
cp -R "$root/web/dist" "$source/web/"
build() {
  node -e 'const fs = require("fs"), file=process.argv[1], pkg=JSON.parse(fs.readFileSync(file)); pkg.version=process.argv[2]; fs.writeFileSync(file, JSON.stringify(pkg));' "$source/package.json" "99.1.$1"
  bash "$source/deploy/package.sh" "$fixture/release-$1" >/dev/null
}
install_release() { bash "$root/deploy/install.sh" --package "$fixture/release-$1" >"$fixture/out" 2>&1; }
public_port=4720
url() { printf 'http://127.0.0.1:%s%s' "$public_port" "$1"; }
login() {
  local link
  link=$(tail -n1 "$data/access-url")
  [[ "$link" == "$(url '/login?token=')"* ]]
  curl --noproxy '*' --fail --silent --show-error --max-time 3 -c "$fixture/cookie" -o /dev/null "$link"
}
assert_page() {
  local body
  body=$(curl --noproxy '*' -fsS --max-time 3 -b "$fixture/cookie" "$(url /api/update)")
  node -e 'const actual = JSON.parse(process.argv[1]).current; if (!actual.packaged || actual.version !== process.argv[2]) process.exit(1)' "$body" "$1"
  curl --noproxy '*' -fsS --max-time 3 -b "$fixture/cookie" "$(url /)" >"$fixture/index"
  cmp -s "$fixture/index" "$app/current/web/dist/index.html"
}
build 1
echo 'Migrating the genuine single writer to the private socket and the browser service'
install_release 1
executor_pid=$(pid "$service")
control_pid=$(pid "$control")
[[ "$executor_pid" != "$legacy_pid" && -S /run/trading-platform/execution.sock && $(stat -c %a /run/trading-platform) == 700 ]]
[[ ! -e "/proc/$control_pid/root$conf/config.json" && ! -e "/proc/$control_pid/root$data/access-url" ]]
systemctl is-enabled --quiet "$control"
[[ -e "$app/.update-helper" ]]
login
assert_page v99.1.1

echo 'Page and version changes preserve both real processes, cookies and their pinned packages across cleanup'
first_executor=$(readlink "$app/executor")
first_control=$(readlink "$app/control")
for version in 2 3 4 5; do
  printf '\n<!-- simulated page release %s -->\n' "$version" >>"$source/web/dist/index.html"
  build "$version"
  install_release "$version"
  [[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" && -f "$first_executor/src/service/main.ts" && -f "$first_control/src/control/main.ts" ]]
  assert_page "v99.1.$version"
done

echo 'Control code changes restart only the browser service; a repeat is a healthy no-op'
printf '\nif (import.meta.main) console.info("模拟控制面升级");\n' >>"$source/src/control/main.ts"
build 6
install_release 6
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") != "$control_pid" ]]
control_pid=$(pid "$control")
assert_page v99.1.6
install_release 6
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" ]]
grep -q '无变化' "$fixture/out"

echo 'A control activation that exits keeps the execution PID and restores the known-good page and control code'
cp "$source/src/control/main.ts" "$fixture/good-control"
sed -i '1i if (import.meta.main) throw new Error("模拟控制面启动失败");' "$source/src/control/main.ts"
build 7
if install_release 7; then echo 'Broken control accepted' >&2; exit 1; fi
grep -q '已回退到 v99.1.6 并确认运行正常' "$fixture/out"
[[ $(pid "$service") == "$executor_pid" ]]
assert_page v99.1.6
control_pid=$(pid "$control")
cp "$fixture/good-control" "$source/src/control/main.ts"

echo 'An executor-only upgrade restarts one writer, keeps the control PID and preserves stored sessions'
printf '\nif (import.meta.main && !process.argv.includes("--check-config")) console.info("模拟执行面升级");\n' >>"$source/src/service/main.ts"
build 8
install_release 8
[[ $(pid "$service") != "$executor_pid" && $(pid "$control") == "$control_pid" ]]
executor_pid=$(pid "$service")
assert_page v99.1.8

echo 'Failed execution code rolls back in order and still serves the last good release'
sed -i '1i if (import.meta.main && !process.argv.includes("--check-config")) throw new Error("模拟执行面启动失败");' "$source/src/service/main.ts"
build 9
if install_release 9; then echo 'Broken execution accepted' >&2; exit 1; fi
grep -q '已回退到 v99.1.8 并确认运行正常' "$fixture/out"
[[ $(pid "$service") != "$executor_pid" && $(pid "$control") == "$control_pid" ]]
assert_page v99.1.8

echo 'Changing the public port updates both effective configurations and repeated installation can repair a stopped unit'
public_port=14720
node -e 'const fs = require("fs"), file = process.argv[1], c = JSON.parse(fs.readFileSync(file)); c.port=Number(process.argv[2]); fs.writeFileSync(file, JSON.stringify(c));' "$conf/config.json" "$public_port"
printf '%s\n' 'NODE_USE_ENV_PROXY=1' 'NO_PROXY=127.0.0.1' 'CI_EXECUTION_ONLY=marker' >"$conf/environment"
install_release 8
login
assert_page v99.1.8
control_pid=$(pid "$control")
tr '\0' '\n' <"/proc/$control_pid/environ" >"$fixture/control-env"
grep -qx 'NODE_USE_ENV_PROXY=1' "$fixture/control-env"
if grep -q CI_EXECUTION_ONLY "$fixture/control-env"; then echo 'Executor environment reached control' >&2; exit 1; fi
executor_pid=$(pid "$service")
systemctl stop "$control"
install_release 8
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") != "$control_pid" ]]
assert_page v99.1.8

echo 'Downgrade frees TCP for the original unit and can migrate forward again'
bash "$root/deploy/install.sh" --package "$old" >"$fixture/out" 2>&1
[[ ! -e "$unitdir/$control.service" && ! -e "$app/control" && ! -e /run/trading-platform/execution.sock ]]
if systemctl is-active --quiet "$control"; then echo 'Control still running on downgrade' >&2; exit 1; fi
login
assert_page v0.63.0
install_release 8
login
assert_page v99.1.8
echo 'Independent activation, rollback and migration passed with real systemd'
