#!/usr/bin/env bash
# pilot-soak.sh — 常驻试点健康编排（详见 docs/operations/pilot-soak-runbook.md）
#
# 编排可在本机执行的检查（边缘侧冒烟/装配门禁/TCK/静态门禁）；需真实环境
# （PostgreSQL/Docker/真机）的步骤输出 BLOCKED 而非失败。退出码语义：
#   0   = 全部通过
#   2   = 有 BLOCKED（环境缺失，诚实报告）
#   其他 = 存在真实失败
#
# 用法：
#   bash scripts/pilot-soak.sh            # 全量检查
#   bash scripts/pilot-soak.sh --report   # 输出每小时健康摘要（写入 output/pilot-soak/）
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BLOCKED=0
FAILED=0
REPORT=""

section() { printf '\n== %s ==\n' "$1"; }

step() {
  local name="$1"; shift
  local log
  log="$(mktemp -t pilot-soak-step-XXXX)"
  if "$@" >"$log" 2>&1; then
    REPORT+="PASS  $name\n"
    echo "PASS  $name"
  else
    FAILED=$((FAILED + 1))
    REPORT+="FAIL  $name\n"
    echo "FAIL  $name"
    # SCR-033: 失败时打印输出尾部，不再全程丢弃 stdout/stderr。
    echo "---- $name 失败输出尾部 ----"
    tail -n 20 "$log"
    echo "----------------------------"
  fi
  rm -f "$log"
}

blocked() {
  local name="$1" reason="$2"
  BLOCKED=$((BLOCKED + 1))
  REPORT+="BLOCKED  $name  ($reason)\n"
  echo "BLOCKED  $name  ($reason)"
}

section "1. 边缘侧（本机可执行）"
step "edge-unittest 冒烟" python3 -m unittest discover -s src/edge_platform/tests -q
step "仓库级契约测试" env PYTHONPATH=src python3 -m pytest tests/ -q
step "production 装配门禁" env PYTHONPATH=src python3 -m pytest tests/test_production_assembly.py tests/test_bus_contract.py -q
step "连接器 TCK" env PYTHONPATH=src python3 scripts/connector-tck.py
step "AAS TCK" env PYTHONPATH=src python3 scripts/aas-tck.py
step "Rego TCK" env PYTHONPATH=src python3 scripts/rego-tck.py
# SCR-034: 已知 lint 存量债（cpsat/*.py 等）——缺省 WARN 不阻断；
# 设 EWOH_SOAK_RUFF_STRICT=1 收紧为阻断（存量清理完成后应默认开启）。
if ruff check src/edge_platform >/dev/null 2>&1; then
  REPORT+="PASS  edge ruff\n"
  echo "PASS  edge ruff"
elif [ "${EWOH_SOAK_RUFF_STRICT:-0}" = "1" ]; then
  FAILED=$((FAILED + 1))
  REPORT+="FAIL  edge ruff（EWOH_SOAK_RUFF_STRICT=1）\n"
  echo "FAIL  edge ruff（严格模式：lint 失败即阻断）"
  ruff check src/edge_platform 2>/dev/null | tail -n 5 || true
else
  RUFF_N="$(ruff check src/edge_platform 2>/dev/null | grep -c '^src')"
  REPORT+="WARN  edge ruff（存量 $RUFF_N 处，不阻断 soak）\n"
  echo "WARN  edge ruff（存量 $RUFF_N 处，不阻断 soak）"
fi

section "2. 云侧（本机可执行）"
step "openapi 路由零漂移" node scripts/audit-openapi-routes.js --strict
step "truth-feature-status" node scripts/truth-feature-status.js --skip-openapi
step "env 清单门禁" node scripts/audit-env-inventory.js --strict
step "repo-facts" node scripts/audit-repo-facts.js --strict
step "云侧类型检查" bash -c 'cd ewoh-spark-app && npm run type:check'
step "飞书侧车测试" bash -c 'cd ewoh-feishu-app && npm test --silent'
step "飞书静态页 JS 语法" bash -c 'node --check ewoh-feishu-app/public/js/app.js'

section "3. 需真实环境（试点部署后执行，本地如实 BLOCKED）"
if command -v psql >/dev/null 2>&1 && pg_isready >/dev/null 2>&1; then
  step "PG 迁移链 apply+verify" node db/runner/run_migrations.js --apply-standalone
else
  blocked "PG 迁移链 apply+verify" "本机无 PostgreSQL（psql/pg_isready 不存在）"
fi
if docker info >/dev/null 2>&1; then
  step "compose 配置校验" docker compose -f deploy/cloud/docker-compose.standalone.yml config
else
  blocked "compose 配置校验" "Docker daemon 不可达（CLI 存在但 info 失败）"
fi
blocked "真机/仿真源遥测注入（P4）" "需部署环境接入 NY-EXO-A1 或 WireInjector"
blocked "云侧 SSE 双通道（P6）" "需运行中的 standalone + 有效 Bearer"
blocked "飞书卡片闭环（P7）" "需真实飞书 webhook 环境"
blocked "CP-SAT 影子评估（周五演练）" "需部署环境安装 ortools==9.11.4210"

section "4. 摘要"
echo "PASS: $(printf '%b' "$REPORT" | grep -c '^PASS')  FAIL: $FAILED  BLOCKED: $BLOCKED"

if [ "${1:-}" = "--report" ]; then
  OUT_DIR="$REPO_ROOT/output/pilot-soak"
  mkdir -p "$OUT_DIR"
  STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  {
    echo "# pilot-soak hourly report $STAMP"
    printf '%b' "$REPORT"
  } > "$OUT_DIR/report-$STAMP.md"
  echo "report -> $OUT_DIR/report-$STAMP.md"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "PILOT-SOAK: FAILED=${FAILED}"
  exit 1
fi
if [ "$BLOCKED" -ne 0 ]; then
  echo "PILOT-SOAK: BLOCKED=${BLOCKED}（环境缺失，如实报告）"
  exit 2
fi
echo "PILOT-SOAK: OK"
exit 0
