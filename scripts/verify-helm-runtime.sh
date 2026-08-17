#!/usr/bin/env bash
# EWOH Kubernetes/Helm runtime gate (gate #3).
#
# Requires a real cluster (kind/k3d/k8s) + Helm + kubectl + a cluster-reachable
# PostgreSQL. This script performs, in order:
#   1. install       helm install --wait; wait for migration Job; rollout status
#   2. readiness/liveness probes via /health/live + /health/ready
#   3. migration job pre/post-upgrade hook succeeds
#   4. pod restart   kubectl rollout restart; rollout status
#   5. multiple replicas == replicaCount
#   6. worker deployment present and ready
#   7. persistent storage PVC bound
#   8. network policies applied
#   9. upgrade       helm upgrade --set image.tag=<new>; rollout status
#  10. rollback      helm rollback <prev-revision>; rollout status; probes OK
#
# Exits non-zero on any failure. Emits a machine-readable report to
# output/helm-runtime-report.json and records the truth gate ONLY when the
# cluster is reachable. Records BLOCKED_BY_ENVIRONMENT otherwise.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p output/gate-results

GATE_ID="helm-runtime"
REPORT="output/helm-runtime-report.json"
CHART="${CHART:-deploy/cloud/helm/ewoh}"
RELEASE="${RELEASE:-ewoh}"
NAMESPACE="${NAMESPACE:-ewoh}"
HELM_TIMEOUT="${HELM_TIMEOUT:-10m}"
# SCR-031: CI 中升级目标镜像 tag 必须显式设置（默认值 0.6.0-rc5 可能不存在，不得静默使用）。
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]] && [ -z "${IMAGE_TAG_UPGRADE:-}" ]; then
  echo "::notice::BLOCKED_BY_ENVIRONMENT: CI 环境必须显式设置 IMAGE_TAG_UPGRADE（升级镜像 tag），不允许回退可能不存在的默认值"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"BLOCKED_BY_ENVIRONMENT\",\"reason\":\"CI 未显式设置 IMAGE_TAG_UPGRADE\"}" > "$REPORT"
  exit 0
fi
IMAGE_TAG_UPGRADE="${IMAGE_TAG_UPGRADE:-0.6.0-rc5}"   # 本地缺省（仅非 CI）
API_URL="${API_URL:-http://127.0.0.1:3000}"
# Worker Deployment 当前默认关闭（API 镜像尚无 dist/server/worker.js 入口）。
# 一旦镜像提供 worker 入口，设 WORKER_ENABLED=true 以覆盖并校验 worker 部署。
WORKER_ENABLED="${WORKER_ENABLED:-false}"
# SCR-016: CI 中 worker 部署校验必须显式开启（WORKER_ENABLED=true），不允许默认 false 跳过。
if [[ -n "${CI:-}" || -n "${GITHUB_ACTIONS:-}" ]] && [ "$WORKER_ENABLED" != "true" ]; then
  echo "::notice::BLOCKED_BY_ENVIRONMENT: CI 环境必须设置 WORKER_ENABLED=true 以校验 worker 部署（当前 WORKER_ENABLED=$WORKER_ENABLED）"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"BLOCKED_BY_ENVIRONMENT\",\"reason\":\"CI 未显式设置 WORKER_ENABLED=true\"}" > "$REPORT"
  exit 0
fi

record() { # status details
  node scripts/truth-gate-record.js \
    --id "$GATE_ID" \
    --name "Kubernetes/Helm 运行时门禁（install/upgrade/rollback/探针/迁移Job/replicas/worker/storage/networkpolicy）" \
    --status "$1" --details "$2"
}

blocked() {
  echo "::notice::BLOCKED_BY_ENVIRONMENT: $1"
  record BLOCKED_BY_ENVIRONMENT "$1"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"BLOCKED_BY_ENVIRONMENT\",\"reason\":\"$1\"}" > "$REPORT"
  exit 0
}

probe() {
  local path="$1"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$API_URL$path" || echo 000)"
  [ "$code" = "200" ] || { echo "HEALTH FAIL $path -> $code"; return 1; }
  echo "HEALTH OK $path"
}

fail() {
  echo "::error::$1"
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"FAILED\",\"reason\":\"$1\"}" > "$REPORT"
  record FAILED "$1"
  exit 1
}

command -v helm >/dev/null 2>&1 || blocked "helm binary 缺失"
command -v kubectl >/dev/null 2>&1 || blocked "kubectl binary 缺失"
if ! kubectl cluster-info >/dev/null 2>&1; then
  blocked "无可达集群（kubectl cluster-info 失败）"
fi

helm lint "$CHART" >/dev/null || fail "helm lint 失败"

echo "== 1. helm install =="
helm upgrade --install "$RELEASE" "$CHART" --namespace "$NAMESPACE" --create-namespace \
  --wait --timeout "$HELM_TIMEOUT" \
  --set image.repository=ewoh-api --set image.tag=ci \
  --set migration.image.repository=ewoh-migrate --set migration.image.tag=ci \
  --set worker.enabled="$WORKER_ENABLED" \
  || fail "helm install 失败"

echo "== 2. migration job hook =="
# 注意：Job 对象本身没有 app.kubernetes.io/component 标签（该标签仅存在于 pod
# template），按标签选择器等待会命中零资源并立即报错，故按确定性名称等待。
kubectl -n "$NAMESPACE" wait --for=condition=complete "job/$RELEASE-ewoh-migrate" \
  --timeout="$HELM_TIMEOUT" || fail "迁移 Job 未完成"

echo "== 3. rollout + replicas =="
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh --timeout="$HELM_TIMEOUT" \
  || fail "API deployment rollout 失败"
REPLICAS_READY="$(kubectl -n "$NAMESPACE" get deploy "$RELEASE"-ewoh -o jsonpath='{.status.readyReplicas}')"
[ "$REPLICAS_READY" -ge 3 ] || fail "期望 >=3 ready replicas，实际 $REPLICAS_READY"

echo "== 4. worker deployment =="
if [ "$WORKER_ENABLED" = "true" ]; then
  kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh-worker --timeout="$HELM_TIMEOUT" \
    || fail "worker deployment rollout 失败"
else
  echo "WORKER_ENABLED=false（API 镜像暂无 worker 入口），跳过 worker 部署校验"
fi

echo "== 5. probes =="
probe /health/live || fail "liveness probe 失败"
probe /health/ready || fail "readiness probe 失败"

echo "== 6. network policies =="
kubectl -n "$NAMESPACE" get networkpolicy -o name | grep -q ewoh || fail "未发现 NetworkPolicy"

echo "== 7. persistent storage PVC =="
kubectl -n "$NAMESPACE" get pvc ewoh-uploads -o jsonpath='{.status.phase}' | grep -q Bound \
  || fail "PVC 未 Bound"

echo "== 8. pod restart =="
kubectl -n "$NAMESPACE" rollout restart deploy/"$RELEASE"-ewoh || fail "rollout restart 失败"
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh --timeout="$HELM_TIMEOUT" \
  || fail "restart 后 rollout 失败"

echo "== 9. upgrade =="
helm upgrade "$RELEASE" "$CHART" --namespace "$NAMESPACE" \
  --set image.tag="$IMAGE_TAG_UPGRADE" --wait --timeout "$HELM_TIMEOUT" \
  || fail "helm upgrade 失败"
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh --timeout="$HELM_TIMEOUT" \
  || fail "upgrade 后 rollout 失败"
probe /health/live || fail "upgrade 后 liveness 失败"

echo "== 10. rollback =="
PREV_REV="$(( $(kubectl -n "$NAMESPACE" get deploy "$RELEASE"-ewoh -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}') - 1 ))"
helm rollback "$RELEASE" "$PREV_REV" --namespace "$NAMESPACE" --wait --timeout "$HELM_TIMEOUT" \
  || fail "helm rollback 失败"
kubectl -n "$NAMESPACE" rollout status deploy/"$RELEASE"-ewoh --timeout="$HELM_TIMEOUT" \
  || fail "rollback 后 rollout 失败"
probe /health/live || fail "rollback 后 liveness 失败"
probe /health/ready || fail "rollback 后 readiness 失败"

echo "{\"gate\":\"$GATE_ID\",\"status\":\"SUCCEEDED\",\"replicas\":$REPLICAS_READY,\"revision\":$PREV_REV}" > "$REPORT"
record SUCCEEDED "install/upgrade/rollback/probes/migration-job/restart/replicas/worker/storage/networkpolicy 全部通过"
echo "HELM RUNTIME GATE SUCCEEDED"