#!/usr/bin/env bash
# 副服务器一键部署主服务器巡检（main-watch）：常驻接收统一交易平台推送的签名心跳，每分钟巡检一次，
# 连续失败发飞书告警，恢复后通知。说明见 docs/watch.md。
#
#   curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install-watch.sh && sudo bash install-watch.sh [选项]
#
# 可重复执行升级；未传参数时保留已有配置，内容未变且服务正常时直接结束。
# 来源：project-aggregation 的 deploy/install-main-watch.sh（提交 7745181）；程序目录、配置与服务名沿用 main-watch，
# 已用工作台版本部署过的副服务器直接执行本脚本即升级，配置（含心跳令牌）保留。
# shellcheck disable=SC2015  # A && B || C 只用在 C 不会失败、B 的失败也该走 C 的地方
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
unset PYTHONPATH PYTHONHOME LD_PRELOAD LD_LIBRARY_PATH
say() { printf '[main-watch] %s\n' "$*"; }
die() { printf '[main-watch] %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
用法（副服务器）: sudo bash install-watch.sh [选项]
  --heartbeat-listen HOST:PORT
                       接收主服务器心跳的监听地址，如 0.0.0.0:8792；传空串关闭心跳模式
  --heartbeat-token T  心跳共享令牌（32~256 位字母数字-_）；开启心跳且未设置时自动生成
  --main HOST:PORT     副服务器能直连主服务器平台页面时，另外检查 http://HOST:PORT/api/ready；传空串清除
  --checks "目标 ..."  额外检查目标：http(s)://... 或 tcp://主机:端口，空格分隔；传空串清除
                       --main 与 --checks 分开保存，只改其中一项不影响另一项
  --webhook URL        飞书群机器人 Webhook
  --secret SECRET      机器人开启“签名校验”时的密钥
  --name NAME          告警里显示的服务器名称，默认“主服务器”
  --threshold N        连续失败几次才告警（每分钟一次），默认 3
  --remind MINUTES     故障持续时每隔多少分钟再提醒，默认 30
  --test               部署后发送测试消息（配置变化时总会发送）
  --version vX.Y.Z     安装指定版本的巡检程序（也用于回退）；默认最新正式版
  --uninstall          停止并移除巡检服务，保留 /etc/main-watch 配置
首次安装需要 --heartbeat-listen、--main 或 --checks 之一，以及 --webhook；之后不带参数重复执行即为升级。
开启心跳后，按部署结束时打印的命令在主服务器（统一交易平台）上开启推送：
  sudo bash install.sh --watch-url http://<本机IP>:<端口>/heartbeat --watch-token <令牌>
USAGE
}
[[ $(uname -s) == Linux && $EUID -eq 0 ]] || die '请在 Linux 上以 root 或 sudo 运行。'
[[ -d /run/systemd/system ]] || die '需要正在运行的 systemd。'

root=/opt/main-watch
etc=/etc/main-watch
service=main-watch
systemd_dir=/etc/systemd/system
repository=hxx344/trading-platform
# 只有仓库自带的 systemd 验收会改它（指向本机回环上的发布文件）。
release_base=${MAIN_WATCH_RELEASE_BASE:-https://github.com/$repository/releases}
config=$etc/config
command_path=/usr/local/bin/main-watch
units=(main-watch.service main-watch.timer main-watch-heartbeat.service)

args=("$@") source_dir='' source_revision='' version='' send_test=0 uninstall=0
settings=()
while (($#)); do
  case $1 in
    --main|--checks|--webhook|--secret|--name|--threshold|--remind|--heartbeat-listen|--heartbeat-token|--version|--source|--revision)
      [[ $# -ge 2 ]] || die "$1 需要一个值"
      case $1 in
        --main)
          [[ -z $2 || $2 =~ ^[A-Za-z0-9.-]+:[0-9]{1,5}$ || $2 =~ ^\[[0-9A-Fa-f:]+\]:[0-9]{1,5}$ ]] || die '--main 格式应为 主机:端口，例如 100.64.0.5:4720；传空串清除'
          settings+=("MAIN=$2") ;;
        --checks) settings+=("CHECKS=$2") ;;
        --webhook) settings+=("FEISHU_WEBHOOK=$2") ;;
        --secret) settings+=("FEISHU_SECRET=$2") ;;
        --name) settings+=("NAME=$2") ;;
        --threshold) settings+=("FAIL_THRESHOLD=$2") ;;
        --remind) settings+=("REMIND_MINUTES=$2") ;;
        --heartbeat-listen) settings+=("HEARTBEAT_LISTEN=$2") ;;
        --heartbeat-token) settings+=("HEARTBEAT_TOKEN=$2") ;;
        --version) version=$2 ;;
        --source) source_dir=$2 ;;
        --revision) source_revision=$2 ;;
      esac
      shift 2 ;;
    --test) send_test=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "未知参数：$1" ;;
  esac
done
[[ -z $version || $version =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '--version 须形如 v0.47.0'
[[ -z $source_revision || $source_revision =~ ^[A-Za-z0-9._:-]{1,64}$ ]] || die '--revision 格式无效。'

# 不解析符号链接：系统升级换掉 python3.X 后，单元仍指向有效的 python3。依赖检查与服务使用同一个解释器。
pick_python() { if [[ -x /usr/bin/python3 ]]; then python_bin=/usr/bin/python3; else python_bin=$(command -v python3 || true); fi; }
system_ready() {
  local tool
  for tool in curl flock systemctl useradd runuser install cmp sha256sum awk; do command -v "$tool" >/dev/null || return 1; done
  pick_python
  [[ -n $python_bin ]] && "$python_bin" -I -c 'import sys, ssl; ssl.create_default_context(); sys.exit(sys.version_info < (3, 8))' 2>/dev/null
}
if ! system_ready; then
  command -v apt-get >/dev/null || die '缺少 python3(>=3.8)/curl，且系统不是 apt 系，请先手工安装。'
  say '安装缺少的依赖：python3 curl ca-certificates'
  # 经 curl | bash 运行时脚本在标准输入里，不能让 apt 读走。
  apt-get update -qq </dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 curl ca-certificates util-linux passwd diffutils coreutils gawk </dev/null >/dev/null
fi
system_ready || die '需要 python3 3.8+、curl 与 systemd。'

trusted() {
  python3 -I - "$@" <<'PY'
import os, stat, sys
from pathlib import Path
def trust_paths(paths):
    for raw in paths:
        if '..' in Path(raw).parts:
            raise ValueError('Parent traversal in trusted path')
        path = Path(os.path.abspath(raw))
        for item in reversed((path, *path.parents)):
            try:
                info = item.lstat()
            except FileNotFoundError:
                continue
            if (info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode)
                    or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
                raise ValueError('Untrusted path: ' + str(item))
trust_paths(sys.argv[1:])
PY
}
download() {
  # 最多三次尝试；连接、单次与总重试时长都有上限。只走 https，验收用的本机回环地址除外。
  local proto='=https'
  if [[ $1 =~ ^http://127\.0\.0\.1:[0-9]+/ ]]; then proto='=http'; fi
  curl --proto "$proto" --proto-redir "$proto" --tlsv1.2 --retry 2 --retry-max-time 120 \
    --connect-timeout 15 --max-time 60 --max-filesize 1048576 -fsSL "$1" -o "$2"
}
# 发布清单 SHA256SUMS 里两份巡检文件的校验和；目录里的文件与之一致才算完整。
source_matches() { (cd "$1" && printf '%s  main_watch.py\n%s  install-watch.sh\n' "$2" "$3" | sha256sum --check --status); }

trusted "$root" "$etc" "${units[@]/#/$systemd_dir/}" "$command_path"
install -d -m 755 "$root" "$root/sources"
exec 9>"$root/upgrade.lock"
flock -n 9 || die '另一个 main-watch 安装正在运行。'

if ((uninstall)); then
  systemctl disable --now "${units[@]:1}" >/dev/null 2>&1 || true
  systemctl stop "${units[0]}" >/dev/null 2>&1 || true
  rm -f -- "${units[@]/#/$systemd_dir/}" "$command_path"
  # 工作台版本的心跳推送端若还装在本机，共用的程序目录留给它。
  if [[ -e $systemd_dir/main-watch-sender.timer || -e $systemd_dir/main-watch-sender.service ]]; then
    say '本机还有工作台版本的心跳推送端（main-watch-sender），程序目录保留。'
  else
    rm -rf -- "$root"
  fi
  systemctl daemon-reload
  systemctl reset-failed "${units[@]}" >/dev/null 2>&1 || true
  say "已移除巡检服务。配置保留在 $etc，状态在 /var/lib/$service；不再需要时可手工删除，并执行 userdel $service。"
  exit 0
fi

scratch=$(mktemp -d "$root/.install-XXXXXX")
backup="$scratch/backup" switched=0
# 记录定时器与心跳接收服务原来的启用与运行状态，失败时按原样恢复。
declare -A was_enabled=() was_active=()
for name in "${units[@]:1}"; do
  systemctl is-enabled --quiet "$name" 2>/dev/null && was_enabled[$name]=1
  systemctl is-active --quiet "$name" 2>/dev/null && was_active[$name]=1
done
targets=("$root/main_watch.py" "${units[@]/#/$systemd_dir/}" "$command_path" "$config")
config_index=$((${#targets[@]} - 1)) command_index=$((${#targets[@]} - 2))
restore() {
  local index target name
  # 先在单元文件还在时停用，避免删掉文件后留下悬空的启用链接。
  systemctl disable --now "${units[@]:1}" >/dev/null 2>&1 || true
  for index in "${!targets[@]}"; do
    target=${targets[$index]}
    if [[ -f $backup/$index ]]; then cp -p -- "$backup/$index" "$target"; else rm -f -- "$target"; fi
  done
  systemctl daemon-reload || true
  for name in "${units[@]:1}"; do
    if [[ -n ${was_enabled[$name]:-} ]]; then systemctl enable "$name" >/dev/null 2>&1 || true; else systemctl disable "$name" >/dev/null 2>&1 || true; fi
    if [[ -n ${was_active[$name]:-} ]]; then systemctl restart "$name" || true; else systemctl stop "$name" >/dev/null 2>&1 || true; fi
  done
}
cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if ((result != 0 && switched)); then
    printf '[main-watch] 部署失败，已恢复原有文件与定时器状态。\n' >&2
    restore
  fi
  [[ $scratch == "$root"/.install-* ]] && rm -rf -- "$scratch"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z $source_dir ]]; then
  # 引导阶段：先只取发布的校验清单，巡检程序与安装器按清单核对后缓存，再用同一版本的安装器完成部署。
  if [[ -n $version ]]; then base="$release_base/download/$version" label=$version; else base="$release_base/latest/download" label=latest; fi
  download "$base/SHA256SUMS" "$scratch/SHA256SUMS" || die "下载校验清单失败：$base/SHA256SUMS"
  want_program=$(awk '$2 == "main_watch.py" { print $1 }' "$scratch/SHA256SUMS")
  want_installer=$(awk '$2 == "install-watch.sh" { print $1 }' "$scratch/SHA256SUMS")
  [[ $want_program =~ ^[a-f0-9]{64}$ && $want_installer =~ ^[a-f0-9]{64}$ ]] || die "该版本的发布里没有副服务器巡检文件（v0.47.0 起提供）。"
  source_revision="$label:${want_program:0:12}"
  source_dir="$root/sources/${want_program:0:16}${want_installer:0:16}"
  if [[ -f $source_dir/.source-complete ]]; then
    trusted "$source_dir/.source-complete" "$source_dir/main_watch.py" "$source_dir/install-watch.sh" || die "源码缓存归属异常，请检查或删除：$source_dir"
    source_matches "$source_dir" "$want_program" "$want_installer" || die "源码缓存校验失败，请删除后重试：$source_dir"
    say "巡检文件 ${want_program:0:12} 已缓存，跳过下载。"
  else
    [[ ! -e $source_dir ]] || rm -rf -- "$source_dir"
    say "下载巡检文件（$label）。"
    mkdir "$scratch/source"
    for name in main_watch.py install-watch.sh; do
      download "$base/$name" "$scratch/source/$name" || die "下载失败：$base/$name"
    done
    source_matches "$scratch/source" "$want_program" "$want_installer" || die '巡检文件的 SHA-256 与校验清单不一致。'
    : > "$scratch/source/.source-complete"
    chmod -R go-w,a+rX "$scratch/source"
    mv -T "$scratch/source" "$source_dir"
  fi
  # 只保留当前版本的源码缓存。
  find "$root/sources" -mindepth 1 -maxdepth 1 -type d ! -name "$(basename -- "$source_dir")" -exec rm -rf -- {} +
  rm -rf -- "$scratch"
  trap - EXIT HUP INT TERM
  exec 9>&-
  exec bash "$source_dir/install-watch.sh" "${args[@]}" --source "$source_dir" --revision "$source_revision"
fi

# --source 可以是发布文件所在目录，也可以是仓库检出。
program="$source_dir/main_watch.py"
[[ -f $program ]] || program="$source_dir/deploy/main-watch/main_watch.py"
trusted "$source_dir" "$program" || die "--source 及其上级目录须归 root 所有且不可被他人写入：$source_dir"
[[ -f $program ]] || die "--source 里没有 main_watch.py：$source_dir"
revision_label=${source_revision:-local:$(sha256sum "$program" | cut -c1-12)}

# 合并配置：命令行给出的项覆盖已有配置，其余保留；未传参数时不改动配置文件。
if [[ ! -f $config && ${#settings[@]} -eq 0 ]]; then
  usage >&2
  die '首次安装需要 --heartbeat-listen、--main 或 --checks 之一，以及 --webhook。'
fi
if ((${#settings[@]})); then
  python3 -I -B - "$(dirname -- "$program")" "$config" "$scratch/config" "${settings[@]}" <<'PY'
import os, secrets, sys
sys.path.insert(0, sys.argv[1])
import main_watch
existing = {}
try:
    if os.path.exists(sys.argv[2]):
        with open(sys.argv[2], encoding='utf-8') as handle:
            existing = main_watch.parse_config(handle.read())
    for item in sys.argv[4:]:
        key, _, value = item.partition('=')
        if any(ch in value for ch in '\r\n'):
            raise main_watch.ConfigError(f'{key} 不能包含换行')
        existing[key] = value.strip()
    # 开启心跳且没有令牌时自动生成，部署结束时打印给主服务器使用。
    if existing.get('HEARTBEAT_LISTEN') and not existing.get('HEARTBEAT_TOKEN'):
        existing['HEARTBEAT_TOKEN'] = secrets.token_urlsafe(32)
    main_watch.validate(existing)
except main_watch.ConfigError as error:
    sys.exit(f'[main-watch] 配置无效，未做任何改动：{error}')
lines = ['# 由 install-watch.sh 维护；手工修改后执行 sudo main-watch check 校验，再执行一次 install-watch.sh 生效']
lines += [f'{key}={existing[key]}' for key in main_watch.KEYS if key in existing]
with open(sys.argv[3], 'w', encoding='utf-8') as handle:
    handle.write('\n'.join(lines) + '\n')
PY
else
  cp -p -- "$config" "$scratch/config"
fi
"$python_bin" -I "$program" --config "$scratch/config" --check >/dev/null || die '配置无效，未做任何改动。'
# 开启心跳时取出：监听地址、本机可连地址与端口、令牌。
heartbeat=()
heartbeat_line=$("$python_bin" -I -B - "$(dirname -- "$program")" "$scratch/config" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import main_watch
with open(sys.argv[2], encoding='utf-8') as handle:
    config = main_watch.validate(main_watch.parse_config(handle.read()))
print(' '.join([config['listen'], *map(str, main_watch.local_address(config['listen'])), config['token']]) if config['heartbeat'] else 'off')
PY
) || die '读取心跳配置失败，未做任何改动。'
[[ $heartbeat_line == off ]] || read -r -a heartbeat <<< "$heartbeat_line"

hardening='UMask=0077
NoNewPrivileges=true
CapabilityBoundingSet=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true'
documentation="https://github.com/$repository/blob/main/docs/watch.md"
cat > "$scratch/service" <<UNIT
[Unit]
Description=Main server watch with Feishu alerts
Documentation=$documentation
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$service
Group=$service
StateDirectory=$service
WorkingDirectory=/var/lib/$service
ExecStart=$python_bin -I $root/main_watch.py --config $config
TimeoutStartSec=15min
$hardening
UNIT
cat > "$scratch/timer" <<'UNIT'
[Unit]
Description=Run main-watch every minute

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
UNIT
cat > "$scratch/receiver" <<UNIT
[Unit]
Description=Receive main server heartbeats for main-watch
Documentation=$documentation
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$service
Group=$service
StateDirectory=$service
WorkingDirectory=/var/lib/$service
ExecStart=$python_bin -I $root/main_watch.py --config $config --serve
Restart=always
RestartSec=5
# 配置错误（退出码 2）不反复重启，重跑安装器修复。
RestartPreventExitStatus=2
$hardening

[Install]
WantedBy=multi-user.target
UNIT
cat > "$scratch/command" <<CMD
#!/bin/sh
# main-watch 管理命令，由 install-watch.sh 生成。
case "\$1" in
  check) exec $python_bin -I $root/main_watch.py --config $config --check ;;
  # 探测会读服务账号写的心跳记录，与测试消息一样以服务账号运行。
  probe|test) exec runuser -u $service -- $python_bin -I $root/main_watch.py --config $config --"\$1" ;;
  status) systemctl list-timers main-watch.timer --no-pager; exec systemctl status main-watch.service main-watch-heartbeat.service --no-pager ;;
  logs) exec journalctl -u main-watch.service -u main-watch-heartbeat.service -n "\${2:-50}" --no-pager ;;
  *) echo "用法: sudo main-watch check|probe|test|status|logs [行数]" >&2; exit 2 ;;
esac
CMD
desired=("$program" "$scratch/service" "$scratch/timer" "$scratch/receiver" "$scratch/command" "$scratch/config")

changed=()
for index in "${!targets[@]}"; do
  cmp -s -- "${desired[$index]}" "${targets[$index]}" || changed+=("$index")
done
id "$service" >/dev/null 2>&1 || useradd --system --user-group --no-create-home --home-dir /var/lib/$service --shell /usr/sbin/nologin "$service"
[[ $(id -u "$service") != 0 ]] || die '服务账号不能是 root。'
# 跳过标准与部署成功标准一致：文件与权限不变、定时器在运行、最近一轮在 systemd 下成功，
# 心跳接收服务的运行状态与配置一致。
healthy=0
if [[ -f $config && $(stat -c '%U:%G %a' "$config") == "root:$service 640" && $(stat -c '%U:%G %a' "$etc") == "root:$service 750" ]] &&
    systemctl is-enabled --quiet "${units[1]}" && systemctl is-active --quiet "${units[1]}" &&
    [[ $(systemctl show --property=Result --value "${units[0]}") == success ]]; then healthy=1; fi
for name in "${units[@]}"; do
  [[ $(systemctl show --property=NeedDaemonReload --value "$name") == no ]] || healthy=0
done
# 常驻的接收服务只在启动时读配置与程序：比它们旧（例如手工改过令牌）也要重新部署。
# 按 UTC 取时间：本地时区缩写（如 CST）会被 date 误解。
started_at() { local value; value=$(TZ=UTC systemctl show --property=ActiveEnterTimestamp --value "$1"); [[ -n $value ]] && TZ=UTC date -d "$value" +%s || echo 0; }
if ((${#heartbeat[@]})); then
  if ! systemctl is-enabled --quiet main-watch-heartbeat.service || ! systemctl is-active --quiet main-watch-heartbeat.service ||
      (( $(started_at main-watch-heartbeat.service) < $(stat -c %Y "$config" "$root/main_watch.py" | sort -n | tail -n 1) )); then healthy=0; fi
elif systemctl is-active --quiet main-watch-heartbeat.service; then healthy=0; fi
if ((${#changed[@]} == 0 && healthy)); then
  say "版本 $revision_label：程序、配置与服务均未变化，跳过部署。"
  if ((send_test)); then runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --test; fi
  exit 0
fi

mkdir -p "$backup"
for index in "${!targets[@]}"; do
  [[ ! -f ${targets[$index]} ]] || cp -p -- "${targets[$index]}" "$backup/$index"
done
install -d -m 750 -o root -g "$service" "$etc"
switched=1
# 先停定时器与进行中的一轮，部署后的首轮必定按新文件运行；失败时 restore 按原状态恢复。
systemctl stop "${units[1]}" "${units[0]}" >/dev/null 2>&1 || true
for index in "${!targets[@]}"; do
  group=root mode=644
  if ((index == config_index)); then group=$service mode=640; elif ((index == command_index)); then mode=755; fi
  install -m "$mode" -o root -g "$group" "${desired[$index]}" "${targets[$index]}.next"
  mv -f -- "${targets[$index]}.next" "${targets[$index]}"
done
systemctl daemon-reload
config_changed=0
for index in "${changed[@]}"; do if ((index == config_index)); then config_changed=1; fi; done

if ((send_test || config_changed)); then
  say '发送飞书测试消息，确认告警通道可用。'
  runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --test || die '飞书测试消息发送失败，请检查 Webhook 与签名密钥。'
fi
receiver_up() {
  # 只认本服务的应答（GET 返回 404 且 Server 为 main-watch），端口被其他程序占用不算启动成功。
  "$python_bin" -I - "$1" "$2" <<'PY'
import sys, urllib.error, urllib.request
host = f'[{sys.argv[1]}]' if ':' in sys.argv[1] else sys.argv[1]
try:
    urllib.request.build_opener(urllib.request.ProxyHandler({})).open(f'http://{host}:{sys.argv[2]}/heartbeat', timeout=2)
except urllib.error.HTTPError as error:
    sys.exit(0 if error.code == 404 and (error.headers.get('Server') or '').startswith('main-watch') else 1)
except Exception:
    pass
sys.exit(1)
PY
}
if ((${#heartbeat[@]})); then
  systemctl enable main-watch-heartbeat.service >/dev/null 2>&1
  systemctl restart main-watch-heartbeat.service
  up=0
  for _ in {1..40}; do if receiver_up "${heartbeat[1]}" "${heartbeat[2]}"; then up=1; break; fi; sleep 0.25; done
  ((up)) || { journalctl -u main-watch-heartbeat.service -n 20 --no-pager >&2 || true; die "心跳接收服务未能监听 ${heartbeat[0]}，端口可能已被占用。"; }
else
  systemctl disable --now main-watch-heartbeat.service >/dev/null 2>&1 || true
fi
# 按 systemd 的真实启动路径跑一轮，确认服务账号能读配置、写状态。
systemctl reset-failed main-watch.service >/dev/null 2>&1 || true
systemctl start main-watch.service || { journalctl -u main-watch.service -n 20 --no-pager >&2 || true; die '首轮巡检在 systemd 下运行失败。'; }
systemctl enable main-watch.timer >/dev/null 2>&1
systemctl restart main-watch.timer
systemctl is-active --quiet main-watch.timer || die '定时器未能启动。'
switched=0
say "已部署版本 $revision_label，每分钟巡检一次。当前探测结果："
runuser -u "$service" -- "$python_bin" -I "$root/main_watch.py" --config "$config" --probe || say '注意：有目标当前不可达。若主服务器实际正常，请检查心跳推送是否已开启、安全组是否放通，或 --main / --checks 的地址。'
if ((${#heartbeat[@]} && config_changed)); then
  host=${heartbeat[0]%:*}
  case $host in 0.0.0.0|'[::]') host='<副服务器公网IP>' ;; esac
  say "心跳接收监听 ${heartbeat[0]}。请在安全组放通主服务器到本机 TCP ${heartbeat[2]}，然后在主服务器（统一交易平台）执行："
  printf '  sudo bash install.sh --watch-url http://%s:%s/heartbeat --watch-token %s\n' "$host" "${heartbeat[2]}" "${heartbeat[3]}"
fi
say '管理命令：sudo main-watch status | logs | probe | test'
