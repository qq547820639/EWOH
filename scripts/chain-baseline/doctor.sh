#!/usr/bin/env bash
# 一次性重放环境的自检（DEP-01 的可诊断入口）。
#
# 为什么单独有它：`chain-baseline-verify` 只有一个退出码，"依赖没装" 与 "链跑红了"
# 在它里面是同一个数字。CI 接入（CI-01b）必须先能区分这两件事——否则一条依赖缺失的
# 克隆会把"不可用"报成失败（噪声），或在被 `continue-on-error` 吞掉时报成通过（假绿）。
# 因此本脚本用**独立退出码**表达"不可用"：
#   0  依赖齐备（ok）
#   3  依赖不可用（undeclared / partial）——CI 应记为 UNAVAILABLE，不得记为 PASS
#   1  其他故障（broken：包在但三件套不可执行）
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$DIR/lib.sh"

declared_in() {
  # 文件不存在时 grep -c 什么都不输出（退出码 2），会被读成"空"；这里显式回 0，
  # 免得清单计数看起来像"没测"。
  local n
  n="$(grep -c "embedded-postgres" "$1" 2>/dev/null || true)"
  printf '%s' "${n:-0}"
}

# 链接水合自检（V101 实测后的新增判据）。
# 为什么要有：平台包的 native/lib 只发布**全版本号**的真实库（libzstd.1.5.7.dylib 等），
# 可执行文件按 **soname**（libzstd.1.dylib / libicuuc.so.60 …）加载，而这些短名是 postinstall
# 的 hydrate-symlinks.js 生成的。A/B 实测：`npm i --ignore-scripts` 装出来的树 `postgres --version`
# 直接 rc=134 "Library not loaded"，默认 `npm i` 装的可用 rc=0。
# 也就是说"包在、三件套在、却根本跑不起来"是一种**独立失效形状**——不查它就会在 initdb 时
# 以一条谁也看不懂的 dyld 错误出现，正是本脚本要消灭的那类噪声（V73 的初衷）。
# 返回：ok / missing:<n>/<m> / no-manifest（清单不在＝该平台不需要水合，不判坏）
hydration_state() {
  local pkg_dir="${1:-$APP_DIR/node_modules/@embedded-postgres/$PGBIN_PLATFORM}"
  local manifest="$pkg_dir/native/pg-symlinks.json"
  [ -f "$manifest" ] || { printf 'no-manifest'; return 0; }
  node -e '
    const fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    const list = JSON.parse(fs.readFileSync(path.join(dir, "native/pg-symlinks.json"), "utf8"));
    const missing = list.filter((e) => !fs.existsSync(path.join(dir, e.target)));
    process.stdout.write(missing.length ? `missing:${missing.length}/${list.length}:${missing[0].target}` : "ok");
  ' "$pkg_dir" 2>/dev/null || printf 'broken-probe'
}

report() {
  local state hyd
  state="$(pg_provision_state)"
  echo "平台键         : $PGBIN_PLATFORM"
  echo "二进制目录     : $PGBIN"
  echo "依赖分类       : $state"
  echo "package.json   : $(declared_in "$APP_DIR/package.json") 处声明"
  echo "package-lock   : $(declared_in "$APP_DIR/package-lock.json") 处引用"
  echo "pnpm-lock      : $(declared_in "$APP_DIR/pnpm-lock.yaml") 处引用"
  if [ -f "$APP_DIR/node_modules/embedded-postgres/package.json" ]; then
    echo "父包版本       : $(node -p "require('$APP_DIR/node_modules/embedded-postgres/package.json').version" 2>/dev/null || echo '?')"
  else
    echo "父包版本       : 未安装"
  fi
  echo "监听 127.0.0.1:$PGPORT : $(port_busy >/dev/null 2>&1 && echo 在（本套集群或他人实例） || echo 无)"
  hyd="$(hydration_state)"
  echo "链接水合       : $hyd"
  # 只有 missing:* 才判失效；no-manifest（该平台不需要水合）与 broken-probe 都不越权改判。
  if [ "$state" = ok ] && [ "${hyd#missing:}" != "$hyd" ]; then
    echo "  包与三件套都在，但 soname 别名缺失（${hyd}）：安装时跳过了 install scripts。" >&2
    echo "  处置：允许本平台包 postinstall，或显式跑 node $APP_DIR/node_modules/@embedded-postgres/$PGBIN_PLATFORM/scripts/hydrate-symlinks.js 后重试。" >&2
    state_out_override=broken
  fi
  case "$state" in
    ok) ;;
    undeclared) pg_remedy ;;
    partial) echo "  缺本平台二进制：换机/换架构或可选依赖未解析；重装或在 CI 里显式安装本平台包。" >&2 ;;
    *) echo "  包在但三件套不齐/不可执行：属安装损坏，需要人工看 ${PGBIN}。" >&2 ;;
  esac
  return 0
}

# 自测：证明这套分类**能变红**（不是永远回 ok 的摆设）。
# 用 tmp/ 下的合成目录跑四态，且额外断言"全空目录不会被误判成 ok"。
# 注意：这条**不检查本机环境**——干净克隆上真实仓库本来就判 undeclared（那正是 DEP-01），
# 把主机断言混进门禁会让 CI 因为"依赖没登记"而在一条讲"分类逻辑对不对"的闸上变红。
# 主机反证单独用 --self-test-with-host 跑（人工/本机环境检查）。
self_test() {
  local base="$ROOT/tmp/chain-baseline-doctor-selftest" fails=0 with_host="${1:-}"
  rm -rf "$base"; mkdir -p "$base"
  stub() { mkdir -p "$1"; : > "$1/postgres"; : > "$1/initdb"; : > "$1/pg_ctl"; chmod +x "$1"/postgres "$1"/initdb "$1"/pg_ctl; }
  expect() { # expect <desc> <want> <got>
    if [ "$2" = "$3" ]; then echo "  ok   $1 ($3)"; else echo "  FAIL $1: 期望 $2 实得 $3" >&2; fails=$((fails + 1)); fi
  }
  expect "空目录=未登记(不是 ok)"      undeclared "$(pg_provision_state "$base/empty" x)"
  mkdir -p "$base/parent/node_modules/embedded-postgres"; : > "$base/parent/node_modules/embedded-postgres/package.json"
  expect "只有父包=本平台缺失"          partial    "$(pg_provision_state "$base/parent" x)"
  stub "$base/broken/node_modules/@embedded-postgres/x/native/bin"
  chmod -x "$base/broken/node_modules/@embedded-postgres/x/native/bin/pg_ctl"
  expect "三件套缺一=损坏"              broken     "$(pg_provision_state "$base/broken" x)"
  mkdir -p "$base/ok/node_modules/embedded-postgres"; : > "$base/ok/node_modules/embedded-postgres/package.json"
  stub "$base/ok/node_modules/@embedded-postgres/x/native/bin"
  expect "齐备=ok"                      ok         "$(pg_provision_state "$base/ok" x)"
  # 再加一条"分类器不会把所有东西都判成同一个值"的判别控制：
  expect "四态互不相同"                4          "$(printf '%s\n%s\n%s\n%s\n' \
    "$(pg_provision_state "$base/empty" x)" "$(pg_provision_state "$base/parent" x)" \
    "$(pg_provision_state "$base/broken" x)" "$(pg_provision_state "$base/ok" x)" | sort -u | wc -l | tr -d ' ')"
  # V101 新增：链接水合判据（soname 别名缺失＝包在但跑不起来）
  hstub() { # hstub <dir> <要放的目标别名，可多个>
    local d="$1"; mkdir -p "$d/native/lib"; : > "$d/native/lib/libzstd.1.5.7.dylib"
    printf '[{"source":"native/lib/libzstd.1.5.7.dylib","target":"native/lib/libzstd.1.dylib"},{"source":"native/lib/libzstd.1.5.7.dylib","target":"native/lib/libzstd.dylib"}]' > "$d/native/pg-symlinks.json"
    shift; for t in "$@"; do ln -sf libzstd.1.5.7.dylib "$d/native/lib/$t"; done
  }
  hstub "$base/hyd-ok" libzstd.1.dylib libzstd.dylib
  expect "水合齐=ok"          ok               "$(hydration_state "$base/hyd-ok")"
  hstub "$base/hyd-missing" libzstd.dylib
  got="$(hydration_state "$base/hyd-missing")"
  case "$got" in
    # V189 注：这里必须写 ${got} 而不是 ${got}——后面紧跟全角括号时，bash 3.2 在 UTF-8
    # locale 下会把多字节字符续进变量名（"got）: unbound variable"），set -u 直接崩。
    # 本次它在主线15（每次门禁都执行）上真实咬人；同族位点清单见基线文档 §5.3em 末。
    missing:1/2:*) echo "  ok   缺一个别名=missing:1/2（${got}）" ;;
    *) echo "  FAIL 缺水合判据没有按 missing:1/2 报出：${got}" >&2; fails=$((fails + 1)) ;;
  esac
  mkdir -p "$base/hyd-none/native"; expect "无清单=不判坏" no-manifest "$(hydration_state "$base/hyd-none")"
  if [ "$with_host" = "--host" ]; then
    expect "本机真实仓库应判 ok"        ok         "$(pg_provision_state)"
  fi
  rm -rf "$base"
  if [ "$fails" -gt 0 ]; then echo "自测未通过：$fails 项" >&2; return 1; fi
  echo "自测通过（4 态 + 互异性判别控制$([ "$with_host" = "--host" ] && echo ' + 本机反证')）"
  return 0
}

if [ "${1:-}" = "--self-test" ]; then self_test; exit $?; fi
if [ "${1:-}" = "--self-test-with-host" ]; then self_test --host; exit $?; fi
state_out="$(pg_provision_state)"
report
state_out="${state_out_override:-$state_out}"
case "$state_out" in
  ok) exit 0 ;;
  undeclared | partial) exit 3 ;;
  *) exit 1 ;;
esac
