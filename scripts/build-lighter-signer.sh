#!/usr/bin/env bash
# 从固定的源码提交编译 Lighter 交易签名器（WASM），放进 src/varlighter/signer/：
#   lighter-signer.wasm  elliottech/lighter-go 的 ./wasm/（Apache-2.0），GOOS=js GOARCH=wasm
#   wasm_exec.js         同一 Go 版本自带的 $(go env GOROOT)/lib/wasm/wasm_exec.js
# 两个文件都不进仓库（.gitignore），也不下载任何预编译产物；仓库里只提交它们的 sha256（同目录 SHA256SUMS）。
# 文件已在且与 SHA256SUMS 一致时直接成功返回（不需要 Go）。否则用固定版本的 Go 重新编译并核对：
#   - 一致：装入 src/varlighter/signer/，返回 0；
#   - 不一致：打印实际值，返回 1，不装入；
#   - SHA256SUMS 仍是占位（64 个 0）：照常编译，醒目打印两行实际的「sha256  文件名」，返回 3，不装入。
#     把这两行抄进 SHA256SUMS 提交后再运行。
# 用法：bash scripts/build-lighter-signer.sh            编译或校验
#       bash scripts/build-lighter-signer.sh --go-version  只打印所需的 Go 版本（CI 用它装 Go，版本只写在这里）
set -euo pipefail

REPO=https://github.com/elliottech/lighter-go
# 标签 v1.0.13。按提交取源码，标签被移动也不影响。
COMMIT=e8687faa091ae78de3da78fc338a11c48b4de87e
# 上游 justfile 的 build-wasm 固定用这个工具链（GOTOOLCHAIN=go1.26.8），换版本会改变产物。
GO_VERSION=1.26.8

if [[ ${1:-} == --go-version ]]; then
  printf '%s\n' "$GO_VERSION"
  exit 0
fi
[[ $# -eq 0 ]] || { echo "未知参数：$*" >&2; exit 2; }

root=$(cd "$(dirname "$0")/.." && pwd)
dest=$root/src/varlighter/signer
sums=$dest/SHA256SUMS
placeholder=0000000000000000000000000000000000000000000000000000000000000000

die() { echo "build-lighter-signer: $*" >&2; exit 1; }

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum <"$1" | cut -d' ' -f1
  else shasum -a 256 <"$1" | cut -d' ' -f1
  fi
}

# SHA256SUMS 里某个文件登记的值：恰好一行、64 位小写十六进制，否则报错。检出成 CRLF 时去掉回车。
expected() {
  local value
  value=$(tr -d '\r' <"$sums" | awk -v name="$1" '$2 == name || $2 == "*" name { print $1 }')
  [[ $value =~ ^[0-9a-f]{64}$ ]] || die "$sums 里 $1 的登记应恰好一行、64 位小写十六进制"
  printf '%s\n' "$value"
}

[[ -f $sums ]] || die "缺少 $sums"
want_wasm=$(expected lighter-signer.wasm)
want_js=$(expected wasm_exec.js)
pending=0
if [[ $want_wasm == "$placeholder" || $want_js == "$placeholder" ]]; then pending=1; fi

if [[ $pending -eq 0 && -f $dest/lighter-signer.wasm && -f $dest/wasm_exec.js ]] &&
    [[ $(sha "$dest/lighter-signer.wasm") == "$want_wasm" && $(sha "$dest/wasm_exec.js") == "$want_js" ]]; then
  echo "Lighter 签名器已就绪，校验通过：$dest"
  exit 0
fi

command -v git >/dev/null 2>&1 || die '需要 git'
command -v go >/dev/null 2>&1 || die "需要 Go $GO_VERSION（未找到 go）"
# GOTOOLCHAIN=local：只认本机这一个工具链，不让 go 命令自己去下载别的版本。
have=$(cd / && GOTOOLCHAIN=local go version | awk '{ print $3 }')
[[ $have == "go$GO_VERSION" ]] || die "需要 Go $GO_VERSION，当前是 ${have:-未知}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src=$work/lighter-go
mkdir "$src"
git -C "$src" init -q
# 不受本机换行设置影响；只取这一个提交。
git -C "$src" -c core.autocrlf=false fetch -q --depth 1 "$REPO" "$COMMIT"
git -C "$src" -c core.autocrlf=false -c advice.detachedHead=false checkout -q --detach FETCH_HEAD
head=$(git -C "$src" rev-parse HEAD)
[[ $head == "$COMMIT" ]] || die "取到的提交是 $head，应为 $COMMIT"

# 与上游 justfile 的 build-wasm 相同的参数与干净环境；依赖按 go.sum 校验（-mod=readonly），GOWORK=off 防止上层目录的工作区介入。
(cd "$src" && GOTOOLCHAIN=local GOFLAGS='' GOWASM='' GOEXPERIMENT='' GOWORK=off CGO_ENABLED=0 GOOS=js GOARCH=wasm \
  go build -mod=readonly -trimpath -buildvcs=false -o "$work/lighter-signer.wasm" ./wasm/)
goroot=$(cd / && GOTOOLCHAIN=local go env GOROOT)
[[ -f $goroot/lib/wasm/wasm_exec.js ]] || die "Go 安装里没有 lib/wasm/wasm_exec.js：$goroot"
cp "$goroot/lib/wasm/wasm_exec.js" "$work/wasm_exec.js"

got_wasm=$(sha "$work/lighter-signer.wasm")
got_js=$(sha "$work/wasm_exec.js")
actual() {
  echo '================ Lighter 签名器实际 sha256 ================'
  printf '%s  %s\n' "$got_wasm" lighter-signer.wasm
  printf '%s  %s\n' "$got_js" wasm_exec.js
  echo '=========================================================='
}

if [[ $pending -eq 1 ]]; then
  {
    echo
    echo 'src/varlighter/signer/SHA256SUMS 仍是占位。把下面两行原样写进该文件并提交，然后重新运行：'
    actual
    echo
  } >&2
  if [[ -n ${GITHUB_STEP_SUMMARY:-} ]]; then
    { echo '### Lighter 签名器 sha256（写进 src/varlighter/signer/SHA256SUMS）'; echo '```'; printf '%s  %s\n' "$got_wasm" lighter-signer.wasm "$got_js" wasm_exec.js; echo '```'; } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 3
fi

if [[ $got_wasm != "$want_wasm" || $got_js != "$want_js" ]]; then
  {
    echo
    echo '编译结果与 src/varlighter/signer/SHA256SUMS 不一致，未装入。登记值：'
    printf '%s  %s\n' "$want_wasm" lighter-signer.wasm "$want_js" wasm_exec.js
    actual
    echo
  } >&2
  exit 1
fi

# 先写到同目录的临时名再改名，读的一方不会看到写了一半的文件。
cp "$work/lighter-signer.wasm" "$dest/.lighter-signer.wasm.tmp"
cp "$work/wasm_exec.js" "$dest/.wasm_exec.js.tmp"
mv -f "$dest/.lighter-signer.wasm.tmp" "$dest/lighter-signer.wasm"
mv -f "$dest/.wasm_exec.js.tmp" "$dest/wasm_exec.js"
echo "Lighter 签名器已编译并校验通过：$dest"
