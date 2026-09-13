#!/usr/bin/env bash
# EWOH 本地一键启动（2026-09-11）。
#
# 目标：把「感知 → 影响 → 方案 → 审批 → 派工 → 执行回执 → 反馈 → 学习」
# 这条主产品闭环在本机用真实 PostgreSQL 跑起来。幂等——重复执行安全；
# 已在跑的服务先停掉再启动，数据库默认不动已有数据。
#
# 用法：
#   ./scripts/local-up.sh                # 首次/日常启动（库不存在时自动建）
#   ./scripts/local-up.sh --rebuild-db   # 丢弃本地开发库数据，从迁移链重建
#   ./scripts/local-up.sh --skip-build   # 跳过构建（dist 已是最新时用）
#   ./scripts/local-up.sh --no-server    # 只初始化数据库与账号，不启动服务
#   ./scripts/local-up.sh --reset-scenario  # 复位场景 + 清累积表（见下）
#
# --reset-scenario：复位 seed 场景并**清空派生的/累积的**运行时事实（快照、
# 事件、outbox、排产派生…）。本地库累积是已实测的退化源——求解成本对候选
# 任务数超线性，`POST /api/scheduler/runs` 会从 5s 退化到 >180s 且无明显线索。
# 排产变慢时先跑它。只在本机开发库使用：不可逆，配置/种子（人、设备、班次、
# 模板、策略基线）不受影响。预览可单独跑：
#   node db/runner/reset-scenario-data.js --org-id <uuid> --purge-derived
#
# 环境变量均可覆盖（以下是本地开发默认值，勿用于生产）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/ewoh-spark-app"

PG_CONTAINER="${PG_CONTAINER:-ewoh-pg-dev}"
PG_PORT="${PG_PORT:-55432}"
PG_USER="${PG_USER:-ewoh_owner}"
PG_PASSWORD="${PG_PASSWORD:-devownerpw}"
PG_DB="${PG_DB:-ewoh}"
DB_URL_OWNER="${EWOH_DATABASE_URL:-postgresql://ewoh_owner:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}}"

EWOH_API_DATABASE_PASSWORD="${EWOH_API_DATABASE_PASSWORD:-DevApiPassword#2026x}"
EWOH_BOOTSTRAP_ADMIN_USERNAME="${EWOH_BOOTSTRAP_ADMIN_USERNAME:-admin}"
EWOH_BOOTSTRAP_ADMIN_PASSWORD="${EWOH_BOOTSTRAP_ADMIN_PASSWORD:-DevAdmin#2026x}"
APPROVER_PASSWORD="${EWOH_APPROVER_PASSWORD:-Approver#2026x}"
WORKER_PASSWORD="${EWOH_WORKER_PASSWORD:-Worker#2026x}"

SERVER_PORT="${SERVER_PORT:-3100}"
ORG_ID="00000000-0000-4000-8000-000000000001"

REBUILD_DB=0; SKIP_BUILD=0; NO_SERVER=0; RESET_SCENARIO=0
for arg in "$@"; do
  case "$arg" in
    --rebuild-db) REBUILD_DB=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-server)  NO_SERVER=1 ;;
    --reset-scenario) RESET_SCENARIO=1 ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

log()  { printf '\033[1;34m[local-up]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[local-up] 失败:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. PostgreSQL
log "1/6 检查 PostgreSQL（docker 容器 ${PG_CONTAINER}）"
if ! command -v docker >/dev/null 2>&1; then
  fail "未找到 docker。请自备 PostgreSQL ≥17，并把 DB_URL_OWNER 指向它。"
fi
if ! docker inspect "$PG_CONTAINER" >/dev/null 2>&1; then
  log "  创建容器 ${PG_CONTAINER}（端口 ${PG_PORT}）"
  docker run -d --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" -e POSTGRES_DB="$PG_DB" \
    -p "${PG_PORT}:5432" postgres:17-alpine >/dev/null
else
  docker inspect -f '{{.State.Status}}' "$PG_CONTAINER" | grep -q running \
    || docker start "$PG_CONTAINER" >/dev/null
fi
for i in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  [ "$i" = 30 ] && fail "PostgreSQL 30 秒内未就绪"
  sleep 1
done
log "  PostgreSQL 就绪"

if [ "$REBUILD_DB" = 1 ]; then
  log "  --rebuild-db：丢弃并重建 ${PG_DB}（仅本地开发库！）"
  docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS ${PG_DB} WITH (FORCE);" \
    -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};" >/dev/null
fi

# ---------------------------------------------------------------- 2. 迁移链
log "2/6 应用迁移链 + 校验（幂等；约 73 个 standalone 迁移）"
export EWOH_DATABASE_URL="$DB_URL_OWNER" EWOH_ALLOW_DDL=1 EWOH_API_DATABASE_PASSWORD
node "$ROOT/db/runner/standalone-chain.js" --apply >/dev/null || fail "迁移链应用失败（详情重跑：standalone-chain.js --apply）"
node "$ROOT/db/runner/run_migrations.js" --apply-standalone-users >/dev/null || fail "users 迁移失败"
node "$ROOT/db/runner/run_migrations.js" --apply-standalone-runtime-role >/dev/null || fail "运行角色迁移失败"
CHAIN_VERIFY="$(node "$ROOT/db/runner/standalone-chain.js" --verify 2>&1 || true)"
echo "$CHAIN_VERIFY" | grep -q "VERIFY FAILED" && { echo "$CHAIN_VERIFY" | grep "VERIFY FAILED"; fail "迁移校验失败"; }
log "  迁移链校验通过（$(echo "$CHAIN_VERIFY" | grep -c 'VERIFY OK') 项）"

# ---------------------------------------------------------------- 3. 种子数据
log "3/6 种子数据（演示租户 / 调度场景 / 角色工作台）"
node "$ROOT/db/runner/run_migrations.js" --seed-standalone >/dev/null || fail "基础种子失败"
EWOH_BOOTSTRAP_ADMIN_USERNAME="$EWOH_BOOTSTRAP_ADMIN_USERNAME" \
EWOH_BOOTSTRAP_ADMIN_PASSWORD="$EWOH_BOOTSTRAP_ADMIN_PASSWORD" \
  node "$ROOT/db/runner/run_migrations.js" --seed-standalone-admin >/dev/null || fail "管理员种子失败"
node "$ROOT/db/runner/run_migrations.js" --seed-standalone-scheduling >/dev/null || fail "调度场景种子失败"
node "$ROOT/db/runner/run_migrations.js" --seed-standalone-workbench-data >/dev/null || fail "工作台种子失败"
node "$ROOT/db/runner/run_migrations.js" --seed-standalone-shift >/dev/null || fail "班次种子失败"
# 物料主数据/库存/需求（standalone_099）：世界模型的一等实体，物料页读面依赖它。
node "$ROOT/db/runner/run_migrations.js" --seed-standalone-material >/dev/null || fail "物料种子失败"
log "  种子完成（重复执行安全：seed 幂等）"

# --reset-scenario：本地开发库的卫生开关（清累积表，见文件头说明）。
if [ "$RESET_SCENARIO" = 1 ]; then
  log "  --reset-scenario：复位场景 + 清理累积表（不可逆；仅本地开发库）"
  EWOH_DATABASE_URL="$DB_URL_OWNER" node "$ROOT/db/runner/reset-scenario-data.js" \
    --org-id "$ORG_ID" --purge-derived --yes \
    || fail "场景复位失败（预览：node db/runner/reset-scenario-data.js --org-id $ORG_ID --purge-derived）"
fi

# ---------------------------------------------------------------- 4. 运营账号
log "4/6 运营账号（B5 审批独立性：生成人 ≠ 审批人；现场工人绑定人员域）"
export EWOH_DATABASE_URL="$DB_URL_OWNER"
op() { # op <username> <display> <roles> <password> [person-id]
  local extra=(); [ -n "${5:-}" ] && extra=(--person-id "$5")
  EWOH_OPERATOR_PASSWORD="$4" node "$ROOT/db/runner/create-operator.js" \
    --username "$1" --display-name "$2" --roles "$3" "${extra[@]}" >/dev/null 2>&1 || true
}
op approver.li    "李审批（车间主任）" "workshop_lead,dispatcher" "$APPROVER_PASSWORD" 63000000-0000-4000-8000-000000000003
op worker.zhangwei "张伟（装配工）"    "worker"                   "$WORKER_PASSWORD"  63000000-0000-4000-8000-000000000001
log "  账号：admin / approver.li / worker.zhangwei（查看：create-operator.js --list）"

# ---------------------------------------------------------------- 5. 构建
if [ "$SKIP_BUILD" = 0 ] && [ "$NO_SERVER" = 0 ]; then
  log "5/6 构建 standalone（server + client）"
  (cd "$APP" && npm run build:prod:standalone >/dev/null 2>&1) || fail "构建失败（重跑：npm run build:prod:standalone）"
else
  log "5/6 跳过构建"
fi

# ---------------------------------------------------------------- 6. 启动
[ "$NO_SERVER" = 1 ] && { log "6/6 不启动服务（--no-server）"; log "完成。"; exit 0; }

log "6/6 启动 standalone 服务（127.0.0.1:${SERVER_PORT}）"
# 匹配相对/绝对两种启动路径的历史实例（standalone-main 以 process.cwd() 解析
# dist/client，因此必须在 ewoh-spark-app 目录内启动，否则 SPA 全部 404）。
pkill -f "dist/server/main.js" 2>/dev/null || true
sleep 1
(
  cd "$APP" || exit 1
  set -a; . ./.env.local-standalone; set +a
  PORT="$SERVER_PORT" NODE_ENV=production nohup node dist/server/main.js \
    > /tmp/ewoh-local-up.log 2>&1 &
)
for i in $(seq 1 20); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SERVER_PORT}/api/auth/login" -X POST -H 'Content-Type: application/json' -d '{}' 2>/dev/null || echo 000)"
  [ "$code" != "000" ] && break
  [ "$i" = 20 ] && { tail -20 /tmp/ewoh-local-up.log; fail "服务 20 秒内未监听"; }
  sleep 1
done

cat <<EOF

============================================================
 EWOH 本地环境已就绪
============================================================
 产品入口   http://127.0.0.1:${SERVER_PORT}
 账号       admin / ${EWOH_BOOTSTRAP_ADMIN_PASSWORD}          （全局管理员）
            approver.li / ${APPROVER_PASSWORD}    （班组长·审批人）
            worker.zhangwei / ${WORKER_PASSWORD}      （现场工人·张伟）
 日志       /tmp/ewoh-local-up.log
 数据库     ${DB_URL_OWNER}

 下一步（闭环验证，见 docs/operations/main-product-closed-loop.md）:
   make demo-closed-loop   # 边缘模拟闭环（无 PG 依赖）
   make e2e-closed-loop    # 云侧真实 PG 闭环（golden + receipt）
 排产变慢? 先看数据规模（快照/事件/任务是退化源）:
   node db/runner/reset-scenario-data.js --org-id ${ORG_ID} --purge-derived   # 预览
   ./scripts/local-up.sh --reset-scenario                                     # 复位+清理
============================================================
EOF
