#!/usr/bin/env bash
# 统一交易平台：安装与升级（root 运行，可重复执行，保留配置与数据）。
#
#   curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
#   sudo bash install.sh --version v0.1.0     安装指定版本（也用于回退）
#   sudo bash install.sh --package <目录>     从本地目录安装（含 trading-platform.tar.gz 与 SHA256SUMS）
#
# 首次安装只放好程序和示例配置；按示例写好 /etc/trading-platform/config.json 与 secrets.json 后再执行一次即启动。
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

log() { printf '%s\n' "$*"; }
join() { local out='' item; for item in "$@"; do out+="${out:+、}$item"; done; printf '%s' "$out"; }
fail() { printf '安装失败：%s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

version=''
package_dir=''
while (($#)); do
  case "$1" in
    --version) [[ $# -ge 2 ]] || usage 2; version=$2; shift 2 ;;
    --package) [[ $# -ge 2 ]] || usage 2; package_dir=$2; shift 2 ;;
    -h|--help) usage 0 ;;
    *) printf '未知参数：%s\n' "$1" >&2; usage 2 ;;
  esac
done
[[ -z "$version" || "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail '--version 须形如 v0.1.0'
[[ -z "$version" || -z "$package_dir" ]] || fail '--version 与 --package 只能二选一'

[[ "$(uname -s)" == Linux ]] || fail '只支持 Linux。'
if [[ "$TEST_MODE" != 1 ]]; then
  [[ $EUID -eq 0 ]] || fail '需要 root 运行：sudo bash install.sh'
  for cmd in systemctl useradd getent runuser; do command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"; done
fi
for cmd in curl tar gzip sha256sum awk flock stat; do command -v "$cmd" >/dev/null || fail "缺少命令 $cmd"; done

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
trap 'rm -rf "$work_dir"' EXIT

# ---- 1. 校验清单与程序包 ----------------------------------------------------------
if [[ -n "$package_dir" ]]; then
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
current_sha=$(cat "$APP_DIR/current/.package-sha256" 2>/dev/null || true)
# The release `current` points at, if it is one of ours; a missing link or anything else is no version to roll back to.
previous_dir=''
if [[ -L "$APP_DIR/current" ]]; then
  target=$(readlink "$APP_DIR/current")
  [[ "$target" == "$APP_DIR/releases/"* && -d "$target" ]] && previous_dir=$target
fi

as_root_dir "$APP_DIR/releases" 755
if [[ -f "$release_dir/.package-sha256" && "$(cat "$release_dir/.package-sha256")" == "$expected" ]]; then
  [[ "$current_sha" == "$expected" ]] && skipped+=('程序包（未变化）')
else
  if [[ -n "$package_dir" ]]; then cp "$package_dir/trading-platform.tar.gz" "$work_dir/package.tar.gz"
  else log "下载程序包（$source_label）。"; fetch "$base/trading-platform.tar.gz" "$work_dir/package.tar.gz"; fi
  (cd "$work_dir" && printf '%s  %s\n' "$expected" package.tar.gz | sha256sum --check --status) || fail '程序包 SHA-256 与校验清单不一致。'
  mkdir "$work_dir/extract"
  tar -xzf "$work_dir/package.tar.gz" -C "$work_dir/extract" --no-same-owner --no-same-permissions
  [[ -f "$work_dir/extract/trading-platform/VERSION" && -f "$work_dir/extract/trading-platform/src/service/main.ts" ]] || fail '程序包结构不完整。'
  printf '%s\n' "$expected" >"$work_dir/extract/trading-platform/.package-sha256"
  chmod -R u=rwX,go=rX "$work_dir/extract/trading-platform"
  rm -rf "$release_dir.staging" "$release_dir"
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
for name in config secrets; do
  example="$release_dir/deploy/$name.example.json"
  if ! cmp -s "$example" "$CONF_DIR/$name.example.json"; then install -m 644 "$example" "$CONF_DIR/$name.example.json"; fi
done
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
  for file in "$CONF_DIR/config.json" ${secrets_file:+"$secrets_file"}; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    if [[ "$TEST_MODE" == 1 ]]; then wanted="$(id -un) 600"; else wanted="$SERVICE_USER 600"; fi
    if [[ "$(stat -c '%U %a' "$file")" != "$wanted" ]]; then
      [[ "$TEST_MODE" == 1 ]] || chown -h "$SERVICE_USER:$SERVICE_USER" "$file"
      chmod 600 "$file"
      changes+=("$file 改为仅 ${wanted%% *} 可读写（600）")
    fi
  done
fi

# ---- 4. 校验配置 ----------------------------------------------------------------------
config_hash() {
  "$NODE_BIN" -e 'const fs = require("fs"), hash = require("crypto").createHash("sha256"); const text = fs.readFileSync(process.argv[1]); hash.update(text);
    try { const s = JSON.parse(text).secretsFile; if (typeof s === "string") hash.update(fs.readFileSync(s)); } catch {} process.stdout.write(hash.digest("hex"));' "$CONF_DIR/config.json"
}
switch_to() {
  ln -sfn "$1" "$APP_DIR/.current.tmp"
  mv -Tf "$APP_DIR/.current.tmp" "$APP_DIR/current"
}
if ((configured)); then
  if ! check=$(as_service "$NODE_BIN" "$release_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config 2>&1); then
    fail "配置检查未通过，服务保持原版本：$check"
  fi
  log "$check"
fi

# ---- 5. systemd 单元、切换版本 ---------------------------------------------------------
# Written only after the config check passed, so a failed run never leaves a new unit that systemd was not reloaded for.
write_unit() { # $1：取单元模板的版本目录；有变化并已写入返回 0，未变化返回 1，模板缺失或无法生成返回 2（不动现有单元）
  [[ -f "$1/deploy/trading-platform.service" ]] || return 2
  sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@CONF_DIR@|$CONF_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    "$1/deploy/trading-platform.service" >"$work_dir/unit" || return 2
  [[ -s "$work_dir/unit" ]] || return 2
  cmp -s "$work_dir/unit" "$UNIT_FILE" && return 1
  install -m 644 "$work_dir/unit" "$UNIT_FILE"
}
unit_changed=0
unit_status=0
write_unit "$release_dir" || unit_status=$?
case $unit_status in
  0) unit_changed=1; changes+=('systemd 单元') ;;
  1) skipped+=('systemd 单元（未变化）') ;;
  *) fail '无法从程序包生成 systemd 单元，未切换版本。' ;;
esac
# An earlier run may have written the unit and stopped before reloading.
needs_reload() { ((unit_changed)) || [[ "$TEST_MODE" != 1 && "$(systemctl show -p NeedDaemonReload --value "$SERVICE" 2>/dev/null)" == yes ]]; }
program_changed=0
if [[ "$previous_dir" != "$release_dir" ]]; then switch_to "$release_dir"; program_changed=1; changes+=("程序 $new_version"); fi
applied_file="$APP_DIR/.applied-config"
config_changed=0
if ((configured)); then
  applied=$(config_hash)
  [[ "$(cat "$applied_file" 2>/dev/null || true)" == "$applied" ]] || config_changed=1
fi

# ---- 6. 启动或重启 ------------------------------------------------------------------
journal_tail() { journalctl -u "$SERVICE" -n 30 --no-pager -o cat 2>/dev/null || true; }
healthy() { # marker：重启前的时间（秒）；服务写出新的登录链接文件说明已完成装配并在本机监听
  local marker=$1 waited=0 restarts
  while ((waited < HEALTH_WAIT_S * 2)); do
    sleep 0.5; waited=$((waited + 1))
    [[ "$(systemctl show -p ActiveState --value "$SERVICE")" == active ]] || continue
    [[ -f "$DATA_DIR/access-url" && "$(stat -c %Y "$DATA_DIR/access-url")" -ge "$marker" ]] || continue
    restarts=$(systemctl show -p NRestarts --value "$SERVICE")
    sleep 5
    [[ "$(systemctl show -p ActiveState --value "$SERVICE")" == active && "$(systemctl show -p NRestarts --value "$SERVICE")" == "$restarts" ]] && return 0
    return 1
  done
  return 1
}
if [[ "$TEST_MODE" == 1 ]]; then
  skipped+=('systemctl（测试模式）')
  ((configured)) && printf '%s\n' "$applied" >"$applied_file"
elif ((!configured)); then
  if needs_reload; then systemctl daemon-reload; fi
  skipped+=('启动服务（尚无 config.json）')
else
  if needs_reload; then systemctl daemon-reload; fi
  if ! systemctl is-enabled --quiet "$SERVICE"; then systemctl enable --quiet "$SERVICE"; changes+=('开机自启'); fi
  action=''
  if ! systemctl is-active --quiet "$SERVICE"; then action=start
  elif ((program_changed || unit_changed || config_changed)); then action=restart
  else skipped+=('服务（运行中，无需重启）'); fi
  if [[ -n "$action" ]]; then
    marker=$(date +%s)
    # A unit stuck in failed (start limit) refuses start; clear it, and a refused start is a failed start, not an exit.
    systemctl reset-failed "$SERVICE" 2>/dev/null || true
    started=1
    systemctl "$action" "$SERVICE" || started=0
    if ((started)) && healthy "$marker"; then
      printf '%s\n' "$applied" >"$applied_file"; chmod 600 "$applied_file"
      changes+=("服务已$([[ $action == start ]] && echo 启动 || echo 重启)")
    else
      log '服务没有正常启动，最近日志：'; journal_tail
      if ((program_changed)) && [[ -n "$previous_dir" && -d "$previous_dir" ]]; then
        previous_version=$(head -n1 "$previous_dir/VERSION" 2>/dev/null || echo 上一版本)
        switch_to "$previous_dir"
        rollback_unit=0
        write_unit "$previous_dir" || rollback_unit=$?
        ((rollback_unit < 2)) || log "上一版本目录里没有可用的单元模板，保留当前单元文件。"
        systemctl daemon-reload
        systemctl reset-failed "$SERVICE" 2>/dev/null || true
        marker=$(date +%s)
        if systemctl restart "$SERVICE" && healthy "$marker"; then
          fail "新版本 $new_version 启动失败，已回退到 $previous_version 并确认运行正常；请按上面的日志处理"
        fi
        log '回退后服务仍未正常运行，最近日志：'; journal_tail
        fail "新版本 $new_version 启动失败，已切回 $previous_version，但服务仍未正常运行；请按日志处理后重新执行本脚本"
      fi
      fail '服务启动失败；请按上面的日志检查配置后重新执行本脚本'
    fi
  fi
fi

# ---- 7. 清理旧版本 -------------------------------------------------------------------
current_dir=$(readlink -f "$APP_DIR/current")
kept=0
while IFS= read -r dir; do
  [[ -n "$dir" ]] || continue
  if [[ "$dir" == "$current_dir" || "$dir" == "$previous_dir" ]] || ((kept < KEEP_RELEASES)); then kept=$((kept + 1)); continue; fi
  rm -rf "$dir"
done < <(find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d ! -name '*.staging' -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d -name '*.staging' -exec rm -rf {} +

# ---- 8. 小结 --------------------------------------------------------------------------
log "版本：$new_version"
if ((${#changes[@]})); then log "已更新：$(join "${changes[@]}")"; else log '无变化。'; fi
if ((${#skipped[@]})); then log "跳过：$(join "${skipped[@]}")"; fi
if ((!configured)); then
  log "下一步：参照 $CONF_DIR/config.example.json 与 secrets.example.json 写好 $CONF_DIR/config.json 与 secrets.json，再执行一次本脚本。"
else
  port=$("$NODE_BIN" -e 'try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port; process.stdout.write(String(p ?? 4720)); } catch { process.stdout.write("4720"); }' "$CONF_DIR/config.json")
  log "本机页面：在自己电脑上执行 ssh -N -L $port:127.0.0.1:$port <服务器>，再打开 sudo cat $DATA_DIR/access-url 里的登录链接。"
fi
