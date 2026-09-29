#!/usr/bin/env bash
# 建立/复用试点链基线集群：一次性 PostgreSQL + owner/运行角色 + 空业务库。
# 幂等；只操作 tmp/ 下由本套脚本管理的集群（见 lib.sh 的护栏说明）。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

start_cluster
guard_port

node "$HERE/provision.mjs"

cat > "$BASE_DIR/env.sh" <<EOF
# 由 scripts/chain-baseline/up.sh 生成；source 它即可在本机重放链级验证。
$(export_env)
export EWOH_E2E_LOG_DIR="$BASE_DIR/e2e-logs"
export CHAIN_PGDATA="$PGDATA"
EOF
chmod 600 "$BASE_DIR/env.sh"
log "环境就绪：source $BASE_DIR/env.sh"
