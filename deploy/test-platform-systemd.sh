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
updates=/var/lib/trading-platform-update
unitdir=/etc/systemd/system
service=trading-platform
control=trading-platform-control
market=trading-platform-market
extra_user=tp-market-ci-extra
market_socket=/run/trading-platform-market/market.sock
units=("$service.service" "$control.service" "$market.service" "$service-import.path" "$service-import.service" "$service-update.path" "$service-update.service")
for path in "$app" "$conf" "$data" "$handoff" "$updates" /run/trading-platform /run/trading-platform-market "$unitdir/$service.service.d" "$unitdir/$market.service.d" "${units[@]/#/$unitdir/}"; do
  [[ ! -e "$path" && ! -L "$path" ]] || { echo "Fixture target already exists: $path" >&2; exit 1; }
done
for account in "$service" "$control" "$service-ipc" "$market" "$market-ipc" "$extra_user"; do
  if getent passwd "$account" >/dev/null || getent group "$account" >/dev/null; then echo 'Fixture account already exists' >&2; exit 1; fi
done
fixture=$(mktemp -d /opt/trading-platform-ci-XXXXXXXX)
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then
    [[ ! -f "$fixture/out" ]] || tail -n 20 "$fixture/out"
    systemctl show "$service-update.path" "$service-update.service" "$service-import.path" "$service-import.service" \
      -p Id -p ActiveState -p SubState -p Result -p ExecMainStatus -p Paths -p Triggers --no-pager || true
    journalctl -u "$service" -u "$control" -u "$market" -u "$service-update.path" -u "$service-update.service" \
      -u "$service-import.path" -u "$service-import.service" --no-pager -n 70 || true
    # Report only file type, owner/mode, the phase and an enumerated reason. Never open links or print a request,
    # access token, updater output array, password, or an arbitrary string written by a service account.
    node --input-type=module - "$updates" "$handoff" <<'JS' || true
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
for (const [dir, files] of [[process.argv[2], ['update-request.json', 'update-result.json']], [process.argv[3], ['request.json', 'result.json']]]) {
  for (const name of files) {
    const path = join(dir, name);
    let fd;
    try {
      const s = lstatSync(path);
      const summary = { path, uid:s.uid, gid:s.gid, mode:(s.mode & 0o7777).toString(8), type:s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other' };
      if (s.isFile() && name.endsWith('result.json')) {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        if (fstatSync(fd).isFile()) {
          const bytes = Buffer.alloc(32769), n = readSync(fd, bytes, 0, bytes.length, 0);
          if (n < bytes.length) {
            const v = JSON.parse(bytes.toString('utf8', 0, n));
            summary.phase = ['running','done','failed'].includes(v.phase) ? v.phase : 'unknown';
            summary.reason = ['请求文件不属于服务账户','不比已装版本','不是普通文件','已过期','中断'].find(r => String(v.message).includes(r)) ?? 'other';
          }
        }
      }
      console.log(summary);
    } catch (e) { console.log(path, e.code ?? 'unreadable'); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
}
JS
  fi
  systemctl disable --now "$service-update.path" "$service-import.path" "$control" "$market" "$service" >/dev/null 2>&1 || true
  rm -f "${units[@]/#/$unitdir/}"
  systemctl daemon-reload || true
  for account in "$extra_user" "$market" "$control" "$service"; do userdel "$account" >/dev/null 2>&1 || true; done
  for group in "$service" "$control" "$service-ipc" "$market" "$market-ipc"; do groupdel "$group" >/dev/null 2>&1 || true; done
  rm -rf "$app" "$conf" "$data" "$handoff" "$updates" "$unitdir/$service.service.d" "$unitdir/$market.service.d" "$fixture"
  exit "$result"
}
trap cleanup EXIT
umask 022
mkdir "$fixture/source"
# The actual page import below enables the observe-only Ondo module using an empty fixture, without any keys.
# Keep the executor on loopback throughout this acceptance, including after its import-triggered restart.
mkdir -p "$fixture/workbench/ondo-mm" "$unitdir/$service.service.d" "$unitdir/$market.service.d"
printf 'DATA_DIR=%s\n' "$fixture/workbench" >"$fixture/workbench.env"
chmod 600 "$fixture/workbench.env"
export TP_WORKBENCH_ENV="$fixture/workbench.env"
printf '[Service]\nIPAddressDeny=any\nIPAddressAllow=localhost\n' >"$unitdir/$service.service.d/ci-loopback.conf"
cp "$unitdir/$service.service.d/ci-loopback.conf" "$unitdir/$market.service.d/ci-loopback.conf"
# Upgrade from genuine single-process and two-process releases, including their installers' on-disk state.
old="$fixture/v0.63.0"
dual="$fixture/v0.64.0"
for version in v0.63.0 v0.64.0; do
  mkdir "$fixture/$version"
  for asset in SHA256SUMS trading-platform.tar.gz install.sh; do
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 10 --max-time 180 \
      "https://github.com/hxx344/trading-platform/releases/download/$version/$asset" -o "$fixture/$version/$asset"
  done
  (cd "$fixture/$version" && awk '$2 == "install.sh" || $2 == "trading-platform.tar.gz"' SHA256SUMS >required && [[ $(wc -l <required) == 2 ]] && sha256sum -c --quiet required)
done
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
market_probe() {
  runuser -u "$service" -g "$market-ipc" -- timeout 4 node "$1/src/market/probe.ts" --socket "$market_socket" --root "$1"
}
assert_market_absent() {
  [[ ! -e "$unitdir/$market.service" && ! -e "$app/market" && ! -e "$app/market.env" && ! -e "$market_socket" ]]
  if systemctl is-active --quiet "$market"; then echo 'Market still running after downgrade' >&2; return 1; fi
}
build 1
echo 'Migrating the genuine single writer to the private socket and the browser service'
install_release 1
executor_pid=$(pid "$service")
control_pid=$(pid "$control")
market_pid=$(pid "$market")
[[ "$executor_pid" != "$legacy_pid" && -S /run/trading-platform/execution.sock &&
   $(stat -c '%U:%G %a' /run/trading-platform) == "$service:$service-ipc 2750" &&
   $(stat -c '%U:%G %a' /run/trading-platform/execution.sock) == "$service:$service-ipc 660" ]]
[[ $(stat -c '%U:%G %a' "$updates") == "root:$control 770" && $(stat -c %u "/proc/$control_pid") != "$(stat -c %u "/proc/$executor_pid")" ]]
[[ ! -e "/proc/$control_pid/root$conf/config.json" && ! -e "/proc/$control_pid/root$data/access-url" ]]
if runuser -u "$control" -- test -r "$conf/secrets.json" || runuser -u "$control" -- test -w "$handoff" ||
    runuser -u "$control" -- kill -0 "$executor_pid" 2>/dev/null; then echo 'Control UID reached execution credentials, import queue or signal permission' >&2; exit 1; fi
systemctl is-enabled --quiet "$control"
systemctl is-enabled --quiet "$market"
[[ $(stat -c %U "/proc/$market_pid") == "$market" && -S "$market_socket" &&
   $(stat -c '%U:%G %a' "/run/$market") == "$market:$market-ipc 2750" && $(stat -c '%U:%G %a' "$market_socket") == "$market:$market-ipc 660" ]]
[[ ! -e "/proc/$market_pid/root$conf/config.json" && ! -e "/proc/$market_pid/root$data/access-url" &&
   ! -e "/proc/$market_pid/root$data/executor-live.sqlite" && "$(stat -c '%U %a' "$app/market.env")" == 'root 600' ]]
if runuser -u "$market" -g "$market-ipc" -- test -w "$data" || runuser -u "$market" -- test -r "$conf/secrets.json" ||
    runuser -u "$market" -- test -w "$updates" || runuser -u "$market" -- test -w "$handoff" ||
    runuser -u "$market" -- kill -0 "$executor_pid" 2>/dev/null; then echo 'Market UID reached private service resources' >&2; exit 1; fi
# Try each disallowed socket from a service UID with the exact IPC group used by its unit.
for recipient in "$market:$market-ipc:/run/trading-platform/execution.sock" "$control:$service-ipc:$market_socket"; do
  IFS=: read -r account group socket <<<"$recipient"
  runuser -u "$account" -g "$group" -- node -e '
    const s = require("net").connect(process.argv[1]);
    s.on("connect", () => { s.destroy(); process.exitCode = 1; });
    s.on("error", e => { if (e.code !== "EACCES") process.exitCode = 1; });' "$socket"
done
market_probe "$app/market"
[[ -e "$app/.update-helper" ]]
login
assert_page v99.1.1

echo 'A killed market process restarts on its own; the logged-in page and the original execution generation continue'
kill -KILL "$market_pid"
assert_page v99.1.1
for _ in {1..50}; do
  if [[ $(pid "$market") != "$market_pid" ]] && market_probe "$app/market" 2>/dev/null; then break; fi
  sleep 0.5
done
market_probe "$app/market"
[[ $(pid "$market") != "$market_pid" && $(pid "$control") == "$control_pid" && $(pid "$service") == "$executor_pid" ]]
market_pid=$(pid "$market")

echo 'Rejecting an already shared market IPC group leaves all three processes running'
useradd --system --no-user-group --gid "$market-ipc" --no-create-home --shell /usr/sbin/nologin "$extra_user"
if install_release 1; then echo 'Accepted an unrelated user in the market IPC group' >&2; exit 1; fi
grep -q '行情通信组已用作其他账户的主组' "$fixture/out"
[[ $(pid "$market") == "$market_pid" && $(pid "$control") == "$control_pid" && $(pid "$service") == "$executor_pid" ]]
userdel "$extra_user"

echo 'Unsafe custom update parents are rejected before provisioning, preserving the live services'
mkdir "$fixture/parent-group" "$fixture/parent-other" "$fixture/parent-user" "$fixture/parent-trusted"
chmod 0770 "$fixture/parent-group"; chmod 0757 "$fixture/parent-other"
chown "$control:$control" "$fixture/parent-user"
ln -s "$fixture/parent-trusted" "$fixture/parent-link"
for parent in parent-group parent-other parent-user parent-link parent-missing; do
  if TP_UPDATE_DIR="$fixture/$parent/updates" install_release 1; then echo "Accepted unsafe update parent $parent" >&2; exit 1; fi
  grep -q '更新交接目录的父目录' "$fixture/out"
  [[ ! -e "$fixture/$parent/updates" && $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" ]]
done

echo 'The update path checks the request UID and returns its answer only to the control UID'
request_id=9d827fe0-5725-4d18-a5ec-2573cc94166f
update_reply() {
  local reason=$1
  for _ in {1..80}; do
    if [[ -f "$updates/update-result.json" ]] && grep -q "$reason" "$updates/update-result.json"; then
      if [[ $(stat -c '%U:%G %a' "$updates/update-result.json") == "$control:$control 600" ]]; then echo "Update helper answered: $reason"; return 0; fi
    fi
    sleep 0.25
  done
  echo "Timed out waiting for update helper: $reason" >&2; return 1
}
systemctl stop "$service-update.path"
printf '{"id":"%s","version":"v99.1.1","at":%s}\n' "$request_id" "$(date +%s%3N)" >"$fixture/root-request"
mv -T "$fixture/root-request" "$updates/update-request.json"
systemctl start "$service-update.path"
update_reply '请求文件不属于服务账户'
runuser -u "$control" -- node -e 'const fs=require("fs"), p=process.argv[1]; fs.writeFileSync(p+".next", JSON.stringify({id:process.argv[2],version:"v99.1.1",at:Date.now()}), {flag:"wx",mode:0o600}); fs.renameSync(p+".next",p);' "$updates/update-request.json" "$request_id"
update_reply '不比已装版本'
runuser -u "$control" -- mkdir "$updates/update-request.json"
update_reply '不是普通文件'
[[ ! -e "$updates/update-request.json" ]]
systemctl is-active --quiet "$service-update.path"

echo 'An actual page import restarts execution once and the subsequent page deployment keeps the imported generation'
curl --noproxy '*' -fsS --max-time 3 -b "$fixture/cookie" -H 'x-pa-executor: 1' -H 'Content-Type: application/json' \
  --data '{"action":"import","ondo":true}' "$(url /api/import)" >"$fixture/import-request"
for _ in {1..120}; do
  if [[ -f "$handoff/result.json" ]] && node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1])); process.exit(r.phase === "done" ? 0 : 1)' "$handoff/result.json"; then break; fi
  sleep 0.5
done
node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1])); if (r.phase !== "done") throw new Error(r.message)' "$handoff/result.json"
[[ $(pid "$service") != "$executor_pid" && $(pid "$control") == "$control_pid" ]]
executor_pid=$(pid "$service")
# Let the oneshot finish its current request and release the installer/import lock.
flock -w 90 "$app/.install.lock" true

echo 'Page and version changes preserve both real processes, cookies and their pinned packages across cleanup'
first_executor=$(readlink "$app/executor")
first_control=$(readlink "$app/control")
first_market=$(readlink "$app/market")
for version in 2 3 4 5; do
  printf '\n<!-- simulated page release %s -->\n' "$version" >>"$source/web/dist/index.html"
  build "$version"
  install_release "$version"
  [[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" && -f "$first_executor/src/service/main.ts" && -f "$first_control/src/control/main.ts" ]]
  [[ $(pid "$market") == "$market_pid" && -f "$first_market/src/market/main.ts" ]]
  assert_page "v99.1.$version"
done

echo 'Changing public subscriptions and historical/depth readers refreshes only the market generation and its reported identity'
for reader in monitor/perpetual-feed.ts vendor/perpetual-exchanges.mjs vendor/perpetual-price-reader.mjs vendor/crossex/depth-reader.mjs; do
  printf '\n// simulated public market reader upgrade\n' >>"$source/src/$reader"
done
build 13
install_release 13
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" && $(pid "$market") != "$market_pid" ]]
market_probe "$app/market"
if market_probe "$first_market" 2>/dev/null; then echo 'A market probe accepted a different running build' >&2; exit 1; fi
assert_page v99.1.13

echo 'A broken market-only package restores the previous market and preserves both non-market PIDs'
cp "$source/src/market/main.ts" "$fixture/good-market"
sed -i '1i if (import.meta.main) throw new Error("模拟行情服务启动失败");' "$source/src/market/main.ts"
build 14
if install_release 14; then echo 'Broken market accepted' >&2; exit 1; fi
grep -q '已回退到 v99.1.13 并确认运行正常' "$fixture/out"
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" ]]
market_probe "$app/market"
assert_page v99.1.13
cp "$fixture/good-market" "$source/src/market/main.ts"
market_pid=$(pid "$market")

echo 'An update-helper-only package leaves both live process generations unchanged'
printf '\n// simulated root helper update\n' >>"$source/src/service/update-helper.ts"
build 11
install_release 11
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" && $(pid "$market") == "$market_pid" ]]
assert_page v99.1.11

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
cp "$app/executor/src/service/main.ts" "$source/src/service/main.ts"
sed -i '1i if (import.meta.main) throw new Error("模拟新端口下控制面启动失败");' "$source/src/control/main.ts"
build 10
if install_release 10; then echo 'Broken control with changed listen port accepted' >&2; exit 1; fi
grep -q '已回退到 v99.1.8 并确认运行正常' "$fixture/out"
login
assert_page v99.1.8
if curl --noproxy '*' -s --max-time 1 -o /dev/null http://127.0.0.1:4720/api/ready; then echo 'Rollback left the old port listening' >&2; exit 1; fi
printf '%s\n' 'NODE_USE_ENV_PROXY=1' 'NO_PROXY=127.0.0.1' 'COINGECKO_DEMO_API_KEY=fixture-market-key' 'CI_EXECUTION_ONLY=marker' >"$conf/environment"
install_release 8
login
assert_page v99.1.8
control_pid=$(pid "$control")
tr '\0' '\n' <"/proc/$control_pid/environ" >"$fixture/control-env"
grep -qx 'NODE_USE_ENV_PROXY=1' "$fixture/control-env"
tr '\0' '\n' <"/proc/$(pid "$market")/environ" >"$fixture/market-env"
grep -qx 'NODE_USE_ENV_PROXY=1' "$fixture/market-env"
grep -qx 'COINGECKO_DEMO_API_KEY=fixture-market-key' "$fixture/market-env"
if grep -q CI_EXECUTION_ONLY "$fixture/market-env" "$fixture/control-env" || grep -q COINGECKO_DEMO_API_KEY "$fixture/control-env"; then
  echo 'The environment crossed a service boundary' >&2; exit 1
fi
executor_pid=$(pid "$service")
market_pid=$(pid "$market")
sed -i 's/^COINGECKO_DEMO_API_KEY=fixture-market-key$/COINGECKO_DEMO_API_KEY=changed-market-key/' "$conf/environment"
install_release 8
[[ $(pid "$market") != "$market_pid" && $(pid "$service") == "$executor_pid" && $(pid "$control") == "$control_pid" ]]
systemctl stop "$control"
install_release 8
[[ $(pid "$service") == "$executor_pid" && $(pid "$control") != "$control_pid" ]]
assert_page v99.1.8

echo 'Downgrade frees TCP for the original unit and can migrate forward again'
bash "$root/deploy/install.sh" --package "$old" >"$fixture/out" 2>&1
[[ ! -e "$unitdir/$control.service" && ! -e "$app/control" && ! -e /run/trading-platform/execution.sock ]]
assert_market_absent
grep -qF "PathChanged=$handoff/update-request.json" "$unitdir/$service-update.path"
grep -qF -- "--dir $handoff --app-dir $app" "$unitdir/$service-update.service"
if systemctl is-active --quiet "$control"; then echo 'Control still running on downgrade' >&2; exit 1; fi
login
assert_page v0.63.0

echo 'Upgrade from the genuine two-process release and downgrade to its original public-data owner'
bash "$dual/install.sh" --package "$dual" >"$fixture/out" 2>&1
login
assert_page v0.64.0
assert_market_absent
install_release 8
login
assert_page v99.1.8
market_probe "$app/market"
echo 'Removing the market service still succeeds after an unrelated user joins its socket group'
useradd --system --no-user-group --gid "$market-ipc" --no-create-home --shell /usr/sbin/nologin "$extra_user"
bash "$root/deploy/install.sh" --package "$dual" >"$fixture/out" 2>&1
login
assert_page v0.64.0
assert_market_absent
[[ $(id -gn "$extra_user") == "$market-ipc" ]]
userdel "$extra_user"

echo 'A broken two-process downgrade cannot bring the previous market back with an unsafe socket group'
install_release 8
market_probe "$app/market"
last_good=$(readlink "$app/current")
useradd --system --no-user-group --gid "$market-ipc" --no-create-home --shell /usr/sbin/nologin "$extra_user"
broken_dual="$fixture/broken-dual"
mkdir -p "$broken_dual/source"
tar -xzf "$dual/trading-platform.tar.gz" -C "$broken_dual/source"
# An unsuccessful ExecStartPre fails the real systemctl restart job immediately, before the 90-second health wait.
printf '\n[Service]\nExecStartPre=/bin/false\nRestart=no\n' >>"$broken_dual/source/trading-platform/deploy/$service.service"
tar -C "$broken_dual/source" -czf "$broken_dual/trading-platform.tar.gz" trading-platform
(cd "$broken_dual" && sha256sum trading-platform.tar.gz >SHA256SUMS)
if bash "$root/deploy/install.sh" --package "$broken_dual" >"$fixture/out" 2>&1; then echo 'Broken downgrade accepted' >&2; exit 1; fi
systemctl is-failed --quiet "$service"
grep -Fxq 'ExecStartPre=/bin/false' "$unitdir/$service.service"
grep -Fq '上一版本 v99.1.8 的行情账户未通过核验，无法重新启用' "$fixture/out"
[[ $(cat "$app/.deployment/current") == "$last_good" && $(readlink "$app/current") != "$last_good" ]]
assert_market_absent
# The known-good two-process package can recover execution without granting the unrelated UID any new access.
bash "$root/deploy/install.sh" --package "$dual" >"$fixture/out" 2>&1
login
assert_page v0.64.0
assert_market_absent
[[ $(id -gn "$extra_user") == "$market-ipc" ]]
userdel "$extra_user"

echo 'Reconciling a real old installer which changed current without updating the split deployment record'
systemctl disable --now "$control"
bash "$old/install.sh" --package "$old" >"$fixture/out" 2>&1
legacy_pid=$(pid "$service")
legacy_dir=$(readlink "$app/current")
[[ $(cat "$app/.deployment/current") != "$legacy_dir" ]]
sed -i '1i if (import.meta.main && process.argv.includes("--check-config")) throw new Error("模拟配置预检失败");' "$source/src/service/main.ts"
build 12
if install_release 12; then echo 'Broken config check accepted' >&2; exit 1; fi
grep -q '模拟配置预检失败' "$fixture/out"
[[ $(pid "$service") == "$legacy_pid" && $(readlink "$app/current") == "$legacy_dir" && $(cat "$app/.deployment/current") == "$legacy_dir" ]]
assert_page v0.63.0
install_release 8
login
assert_page v99.1.8
echo 'Independent activation, rollback and migration passed with real systemd'
