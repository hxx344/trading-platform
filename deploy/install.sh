#!/usr/bin/env bash
# 统一交易平台：安装与升级（root 运行，可重复执行，保留配置与数据）。
#
#   curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
#   sudo bash install.sh --version v0.1.0     安装指定版本（也用于回退）
#   sudo bash install.sh --package <目录>     从本地目录安装（含 trading-platform.tar.gz 与 SHA256SUMS）
#   sudo bash install.sh --import-workbench   命令行方式从本机工作台导入已开启保证金平衡的配对与凭据并启动（可加 --pairs id,id
#                                             只导入指定配对，--workbench-data <目录> 指定工作台数据目录）；页面上也能导入，见下
#   sudo bash install.sh --import-workbench --oil
#                                             只导入工作台的原油执行账户（Binance / Bybit / OKX，hub.sqlite 解密）；同时导入配对时
#                                             再加 --pairs id,id。工作台有实盘启用的原油自动规则时拒绝导入该交易所账户
#   sudo bash install.sh --import-workbench --options
#                                             导入工作台期权模块（Greeks）的 Bybit 密钥与风险上限（可与 --oil、--pairs 同用）；
#                                             工作台开着自动开仓、不是实盘主网，或还有未结束的订单 / 任务 / RFQ / 跟踪策略时拒绝
#   sudo bash install.sh --import-workbench --monitor --asset [--asset-owner <用户>]
#                                             启用行情监控（股数取默认值），并把工作台资产账本导入本服务数据目录（账本有多个
#                                             用户时用 --asset-owner 指定）；两项可分开用，也可与 --oil、--options、--pairs 同用
#   sudo bash install.sh --import-workbench --monitor-alerts
#                                             同时启用行情监控，并导入工作台行情监控的原油 / 海力士告警档位（替换本服务现有档位）
#                                             与飞书机器人（写入 secrets.json 的 feishuMonitor）；回滚到 v0.29.x 前须先删掉 feishuMonitor
#   sudo bash install.sh --import-workbench --monitor-variational
#                                             同时启用行情监控，并导入工作台保存的 Var token（本服务没有、已过期或到期更早时替换；
#                                             运行中的服务下一次读取即用它，不重启）；可与 --monitor-alerts 同用
#   sudo bash install.sh --import-workbench --monitor-paper
#                                             同时启用行情监控，并导入工作台合约价差的模拟与手工持仓记录（本服务已有的保留；写入
#                                             待载入文件，运行中的服务下一次检查时载入，不重启）；可与 --monitor-alerts、--monitor-variational 同用
#   sudo bash install.sh --import-workbench --crossex
#                                             导入工作台 CrossEx 模块的 Gate 密钥、账户 UID 与额度（首次导入时连同页面设置）；
#                                             工作台未连接、还有未结束的执行 / 订单 / 挂单或缺 UID 时拒绝；可与其他导入项同用
#   sudo bash install.sh --import-workbench --ondo
#                                             启用 Ondo 挂单奖励：工作台 Ondo 挂单设置以观察模式带过来，工作台没有实盘会话记录时
#                                             一并导入 API Key（写入 secrets.json 的 ondo）；没有工作台 Ondo 数据时也可启用（只观察）
#   sudo bash install.sh --set-password       设置或更换页面登录密码（输入两次，不回显；只存 scrypt 摘要，已登录的页面须重新登录；
#                                             沿用当前已装版本，不联网升级；脚本化时加 --password-stdin 从标准输入读一行）
#   sudo bash install.sh --watch-url <地址> --watch-token <令牌>
#                                             开启副服务器巡检心跳：每 30 秒向副服务器 main-watch 的心跳地址（如 http://<副服务器 IP>:8792/heartbeat）
#                                             推送签名心跳；地址与令牌由副服务器的 install-watch.sh 打印。只换地址时可不带 --watch-token
#   sudo bash install.sh --watch-import       同上，地址与令牌取自本机工作台版本的心跳推送端配置 /etc/main-watch/sender，并停用那个推送端
#   sudo bash install.sh --watch-off          关闭巡检心跳（回退到 v0.46.0 及更早版本前须先执行）。这三项与 --set-password 一样
#                                             沿用当前已装版本、不联网升级（已装版本早于 v0.47.0 时先升级到最新版）
#
# 页面总在 127.0.0.1 监听（用 SSH 隧道打开）；在 config.json 写 "host": "<本机 Tailscale IP>" 后也在该地址监听，直接打开。
# 删除 /etc/trading-platform/login-password 再执行本脚本即取消密码，只能用数据目录 access-url 里的链接登录。
#
# 首次安装写入不含配对的空配置并启动服务；之后在本机页面「从工作台导入配对」里选择导入（由随本脚本安装的 root 导入助手
# trading-platform-import.path/.service 执行，写好配置后自动重启服务）。已有配置只追加新配对，导入的配对登记为停用。
# 之后每次执行：先只下载校验清单，程序包、Node.js、systemd 单元、配置都没变且服务在运行时直接结束；
# 有变化时先用新程序校验配置，校验不过就保持原版本；重启后 90 秒内没有正常监听就自动回退到上一版本。
set -euo pipefail
umask 022

REPO=hxx344/trading-platform
SERVICE=trading-platform
SERVICE_USER=trading-platform
NODE_VERSION=24.15.0
KEEP_RELEASES=3
HEALTH_WAIT_S=90
APP_DIR=${TP_APP_DIR:-/opt/trading-platform}
CONF_DIR=${TP_CONF_DIR:-/etc/trading-platform}
DATA_DIR=${TP_DATA_DIR:-/var/lib/trading-platform}
UNIT_FILE=${TP_UNIT_FILE:-/etc/systemd/system/$SERVICE.service}
RELEASE_BASE=${TP_RELEASE_BASE:-https://github.com/$REPO/releases}
# 测试模式：不要求 root、不建系统账号、不改属主、不调用 systemctl；只用于仓库自带的安装测试。
TEST_MODE=${TP_TEST_MODE:-0}
WORKBENCH_ENV=${TP_WORKBENCH_ENV:-/etc/project-aggregation.env}
# The workbench's heartbeat sender on this machine (its install-main-watch.sh --sender), read by --watch-import.
WATCH_SENDER=${TP_WATCH_SENDER:-/etc/main-watch/sender}
# The page's import requests: root owns it, the service's group writes requests, the root helper writes results.
IMPORT_DIR=${TP_IMPORT_DIR:-/var/lib/trading-platform-import}
UNIT_DIR=$(dirname "$UNIT_FILE")
IMPORT_UNITS=("$SERVICE-import.path" "$SERVICE-import.service")
# The page's root helpers: the import above and the online update (docs/update.md), both watching the import directory.
HELPER_UNITS=("${IMPORT_UNITS[@]}" "$SERVICE-update.path" "$SERVICE-update.service")
# Written once trading-platform-update.path is enabled and running; the service offers the page's update only with it.
# In the root-owned program directory: root never writes by path into the hand-off directory the service can change.
UPDATE_READY="$APP_DIR/.update-helper"

# Never fails: a closed terminal (SSH gone) or pipe must not end the script half way through a start.
log() { printf '%s\n' "$*" 2>/dev/null || true; }
# Runs a command a signal must not cut short (Ctrl-C reaches the whole foreground group); ignored signals survive exec.
steady() { ( trap '' INT TERM HUP; exec "$@" ); }
join() { local out='' item; for item in "$@"; do out+="${out:+、}$item"; done; printf '%s' "$out"; }
fail() { restore_import; printf '安装失败：%s\n' "$*" >&2; exit 1; }
# Set while config.json and its key file hold what an import wrote and the service has not run on them yet: any failure
# from then on puts the files back as they were, so neither the old program nor a rollback is left with them.
import_backup=''
# What the backup undoes, for the messages: 导入, 设置密码 or both.
backup_what=''
interrupted=0
restore_import() {
  [[ -n "$import_backup" ]] || return 0
  local name failed=()
  while IFS= read -r name; do
    if [[ -f "$import_backup/$name" ]]; then cp -p "$import_backup/$name" "$CONF_DIR/$name" || failed+=("$name")
    else rm -f "$CONF_DIR/$name" || failed+=("$name"); fi
  done <"$import_backup/.files"
  import_backup=''
  if ((${#failed[@]} == 0)); then log "已恢复${backup_what}前的配置文件。"
  else printf '恢复%s前的配置失败：%s 可能仍是%s后的内容，请检查后手工改回\n' "$backup_what" "$(join "${failed[@]}")" "$backup_what" >&2; fi
}
usage() { sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

version=''
package_dir=''
import_workbench=0
workbench_data=''
import_pairs=''
import_oil=0
import_options=0
import_monitor=0
import_monitor_alerts=0
import_monitor_variational=0
import_monitor_paper=0
import_asset=0
import_crossex=0
import_ondo=0
asset_owner=''
set_password=0
password_stdin=0
watch_url=''
watch_token=''
watch_import=0
watch_off=0
while (($#)); do
  case "$1" in
    --import-workbench) import_workbench=1; shift ;;
    --workbench-data) [[ $# -ge 2 ]] || usage 2; workbench_data=$2; shift 2 ;;
    --pairs) [[ $# -ge 2 ]] || usage 2; import_pairs=$2; shift 2 ;;
    --oil) import_oil=1; shift ;;
    --options) import_options=1; shift ;;
    --monitor) import_monitor=1; shift ;;
    --monitor-alerts) import_monitor_alerts=1; shift ;;
    --monitor-variational) import_monitor_variational=1; shift ;;
    --monitor-paper) import_monitor_paper=1; shift ;;
    --asset) import_asset=1; shift ;;
    --asset-owner) [[ $# -ge 2 ]] || usage 2; asset_owner=$2; shift 2 ;;
    --crossex) import_crossex=1; shift ;;
    --ondo) import_ondo=1; shift ;;
    --set-password) set_password=1; shift ;;
    --password-stdin) password_stdin=1; shift ;;
    --watch-url) [[ $# -ge 2 && -n "$2" ]] || usage 2; watch_url=$2; shift 2 ;;
    --watch-token) [[ $# -ge 2 && -n "$2" ]] || usage 2; watch_token=$2; shift 2 ;;
    --watch-import) watch_import=1; shift ;;
    --watch-off) watch_off=1; shift ;;
    --version) [[ $# -ge 2 ]] || usage 2; version=$2; shift 2 ;;
    --package) [[ $# -ge 2 ]] || usage 2; package_dir=$2; shift 2 ;;
    -h|--help) usage 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage 2 ;;
  esac
done
[[ -z "$version" || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '--version 须形如 v0.1.0'
[[ -z "$version" || -z "$package_dir" ]] || fail '--version 与 --package 只能二选一'
((import_workbench)) || [[ -z "$workbench_data$import_pairs" ]] || fail '--workbench-data 与 --pairs 须和 --import-workbench 一起使用'
((import_workbench || !import_oil)) || fail '--oil 须和 --import-workbench 一起使用'
((import_workbench || !import_options)) || fail '--options 须和 --import-workbench 一起使用'
((import_workbench || !import_monitor)) || fail '--monitor 须和 --import-workbench 一起使用'
((import_workbench || !import_monitor_alerts)) || fail '--monitor-alerts 须和 --import-workbench 一起使用'
((import_workbench || !import_monitor_variational)) || fail '--monitor-variational 须和 --import-workbench 一起使用'
((import_workbench || !import_monitor_paper)) || fail '--monitor-paper 须和 --import-workbench 一起使用'
((import_workbench || !import_asset)) || fail '--asset 须和 --import-workbench 一起使用'
((import_asset)) || [[ -z "$asset_owner" ]] || fail '--asset-owner 须和 --asset 一起使用'
((import_workbench || !import_crossex)) || fail '--crossex 须和 --import-workbench 一起使用'
((import_workbench || !import_ondo)) || fail '--ondo 须和 --import-workbench 一起使用'
((set_password || !password_stdin)) || fail '--password-stdin 须和 --set-password 一起使用'
watch_change=0
if [[ -n "$watch_url" ]] || ((watch_import || watch_off)); then watch_change=1; fi
[[ -z "$watch_url" ]] || ((!watch_import && !watch_off)) || fail '--watch-url、--watch-import、--watch-off 只能用一个'
((!watch_import || !watch_off)) || fail '--watch-url、--watch-import、--watch-off 只能用一个'
[[ -z "$watch_token" || -n "$watch_url" ]] || fail '--watch-token 须和 --watch-url 一起使用'
[[ -z "$watch_token" || "$watch_token" =~ ^[A-Za-z0-9_-]{32,256}$ ]] || fail '--watch-token 须为 32~256 位字母、数字、- 或 _（副服务器 /etc/main-watch/config 的 HEARTBEAT_TOKEN）'

[[ "$(uname -s)" == Linux ]] || fail '只支持 Linux。'
if [[ "$TEST_MODE" != 1 ]]; then
  [[ $EUID -eq 0 ]] || fail '需要 root 运行：sudo bash install.sh'
  for cmd in systemctl useradd getent runuser; do command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"; done
fi
for cmd in curl tar gzip sha256sum awk flock stat; do command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"; done

# Asked before anything is downloaded. A terminal gets two hidden prompts; anything else must say --password-stdin,
# so `curl … | sudo bash -s -- --set-password` cannot take the script's own next line as the password.
new_password=''
if ((set_password)); then
  if ((password_stdin)); then
    # A script read from stdin itself (curl … | bash -s) would give its own next line as the password.
    [[ -f "$0" ]] || fail '脚本本身从标准输入读入时不能用 --password-stdin：先下载 install.sh 再执行'
    IFS= read -r new_password || [[ -n "$new_password" ]] || fail '--password-stdin 没有从标准输入读到密码'
  elif [[ -t 0 ]]; then
    IFS= read -rs -p '新的页面登录密码（至少 8 个字符）：' new_password; printf '\n' >&2
    IFS= read -rs -p '再输入一次：' again; printf '\n' >&2
    [[ "$new_password" == "$again" ]] || fail '两次输入的密码不一致'
    unset again
  else
    [[ -f "$0" ]] || fail '标准输入不是终端：请先下载 install.sh，再在终端里执行 sudo bash install.sh --set-password'
    fail '标准输入不是终端：请在终端里执行，或加 --password-stdin 从标准输入读一行密码'
  fi
  ((${#new_password} >= 8)) || fail '密码至少 8 个字符'
fi


as_root_dir() { # path mode [owner group]
  if [[ "$TEST_MODE" == 1 ]]; then install -d -m "$2" "$1"; else install -d -m "$2" -o "${3:-root}" -g "${4:-root}" "$1"; fi
}
as_service() { if [[ "$TEST_MODE" == 1 ]]; then (cd / && "$@"); else (cd / && runuser -u "$SERVICE_USER" -- "$@"); fi; }
fetch() { # url target
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 600 --retry 3 --retry-delay 2 "$1" -o "$2" \
    || fail "下载失败：$1（网络不通时可在别处下载后用 --package 安装）"
}

changes=()
skipped=()

as_root_dir "$APP_DIR" 755
exec 9>"$APP_DIR/.install.lock"
flock -n 9 || fail '另一个安装进程正在运行。'
work_dir=$(mktemp -d)
# An exit that bypasses fail (set -e, a signal) still puts imported files back before the backup goes with work_dir;
# the backup is cleared only once the service runs on them. A signal becomes an exit, so the EXIT trap runs.
trap 'trap "" INT TERM HUP; restore_import; rm -rf "$work_dir"' EXIT
trap 'exit 130' INT TERM HUP

# ---- 1. 校验清单与程序包 ----------------------------------------------------------
# Changing only the password or the heartbeat keeps the installed release: nothing is downloaded and the program does
# not change. An installed release from before the heartbeat existed cannot switch it, so that case takes the latest.
installed_sha=$(cat "$APP_DIR/current/.package-sha256" 2>/dev/null || true)
keep_installed=0
if [[ -z "$version$package_dir" && "$installed_sha" =~ ^[a-f0-9]{64}$ ]]; then
  if ((set_password)) || { ((watch_change)) && [[ -f "$APP_DIR/current/src/service/watch-config.ts" ]]; }; then keep_installed=1; fi
fi
if ((keep_installed)); then
  printf '%s  trading-platform.tar.gz\n' "$installed_sha" >"$work_dir/SHA256SUMS"
  source_label='当前已装版本'
elif [[ -n "$package_dir" ]]; then
  [[ -f "$package_dir/SHA256SUMS" && -f "$package_dir/trading-platform.tar.gz" ]] || fail "$package_dir 里缺少 SHA256SUMS 或 trading-platform.tar.gz"
  cp "$package_dir/SHA256SUMS" "$work_dir/SHA256SUMS"
  source_label="本地目录 $package_dir"
else
  if [[ -n "$version" ]]; then base="$RELEASE_BASE/download/$version"; source_label="版本 $version"; else base="$RELEASE_BASE/latest/download"; source_label='最新正式版'; fi
  fetch "$base/SHA256SUMS" "$work_dir/SHA256SUMS"
fi
expected=$(awk '$2 == "trading-platform.tar.gz" { print $1 }' "$work_dir/SHA256SUMS")
[[ "$expected" =~ ^[a-f0-9]{64}$ ]] || fail '校验清单里没有程序包的 SHA-256。'
release_dir="$APP_DIR/releases/${expected:0:16}"
if [[ -d "$release_dir" && "$(cat "$release_dir/.package-sha256" 2>/dev/null || true)" != "$expected" ]]; then
  # A damaged marker or an abbreviated-name collision must not remove a package a live process may still use.
  release_dir="$APP_DIR/releases/$expected"
fi
current_sha=$(cat "$APP_DIR/current/.package-sha256" 2>/dev/null || true)
# The release `current` points at, if it is one of ours; a missing link or anything else is no version to roll back to.
previous_dir=''
if [[ -L "$APP_DIR/current" ]]; then
  target=$(readlink "$APP_DIR/current")
  [[ "$target" == "$APP_DIR/releases/"* && -d "$target" ]] && previous_dir=$target
fi
if ((keep_installed)); then
  [[ -n "$previous_dir" && "$(cat "$previous_dir/.package-sha256" 2>/dev/null)" == "$expected" ]] || fail '找不到当前已装版本的目录，请加 --version 或 --package 指定要用的版本'
  release_dir=$previous_dir
fi

as_root_dir "$APP_DIR/releases" 755
if [[ -f "$release_dir/.package-sha256" && "$(cat "$release_dir/.package-sha256")" == "$expected" ]]; then
  [[ "$current_sha" == "$expected" ]] && skipped+=('程序包（未变化）')
else
  [[ ! -e "$release_dir" ]] || fail "已有版本目录 $release_dir 校验标记异常，已保留原目录。"
  if [[ -n "$package_dir" ]]; then cp "$package_dir/trading-platform.tar.gz" "$work_dir/package.tar.gz"
  else log "下载程序包（$source_label）。"; fetch "$base/trading-platform.tar.gz" "$work_dir/package.tar.gz"; fi
  (cd "$work_dir" && printf '%s  %s\n' "$expected" package.tar.gz | sha256sum --check --status) || fail '程序包 SHA-256 与校验清单不一致。'
  mkdir "$work_dir/extract"
  tar -xzf "$work_dir/package.tar.gz" -C "$work_dir/extract" --no-same-owner --no-same-permissions
  [[ -f "$work_dir/extract/trading-platform/VERSION" && -f "$work_dir/extract/trading-platform/src/service/main.ts" ]] || fail '程序包结构不完整。'
  printf '%s\n' "$expected" >"$work_dir/extract/trading-platform/.package-sha256"
  chmod -R u=rwX,go=rX "$work_dir/extract/trading-platform"
  rm -rf "$release_dir.staging"
  mv "$work_dir/extract/trading-platform" "$release_dir.staging"
  [[ "$TEST_MODE" == 1 ]] || chown -R root:root "$release_dir.staging"
  mv "$release_dir.staging" "$release_dir"
fi
new_version=$(head -n1 "$release_dir/VERSION")

# ---- 2. Node.js -------------------------------------------------------------------
node_supported() {
  local found
  found=$("$1" -p 'process.versions.node' 2>/dev/null) || return 1
  [[ "$found" =~ ^24\.([0-9]+)\.[0-9]+$ ]] && ((BASH_REMATCH[1] >= 15))
}
ensure_node() {
  local candidate machine archive runtime_dir checksum
  if [[ "$TEST_MODE" == 1 && -n "${TP_NODE_BIN:-}" ]]; then NODE_BIN=$TP_NODE_BIN; node_supported "$NODE_BIN" || fail 'TP_NODE_BIN 不是 Node 24.15+。'; return; fi
  candidate=$(command -v node || true)
  [[ -z "$candidate" ]] || candidate=$(realpath "$candidate")
  # The service account cannot reach home directories (ProtectHome), so a node there is not used.
  if [[ -n "$candidate" && "$candidate" != /root/* && "$candidate" != /home/* ]] && node_supported "$candidate"; then NODE_BIN=$candidate; return; fi
  case "$(uname -m)" in x86_64) machine=x64 ;; aarch64|arm64) machine=arm64 ;; *) fail '自动安装 Node.js 只支持 x64 与 arm64。' ;; esac
  archive="node-v${NODE_VERSION}-linux-${machine}.tar.xz"
  runtime_dir="$APP_DIR/runtime/node-v${NODE_VERSION}-linux-${machine}"
  if [[ ! -x "$runtime_dir/bin/node" ]] || ! node_supported "$runtime_dir/bin/node"; then
    command -v xz >/dev/null || fail '缺少命令 xz（解压 Node.js 需要）'
    log "下载 Node.js $NODE_VERSION（约 30 MB）并核验官方 SHA-256。"
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" "$work_dir/NODE_SUMS"
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" "$work_dir/$archive"
    checksum=$(awk -v name="$archive" '$2 == name { print $1 }' "$work_dir/NODE_SUMS")
    [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || fail '官方校验文件里找不到当前 Node.js 包。'
    (cd "$work_dir" && printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status) || fail 'Node.js 包 SHA-256 不一致。'
    as_root_dir "$APP_DIR/runtime" 755
    rm -rf "$runtime_dir"
    tar -xJf "$work_dir/$archive" -C "$APP_DIR/runtime" --no-same-owner
    changes+=("Node.js $NODE_VERSION")
  fi
  NODE_BIN="$runtime_dir/bin/node"
  node_supported "$NODE_BIN" || fail 'Node.js 版本不满足 24.15+。'
}
ensure_node

# ---- 3. 系统账号与目录 -------------------------------------------------------------
if [[ "$TEST_MODE" != 1 ]] && ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --user-group --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  changes+=("系统账号 $SERVICE_USER")
fi
as_root_dir "$CONF_DIR" 750 root "$SERVICE_USER"
as_root_dir "$DATA_DIR" 700 "$SERVICE_USER" "$SERVICE_USER"
as_root_dir "$IMPORT_DIR" 770 root "$SERVICE_USER"
for name in config secrets; do
  example="$release_dir/deploy/$name.example.json"
  if ! cmp -s "$example" "$CONF_DIR/$name.example.json"; then install -m 644 "$example" "$CONF_DIR/$name.example.json"; fi
done
# Saves config.json and the key file it names (always in this directory) the first time it is called, so that whatever
# an import or a heartbeat change writes can be put back; $1 names the change for the messages.
backup_conf_files() {
  local name
  if [[ ! -d "$work_dir/conf-before" ]]; then
    mkdir "$work_dir/conf-before"
    {
      printf '%s\n' config.json secrets.json
      if [[ -f "$CONF_DIR/config.json" ]]; then
        "$NODE_BIN" -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).secretsFile; const p = require("path"); if (typeof v === "string" && p.dirname(p.resolve(v)) === p.resolve(process.argv[2])) process.stdout.write(p.basename(v) + "\n"); } catch {}' "$CONF_DIR/config.json" "$CONF_DIR"
      fi
    } | sort -u >"$work_dir/conf-before/.files"
    while IFS= read -r name; do
      if [[ -f "$CONF_DIR/$name" ]]; then cp -p "$CONF_DIR/$name" "$work_dir/conf-before/$name"; fi
    done <"$work_dir/conf-before/.files"
  fi
  import_backup="$work_dir/conf-before"
  backup_what=${backup_what:+$backup_what与}$1
}
# Run as root: it reads the workbench's database and environment, and writes both files as root 600; the takeover
# below then hands them to the service account. A failed import writes nothing and stops the install.
if ((import_workbench)); then
  [[ -f "$release_dir/src/service/import-workbench.ts" ]] || fail "版本 $new_version 不支持 --import-workbench，请用最新版本导入"
  if ((import_oil)); then grep -q 'readWorkbenchOil' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --oil，请用最新版本导入"; fi
  if ((import_options)); then grep -q 'readWorkbenchOptions' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --options，请用最新版本导入"; fi
  if ((import_monitor)); then grep -q 'readWorkbenchMonitor' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --monitor，请用最新版本导入"; fi
  if ((import_monitor_alerts)); then grep -q 'readWorkbenchAlerts' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --monitor-alerts，请用最新版本导入"; fi
  if ((import_monitor_variational)); then grep -q 'readWorkbenchVariational' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --monitor-variational，请用最新版本导入"; fi
  if ((import_monitor_paper)); then grep -q 'readWorkbenchPaper' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --monitor-paper，请用最新版本导入"; fi
  if ((import_asset)); then grep -q 'readWorkbenchAsset' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --asset，请用最新版本导入"; fi
  if ((import_crossex)); then grep -q 'readWorkbenchCrossex' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --crossex，请用最新版本导入"; fi
  if ((import_ondo)); then grep -q 'readWorkbenchOndo' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --ondo，请用最新版本导入"; fi
  backup_conf_files 导入
  import_args=(--config "$CONF_DIR/config.json" --workbench-env "$WORKBENCH_ENV")
  [[ -z "$workbench_data" ]] || import_args+=(--workbench-data "$workbench_data")
  [[ -z "$import_pairs" ]] || import_args+=(--pairs "$import_pairs")
  ((!import_oil)) || import_args+=(--oil)
  ((!import_options)) || import_args+=(--options)
  ((!import_monitor)) || import_args+=(--monitor)
  ((!import_monitor_alerts)) || import_args+=(--monitor-alerts)
  ((!import_monitor_variational)) || import_args+=(--monitor-variational)
  ((!import_monitor_paper)) || import_args+=(--monitor-paper)
  # The ledger, the alert tiers, the Var token and the pending paper records go into the service's data directory, written
  # by the importer as that directory's owner.
  ((!import_asset)) || import_args+=(--asset)
  ((!import_asset && !import_monitor_alerts && !import_monitor_variational && !import_monitor_paper)) || import_args+=(--data-dir "$DATA_DIR")
  [[ -z "$asset_owner" ]] || import_args+=(--asset-owner "$asset_owner")
  # The CrossEx page settings go into the same data directory (named once when an item above already named it).
  ((!import_crossex)) || import_args+=(--crossex)
  ((!import_crossex || import_asset || import_monitor_alerts || import_monitor_variational || import_monitor_paper)) || import_args+=(--data-dir "$DATA_DIR")
  ((!import_ondo)) || import_args+=(--ondo)
  # The service's proxy settings (KEY=VALUE lines, as systemd reads them): importing the options account reads Bybit once.
  import_env=()
  if [[ -f "$CONF_DIR/environment" ]]; then
    while IFS= read -r env_line || [[ -n "$env_line" ]]; do
      env_line=${env_line%$'\r'}
      [[ "$env_line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
      env_key=${BASH_REMATCH[1]} env_value=${BASH_REMATCH[2]}
      if [[ "$env_value" =~ ^\"(.*)\"$ || "$env_value" =~ ^\'(.*)\'$ ]]; then env_value=${BASH_REMATCH[1]}; fi
      import_env+=("$env_key=$env_value")
    done <"$CONF_DIR/environment"
  fi
  (cd / && env ${import_env[@]+"${import_env[@]}"} "$NODE_BIN" "$release_dir/src/service/import-workbench.ts" "${import_args[@]}" 9>&-) || fail '从工作台导入配置失败'
fi
# A first setup without an import starts on a config with no pairs, so the page is up to import them from.
if [[ ! -e "$CONF_DIR/config.json" && ! -L "$CONF_DIR/config.json" ]]; then
  if [[ -e "$CONF_DIR/secrets.json" || -L "$CONF_DIR/secrets.json" ]]; then
    log "$CONF_DIR/secrets.json 已存在但没有 config.json，未生成空配置；请先确认它的内容。"
  elif compgen -G "$DATA_DIR/executor*.sqlite" >/dev/null; then
    # A service that ran before and lost its config would start with no pairs and disable every pair it knew.
    log "$DATA_DIR 里已有运行记录但没有 config.json，未生成空配置；请恢复原配置，或在确认后手动写入空配置。"
  else
    # Both or neither: a key file left without a config would need a manual look on the next run.
    "$NODE_BIN" -e 'const fs = require("fs"), [config, secrets] = process.argv.slice(1);
      fs.writeFileSync(secrets, JSON.stringify({ accounts: {} }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      try { fs.writeFileSync(config, JSON.stringify({ secretsFile: secrets, pairs: [] }, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
      catch (error) { fs.rmSync(secrets, { force: true }); throw error; }' \
      "$CONF_DIR/config.json" "$CONF_DIR/secrets.json" || fail '无法生成空配置'
    changes+=('空配置（在页面导入配对）')
  fi
fi
# The heartbeat for the second server's main-watch (docs/watch.md): the address goes into config.json, the token into the
# key file. Run as root like the import; the token reaches the program on stdin, not on its command line.
if ((watch_change)); then
  [[ -f "$release_dir/src/service/watch-config.ts" ]] || fail "版本 $new_version 不支持巡检心跳（v0.47.0 起提供），请用最新版本"
  [[ -f "$CONF_DIR/config.json" ]] || fail "尚无 $CONF_DIR/config.json，无法设置巡检心跳"
  backup_conf_files 设置巡检心跳
  if ((watch_off)); then watch_args=(--off)
  elif ((watch_import)); then watch_args=(--from-sender "$WATCH_SENDER")
  else watch_args=(--url "$watch_url"); fi
  set_watch() { (cd / && "$NODE_BIN" "$release_dir/src/service/watch-config.ts" --config "$CONF_DIR/config.json" "${watch_args[@]}" 9>&-); }
  # Only --url reads the token line; the others get no pipe, whose writer could fail once they have exited.
  if [[ -n "$watch_url" ]]; then printf '%s\n' "$watch_token" | set_watch || fail '设置巡检心跳失败'
  else set_watch </dev/null || fail '设置巡检心跳失败'; fi
  watch_token=''
fi
configured=0
if [[ -f "$CONF_DIR/config.json" ]]; then
  configured=1
  # The service reads both files only when they belong to its account and nobody else can read them.
  secrets_file=$("$NODE_BIN" -e 'try { const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).secretsFile; if (typeof v === "string") process.stdout.write(v); } catch {}' "$CONF_DIR/config.json")
  # Only files of this directory are taken over: a secretsFile pointing elsewhere (say the workbench's own key file)
  # is left as it is, and the service refuses it unless it already belongs to the service account with mode 600.
  if [[ -n "$secrets_file" ]]; then
    conf_real=$(readlink -f "$CONF_DIR")
    if [[ -L "$secrets_file" || ! -f "$secrets_file" || "$(readlink -f "$secrets_file")" != "$conf_real/"* ]]; then
      log "密钥文件 $secrets_file 不是 $CONF_DIR 下的普通文件，未调整属主与权限；请自行确认它只归服务账户所有且为 600。"
      secrets_file=''
    fi
  fi
  # The login password's digest is written below when asked for; set the hard way, it is taken over the same.
  if ((set_password)); then
    grep -q "'hash-password'" "$release_dir/src/service/main.ts" || fail "所选版本 $new_version 不支持 --set-password：先执行 sudo bash install.sh 升级（或加 --version 指定 v0.4.0 及以后的版本）再设置"
    password_hash=$(printf '%s\n' "$new_password" | as_service "$NODE_BIN" "$release_dir/src/service/main.ts" --hash-password) || fail '无法生成密码摘要'
    new_password=''
    [[ "$password_hash" == scrypt:* ]] || fail '密码摘要格式不对'
    # Undone like an import until the service runs on it: a failed check or start puts the old password back.
    if [[ ! -d "$work_dir/conf-before" ]]; then mkdir "$work_dir/conf-before"; : >"$work_dir/conf-before/.files"; fi
    if ! grep -qx login-password "$work_dir/conf-before/.files"; then
      if [[ -f "$CONF_DIR/login-password" ]]; then cp -p "$CONF_DIR/login-password" "$work_dir/conf-before/login-password"; fi
      printf 'login-password\n' >>"$work_dir/conf-before/.files"
    fi
    import_backup="$work_dir/conf-before"
    backup_what=${backup_what:+$backup_what与}设置密码
    ( umask 077; printf '%s\n' "$password_hash" >"$CONF_DIR/.login-password.tmp" ) || fail '无法写入登录密码'
    [[ "$TEST_MODE" == 1 ]] || chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/.login-password.tmp"
    mv -f "$CONF_DIR/.login-password.tmp" "$CONF_DIR/login-password"
    changes+=('登录密码（已打开的页面须重新登录）')
  fi
  for file in "$CONF_DIR/config.json" ${secrets_file:+"$secrets_file"} "$CONF_DIR/login-password"; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    if [[ "$TEST_MODE" == 1 ]]; then wanted="$(id -un) 600"; else wanted="$SERVICE_USER 600"; fi
    if [[ "$(stat -c '%U %a' "$file")" != "$wanted" ]]; then
      [[ "$TEST_MODE" == 1 ]] || chown -h "$SERVICE_USER:$SERVICE_USER" "$file"
      chmod 600 "$file"
      changes+=("$file 改为仅 ${wanted%% *} 可读写（600）")
    fi
  done
fi

((configured || !set_password)) || fail "尚无 $CONF_DIR/config.json，无法设置登录密码"

# ---- 4. 校验配置 ----------------------------------------------------------------------
CONTROL=$SERVICE-control
STATE="$APP_DIR/.deployment"
RECORDS="$APP_DIR/.deployments"
as_root_dir "$RECORDS" 700
candidate="$work_dir/candidate"
mkdir -m 700 "$candidate"
read_value() { if [[ -f "$1" ]]; then cat "$1"; fi; }
switch_link() { # real directory, link in the root-owned application directory
  [[ "$(readlink "$2" 2>/dev/null || true)" != "$1" ]] || return 0
  ln -sfn "$1" "$2.next" && mv -Tf "$2.next" "$2"
}
# Commit all component pins and their effective settings together. If the installer or host dies halfway through
# activation, the next run still compares against the last success and can restore its units and public listener.
save_record() {
  local snapshot
  snapshot=$(mktemp -d "$RECORDS/state.XXXXXXXX") || return 1
  cp -a "$1/." "$snapshot/" && switch_link "$snapshot" "$STATE"
}
if [[ ! -d "$STATE" ]]; then
  initial="$work_dir/previous"
  mkdir -m 700 "$initial"
  printf '%s\n' "$previous_dir" >"$initial/current"
  # Bootstrap an existing installation (v0.63.0 and older had only current and the main unit).
  if [[ -n "$previous_dir" ]]; then cp "$UNIT_FILE" "$initial/executor.service" || fail '找不到已安装的服务单元，未切换版本。'; fi
  if [[ -n "$previous_dir" && -f "$UNIT_DIR/$CONTROL.service" && -L "$APP_DIR/executor" && -L "$APP_DIR/control" ]]; then
    readlink -f "$APP_DIR/executor" >"$initial/executor"
    readlink -f "$APP_DIR/control" >"$initial/control"
    cp "$UNIT_DIR/$CONTROL.service" "$initial/control.service"
    cp "$APP_DIR/control-listen.json" "$APP_DIR/control-proxy.env" "$initial/"
  fi
  save_record "$initial" || fail '无法保存当前版本的回退信息，未切换版本。'
fi
previous_dir=$(read_value "$STATE/current")
previous_executor=$(read_value "$STATE/executor")
previous_control=$(read_value "$STATE/control")
split=0
if [[ -e "$release_dir/src/control" || -e "$release_dir/deploy/$CONTROL.service" || -e "$release_dir/.control-sha256" ]]; then
  split=1
  [[ -f "$release_dir/src/control/main.ts" && -f "$release_dir/src/control/probe.ts" && -f "$release_dir/deploy/$CONTROL.service" &&
     "$(read_value "$release_dir/.executor-sha256")" =~ ^[0-9a-f]{64}$ && "$(read_value "$release_dir/.control-sha256")" =~ ^[0-9a-f]{64}$ ]] ||
    fail '控制面与执行面程序包不完整，未切换版本。'
fi
# Hash as the service account. File metadata matters too: a readable key file with the wrong mode must fail a fresh
# check. Never read a service-configured key path as root, and store only the aggregate digest in the private record.
config_hash() {
  as_service "$NODE_BIN" -e 'const fs = require("fs"), path = require("path"), hash = require("crypto").createHash("sha256");
    const config = process.argv[1];
    function include(file) {
      if (typeof file !== "string") { hash.update("no-path\n"); return; }
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const s = fs.fstatSync(fd);
        hash.update(JSON.stringify([file, s.mode, s.uid, s.gid, s.size]) + "\n");
        if (!s.isFile() || s.size > 65536) return;
        const bytes = Buffer.alloc(65537); let size = 0, n;
        while (size < bytes.length && (n = fs.readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
        hash.update(bytes.subarray(0, size));
        return bytes.toString("utf8", 0, size);
      } catch (e) { hash.update(file + ":" + e.code + "\n"); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    let secrets; try { secrets = JSON.parse(include(config)).secretsFile; } catch {}
    include(secrets); include(path.join(path.dirname(config), "login-password"));
    process.stdout.write(hash.digest("hex"));' "$CONF_DIR/config.json"
}
node_identity="$NODE_BIN $(stat -Lc '%d:%i:%s:%Y:%Z' "$NODE_BIN")"
applied=''
if ((configured)); then
  applied=$(config_hash)
  printf '%s\n' "$expected" "$applied" "$node_identity" >"$candidate/check-key"
  if cmp -s "$candidate/check-key" "$STATE/check-key" && [[ -f "$STATE/check-output" ]]; then
    cp "$STATE/check-output" "$candidate/check-output"
    skipped+=('配置检查（已验证）')
  elif ! as_service "$NODE_BIN" "$release_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config >"$candidate/check-output" 2>&1; then
    fail "配置检查未通过，服务保持原版本：$(cat "$candidate/check-output")"
  fi
  check=$(cat "$candidate/check-output")
  log "$check"
  if ((set_password)); then rm -f "$DATA_DIR/http-session"; fi
elif [[ -n "$previous_dir" ]]; then
  log '尚无 config.json，已保留当前程序、服务及数据。'
  exit 0
fi

# ---- 5. 分别准备执行面、控制面与页面版本 ------------------------------------------------
FLOCK_BIN=$(command -v flock)
render_to() {
  [[ -f "$1" ]] && sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@CONF_DIR@|$CONF_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@IMPORT_DIR@|$IMPORT_DIR|g" -e "s|@FLOCK@|$FLOCK_BIN|g" -e "s|@WORKBENCH_ENV@|$WORKBENCH_ENV|g" "$1" >"$2" && [[ -s "$2" ]]
}
printf '%s\n' "$release_dir" >"$candidate/current"
render_to "$release_dir/deploy/trading-platform.service" "$candidate/executor.service" || fail '无法从程序包生成 systemd 单元，未切换版本。'
# Reuse the original release directories of unchanged components. In particular later lazy imports and Python
# helpers still run from the executor's original package after any number of page releases.
pin_component() {
  local name=$1 pinned
  pinned=$(read_value "$STATE/$name")
  if [[ -n "$pinned" && -d "$pinned" ]] && cmp -s "$release_dir/.$name-sha256" "$pinned/.$name-sha256"; then
    printf '%s\n' "$pinned"
  else printf '%s\n' "$release_dir"; fi
}
if ((split)); then
  pin_component executor >"$candidate/executor"
  pin_component control >"$candidate/control"
  render_to "$release_dir/deploy/$CONTROL.service" "$candidate/control.service" || fail '无法生成控制面单元，未切换版本。'
  if ((configured)); then
    # Use the same port and host validation as the two services, and copy only these two public fields.
    as_service "$NODE_BIN" --input-type=module - "$CONF_DIR/config.json" "$release_dir/src/service/listen-config.ts" >"$candidate/control-listen.json" <<'JS'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { parseListenConfig } = await import(pathToFileURL(process.argv[3]));
const { port, host } = parseListenConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.log(JSON.stringify({ port, host }));
JS
    # The default key is already hidden by the config directory. Cover a supported external key path (and any
    # symlink target) too. Encode unit syntax rather than inserting a service-owned config string into a root unit.
    as_service "$NODE_BIN" - "$CONF_DIR/config.json" "$CONF_DIR" "$DATA_DIR" >>"$candidate/control.service" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [, , config, ...hidden] = process.argv;
const key = JSON.parse(fs.readFileSync(config, 'utf8')).secretsFile;
for (const file of new Set([path.resolve(key), fs.realpathSync(key)])) {
  if (hidden.some(dir => file.startsWith(dir + '/'))) continue;
  const word = [...Buffer.from(file)].map(b => /[a-zA-Z0-9_./-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0')).join('').replace(/\\x25/g, '%%');
  console.log('\n[Service]\nInaccessiblePaths=-' + word);
}
JS
  else printf '%s\n' '{"port":4720,"host":null}' >"$candidate/control-listen.json"; fi
  # systemd reads this root-only file before applying InaccessiblePaths. Pass only proxy settings to the browser
  # service; the executor and the two root helpers continue to use the original EnvironmentFile.
  : >"$candidate/control-proxy.env"
  if [[ -f "$CONF_DIR/environment" ]]; then
    awk '/^[[:blank:]]*(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|http_proxy|https_proxy|all_proxy|no_proxy|NODE_USE_ENV_PROXY)=/{print}' \
      "$CONF_DIR/environment" >"$candidate/control-proxy.env"
  fi
  { printf '%s\n' "$node_identity"; cat "$release_dir/.control-sha256"; sha256sum <"$candidate/control.service"; sha256sum <"$candidate/control-listen.json"; sha256sum <"$candidate/control-proxy.env"; } \
    | sha256sum | cut -d' ' -f1 >"$candidate/control-key"
fi
{
  printf '%s\n' "$node_identity" "$applied"
  if ((split)); then cat "$release_dir/.executor-sha256"; else printf '%s\n' "$expected"; fi
  sha256sum <"$candidate/executor.service"
  if [[ -f "$CONF_DIR/environment" ]]; then sha256sum <"$CONF_DIR/environment"; fi
} | sha256sum | cut -d' ' -f1 >"$candidate/executor-key"

# Older packages without a helper leave its installed units in place. Prepare all files before changing any of them.
for unit in "${HELPER_UNITS[@]}"; do
  if [[ -f "$release_dir/deploy/$unit" ]]; then render_to "$release_dir/deploy/$unit" "$work_dir/$unit" || fail "无法生成 $unit，未切换版本。"; fi
done
helper_changed=0
for unit in "${HELPER_UNITS[@]}"; do
  [[ -f "$work_dir/$unit" ]] || continue
  cmp -s "$work_dir/$unit" "$UNIT_DIR/$unit" && continue
  install -m 644 "$work_dir/$unit" "$UNIT_DIR/$unit"
  helper_changed=1
done
if ((helper_changed)); then changes+=('页面助手单元'); fi
arm_path() { # unit, description
  local unit=$1 what=$2
  [[ -f "$UNIT_DIR/$unit" ]] || return 1
  if ! systemctl is-enabled --quiet "$unit"; then
    if systemctl enable --quiet "$unit"; then changes+=("$what"); else log "无法设置 $unit 开机自启，${what}暂不可用"; return 1; fi
  fi
  if ((helper_changed)) || ! systemctl is-active --quiet "$unit"; then
    systemctl restart "$unit" || { log "无法启动 $unit，${what}暂不可用"; return 1; }
  fi
}
ensure_import_path() {
  local active=$1
  arm_path "$SERVICE-import.path" 页面导入助手 || true
  if [[ -f "$active/src/service/update-helper.ts" ]] && arm_path "$SERVICE-update.path" 页面在线更新; then
    [[ -f "$UPDATE_READY" ]] || { printf '%s\n' "$(head -n1 "$active/VERSION")" >"$UPDATE_READY" && chmod 644 "$UPDATE_READY"; } || log "无法写入 $UPDATE_READY，页面在线更新暂不可用"
  else rm -f "$UPDATE_READY"; fi
}
put_file() { # atomically replace a file in a root-owned directory
  cmp -s "$1" "$2" && [[ $(stat -c %a "$2") == "$3" ]] && return 0
  install -m "$3" "$1" "$2.next" && mv -Tf "$2.next" "$2"
}
running_from() { # WorkingDirectory pins the real package of the running process, even after an interrupted update.
  local pid
  pid=$(systemctl show -p MainPID --value "$1") && [[ "$pid" =~ ^[1-9][0-9]*$ && "$(readlink "/proc/$pid/cwd")" == "$2" ]]
}
journal_tail() { steady journalctl -u "$SERVICE" -u "$CONTROL" -n 40 --no-pager -o cat 2>/dev/null || true; }
healthy_executor() {
  local deadline=$((SECONDS + HEALTH_WAIT_S)) pid
  while ((SECONDS < deadline)); do
    if [[ "$DATA_DIR/access-url" -nt "$work_dir/before-start" ]] && systemctl is-active --quiet "$SERVICE"; then
      pid=$(systemctl show -p MainPID --value "$SERVICE")
      steady sleep 5
      [[ "$pid" != 0 && "$(systemctl show -p MainPID --value "$SERVICE")" == "$pid" ]] && systemctl is-active --quiet "$SERVICE" && return 0
    fi
    steady sleep 0.5
  done
  return 1
}
probe_control() {
  as_service timeout --kill-after=1 4 "$NODE_BIN" "$1/src/control/probe.ts" --current "$APP_DIR/current" --listen-file "$APP_DIR/control-listen.json" \
    >"$work_dir/probe.log" 2>&1
}
healthy_control() {
  local target=$1 deadline=$((SECONDS + HEALTH_WAIT_S))
  while ((SECONDS < deadline)); do
    if systemctl is-active --quiet "$CONTROL" && probe_control "$target"; then return 0; fi
    steady sleep 0.5
  done
  [[ ! -s "$work_dir/probe.log" ]] || log "$(tail -c 600 "$work_dir/probe.log")"
  return 1
}
enable_service() {
  systemctl is-enabled --quiet "$1" || { steady systemctl enable --quiet "$1" && changes+=("$1 开机自启"); }
}
# ---- 6. 激活（回退走同一条路径） ------------------------------------------------------
# Compare the two component keys separately. A bad UI must never request an executor restart. Unit/filesystem drift
# and a process running an unexpected release are also repaired, e.g. after a power cut between switching and starting.
activate() {
  local to=$1 from=$2 target exe ctl live changes_unit=0 moving=0 change_ex=0 change_ctl=0
  local action_ex='' action_ctl='' unit name
  target=$(read_value "$to/current")
  exe=$(read_value "$to/executor")
  ctl=$(read_value "$to/control")
  live=$(readlink "$APP_DIR/current" 2>/dev/null || true)
  [[ "$live" == "$target" ]] || moving=1
  cmp -s "$to/executor-key" "$from/executor-key" || change_ex=1
  [[ ! -e "$APP_DIR/.restarting-executor" ]] || change_ex=1
  if ! cmp -s "$to/executor.service" "$UNIT_FILE"; then changes_unit=1; change_ex=1; fi
  if [[ -n "$ctl" ]]; then
    cmp -s "$to/control-key" "$from/control-key" || change_ctl=1
    [[ ! -e "$APP_DIR/.restarting-control" ]] || change_ctl=1
    if ! cmp -s "$to/control.service" "$UNIT_DIR/$CONTROL.service"; then changes_unit=1; change_ctl=1; fi
    cmp -s "$to/control-listen.json" "$APP_DIR/control-listen.json" && cmp -s "$to/control-proxy.env" "$APP_DIR/control-proxy.env" || change_ctl=1
  elif [[ -f "$UNIT_DIR/$CONTROL.service" ]]; then
    # Downgrade to the monolith: release its TCP port before the old program can start.
    if [[ "$TEST_MODE" != 1 ]]; then steady systemctl disable --now --quiet "$CONTROL" || return 1; fi
    rm -f "$UNIT_DIR/$CONTROL.service" "$APP_DIR/control" "$APP_DIR/executor" "$APP_DIR/control-listen.json" "$APP_DIR/control-proxy.env" "$APP_DIR/.restarting-control" || return 1
    changes_unit=1
  fi
  # Persist a requested restart before changing its files. This covers interruption during rollback even when
  # the previous code directory is identical (for example an environment-only change with the same TCP port).
  if [[ "$TEST_MODE" != 1 ]] && ((configured)); then
    if ((change_ex)); then : >"$APP_DIR/.restarting-executor" || return 1; fi
    if [[ -n "$ctl" ]] && ((change_ctl)); then : >"$APP_DIR/.restarting-control" || return 1; fi
  fi
  put_file "$to/executor.service" "$UNIT_FILE" 644 || return 1
  if [[ -n "$ctl" ]]; then
    put_file "$to/control.service" "$UNIT_DIR/$CONTROL.service" 644 && put_file "$to/control-listen.json" "$APP_DIR/control-listen.json" 644 &&
      put_file "$to/control-proxy.env" "$APP_DIR/control-proxy.env" 600 && switch_link "$exe" "$APP_DIR/executor" && switch_link "$ctl" "$APP_DIR/control" || return 1
  fi
  switch_link "$target" "$APP_DIR/current" || return 1
  if ((moving)); then changes+=("程序 $(head -n1 "$target/VERSION")"); fi
  if ((changes_unit)); then changes+=('systemd 单元'); else skipped+=('systemd 单元（未变化）'); fi
  if [[ "$TEST_MODE" == 1 ]]; then skipped+=('systemctl（测试模式）'); return 0; fi
  if ((!changes_unit && !helper_changed)); then
    for unit in "$SERVICE" "$CONTROL" "${HELPER_UNITS[@]}"; do
      [[ $(systemctl show -p NeedDaemonReload --value "$unit" 2>/dev/null) != yes ]] || { changes_unit=1; break; }
    done
  fi
  if ((changes_unit || helper_changed)); then steady systemctl daemon-reload || return 1; fi
  if ((!configured)); then skipped+=('启动服务（尚无 config.json）'); return 0; fi
  enable_service "$SERVICE" || return 1
  if ! systemctl is-active --quiet "$SERVICE"; then action_ex=start
  elif ((change_ex)) || { [[ -n "$exe" ]] && ! running_from "$SERVICE" "$exe"; }; then action_ex=restart; fi
  if [[ -n "$ctl" ]]; then
    enable_service "$CONTROL" || return 1
    if ! systemctl is-active --quiet "$CONTROL"; then action_ctl=start
    elif ((change_ctl)) || ! running_from "$CONTROL" "$ctl"; then action_ctl=restart
    elif ((moving)) || [[ "$(read_value "$from/current")" != "$target" ]]; then action_ctl=reload; fi
  fi
  if [[ -n "$action_ex" ]]; then
    touch "$work_dir/before-start" || return 1
    steady systemctl reset-failed "$SERVICE" 2>/dev/null || true
    steady systemctl "$action_ex" "$SERVICE" && healthy_executor || return 1
    rm -f "$APP_DIR/.restarting-executor" || return 1
    changes+=("执行服务已$([[ $action_ex == start ]] && echo 启动 || echo 重启)")
  else skipped+=('执行服务（继续运行）'); fi
  if [[ -n "$ctl" ]]; then
    # Even an unchanged, apparently active unit can have stopped answering. Repair the browser process alone.
    if [[ -z "$action_ctl" ]] && ! probe_control "$target"; then action_ctl=restart; fi
    if [[ -n "$action_ctl" ]]; then
      steady systemctl reset-failed "$CONTROL" 2>/dev/null || true
      steady systemctl "$action_ctl" "$CONTROL" && healthy_control "$target" || return 1
      rm -f "$APP_DIR/.restarting-control" || return 1
      case $action_ctl in start) name=已启动 ;; restart) name=已重启 ;; reload) name=已重载页面 ;; esac
      changes+=("控制面$name")
    else skipped+=('控制面（运行正常）'); fi
  fi
}

# Hold signals until either the candidate or its predecessor has been verified, including control-only reloads.
trap 'interrupted=1; log "收到停止信号：版本正在切换，检查结束后再退出"' INT TERM HUP
trap '' PIPE
if activate "$candidate" "$STATE"; then
  import_backup=''
  if [[ ! -d "$STATE" ]] || ! diff -qr "$candidate" "$STATE/" >/dev/null; then
    save_record "$candidate" || fail '程序已启动，但无法保存部署状态；请重新执行安装。'
  fi
  # Compatibility with a subsequent older installer.
  if ((configured)); then printf '%s\n' "$applied" >"$work_dir/applied"; put_file "$work_dir/applied" "$APP_DIR/.applied-config" 600; fi
else
  log '服务没有正常启动，最近日志：'; journal_tail
  restore_import
  if [[ -n "$previous_dir" && -d "$previous_dir" && -f "$CONF_DIR/config.json" ]]; then
    previous_version=$(head -n1 "$previous_dir/VERSION")
    if ! previous_check=$(as_service "$NODE_BIN" "$previous_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config 2>&1); then
      fail "新版本 $new_version 启动失败；上一版本 $previous_version 不接受当前配置（$previous_check），未回退。请恢复兼容配置后重新执行本脚本"
    fi
    if activate "$STATE" "$candidate"; then
      if [[ "$TEST_MODE" != 1 ]]; then ensure_import_path "$previous_dir"; fi
      fail "新版本 $new_version 启动失败，已回退到 $previous_version 并确认运行正常；请按上面的日志处理"
    fi
    journal_tail
    fail "新版本 $new_version 启动失败，已尝试切回 $previous_version，但服务仍未正常运行；请按日志处理后重新执行本脚本"
  fi
  if [[ "$TEST_MODE" != 1 ]]; then
    [[ ! -f "$UNIT_DIR/$CONTROL.service" ]] || steady systemctl disable --now --quiet "$CONTROL" || true
    steady systemctl disable --now --quiet "$SERVICE" || true
  fi
  fail '服务启动失败，尚无可运行的上一版；请按上面的日志检查配置后重新执行本脚本'
fi
if [[ "$TEST_MODE" != 1 || ${TP_TEST_ARM:-0} == 1 ]]; then ensure_import_path "$release_dir"; fi
trap 'exit 130' INT TERM HUP
trap - PIPE
if ((interrupted)); then log '已收到停止信号；服务已正常运行，安装已完成。'; fi

# The workbench's sender on this machine, when it pushes to the same receiver: the receiver takes the newest beat, so the
# two would alternate with different answers. Only its timer is switched off; its files stay.
if ((watch_change && !watch_off && configured)) && [[ "$TEST_MODE" != 1 && -f "$WATCH_SENDER" ]] && systemctl is-enabled --quiet main-watch-sender.timer 2>/dev/null; then
  pushed_to=$("$NODE_BIN" -e 'try { const w = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).watch; if (w && typeof w.url === "string") process.stdout.write(w.url); } catch {}' "$CONF_DIR/config.json")
  sender_to=$(sed -n 's/^[[:space:]]*HEARTBEAT_URL[[:space:]]*=[[:space:]]*//p' "$WATCH_SENDER" | tail -n 1 | tr -d "\"' ")
  if [[ -n "$pushed_to" && "$pushed_to" == "$sender_to" ]]; then
    if systemctl disable --now --quiet main-watch-sender.timer; then changes+=('停用工作台版本的心跳推送 main-watch-sender.timer（同一地址改由本服务推送；副服务器从此只收到本服务的就绪情况，工作台是否正常不再上报）')
    else log '无法停用 main-watch-sender.timer：它与本服务推送到同一地址，请手工执行 sudo systemctl disable --now main-watch-sender.timer'; fi
  fi
fi

# ---- 7. 清理旧版本 -------------------------------------------------------------------
current_dir=$(readlink -f "$APP_DIR/current")
executor_dir=$(read_value "$STATE/executor")
control_dir=$(read_value "$STATE/control")
kept=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  if [[ "$dir" == "$current_dir" || "$dir" == "$executor_dir" || "$dir" == "$control_dir" || "$dir" == "$previous_dir" ||
        "$dir" == "$previous_executor" || "$dir" == "$previous_control" ]] || ((kept < KEEP_RELEASES)); then kept=$((kept + 1)); continue; fi
  rm -rf "$dir"
done < <(find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d ! -name '*.staging' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -name '*.staging' -exec rm -rf {} +
find "$RECORDS" -mindepth 1 -maxdepth 1 -type d -name 'state.*' ! -path "$(readlink -f "$STATE")" -exec rm -rf {} +

# ---- 8. 小结 --------------------------------------------------------------------------
log "版本：$new_version"
if ((${#changes[@]})); then log "已更新：$(join "${changes[@]}")"; else log '无变化。'; fi
if ((${#skipped[@]})); then log "跳过：$(join "${skipped[@]}")"; fi
if ((!configured)); then
  log "下一步：参照 $CONF_DIR/config.example.json 与 secrets.example.json 写好 $CONF_DIR/config.json 与 secrets.json，再执行一次本脚本。"
else
  read -r port host < <("$NODE_BIN" -e 'let c = {}; try { c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
    const h = typeof c.host === "string" ? c.host : ""; process.stdout.write(String(c.port ?? 4720) + " " + (h.includes(":") ? "[" + h + "]" : h) + "\n");' "$CONF_DIR/config.json")
  if [[ -f "$CONF_DIR/login-password" ]]; then login_hint='用登录密码登录'; else login_hint="用 sudo cat $DATA_DIR/access-url 里的链接登录（设置登录密码：sudo bash install.sh --set-password）"; fi
  if [[ -n "$host" ]]; then
    log "页面：http://$host:$port/ ，$login_hint（Tailscale 不通时：ssh -N -L $port:127.0.0.1:$port <服务器> 后打开 http://127.0.0.1:$port/）。"
  else
    log "本机页面：在自己电脑上执行 ssh -N -L $port:127.0.0.1:$port <服务器>，再打开 http://127.0.0.1:$port/ ，$login_hint；在 config.json 写 \"host\": \"<Tailscale IP>\" 可免隧道。"
  fi
  [[ "${check:-}" != 配置有效：0\ 个配对* ]] || log "下一步：在页面「从工作台导入配对」里点「读取工作台」，勾选配对后导入；导入后在旧工作台删除该配对，再在页面启用。"
fi
