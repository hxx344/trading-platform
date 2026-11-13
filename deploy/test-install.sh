#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # checks are eval-ed later on purpose
# Runs install.sh as an ordinary user in test mode (temporary directories, no system account, no systemctl):
# first install without config, unchanged rerun, permission repair, a config the new program rejects, an upgrade,
# and a deterministic package. The systemd start, health check and rollback need root and are checked on the server.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export TP_TEST_MODE=1 TP_NODE_BIN TP_APP_DIR="$tmp/opt" TP_CONF_DIR="$tmp/etc" TP_DATA_DIR="$tmp/var" TP_UNIT_FILE="$tmp/unit.service" TP_IMPORT_DIR="$tmp/import"
TP_NODE_BIN=$(command -v node)
install_sh="$root/deploy/install.sh"
failures=0
check() { if eval "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; failures=$((failures + 1)); fi; }
run() { bash "$install_sh" "$@" >"$tmp/out" 2>&1; }

bash "$root/deploy/package.sh" "$tmp/a" >/dev/null
bash "$root/deploy/package.sh" "$tmp/a2" >/dev/null
check '同一源码打出的包校验和相同' 'cmp -s "$tmp/a/SHA256SUMS" "$tmp/a2/SHA256SUMS"'
tar -tzf "$tmp/a/trading-platform.tar.gz" >"$tmp/a.list"
check '发布包含构建好的页面' 'grep -q "/web/dist/index.html$" "$tmp/a.list" && grep -q "/web/dist/assets/.*\.js$" "$tmp/a.list"'

# A second package with different contents, for the upgrade.
mkdir -p "$tmp/src-b/deploy"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-b/"
mkdir -p "$tmp/src-b/web" && cp -R "$root/web/dist" "$tmp/src-b/web/"
cp "$root/deploy/"{package.sh,install.sh,trading-platform.service,trading-platform-import.service,trading-platform-import.path,config.example.json,secrets.example.json} "$tmp/src-b/deploy/"
printf '\n升级测试\n' >>"$tmp/src-b/README.md"
bash "$tmp/src-b/deploy/package.sh" "$tmp/b" >/dev/null

run --package "$tmp/a" && status=0 || status=$?
check '首次安装成功' '[[ $status -eq 0 ]]'
check '首次安装生成空配置并通过检查' 'grep -q "\"pairs\": \[\]" "$TP_CONF_DIR/config.json" && [[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]] && grep -q "配置有效：0 个配对（尚未导入）" "$tmp/out"'
check '首次安装提示在页面导入' 'grep -q "下一步：在页面「从工作台导入配对」" "$tmp/out"'
check '导入目录权限 770' '[[ "$(stat -c %a "$TP_IMPORT_DIR")" == 770 ]]'
check '导入助手单元已填入路径' '! grep -q "@" "$tmp/trading-platform-import.service" "$tmp/trading-platform-import.path" && grep -q "PathChanged=$TP_IMPORT_DIR/request.json" "$tmp/trading-platform-import.path" && grep -q "ExecStart=$(command -v flock) -w 100 $TP_APP_DIR/.install.lock $TP_NODE_BIN $TP_APP_DIR/current/src/service/import-helper.ts --dir $TP_IMPORT_DIR --config $TP_CONF_DIR/config.json --data-dir $TP_DATA_DIR" "$tmp/trading-platform-import.service" && grep -q "ExecStopPost=$(command -v flock) -w 60 $TP_APP_DIR/.install.lock $TP_NODE_BIN $TP_APP_DIR/current/src/service/import-helper.ts --recover --dir $TP_IMPORT_DIR" "$tmp/trading-platform-import.service"'
check '当前版本指向新包' '[[ -f "$TP_APP_DIR/current/src/service/main.ts" ]]'
check '示例配置已放入' '[[ -f "$TP_CONF_DIR/config.example.json" && -f "$TP_CONF_DIR/secrets.example.json" ]]'
check '数据目录权限 700' '[[ "$(stat -c %a "$TP_DATA_DIR")" == 700 ]]'
check 'systemd 单元已填入路径' '! grep -q "@" "$TP_UNIT_FILE" && grep -q "ExecStart=$TP_NODE_BIN $TP_APP_DIR/current/src/service/main.ts --config $TP_CONF_DIR/config.json --data-dir $TP_DATA_DIR --import-dir $TP_IMPORT_DIR" "$TP_UNIT_FILE" && grep -q "ReadWritePaths=$TP_DATA_DIR -$TP_IMPORT_DIR" "$TP_UNIT_FILE"'
first=$(readlink -f "$TP_APP_DIR/current")

run --package "$tmp/a"
check '重复执行无变化' 'grep -q "无变化" "$tmp/out" && grep -q "程序包（未变化）" "$tmp/out" && grep -q "systemd 单元（未变化）" "$tmp/out"'

# Test-only keys from the ASTER stand-in.
(cd "$root" && node --input-type=module -e '
  const { MAIN, LONG, SHORT } = await import("./test/aster-fake.ts");
  process.stdout.write(JSON.stringify({ accounts: { main: MAIN, "long-1": LONG, "short-1": SHORT } }));') >"$TP_CONF_DIR/secrets.json"
# The example's ASTER part only: its oil block needs Binance/Bybit keys, which the ASTER-only checks below do not cover.
node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); delete c.oil; c.secretsFile = process.argv[2]; process.stdout.write(JSON.stringify(c, null, 2));' "$root/deploy/config.example.json" "$TP_CONF_DIR/secrets.json" >"$TP_CONF_DIR/config.json"
chmod 644 "$TP_CONF_DIR/config.json" "$TP_CONF_DIR/secrets.json"
run --package "$tmp/a" && status=0 || status=$?
check '写好配置后执行成功' '[[ $status -eq 0 ]]'
check '配置经新程序校验' 'grep -q "配置有效：1 个配对（pair-1），3 个账户，端口 4720，飞书未配置" "$tmp/out"'
check '配置检查同时载入页面' 'grep -Eq "页面 [1-9][0-9]* 个文件" "$tmp/out"'
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

# A secretsFile outside the config directory is never taken over (P3-1 of the step 4 review).
mkdir -p "$tmp/outside"
cp "$TP_CONF_DIR/secrets.json" "$tmp/outside/secrets.json"; chmod 640 "$tmp/outside/secrets.json"
sed -i "s|$TP_CONF_DIR/secrets.json|$tmp/outside/secrets.json|" "$TP_CONF_DIR/config.json"
run --package "$tmp/a" && status=0 || status=$?
check '目录外的密钥文件不改权限' '[[ "$(stat -c %a "$tmp/outside/secrets.json")" == 640 ]] && grep -q "未调整属主与权限" "$tmp/out"'
sed -i "s|$tmp/outside/secrets.json|$TP_CONF_DIR/secrets.json|" "$TP_CONF_DIR/config.json"

# Importing from a workbench on the same machine: its enabled pair is added beside pair-1, the main account is
# matched to the existing entry by wallet, and the result passes the new program's config check.
mkdir -p "$tmp/wb/data/modules/aster"
(cd "$root" && node --input-type=module -e '
  const { DatabaseSync } = await import("node:sqlite");
  const { addressOf } = await import("./src/aster/eip712.ts");
  const { MAIN } = await import("./test/aster-fake.ts");
  const [dir] = process.argv.slice(1);
  const wallet = (user, byte) => { const privateKey = "0x" + byte.repeat(32); return { user, signer: addressOf(privateKey), privateKey }; };
  const db = new DatabaseSync(dir + "/data/modules/aster/trading.sqlite3");
  db.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE pairs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  for (const [id, prefix] of [["l9", "WB_L9"], ["s9", "WB_S9"]]) db.prepare("INSERT INTO accounts VALUES (?, ?)").run(id, JSON.stringify({ id, name: id, mode: "live", env_prefix: prefix, enabled: false }));
  db.prepare("INSERT INTO pairs VALUES (?, ?)").run("wb-gold", JSON.stringify({ id: "wb-gold", name: "gold", long_account_id: "l9", short_account_id: "s9", margin: { enabled: true, master_env_prefix: "WB_MAIN" } }));
  db.close();
  const line = (prefix, w) => `${prefix}_USER=${w.user}\n${prefix}_SIGNER=${w.signer}\n${prefix}_PRIVATE_KEY=${w.privateKey}\n`;
  process.stdout.write(`DATA_DIR=${dir}/data\n` + line("WB_MAIN", MAIN) + line("WB_L9", wallet("0x" + "4d".repeat(20), "24")) + line("WB_S9", wallet("0x" + "5e".repeat(20), "25")));
' "$tmp/wb") >"$tmp/wb/workbench.env"
# A program whose config check fails: the imported files are put back, the old release stays current.
mkdir -p "$tmp/src-c/deploy"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-c/"
mkdir -p "$tmp/src-c/web" && cp -R "$root/web/dist" "$tmp/src-c/web/"
cp "$root/deploy/"{package.sh,install.sh,trading-platform.service,trading-platform-import.service,trading-platform-import.path,config.example.json,secrets.example.json} "$tmp/src-c/deploy/"
sed -i "s|if (values\['check-config'\]) {|if (values['check-config']) { throw new Error('测试：配置检查失败');|" "$tmp/src-c/src/service/main.ts"
bash "$tmp/src-c/deploy/package.sh" "$tmp/c" >/dev/null
cp -p "$TP_CONF_DIR/config.json" "$tmp/config.before"; cp -p "$TP_CONF_DIR/secrets.json" "$tmp/secrets.before"
current_before=$(readlink -f "$TP_APP_DIR/current")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/c" --import-workbench && status=0 || status=$?
check '导入后检查失败时恢复导入前的配置' '[[ $status -ne 0 ]] && grep -q "导入配对 wb-gold" "$tmp/out" && grep -q "已恢复导入前的配置文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json" && [[ "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '导入后检查失败时仍是原版本' '[[ "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]]'
# Stopped by a signal while the new program checks the imported files: they are put back all the same.
mkdir -p "$tmp/src-d/deploy"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-d/"
mkdir -p "$tmp/src-d/web" && cp -R "$root/web/dist" "$tmp/src-d/web/"
cp "$root/deploy/"{package.sh,install.sh,trading-platform.service,trading-platform-import.service,trading-platform-import.path,config.example.json,secrets.example.json} "$tmp/src-d/deploy/"
sed -i "s|if (values\['check-config'\]) {|if (values['check-config']) { (await import('node:fs')).writeFileSync(process.env.TP_TEST_MARK, ''); await new Promise(resolve => setTimeout(resolve, 1500));|" "$tmp/src-d/src/service/main.ts"
bash "$tmp/src-d/deploy/package.sh" "$tmp/d" >/dev/null
rm -f "$tmp/mark"
TP_TEST_MARK="$tmp/mark" TP_WORKBENCH_ENV="$tmp/wb/workbench.env" bash "$install_sh" --package "$tmp/d" --import-workbench >"$tmp/out" 2>&1 &
pid=$!
for _ in $(seq 100); do [[ -e "$tmp/mark" ]] && break; sleep 0.1; done
kill -TERM "$pid"; wait "$pid" && status=0 || status=$?
check '导入后收到停止信号时恢复导入前的配置' '[[ -e "$tmp/mark" && $status -eq 130 ]] && grep -q "导入配对 wb-gold" "$tmp/out" && grep -q "已恢复导入前的配置文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json"'
check '收到停止信号时仍是原版本' '[[ "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]]'

TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench && status=0 || status=$?
check '从工作台导入并通过配置检查' '[[ $status -eq 0 ]] && grep -q "导入配对 wb-gold（gold）" "$tmp/out" && grep -q "配置有效：2 个配对（pair-1、wb-gold），5 个账户" "$tmp/out"'
check '导入后配置与密钥仍为 600' '[[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]] && grep -q "\"main\": \"main\"" "$TP_CONF_DIR/config.json"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench && status=0 || status=$?
check '重复导入不改动配置' '[[ $status -eq 0 ]] && grep -q "没有新的配对，配置未改动" "$tmp/out" && grep -q "无变化" "$tmp/out"'
run --package "$tmp/a" --pairs wb-gold && status=0 || status=$?
check '--pairs 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q "须和 --import-workbench 一起使用" "$tmp/out"'

# No current link (data and config left from an earlier install): installs and points current at the release.
rm "$TP_APP_DIR/current"
run --package "$tmp/b" && status=0 || status=$?
check '没有 current 链接时重新安装' '[[ $status -eq 0 && -L "$TP_APP_DIR/current" && "$(readlink "$TP_APP_DIR/current")" == "$TP_APP_DIR/releases/"* ]]'

# A data directory that already ran the service, with its config gone: no empty config is made up for it.
mkdir -p "$tmp/var2" && : >"$tmp/var2/executor-live.sqlite"
TP_CONF_DIR="$tmp/etc2" TP_DATA_DIR="$tmp/var2" run --package "$tmp/b" && status=0 || status=$?
check '已有运行记录时不生成空配置' '[[ $status -eq 0 && ! -e "$tmp/etc2/config.json" ]] && grep -q "已有运行记录但没有 config.json" "$tmp/out"'

# Login password: one line on stdin outside a terminal; only the digest lands, private, and older page sessions go.
printf 'test-password-123\n' | run --set-password && status=0 || status=$?
check '非终端没有 --password-stdin 时不读密码' '[[ $status -ne 0 && ! -e "$TP_CONF_DIR/login-password" ]] && grep -q "加 --password-stdin" "$tmp/out"'
printf 'short\n' | run --set-password --password-stdin && status=0 || status=$?
check '过短的登录密码被拒' '[[ $status -ne 0 && ! -e "$TP_CONF_DIR/login-password" ]] && grep -q "至少 8 个字符" "$tmp/out"'
: >"$TP_DATA_DIR/http-session"
printf 'wrong-check-123\n' | run --package "$tmp/c" --set-password --password-stdin && status=0 || status=$?
check '配置检查失败时撤销新密码、不作废会话' '[[ $status -ne 0 && ! -e "$TP_CONF_DIR/login-password" && -e "$TP_DATA_DIR/http-session" ]] && grep -q "已恢复设置密码前的配置文件" "$tmp/out"'
current_before=$(readlink -f "$TP_APP_DIR/current")
# No --version or --package: the installed release is kept, nothing is fetched (TP_RELEASE_BASE points nowhere).
printf 'test-password-123\n' | TP_RELEASE_BASE=https://127.0.0.1:9/none run --set-password --password-stdin && status=0 || status=$?
check '只改密码时沿用已装版本、不联网' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]] && grep -q "程序包（未变化）" "$tmp/out"'
check '设置登录密码只存摘要且为 600' '[[ $status -eq 0 && "$(stat -c %a "$TP_CONF_DIR/login-password")" == 600 ]] && grep -q "^scrypt:32768:8:1:" "$TP_CONF_DIR/login-password" && ! grep -q "test-password-123" "$TP_CONF_DIR/login-password" "$tmp/out"'
check '设置密码后旧会话作废、配置检查与提示认出密码' '[[ ! -e "$TP_DATA_DIR/http-session" ]] && grep -q "登录密码已设置" "$tmp/out" && grep -q "用登录密码登录" "$tmp/out" && grep -q "登录密码（已打开的页面须重新登录）" "$tmp/out"'
"$TP_NODE_BIN" -e 'const fs = require("fs"), p = process.argv[1], c = JSON.parse(fs.readFileSync(p, "utf8")); c.host = "100.64.0.5"; fs.writeFileSync(p, JSON.stringify(c, null, 2));' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '配置 host 后直接给出页面地址' '[[ $status -eq 0 ]] && grep -q "监听 127.0.0.1 与 100.64.0.5，登录密码已设置" "$tmp/out" && grep -q "注意：100.64.0.5 现在不在本机网卡上" "$tmp/out" && grep -q "页面：http://100.64.0.5:4720/ ，用登录密码登录" "$tmp/out"'
"$TP_NODE_BIN" -e 'const fs = require("fs"), p = process.argv[1], c = JSON.parse(fs.readFileSync(p, "utf8")); c.host = "0.0.0.0"; fs.writeFileSync(p, JSON.stringify(c, null, 2));' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '通配监听地址被配置检查拒绝' '[[ $status -ne 0 ]] && grep -q "不能是 0.0.0.0" "$tmp/out"'

if ((failures)); then printf '%d 项失败；最后一次输出：\n' "$failures"; cat "$tmp/out"; exit 1; fi
printf '安装测试全部通过\n'
