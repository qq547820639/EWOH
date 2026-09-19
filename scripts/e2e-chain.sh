#!/usr/bin/env bash
# 主产品闭环 E2E 链（真实后端 + 真实 PG；NO-60a 起入库，之前只是本地临时脚本）。
#
# 为什么入库：这条链是"感知—理解—决策—授权—执行—反馈—学习"最有力的证据来源，
# 之前只存在于本地 /tmp，别人无法复现；本轮把它变成仓库资产（可重复、可 CI 化）。
#
# 用法：
#   EWOH_E2E_OWNER_DATABASE_URL=postgres://… EWOH_E2E_ADMIN_PASS=… \
#   EWOH_E2E_APPROVER_PASS=… EWOH_E2E_OPERATOR_PASS=… EWOH_E2E_FIELD_PASS=… \
#   EWOH_E2E_INGEST_KEY=… EWOH_CONTROL_FINGERPRINT_SECRET=… \
#     bash scripts/e2e-chain.sh
#   （可先用 `set -a && . /tmp/ewoh-e2e-env.sh && set +a` 载入本地凭据）
#
# 凭据纪律（实测教训 2026-09-19）：
#   - EWOH_E2E_OPERATOR_PASS 与 EWOH_E2E_APPROVER_PASS 都要给：preflight 校验
#     OPERATOR（审批派工角色），部分场景读 APPROVER——缺一会被误判 LOGIN_FAILED；
#   - EWOH_CONTROL_FINGERPRINT_SECRET 必须与被测后端一致：edge_control_agent
#     用它本地验签授权范围指纹——不一致时产品按 fail-closed 拒绝投递
#     （control-actuator 步骤 8/9 全红，产品行为正确，是运行环境配错）；
#   - 可选增强：EWOH_E2E_PG_URL（receipt 步骤 14-16 DB 事实断言）、
#     EWOH_E2E_PERSON_ID（edge 5f/5j 与 exo-session 佩戴者点名）——
#     **必须是已绑定登录账号的人员**（本地默认 …0001 ↔ worker.zhangwei；
#     无账号人员会导致"点名到本人"类断言失败，产品行为正确：叫不到人要显式报缺口）。
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

# ── 链前预检 2（NO-73b）：E2E 凭证**角色矩阵**自检 ─────────────────────────────
# 教训（第 73 轮）：把 OPERATOR 误配成 worker 角色 → 方案审批 403 → 回执闭环整条 SKIP，
# 排障花了很久才发现是凭证配错而不是产品缺陷。三个凭证不能混用：
#   admin=生成/代批；OPERATOR=审批派工（workshop_lead/dispatcher）；FIELD=现场回执（worker）。
# 这里在跑任何场景前先登录核对角色，配错就**立即失败**（带修正指引），不再浪费一整条链。
preflight_credentials() {
  local base="${EWOH_E2E_BACKEND_URL:-http://127.0.0.1:3100}"
  local admin_user="${EWOH_E2E_ADMIN_USER:-admin}"
  local admin_pass="${EWOH_E2E_ADMIN_PASS:-}"
  local op_user="${EWOH_E2E_OPERATOR_USER:-approver.li}"
  local op_pass="${EWOH_E2E_OPERATOR_PASS:-}"
  local field_user="${EWOH_E2E_FIELD_USER:-worker.zhangwei}"
  local field_pass="${EWOH_E2E_FIELD_PASS:-}"
  local ok=1

  role_of() {
    local token
    token=$(curl -s -X POST "$base/api/auth/login" -H 'Content-Type: application/json' \
      -d "{\"username\":\"$1\",\"password\":\"$2\"}" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).accessToken||'')}catch{console.log('')}})")
    [ -z "$token" ] && { echo "LOGIN_FAILED"; return; }
    curl -s "$base/api/auth/me" -H "Authorization: Bearer $token" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log((r.roles||r.user&&r.user.roles||[]).join(','))}catch{console.log('')}})"
  }

  local admin_roles op_roles field_roles
  admin_roles=$(role_of "$admin_user" "$admin_pass")
  op_roles=$(role_of "$op_user" "$op_pass")
  field_roles=$(role_of "$field_user" "$field_pass")

  echo "=== preflight: E2E credential roles ==="
  echo "  $admin_user: $admin_roles"
  echo "  $op_user: $op_roles"
  echo "  $field_user: $field_roles"

  case ",$admin_roles," in *,global_admin,*) ;; *) echo "  [preflight] FAIL: $admin_user 缺 global_admin（admin 凭证配错？）"; ok=0;; esac
  case ",$op_roles," in *,workshop_lead,*|*,dispatcher,*) ;; *) echo "  [preflight] FAIL: $op_user 无审批角色（workshop_lead/dispatcher）——方案审批会 403。OPERATOR 凭证应为 approver.li，现场工人走 FIELD_*"; ok=0;; esac
  case ",$field_roles," in *,worker,*) ;; *) echo "  [preflight] FAIL: $field_user 缺 worker 角色（FIELD 凭证配错？）"; ok=0;; esac

  if [ $ok -ne 1 ]; then
    echo "  [preflight] 凭证角色矩阵不满足——修正 /tmp/ewoh-e2e-env.sh 后重跑（模板见 runbook『E2E 凭证的角色分工』）"
    exit 1
  fi
  echo "  [preflight] OK"
}
preflight_credentials

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
# 仿真对抗链（虚拟外骨骼机群 + 设备物理孪生）：自建设备/实体/会话，reset=1 保干净世界
scenario e2e:exo-simfarm 1
scenario e2e:device-physics 1
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
