#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # checks are eval-ed later on purpose
# Runs install.sh as an ordinary user in test mode (temporary directories, no system account, no systemctl):
# first install without config, unchanged rerun, permission repair, a config the new program rejects, an upgrade,
# the watchdog heartbeat's switches, and a deterministic package. The systemd start, health check and rollback run separately in test-platform-systemd.sh.
# An optional part (1, 2 or 3) runs only that group after the shared setup and first install, so CI can run the three
# groups in parallel: 1 install, upgrade, password and listen address; 2 importing from the workbench; 3 the watchdog
# heartbeat. With no argument all of them run in file order.
set -euo pipefail
part=${1:-all}
[[ $part =~ ^(all|1|2|3)$ ]] || { printf '用法：%s [1|2|3]\n' "$0" >&2; exit 2; }
part_is() { [[ $part == all || $part == "$1" ]]; }
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export TP_TEST_MODE=1 TP_NODE_BIN TP_APP_DIR="$tmp/opt" TP_CONF_DIR="$tmp/etc" TP_DATA_DIR="$tmp/var" TP_UNIT_FILE="$tmp/unit.service" TP_IMPORT_DIR="$tmp/import" TP_UPDATE_DIR="$tmp/update"
TP_NODE_BIN=$(command -v node)
# Every install.sh run starts node on the same release files; the compile cache saves re-parsing them each time.
export NODE_COMPILE_CACHE=${NODE_COMPILE_CACHE:-$tmp/node-compile-cache}
install_sh="$root/deploy/install.sh"
failures=0
check() { if eval "$2"; then printf 'ok   %s\n' "$1"; else printf 'FAIL %s\n' "$1"; if [[ -f "$tmp/out" ]]; then tail -n 8 "$tmp/out"; fi; failures=$((failures + 1)); fi; }
run() { bash "$install_sh" "$@" >"$tmp/out" 2>&1; }

bash "$root/deploy/package.sh" "$tmp/a" >/dev/null
if part_is 1; then
bash "$root/deploy/package.sh" "$tmp/a2" >/dev/null
check '同一源码打出的包校验和相同' 'cmp -s "$tmp/a/SHA256SUMS" "$tmp/a2/SHA256SUMS"'
tar -tzf "$tmp/a/trading-platform.tar.gz" >"$tmp/a.list"
check '发布包含构建好的页面' 'grep -q "/web/dist/index.html$" "$tmp/a.list" && grep -q "/web/dist/assets/.*\.js$" "$tmp/a.list"'
check '发布包含 Var 请求脚本（行情监控 M-3d）' 'grep -q "/scripts/variational-request.py$" "$tmp/a.list"'
check '发布包含行情服务、探针、单元和独立组件摘要' '[[ $(grep -Exc "trading-platform/(src/market/(main|probe)\.ts|deploy/trading-platform-market\.service|\.market-sha256)" "$tmp/a.list") == 4 ]]'
check '发布包含原表转换脚本（资产 A-6）' 'grep -q "/scripts/import-workbook.py$" "$tmp/a.list"'
check '发布文件含副服务器巡检的安装脚本与程序，且与源码、校验清单一致' 'cmp -s "$root/deploy/install-watch.sh" "$tmp/a/install-watch.sh" && cmp -s "$root/deploy/main-watch/main_watch.py" "$tmp/a/main_watch.py" && (cd "$tmp/a" && sha256sum -c --quiet SHA256SUMS) && [[ "$(wc -l <"$tmp/a/SHA256SUMS")" == 4 ]]'
fi

if part_is 1; then
# A second package with different contents, for the upgrade.
mkdir -p "$tmp/src-b/deploy/main-watch" && cp "$root/deploy/main-watch/main_watch.py" "$tmp/src-b/deploy/main-watch/"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-b/"
mkdir -p "$tmp/src-b/web" && cp -R "$root/web/dist" "$tmp/src-b/web/"
mkdir -p "$tmp/src-b/scripts" && cp "$root/scripts/variational-balance.py" "$root/scripts/variational-request.py" "$root/scripts/import-workbook.py" "$tmp/src-b/scripts/"
cp "$root/deploy/"{package.sh,component-digests.mjs,install.sh,install-watch.sh,trading-platform.service,trading-platform-control.service,trading-platform-market.service,trading-platform-import.service,trading-platform-import.path,trading-platform-update.service,trading-platform-update.path,config.example.json,secrets.example.json} "$tmp/src-b/deploy/"
printf '\n升级测试\n' >>"$tmp/src-b/README.md"
bash "$tmp/src-b/deploy/package.sh" "$tmp/b" >/dev/null
fi
# A program whose config check always fails, used by every part: the files a run changes are put back, the old release stays current.
mkdir -p "$tmp/src-c/deploy/main-watch" && cp "$root/deploy/main-watch/main_watch.py" "$tmp/src-c/deploy/main-watch/"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-c/"
mkdir -p "$tmp/src-c/web" && cp -R "$root/web/dist" "$tmp/src-c/web/"
mkdir -p "$tmp/src-c/scripts" && cp "$root/scripts/variational-balance.py" "$root/scripts/variational-request.py" "$root/scripts/import-workbook.py" "$tmp/src-c/scripts/"
cp "$root/deploy/"{package.sh,component-digests.mjs,install.sh,install-watch.sh,trading-platform.service,trading-platform-control.service,trading-platform-market.service,trading-platform-import.service,trading-platform-import.path,trading-platform-update.service,trading-platform-update.path,config.example.json,secrets.example.json} "$tmp/src-c/deploy/"
sed -i "s|if (values\['check-config'\]) {|if (values['check-config']) { throw new Error('测试：配置检查失败');|" "$tmp/src-c/src/service/main.ts"
bash "$tmp/src-c/deploy/package.sh" "$tmp/c" >/dev/null

run --package "$tmp/a" && status=0 || status=$?
check '首次安装成功' '[[ $status -eq 0 ]]'
check '首次安装生成空配置并通过检查' 'grep -q "\"pairs\": \[\]" "$TP_CONF_DIR/config.json" && [[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]] && grep -q "配置有效：0 个配对（尚未导入）" "$tmp/out"'
check '首次安装提示在页面导入' 'grep -q "下一步：在页面「从工作台导入配对」" "$tmp/out"'
check '导入目录权限 770' '[[ "$(stat -c %a "$TP_IMPORT_DIR")" == 770 ]]'
check '导入助手单元已填入路径' '! grep -q "@" "$tmp/trading-platform-import.service" "$tmp/trading-platform-import.path" && grep -q "PathExists=$TP_IMPORT_DIR/request.json" "$tmp/trading-platform-import.path" && grep -q "ExecStart=$(command -v flock) -w 100 $TP_APP_DIR/.install.lock $TP_NODE_BIN $TP_APP_DIR/current/src/service/import-helper.ts --dir $TP_IMPORT_DIR --config $TP_CONF_DIR/config.json --data-dir $TP_DATA_DIR" "$tmp/trading-platform-import.service" && grep -q "ExecStopPost=$(command -v flock) -w 60 $TP_APP_DIR/.install.lock $TP_NODE_BIN $TP_APP_DIR/current/src/service/import-helper.ts --recover --dir $TP_IMPORT_DIR" "$tmp/trading-platform-import.service"'
check '在线更新助手单元已填入路径（docs/update.md）' '! grep -q "@" "$tmp/trading-platform-update.service" "$tmp/trading-platform-update.path" && grep -q "PathExists=$TP_UPDATE_DIR/update-request.json" "$tmp/trading-platform-update.path" && grep -q "ExecStart=$TP_NODE_BIN $TP_APP_DIR/current/src/service/update-helper.ts --dir $TP_UPDATE_DIR --app-dir $TP_APP_DIR --data-dir $TP_DATA_DIR --request-uid $(id -u) --request-gid $(id -g)$" "$tmp/trading-platform-update.service" && grep -q "ExecStopPost=$TP_NODE_BIN $TP_APP_DIR/current/src/service/update-helper.ts --recover --dir $TP_UPDATE_DIR --app-dir $TP_APP_DIR --data-dir $TP_DATA_DIR --request-uid $(id -u) --request-gid $(id -g)$" "$tmp/trading-platform-update.service"'
check '测试模式不写在线更新就绪标记（只在 systemd 启用 .path 后写）' '[[ ! -e "$TP_APP_DIR/.update-helper" && ! -e "$TP_IMPORT_DIR/.update-helper" ]]'
check '当前版本指向新包' '[[ -f "$TP_APP_DIR/current/src/service/main.ts" ]]'
check '示例配置已放入' '[[ -f "$TP_CONF_DIR/config.example.json" && -f "$TP_CONF_DIR/secrets.example.json" ]]'
check '数据目录权限 700' '[[ "$(stat -c %a "$TP_DATA_DIR")" == 700 ]]'
check 'systemd 单元已填入路径' '! grep -q "@" "$TP_UNIT_FILE" && grep -q "ExecStart=$TP_NODE_BIN $TP_APP_DIR/executor/src/service/main.ts --config $TP_CONF_DIR/config.json --data-dir $TP_DATA_DIR --import-dir $TP_IMPORT_DIR --socket /run/trading-platform/execution.sock" "$TP_UNIT_FILE" && grep -q "ReadWritePaths=$TP_DATA_DIR -$TP_IMPORT_DIR" "$TP_UNIT_FILE"'
check '行情单元只接收专用环境，通过独立通信组向执行账户提供套接字' '! grep -q "@" "$tmp/trading-platform-market.service" && grep -Fqx "Group=trading-platform-market-ipc" "$tmp/trading-platform-market.service" && grep -Fqx "ExecStart=$TP_NODE_BIN $TP_APP_DIR/market/src/market/main.ts --socket /run/trading-platform-market/market.sock" "$tmp/trading-platform-market.service" && grep -Fqx "EnvironmentFile=-$TP_APP_DIR/market.env" "$tmp/trading-platform-market.service" && grep -Fq -- "--market-socket /run/trading-platform-market/market.sock" "$TP_UNIT_FILE" && [[ $(stat -c %a "$TP_APP_DIR/market.env") == 600 ]]'
first=$(readlink -f "$TP_APP_DIR/current")

if part_is 1; then
for unsafe_queue in "$TP_APP_DIR/releases" "$TP_APP_DIR/runtime/updates" "$TP_CONF_DIR/queue" "$TP_DATA_DIR/queue" "$TP_IMPORT_DIR/queue" "/run/trading-platform-market/update" "$tmp"; do
  before_mode=$(stat -c '%u:%g %a' "$unsafe_queue" 2>/dev/null || echo absent)
  TP_UPDATE_DIR="$unsafe_queue" run --package "$tmp/a" && status=0 || status=$?
  check '拒绝更新交接目录与运行目录重叠且保持其权限' '[[ $status -ne 0 && "$(stat -c "%u:%g %a" "$unsafe_queue" 2>/dev/null || echo absent)" == "$before_mode" ]] && grep -q "更新交接目录须与" "$tmp/out"'
done
unsafe_queue="$TP_DATA_DIR/legacy-queue"
TP_DATA_DIR="$tmp/other-data" TP_UPDATE_DIR="$unsafe_queue" run --package "$tmp/a" && status=0 || status=$?
check '修改目录参数时保护已安装单元的交易数据目录' '[[ $status -ne 0 && ! -e "$TP_DATA_DIR/legacy-queue" ]] && grep -q "更新交接目录须与" "$tmp/out"'
run --package "$tmp/a"
check '重复执行无变化' 'grep -q "无变化" "$tmp/out" && grep -q "程序包（未变化）" "$tmp/out" && grep -q "systemd 单元（未变化）" "$tmp/out"'
cat >"$TP_CONF_DIR/environment" <<'ENV'
NO_PROXY=localhost
COINGECKO_DEMO_API_KEY=first
PERPETUAL_COIN_IDS='{"BTC":"bitcoin"}'
PRIVATE_QUOTED='line one
HTTPS_PROXY=private-marker
COINGECKO_DEMO_API_KEY=private-marker
line four'
PRIVATE_CONTINUED=line-one\
HTTP_PROXY=private-marker
ENV
run --package "$tmp/a"
check '代理与公开行情变量分别投影，私有多行配置留在执行面' 'grep -Fxq "COINGECKO_DEMO_API_KEY=first" "$TP_APP_DIR/market.env" && [[ $(wc -l <"$TP_APP_DIR/market.env") == 3 && $(cat "$TP_APP_DIR/control-proxy.env") == "NO_PROXY=localhost" ]] && ! grep -q private-marker "$TP_APP_DIR/control-proxy.env" "$TP_APP_DIR/market.env"'
cp "$TP_APP_DIR/.deployment/executor-key" "$tmp/exec.env.before"
cp "$TP_APP_DIR/.deployment/control-key" "$tmp/control.env.before"
cp "$TP_APP_DIR/.deployment/market-key" "$tmp/market.env.before"
sed -i 's/^COINGECKO_DEMO_API_KEY=first$/COINGECKO_DEMO_API_KEY=second/' "$TP_CONF_DIR/environment"
run --package "$tmp/a"
check '只改公开行情键时只有行情组件配置摘要变化' 'cmp -s "$TP_APP_DIR/.deployment/executor-key" "$tmp/exec.env.before" && cmp -s "$TP_APP_DIR/.deployment/control-key" "$tmp/control.env.before" && ! cmp -s "$TP_APP_DIR/.deployment/market-key" "$tmp/market.env.before"'
rm "$TP_CONF_DIR/environment"
run --package "$tmp/a"
fi

if part_is 1; then
# Arming the page helpers (docs/update.md) against a stand-in systemctl: units are neither enabled nor active, `enable`
# fails for the units listed in TP_FAKE_FAIL. The update helper's marker goes into the root-owned program directory.
mkdir -p "$tmp/fakebin"
cat >"$tmp/fakebin/systemctl" <<'EOS'
#!/usr/bin/env bash
case $1 in
  is-enabled|is-active) exit 1 ;;
  enable) for unit in ${TP_FAKE_FAIL:-}; do [[ ${!#} == "$unit" ]] && exit 1; done; exit 0 ;;
  *) exit 0 ;;
esac
EOS
chmod +x "$tmp/fakebin/systemctl"
arm() { PATH="$tmp/fakebin:$PATH" TP_TEST_ARM=1 run "$@"; }
arm --package "$tmp/a" && status=0 || status=$?
check '启用在线更新助手后在程序目录写就绪标记（644），交接目录里没有' '[[ $status -eq 0 && -f "$TP_APP_DIR/.update-helper" && ! -L "$TP_APP_DIR/.update-helper" && "$(stat -c %a "$TP_APP_DIR/.update-helper")" == 644 && ! -e "$TP_IMPORT_DIR/.update-helper" ]] && grep -q "页面在线更新" "$tmp/out"'
TP_FAKE_FAIL=trading-platform-update.path arm --package "$tmp/a" && status=0 || status=$?
check '在线更新助手启用失败时删掉就绪标记，安装照常成功' '[[ $status -eq 0 && ! -e "$TP_APP_DIR/.update-helper" ]] && grep -q "无法设置 trading-platform-update.path 开机自启，页面在线更新暂不可用" "$tmp/out"'
arm --package "$tmp/a" >/dev/null && [[ -f "$TP_APP_DIR/.update-helper" ]]
# A release from before the online update (no update-helper.ts): the marker goes, the units stay.
mkdir -p "$tmp/src-d" && cp -R "$tmp/src-b/." "$tmp/src-d/" && rm "$tmp/src-d/src/service/update-helper.ts"
printf '\n没有在线更新助手\n' >>"$tmp/src-d/README.md"
bash "$tmp/src-d/deploy/package.sh" "$tmp/d" >/dev/null
arm --package "$tmp/d" && status=0 || status=$?
check '装没有在线更新助手的版本时删掉就绪标记、保留单元' '[[ $status -eq 0 && ! -e "$TP_APP_DIR/.update-helper" && -f "$tmp/trading-platform-update.path" ]]'
run --package "$tmp/a" >/dev/null || true
fi

# Test-only keys from the ASTER stand-in.
(cd "$root" && node --input-type=module -e '
  const { MAIN, LONG, SHORT } = await import("./test/aster-fake.ts");
  process.stdout.write(JSON.stringify({ accounts: { main: MAIN, "long-1": LONG, "short-1": SHORT } }));') >"$TP_CONF_DIR/secrets.json"
# The example's ASTER part only: its oil block needs Binance/Bybit keys, which the ASTER-only checks below do not cover;
# its monitor block would read the exchanges' public market data during the test.
node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); delete c.oil; delete c.monitor; c.secretsFile = process.argv[2]; process.stdout.write(JSON.stringify(c, null, 2));' "$root/deploy/config.example.json" "$TP_CONF_DIR/secrets.json" >"$TP_CONF_DIR/config.json"
chmod 644 "$TP_CONF_DIR/config.json" "$TP_CONF_DIR/secrets.json"
run --package "$tmp/a" && status=0 || status=$?
check '写好配置后执行成功' '[[ $status -eq 0 ]]'
check '配置经新程序校验' 'grep -q "配置有效：1 个配对（pair-1），3 个账户，端口 4720，飞书未配置" "$tmp/out"'
check '配置检查同时载入页面' 'grep -Eq "页面 [1-9][0-9]* 个文件" "$tmp/out"'
check '配置与密钥改为 600' '[[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '输出 SSH 隧道说明' 'grep -q "ssh -N -L 4720:127.0.0.1:4720" "$tmp/out"'

if part_is 1; then
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
fi

if part_is 2; then
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
cp -p "$TP_CONF_DIR/config.json" "$tmp/config.before"; cp -p "$TP_CONF_DIR/secrets.json" "$tmp/secrets.before"
current_before=$(readlink -f "$TP_APP_DIR/current")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/c" --import-workbench && status=0 || status=$?
check '导入后检查失败时恢复导入前的配置' '[[ $status -ne 0 ]] && grep -q "导入配对 wb-gold" "$tmp/out" && grep -q "已恢复导入前的配置文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json" && [[ "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '导入后检查失败时仍是原版本' '[[ "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]]'
# Stopped by a signal while the new program checks the imported files: they are put back all the same.
mkdir -p "$tmp/src-d/deploy/main-watch" && cp "$root/deploy/main-watch/main_watch.py" "$tmp/src-d/deploy/main-watch/"
cp -R "$root/src" "$root/package.json" "$root/README.md" "$tmp/src-d/"
mkdir -p "$tmp/src-d/web" && cp -R "$root/web/dist" "$tmp/src-d/web/"
mkdir -p "$tmp/src-d/scripts" && cp "$root/scripts/variational-balance.py" "$root/scripts/variational-request.py" "$root/scripts/import-workbook.py" "$tmp/src-d/scripts/"
cp "$root/deploy/"{package.sh,component-digests.mjs,install.sh,install-watch.sh,trading-platform.service,trading-platform-control.service,trading-platform-market.service,trading-platform-import.service,trading-platform-import.path,trading-platform-update.service,trading-platform-update.path,config.example.json,secrets.example.json} "$tmp/src-d/deploy/"
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
run --package "$tmp/a" --oil && status=0 || status=$?
check '--oil 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--oil 须和 --import-workbench 一起使用" "$tmp/out"'
# The workbench's oil execution account (hub.sqlite, encrypted with credentials.key) comes over beside the pairs.
(cd "$root" && node --input-type=module -e '
  const { DatabaseSync } = await import("node:sqlite");
  const { randomBytes, createCipheriv } = await import("node:crypto");
  const { writeFileSync } = await import("node:fs");
  const [dir] = process.argv.slice(1);
  const key = randomBytes(32);
  writeFileSync(dir + "/data/credentials.key", key, { mode: 0o600 });
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64"); };
  const db = new DatabaseSync(dir + "/data/hub.sqlite");
  db.exec("CREATE TABLE execution_accounts (exchange TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, credentials TEXT, account_mode TEXT NOT NULL, identity TEXT)");
  db.prepare("INSERT INTO execution_accounts VALUES (?, ?, ?, ?, ?)").run("binance", 2, encrypt({ purpose: "execution", exchange: "binance", apiKey: "k".repeat(64), apiSecret: "s".repeat(64) }), "standard", "123456789");
  db.prepare("INSERT INTO execution_accounts VALUES (?, ?, ?, ?, ?)").run("okx", 1, encrypt({ purpose: "execution", exchange: "okx", apiKey: "q".repeat(36), apiSecret: "w".repeat(32), passphrase: "Pp-" + "z".repeat(12) }), "cross", "5551234567");
  db.close();
' "$tmp/wb")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --oil && status=0 || status=$?
check '--oil 导入原油执行账户并通过配置检查' '[[ $status -eq 0 ]] && grep -q "导入原油执行账户 Binance standard 账户 \*\*\*6789" "$tmp/out" && grep -q "原油执行账户 Binance \*\*\*6789（standard，凭据版本 2）" "$tmp/out" && grep -q "不设名义金额上限" "$tmp/out" && ! grep -q "notionalLimits" "$TP_CONF_DIR/config.json"'
check '--oil 一并导入 OKX 执行账户（带 Passphrase）' 'grep -q "导入原油执行账户 OKX cross 账户 \*\*\*4567，凭据版本 1" "$tmp/out" && grep -q "OKX \*\*\*4567（cross，凭据版本 1）" "$tmp/out" && grep -q "\"passphrase\": \"Pp-zzzzzzzzzzzz\"" "$TP_CONF_DIR/secrets.json"'
check '导入原油账户的输出不含密钥' '! grep -q "kkkkkkkk\|ssssssss\|qqqqqqqq\|wwwwwwww\|zzzzzzzz" "$tmp/out"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --oil && status=0 || status=$?
check '重复导入原油账户保留现有设置' '[[ $status -eq 0 ]] && grep -q "已在本项目配置中，保留现有设置" "$tmp/out" && grep -q "没有新的原油执行账户，配置未改动" "$tmp/out"'
run --package "$tmp/a" --options && status=0 || status=$?
check '--options 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--options 须和 --import-workbench 一起使用" "$tmp/out"'
# The workbench here has no options key: the account is skipped with the reason and nothing else changes.
cp "$TP_CONF_DIR/config.json" "$tmp/config.before"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --options && status=0 || status=$?
check '--options 在工作台没有期权密钥时跳过且不改配置' '[[ $status -eq 0 ]] && grep -q "跳过期权账户：工作台期权模块没有配置 Bybit 密钥" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json"'
run --package "$tmp/a" --monitor && status=0 || status=$?
check '--monitor 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--monitor 须和 --import-workbench 一起使用" "$tmp/out"'
run --package "$tmp/a" --monitor-alerts && status=0 || status=$?
check '--monitor-alerts 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--monitor-alerts 须和 --import-workbench 一起使用" "$tmp/out"'
run --package "$tmp/a" --monitor-variational && status=0 || status=$?
check '--monitor-variational 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--monitor-variational 须和 --import-workbench 一起使用" "$tmp/out"'
run --package "$tmp/a" --monitor-paper && status=0 || status=$?
check '--monitor-paper 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--monitor-paper 须和 --import-workbench 一起使用" "$tmp/out"'
run --package "$tmp/a" --asset && status=0 || status=$?
check '--asset 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--asset 须和 --import-workbench 一起使用" "$tmp/out"'
run --package "$tmp/a" --import-workbench --asset-owner alice && status=0 || status=$?
check '--asset-owner 须和 --asset 一起用' '[[ $status -ne 0 ]] && grep -q -- "--asset-owner 须和 --asset 一起使用" "$tmp/out"'
# The workbench's asset ledger with two users (alice and bob); the import copies one of them into the data directory.
# Enabling the monitor here is safe: only --check-config runs in test mode, which reads no market data.
mkdir -p "$tmp/wb/data/modules/asset"
(cd "$root" && node --input-type=module -e '
  const { writeWorkbenchLedger } = await import("./test/asset-fixture.ts");
  writeWorkbenchLedger(process.argv[1]);
' "$tmp/wb/data/modules/asset/ledger.sqlite")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor --asset && status=0 || status=$?
check '账本有多个用户时须指定 --asset-owner，不改任何文件' '[[ $status -ne 0 && ! -e "$TP_DATA_DIR/asset.sqlite" ]] && grep -q "有多个用户（alice、bob），请用 --asset-owner <用户> 指定，未改动任何文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor --asset --asset-owner alice && status=0 || status=$?
check '--monitor --asset 启用行情监控、导入资产账本并通过配置检查' '[[ $status -eq 0 ]] && grep -q "启用行情监控 Anthropic 价差" "$tmp/out" && grep -q "已写入资产账本 $TP_DATA_DIR/asset.sqlite：用户 alice" "$tmp/out" && grep -q "行情监控 Anthropic 价差（流通股 13.116 十亿" "$tmp/out" && grep -q "资产账本已启用" "$tmp/out"'
check '导入的资产账本仅服务账户可读写且不含凭据' '[[ "$(stat -c %a "$TP_DATA_DIR/asset.sqlite")" == 600 ]] && ! grep -q "ciphertext-\|tail-k3y9" "$TP_DATA_DIR/asset.sqlite" "$tmp/out"'
cp "$TP_CONF_DIR/config.json" "$tmp/config.before"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor --asset --asset-owner bob && status=0 || status=$?
check '重复导入只替换资产账本、保留配置' '[[ $status -eq 0 ]] && grep -q "已写入资产账本 $TP_DATA_DIR/asset.sqlite：用户 bob" "$tmp/out" && grep -q "配置未改动（资产账本已启用，只重新导入了账本" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json"'
# The workbench's market alerts (M-3b): the oil tiers and the one robot come over; Hynix has no file here.
mkdir -p "$tmp/wb/data/modules/monitor/oil"
printf '%s' '{"schemaVersion":1,"config":{"enabled":true,"rules":[{"id":"r1","label":"价差 5","metric":"spread","operator":"gte","threshold":5,"cooldownMinutes":30,"hysteresis":0.1,"enabled":true}]}}' >"$tmp/wb/data/modules/monitor/oil/monitor.json"
printf '%s' '{"version":1,"config":{"webhookUrl":"https://open.feishu.cn/open-apis/bot/v2/hook/install-test-hook-0001","signingSecret":"install-sign-0001"},"candidates":[]}' >"$tmp/wb/data/modules/monitor/notifications.json"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-alerts && status=0 || status=$?
check '--monitor-alerts 导入原油档位与机器人并通过配置检查' '[[ $status -eq 0 ]] && grep -q "导入行情告警：替换本服务的原油 1 档" "$tmp/out" && grep -q "已写入告警档位（原油 1 档）" "$tmp/out" && grep -q "海力士告警 未导入：工作台没有 hynix/alerts.json" "$tmp/out" && grep -q "\"feishuMonitor\"" "$TP_CONF_DIR/secrets.json" && [[ -f "$TP_DATA_DIR/monitor.sqlite" ]]'
check '导入告警的输出不含机器人地址与签名' '! grep -q "install-test-hook\|install-sign" "$tmp/out"'
# The workbench's Var token (M-3d-2): mode 644 is refused as the workbench refuses it; at 600 it comes over, privately.
var_token=$(cd "$root" && node --input-type=module -e 'const { fakeVariationalToken } = await import("./test/monitor-fake.ts"); process.stdout.write(fakeVariationalToken(Date.now() + 86400000, "install"));')
printf '{"version":1,"revision":3,"token":"%s","updatedAt":"2026-11-14T00:00:00.000Z"}\n' "$var_token" >"$tmp/wb/data/modules/monitor/variational-session.json"
chmod 644 "$tmp/wb/data/modules/monitor/variational-session.json"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-variational && status=0 || status=$?
check '--monitor-variational 不导入权限不是 600 的 token 文件' '[[ $status -eq 0 && ! -e "$TP_DATA_DIR/monitor-variational-session.json" ]] && grep -q "跳过 Var token：variational-session.json 权限不是 600" "$tmp/out"'
chmod 600 "$tmp/wb/data/modules/monitor/variational-session.json"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-variational && status=0 || status=$?
check '--monitor-variational 导入 token、仅服务账户可读写且输出不含 token' '[[ $status -eq 0 && "$(stat -c %a "$TP_DATA_DIR/monitor-variational-session.json")" == 600 ]] && grep -q "已写入Var token（版本 1，声明到期" "$tmp/out" && grep -q "$var_token" "$TP_DATA_DIR/monitor-variational-session.json" && ! grep -q "$var_token" "$tmp/out"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-variational && status=0 || status=$?
check '重复导入同一个 Var token 时跳过' '[[ $status -eq 0 ]] && grep -q "跳过 Var token：本服务的 Var token 声明到期" "$tmp/out" && grep -q "\"revision\":1," "$TP_DATA_DIR/monitor-variational-session.json"'
# The workbench's paper records (M-5e2): written to the pending file only, which the service merges on its next check.
mkdir -p "$tmp/wb/data/modules/monitor/perpetual"
(cd "$root" && node --input-type=module -e '
  const { writeFileSync } = await import("node:fs");
  const { paperPosition, paperState } = await import("./test/monitor-paper-fixture.ts");
  writeFileSync(process.argv[1], JSON.stringify(paperState([paperPosition("install-a1"), paperPosition("install-s1", { closedAt: Date.now() - 3600000 })])));
' "$tmp/wb/data/modules/monitor/perpetual/paper-positions.json")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-paper && status=0 || status=$?
check '--monitor-paper 写待载入文件、仅服务账户可读写，不碰持仓记录' '[[ $status -eq 0 && "$(stat -c %a "$TP_DATA_DIR/perpetual-paper-positions.import.json")" == 600 && ! -e "$TP_DATA_DIR/perpetual-paper-positions.json" ]] && grep -q "已写入持仓记录 2 条（待载入文件）" "$tmp/out" && grep -q "install-s1" "$TP_DATA_DIR/perpetual-paper-positions.import.json"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --monitor-paper && status=0 || status=$?
check '重复导入持仓记录时跳过' '[[ $status -eq 0 ]] && grep -q "跳过持仓记录：本服务已有这些记录" "$tmp/out"'
# The workbench Ondo module (docs/ondo.md §8): its settings come over in observe mode; the key only once the workbench
# has no session record left, which the second import then adds to the module already enabled.
run --package "$tmp/a" --ondo && status=0 || status=$?
check '--ondo 须和 --import-workbench 一起用' '[[ $status -ne 0 ]] && grep -q -- "--ondo 须和 --import-workbench 一起使用" "$tmp/out"'
mkdir -p "$tmp/wb/data/ondo-mm"
(cd "$root" && node --input-type=module -e '
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { randomBytes, createCipheriv } = await import("node:crypto");
  const { ONDO_MM_DEFAULTS } = await import("./src/vendor/ondo/mm.mjs");
  const dir = process.argv[1], key = readFileSync(dir + "/credentials.key");
  const encrypt = value => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64"); };
  writeFileSync(dir + "/ondo-mm/config.json", JSON.stringify({ revision: 3, config: { ...ONDO_MM_DEFAULTS, mode: "live", markets: ["NVDA-USD.P", "TSLA-USD.P"], orderUsd: "250", maxPositionUsd: "250" } }));
  writeFileSync(dir + "/ondo-mm/credentials.json", JSON.stringify({ hint: "9876", value: encrypt({ keyId: "ondokey-install-9876", secret: "ondosecret-" + "x".repeat(24) }) }));
  writeFileSync(dir + "/ondo-mm/session.json", JSON.stringify({ startedAt: new Date().toISOString(), prefix: "omm-abc-" }));
' "$tmp/wb/data")
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --ondo && status=0 || status=$?
check '--ondo 在工作台仍有会话记录时只启用模块、不导入 API Key' '[[ $status -eq 0 ]] && grep -q "导入 Ondo 挂单奖励（未导入 API Key：工作台 Ondo 挂单仍在实盘" "$tmp/out" && grep -q "\"orderUsd\": \"250\"" "$TP_CONF_DIR/config.json" && grep -q "\"mode\": \"observe\"" "$TP_CONF_DIR/config.json" && ! grep -q "\"ondo\"" "$TP_CONF_DIR/secrets.json" && grep -q "Ondo 挂单奖励（未配置 API Key，只能观察）" "$tmp/out"'
rm "$tmp/wb/data/ondo-mm/session.json"
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --ondo && status=0 || status=$?
check '--ondo 在会话结束后补入 API Key、输出不含 Secret' '[[ $status -eq 0 ]] && grep -q "已在本项目配置中，补入 API Key \*\*\*9876" "$tmp/out" && grep -q "ondosecret-x" "$TP_CONF_DIR/secrets.json" && grep -q "Ondo 挂单奖励（API Key \*\*\*9876）" "$tmp/out" && ! grep -q "ondosecret" "$tmp/out"'
TP_WORKBENCH_ENV="$tmp/wb/workbench.env" run --package "$tmp/a" --import-workbench --ondo && status=0 || status=$?
check '重复导入 Ondo 时保留现有设置' '[[ $status -eq 0 ]] && grep -q "已在本项目配置中（含 API Key），保留现有设置" "$tmp/out" && grep -q "没有新的Ondo 挂单奖励，配置未改动" "$tmp/out"'
fi

if part_is 3; then
# The heartbeat for the second server's main-watch: the address lands in config.json, the token in the key file (from
# stdin, never printed), the new program checks both, and a failed check puts them back.
watch_token=watch-install-token-0123456789abcdefgh
watch_to=http://203.0.113.9:8792/heartbeat
run --package "$tmp/a" --watch-token "$watch_token" && status=0 || status=$?
check '--watch-token 须和 --watch-url 一起用' '[[ $status -ne 0 ]] && grep -q -- "--watch-token 须和 --watch-url 一起使用" "$tmp/out"'
run --package "$tmp/a" --watch-url "$watch_to" --watch-off && status=0 || status=$?
check '--watch-url 与 --watch-off 不能同用' '[[ $status -ne 0 ]] && grep -q "只能用一个" "$tmp/out"'
run --package "$tmp/a" --watch-url "$watch_to" --watch-token short-token && status=0 || status=$?
check '过短的心跳令牌被拒且不回显' '[[ $status -ne 0 ]] && grep -q "须为 32~256 位" "$tmp/out" && ! grep -q "short-token" "$tmp/out"'
cp -p "$TP_CONF_DIR/config.json" "$tmp/config.before"; cp -p "$TP_CONF_DIR/secrets.json" "$tmp/secrets.before"
run --package "$tmp/a" --watch-url "$watch_to" && status=0 || status=$?
check '没存过令牌时只给地址被拒，不改任何文件' '[[ $status -ne 0 ]] && grep -q "还没有保存过心跳令牌" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json"'
run --package "$tmp/a" --watch-url "ftp://203.0.113.9/heartbeat" --watch-token "$watch_token" && status=0 || status=$?
check '不是 http(s) 的心跳地址被拒，不改任何文件' '[[ $status -ne 0 ]] && grep -q "watch.url 须为" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json"'
current_before=$(readlink -f "$TP_APP_DIR/current")
run --package "$tmp/c" --watch-url "$watch_to" --watch-token "$watch_token" && status=0 || status=$?
check '开启心跳后配置检查失败时恢复两个文件、仍是原版本' '[[ $status -ne 0 ]] && grep -q "巡检心跳：每 30 秒推送到 $watch_to" "$tmp/out" && grep -q "已恢复设置巡检心跳前的配置文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json" && [[ "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]]'
run --package "$tmp/a" --watch-url "$watch_to" --watch-token "$watch_token" && status=0 || status=$?
check '--watch-url 写入地址与令牌并通过配置检查' '[[ $status -eq 0 ]] && grep -q "巡检心跳：每 30 秒推送到 $watch_to" "$tmp/out" && grep -q "，巡检心跳推送到 $watch_to" "$tmp/out" && [[ "$("$TP_NODE_BIN" -p "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).watch.url" "$TP_CONF_DIR/config.json")" == "$watch_to" && "$("$TP_NODE_BIN" -p "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).watch.token" "$TP_CONF_DIR/secrets.json")" == "$watch_token" ]]'
check '心跳令牌只在密钥文件里，两个文件仍为 600' '! grep -q "$watch_token" "$tmp/out" "$TP_CONF_DIR/config.json" && [[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '开启心跳不动其余配置' '[[ "$("$TP_NODE_BIN" -e "const f = p => { const v = JSON.parse(require(\"fs\").readFileSync(p, \"utf8\")); delete v.watch; return JSON.stringify(v); }; process.stdout.write(String(f(process.argv[1]) === f(process.argv[2]) && f(process.argv[3]) === f(process.argv[4])))" "$tmp/config.before" "$TP_CONF_DIR/config.json" "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json")" == true ]]'
run --package "$tmp/a" --watch-url "$watch_to" --watch-token "$watch_token" && status=0 || status=$?
check '重复开启心跳不改动配置' '[[ $status -eq 0 ]] && grep -q "巡检心跳已是推送到 $watch_to，配置未改动" "$tmp/out" && grep -q "无变化" "$tmp/out"'
run --package "$tmp/a" --watch-url http://203.0.113.10:8792/heartbeat && status=0 || status=$?
check '只换心跳地址时沿用已存的令牌' '[[ $status -eq 0 ]] && grep -q "，巡检心跳推送到 http://203.0.113.10:8792/heartbeat" "$tmp/out" && grep -q "\"token\": \"$watch_token\"" "$TP_CONF_DIR/secrets.json"'
TP_WATCH_SENDER="$tmp/none/sender" run --package "$tmp/a" --watch-import && status=0 || status=$?
check '--watch-import 找不到工作台推送端配置时说明改用 --watch-url' '[[ $status -ne 0 ]] && grep -q "没有找到工作台心跳推送端的配置" "$tmp/out" && grep -q "请改用 --watch-url 与 --watch-token" "$tmp/out"'
sender_token=sender-file-token-0123456789abcdefghij
printf 'HEARTBEAT_URL=http://203.0.113.11:8792/heartbeat\nHEARTBEAT_TOKEN=%s\nREADY_URL=http://127.0.0.1:3100/api/ready\nTIMEOUT=5\n' "$sender_token" >"$tmp/sender"
TP_WATCH_SENDER="$tmp/sender" run --package "$tmp/a" --watch-import && status=0 || status=$?
check '--watch-import 取工作台推送端的地址与令牌，输出不含令牌' '[[ $status -eq 0 ]] && grep -q "，巡检心跳推送到 http://203.0.113.11:8792/heartbeat" "$tmp/out" && grep -q "\"token\": \"$sender_token\"" "$TP_CONF_DIR/secrets.json" && ! grep -q "$sender_token" "$tmp/out"'
run --package "$tmp/a" --watch-off && status=0 || status=$?
check '--watch-off 去掉地址与令牌，配置回到开启前' '[[ $status -eq 0 ]] && grep -q "巡检心跳已关闭" "$tmp/out" && ! grep -q "巡检心跳推送到" "$tmp/out" && ! grep -q "\"watch\"" "$TP_CONF_DIR/config.json" "$TP_CONF_DIR/secrets.json" && [[ "$("$TP_NODE_BIN" -e "const f = p => JSON.stringify(JSON.parse(require(\"fs\").readFileSync(p, \"utf8\"))); process.stdout.write(String(f(process.argv[1]) === f(process.argv[2]) && f(process.argv[3]) === f(process.argv[4])))" "$tmp/config.before" "$TP_CONF_DIR/config.json" "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json")" == true ]]'
run --package "$tmp/a" --watch-off && status=0 || status=$?
check '重复关闭心跳不改动配置' '[[ $status -eq 0 ]] && grep -q "巡检心跳本来就没有开启，配置未改动" "$tmp/out"'
# No --version or --package: the installed release is kept, nothing is fetched (TP_RELEASE_BASE points nowhere).
current_before=$(readlink -f "$TP_APP_DIR/current")
TP_RELEASE_BASE=https://127.0.0.1:9/none run --watch-url "$watch_to" --watch-token "$watch_token" && status=0 || status=$?
check '只开心跳时沿用已装版本、不联网' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]] && grep -q "程序包（未变化）" "$tmp/out" && grep -q "，巡检心跳推送到 $watch_to" "$tmp/out"'
TP_RELEASE_BASE=https://127.0.0.1:9/none run --watch-off && status=0 || status=$?
check '只关心跳时沿用已装版本、不联网' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]] && grep -q "巡检心跳已关闭" "$tmp/out"'

# MEV arbitrage (docs/mev.md): the two addresses land in config.json, the node address and the hot wallet's key in the
# key file (from stdin, never printed), the new program checks both, and --unset-mev takes them out again.
mev_key=0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318
mev_executor=0x00000000000000000000000000000000004D4556
mev_owner=0x000000000000000000000000000000000000B0B0
mev_rpc=https://base.example.invalid/v2/rpc-key-secret
mev_field() { "$TP_NODE_BIN" -p "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")).mev?.[process.argv[2]] ?? \"\"" "$1" "$2"; }
cp -p "$TP_CONF_DIR/config.json" "$tmp/config.before"; cp -p "$TP_CONF_DIR/secrets.json" "$tmp/secrets.before"
run --package "$tmp/a" --mev-executor "$mev_executor" && status=0 || status=$?
check '--mev-executor 须和 --set-mev 一起用' '[[ $status -ne 0 ]] && grep -q -- "须和 --set-mev 一起使用" "$tmp/out"'
run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" </dev/null && status=0 || status=$?
check '--set-mev 缺地址被拒' '[[ $status -ne 0 ]] && grep -q "须同时给出 --mev-executor 与 --mev-owner" "$tmp/out"'
run --package "$tmp/a" --set-mev --unset-mev --mev-executor "$mev_executor" --mev-owner "$mev_owner" </dev/null && status=0 || status=$?
check '--set-mev 与 --unset-mev 不能同用' '[[ $status -ne 0 ]] && grep -q "只能用一个" "$tmp/out"'
run --package "$tmp/a" --set-mev --mev-executor "$mev_executor" --mev-owner "$mev_owner" </dev/null && status=0 || status=$?
check '不在终端且没有 --mev-stdin 时不读私钥' '[[ $status -ne 0 ]] && grep -q "加 --mev-stdin 从标准输入读三行" "$tmp/out"'
printf '%s\n\n%s\n' "$mev_rpc" not-a-key-0123 | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '格式不对的私钥被拒且不回显，不改任何文件' '[[ $status -ne 0 ]] && grep -q "mev 的私钥格式无效" "$tmp/out" && ! grep -q "not-a-key-0123\|rpc-key-secret" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json"'
printf '%s\n\n%s\n' "http://203.0.113.9:8545/rpc-key-secret" "$mev_key" | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '公网明文 http 的节点地址被拒且不回显' '[[ $status -ne 0 ]] && grep -q "节点地址须为 https 地址" "$tmp/out" && ! grep -q "rpc-key-secret\|203.0.113.9:8545" "$tmp/out" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json"'
printf '\n\n%s\n' "$mev_key" | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '第一次开启没给节点地址被拒' '[[ $status -ne 0 ]] && grep -q "还没有保存过节点地址" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json"'
printf '%s\n\n%s\n' "$mev_rpc" "$mev_key" | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_executor" && status=0 || status=$?
check '合约与 owner 同一地址被拒' '[[ $status -ne 0 ]] && grep -q "不能是同一个地址" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json"'
current_before=$(readlink -f "$TP_APP_DIR/current")
printf '%s\n\n%s\n' "$mev_rpc" "$mev_key" | run --package "$tmp/c" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '开启 MEV 后配置检查失败时恢复两个文件、仍是原版本' '[[ $status -ne 0 ]] && grep -q "已恢复设置 MEV 套利前的配置文件" "$tmp/out" && cmp -s "$tmp/config.before" "$TP_CONF_DIR/config.json" && cmp -s "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json" && [[ "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]]'
printf '%s\n\n%s\n' "$mev_rpc" "$mev_key" | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '--set-mev 写入地址、节点与私钥并通过配置检查' '[[ $status -eq 0 ]] && grep -q "MEV 套利：执行合约 0x00000000000000000000000000000000004d4556，利润收款 0x000000000000000000000000000000000000b0b0，热钱包 0x[0-9a-f]\{40\}，节点 base.example.invalid" "$tmp/out" && grep -q "，MEV 套利（Base，执行合约 0x0000…4556，热钱包 0x" "$tmp/out" && [[ "$(mev_field "$TP_CONF_DIR/config.json" executor)" == 0x00000000000000000000000000000000004d4556 && "$(mev_field "$TP_CONF_DIR/secrets.json" rpcUrl)" == "$mev_rpc" && "$(mev_field "$TP_CONF_DIR/secrets.json" privateKey)" == "$mev_key" ]]'
check '私钥与节点地址只在密钥文件里，两个文件仍为 600' '! grep -q "${mev_key#0x}\|rpc-key-secret" "$tmp/out" "$TP_CONF_DIR/config.json" && [[ "$(stat -c %a "$TP_CONF_DIR/config.json")" == 600 && "$(stat -c %a "$TP_CONF_DIR/secrets.json")" == 600 ]]'
check '开启 MEV 不动其余配置' '[[ "$("$TP_NODE_BIN" -e "const f = p => { const v = JSON.parse(require(\"fs\").readFileSync(p, \"utf8\")); delete v.mev; return JSON.stringify(v); }; process.stdout.write(String(f(process.argv[1]) === f(process.argv[2]) && f(process.argv[3]) === f(process.argv[4])))" "$tmp/config.before" "$TP_CONF_DIR/config.json" "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json")" == true ]]'
printf '%s\n\n%s\n' "$mev_rpc" "$mev_key" | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '重复开启 MEV 不改动配置' '[[ $status -eq 0 ]] && grep -q "与现有配置相同，未改动" "$tmp/out" && grep -q "无变化" "$tmp/out"'
printf '\nhttps://send.example.invalid/key-two\n\n' | run --package "$tmp/a" --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner 0x000000000000000000000000000000000000C0C0 && status=0 || status=$?
check '只换 owner 与发送节点时沿用已存的节点地址与私钥' '[[ $status -eq 0 ]] && grep -q "发送走 send.example.invalid" "$tmp/out" && ! grep -q "key-two" "$tmp/out" && [[ "$(mev_field "$TP_CONF_DIR/config.json" owner)" == 0x000000000000000000000000000000000000c0c0 && "$(mev_field "$TP_CONF_DIR/secrets.json" rpcUrl)" == "$mev_rpc" && "$(mev_field "$TP_CONF_DIR/secrets.json" privateKey)" == "$mev_key" && "$(mev_field "$TP_CONF_DIR/secrets.json" sendRpcUrl)" == https://send.example.invalid/key-two ]]'
printf '\n-\n\n' | TP_RELEASE_BASE=https://127.0.0.1:9/none run --set-mev --mev-stdin --mev-executor "$mev_executor" --mev-owner "$mev_owner" && status=0 || status=$?
check '只改 MEV 时沿用已装版本、不联网；- 去掉发送节点' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]] && grep -q "程序包（未变化）" "$tmp/out" && [[ -z "$(mev_field "$TP_CONF_DIR/secrets.json" sendRpcUrl)" ]]'
TP_RELEASE_BASE=https://127.0.0.1:9/none run --unset-mev && status=0 || status=$?
check '--unset-mev 去掉地址、节点与私钥，配置回到开启前' '[[ $status -eq 0 ]] && grep -q "MEV 套利已关闭" "$tmp/out" && ! grep -q "，MEV 套利（" "$tmp/out" && ! grep -q "\"mev\"" "$TP_CONF_DIR/config.json" "$TP_CONF_DIR/secrets.json" && [[ "$("$TP_NODE_BIN" -e "const f = p => JSON.stringify(JSON.parse(require(\"fs\").readFileSync(p, \"utf8\"))); process.stdout.write(String(f(process.argv[1]) === f(process.argv[2]) && f(process.argv[3]) === f(process.argv[4])))" "$tmp/config.before" "$TP_CONF_DIR/config.json" "$tmp/secrets.before" "$TP_CONF_DIR/secrets.json")" == true ]]'
run --package "$tmp/a" --unset-mev && status=0 || status=$?
check '重复关闭 MEV 不改动配置' '[[ $status -eq 0 ]] && grep -q "MEV 套利本来就没有开启，配置未改动" "$tmp/out"'
fi

if part_is 1; then
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
printf '{}\n' >"$TP_DATA_DIR/read-token.json"
printf 'wrong-check-123\n' | run --package "$tmp/c" --set-password --password-stdin && status=0 || status=$?
check '配置检查失败时撤销新密码、不作废会话与令牌' '[[ $status -ne 0 && ! -e "$TP_CONF_DIR/login-password" && -e "$TP_DATA_DIR/http-session" && -e "$TP_DATA_DIR/read-token.json" ]] && grep -q "已恢复设置密码前的配置文件" "$tmp/out"'
current_before=$(readlink -f "$TP_APP_DIR/current")
# No --version or --package: the installed release is kept, nothing is fetched (TP_RELEASE_BASE points nowhere).
printf 'test-password-123\n' | TP_RELEASE_BASE=https://127.0.0.1:9/none run --set-password --password-stdin && status=0 || status=$?
check '只改密码时沿用已装版本、不联网' '[[ $status -eq 0 && "$(readlink -f "$TP_APP_DIR/current")" == "$current_before" ]] && grep -q "程序包（未变化）" "$tmp/out"'
check '设置登录密码只存摘要且为 600' '[[ $status -eq 0 && "$(stat -c %a "$TP_CONF_DIR/login-password")" == 600 ]] && grep -q "^scrypt:32768:8:1:" "$TP_CONF_DIR/login-password" && ! grep -q "test-password-123" "$TP_CONF_DIR/login-password" "$tmp/out"'
check '设置密码后旧会话与只读令牌作废、配置检查与提示认出密码' '[[ ! -e "$TP_DATA_DIR/http-session" && ! -e "$TP_DATA_DIR/read-token.json" ]] && grep -q "登录密码已设置" "$tmp/out" && grep -q "用登录密码登录" "$tmp/out" && grep -q "登录密码（已打开的页面须重新登录，只读接口令牌已全部吊销）" "$tmp/out"'
"$TP_NODE_BIN" -e 'const fs = require("fs"), p = process.argv[1], c = JSON.parse(fs.readFileSync(p, "utf8")); c.host = "100.64.0.5"; fs.writeFileSync(p, JSON.stringify(c, null, 2));' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '配置 host 后直接给出页面地址' '[[ $status -eq 0 ]] && grep -q "监听 127.0.0.1 与 100.64.0.5，登录密码已设置" "$tmp/out" && grep -q "注意：100.64.0.5 现在不在本机网卡上" "$tmp/out" && grep -q "页面：http://100.64.0.5:4720/ ，用登录密码登录" "$tmp/out"'
"$TP_NODE_BIN" -e 'const fs = require("fs"), p = process.argv[1], c = JSON.parse(fs.readFileSync(p, "utf8")); c.host = "0.0.0.0"; fs.writeFileSync(p, JSON.stringify(c, null, 2));' "$TP_CONF_DIR/config.json"
run --package "$tmp/b" && status=0 || status=$?
check '通配监听地址被配置检查拒绝' '[[ $status -ne 0 ]] && grep -q "不能是 0.0.0.0" "$tmp/out"'
fi

if ((failures)); then printf '%d 项失败；最后一次输出：\n' "$failures"; cat "$tmp/out"; exit 1; fi
if [[ $part == all ]]; then printf '安装测试全部通过\n'; else printf '安装测试第 %s 部分通过\n' "$part"; fi
