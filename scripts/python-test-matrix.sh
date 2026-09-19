#!/usr/bin/env bash
# NO-77b：Python 解释器矩阵——真栈用例跨解释器运行。
#
# 纪律：
#   · asyncua 2.x 需要 Python ≥ 3.10；低版本解释器上真栈用例**显式 SKIP**（版本守卫），
#     矩阵脚本把"SKIP"如实打印，不当作失败也不当作通过（三态语义与 e2e 链一致）。
#   · 真线用例（test_actuator_opcua_real.py）在有 asyncua ≥ 2.0 的解释器上必须全绿。
# 用法：bash scripts/python-test-matrix.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

INTERPRETERS=("python3" "python3.12" "python3.13")
FAIL=0

for PY in "${INTERPRETERS[@]}"; do
  command -v "$PY" >/dev/null 2>&1 || continue
  VERSION_OK=$("$PY" -c 'import sys; print(1 if sys.version_info >= (3, 10) else 0)')
  if [ "$VERSION_OK" != "1" ]; then
    echo "[$PY] SKIP（Python < 3.10：asyncua 2.x 不支持；真栈用例按版本守卫显式跳过）"
    continue
  fi
  # pytest 可用性检查：目标解释器没装 pytest → SKIP（与"asyncua 未装 → SKIP"同纪律）
  if ! "$PY" -c "import pytest" 2>/dev/null; then
    echo "[$PY] SKIP（$PY 没装 pytest；安装后可跑真栈用例）"
    continue
  fi
  echo "[$PY] 运行真栈 + Modbus 用例…"
  if PYTHONPATH=src "$PY" -m pytest -q \
      src/edge_platform/tests/test_actuator_opcua_real.py \
      src/edge_platform/tests/test_actuator_modbus.py -p no:cacheprovider; then
    echo "[$PY] PASS"
  else
    echo "[$PY] FAIL"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[matrix] FAIL"
  exit 1
fi
echo "[matrix] OK"
