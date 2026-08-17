#!/usr/bin/env bash
# EWOH canary upgrade gate (gate #4).
#
# Requires a running cluster (G3 helm runtime as prerequisite) + reachable API.
# Steps:
#   1. baseline health metrics captured (error rate, latency p95, /health/ready)
#   2. deploy canary ring (factory.upgradeRing=canary) / or a broken image ref
#   3. poll canary health metrics against configured failure thresholds
#   4. automatic rollback when thresholds are breached; verify rollback API
#   5. post-rollback business-state verification (org-scoped reads + export task
#      state machine still consistent)
#
# Never fabricates a PASS: if the cluster/API is unavailable the gate is recorded
# BLOCKED_BY_ENVIRONMENT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p output/gate-results

GATE_ID="canary-upgrade"
REPORT="output/canary-report.json"
RELEASE="${RELEASE:-ewoh}"
CHART="${CHART:-deploy/cloud/helm/ewoh}"
NAMESPACE="${NAMESPACE:-ewoh}"
API_URL="${API_URL:-http://127.0.0.1:3000}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"

# Failure thresholds (tunable via env).
CANARY_POLLS="${CANARY_POLLS:-30}"          # how many polls before deciding
CANARY_POLL_INTERVAL="${CANARY_POLL_INTERVAL:-10}"  # seconds
MAX_ERROR_RATE="${MAX_ERROR_RATE:-0.05}"    # 5% error rate allowed
MAX_P95_MS="${MAX_P95_MS:-2000}"            # p95 latency budget
BAD_IMAGE_TAG="${BAD_IMAGE_TAG:-ewoh-broken-canary}"  # image tag that will fail
CANARY_TEST_ORG="${CANARY_TEST_ORG:-orgA}"    # SCR-040: 业务态校验用的 org，从 env 读取

record() {
  node scripts/truth-gate-record.js \
    --id "$GATE_ID" \
    --name "Canary 升级门禁（健康指标/失败阈值/自动回滚/回滚后业务校验）" \
    --status "$1" --details "$2"
}

blocked() {
  echo "::notice::BLOCKED_BY_ENVIRONMENT: $1"
  record BLOCKED_BY_ENVIRONMENT "$1"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"BLOCKED_BY_ENVIRONMENT\",\"reason\":\"$1\"}" > "$REPORT"
  exit 0
}

fail() {
  echo "::error::$1"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"FAILED\",\"reason\":\"$1\"}" > "$REPORT"
  record FAILED "$1"
  exit 1
}

# health_metrics -> "error_rate p95_ms ready": from /metrics (Prometheus)
# Fall back to a simple readiness probe when /metrics is not exposed.
health_metrics() {
  local metrics
  if metrics="$(curl -sf "$API_URL/metrics" 2>/dev/null)"; then
    local err p95
    err="$(echo "$metrics" | awk '/^ewoh_http_errors_total/{e+=$2} /^ewoh_http_requests_total/{t+=$2} END{if(t>0)print e/t; else print 0}')"
    p95="$(echo "$metrics" | awk '/^ewoh_http_duration_ms_bucket{quantile="0.95"}/{print $2}')"
    echo "${err:-0} ${p95:-0} 1"
  else
    # R2-SCR-004：poll 期间 /metrics 掉线（坏镜像的典型症状：服务半死不暴露
    # metrics 而 /health/ready 仍 200）不得回退探针把 err/p95 置 0——那会让
    # 错误率/p95 阈值静默失效、回滚判定退化为纯 readiness。对齐 SCR-014 的
    # baseline 语义：阈值无法评估≠通过——err=1 显式制造阈值违例触发回滚判定，
    # ready 位仍如实反映探针结果。
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/health/ready" || echo 000)"
    if [ "$code" = "200" ]; then echo "1 0 1"; else echo "1 0 0"; fi
  fi
}

command -v helm >/dev/null 2>&1 || blocked "helm binary 缺失"
command -v kubectl >/dev/null 2>&1 || blocked "kubectl binary 缺失"
kubectl cluster-info >/dev/null 2>&1 || blocked "无可达集群"

echo "== baseline health =="
# SCR-014: 无 /metrics 时 error-rate/p95 阈值无法评估，不允许以回退探针冒充通过——记 BLOCKED。
curl -sf "$API_URL/metrics" >/dev/null 2>&1 \
  || blocked "/metrics 不可用（$API_URL/metrics）：错误率与 p95 阈值无法评估，canary 门禁不能给出可信结论"
BASE="$(health_metrics)"
echo "baseline: $BASE"

echo "== deploy canary ring (broken image to force rollback) =="
helm upgrade "$RELEASE" "$CHART" --namespace "$NAMESPACE" \
  --set image.tag="$BAD_IMAGE_TAG" \
  --set factory.upgradeRing=canary \
  --timeout "$HELM_TIMEOUT" || echo "(canary upgrade 失败为预期，进入门禁判定)"

echo "== poll canary metrics vs thresholds =="
ROLLED_BACK=0
for i in $(seq 1 "$CANARY_POLLS"); do
  read -r err p95 ready <<< "$(health_metrics)"
  # auto-rollback decision
  if [ "$ready" != "1" ] || awk -v e="$err" -v m="$MAX_ERROR_RATE" 'BEGIN{exit !(e>m)}' || awk -v p="$p95" -v m="$MAX_P95_MS" 'BEGIN{exit !(p>m && p>0)}'; then
    echo "phenomenon: error_rate=$err p95=${p95}ms ready=$ready -> triggering rollback (poll $i)"
    # SCR-015: 回滚目标 revision 动态解析（当前最大 revision 的上一个），不再硬编码 1。
    PREV_REV="$(helm history "$RELEASE" --namespace "$NAMESPACE" -o json | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        const hist = JSON.parse(s).map((h) => ({ ...h, revision: Number(h.revision) }));
        const cur = Math.max(...hist.map((h) => h.revision));
        const prev = Math.max(...hist.filter((h) => h.revision < cur).map((h) => h.revision));
        if (!Number.isFinite(prev)) { console.error("no previous helm revision to rollback to"); process.exit(1); }
        console.log(prev);
      });
    ')" || fail "无法从 helm history 解析回滚目标 revision"
    echo "rollback target revision: $PREV_REV"
    helm rollback "$RELEASE" "$PREV_REV" --namespace "$NAMESPACE" --wait --timeout "$HELM_TIMEOUT" \
      || fail "自动回滚命令失败"
    ROLLED_BACK=1
    break
  fi
  echo "poll $i ok: error_rate=$err p95=${p95}ms ready=$ready"
  sleep "$CANARY_POLL_INTERVAL"
done

[ "$ROLLED_BACK" = "1" ] || fail "canary 未触发自动回滚（阈值内持续健康，无法验证失败回滚路径）"

echo "== post-rollback business-state verification =="
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh --timeout="$HELM_TIMEOUT" || fail "回滚后 rollout 失败"
read -r err p95 ready <<< "$(health_metrics)"
[ "$ready" = "1" ] || fail "回滚后 /health/ready 未恢复"
# business-state: org-scoped export task read + a valid org-scoped query
curl -sf "$API_URL/health/ready" >/dev/null || fail "回滚后 API 不可达"
# SCR-007: 业务态校验不得退化为纯可达性检查——export-tasks org 域读取必须返回 2xx。
BUSINESS_HTTP="$(curl -s -o /dev/null -w '%{http_code}' -H "X-Org-Id: $CANARY_TEST_ORG" "$API_URL/api/workbench/export-tasks?limit=1" || echo 000)"
case "$BUSINESS_HTTP" in
  2*) echo "business-state OK: export-tasks org=$CANARY_TEST_ORG http=$BUSINESS_HTTP" ;;
  404|405) blocked "回滚后业务态校验被阻断：export-tasks 端点未部署（http=$BUSINESS_HTTP），不能宣称业务态通过" ;;
  *) fail "回滚后业务态校验失败：export-tasks org=$CANARY_TEST_ORG http=$BUSINESS_HTTP" ;;
esac

echo "{\"gate\":\"$GATE_ID\",\"status\":\"SUCCEEDED\",\"baseline\":\"$BASE\",\"autoRolledBack\":true}" > "$REPORT"
record SUCCEEDED "canary 失败被捕获并自动回滚；回滚后探针与业务态校验通过"
echo "CANARY GATE SUCCEEDED"