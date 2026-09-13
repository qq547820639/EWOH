#!/usr/bin/env bash
# 主产品闭环 E2E 链（真实后端 + 真实 PG；NO-60a 起入库，之前只是本地临时脚本）。
#
# 为什么入库：这条链是"感知—理解—决策—授权—执行—反馈—学习"最有力的证据来源，
# 之前只存在于本地 /tmp，别人无法复现；本轮把它变成仓库资产（可重复、可 CI 化）。
#
# 用法：
#   EWOH_E2E_OWNER_DATABASE_URL=postgres://… EWOH_E2E_ADMIN_PASS=… \
#   EWOH_E2E_APPROVER_PASS=… EWOH_E2E_FIELD_PASS=… EWOH_E2E_INGEST_KEY=… \
#     bash scripts/e2e-chain.sh
#   （可先用 `set -a && . /tmp/ewoh-e2e-env.sh && set +a` 载入本地凭据）
#
# 语义（三条纪律）：
#   1. `set -o pipefail`：管道会吃掉失败场景的退出码（实测出现过 21 PASS/1 FAIL 仍 exit=0）；
#   2. 每个场景保留**完整日志**（默认 /tmp/e2e-chain-<name>.log，可用 EWOH_E2E_LOG_DIR 覆盖），
#      并打印 三态摘要（PASS/FAIL/SKIP）+ FAIL/SKIP 的具体条目——`tail -3` 排障时什么都看不到；
#   3. 场景退出码：0=全过、1=有 FAIL、2=有 SKIP（未验证 ≠ 通过，也 ≠ 失败）。含 SKIP 只记一笔，
#      不判失败，但链的汇总会显式列出，避免"看起来全绿"。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/ewoh-spark-app"
BACKEND_URL="${EWOH_E2E_BACKEND_URL:-http://127.0.0.1:3100}"
ORG_ID="${EWOH_E2E_INGEST_ORG_ID:-00000000-0000-4000-8000-000000000001}"
LOG_DIR="${EWOH_E2E_LOG_DIR:-/tmp/e2e-chain}"
mkdir -p "$LOG_DIR"

FAILED=0
SKIPPED=0
declare -a FAILED_SCENARIOS=()
declare -a SKIPPED_SCENARIOS=()

reset_scenario_data() {
  if [ -z "${EWOH_E2E_OWNER_DATABASE_URL:-}" ]; then
    return 0
  fi
  (cd "$ROOT" && EWOH_DATABASE_URL="$EWOH_E2E_OWNER_DATABASE_URL" \
    node db/runner/reset-scenario-data.js --org-id "$ORG_ID" --yes >/dev/null 2>&1)
}

scenario() {
  local name="$1"; shift
  local reset="$1"; shift
  [ "$reset" = "1" ] && reset_scenario_data
  echo "=== $name ==="
  ( cd "$APP" && EWOH_E2E_BACKEND_URL="$BACKEND_URL" npm run "$name" ) >"$LOG_DIR/$name.log" 2>&1
  local code=$?
  grep -E "PASS / [0-9]+ FAIL" "$LOG_DIR/$name.log" | tail -1
  grep -E "^(FAILED|SKIPPED)" "$LOG_DIR/$name.log" | head -6
  if [ $code -eq 1 ]; then
    echo "  [chain] $name FAIL（exit=1，完整日志 $LOG_DIR/$name.log）"
    FAILED=$((FAILED+1)); FAILED_SCENARIOS+=("$name")
  elif [ $code -eq 2 ]; then
    echo "  [chain] $name 含 SKIP（exit=2，完整日志 $LOG_DIR/$name.log）"
    SKIPPED=$((SKIPPED+1)); SKIPPED_SCENARIOS+=("$name")
  elif [ $code -ne 0 ]; then
    echo "  [chain] $name 异常退出 exit=$code（完整日志 $LOG_DIR/$name.log）"
    FAILED=$((FAILED+1)); FAILED_SCENARIOS+=("$name")
  fi
}

# 顺序敏感：golden 需要干净库；后续场景多数可复用当前数据（0=不重置，1=重置）
scenario e2e:golden 1
scenario e2e:receipt 1
scenario e2e:wave 1
scenario e2e:learning 0
scenario e2e:capability-explain 1
scenario e2e:approval-expiry 0
scenario e2e:observation-reasoning 0
scenario e2e:master-data 0
scenario e2e:materials 0
scenario e2e:exo-session 0
scenario e2e:data-quality 0
scenario e2e:learning-signal 0
scenario e2e:improvement-action 0
# AGV 搬运：审批腿需要相对干净的世界（60s 设备新鲜度 vs 数分钟求解），故 reset=1
scenario e2e:agv-transport 1
scenario e2e:control-actuator 0
scenario e2e:plan-staleness 0
scenario e2e:perception-fusion 0
scenario e2e:edge 0

echo ""
echo "[chain] 失败场景数：${FAILED} / 含 SKIP 场景数：${SKIPPED}（失败必须为 0；SKIP 表示有未验证项，需人工确认）"
if [ ${#FAILED_SCENARIOS[@]} -gt 0 ]; then
  echo "[chain] FAIL：${FAILED_SCENARIOS[*]}"
fi
if [ ${#SKIPPED_SCENARIOS[@]} -gt 0 ]; then
  echo "[chain] SKIP：${SKIPPED_SCENARIOS[*]}"
fi
exit $((FAILED > 0 ? 1 : 0))
