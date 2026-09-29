#!/usr/bin/env bash
# 停止基线集群（保留数据目录，便于复跑）。彻底删除请手动 rm -rf tmp/chain-baseline/pgdata。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
stop_cluster
