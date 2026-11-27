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
#   sudo bash install.sh --import-workbench --monitor-settings
#                                             同时启用行情监控，并导入工作台合约价差的模拟与手工持仓记录（本服务已有的保留；写入
#                                             待载入文件，运行中的服务下一次检查时载入，不重启）；可与 --monitor-alerts、--monitor-variational 同用
#   sudo bash install.sh --import-workbench --crossex
#                                             导入工作台 CrossEx 模块的 Gate 密钥、账户 UID 与额度（首次导入时连同页面设置）；
#                                             工作台未连接、还有未结束的执行 / 订单 / 挂单或缺 UID 时拒绝；可与其他导入项同用
#   sudo bash install.sh --import-workbench --ondo
#                                             启用 Ondo 挂单奖励：工作台 Ondo 挂单设置以观察模式带过来，工作台没有实盘会话记录时
#                                             一并导入 API Key（写入 secrets.json 的 ondo）；没有工作台 Ondo 数据时也可启用（只观察）
#   sudo bash install.sh --set-password       设置或更换页面登录密码（输入两次，不回显；只存 scrypt 摘要，已登录的页面须重新登录，只读接口令牌全部吊销；
#                                             沿用当前已装版本，不联网升级；脚本化时加 --password-stdin 从标准输入读一行）
#   sudo bash install.sh --watch-url <地址> --watch-token-stdin < /path/to/heartbeat-token
#                                             开启副服务器巡检心跳：每 30 秒向副服务器 main-watch 的心跳地址（如 http://<副服务器 IP>:8792/heartbeat）
#                                             推送签名心跳；地址与令牌由副服务器的 install-watch.sh 打印。只换地址时可不带 --watch-token
#   sudo bash install.sh --watch-import       同上，地址与令牌取自本机工作台版本的心跳推送端配置 /etc/main-watch/sender，并停用那个推送端
#   sudo bash install.sh --watch-off          关闭巡检心跳（回退到 v0.46.0 及更早版本前须先执行）。这三项与 --set-password 一样
#                                             沿用当前已装版本、不联网升级（已装版本早于 v0.47.0 时先升级到最新版）
#   sudo bash install.sh --set-mev --mev-executor <合约地址> --mev-owner <利润收款地址>
#                                             开启或修改 MEV 套利（Base 链上原子套利，docs/mev.md）：随后依次询问 Base 节点地址、
#                                             发送用节点地址（可留空）、专用热钱包私钥，都不回显、不进命令行；留空沿用已保存的值。
#                                             脚本化时加 --mev-stdin，从标准输入读这三行（发送用节点地址填 - 表示去掉）。
#                                             开启后是观察模式，实盘在页面上核对后手动开始；沿用当前已装版本、不联网升级（已装版本不带本模块时先升级到最新版）
#   sudo bash install.sh --unset-mev          关闭 MEV 套利并去掉节点地址与热钱包私钥（回退到不含该模块的版本前须先执行）；不换版本、不联网
#   sudo bash install.sh --set-dex-keys       录入或修改 DEX 价差实盘的场所账户（docs/dexspread.md 第 12.13 节）：依次询问 Lighter 主网账户编号、
#                                             Lighter RH 账户编号、Entropy 账户地址，都不回显、不进命令行；留空沿用已保存的值，填 - 去掉那个场所。
#                                             脚本化时加 --dex-keys-stdin，从标准输入读这三行。这一版只读账户的保证金与持仓，不下单；
#                                             沿用当前已装版本、不联网升级（已装版本不带这项时先升级到最新版），随后只重启 DEX 价差服务
#   sudo bash install.sh --unset-dex-keys     去掉场所账户并重启 DEX 价差服务；不换版本、不联网
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
CONTROL=$SERVICE-control
MARKET=$SERVICE-market
SERVICE_USER=trading-platform
CONTROL_USER=trading-platform-control
MARKET_USER=trading-platform-market
IPC_GROUP=trading-platform-ipc
MARKET_IPC_GROUP=trading-platform-market-ipc
MARKET_SOCKET=/run/trading-platform-market/market.sock
DEX=$SERVICE-dex
DEX_USER=trading-platform-dex
DEX_IPC_GROUP=trading-platform-dex-ipc
DEX_SOCKET=/run/trading-platform-dex/dex.sock
# The unit's StateDirectory; the installer creates it before the first copy (docs/dexspread.md 11.5).
DEX_STATE=/var/lib/trading-platform-dex
NODE_VERSION=24.15.0
KEEP_RELEASES=3
HEALTH_WAIT_S=90
APP_DIR=${TP_APP_DIR:-/opt/trading-platform}
CONF_DIR=${TP_CONF_DIR:-/etc/trading-platform}
# Venue accounts for DEX live trading (docs/dexspread.md 12.13). Root owns the directory and the file (0600): systemd
# hands the content to the DEX service as an EnvironmentFile, the service account cannot open the file. The content stays
# readable in /proc/<pid>/environ to processes of that account, so it holds account identifiers only (LESSONS L211).
DEX_CONF_DIR=${TP_DEX_CONF_DIR:-/etc/trading-platform-dex}
DEX_KEYS_FILE=$DEX_CONF_DIR/keys.env
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
UPDATE_DIR=${TP_UPDATE_DIR:-/var/lib/trading-platform-update}
if [[ "$TEST_MODE" == 1 && -z "${TP_UPDATE_DIR:-}" ]]; then UPDATE_DIR="$IMPORT_DIR-updates"; fi
UNIT_DIR=$(dirname "$UNIT_FILE")
IMPORT_UNITS=("$SERVICE-import.path" "$SERVICE-import.service")
# Each root helper watches its service account's private handoff, the trading import queue and the control update queue.
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
usage() { sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

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
import_monitor_settings=0
import_asset=0
import_crossex=0
import_ondo=0
asset_owner=''
set_password=0
password_stdin=0
watch_url=''
watch_token=''
watch_token_stdin=0
watch_import=0
watch_off=0
set_mev=0
unset_mev=0
mev_stdin=0
set_dex_keys=0
unset_dex_keys=0
dex_keys_stdin=0
mev_executor=''
mev_owner=''
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
    --monitor-settings) import_monitor_settings=1; shift ;;
    --asset) import_asset=1; shift ;;
    --asset-owner) [[ $# -ge 2 ]] || usage 2; asset_owner=$2; shift 2 ;;
    --crossex) import_crossex=1; shift ;;
    --ondo) import_ondo=1; shift ;;
    --set-password) set_password=1; shift ;;
    --password-stdin) password_stdin=1; shift ;;
    --watch-url) [[ $# -ge 2 && -n "$2" ]] || usage 2; watch_url=$2; shift 2 ;;
    --watch-token-stdin) watch_token_stdin=1; shift ;;
    --watch-token) [[ $# -ge 2 && -n "$2" ]] || usage 2; watch_token=$2; shift 2 ;;
    --watch-import) watch_import=1; shift ;;
    --watch-off) watch_off=1; shift ;;
    --set-mev) set_mev=1; shift ;;
    --unset-mev) unset_mev=1; shift ;;
    --mev-stdin) mev_stdin=1; shift ;;
    --set-dex-keys) set_dex_keys=1; shift ;;
    --unset-dex-keys) unset_dex_keys=1; shift ;;
    --dex-keys-stdin) dex_keys_stdin=1; shift ;;
    --mev-executor) [[ $# -ge 2 && -n "$2" ]] || usage 2; mev_executor=$2; shift 2 ;;
    --mev-owner) [[ $# -ge 2 && -n "$2" ]] || usage 2; mev_owner=$2; shift 2 ;;
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
((import_workbench || !import_monitor_settings)) || fail '--monitor-settings 须和 --import-workbench 一起使用'
((import_workbench || !import_asset)) || fail '--asset 须和 --import-workbench 一起使用'
((import_asset)) || [[ -z "$asset_owner" ]] || fail '--asset-owner 须和 --asset 一起使用'
((import_workbench || !import_crossex)) || fail '--crossex 须和 --import-workbench 一起使用'
((import_workbench || !import_ondo)) || fail '--ondo 须和 --import-workbench 一起使用'
((set_password || !password_stdin)) || fail '--password-stdin 须和 --set-password 一起使用'
watch_change=0
if [[ -n "$watch_url" ]] || ((watch_import || watch_off)); then watch_change=1; fi
[[ -z "$watch_url" ]] || ((!watch_import && !watch_off)) || fail '--watch-url、--watch-import、--watch-off 只能用一个'
((!watch_import || !watch_off)) || fail '--watch-url、--watch-import、--watch-off 只能用一个'
if ((watch_token_stdin)); then
  [[ -n "$watch_url" && -z "$watch_token" ]] || fail '--watch-token-stdin 须与 --watch-url 一起使用，且不能同时给出 --watch-token'
  ((!password_stdin && !mev_stdin && !dex_keys_stdin)) || fail '多个参数同时读取标准输入，请分开执行'
  [[ -f "$0" ]] || fail '请先下载 install.sh 再使用 --watch-token-stdin'
  IFS= read -r watch_token || [[ -n "$watch_token" ]] || fail '没有从标准输入读到心跳令牌'
  [[ -n "$watch_token" ]] || fail '心跳令牌不能为空'
fi
[[ -z "$watch_token" || -n "$watch_url" ]] || fail '--watch-token 须和 --watch-url 一起使用'
[[ -z "$watch_token" || "$watch_token" =~ ^[A-Za-z0-9_-]{32,256}$ ]] || fail '--watch-token 须为 32~256 位字母、数字、- 或 _（副服务器 /etc/main-watch/config 的 HEARTBEAT_TOKEN）'
mev_change=0
if ((set_mev || unset_mev)); then mev_change=1; fi
((!set_mev || !unset_mev)) || fail '--set-mev 与 --unset-mev 只能用一个'
((set_mev)) || [[ -z "$mev_executor$mev_owner" ]] || fail '--mev-executor 与 --mev-owner 须和 --set-mev 一起使用'
((set_mev || !mev_stdin)) || fail '--mev-stdin 须和 --set-mev 一起使用'
((!set_mev)) || [[ "$mev_executor" =~ ^0x[0-9a-fA-F]{40}$ && "$mev_owner" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail '--set-mev 须同时给出 --mev-executor 与 --mev-owner（0x 开头的 40 位十六进制地址）'
((!mev_stdin || !password_stdin)) || fail '--mev-stdin 与 --password-stdin 都读标准输入，请分两次执行'
dex_keys_change=0
if ((set_dex_keys || unset_dex_keys)); then dex_keys_change=1; fi
((!set_dex_keys || !unset_dex_keys)) || fail '--set-dex-keys 与 --unset-dex-keys 只能用一个'
((set_dex_keys || !dex_keys_stdin)) || fail '--dex-keys-stdin 须和 --set-dex-keys 一起使用'
((!dex_keys_stdin || (!password_stdin && !mev_stdin))) || fail '--dex-keys-stdin 与 --password-stdin、--mev-stdin 都读标准输入，请分开执行'
((!set_dex_keys || !set_mev || dex_keys_stdin || mev_stdin)) || fail '--set-dex-keys 与 --set-mev 都要在终端里逐项询问，请分两次执行'

[[ "$(uname -s)" == Linux ]] || fail '只支持 Linux。'
if [[ "$TEST_MODE" != 1 ]]; then
  [[ $EUID -eq 0 ]] || fail '需要 root 运行：sudo bash install.sh'
  for cmd in systemctl useradd groupadd getent runuser; do command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"; done
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
# The node address (it may carry the provider's key) and the hot wallet's key are asked for the same way: hidden
# prompts on a terminal, three lines with --mev-stdin. Neither is ever an argument, so neither shows in ps or history.
mev_input=''
if ((set_mev)); then
  if ((mev_stdin)); then
    [[ -f "$0" ]] || fail '脚本本身从标准输入读入时不能用 --mev-stdin：先下载 install.sh 再执行'
    IFS= read -r mev_rpc || true
    IFS= read -r mev_send || true
    IFS= read -r mev_key || true
  elif [[ -t 0 ]]; then
    IFS= read -rs -p 'Base 节点地址（https，不回显；留空沿用已保存的）：' mev_rpc; printf '\n' >&2
    IFS= read -rs -p '发送交易用的节点地址（不回显；留空沿用已保存的或与上一项相同，填 - 去掉）：' mev_send; printf '\n' >&2
    IFS= read -rs -p '专用热钱包私钥（64 位十六进制，不回显；留空沿用已保存的）：' mev_key; printf '\n' >&2
  else
    [[ -f "$0" ]] || fail '标准输入不是终端：请先下载 install.sh，再在终端里执行 sudo bash install.sh --set-mev …'
    fail '标准输入不是终端：请在终端里执行，或加 --mev-stdin 从标准输入读三行（节点地址、发送用节点地址、热钱包私钥）'
  fi
  mev_input=$(printf '%s\n%s\n%s' "$mev_rpc" "$mev_send" "$mev_key")
  unset mev_rpc mev_send mev_key
fi
# Venue accounts for DEX live trading are asked for the same way and never become arguments.
dex_keys_input=''
if ((set_dex_keys)); then
  if ((dex_keys_stdin)); then
    [[ -f "$0" ]] || fail '脚本本身从标准输入读入时不能用 --dex-keys-stdin：先下载 install.sh 再执行'
    IFS= read -r dex_lighter || true
    IFS= read -r dex_rh || true
    IFS= read -r dex_entropy || true
  elif [[ -t 0 ]]; then
    IFS= read -rs -p 'Lighter 主网账户编号（不回显；留空沿用已保存的，填 - 去掉）：' dex_lighter; printf '\n' >&2
    IFS= read -rs -p 'Lighter RH 账户编号（不回显；留空沿用已保存的，填 - 去掉）：' dex_rh; printf '\n' >&2
    IFS= read -rs -p 'Entropy（Hyperliquid）账户地址（0x 开头，不回显；留空沿用已保存的，填 - 去掉）：' dex_entropy; printf '\n' >&2
  else
    [[ -f "$0" ]] || fail '标准输入不是终端：请先下载 install.sh，再在终端里执行 sudo bash install.sh --set-dex-keys'
    fail '标准输入不是终端：请在终端里执行，或加 --dex-keys-stdin 从标准输入读三行（Lighter 主网账户编号、Lighter RH 账户编号、Entropy 账户地址）'
  fi
  dex_keys_input=$(printf '%s\n%s\n%s' "$dex_lighter" "$dex_rh" "$dex_entropy")
  unset dex_lighter dex_rh dex_entropy
fi


as_root_dir() { # path mode [owner group]
  if [[ "$TEST_MODE" == 1 ]]; then install -d -m "$2" "$1"; else install -d -m "$2" -o "${3:-root}" -g "${4:-root}" "$1"; fi
}
as_user() { local user=$1; shift; if [[ "$TEST_MODE" == 1 ]]; then (cd / && "$@"); else (cd / && runuser -u "$user" -- "$@"); fi; }
as_service() { as_user "$SERVICE_USER" "$@"; }
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
trap 'trap "" INT TERM HUP; restore_import; rm -rf "$work_dir"; flock -u 9' EXIT
trap 'exit 130' INT TERM HUP

# ---- 1. 校验清单与程序包 ----------------------------------------------------------
# Changing only the password or the heartbeat keeps the installed release: nothing is downloaded and the program does
# not change. An installed release from before the heartbeat existed cannot switch it, so that case takes the latest.
installed_sha=$(cat "$APP_DIR/current/.package-sha256" 2>/dev/null || true)
keep_installed=0
if [[ -z "$version$package_dir" && "$installed_sha" =~ ^[a-f0-9]{64}$ ]]; then
  if ((set_password)) || { ((watch_change)) && [[ -f "$APP_DIR/current/src/service/watch-config.ts" ]]; } ||
     { ((mev_change)) && [[ -f "$APP_DIR/current/src/service/mev-setup.ts" ]]; }; then keep_installed=1; fi
  # Turning the module on needs a release that has it: an installed one from before it existed takes the latest.
  if ((set_mev)) && [[ ! -f "$APP_DIR/current/src/service/mev-setup.ts" ]]; then keep_installed=0; fi
  # Turning it off never changes the release: on one from before the module there is nothing to remove.
  if ((unset_mev)); then keep_installed=1; fi
  # The venue accounts follow the same rule: keep the installed release when it can hold them, removal never moves it.
  if ((set_dex_keys)); then if [[ -f "$APP_DIR/current/src/dex/keys-setup.ts" ]]; then keep_installed=1; else keep_installed=0; fi; fi
  if ((unset_dex_keys)); then keep_installed=1; fi
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
read_value() { if [[ -f "$1" ]]; then cat "$1"; fi; }
split=0
if [[ -e "$release_dir/src/control" || -e "$release_dir/deploy/$CONTROL.service" || -e "$release_dir/.control-sha256" ]]; then
  split=1
  [[ -f "$release_dir/src/control/main.ts" && -f "$release_dir/src/control/probe.ts" && -f "$release_dir/deploy/$CONTROL.service" &&
     "$(read_value "$release_dir/.executor-sha256")" =~ ^[0-9a-f]{64}$ && "$(read_value "$release_dir/.control-sha256")" =~ ^[0-9a-f]{64}$ ]] ||
    fail '控制面与执行面程序包不完整，未切换版本。'
fi
if [[ -e "$release_dir/src/market" || -e "$release_dir/deploy/$MARKET.service" || -e "$release_dir/.market-sha256" ]]; then
  [[ "$split" == 1 && -f "$release_dir/src/market/main.ts" && -f "$release_dir/src/market/probe.ts" &&
     -f "$release_dir/deploy/$MARKET.service" && "$(read_value "$release_dir/.market-sha256")" =~ ^[0-9a-f]{64}$ ]] ||
    fail '公开行情组件程序包不完整，未切换版本。'
fi
if [[ -e "$release_dir/src/dex" || -e "$release_dir/deploy/$DEX.service" || -e "$release_dir/.dex-sha256" ]]; then
  [[ "$split" == 1 && -f "$release_dir/src/dex/main.ts" && -f "$release_dir/src/dex/probe.ts" && -f "$release_dir/src/dex/move-db.ts" &&
     -f "$release_dir/deploy/$DEX.service" && "$(read_value "$release_dir/.dex-sha256")" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'DEX 价差组件程序包不完整，未切换版本。'
fi

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
    # nodejs.org/dist/v24.15.0/SHASUMS256.txt, pinned with the version.
    case "$archive" in
      node-v24.15.0-linux-x64.tar.xz) checksum=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6 ;;
      node-v24.15.0-linux-arm64.tar.xz) checksum=f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0 ;;
      *) fail '缺少此版本 Node.js 包的固定校验值' ;;
    esac
    fetch "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" "$work_dir/$archive"
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
CONTROL_UID='' CONTROL_GID=''
if ((split)) || [[ -f "$APP_DIR/control/.control-sha256" ]]; then
  if [[ "$TEST_MODE" == 1 ]]; then CONTROL_UID=$(id -u); CONTROL_GID=$(id -g)
  else
    getent group "$IPC_GROUP" >/dev/null || groupadd --system "$IPC_GROUP"
    if ! getent passwd "$CONTROL_USER" >/dev/null; then
      useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$CONTROL_USER"
      changes+=("系统账号 $CONTROL_USER")
    fi
    CONTROL_UID=$(id -u "$CONTROL_USER"); CONTROL_GID=$(id -g "$CONTROL_USER")
    [[ "$CONTROL_UID" != 0 && "$CONTROL_UID" != "$(id -u "$SERVICE_USER")" &&
       " $(id -G "$CONTROL_USER") " != *" $(id -g "$SERVICE_USER") "* &&
       " $(id -G "$SERVICE_USER") " != *" $CONTROL_GID "* &&
       "$CONTROL_GID" == "$(getent group "$CONTROL_USER" | cut -d: -f3)" ]] || fail '两个服务须使用不同的专用账户及私有组。'
  fi
  [[ "$UPDATE_DIR" == /* ]] || fail '更新交接目录须为绝对路径。'
  update_path=$(realpath -m "$UPDATE_DIR")
  protected_dirs=("$APP_DIR" "$CONF_DIR" "$DATA_DIR" "$IMPORT_DIR" /run/trading-platform /run/trading-platform-market /run/trading-platform-dex "$DEX_STATE")
  old_units=("$UNIT_FILE")
  if [[ "$TEST_MODE" != 1 ]]; then
    protected_dirs+=("$UNIT_DIR" /etc/systemd/system /opt/trading-platform /etc/trading-platform /var/lib/trading-platform /var/lib/trading-platform-import)
    [[ "$UNIT_FILE" == "/etc/systemd/system/$SERVICE.service" ]] || old_units+=("/etc/systemd/system/$SERVICE.service")
  fi
  # Keep previous non-standard locations protected when this invocation changes a directory override.
  for unit in "${old_units[@]}"; do
    [[ -f "$unit" ]] || continue
    while IFS= read -r old_dir; do protected_dirs+=("$old_dir"); done < <(awk '/^ExecStart=/ {
      for (i=1; i<=NF; i++) {
        if ($i == "--data-dir" || $i == "--import-dir") print $(i+1);
        if ($i == "--config") { dir=$(i+1); sub(/\/[^/]+$/, "", dir); print dir; }
        if ($i ~ /\/(current|executor)\/src\/service\/main[.]ts$/) { dir=$i; sub(/\/(current|executor)\/src\/service\/main[.]ts$/, "", dir); print dir; }
      }
    }' "$unit")
  done
  for protected in "${protected_dirs[@]}"; do
    protected_path=$(realpath -m "$protected")
    [[ "$update_path" != / && "$update_path" != "$protected_path" && "$protected_path" != "$update_path/"* &&
       "$update_path" != "$protected_path/"* ]] || fail '更新交接目录须与程序、配置、执行数据和导入交接目录隔离。'
  done
  # The root update helper uses lstat on the directory and its immediate parent. Check the same parent before
  # provisioning the leaf: install -d would otherwise follow a link or create a missing directory chain.
  expected_owner=0
  [[ "$TEST_MODE" != 1 ]] || expected_owner=$(id -u)
  update_parent=$(dirname -- "$UPDATE_DIR")
  if [[ ! -d "$update_parent" || -L "$update_parent" || "$(stat -c %u -- "$update_parent")" != "$expected_owner" ]] ||
      (( (8#$(stat -c %a -- "$update_parent") & 0022) != 0 )); then
    fail "更新交接目录的父目录 $update_parent 须已存在、由安装账户所有，且不是符号链接，组和其他人不可写。"
  fi
  # Never take over another existing directory (including paths used by an older install with other overrides).
  # An existing handoff is already provisioned for the dedicated group. Leave its ownership and mode untouched.
  if [[ -e "$UPDATE_DIR" || -L "$UPDATE_DIR" ]]; then
    [[ -d "$UPDATE_DIR" && ! -L "$UPDATE_DIR" && "$(stat -c '%u:%g %a' "$UPDATE_DIR")" == "$expected_owner:$CONTROL_GID 770" ]] ||
      fail "已有的 $UPDATE_DIR 不属于专用更新交接目录，请指定独立新目录。"
  else
    as_root_dir "$UPDATE_DIR" 770 root "$CONTROL_USER"
  fi
fi
ensure_market_account() {
  local target=$1 market_uid market_gid market_groups market_ipc_gid members member gid
  local -a ipc_members
  # Validate the release about to take ownership, including an automatic rollback. Removing the market unit
  # must remain possible even if another local account has since joined its socket group.
  [[ "$TEST_MODE" != 1 && -f "$target/.market-sha256" ]] || return 0
  getent group "$MARKET_IPC_GROUP" >/dev/null || groupadd --system "$MARKET_IPC_GROUP" || return 1
  if ! getent passwd "$MARKET_USER" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$MARKET_USER" || return 1
    changes+=("系统账号 $MARKET_USER")
  fi
  market_uid=$(id -u "$MARKET_USER") || return 1
  market_gid=$(id -g "$MARKET_USER") || return 1
  IFS=: read -r _ _ market_ipc_gid members <<<"$(getent group "$MARKET_IPC_GROUP")"
  [[ "$market_ipc_gid" =~ ^[0-9]+$ && "$market_uid" != 0 && "$market_uid" != "$(id -u "$SERVICE_USER")" && "$market_uid" != "$CONTROL_UID" &&
     "$market_gid" == "$(getent group "$MARKET_USER" | cut -d: -f3)" && "$market_gid" != "$market_ipc_gid" &&
     " $(id -G "$CONTROL_USER") " != *" $market_ipc_gid "* ]] || { log '行情服务须使用独立的账户和通信组。'; return 1; }
  for gid in 0 "$(id -g "$SERVICE_USER")" "$CONTROL_GID" "$(getent group "$IPC_GROUP" | cut -d: -f3)" \
      "$(getent group "$DEX_USER" | cut -d: -f3)" "$(getent group "$DEX_IPC_GROUP" | cut -d: -f3)"; do
    [[ -z "$gid" || ( "$market_gid" != "$gid" && "$market_ipc_gid" != "$gid" ) ]] || { log '行情服务不能共用交易、控制、DEX 价差或特权组。'; return 1; }
  done
  # A pre-existing group can also grant socket access through an unrelated account's primary GID.
  IFS=, read -r -a ipc_members <<<"$members"
  for member in "${ipc_members[@]}"; do
    [[ "$member" == "$MARKET_USER" || "$member" == "$SERVICE_USER" ]] || { log '行情通信组已授予其他账户，请恢复专用组后再安装。'; return 1; }
  done
  getent passwd | awk -F: -v gid="$market_ipc_gid" -v market="$MARKET_USER" -v executor="$SERVICE_USER" \
    '$4 == gid && $1 != market && $1 != executor { bad=1 } END { exit bad }' || { log '行情通信组已用作其他账户的主组，请恢复专用组后再安装。'; return 1; }
  # systemd adds a user's login groups to its service groups. An existing account must not bring unrelated access.
  market_groups=$(id -G "$MARKET_USER") || return 1
  for gid in $market_groups; do
    [[ "$gid" == "$market_gid" || "$gid" == "$market_ipc_gid" ]] || { log '行情账户已加入其他组，请恢复专用账户后再安装。'; return 1; }
  done
}
ensure_market_account "$release_dir" || fail '目标版本的行情账户未通过核验，已保留当前服务。'
# The DEX spread service (docs/dexspread.md 11.9) gets the same checks as the market account. The executor unit names its
# socket group, so the account and groups exist whenever the release carries the component, even with the module off.
ensure_dex_account() {
  local target=$1 dex_uid dex_gid dex_groups dex_ipc_gid members member gid
  local -a ipc_members
  [[ "$TEST_MODE" != 1 && -f "$target/.dex-sha256" ]] || return 0
  getent group "$DEX_IPC_GROUP" >/dev/null || groupadd --system "$DEX_IPC_GROUP" || return 1
  if ! getent passwd "$DEX_USER" >/dev/null; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$DEX_USER" || return 1
    changes+=("系统账号 $DEX_USER")
  fi
  dex_uid=$(id -u "$DEX_USER") || return 1
  dex_gid=$(id -g "$DEX_USER") || return 1
  IFS=: read -r _ _ dex_ipc_gid members <<<"$(getent group "$DEX_IPC_GROUP")"
  [[ "$dex_ipc_gid" =~ ^[0-9]+$ && "$dex_uid" != 0 && "$dex_uid" != "$(id -u "$SERVICE_USER")" && "$dex_uid" != "$CONTROL_UID" &&
     "$dex_gid" == "$(getent group "$DEX_USER" | cut -d: -f3)" && "$dex_gid" != "$dex_ipc_gid" &&
     " $(id -G "$CONTROL_USER") " != *" $dex_ipc_gid "* ]] || { log 'DEX 价差服务须使用独立的账户和通信组。'; return 1; }
  if getent passwd "$MARKET_USER" >/dev/null; then
    [[ "$dex_uid" != "$(id -u "$MARKET_USER")" && " $(id -G "$MARKET_USER") " != *" $dex_ipc_gid "* ]] || { log 'DEX 价差服务不能与行情服务共用账户或通信组。'; return 1; }
  fi
  for gid in 0 "$(id -g "$SERVICE_USER")" "$CONTROL_GID" "$(getent group "$IPC_GROUP" | cut -d: -f3)" \
      "$(getent group "$MARKET_USER" | cut -d: -f3)" "$(getent group "$MARKET_IPC_GROUP" | cut -d: -f3)"; do
    [[ -z "$gid" || ( "$dex_gid" != "$gid" && "$dex_ipc_gid" != "$gid" ) ]] || { log 'DEX 价差服务不能共用交易、控制、行情或特权组。'; return 1; }
  done
  IFS=, read -r -a ipc_members <<<"$members"
  for member in "${ipc_members[@]}"; do
    [[ "$member" == "$DEX_USER" || "$member" == "$SERVICE_USER" ]] || { log 'DEX 价差通信组已授予其他账户，请恢复专用组后再安装。'; return 1; }
  done
  getent passwd | awk -F: -v gid="$dex_ipc_gid" -v dex="$DEX_USER" -v executor="$SERVICE_USER" \
    '$4 == gid && $1 != dex && $1 != executor { bad=1 } END { exit bad }' || { log 'DEX 价差通信组已用作其他账户的主组，请恢复专用组后再安装。'; return 1; }
  dex_groups=$(id -G "$DEX_USER") || return 1
  for gid in $dex_groups; do
    [[ "$gid" == "$dex_gid" || "$gid" == "$dex_ipc_gid" ]] || { log 'DEX 价差账户已加入其他组，请恢复专用账户后再安装。'; return 1; }
  done
}
ensure_dex_account "$release_dir" || fail '目标版本的 DEX 价差账户未通过核验，已保留当前服务。'
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
  if ((import_monitor_settings)); then grep -q 'inspectPerpetualImport' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --monitor-settings，请用最新版本导入"; fi
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
  ((!import_monitor_settings)) || import_args+=(--monitor-settings)
  # The ledger, the alert tiers, the Var token and the pending paper records go into the service's data directory, written
  # by the importer as that directory's owner.
  ((!import_asset)) || import_args+=(--asset)
  ((!import_asset && !import_monitor_alerts && !import_monitor_variational && !import_monitor_paper && !import_monitor_settings)) || import_args+=(--data-dir "$DATA_DIR")
  [[ -z "$asset_owner" ]] || import_args+=(--asset-owner "$asset_owner")
  # The CrossEx page settings go into the same data directory (named once when an item above already named it).
  ((!import_crossex)) || import_args+=(--crossex)
  ((!import_crossex || import_asset || import_monitor_alerts || import_monitor_variational || import_monitor_paper || import_monitor_settings)) || import_args+=(--data-dir "$DATA_DIR")
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
# MEV arbitrage (docs/mev.md): the contract and owner addresses go into config.json, the node address and the hot
# wallet's key into the key file. Run as root like the import; the secrets reach the program on stdin only.
if ((mev_change)); then
  if [[ ! -f "$release_dir/src/service/mev-setup.ts" ]]; then
    # Turning off what a release without the module cannot hold needs nothing from that release.
    ((set_mev)) && fail "版本 $new_version 不支持 MEV 套利，请用最新版本"
    grep -q '"mev"' "$CONF_DIR/config.json" 2>/dev/null && fail "版本 $new_version 不含 MEV 套利模块：先在当前版本上执行 sudo bash install.sh --unset-mev，再安装它"
  else
    [[ -f "$CONF_DIR/config.json" ]] || fail "尚无 $CONF_DIR/config.json，无法设置 MEV 套利"
    backup_conf_files '设置 MEV 套利'
    set_mev_files() { (cd / && "$NODE_BIN" "$release_dir/src/service/mev-setup.ts" --config "$CONF_DIR/config.json" "$@" 9>&-); }
    if ((unset_mev)); then set_mev_files --off </dev/null || fail '关闭 MEV 套利失败'
    else printf '%s\n' "$mev_input" | set_mev_files --executor "$mev_executor" --owner "$mev_owner" || fail '设置 MEV 套利失败'; fi
  fi
  mev_input=''
fi
# Venue accounts for DEX live trading (docs/dexspread.md 12.13). The file lives in a root-owned directory the service
# account cannot write, so root may write it by path (L201). Its digest is part of the DEX component key below, so a
# change restarts only the DEX service.
if ((dex_keys_change)); then
  if ((unset_dex_keys)); then
    # Removal needs nothing from the release: a rollback target without the helper must still be able to drop the file.
    if [[ -e "$DEX_KEYS_FILE" || -L "$DEX_KEYS_FILE" ]]; then rm -f "$DEX_KEYS_FILE" || fail '去掉 DEX 价差场所账户失败'; changes+=('DEX 价差场所账户已去掉'); else skipped+=('DEX 价差场所账户（本来就没有）'); fi
  else
    [[ -f "$release_dir/src/dex/keys-setup.ts" ]] || fail "版本 $new_version 不支持录入 DEX 价差场所账户，请用最新版本"
    as_root_dir "$DEX_CONF_DIR" 755
    dex_keys_out=$(printf '%s\n' "$dex_keys_input" | (cd / && "$NODE_BIN" "$release_dir/src/dex/keys-setup.ts" --file "$DEX_KEYS_FILE" 9>&-)) || fail '录入 DEX 价差场所账户失败'
    # The helper creates the file 0600. Nothing here may touch an unchanged file: the running service compares its ctime,
    # and an unchanged digest means no restart, so even a no-op chmod would leave it refusing the accounts.
    log "$dex_keys_out"
  fi
  dex_keys_input=''
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
    changes+=('登录密码（已打开的页面须重新登录，只读接口令牌已全部吊销）')
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
STATE="$APP_DIR/.deployment"
RECORDS="$APP_DIR/.deployments"
as_root_dir "$RECORDS" 700
candidate="$work_dir/candidate"
mkdir -m 700 "$candidate"
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
# An explicitly restored monolith may have been activated by its own installer, which predates our record.
external_legacy=0
if [[ -d "$STATE" && -n "$previous_dir" && "$previous_dir" != "$(read_value "$STATE/current")" &&
      ! -f "$previous_dir/.executor-sha256" && ! -e "$APP_DIR/.restarting-executor" ]] &&
   grep -qF "$APP_DIR/current/src/service/main.ts" "$UNIT_FILE" &&
   { [[ "$TEST_MODE" == 1 ]] || { systemctl is-active --quiet "$SERVICE" && ! systemctl is-active --quiet "$SERVICE-control"; }; }; then
  external_legacy=1
fi
if [[ ! -d "$STATE" ]] || ((external_legacy)); then
  initial="$work_dir/previous"
  mkdir -m 700 "$initial"
  printf '%s\n' "$previous_dir" >"$initial/current"
  # Bootstrap an existing installation (v0.63.0 and older had only current and the main unit).
  if [[ -n "$previous_dir" ]]; then cp "$UNIT_FILE" "$initial/executor.service" || fail '找不到已安装的服务单元，未切换版本。'; fi
  if [[ -n "$previous_dir" && -f "$previous_dir/.executor-sha256" && -f "$UNIT_DIR/$CONTROL.service" && -L "$APP_DIR/executor" && -L "$APP_DIR/control" ]]; then
    readlink -f "$APP_DIR/executor" >"$initial/executor"
    readlink -f "$APP_DIR/control" >"$initial/control"
    cp "$UNIT_DIR/$CONTROL.service" "$initial/control.service"
    cp "$APP_DIR/control-listen.json" "$APP_DIR/control-proxy.env" "$initial/"
  fi
  if [[ -n "$previous_dir" && -f "$previous_dir/.market-sha256" && -f "$UNIT_DIR/$MARKET.service" && -L "$APP_DIR/market" ]]; then
    readlink -f "$APP_DIR/market" >"$initial/market"
    cp "$UNIT_DIR/$MARKET.service" "$initial/market.service"
    cp "$APP_DIR/market.env" "$initial/market.env"
  fi
  if [[ -n "$previous_dir" && -f "$previous_dir/.dex-sha256" && -f "$UNIT_DIR/$DEX.service" && -L "$APP_DIR/dex" ]]; then
    readlink -f "$APP_DIR/dex" >"$initial/dex"
    cp "$UNIT_DIR/$DEX.service" "$initial/dex.service"
    cp "$APP_DIR/dex.env" "$initial/dex.env"
  fi
  for unit in "${HELPER_UNITS[@]}"; do
    [[ ! -f "$UNIT_DIR/$unit" ]] || cp "$UNIT_DIR/$unit" "$initial/$unit"
  done
  save_record "$initial" || fail '无法保存当前版本的回退信息，未切换版本。'
fi
previous_dir=$(read_value "$STATE/current")
previous_executor=$(read_value "$STATE/executor")
previous_control=$(read_value "$STATE/control")
previous_market=$(read_value "$STATE/market")
previous_dex=$(read_value "$STATE/dex")
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
  elif check=$(as_service "$NODE_BIN" "$release_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config 2>&1); then
    printf '%s\n' "$check" >"$candidate/check-output"
  else
    fail "配置检查未通过，服务保持原版本：$check"
  fi
  check=$(cat "$candidate/check-output")
  log "$check"
  # A new password ends the sessions and revokes every read-only token (docs/mcp.md 8.4); the service refuses them as
  # soon as the file is gone and never writes it back.
  if ((set_password)); then rm -f "$DATA_DIR/http-session" "$DATA_DIR/read-token.json"; fi
elif [[ -n "$previous_dir" ]]; then
  log '尚无 config.json，已保留当前程序、服务及数据。'
  exit 0
fi

# ---- 5. 准备独立组件和页面版本 --------------------------------------------------------
# The DEX spread module runs unless config.json says "varLighter": false; turning it on or off takes a rerun of this
# script (docs/dexspread.md 11.9). Read as the service account, like the other configuration reads.
dex_enabled=0
if ((configured)) && as_service "$NODE_BIN" -e 'process.exitCode = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).varLighter === false ? 1 : 0' \
    "$CONF_DIR/config.json" 2>/dev/null; then dex_enabled=1; fi
FLOCK_BIN=$(command -v flock)
render_to() {
  [[ -f "$1" ]] && sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@CONF_DIR@|$CONF_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@IMPORT_DIR@|$IMPORT_DIR|g" -e "s|@UPDATE_DIR@|$UPDATE_DIR|g" -e "s|@CONTROL_UID@|$CONTROL_UID|g" -e "s|@CONTROL_GID@|$CONTROL_GID|g" \
    -e "s|@FLOCK@|$FLOCK_BIN|g" -e "s|@WORKBENCH_ENV@|$WORKBENCH_ENV|g" -e "s|@DEX_CONF_DIR@|$DEX_CONF_DIR|g" "$1" >"$2" && [[ -s "$2" ]]
}
# Copy only whole EnvironmentFile assignments. An allowed-looking line inside a private quoted or continued
# value belongs to the private key. Preserve quoting for systemd and never pass private values on a command line.
project_environment() {
  "$NODE_BIN" --input-type=module - "$CONF_DIR/environment" "$1" <<'JS'
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [file, out] = process.argv.slice(2);
const source = existsSync(file) ? readFileSync(file, 'utf8').split('\0', 1)[0] : '';
const proxyKeys = new Set(['NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
const marketKeys = new Set(['COINGECKO_DEMO_API_KEY', 'PERPETUAL_COIN_IDS']);
const execution = createHash('sha256');
let proxy = '', market = '';
const newline = ch => ch === '\n' || ch === '\r';
for (let start = 0; start < source.length;) {
  let lineEnd = start;
  while (lineEnd < source.length && !newline(source[lineEnd])) lineEnd++;
  const line = source.slice(start, lineEnd), equals = line.indexOf('=');
  if (equals < 0 || /^[\t\v\f ]*[#;]/.test(line)) { start = lineEnd + 1; continue; }
  const key = line.slice(0, equals).trim();
  let end = start + equals + 1, mode = 'leading';
  for (; end < source.length; end++) {
    const ch = source[end];
    if (ch === '\\' && mode !== "'") { if (mode === 'leading') mode = 'raw'; end++; continue; }
    if (mode === '"' || mode === "'") { if (ch === mode) mode = 'leading'; continue; }
    if (newline(ch)) break;
    if (mode === 'leading' && !/[\t\v\f ]/.test(ch)) mode = ch === '"' || ch === "'" ? ch : 'raw';
  }
  const record = source.slice(start, end) + '\n';
  if (proxyKeys.has(key)) proxy += record;
  if (proxyKeys.has(key) || marketKeys.has(key)) market += record;
  if (!marketKeys.has(key)) execution.update(record);
  start = end + 1;
}
writeFileSync(join(out, 'control-proxy.env'), proxy, { mode: 0o600 });
if (existsSync(join(out, 'dex'))) writeFileSync(join(out, 'dex.env'), proxy, { mode: 0o600 });
if (existsSync(join(out, 'market'))) {
  writeFileSync(join(out, 'market.env'), market, { mode: 0o600 });
  writeFileSync(join(out, 'executor-env-key'), execution.digest('hex') + '\n', { mode: 0o600 });
}
JS
}
# Build both forward and rollback records against the configuration that will actually remain on disk. The fixed
# code pins survive page releases; public listen settings and the expected runtime config must match the same files.
prepare_record() {
  local target=$1 pins=$2 out=$3 name existing unit
  printf '%s\n' "$target" >"$out/current" || return 1
  render_to "$target/deploy/trading-platform.service" "$out/executor.service" || return 1
  if [[ -f "$target/.control-sha256" ]]; then
    for name in executor control market dex; do
      [[ -f "$target/.$name-sha256" ]] || continue
      [[ "$name" != dex ]] || ((dex_enabled)) || continue
      existing=$(read_value "$pins/$name")
      if [[ -n "$existing" && -d "$existing" ]] && cmp -s "$target/.$name-sha256" "$existing/.$name-sha256"; then
        printf '%s\n' "$existing" >"$out/$name" || return 1
      else printf '%s\n' "$target" >"$out/$name" || return 1; fi
    done
    render_to "$target/deploy/$CONTROL.service" "$out/control.service" || return 1
    if ((configured)); then
      as_service "$NODE_BIN" "$target/src/service/config-fingerprint.ts" "$CONF_DIR/config.json" >"$out/config-key" &&
        [[ "$(read_value "$out/config-key")" =~ ^[0-9a-f]{64}$ ]] || return 1
      as_service "$NODE_BIN" --input-type=module - "$CONF_DIR/config.json" "$target/src/service/listen-config.ts" >"$out/control-listen.json" <<'JS' || return 1
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { parseListenConfig } = await import(pathToFileURL(process.argv[3]));
const { port, host } = parseListenConfig(JSON.parse(readFileSync(process.argv[2], 'utf8')));
console.log(JSON.stringify({ port, host }));
JS
    else printf '%s\n' '{"port":4720,"host":null}' >"$out/control-listen.json" || return 1; fi
    # Only the selected proxy settings reach the browser's separate UID. The main configuration and private key
    # files, including a key outside the config directory, remain readable only by the execution account.
    project_environment "$out" || return 1
    { printf '%s\n' "$node_identity"; cat "$target/.control-sha256"; sha256sum <"$out/control.service"; sha256sum <"$out/control-listen.json"; sha256sum <"$out/control-proxy.env"; } \
      | sha256sum | cut -d' ' -f1 >"$out/control-key" || return 1
    if [[ -f "$out/market" ]]; then
      render_to "$target/deploy/$MARKET.service" "$out/market.service" || return 1
      { printf '%s\n' "$node_identity"; cat "$target/.market-sha256"; sha256sum <"$out/market.service"; sha256sum <"$out/market.env"; } \
        | sha256sum | cut -d' ' -f1 >"$out/market-key" || return 1
    fi
    if [[ -f "$out/dex" ]]; then
      render_to "$target/deploy/$DEX.service" "$out/dex.service" || return 1
      # The venue accounts reach the service only at start, so a changed or removed file must restart it.
      { printf '%s\n' "$node_identity"; cat "$target/.dex-sha256"; sha256sum <"$out/dex.service"; sha256sum <"$out/dex.env"
        if [[ -f "$DEX_KEYS_FILE" ]]; then sha256sum <"$DEX_KEYS_FILE"; fi; } \
        | sha256sum | cut -d' ' -f1 >"$out/dex-key" || return 1
    fi
  fi
  {
    printf '%s\n' "$node_identity"
    if [[ -f "$out/executor" ]]; then cat "$target/.executor-sha256"; else cat "$target/.package-sha256"; if ((configured)); then config_hash; fi; fi
    sha256sum <"$out/executor.service"
    if [[ -f "$out/executor-env-key" ]]; then cat "$out/executor-env-key";
    elif [[ -f "$CONF_DIR/environment" ]]; then sha256sum <"$CONF_DIR/environment"; fi
  } | sha256sum | cut -d' ' -f1 >"$out/executor-key" || return 1
  for unit in "${HELPER_UNITS[@]}"; do
    if [[ -f "$target/deploy/$unit" ]]; then render_to "$target/deploy/$unit" "$out/$unit" || return 1
    elif [[ -f "$pins/$unit" ]]; then cp "$pins/$unit" "$out/$unit" || return 1; fi
  done
}
prepare_record "$release_dir" "$STATE" "$candidate" || fail '无法准备所选版本的服务单元与生效配置，未切换版本。'
helper_changed=0
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
journal_tail() { steady journalctl -u "$SERVICE" -u "$CONTROL" -u "$MARKET" -u "$DEX" -n 40 --no-pager -o cat 2>/dev/null || true; }
healthy_executor() {
  local expected_dir=$1 deadline=$((SECONDS + HEALTH_WAIT_S)) pid
  while ((SECONDS < deadline)); do
    if [[ "$DATA_DIR/access-url" -nt "$work_dir/before-start" ]] && systemctl is-active --quiet "$SERVICE"; then
      pid=$(systemctl show -p MainPID --value "$SERVICE")
      steady sleep 5
      if [[ "$pid" != 0 && "$(systemctl show -p MainPID --value "$SERVICE")" == "$pid" ]] && systemctl is-active --quiet "$SERVICE" &&
          { [[ -z "$expected_dir" ]] || running_from "$SERVICE" "$expected_dir"; }; then return 0; fi
    fi
    steady sleep 0.5
  done
  return 1
}
probe_control() {
  as_user "$CONTROL_USER" timeout --kill-after=1 4 "$NODE_BIN" "$1/src/control/probe.ts" --current "$APP_DIR/current" --listen-file "$APP_DIR/control-listen.json" \
    >"$work_dir/probe.log" 2>&1
}
probe_execution_config() {
  local attempt status
  for attempt in 1 2; do
    status=0
    as_service timeout --kill-after=1 4 "$NODE_BIN" "$1/src/control/probe.ts" --current "$1" --socket /run/trading-platform/execution.sock --config-check "$2" \
      >"$work_dir/config-probe.log" 2>&1 || status=$?
    case $status in 0|3) return "$status" ;; esac
    if ((attempt == 1)); then steady sleep 1; fi
  done
  return "$status"
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
probe_market() {
  # Match the execution unit's UID and its dedicated group for this socket; ordinary login sessions lack that group.
  (cd / && runuser -u "$SERVICE_USER" -g "$MARKET_IPC_GROUP" -- timeout --kill-after=1 4 "$NODE_BIN" \
    "$1/src/market/probe.ts" --socket "$MARKET_SOCKET" --root "$2") >"$work_dir/market-probe.log" 2>&1
}
healthy_market() {
  local target=$1 market=$2 deadline=$((SECONDS + HEALTH_WAIT_S))
  while ((SECONDS < deadline)); do
    if systemctl is-active --quiet "$MARKET" && running_from "$MARKET" "$market" && probe_market "$target" "$market"; then return 0; fi
    steady sleep 0.5
  done
  return 1
}
probe_dex() {
  (cd / && runuser -u "$SERVICE_USER" -g "$DEX_IPC_GROUP" -- timeout --kill-after=1 4 "$NODE_BIN" \
    "$1/src/dex/probe.ts" --socket "$DEX_SOCKET" --root "$2") >"$work_dir/dex-probe.log" 2>&1
}
healthy_dex() {
  local target=$1 dex=$2 deadline=$((SECONDS + HEALTH_WAIT_S))
  while ((SECONDS < deadline)); do
    if systemctl is-active --quiet "$DEX" && running_from "$DEX" "$dex" && probe_dex "$target" "$dex"; then return 0; fi
    steady sleep 0.5
  done
  [[ ! -s "$work_dir/dex-probe.log" ]] || log "$(tail -c 600 "$work_dir/dex-probe.log")"
  return 1
}
# Which directory holds the live varlighter.sqlite: dex or executor (no file: executor). Root-owned, written right after
# each successful copy, so an interrupted run still knows which side to copy from (docs/dexspread.md 11.5).
DEX_DB_MARK="$APP_DIR/.dex-db"
# The marker decides which side owns the database after a crash, so both the file and the rename reach the disk.
set_dex_db() { printf '%s\n' "$1" >"$DEX_DB_MARK.next" && chmod 644 "$DEX_DB_MARK.next" && sync "$DEX_DB_MARK.next" && mv -Tf "$DEX_DB_MARK.next" "$DEX_DB_MARK" && sync "$APP_DIR"; }
# Copy the database between the two private directories with the DEX unit stopped. Root never opens a file in either
# directory: each side runs as the directory's owner with a clean environment, root only pipes them together (L201).
copy_dex_db() { # tool release, from user, from dir, to user, to dir
  local tool="$1/src/dex/move-db.ts"
  [[ -f "$tool" ]] || { log "找不到 $tool，无法复制 DEX 价差库。"; return 1; }
  steady systemctl stop "$DEX" 2>/dev/null || true
  if systemctl is-active --quiet "$DEX"; then log 'DEX 价差服务未能停止，未复制库。'; return 1; fi
  if (cd / && steady runuser -u "$2" -- timeout --kill-after=5 600 env -i "$NODE_BIN" "$tool" export --dir "$3" 2>"$work_dir/move-db-export.log" |
      steady runuser -u "$4" -- timeout --kill-after=5 600 env -i "$NODE_BIN" "$tool" import --dir "$5" 2>"$work_dir/move-db.log"); then
    log "DEX 价差库：$(tail -n 1 "$work_dir/move-db.log")"
    return 0
  fi
  log "复制 DEX 价差库失败：$(tail -c 400 "$work_dir/move-db-export.log" 2>/dev/null) $(tail -c 400 "$work_dir/move-db.log" 2>/dev/null)"
  return 1
}
enable_service() {
  systemctl is-enabled --quiet "$1" || { steady systemctl enable --quiet "$1" && changes+=("$1 开机自启"); }
}
# ---- 6. 激活（回退走同一条路径） ------------------------------------------------------
# Compare component keys separately. An independent market or control update must keep a healthy executor running. Unit/filesystem drift
# and a process running an unexpected release are also repaired, e.g. after a power cut between switching and starting.
activate() {
  local to=$1 from=$2 target exe ctl market dex live changes_unit=0 moving=0 change_ex=0 change_ctl=0 change_market=0 change_dex=0
  local action_ex='' action_ctl='' action_market='' action_dex='' unit name probe_status dex_from
  target=$(read_value "$to/current")
  exe=$(read_value "$to/executor")
  ctl=$(read_value "$to/control")
  market=$(read_value "$to/market")
  dex=$(read_value "$to/dex")
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
  if [[ -n "$market" ]]; then
    cmp -s "$to/market-key" "$from/market-key" || change_market=1
    [[ ! -e "$APP_DIR/.restarting-market" ]] || change_market=1
    if ! cmp -s "$to/market.service" "$UNIT_DIR/$MARKET.service"; then changes_unit=1; change_market=1; fi
    cmp -s "$to/market.env" "$APP_DIR/market.env" || change_market=1
  elif [[ -f "$UNIT_DIR/$MARKET.service" || -L "$APP_DIR/market" ]]; then
    if [[ "$TEST_MODE" != 1 && -f "$UNIT_DIR/$MARKET.service" ]]; then steady systemctl disable --now --quiet "$MARKET" || return 1; fi
    rm -f "$UNIT_DIR/$MARKET.service" "$APP_DIR/market" "$APP_DIR/market.env" "$APP_DIR/.restarting-market" || return 1
    changes_unit=1
  fi
  if [[ -n "$dex" ]]; then
    cmp -s "$to/dex-key" "$from/dex-key" || change_dex=1
    [[ ! -e "$APP_DIR/.restarting-dex" ]] || change_dex=1
    if ! cmp -s "$to/dex.service" "$UNIT_DIR/$DEX.service"; then changes_unit=1; change_dex=1; fi
    cmp -s "$to/dex.env" "$APP_DIR/dex.env" || change_dex=1
  elif [[ -f "$UNIT_DIR/$DEX.service" || -L "$APP_DIR/dex" || "$(read_value "$DEX_DB_MARK")" == dex ]]; then
    # Module off or a release without the component: hand the database back before an older executor can open it.
    if [[ "$TEST_MODE" != 1 ]]; then
      if [[ -f "$UNIT_DIR/$DEX.service" ]]; then steady systemctl disable --now --quiet "$DEX" || return 1; fi
      if [[ "$(read_value "$DEX_DB_MARK")" == dex ]]; then
        # move-db.ts is not part of the DEX fingerprint, so a pinned DEX release may carry an older copy: prefer the target's.
        if [[ -f "$target/src/dex/move-db.ts" ]]; then dex_from=$target; else dex_from=$(readlink -f "$APP_DIR/dex" 2>/dev/null || true); fi
        [[ -n "$dex_from" && -f "$dex_from/src/dex/move-db.ts" ]] || { log '找不到 DEX 价差组件目录，无法把库交回执行服务。'; return 1; }
        copy_dex_db "$dex_from" "$DEX_USER" "$DEX_STATE" "$SERVICE_USER" "$DATA_DIR" && set_dex_db executor || return 1
        changes+=('DEX 价差库已交回执行服务')
      fi
    fi
    rm -f "$UNIT_DIR/$DEX.service" "$APP_DIR/dex" "$APP_DIR/dex.env" "$APP_DIR/.restarting-dex" || return 1
    changes_unit=1
  fi
  # Persist a requested restart before changing its files. This covers interruption during rollback even when
  # the previous code directory is identical (for example an environment-only change with the same TCP port).
  if [[ "$TEST_MODE" != 1 ]] && ((configured)); then
    if ((change_ex)); then : >"$APP_DIR/.restarting-executor" || return 1; fi
    if [[ -n "$ctl" ]] && ((change_ctl)); then : >"$APP_DIR/.restarting-control" || return 1; fi
    if [[ -n "$market" ]] && ((change_market)); then : >"$APP_DIR/.restarting-market" || return 1; fi
    if [[ -n "$dex" ]] && ((change_dex)); then : >"$APP_DIR/.restarting-dex" || return 1; fi
  fi
  put_file "$to/executor.service" "$UNIT_FILE" 644 || return 1
  helper_changed=0
  for unit in "${HELPER_UNITS[@]}"; do
    [[ -f "$to/$unit" ]] || continue
    if ! cmp -s "$to/$unit" "$UNIT_DIR/$unit"; then
      put_file "$to/$unit" "$UNIT_DIR/$unit" 644 || return 1
      helper_changed=1
    fi
  done
  if ((helper_changed)); then changes+=('页面助手单元'); fi
  if [[ -n "$ctl" ]]; then
    put_file "$to/control.service" "$UNIT_DIR/$CONTROL.service" 644 && put_file "$to/control-listen.json" "$APP_DIR/control-listen.json" 644 &&
      put_file "$to/control-proxy.env" "$APP_DIR/control-proxy.env" 600 && switch_link "$exe" "$APP_DIR/executor" && switch_link "$ctl" "$APP_DIR/control" || return 1
  fi
  if [[ -n "$market" ]]; then
    put_file "$to/market.service" "$UNIT_DIR/$MARKET.service" 644 && put_file "$to/market.env" "$APP_DIR/market.env" 600 &&
      switch_link "$market" "$APP_DIR/market" || return 1
  fi
  if [[ -n "$dex" ]]; then
    put_file "$to/dex.service" "$UNIT_DIR/$DEX.service" 644 && put_file "$to/dex.env" "$APP_DIR/dex.env" 600 &&
      switch_link "$dex" "$APP_DIR/dex" || return 1
  fi
  switch_link "$target" "$APP_DIR/current" || return 1
  if ((moving)); then changes+=("程序 $(head -n1 "$target/VERSION")"); fi
  if ((changes_unit)); then changes+=('systemd 单元'); else skipped+=('systemd 单元（未变化）'); fi
  if [[ "$TEST_MODE" == 1 ]]; then skipped+=('systemctl（测试模式）'); return 0; fi
  if ((!changes_unit && !helper_changed)); then
    for unit in "$SERVICE" "$CONTROL" "$MARKET" "$DEX" "${HELPER_UNITS[@]}"; do
      [[ $(systemctl show -p NeedDaemonReload --value "$unit" 2>/dev/null) != yes ]] || { changes_unit=1; break; }
    done
  fi
  if ((changes_unit || helper_changed)); then steady systemctl daemon-reload || return 1; fi
  if ((!configured)); then skipped+=('启动服务（尚无 config.json）'); return 0; fi
  enable_service "$SERVICE" || return 1
  if ! systemctl is-active --quiet "$SERVICE"; then action_ex=start
  elif ((change_ex)) || { [[ -n "$exe" ]] && ! running_from "$SERVICE" "$exe"; }; then action_ex=restart; fi
  # Page imports restart the executor independently of the installer. Compare the configuration in that process,
  # including when the files have since been changed back to the last installed values.
  if [[ -n "$exe" && -z "$action_ex" ]]; then
    probe_status=0
    probe_execution_config "$target" "$(read_value "$to/config-key")" || probe_status=$?
    case $probe_status in
      0) ;;
      3) action_ex=restart ;;
      *) log '暂时无法确认执行服务的实际配置，保留运行中的执行服务。'; return 1 ;;
    esac
  fi
  if [[ -n "$ctl" ]]; then
    enable_service "$CONTROL" || return 1
    if ! systemctl is-active --quiet "$CONTROL"; then action_ctl=start
    elif ((change_ctl)) || ! running_from "$CONTROL" "$ctl"; then action_ctl=restart
    elif ((moving)) || [[ "$(read_value "$from/current")" != "$target" ]]; then action_ctl=reload; fi
  fi
  # Confirm the market generation before touching a live writer or reloading the page. No service dependency
  # binds their lifetimes; an independent market restart can be rolled back while existing orders reconcile.
  if [[ -n "$market" ]]; then
    enable_service "$MARKET" || return 1
    if ! systemctl is-active --quiet "$MARKET"; then action_market=start
    elif ((change_market)) || ! running_from "$MARKET" "$market" || ! probe_market "$target" "$market"; then action_market=restart; fi
    if [[ -n "$action_market" ]]; then
      steady systemctl reset-failed "$MARKET" 2>/dev/null || true
      steady systemctl "$action_market" "$MARKET" && healthy_market "$target" "$market" || return 1
      rm -f "$APP_DIR/.restarting-market" || return 1
      changes+=("行情服务已$([[ $action_market == start ]] && echo 启动 || echo 重启)")
    else skipped+=('行情服务（运行正常）'); fi
  fi
  if [[ -n "$action_ex" ]]; then
    touch "$work_dir/before-start" || return 1
    steady systemctl reset-failed "$SERVICE" 2>/dev/null || true
    # restart also starts an inactive unit. A plain start could race an automatic start after the state check:
    # its access-url might already have been written before our marker, leaving a healthy generation unprovable.
    steady systemctl restart "$SERVICE" && healthy_executor "$exe" || return 1
    if [[ -n "$exe" ]] && ! probe_execution_config "$target" "$(read_value "$to/config-key")"; then
      log '新执行服务未能确认目标配置，正在恢复。'; return 1
    fi
    rm -f "$APP_DIR/.restarting-executor" || return 1
    changes+=("执行服务已$([[ $action_ex == start ]] && echo 启动 || echo 重启)")
  else skipped+=('执行服务（继续运行）'); fi
  # After the executor: a running pre-split executor writes varlighter.sqlite itself, the new one only forwards. Taking the
  # database over stops DEX first; a DEX failure rolls the whole deployment back like a market failure.
  if [[ -n "$dex" ]]; then
    enable_service "$DEX" || return 1
    if [[ "$(read_value "$DEX_DB_MARK")" != dex ]]; then
      as_root_dir "$DEX_STATE" 700 "$DEX_USER" "$DEX_USER" || return 1
      copy_dex_db "$target" "$SERVICE_USER" "$DATA_DIR" "$DEX_USER" "$DEX_STATE" && set_dex_db dex || return 1
      changes+=('DEX 价差库已移到独立服务')
      action_dex=start
    elif ! systemctl is-active --quiet "$DEX"; then action_dex=start
    elif ((change_dex)) || ! running_from "$DEX" "$dex" || ! probe_dex "$target" "$dex"; then action_dex=restart; fi
    if [[ -n "$action_dex" ]]; then
      steady systemctl reset-failed "$DEX" 2>/dev/null || true
      steady systemctl restart "$DEX" && healthy_dex "$target" "$dex" || return 1
      rm -f "$APP_DIR/.restarting-dex" || return 1
      changes+=("DEX 价差服务已$([[ $action_dex == start ]] && echo 启动 || echo 重启)")
    else skipped+=('DEX 价差服务（运行正常）'); fi
  fi
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
  # Once more after the restart: the old process could have written the tokens back between its check that the file
  # is there and its rename (docs/mcp.md 8.4); the new process notices the file gone at its next request.
  if ((set_password)); then rm -f "$DATA_DIR/read-token.json"; fi
  # Compatibility with a subsequent older installer.
  if ((configured)); then printf '%s\n' "$applied" >"$work_dir/applied"; put_file "$work_dir/applied" "$APP_DIR/.applied-config" 600; fi
else
  log '服务没有正常启动，最近日志：'; journal_tail
  restore_import
  if [[ -n "$previous_dir" && -d "$previous_dir" && -f "$CONF_DIR/config.json" ]]; then
    read -r previous_version _ <"$previous_dir/VERSION"
    if ! previous_check=$(as_service "$NODE_BIN" "$previous_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config 2>&1); then
      fail "新版本 $new_version 启动失败；上一版本 $previous_version 不接受当前配置（$previous_check），未回退。请恢复兼容配置后重新执行本脚本"
    fi
    fallback="$work_dir/fallback"
    mkdir -m 700 "$fallback" || fail '无法准备回退记录。'
    ensure_market_account "$previous_dir" || fail "新版本 $new_version 启动失败，上一版本 $previous_version 的行情账户未通过核验，无法重新启用。"
    ensure_dex_account "$previous_dir" || fail "新版本 $new_version 启动失败，上一版本 $previous_version 的 DEX 价差账户未通过核验，无法重新启用。"
    if prepare_record "$previous_dir" "$STATE" "$fallback" && activate "$fallback" "$candidate"; then
      save_record "$fallback" || fail '已切回上一版，但无法保存部署状态。'
      if ((set_password)); then rm -f "$DATA_DIR/read-token.json"; fi
      if [[ "$TEST_MODE" != 1 ]]; then ensure_import_path "$previous_dir"; fi
      fail "新版本 $new_version 启动失败，已回退到 $previous_version 并确认运行正常；请按上面的日志处理"
    fi
    journal_tail
    fail "新版本 $new_version 启动失败，已尝试切回 $previous_version，但服务仍未正常运行；请按日志处理后重新执行本脚本"
  fi
  if [[ "$TEST_MODE" != 1 ]]; then
    [[ ! -f "$UNIT_DIR/$CONTROL.service" ]] || steady systemctl disable --now --quiet "$CONTROL" || true
    [[ ! -f "$UNIT_DIR/$MARKET.service" ]] || steady systemctl disable --now --quiet "$MARKET" || true
    [[ ! -f "$UNIT_DIR/$DEX.service" ]] || steady systemctl disable --now --quiet "$DEX" || true
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
market_dir=$(read_value "$STATE/market")
dex_dir=$(read_value "$STATE/dex")
# The release whose move-db copied the database stays until the database is handed back.
dex_link=$(readlink -f "$APP_DIR/dex" 2>/dev/null || true)
kept=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  if [[ "$dir" == "$current_dir" || "$dir" == "$executor_dir" || "$dir" == "$control_dir" || "$dir" == "$market_dir" || "$dir" == "$previous_dir" ||
        "$dir" == "$previous_executor" || "$dir" == "$previous_control" || "$dir" == "$previous_market" ||
        "$dir" == "$dex_dir" || "$dir" == "$previous_dex" || "$dir" == "$dex_link" ]] || ((kept < KEEP_RELEASES)); then kept=$((kept + 1)); continue; fi
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
