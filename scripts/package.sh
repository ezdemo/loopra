#!/usr/bin/env bash
# Package the workbench, the web server, and the desktop app into bin/.
# Target list: scripts/package-matrix.txt (shared with package.ps1).
#
# Desktop builds are windows, linux, and darwin on amd64 and arm64.
# Web also builds windows/386, linux/armv7 (GOARM=7), and linux/s390x.
# windows/amd64 also gets the short names looprax.exe and looprax-desktop.exe.
# darwin desktop builds are LoopraX .app bundles, plus a .zip that keeps
# the executable bit when the archive is copied from Windows.
#
#   ./scripts/package.sh
#   ./scripts/package.sh --only web --os linux --arch amd64
#   ./scripts/package.sh --only desktop --os darwin --arch arm64 --skip-frontend
#   ./scripts/package.sh --dry-run

set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
matrix=$root/scripts/package-matrix.txt
out=$root/bin
only=frontend,web,desktop
os_filter=
arch_filter=
skip_frontend=0
dry_run=0

usage() {
  cat <<'EOF'
用法: ./scripts/package.sh [选项]

  --only LIST     frontend,web,desktop，逗号分隔。默认三个都打。
  --os LIST       windows,linux,darwin。macOS 可写成 macos。
  --arch LIST     amd64,arm64,386,arm,s390x。armv7 等同 arm。
  --out DIR       输出目录，默认仓库 bin/。
  --skip-frontend 沿用已有 web/dist，不重新执行 pnpm build。
  --dry-run       只打印将要打包的目标。
  -h, --help      显示本说明。
EOF
}

normalize() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed \
    -e 's/^macos$/darwin/' \
    -e 's/^mac$/darwin/' \
    -e 's/^osx$/darwin/' \
    -e 's/^win$/windows/' \
    -e 's/^armv7$/arm/' \
    -e 's/^x64$/amd64/' \
    -e 's/^x86_64$/amd64/' \
    -e 's/^aarch64$/arm64/' \
    -e 's/^x86$/386/'
}

selected() {
  filter=$1
  value=$(normalize "$2")
  if [ -z "$filter" ]; then
    return 0
  fi
  old_ifs=$IFS
  IFS=,
  for token in $filter; do
    token=$(normalize "$token")
    if [ "$token" = "$value" ]; then
      IFS=$old_ifs
      return 0
    fi
  done
  IFS=$old_ifs
  return 1
}

version_key() {
  printf '%s\n' "$1" | awk '
    {
      if (match($0, /go([0-9]+)\.([0-9]+)(\.([0-9]+))?/)) {
        split(substr($0, RSTART + 2), parts, /[^0-9]+/)
        patch = parts[3] + 0
        printf "%d\n", parts[1] * 1000000 + parts[2] * 1000 + patch
      } else {
        print 0
      }
    }
  '
}

find_go() {
  if command -v go >/dev/null 2>&1; then
    command -v go
    return
  fi
  if command -v go.exe >/dev/null 2>&1; then
    command -v go.exe
    return
  fi
  best=
  best_key=0
  for dir in "$HOME/go" "$HOME/sdk"; do
    [ -d "$dir" ] || continue
    for candidate in "$dir"/go*/bin/go "$dir"/go*/bin/go.exe; do
      [ -f "$candidate" ] || continue
      key=$(version_key "$candidate")
      if [ "$key" -gt "$best_key" ]; then
        best=$candidate
        best_key=$key
      fi
    done
  done
  if [ -z "$best" ]; then
    echo '未找到 go。请安装 Go 1.27.3，或把 go 加入 PATH。' >&2
    exit 1
  fi
  printf '%s\n' "$best"
}

artifact_name() {
  product=$1
  goos=$2
  arch=$3
  goarm=$4
  label=$arch
  if [ "$arch" = arm ] && [ "$goarm" = 7 ]; then
    label=armv7
  fi
  prefix=looprax
  if [ "$product" = desktop ]; then
    prefix=looprax-desktop
  fi
  name=$prefix-$goos-$label
  if [ "$goos" = windows ]; then
    name=$name.exe
  elif [ "$product" = desktop ] && [ "$goos" = darwin ]; then
    name=$name.app
  fi
  printf '%s\n' "$name"
}

mac_version() {
  sed -n 's/.*var Version = "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' \
    "$root/internal/controller/version.go" | head -n 1
}

# Wrap a darwin desktop binary as LoopraX.app. Prints the zip path when one
# was written.
publish_darwin_app() {
  binary=$1
  app=$2
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" || return 1
  mv "$binary" "$app/Contents/MacOS/LoopraX" || return 1
  chmod 755 "$app/Contents/MacOS/LoopraX" 2>/dev/null || true
  version=$(mac_version || true)
  if [ -z "$version" ]; then
    version=0.1.0
  fi
  sed "s/@VERSION@/$version/g" "$root/scripts/macos/Info.plist" >"$app/Contents/Info.plist" || return 1
  printf 'APPL????' >"$app/Contents/PkgInfo" || return 1
  py_icon=
  if command -v python3 >/dev/null 2>&1; then
    py_icon=python3
  elif command -v python >/dev/null 2>&1; then
    py_icon=python
  fi
  if [ -n "$py_icon" ]; then
    "$py_icon" "$root/scripts/appicon.py" app "$app" || echo '  图标未写入 .app' >&2
  fi
  zip=${app%.app}.zip
  py=
  if command -v python3 >/dev/null 2>&1; then
    py=python3
  elif command -v python >/dev/null 2>&1; then
    py=python
  fi
  if [ -n "$py" ] && "$py" "$root/scripts/zip-macos-app.py" "$app" "$zip"; then
    echo "  拷到 Mac 用 $(basename "$zip")"
    printf '%s\n' "$zip"
    return 0
  fi
  echo '  已生成 .app。从 Windows 拷到 Mac 后需要 chmod +x Contents/MacOS/LoopraX' >&2
}

alias_name() {
  product=$1
  goos=$2
  arch=$3
  if [ "$goos" = windows ] && [ "$arch" = amd64 ] && [ "$product" = web ]; then
    printf '%s\n' looprax.exe
    return
  fi
  if [ "$goos" = windows ] && [ "$arch" = amd64 ] && [ "$product" = desktop ]; then
    printf '%s\n' looprax-desktop.exe
    return
  fi
  printf '\n'
}

while [ $# -gt 0 ]; do
  case $1 in
    --only | --os | --arch | --out)
      if [ $# -lt 2 ]; then
        echo "缺少 $1 的值" >&2
        exit 2
      fi
      case $1 in
        --only) only=$2 ;;
        --os) os_filter=$2 ;;
        --arch) arch_filter=$2 ;;
        --out) out=$2 ;;
      esac
      shift 2
      ;;
    --skip-frontend)
      skip_frontend=1
      shift
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

only=$(normalize "$only")
want_frontend=0
want_web=0
want_desktop=0
old_ifs=$IFS
IFS=,
for token in $only; do
  token=$(normalize "$token")
  case $token in
    frontend) want_frontend=1 ;;
    web) want_web=1 ;;
    desktop) want_desktop=1 ;;
    '') ;;
    *)
      echo "未知产品 '$token'。可用 frontend、web、desktop。" >&2
      exit 2
      ;;
  esac
done
IFS=$old_ifs
if [ "$want_frontend" -eq 0 ] && [ "$want_web" -eq 0 ] && [ "$want_desktop" -eq 0 ]; then
  echo '没有选择任何产物。' >&2
  exit 2
fi
if [ "$skip_frontend" -eq 1 ] && [ "$want_web" -eq 0 ] && [ "$want_desktop" -eq 0 ]; then
  echo '--skip-frontend 只在同时打包 web 或 desktop 时有意义。' >&2
  exit 2
fi

old_ifs=$IFS
IFS=,
for token in $os_filter; do
  token=$(normalize "$token")
  case $token in
    '' | windows | linux | darwin) ;;
    *)
      echo "未知系统 '$token'。可用 windows、linux、darwin。" >&2
      exit 2
      ;;
  esac
done
for token in $arch_filter; do
  token=$(normalize "$token")
  case $token in
    '' | amd64 | arm64 | 386 | arm | s390x) ;;
    *)
      echo "未知架构 '$token'。可用 amd64、arm64、386、arm、s390x。" >&2
      exit 2
      ;;
  esac
done
IFS=$old_ifs

targets=$root/scripts/.package-targets.tmp
trap 'rm -f "$targets"' EXIT
: >"$targets"
while IFS= read -r line || [ -n "$line" ]; do
  line=$(printf '%s' "$line" | tr -d '\r')
  case $line in
    '' | \#*) continue ;;
  esac
  set -- $line
  if [ $# -lt 3 ] || [ $# -gt 4 ]; then
    echo "目标清单格式错误: $line" >&2
    exit 2
  fi
  product=$(normalize "$1")
  goos=$(normalize "$2")
  arch=$(normalize "$3")
  goarm=${4:--}
  if [ -z "$goarm" ]; then
    goarm=-
  fi
  case $product in
    web | desktop) ;;
    *)
      echo "目标清单里的产品无法识别: $product" >&2
      exit 2
      ;;
  esac
  if [ "$product" = web ] && [ "$want_web" -eq 0 ]; then
    continue
  fi
  if [ "$product" = desktop ] && [ "$want_desktop" -eq 0 ]; then
    continue
  fi
  if ! selected "$os_filter" "$goos"; then
    continue
  fi
  if ! selected "$arch_filter" "$arch"; then
    continue
  fi
  printf '%s %s %s %s\n' "$product" "$goos" "$arch" "$goarm" >>"$targets"
done <"$matrix"

target_count=$(wc -l <"$targets" | tr -d ' ')
build_frontend=0
if [ "$skip_frontend" -eq 0 ] && { [ "$want_frontend" -eq 1 ] || [ "$want_web" -eq 1 ] || [ "$want_desktop" -eq 1 ]; }; then
  build_frontend=1
fi
if [ "$want_web" -eq 1 ] || [ "$want_desktop" -eq 1 ]; then
  if [ "$target_count" -eq 0 ]; then
    echo '没有符合条件的目标。桌面端只有 windows、linux、darwin 的 amd64 和 arm64。' >&2
    exit 2
  fi
fi

echo "仓库 $root"
echo "输出 $out"
if [ "$dry_run" -eq 1 ]; then
  if [ "$build_frontend" -eq 1 ]; then
    echo '前端 web/ （pnpm build）'
  elif [ "$want_web" -eq 1 ] || [ "$want_desktop" -eq 1 ]; then
    echo '前端 跳过，使用现有 web/dist'
  fi
  while IFS= read -r line; do
    set -- $line
    name=$(artifact_name "$1" "$2" "$3" "$4")
    extra=$(alias_name "$1" "$2" "$3")
    if [ -n "$extra" ]; then
      printf '%-8s %-8s %-6s %s  ->  %s\n' "$1" "$2" "$3" "$name" "$extra"
    else
      printf '%-8s %-8s %-6s %s\n' "$1" "$2" "$3" "$name"
    fi
  done <"$targets"
  exit 0
fi

mkdir -p "$out"
if [ "$build_frontend" -eq 1 ]; then
  if ! command -v pnpm >/dev/null 2>&1; then
    echo '未找到 pnpm。请先安装 pnpm，再打包前端。' >&2
    exit 1
  fi
  if [ ! -d "$root/web/node_modules" ]; then
    echo '== pnpm install =='
    pnpm --dir "$root/web" install --frozen-lockfile
  fi
  echo '== 前端 =='
  pnpm --dir "$root/web" build
fi

if [ "$target_count" -eq 0 ]; then
  echo '前端已打包到 web/dist'
  exit 0
fi
if [ ! -f "$root/web/dist/index.html" ]; then
  echo "缺少 $root/web/dist/index.html。先打包前端，或去掉 --skip-frontend。" >&2
  exit 1
fi

go_bin=$(find_go)
export GOTOOLCHAIN=local
echo "== $($go_bin version) =="
when=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ldflags="-s -w -X github.com/ezdemo/looprax/internal/controller.BuildTime=$when"
failures=$root/scripts/.package-failures.tmp
built=$root/scripts/.package-built.tmp
: >"$failures"
: >"$built"
trap 'rm -f "$targets" "$failures" "$built"' EXIT

while IFS= read -r line; do
  set -- $line
  product=$1
  goos=$2
  arch=$3
  goarm=$4
  if [ "$goarm" = - ]; then
    goarm=
  fi
  name=$(artifact_name "$product" "$goos" "$arch" "$goarm")
  dest=$out/$name
  tmp=$dest.tmp
  pkg=./cmd/looprax
  if [ "$product" = desktop ]; then
    pkg=./cmd/looprax-desktop
  fi
  label="$product $goos/$arch"
  if [ -n "$goarm" ]; then
    label="$label GOARM=$goarm"
  fi
  echo "== $label =="
  saved_os=${GOOS-}
  saved_arch=${GOARCH-}
  saved_arm=${GOARM-}
  saved_cgo=${CGO_ENABLED-}
  export GOOS=$goos GOARCH=$arch CGO_ENABLED=0
  if [ -n "$goarm" ]; then
    export GOARM=$goarm
  else
    unset GOARM
  fi
  rm -f "$tmp"
  build_ldflags=$ldflags
  # Windows 桌面端不分配控制台，双击打开时不会冒出黑窗口。
  if [ "$product" = desktop ] && [ "$goos" = windows ]; then
    build_ldflags="$ldflags -H windowsgui"
  fi
  if (cd "$root" && "$go_bin" build -trimpath -tags webdist -ldflags "$build_ldflags" -o "$tmp" "$pkg"); then
    if [ "$product" = desktop ] && [ "$goos" = darwin ]; then
      if publish_darwin_app "$tmp" "$dest" >/dev/null; then
        printf '%s\n' "$dest" >>"$built"
        zip=${dest%.app}.zip
        if [ -f "$zip" ]; then
          echo "  拷到 Mac 用 $(basename "$zip")"
          printf '%s\n' "$zip" >>"$built"
        fi
      else
        echo "失败 $label" >&2
        printf '%s\n' "$label" >>"$failures"
        rm -rf "$dest"
        rm -f "$tmp"
      fi
    else
      mv -f "$tmp" "$dest"
      printf '%s\n' "$dest" >>"$built"
      py_icon=
      if command -v python3 >/dev/null 2>&1; then
        py_icon=python3
      elif command -v python >/dev/null 2>&1; then
        py_icon=python
      fi
      if [ -n "$py_icon" ] && [ "$goos" = windows ]; then
        "$py_icon" "$root/scripts/appicon.py" exe "$dest" || echo '  图标未写入 exe' >&2
      fi
      extra=$(alias_name "$product" "$goos" "$arch")
      if [ -n "$extra" ]; then
        if ln -f "$dest" "$out/$extra" 2>/dev/null; then
          echo "  别名 $extra"
        elif cp -f "$dest" "$out/$extra"; then
          echo "  别名 $extra（副本）"
        else
          echo "  无法创建别名 $extra" >&2
        fi
      fi
    fi
  else
    echo "失败 $label" >&2
    printf '%s\n' "$label" >>"$failures"
    rm -f "$tmp"
  fi
  if [ -n "$saved_os" ]; then export GOOS=$saved_os; else unset GOOS; fi
  if [ -n "$saved_arch" ]; then export GOARCH=$saved_arch; else unset GOARCH; fi
  if [ -n "$saved_arm" ]; then export GOARM=$saved_arm; else unset GOARM; fi
  if [ -n "$saved_cgo" ]; then export CGO_ENABLED=$saved_cgo; else unset CGO_ENABLED; fi
done <"$targets"

echo
echo '产物'
while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ -d "$path" ]; then
    bytes=$(find "$path" -type f -exec wc -c {} \; | awk '{s+=$1} END {print s+0}')
  else
    bytes=$(wc -c <"$path" | tr -d ' ')
  fi
  awk -v bytes="$bytes" -v name="$(basename "$path")" 'BEGIN { printf "%8.1f MB  %s\n", bytes/1048576, name }'
done <"$built"
if [ -s "$failures" ]; then
  echo
  echo "失败 $(wc -l <"$failures" | tr -d ' ') 个目标"
  sed 's/^/  /' "$failures"
  exit 1
fi
