#!/usr/bin/env bash
# Real systemd acceptance for install-watch.sh on an explicitly disposable Linux runner.
# 来源：project-aggregation 的 deploy/test-main-watch-systemd.sh（提交 7745181）；心跳由 main_watch.py --sender 单次推送代替
# 工作台的推送端安装，另加从发布文件引导安装的检查。平台自己的推送与接收端的互通在 test/watch.test.ts。
# shellcheck disable=SC2015
set -Eeuo pipefail
[[ ${TP_WATCH_DISPOSABLE_CI:-0} == 1 && ${GITHUB_ACTIONS:-false} == true && $(uname -s) == Linux && $EUID == 0 ]] || {
  echo 'Requires TP_WATCH_DISPOSABLE_CI=1 GITHUB_ACTIONS=true on a disposable Linux root runner.' >&2; exit 1;
}
[[ $(cat /proc/1/comm) == systemd ]] || { echo 'A real systemd PID 1 is required.' >&2; exit 1; }
repository=$(cd -- "$(dirname -- "$0")/.." && pwd -P)
service=main-watch
units=(main-watch.service main-watch.timer main-watch-heartbeat.service)
for target in /opt/main-watch /etc/main-watch /var/lib/main-watch "${units[@]/#//etc/systemd/system/}" /usr/local/bin/main-watch; do
  [[ ! -e $target && ! -L $target ]] || { echo "Refusing to replace an existing fixture target: $target" >&2; exit 1; }
done
! id "$service" >/dev/null 2>&1 || { echo 'Service account already exists.' >&2; exit 1; }
umask 022
fixture=$(mktemp -d /opt/main-watch-ci-XXXXXXXX)
server_pid='' release_pid=''
cleanup() {
  result=$?
  trap - EXIT
  if ((result)); then journalctl -u main-watch.service -u main-watch-heartbeat.service -u main-watch.timer --no-pager -n 60 || true; fi
  [[ -z $server_pid ]] || kill "$server_pid" 2>/dev/null || true
  [[ -z $release_pid ]] || kill "$release_pid" 2>/dev/null || true
  systemctl disable --now main-watch.timer main-watch-heartbeat.service >/dev/null 2>&1 || true
  rm -f "${units[@]/#//etc/systemd/system/}" /usr/local/bin/main-watch
  rm -rf /opt/main-watch /etc/main-watch /var/lib/main-watch /var/lib/private/main-watch
  systemctl daemon-reload || true
  userdel "$service" >/dev/null 2>&1 || true
  groupdel "$service" >/dev/null 2>&1 || true
  [[ $fixture == /opt/main-watch-ci-* && -d $fixture && ! -L $fixture ]] && rm -rf -- "$fixture"
  exit "$result"
}
trap cleanup EXIT
chmod 755 "$fixture"
mkdir "$fixture/source"
git -c safe.directory="$repository" -C "$repository" archive HEAD deploy/install-watch.sh deploy/main-watch | \
  tar -x -C "$fixture/source" --no-same-owner
chmod -R go-w,a+rX "$fixture/source"
program="$fixture/source/deploy/main-watch/main_watch.py"

# Loopback stand-ins: /api/ready answers 200, /hook records Feishu posts and fails while the flag file exists.
cat > "$fixture/server.py" <<'PY'
import http.server, json, os, sys
root = sys.argv[1]
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200 if self.path == '/api/ready' else 503); self.end_headers()
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        failing = os.path.exists(os.path.join(root, 'fail'))
        if not failing:
            with open(os.path.join(root, 'posts.log'), 'ab') as handle: handle.write(body + b'\n')
        self.send_response(200); self.end_headers()
        self.wfile.write(json.dumps({'code': 19021, 'msg': 'sign match fail'} if failing else {'code': 0}).encode())
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
with open(os.path.join(root, 'port.next'), 'w') as handle: handle.write(str(server.server_port))
os.replace(os.path.join(root, 'port.next'), os.path.join(root, 'port'))
server.serve_forever()
PY
python3 -I "$fixture/server.py" "$fixture" & server_pid=$!
for _ in {1..50}; do [[ -f $fixture/port ]] && break; sleep 0.1; done
port=$(cat "$fixture/port")
installer=("$fixture/source/deploy/install-watch.sh" --source "$fixture/source")
posts() { [[ -f $fixture/posts.log ]] && wc -l < "$fixture/posts.log" || echo 0; }
free_port() { python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'; }

# Expect a failure whose output names the intended reason, so unrelated errors cannot pass.
fails() { local reason=$1 output; shift; if output=$("$@" 2>&1); then echo "Expected failure: $*" >&2; exit 1; fi
  grep -q -- "$reason" <<< "$output" || { printf 'Unexpected failure reason for %s:\n%s\n' "$*" "$output" >&2; exit 1; }; }

echo '== a rejected first install leaves no service behind'
touch "$fixture/fail"
fails '飞书测试消息发送失败' bash "${installer[@]}" --main "127.0.0.1:$port" --webhook "http://127.0.0.1:$port/hook"
[[ ! -e /opt/main-watch/main_watch.py && ! -e /etc/systemd/system/main-watch.timer && ! -e /etc/main-watch/config && ! -e /usr/local/bin/main-watch ]]
if systemctl is-enabled --quiet main-watch.timer; then echo 'Timer enabled after a rejected install' >&2; exit 1; fi
rm "$fixture/fail"

echo '== first install sends a test message and runs one real round'
bash "${installer[@]}" --main "127.0.0.1:$port" --checks "http://127.0.0.1:$port/down" \
  --webhook "http://127.0.0.1:$port/hook" --secret ci --threshold 1 | tee "$fixture/first.log"
grep -q '监控告警通道正常' "$fixture/posts.log"
grep -q 'sign' "$fixture/posts.log"
grep -q '服务异常' "$fixture/posts.log"  # threshold 1: the real systemd round alerted on /down
systemctl is-enabled --quiet main-watch.timer
systemctl is-active --quiet main-watch.timer
[[ $(stat -c '%U:%G %a' /etc/main-watch/config) == "root:$service 640" ]]
state=$(readlink -f /var/lib/main-watch)/state.json
[[ $(stat -c %U "$state") == "$service" ]]
python3 -I - "$state" "$port" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
assert state[f'http://127.0.0.1:{sys.argv[2]}/api/ready']['fails'] == 0, state
assert state[f'http://127.0.0.1:{sys.argv[2]}/down']['alerted'] is True, state
PY
grep -q '失败 http://127.0.0.1:.*/down' "$fixture/first.log"

echo '== repeat without arguments is a no-op that keeps configuration'
before=$(posts)
config_before=$(sha256sum /etc/main-watch/config)
bash "${installer[@]}" | tee "$fixture/noop.log"
grep -q '跳过部署' "$fixture/noop.log"
[[ $(posts) == "$before" && $(sha256sum /etc/main-watch/config) == "$config_before" ]]

echo '== a rejected webhook rolls back configuration and keeps the timer running'
touch "$fixture/fail"
fails '飞书测试消息发送失败' bash "${installer[@]}" --threshold 5
[[ $(sha256sum /etc/main-watch/config) == "$config_before" ]]
systemctl is-active --quiet main-watch.timer
rm "$fixture/fail"

echo '== invalid arguments change nothing'
fails '配置无效' bash "${installer[@]}" --checks 'ftp://nope'
fails '须形如' bash "${installer[@]}" --version 0.47.0
[[ $(sha256sum /etc/main-watch/config) == "$config_before" ]]

echo '== changing only the extra checks keeps the readiness check'
bash "${installer[@]}" --checks "tcp://127.0.0.1:$port"
grep -qx "MAIN=127.0.0.1:$port" /etc/main-watch/config
grep -qx "CHECKS=tcp://127.0.0.1:$port" /etc/main-watch/config
probe=$(/usr/local/bin/main-watch probe)
grep -q "正常 http://127.0.0.1:$port/api/ready" <<< "$probe"

echo '== heartbeat receiver starts and prints the command for the platform'
hb_port=$(free_port)
bash "${installer[@]}" --heartbeat-listen "127.0.0.1:$hb_port" | tee "$fixture/heartbeat.log"
token=$(sed -n 's/^HEARTBEAT_TOKEN=//p' /etc/main-watch/config)
[[ ${#token} -ge 32 ]]
grep -qF -- "install.sh --watch-url http://127.0.0.1:$hb_port/heartbeat --watch-token $token" "$fixture/heartbeat.log"
systemctl is-enabled --quiet main-watch-heartbeat.service
systemctl is-active --quiet main-watch-heartbeat.service
grep -q "失败 heartbeat://127.0.0.1:$hb_port：尚未收到主服务器心跳" "$fixture/heartbeat.log"
beat=$(readlink -f /var/lib/main-watch)/heartbeat.json
# One signed beat, as the platform pushes it: the token and the readiness address vary per check.
push() { printf 'HEARTBEAT_URL=http://127.0.0.1:%s/heartbeat\nHEARTBEAT_TOKEN=%s\nREADY_URL=http://127.0.0.1:%s%s\n' "$hb_port" "$1" "$port" "$2" > "$fixture/sender"
  python3 -I "$program" --sender --config "$fixture/sender"; }

echo '== the readiness check can be cleared once the heartbeat covers the main server'
bash "${installer[@]}" --main ''
grep -qx 'MAIN=' /etc/main-watch/config
probe=$(/usr/local/bin/main-watch probe || true)  # the heartbeat has not arrived yet, so the probe itself fails
if grep -q '/api/ready' <<< "$probe"; then echo 'Readiness check still present after clearing --main' >&2; exit 1; fi

echo '== a beat signed with the wrong token is refused'
fails '心跳推送被拒绝：HTTP 403' push "$(printf 'w%.0s' {1..40})" /api/ready
[[ ! -e $beat ]]

echo '== a real heartbeat makes the watcher healthy'
push "$token" /api/ready
python3 -I -c 'import json, sys; beat = json.load(open(sys.argv[1])); assert beat["ready"] is True and beat["peer"] == "127.0.0.1", beat' "$beat"
/usr/local/bin/main-watch probe | grep -q "正常 heartbeat://127.0.0.1:$hb_port"

echo '== the heartbeat alert from before the first beat recovers'
systemctl start main-watch.service
grep -q "服务恢复" "$fixture/posts.log"

echo '== an unready platform is reported through the heartbeat'
before=$(posts)
push "$token" /down
python3 -I -c 'import json, sys; beat = json.load(open(sys.argv[1])); assert beat["ready"] is False and "503" in beat["detail"], beat' "$beat"
systemctl start main-watch.service
grep -q '主服务器自检未就绪：HTTP 503' "$fixture/posts.log"
(( $(posts) > before ))

echo '== a hand-edited heartbeat token redeploys the receiver instead of skipping'
bash "${installer[@]}" | tee "$fixture/hand-edit-base.log"
grep -q '跳过部署' "$fixture/hand-edit-base.log"
receiver_started=$(systemctl show --property=ActiveEnterTimestampMonotonic --value main-watch-heartbeat.service)
sleep 1  # 让配置的修改时间晚于接收服务的启动时间
sed -i "s/^HEARTBEAT_TOKEN=.*/HEARTBEAT_TOKEN=$(printf 'h%.0s' {1..40})/" /etc/main-watch/config
[[ $(stat -c '%U:%G %a' /etc/main-watch/config) == "root:$service 640" ]]  # 只有接收服务过旧这一项不一致
bash "${installer[@]}" | tee "$fixture/hand-edit.log"
if grep -q '跳过部署' "$fixture/hand-edit.log"; then echo 'Stale heartbeat receiver was skipped' >&2; exit 1; fi
(( $(systemctl show --property=ActiveEnterTimestampMonotonic --value main-watch-heartbeat.service) > receiver_started ))
bash "${installer[@]}" | tee "$fixture/hand-edit-noop.log"
grep -q '跳过部署' "$fixture/hand-edit-noop.log"

echo '== installing from release files: checksum list first, then verified and cached files'
release="$fixture/release/latest/download"
mkdir -p "$release"
cp "$fixture/source/deploy/install-watch.sh" "$program" "$release/"
(cd "$release" && sha256sum main_watch.py install-watch.sh > SHA256SUMS)
release_port=$(free_port)
python3 -I -m http.server "$release_port" --bind 127.0.0.1 --directory "$fixture/release" >/dev/null 2>&1 & release_pid=$!
for _ in {1..50}; do curl -fsS -o /dev/null "http://127.0.0.1:$release_port/latest/download/SHA256SUMS" 2>/dev/null && break; sleep 0.1; done
export MAIN_WATCH_RELEASE_BASE="http://127.0.0.1:$release_port"
bash "$release/install-watch.sh" | tee "$fixture/release.log"
grep -q '下载巡检文件（latest）' "$fixture/release.log"
grep -q '版本 latest:.*跳过部署' "$fixture/release.log"  # the same program and units as the --source install
bash "$release/install-watch.sh" | tee "$fixture/release-cached.log"
grep -q '已缓存，跳过下载' "$fixture/release-cached.log"
[[ $(find /opt/main-watch/sources -mindepth 1 -maxdepth 1 -type d | wc -l) == 1 ]]
printf '\n# changed after the checksum list was made\n' >> "$release/main_watch.py"
rm -rf /opt/main-watch/sources/*
fails 'SHA-256 与校验清单不一致' bash "$release/install-watch.sh"
[[ -z $(find /opt/main-watch/sources -mindepth 1 -maxdepth 1) ]]
printf 'none\n' > "$release/SHA256SUMS"
fails '没有副服务器巡检文件' bash "$release/install-watch.sh"
unset MAIN_WATCH_RELEASE_BASE
cmp -s "$program" /opt/main-watch/main_watch.py

echo '== disabling heartbeat stops the receiver'
bash "${installer[@]}" --heartbeat-listen '' --checks "http://127.0.0.1:$port/api/ready"
if systemctl is-active --quiet main-watch-heartbeat.service || systemctl is-enabled --quiet main-watch-heartbeat.service; then
  echo 'Heartbeat receiver still running after disabling heartbeat' >&2; exit 1
fi
/usr/local/bin/main-watch probe

echo '== a broken deployment is repaired instead of skipped'
# Only the last systemd round is unhealthy: files and permissions match again before the rerun.
chmod 700 /etc/main-watch
systemctl start main-watch.service || true
[[ $(systemctl show --property=Result --value main-watch.service) != success ]]
chmod 750 /etc/main-watch
bash "${installer[@]}" | tee "$fixture/repair.log"
if grep -q '跳过部署' "$fixture/repair.log"; then echo 'Broken deployment was skipped' >&2; exit 1; fi
[[ $(stat -c '%U:%G %a' /etc/main-watch) == "root:$service 750" ]]
[[ $(systemctl show --property=Result --value main-watch.service) == success ]]

echo '== management command and uninstall'
/usr/local/bin/main-watch check
/usr/local/bin/main-watch probe >/dev/null || true
bash "${installer[@]}" --uninstall
[[ ! -e /etc/systemd/system/main-watch.timer && ! -e /opt/main-watch && -f /etc/main-watch/config ]]
if systemctl is-active --quiet main-watch.timer; then echo 'Timer still active after uninstall' >&2; exit 1; fi
echo 'main-watch systemd acceptance passed'
