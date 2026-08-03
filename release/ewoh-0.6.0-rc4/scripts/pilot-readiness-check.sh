#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

passed=0
failed=0
pending=0
blockers=()

record() {
  local name="$1"
  local status="$2"
  local detail="$3"
  case "$status" in
    PASS) passed=$((passed + 1)) ;;
    FAIL) failed=$((failed + 1)); blockers+=("$name: $detail") ;;
    PENDING) pending=$((pending + 1)); blockers+=("$name: $detail") ;;
  esac
  printf '%-28s %-8s %s\n' "$name" "$status" "$detail"
}

file_present() {
  local name="$1"
  local file="$2"
  if [[ -s "$file" ]]; then
    record "$name" PASS "$file"
  else
    record "$name" FAIL "missing or empty: $file"
  fi
}

command_present() {
  local name="$1"
  local command="$2"
  if command -v "$command" >/dev/null 2>&1; then
    record "$name" PASS "$command available"
  else
    record "$name" FAIL "$command not available on this machine"
  fi
}

echo "== EWOH Pilot Readiness Check =="
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

file_present "release checksums" "release/ewoh-0.6.0-rc4/SHA256SUMS.txt"
file_present "acceptance evidence" "docs/delivery/acceptance-evidence.md"
file_present "training plan" "docs/delivery/training-plan.md"
file_present "deployment runbook" "docs/delivery/deployment-runbook.md"
file_present "release manifest" "docs/delivery/release-manifest.yaml"

command_present "docker" docker
command_present "kubectl" kubectl
command_present "helm" helm

if [[ -n "${EWOH_DATABASE_URL:-}" ]]; then
  if EWOH_DATABASE_URL="$EWOH_DATABASE_URL" node db/runner/run_migrations.js --verify-standalone >/tmp/ewoh-pilot-db-verify.log 2>&1; then
    record "database verify" PASS "standalone verify OK"
  else
    record "database verify" FAIL "standalone verify failed (see /tmp/ewoh-pilot-db-verify.log)"
  fi
else
  record "database verify" PENDING "EWOH_DATABASE_URL not set"
fi

if [[ -n "${EWOH_RUNTIME_DATABASE_URL:-}" ]]; then
  if node --input-type=module -e "
    import postgres from './ewoh-spark-app/node_modules/postgres/src/index.js';
    const sql = postgres(process.env.EWOH_RUNTIME_DATABASE_URL, { max: 1, connect_timeout: 5 });
    await sql\`select 1 as ok\`;
    await sql.end();
  " >/dev/null 2>&1; then
    record "runtime database" PASS "runtime role connect OK"
  else
    record "runtime database" FAIL "runtime connection failed"
  fi
else
  record "runtime database" PENDING "EWOH_RUNTIME_DATABASE_URL not set"
fi

if [[ -n "${EWOH_PILOT_FACTORY_NAME:-}" ]]; then
  record "pilot factory" PASS "$EWOH_PILOT_FACTORY_NAME"
else
  record "pilot factory" PENDING "EWOH_PILOT_FACTORY_NAME not set"
fi

if [[ "${EWOH_PRODUCTION_APPROVAL:-}" == "approved" ]]; then
  record "production approval" PASS "approved"
else
  record "production approval" PENDING "EWOH_PRODUCTION_APPROVAL != approved"
fi

if [[ "${EWOH_TRAINING_COMPLETED:-}" == "true" ]]; then
  record "training completed" PASS "true"
else
  record "training completed" PENDING "EWOH_TRAINING_COMPLETED != true"
fi

if [[ "${EWOH_ACCEPTANCE_SIGNOFF:-}" == "signed" ]]; then
  record "acceptance signoff" PASS "signed"
else
  record "acceptance signoff" PENDING "EWOH_ACCEPTANCE_SIGNOFF != signed"
fi

if [[ -n "${EWOH_REAL_DEVICE_CONFIG:-}" && -s "${EWOH_REAL_DEVICE_CONFIG:-}" ]]; then
  record "real device config" PASS "$EWOH_REAL_DEVICE_CONFIG"
else
  record "real device config" PENDING "EWOH_REAL_DEVICE_CONFIG not provided"
fi

echo ""
echo "Result: passed=$passed failed=$failed pending=$pending"
if (( failed > 0 || pending > 0 )); then
  echo ""
  echo "Go/No-Go blockers:"
  printf '  - %s\n' "${blockers[@]}"
  echo ""
  echo "PILOT READINESS: NOT READY"
  exit 1
fi
echo "PILOT READINESS: READY"
