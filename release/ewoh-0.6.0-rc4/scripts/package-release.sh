#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${EWOH_RELEASE_VERSION:-0.6.0-rc1}"
OUT="${ROOT_DIR}/release/ewoh-${VERSION}"

if ! command -v rsync >/dev/null 2>&1; then
  echo "rsync is required to build the release bundle" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

echo "== copy application source =="
rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'test-results' \
  --exclude 'logs' \
  --exclude '.git' \
  --exclude '.spark' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude 'demo.db*' \
  "${ROOT_DIR}/ewoh-spark-app/" "${OUT}/ewoh-spark-app/"

echo "== copy runtime, db, deploy, contracts, evidence =="
mkdir -p \
  "${OUT}/db" \
  "${OUT}/deploy" \
  "${OUT}/scripts" \
  "${OUT}/openapi" \
  "${OUT}/security" \
  "${OUT}/docs" \
  "${OUT}/delivery"

rsync -a "${ROOT_DIR}/db/" "${OUT}/db/"
rsync -a "${ROOT_DIR}/deploy/" "${OUT}/deploy/"
rsync -a "${ROOT_DIR}/scripts/" "${OUT}/scripts/"
rsync -a "${ROOT_DIR}/openapi/" "${OUT}/openapi/"
rsync -a "${ROOT_DIR}/security/" "${OUT}/security/"
rsync -a "${ROOT_DIR}/docs/" "${OUT}/docs/"
rsync -a "${ROOT_DIR}/delivery/" "${OUT}/delivery/"
rsync -a "${ROOT_DIR}/src/" "${OUT}/src/"
rsync -a "${ROOT_DIR}/tests/" "${OUT}/tests/"
rsync -a "${ROOT_DIR}/ui/" "${OUT}/ui/"
rsync -a "${ROOT_DIR}/contracts/" "${OUT}/contracts/"
rsync -a "${ROOT_DIR}/tools/" "${OUT}/tools/"
rsync -a "${ROOT_DIR}/catalog/" "${OUT}/catalog/"
rsync -a "${ROOT_DIR}/.codex/artifacts/" "${OUT}/.codex/artifacts/"
rsync -a "${ROOT_DIR}/output/" "${OUT}/output/"
rsync -a "${ROOT_DIR}/.github/workflows/" "${OUT}/.github/workflows/"

cp "${ROOT_DIR}/README.md" "${OUT}/README.md" 2>/dev/null || true
cp "${ROOT_DIR}/CHANGELOG.md" "${OUT}/CHANGELOG.md" 2>/dev/null || true
cp "${ROOT_DIR}/SECURITY.md" "${OUT}/SECURITY.md" 2>/dev/null || true
cp "${ROOT_DIR}/Makefile" "${OUT}/Makefile" 2>/dev/null || true
cp "${ROOT_DIR}/pyproject.toml" "${OUT}/pyproject.toml" 2>/dev/null || true
cp "${ROOT_DIR}/requirements-dev.txt" "${OUT}/requirements-dev.txt" 2>/dev/null || true
cp "${ROOT_DIR}/run.py" "${OUT}/run.py" 2>/dev/null || true

echo "== guard: no real environment files may ship =="
if find "$OUT" -type f \( -name '.env' -o -name '.env.local' \) | grep -q .; then
  echo "ERROR: real .env/.env.local found in release bundle" >&2
  exit 1
fi

cat > "${OUT}/RELEASE-README.md" <<EOF
# EWOH ${VERSION} Release Bundle

This bundle contains the standalone EWOH product source, database migrations,
deployment artifacts, contracts, Final 6 work orchestration tools/catalog,
and RC3 acceptance evidence.

## Build

\`\`\`bash
cd ewoh-spark-app
npm ci
npm run build:prod:standalone
\`\`\`

## Database

Run migrations against a disposable PostgreSQL 17 database first:

\`\`\`bash
EWOH_DATABASE_URL='postgresql://owner:...@host:5432/ewoh' \\
EWOH_RUNTIME_DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh' \\
EWOH_API_DATABASE_PASSWORD='<runtime password>' \\
EWOH_BOOTSTRAP_ADMIN_USERNAME='admin' \\
EWOH_BOOTSTRAP_ADMIN_PASSWORD='<12+ chars>' \\
bash scripts/release-drill.sh
\`\`\`

## Run

\`\`\`bash
cd ewoh-spark-app
EWOH_DEPLOY_TARGET=standalone \\
DATABASE_URL='postgresql://ewoh_api:...@host:5432/ewoh' \\
JWT_SECRET='<32+ chars>' \\
PORT=3000 \\
node dist/server/main.js
\`\`\`

See \`docs/delivery/deployment-runbook.md\` and \`docs/delivery/release-manifest.yaml\`.
EOF

echo "== generate checksums =="
(
  cd "$OUT"
  find . -type f -not -name 'SHA256SUMS.txt' -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS.txt
)

echo "== scale release review =="
EWOH_RELEASE_VERSION="$VERSION" node "${ROOT_DIR}/scripts/scale-release-review.js"

echo "Release bundle: ${OUT}"
du -sh "$OUT"
