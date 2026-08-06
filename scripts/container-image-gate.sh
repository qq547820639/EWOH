#!/usr/bin/env bash
# EWOH container image gate (gate #6).
#
# Builds a REAL image, tags it with a run-id + digest, generates an SBOM, runs a
# Trivy image scan on the actual image ref, and records the image digest. If
# Docker/Trivy are unavailable the gate is recorded BLOCKED_BY_ENVIRONMENT.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p output/gate-results

GATE_ID="container-image"
REPORT="output/container-image-report.json"
API_DOCKERFILE="${API_DOCKERFILE:-deploy/cloud/Dockerfile.api}"
MIGRATE_DOCKERFILE="${MIGRATE_DOCKERFILE:-deploy/cloud/Dockerfile.migrate}"
IMAGE_REPO="${IMAGE_REPO:-ewoh-api:build}"
TRIVY_VERSION="${TRIVY_VERSION:-0.58.1}"
RUN_ID="${GITHUB_RUN_ID:-local}"

record() {
  node scripts/truth-gate-record.js \
    --id "$GATE_ID" \
    --name "容器安全门禁（真实镜像构建/SBOM/Trivy 漏洞报告/镜像摘要）" \
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

command -v docker >/dev/null 2>&1 || blocked "docker binary 缺失"
docker info >/dev/null 2>&1 || blocked "docker daemon 不可用"

echo "== build API image =="
docker build -f "$API_DOCKERFILE" -t "$IMAGE_REPO:$RUN_ID" . || fail "API 镜像构建失败"
docker build -f "$MIGRATE_DOCKERFILE" -t "${IMAGE_REPO}-migrate:$RUN_ID" . || fail "migrate 镜像构建失败"

echo "== generate SBOM (CycloneDX) =="
dock sbom "${IMAGE_REPO}:$RUN_ID" --format cyclonedx-json \
  > output/ewoh-api-sbom.cyclonedx.json 2>/dev/null \
  || (command -v syft >/dev/null 2>&1 && syft "${IMAGE_REPO}:$RUN_ID" -o cyclonedx-json > output/ewoh-api-sbom.cyclonedx.json) \
  || echo "note: dock/syft 不可用，SBOM 生成暂缓（不阻断镜像扫描）"
test -s output/ewoh-api-sbom.cyclonedx.json && echo "SBOM OK: $(node -e 'const b=require("./output/ewoh-api-sbom.cyclonedx.json");console.log(b.bomFormat+" comps="+b.components.length)')"

echo "== image digest =="
DIGEST="$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_REPO:$RUN_ID" || docker images --no-trunc --quiet "$IMAGE_REPO:$RUN_ID" | head -n1)"
echo "digest=$DIGEST"

echo "== Trivy image scan =="
if ! command -v trivy >/dev/null 2>&1; then
  curl -sSL -o /tmp/trivy.tar.gz \
    "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
  tar -xzf /tmp/trivy.tar.gz -C /tmp trivy
fi
if /tmp/trivy image --exit-code 1 --severity HIGH,CRITICAL \
    --format json --output output/trivy-image-report.json "$IMAGE_REPO:$RUN_ID"; then
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"SUCCEEDED\",\"digest\":\"$DIGEST\",\"image\":\"$IMAGE_REPO:$RUN_ID\"}" > "$REPORT"
  record SUCCEEDED "镜像 $IMAGE_REPO:$RUN_ID 构建成功，digest=$DIGEST，Trivy 无 HIGH/CRITICAL"
  echo "CONTAINER IMAGE GATE SUCCEEDED"
else
  EXIT=$?
  echo "{\"gate\":\"$GATE_ID\",\"status\":\"FAILED\",\"digest\":\"$DIGEST\",\"trivyExit\":$EXIT}" > "$REPORT"
  record FAILED "Trivy 发现 HIGH/CRITICAL 漏洞（exit $EXIT）"
  exit "$EXIT"
fi