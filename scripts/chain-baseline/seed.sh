#!/usr/bin/env bash
# 把基线库装成「能跑链级场景」的状态：迁移链 + 全部 verify + 种子 + 审批独立性账号。
# 幂等；等价于 scripts/local-up.sh 的 2~4 步，但不依赖 Docker、不 DROP DATABASE。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

guard_port
assert_managed_datadir
export EWOH_DATABASE_URL="$(owner_url "$BASE_DB")" EWOH_PG_URL="$(owner_url "$BASE_DB")"
export EWOH_ALLOW_DDL=1 EWOH_API_DATABASE_PASSWORD

log "1/3 迁移链 + 全量 verify"
node "$ROOT/db/runner/standalone-chain.js" --apply > "$BASE_DIR/seed-chain.log" 2>&1 \
  || fail "迁移链失败，见 $BASE_DIR/seed-chain.log"
node "$ROOT/db/runner/run_migrations.js" --apply-standalone-users >> "$BASE_DIR/seed-chain.log" 2>&1 \
  || fail "users 迁移失败"
node "$ROOT/db/runner/run_migrations.js" --apply-standalone-runtime-role >> "$BASE_DIR/seed-chain.log" 2>&1 \
  || fail "运行角色迁移失败（注意：EWOH_API_DATABASE_PASSWORD 需 ≥16 字符）"
# 单支 verify 失败此前不判红：`|| true` 吞掉退出码，只 grep「有没有任意一条 VERIFY OK」。
# 现在两路都要过：退出码为 0，且 VERIFY OK 条数 == 链上迁移条数（少一条就是有一支没跑或失败被吞）。
WANT="$(node "$ROOT/db/runner/standalone-chain.js" --plan 2>/dev/null | grep -c '"id":' || true)"
VERIFY_RC=0
VERIFY="$(node "$ROOT/db/runner/standalone-chain.js" --verify 2>&1)" || VERIFY_RC=$?
GOT="$(printf '%s\n' "$VERIFY" | grep -c 'VERIFY OK' || true)"
[ "$VERIFY_RC" = "0" ] || { printf '%s\n' "$VERIFY" | tail -20; fail "迁移 verify 未通过（rc=$VERIFY_RC）"; }
printf '%s\n' "$VERIFY" | grep -q 'VERIFY OK' || { printf '%s\n' "$VERIFY" | tail -20; fail "迁移 verify 无任何通过项"; }
if [ "${WANT:-0}" -gt 0 ] && [ "$GOT" != "$WANT" ]; then
  printf '%s\n' "$VERIFY" | tail -20
  fail "verify 通过项 $GOT ≠ 链上迁移 $WANT 支 ⇒ 有分支未跑或失败被吞"
fi
log "  verify 通过项 $GOT/$WANT"

log "2/3 种子（演示租户/调度场景/工作台/班次/物料）"
for step in "" -admin -scheduling -workbench-data -shift -material; do
  node "$ROOT/db/runner/run_migrations.js" "--seed-standalone${step}" > /dev/null 2>&1 \
    || fail "种子 --seed-standalone${step} 失败"
done

log "3/3 运营账号（审批独立性：生成人 ≠ 审批人）"
# SEED-01（V80 实测）：原来两个账号都绑同一个 ${PERSON_ID}，在全新库上第二次创建会被
# 「一个人员在同一组织内只能有一个登录账号」拒掉 ⇒ 基线库**无法从空库重建**（这也是
# ENV-02「基线被消费后没法复位」的下半个原因）。这里让审批人绑另一名seed 人员（李娜 P002），
# 工人继续绑 ${PERSON_ID}（张伟 P001，也是 EWOH_E2E_PERSON_ID 指向的人）。
EWOH_OPERATOR_PASSWORD="$APPROVER_PASSWORD" node "$ROOT/db/runner/create-operator.js" \
  --username approver.li --display-name "李审批（车间主任）" \
  --roles "workshop_lead,dispatcher" --person-id "$APPROVER_PERSON_ID" > /dev/null \
  || fail "创建 approver.li 失败"
EWOH_OPERATOR_PASSWORD="$WORKER_PASSWORD" node "$ROOT/db/runner/create-operator.js" \
  --username worker.zhangwei --display-name "张伟（装配工）" \
  --roles "worker" --person-id "$PERSON_ID" > /dev/null \
  || fail "创建 worker.zhangwei 失败"

log "基线库就绪：${BASE_DB}（source $BASE_DIR/env.sh 后跑 verify.sh）"
