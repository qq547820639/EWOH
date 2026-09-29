#!/usr/bin/env bash
# 试点链基线环境的共享配置与安全护栏。
#
# 为什么需要护栏：`scripts/local-up.sh` 的默认开发栈也在 **127.0.0.1:55432** 上跑一个
# Docker PostgreSQL，而 `scripts/e2e-chain.sh` 的复位路径会 `DROP DATABASE ... WITH (FORCE)`。
# 本套脚本要复用同一端口约定，却不允许误伤别人的库，因此每次动手前先确认
# 「这个监听进程就是我们管理的那个集群」。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_DIR="${EWOH_CHAIN_BASE_DIR:-$ROOT/tmp/chain-baseline}"
PGDATA="$BASE_DIR/pgdata"
SOCK_DIR="$BASE_DIR/sock"
PGPORT="${EWOH_CHAIN_BASE_PORT:-55432}"
PG_USER_OWNER="${EWOH_CHAIN_BASE_OWNER:-ewoh_owner}"
OWNER_PASSWORD="${EWOH_CHAIN_BASE_OWNER_PW:-ewoh_chain_pw}"
API_PASSWORD="${EWOH_API_DATABASE_PASSWORD:-DevApiPassword#2026x}"
# 迁移 runner 要求运行角色口令 ≥16 字符。必须显式赋值再导出：
# 只写 `export EWOH_API_DATABASE_PASSWORD` 会导出一个未赋值变量，standalone_003 随即报「短口令」。
export EWOH_API_DATABASE_PASSWORD="$API_PASSWORD"
BASE_DB="${EWOH_CHAIN_BASE_DB:-ewoh}"
ADMIN_PASSWORD="${EWOH_BOOTSTRAP_ADMIN_PASSWORD:-DevAdmin#2026x}"
APPROVER_PASSWORD="${EWOH_APPROVER_PASSWORD:-Approver#2026x}"
WORKER_PASSWORD="${EWOH_WORKER_PASSWORD:-Worker#2026x}"
# 同上：口令类变量必须「赋值后导出」，不能只 `export NAME`。
# runner 对长度有硬门禁（admin ≥12、api ≥16），空值会以「口令过短」的形式失败。
export EWOH_BOOTSTRAP_ADMIN_USERNAME="${EWOH_BOOTSTRAP_ADMIN_USERNAME:-admin}"
export EWOH_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASSWORD"
export EWOH_APPROVER_PASSWORD="$APPROVER_PASSWORD"
export EWOH_WORKER_PASSWORD="$WORKER_PASSWORD"
ORG_ID="${EWOH_CHAIN_BASE_ORG:-00000000-0000-4000-8000-000000000001}"
PERSON_ID="${EWOH_CHAIN_BASE_PERSON:-63000000-0000-4000-8000-000000000001}"
APPROVER_PERSON_ID="${EWOH_CHAIN_BASE_APPROVER_PERSON:-63000000-0000-4000-8000-000000000002}"

APP_DIR="$ROOT/ewoh-spark-app"
PGBIN_PLATFORM="darwin-arm64"
[ "$(uname -s)" = "Linux" ] && PGBIN_PLATFORM="linux-x64"
PGBIN="${EWOH_CHAIN_PG_BIN_OVERRIDE:-$APP_DIR/node_modules/@embedded-postgres/$PGBIN_PLATFORM/native/bin}"

log() { printf '\033[1;34m[chain-baseline]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[chain-baseline] 失败:\033[0m %s\n' "$*" >&2; exit 1; }

# DEP-01 诊断：把"这套重放跑不起来"分成四类，因为它们该由谁来修完全不同。
#   ok         依赖齐备
#   undeclared 父包与本平台包都不在——**干净克隆必然是这种**：`embedded-postgres` 既不在
#              `ewoh-spark-app/package.json`，也不在 `package-lock.json` / `pnpm-lock.yaml`
#              的任何包键里（两份锁文件里唯一含 "embedded" 的是 `sass-embedded`），
#              所以 `npm ci` 与 `pnpm install --frozen-lockfile` 都不会装它，与"能不能在
#              ubuntu runner 上启动"无关（那是 CI-01b 的第二个未知量）。
#   partial    父包在、本平台包缺失（可选依赖没按平台解析到，或换机/换架构）
#   broken     本平台包在、但三件套不齐或不可执行（安装损坏 / 架构不符）
# 用法：pg_provision_state [应用目录] [平台键]；默认取本仓库与本机平台。
pg_provision_state() {
  local root="${1:-$APP_DIR}"
  local platform="${2:-$PGBIN_PLATFORM}"
  local bin="$root/node_modules/@embedded-postgres/$platform/native/bin"
  if [ ! -f "$root/node_modules/embedded-postgres/package.json" ] && [ ! -x "$bin/postgres" ]; then
    echo undeclared; return 0
  fi
  if [ ! -x "$bin/postgres" ]; then echo partial; return 0; fi
  if [ ! -x "$bin/initdb" ] || [ ! -x "$bin/pg_ctl" ]; then echo broken; return 0; fi
  echo ok
}

pg_remedy() {
  # 只说事实与动作；版本以当前环境里实测存在的父包为准，没装过时让读者自己填。
  local ver=""
  if [ -f "$APP_DIR/node_modules/embedded-postgres/package.json" ]; then
    ver="$(node -p "require('$APP_DIR/node_modules/embedded-postgres/package.json').version" 2>/dev/null || true)"
  fi
  printf '%s\n' \
    '  这是 DEP-01（一次性重放的依赖未登记），不是本机环境问题。' \
    '  登记动作（两条锁文件必须一起更新，否则另一套安装器会以漂移/冻结失败）：' \
    "    1) cd $APP_DIR && npm i -D 'embedded-postgres@${ver:-<钉版>}'" \
    '    2) 同步重新生成 package-lock.json 与 pnpm-lock.yaml' \
    '       （CI 里 npm ci 与 pnpm install --frozen-lockfile 都在跑，只改一条会红另一边）' \
    '    3) 先跑 make chain-baseline-doctor 看到 ok，再跑 make chain-baseline-verify WITH_SERVER=1' >&2
}

require_tools() {
  local state
  state="$(pg_provision_state)"
  [ "$state" = "ok" ] && return 0
  case "$state" in
    undeclared)
      printf '\033[1;31m[chain-baseline] 不可用(DEP-01):\033[0m 缺少 PostgreSQL 二进制（%s）。' \
        "$PGBIN" >&2
      printf '本套脚本依赖的 embedded-postgres 没有被任何清单声明，干净克隆装不出它。\n' >&2
      ;;
    partial)
      printf '\033[1;31m[chain-baseline] 失败:\033[0m 已装 embedded-postgres，但缺本平台（%s）的二进制：可选依赖未按平台解析。\n' \
        "$PGBIN_PLATFORM" >&2
      ;;
    *)
      printf '\033[1;31m[chain-baseline] 失败:\033[0m 找到 @embedded-postgres/%s，但 native/bin 三件套不齐或不可执行（%s）。\n' \
        "$PGBIN_PLATFORM" "$PGBIN" >&2
      ;;
  esac
  pg_remedy
  exit 1
}

# 只允许操作位于本仓库 tmp/ 之下、且由本套脚本创建的集群。
assert_managed_datadir() {
  case "$PGDATA" in
    "$ROOT"/tmp/*) : ;;
    *) fail "PGDATA 必须位于 $ROOT/tmp/ 之下（当前 ${PGDATA}），拒绝操作仓库外数据目录" ;;
  esac
}

listener_is_ours() {
  [ -d "$PGDATA" ] || return 1
  if [ ! -f "$PGDATA/PG_VERSION" ]; then return 1; fi
  local actual
  actual="$("$PGBIN/postgres" -D "$PGDATA" -C data_directory 2>/dev/null || true)"
  [ "$actual" = "$PGDATA" ]
}

port_busy() {
  # 该发行版只带 initdb/pg_ctl/postgres，没有 psql/pg_isready，用 TCP 探测代替。
  node -e '
const net = require("net");
const s = net.connect({ host: "127.0.0.1", port: Number(process.argv[1]) });
s.on("connect", () => { s.end(); process.exit(0); });
s.on("error", () => process.exit(1));
setTimeout(() => process.exit(1), 1500);
' "$PGPORT"
}

# 端口被占但集群不是我们的 → 立刻退出，绝不向别人的实例下发 DDL。
guard_port() {
  if port_busy; then
    require_tools
    listener_is_ours || fail "127.0.0.1:$PGPORT 上已有非本套脚本管理的 PostgreSQL（很可能是 scripts/local-up.sh 的 Docker 开发库）。换端口 EWOH_CHAIN_BASE_PORT=... 或先停掉它。"
    return 0
  fi
}

start_cluster() {
  assert_managed_datadir
  require_tools
  mkdir -p "$BASE_DIR" "$SOCK_DIR"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "初始化集群 $PGDATA"
    "$PGBIN/initdb" -D "$PGDATA" -U ewoh_migrator --auth=trust -A trust --encoding=UTF8 \
      > "$BASE_DIR/initdb.log" 2>&1 || fail "initdb 失败，见 $BASE_DIR/initdb.log"
  fi
  if ! listener_is_ours; then
    fail "已有监听占用 $PGPORT 且数据目录不是 $PGDATA"
  fi
  if ! port_busy; then
    log "启动集群 127.0.0.1:$PGPORT"
    "$PGBIN/pg_ctl" -D "$PGDATA" \
      -o "-p $PGPORT -k $SOCK_DIR -c listen_addresses=127.0.0.1 -c max_connections=40 -c fsync=off -c synchronous_commit=off" \
      -l "$BASE_DIR/pg.log" -w -t 60 start > /dev/null || fail "启动失败，见 $BASE_DIR/pg.log"
  else
    log "集群已在 $PGPORT 运行（复用）"
  fi
}

stop_cluster() {
  if [ -f "$PGDATA/PG_VERSION" ]; then
    "$PGBIN/pg_ctl" -D "$PGDATA" -m fast stop > /dev/null 2>&1 || true
    log "已停止集群"
  fi
}

owner_url() { printf 'postgresql://%s:%s@127.0.0.1:%s/%s' "$PG_USER_OWNER" "$OWNER_PASSWORD" "$PGPORT" "$1"; }
runtime_url() { printf 'postgresql://ewoh_api:%s@127.0.0.1:%s/%s' "$(printf '%s' "$API_PASSWORD" | sed 's/#/%23/')" "$PGPORT" "$BASE_DB"; }

export_env() {
  cat <<EOF
export EWOH_PG_URL="$(owner_url "$BASE_DB")"
export EWOH_DATABASE_URL="$(owner_url "$BASE_DB")"
export EWOH_E2E_OWNER_DATABASE_URL="$(owner_url "$BASE_DB")"
export EWOH_E2E_RUNTIME_DATABASE_URL="$(runtime_url)"
export DATABASE_URL="$(runtime_url)"
export EWOH_API_DATABASE_PASSWORD='$API_PASSWORD'
export EWOH_ALLOW_DDL=1
export EWOH_BOOTSTRAP_ADMIN_USERNAME=admin
export EWOH_BOOTSTRAP_ADMIN_PASSWORD='$ADMIN_PASSWORD'
export EWOH_E2E_ADMIN_USER=admin
export EWOH_E2E_ADMIN_PASS='$ADMIN_PASSWORD'
export EWOH_E2E_APPROVER_USER=approver.li
export EWOH_E2E_APPROVER_PASS='$APPROVER_PASSWORD'
export EWOH_E2E_OPERATOR_USER=approver.li
export EWOH_E2E_OPERATOR_PASS='$APPROVER_PASSWORD'
export EWOH_E2E_FIELD_USER=worker.zhangwei
export EWOH_E2E_FIELD_PASS='$WORKER_PASSWORD'
export EWOH_E2E_BACKEND_URL=http://127.0.0.1:3100
export EWOH_E2E_PG_URL="$(owner_url "$BASE_DB")"
export EWOH_E2E_PERSON_ID='$PERSON_ID'
export EWOH_CONTROL_FINGERPRINT_SECRET='${EWOH_CONTROL_FINGERPRINT_SECRET:-chain-baseline-fp-secret}'
EOF
}
