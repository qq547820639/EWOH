#!/usr/bin/env bash
# 把基线库复位成空库（SEED-01/ENV-02 的修复入口，V80）。
#
# 为什么要有这一步：链级场景会消费自己的前置事实，而 up/seed/verify/reset 四者都不 DROP
# DATABASE（provision 明确「已存在，跳过（不清空）」）⇒ 基线一旦被消费到 reset 救不回来，
# 重放只剩「看起来链坏了」这一种表现。§4.1 的重放纪律据此补强为
# 「基线必须能连跑两次，**并且能从空库重建**」。
#
# 护栏（三层，任一不满足即拒绝发 DROP）：
#   1) 集群归属：端口上必须正是本套脚本自有的 PGDATA（lib.sh 的 listener_is_ours）；
#   2) 无重放竞争：verify.sh 的重放锁被活进程持有时不动库；
#   3) 连接串形状：host=127.0.0.1、端口=EWOH_CHAIN_BASE_PORT、库名=EWOH_CHAIN_BASE_DB
#      且库名必须是裸标识符（rebuild-baseline.mjs 里再核一遍）。
# 默认是 dry-run：只打印目标与护栏结论，不执行 DROP。真删要显式 --yes。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

MODE="${1:---check}"
case "$MODE" in
  --yes) : ;;
  --check) : ;;
  *) fail "用法：rebuild.sh [--check|--yes]（默认 --check 只核护栏）" ;;
esac

require_tools
assert_managed_datadir
port_busy || fail "不可用：127.0.0.1:$PGPORT 上没有集群——先跑 make chain-baseline-up"
listener_is_ours || fail "127.0.0.1:$PGPORT 上不是本套脚本管理的集群，拒绝动库"

LOCK_FILE="$BASE_DIR/.replay.lock"
if [ -f "$LOCK_FILE" ]; then
  LOCK_PID="$(tr -dc '0-9' < "$LOCK_FILE" || true)"
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    fail "另一次重放正在运行（pid=${LOCK_PID}）——复位会把它的数据抽掉，请等它结束"
  fi
fi

export EWOH_E2E_OWNER_DATABASE_URL="$(owner_url "$BASE_DB")" \
       EWOH_CHAIN_BASE_PORT="$PGPORT" EWOH_CHAIN_BASE_DB="$BASE_DB"
if [ "$MODE" = "--check" ]; then
  (cd "$APP_DIR" && node "$HERE/rebuild-baseline.mjs" --check)
else
  (cd "$APP_DIR" && node "$HERE/rebuild-baseline.mjs")
fi

if [ "$MODE" = "--check" ]; then
  log "dry-run 结束：未改动任何数据。确认要复位请跑 rebuild.sh --yes"
else
  log "接着跑 make chain-baseline-seed 重装基线库"
fi
