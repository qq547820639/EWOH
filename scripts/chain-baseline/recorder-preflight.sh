#!/usr/bin/env bash
# 记账前置校验（recorder preflight）：把**候选**的三份自述产物指向一致性尺，跑的是真判据本身。
# 存在理由：V296–V304 里我七次犯同一族错——速览/状态件里被机器读的自述写成"语义对但字形不对"，
# 每次都是落盘后被 chain-baseline-consistency 报红才知道。这个入口把那次红提前到写盘之前：
# 候选件不过，就不许安装到真产物上（判据不复制、不近似，直接调 artifact-consistency.cjs）。
#
# 用法：recorder-preflight.sh <候选目录>
#   <候选目录> 里需要三份文件（名字固定）：chain-behavior-baseline.md / state.json / verdict.md
#   其余输入（重放日志、schema-facts、Makefile、verify.sh）仍读真仓库——候选的只是自述面。
# 退出码：0＝候选件一致；非 0＝判据报出的漂移（原样透传，供记账脚本当拒写条件）。
set -u
cd "$(cd "$(dirname "$0")/../.." && pwd)" || exit 9
DIR="${1:-}"
[ -n "$DIR" ] || { echo "用法: recorder-preflight.sh <候选目录>"; exit 2; }
[ -d "$DIR" ] || { echo "候选目录不存在：$DIR"; exit 2; }
for f in chain-behavior-baseline.md state.json verdict.md; do
  [ -f "$DIR/$f" ] || { echo "候选件缺失：$DIR/$f"; exit 2; }
done
export EWOH_AUDIT_DOC="$DIR/chain-behavior-baseline.md"
export EWOH_AUDIT_STATE="$DIR/state.json"
export EWOH_AUDIT_PKG="$DIR/verdict.md"
node scripts/chain-baseline/artifact-consistency.cjs
rc=$?
if [ "$rc" = "0" ]; then
  echo "[preflight] 候选件过闸（判据：真 artifact-consistency，非复制品）"
else
  echo "[preflight] 候选件不过闸 rc=$rc ⇒ 记账脚本不得落盘"
fi
exit "$rc"
