#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # checks are eval-ed later on purpose
# Runs install.sh as an ordinary user in test mode (temporary directories, no system account, no systemctl):
# first install without config, unchanged rerun, permission repair, a config the new program rejects, an upgrade,
# and a deterministic package. The systemd start, health check and rollback need root and are checked on the server.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export TP_TEST_MODE=1 TP_NODE_BIN TP_APP_DIR="$tmp/opt" TP_CONF_DIR="$tmp/etc" TP_DATA_DIR="$tmp/var" TP_UNIT_FILE="$tmp/unit.service"
TP_NODE_BIN=$(command -v node)
install_sh="$root/deploy/install.sh"
failures=0
check() { if eval "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi; }
run() { bash "$install_sh" "$@" >"$tmp/out" 2>&1; }

bash "$root/deploy/package.sh" "$tmp/a" >/dev/null
bash "$root/deploy/package.sh" "$tmp/a2" >/dev/null
check '同一源码打出的包校验和相同' 'cmp -s "$tmp/a/SHA256SUMS" "$tmp/a2/SHA256SUMS"'

# A second package with different contents, for the upgrade.
mkdir -p "$tmp/src-b/deploy"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-b/"
cp "$root/deploy/"{package.sh,install.sh,trading-platform.service,config.example.json,secrets.example.json} "$tmp/src-b/deploy/"
printf '\n升级测试\n' >>"$tmp/src-b/README.md"
bash "$tmp/src-b/deploy/package.sh" "$tmp/b" >/dev/null

run --package "$tmp/a" && status=0 || status=$?
check '首次安装成功' '[[ $status -eq 0 ]]'
check '首次安装提示先写配置' 'grep -q "下一步" "$tmp/out"'
check '当前版本指向新包' '[[ -f "$TP_APP_DIR/current/src/service/main.ts" ]]'
check '示例配置已放入' '[[ -f "$TP_CONF_DIR/config.example.json" && -f "$TP_CONF_DIR/secrets.example.json" ]]'
check '数据目录权限 700' '[[ "$(stat -c %a "$TP_DATA_DIR")" == 700 ]]'
check 'systemd 单元已填入路径' '! grep -q "@" "$TP_UNIT_FILE" && grep -q "ExecStart=$TP_NODE_BIN $TP_APP_DIR/current/src/service/main.ts --config $TP_CONF_DIR/config.json --data-dir $TP_DATA_DIR" "$TP_UNIT_FILE"'
first=$(readlink -f "$TP_APP_DIR/current")

run --package "$tmp/a"
check '重复执行无变化' 'grep -q "无变化" "$tmp/out" && grep -q "程序包（未变化）" "$tmp/out" && grep -q "systemd 单元（未变化）" "$tmp/out"'

# Test-only keys from the ASTER stand-in.
(cd "$root" && node --input-type=module -e '
  const { MAIN, LONG, SHORT } = await import("./test/aster-fake.ts");
  process.stdout.write(JSON.stringify({ accounts: { main: MAIN, "long-1": LONG, "short-1": SHORT } }));') >"$TP_CONF_DIR/secrets.json"
sed "s|/etc/trading-platform/secrets.json|$TP_CONF_DIR/secrets.json|" "$root/deploy/config.example.json" >"$TP_CONF_DIR/config.json"
chmod 644 "$TP_CONF_DIR/config.json" "$TP_CONF_DIR/secrets.json"
run --package "$tmp/a" && status=0 || status=$?
check '写好配置后执行成功' '[[ $status -eq 0 ]]'
check '配置经新程序校验' 'grep -q "配置有效：1 个配对（pair-1），3 个账户，端口 4720，飞书未配置" "$tmp/out"'
check '配置与密钥改为 600' '[[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '输出 SSH 隧道说明' 'grep -q "ssh -N -L 4720:127.0.0.1:4720" "$tmp/out"'

sed -i 's/"short": "short-1"/"short": "long-1"/' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '配置无效时安装失败' '[[ $status -ne 0 ]] && grep -q "配置检查未通过，服务保持原版本" "$tmp/out"'
check '配置无效时仍是原版本' '[[ "$(readlink -f "$TP_APP_DIR/current")" == "$first" ]]'

sed -i 's/"short": "long-1"/"short": "short-1"/' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '升级成功' '[[ $status -eq 0 ]] && grep -q "已更新：程序 v" "$tmp/out"'
check '升级后指向新包且保留旧包' '[[ "$(readlink -f "$TP_APP_DIR/current")" != "$first" && -d "$first" ]] && grep -q "升级测试" "$TP_APP_DIR/current/README.md"'
check '升级保留配置' 'grep -q "\"short\": \"short-1\"" "$TP_CONF_DIR/config.json"'

run --package "$tmp/a" && status=0 || status=$?
check '可装回上一版本' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$first" ]]'

run --version 0.1.0 && status=0 || status=$?
check '版本号格式校验' '[[ $status -ne 0 ]] && grep -q "须形如 v0.1.0" "$tmp/out"'

if ((failures)); then printf '%d 项失败；最后一次输出：\n' "$failures"; cat "$tmp/out"; exit 1; fi
printf '安装测试全部通过\n'
