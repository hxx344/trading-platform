#!/usr/bin/env bash
# 统一交易平台：安装与升级（root 运行，可重复执行，保留配置与数据）。
#
#   curl -fsSLO https://github.com/hxx344/trading-platform/releases/latest/download/install.sh && sudo bash install.sh
#   sudo bash install.sh --version v0.1.0     安装指定版本（也用于回退）
#   sudo bash install.sh --package <目录>     从本地目录安装（含 trading-platform.tar.gz 与 SHA256SUMS）
#   sudo bash install.sh --import-workbench   命令行方式从本机工作台导入已开启保证金平衡的配对与凭据并启动（可加 --pairs id,id
#                                             只导入指定配对，--workbench-data <目录> 指定工作台数据目录）；页面上也能导入，见下
#   sudo bash install.sh --import-workbench --oil
#                                             只导入工作台的原油执行账户（Binance / Bybit，hub.sqlite 解密）；同时导入配对时
#                                             再加 --pairs id,id。工作台有实盘启用的原油自动规则时拒绝导入该交易所账户
#   sudo bash install.sh --set-password       设置或更换页面登录密码（输入两次，不回显；只存 scrypt 摘要，已登录的页面须重新登录；
#                                             沿用当前已装版本，不联网升级；脚本化时加 --password-stdin 从标准输入读一行）
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
# The page's import requests: root owns it, the service's group writes requests, the root helper writes results.
IMPORT_DIR=${TP_IMPORT_DIR:-/var/lib/trading-platform-import}
UNIT_DIR=$(dirname "$UNIT_FILE")
IMPORT_UNITS=("$SERVICE-import.path" "$SERVICE-import.service")

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
usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

version=''
package_dir=''
import_workbench=0
workbench_data=''
import_pairs=''
import_oil=0
set_password=0
password_stdin=0
while (($#)); do
  case "$1" in
    --import-workbench) import_workbench=1; shift ;;
    --workbench-data) [[ $# -ge 2 ]] || usage 2; workbench_data=$2; shift 2 ;;
    --pairs) [[ $# -ge 2 ]] || usage 2; import_pairs=$2; shift 2 ;;
    --oil) import_oil=1; shift ;;
    --set-password) set_password=1; shift ;;
    --password-stdin) password_stdin=1; shift ;;
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
((set_password || !password_stdin)) || fail '--password-stdin 须和 --set-password 一起使用'

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
# Changing only the password keeps the installed release: nothing is downloaded and the program does not change.
installed_sha=$(cat "$APP_DIR/current/.package-sha256" 2>/dev/null || true)
if ((set_password)) && [[ -z "$version$package_dir" && "$installed_sha" =~ ^[a-f0-9]{64}$ ]]; then
  printf '%s  trading-platform.tar.gz\n' "$installed_sha" >"$work_dir/SHA256SUMS"
  source_label='当前已装版本'
  [[ "$(cat "$APP_DIR/releases/${installed_sha:0:16}/.package-sha256" 2>/dev/null)" == "$installed_sha" ]] || fail '找不到当前已装版本的目录，请加 --version 或 --package 指定要用的版本'
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
as_root_dir "$IMPORT_DIR" 770 root "$SERVICE_USER"
for name in config secrets; do
  example="$release_dir/deploy/$name.example.json"
  if ! cmp -s "$example" "$CONF_DIR/$name.example.json"; then install -m 644 "$example" "$CONF_DIR/$name.example.json"; fi
done
# Run as root: it reads the workbench's database and environment, and writes both files as root 600; the takeover
# below then hands them to the service account. A failed import writes nothing and stops the install.
if ((import_workbench)); then
  [[ -f "$release_dir/src/service/import-workbench.ts" ]] || fail "版本 $new_version 不支持 --import-workbench，请用最新版本导入"
  if ((import_oil)); then grep -q 'readWorkbenchOil' "$release_dir/src/service/import-workbench.ts" || fail "版本 $new_version 不支持 --oil，请用最新版本导入"; fi
  # The files the import may write: config.json and the key file it names (always in this directory).
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
  import_backup="$work_dir/conf-before"
  backup_what='导入'
  import_args=(--config "$CONF_DIR/config.json" --workbench-env "$WORKBENCH_ENV")
  [[ -z "$workbench_data" ]] || import_args+=(--workbench-data "$workbench_data")
  [[ -z "$import_pairs" ]] || import_args+=(--pairs "$import_pairs")
  ((!import_oil)) || import_args+=(--oil)
  (cd / && "$NODE_BIN" "$release_dir/src/service/import-workbench.ts" "${import_args[@]}" 9>&-) || fail '从工作台导入配置失败'
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
config_hash() {
  "$NODE_BIN" -e 'const fs = require("fs"), hash = require("crypto").createHash("sha256"); const text = fs.readFileSync(process.argv[1]); hash.update(text);
    try { const s = JSON.parse(text).secretsFile; if (typeof s === "string") hash.update(fs.readFileSync(s)); } catch {}
    try { const p = require("path").join(require("path").dirname(process.argv[1]), "login-password"); hash.update("login-password"); hash.update(fs.readFileSync(p)); } catch {}
    process.stdout.write(hash.digest("hex"));' "$CONF_DIR/config.json"
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
  # Pages logged in before (perhaps with the old password) are logged out: the restart below makes a new session.
  if ((set_password)); then rm -f "$DATA_DIR/http-session"; fi
fi

# ---- 5. systemd 单元、切换版本 ---------------------------------------------------------
# Written only after the config check passed, so a failed run never leaves a new unit that systemd was not reloaded for.
render_to() { # 模板 输出；模板缺失或无法生成时失败
  [[ -f "$1" ]] || return 1
  sed -e "s|@NODE@|$NODE_BIN|g" -e "s|@APP_DIR@|$APP_DIR|g" -e "s|@CONF_DIR@|$CONF_DIR|g" -e "s|@DATA_DIR@|$DATA_DIR|g" \
    -e "s|@IMPORT_DIR@|$IMPORT_DIR|g" -e "s|@FLOCK@|$FLOCK_BIN|g" -e "s|@WORKBENCH_ENV@|$WORKBENCH_ENV|g" "$1" >"$2" || return 1
  [[ -s "$2" ]]
}
render_unit() { # 模板 目标；有变化并已写入返回 0，未变化返回 1，模板缺失或无法生成返回 2（不动现有单元）
  render_to "$1" "$work_dir/unit" || return 2
  cmp -s "$work_dir/unit" "$2" && return 1
  install -m 644 "$work_dir/unit" "$2"
}
write_unit() { render_unit "$1/deploy/trading-platform.service" "$UNIT_FILE"; } # $1：取单元模板的版本目录
FLOCK_BIN=$(command -v flock)
# The page's import helper. A release without its templates (older than v0.3.0) leaves any installed units as they are.
# Rendered before any unit is written, so a failure here leaves every installed unit untouched.
for unit in "${IMPORT_UNITS[@]}"; do
  if [[ -f "$release_dir/deploy/$unit" ]]; then render_to "$release_dir/deploy/$unit" "$work_dir/$unit" || fail "无法生成 $unit，未切换版本。"; fi
done
unit_changed=0
unit_status=0
write_unit "$release_dir" || unit_status=$?
case $unit_status in
  0) unit_changed=1; changes+=('systemd 单元') ;;
  1) skipped+=('systemd 单元（未变化）') ;;
  *) fail '无法从程序包生成 systemd 单元，未切换版本。' ;;
esac
import_units_changed=0
for unit in "${IMPORT_UNITS[@]}"; do
  [[ -f "$work_dir/$unit" ]] || continue
  cmp -s "$work_dir/$unit" "$UNIT_DIR/$unit" && continue
  install -m 644 "$work_dir/$unit" "$UNIT_DIR/$unit"
  import_units_changed=1
done
if ((import_units_changed)); then changes+=('页面导入助手单元'); fi
# An earlier run may have written a unit and stopped before reloading.
needs_reload() {
  ((unit_changed || import_units_changed)) && return 0
  [[ "$TEST_MODE" != 1 ]] || return 1
  local unit
  for unit in "$SERVICE" "${IMPORT_UNITS[@]}"; do
    [[ "$(systemctl show -p NeedDaemonReload --value "$unit" 2>/dev/null)" != yes ]] || return 0
  done
  return 1
}
program_changed=0
if [[ "$previous_dir" != "$release_dir" ]]; then switch_to "$release_dir"; program_changed=1; changes+=("程序 $new_version"); fi
applied_file="$APP_DIR/.applied-config"
config_changed=0
if ((configured)); then
  applied=$(config_hash)
  [[ "$(cat "$applied_file" 2>/dev/null || true)" == "$applied" ]] || config_changed=1
fi

# ---- 6. 启动或重启 ------------------------------------------------------------------
# Failing to arm the import helper does not fail the install: the service runs, only the page's import waits for it.
ensure_import_path() {
  [[ -f "$UNIT_DIR/$SERVICE-import.path" ]] || return 0
  local unit="$SERVICE-import.path"
  if ! systemctl is-enabled --quiet "$unit"; then
    if systemctl enable --quiet "$unit"; then changes+=('页面导入助手'); else log "无法设置 $unit 开机自启，页面导入暂不可用"; return 0; fi
  fi
  if ((import_units_changed)) || ! systemctl is-active --quiet "$unit"; then
    systemctl restart "$unit" || log "无法启动 $unit，页面导入暂不可用"
  fi
}
journal_tail() { steady journalctl -u "$SERVICE" -n 30 --no-pager -o cat 2>/dev/null || true; }
healthy() { # marker：重启前的时间（秒）；服务写出新的登录链接文件说明已完成装配并在本机监听
  local marker=$1 waited=0 restarts
  while ((waited < HEALTH_WAIT_S * 2)); do
    steady sleep 0.5; waited=$((waited + 1))
    [[ "$(steady systemctl show -p ActiveState --value "$SERVICE")" == active ]] || continue
    [[ -f "$DATA_DIR/access-url" && "$(stat -c %Y "$DATA_DIR/access-url")" -ge "$marker" ]] || continue
    restarts=$(steady systemctl show -p NRestarts --value "$SERVICE")
    steady sleep 5
    [[ "$(steady systemctl show -p ActiveState --value "$SERVICE")" == active && "$(steady systemctl show -p NRestarts --value "$SERVICE")" == "$restarts" ]] && return 0
    return 1
  done
  return 1
}
if [[ "$TEST_MODE" == 1 ]]; then
  skipped+=('systemctl（测试模式）')
  ((configured)) && printf '%s\n' "$applied" >"$applied_file"
elif ((!configured)); then
  if needs_reload; then systemctl daemon-reload; fi
  ensure_import_path
  skipped+=('启动服务（尚无 config.json）')
else
  if needs_reload; then systemctl daemon-reload; fi
  ensure_import_path
  if ! systemctl is-enabled --quiet "$SERVICE"; then systemctl enable --quiet "$SERVICE"; changes+=('开机自启'); fi
  action=''
  if ! systemctl is-active --quiet "$SERVICE"; then action=start
  elif ((program_changed || unit_changed || config_changed)); then action=restart
  else skipped+=('服务（运行中，无需重启）'); fi
  if [[ -n "$action" ]]; then
    # Once systemctl has run, the service may be on the new files: a signal now would put them back under a running
    # service. It waits for the health check instead, whose success or failure branch leaves things consistent.
    # The commands below run through steady, so the check is never cut short either; a closed pipe only fails a write.
    trap 'interrupted=1; log "收到停止信号：服务正在启动，检查结束后再退出"' INT TERM HUP
    trap '' PIPE
    printf -v marker '%(%s)T' -1
    # A unit stuck in failed (start limit) refuses start; clear it, and a refused start is a failed start, not an exit.
    steady systemctl reset-failed "$SERVICE" 2>/dev/null || true
    started=1
    steady systemctl "$action" "$SERVICE" || started=0
    if ((started)) && healthy "$marker"; then
      # Running on the new files from here: nothing that fails below may put them back.
      import_backup=''
      printf '%s\n' "$applied" >"$applied_file"; chmod 600 "$applied_file"
      changes+=("服务已$([[ $action == start ]] && echo 启动 || echo 重启)")
    else
      log '服务没有正常启动，最近日志：'; journal_tail
      imported=0
      if [[ -n "$import_backup" ]]; then restore_import; imported=1; fi
      # A first setup by import leaves no config once undone: nothing to run, so the unit is not left to fail at boot.
      if ((imported)) && [[ ! -f "$CONF_DIR/config.json" ]]; then
        steady systemctl disable --now --quiet "$SERVICE" 2>/dev/null || true
        fail "${backup_what}后的配置启动失败，已撤销${backup_what}（尚无 config.json），服务已停止并取消开机自启；请按上面的日志处理后重新执行本脚本"
      fi
      if ((program_changed)) && [[ -n "$previous_dir" && -d "$previous_dir" ]]; then
        previous_version=$(head -n1 "$previous_dir/VERSION" 2>/dev/null || echo 上一版本)
        # A config only the new version reads (say "host") would leave the old one unable to start: stay instead.
        if ! previous_check=$(as_service "$NODE_BIN" "$previous_dir/src/service/main.ts" --config "$CONF_DIR/config.json" --check-config 2>&1); then
          fail "新版本 $new_version 启动失败；上一版本 $previous_version 不接受当前配置（$previous_check），未回退。请按上面的日志处理后重新执行本脚本；要回退，先删去 config.json 里新版本才有的字段（如 host）再执行 --version"
        fi
        ( trap '' INT TERM HUP; switch_to "$previous_dir" )
        rollback_unit=0
        ( trap '' INT TERM HUP; write_unit "$previous_dir" ) || rollback_unit=$?
        ((rollback_unit < 2)) || log "上一版本目录里没有可用的单元模板，保留当前单元文件。"
        steady systemctl daemon-reload
        steady systemctl reset-failed "$SERVICE" 2>/dev/null || true
        printf -v marker '%(%s)T' -1
        if steady systemctl restart "$SERVICE" && healthy "$marker"; then
          fail "新版本 $new_version 启动失败，已回退到 $previous_version 并确认运行正常；请按上面的日志处理"
        fi
        log '回退后服务仍未正常运行，最近日志：'; journal_tail
        fail "新版本 $new_version 启动失败，已切回 $previous_version，但服务仍未正常运行；请按日志处理后重新执行本脚本"
      fi
      if ((imported)); then
        printf -v marker '%(%s)T' -1
        steady systemctl reset-failed "$SERVICE" 2>/dev/null || true
        if steady systemctl restart "$SERVICE" && healthy "$marker"; then fail "${backup_what}后的配置启动失败，已恢复${backup_what}前的配置并确认服务运行正常；请按上面的日志处理"; fi
        fail "${backup_what}后的配置启动失败，已恢复${backup_what}前的配置，但服务仍未正常运行；请按日志处理后重新执行本脚本"
      fi
      fail '服务启动失败；请按上面的日志检查配置后重新执行本脚本'
    fi
  fi
fi

# The service runs on the imported files (or, in test mode, they passed the check): nothing to put back any more.
import_backup=''
trap 'exit 130' INT TERM HUP
trap - PIPE
if ((interrupted)); then log '已收到停止信号；服务已正常运行，安装已完成。'; fi

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
