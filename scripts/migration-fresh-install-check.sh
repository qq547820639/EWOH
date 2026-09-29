#!/usr/bin/env bash
#
# 迁移链全新库可安装门禁（审计 §4 主线 5 / SQL-003~006）。
#
# 两种模式：
#  1. 静态顺序校验（默认，无 PG 依赖）：解析 db/migrations 下每个迁移 SQL 的
#     CREATE TABLE / ALTER TABLE 目标表，验证「每条 ALTER 的目标表在更早编号
#     文件（或同文件更早位置）已有 CREATE」，幂等守卫（ALTER TABLE IF EXISTS /
#     to_regclass DO 块守卫 / ADD COLUMN IF NOT EXISTS 场景按 IF EXISTS 计）豁免。
#  2. 真实空库执行（EWOH_PG_URL 提供时优先）：psql 顺序执行全部迁移 + verify
#     脚本，任一步非零即失败。
#
# 已接入：make audit-regression-gates（2026-08-17 审计整改 W13）。
# 用法：bash scripts/migration-fresh-install-check.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="${REPO_ROOT}/db/migrations"
VERIFY_DIR="${REPO_ROOT}/db/verify"

# ── 模式 2：真实空库顺序执行 + verify（EWOH_PG_URL 提供时） ─────────────────
if [[ -n "${EWOH_PG_URL:-}" ]]; then
  echo "[migration-fresh-install-check] PG 模式：EWOH_PG_URL 已提供，真实空库顺序执行"
  # 缺 psql 时此前会以 rc=127 崩在 shell 里（"command not found"）——同样响，但读起来像脚本坏了，
  # 而且 trap/cleanup 已经挂着。这里显式判一次，报"不可判"并单独给退出码，别让它冒充通过。
  if ! command -v psql >/dev/null 2>&1; then
    echo "不可判 migration_pg_apply: EWOH_PG_URL 已设但本机没有 psql（embedded-postgres 只带 initdb/pg_ctl/postgres）⇒ 这一档没跑，不折算成通过"
    exit 3
  fi
  SCHEMA="ewoh_fresh_gate"
  cleanup() { psql "${EWOH_PG_URL}" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  psql "${EWOH_PG_URL}" -v ON_ERROR_STOP=1 -q -c "DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};" >/dev/null
  i=0
  for f in "${MIG_DIR}"/standalone_*.sql; do
    [[ "$f" == *.rollback.sql ]] && continue
    i=$((i+1))
    sed -e "s/__EWOH_SCHEMA__/${SCHEMA}/g" \
        -e "s/__EWOH_ROLE_USER_AUTHENTICATED__/user_authenticated_${SCHEMA}/g" \
        -e "s/__EWOH_ROLE_AUTHENTICATED__/authenticated_${SCHEMA}/g" \
        -e "s/__EWOH_ROLE_ANON__/anon_${SCHEMA}/g" \
        -e "s/__EWOH_ROLE_SERVICE__/service_role_${SCHEMA}/g" "$f" \
      | psql "${EWOH_PG_URL}" -v ON_ERROR_STOP=1 -q >/dev/null \
      || { echo "FAIL migration_pg_apply:$(basename "$f") 迁移执行失败"; exit 1; }
  done
  v=0
  for f in "${VERIFY_DIR}"/standalone_*.sql "${VERIFY_DIR}"/standalone_*.verify.sql; do
    [[ -f "$f" ]] || continue
    [[ "$f" == *.rollback.* ]] && continue
    # 同一 verify 可能命中两个 glob，跳过重复（按文件名去重交给 shell 展开顺序）
    v=$((v+1))
    sed -e "s/__EWOH_SCHEMA__/${SCHEMA}/g" "$f" \
      | psql "${EWOH_PG_URL}" -v ON_ERROR_STOP=1 -q >/dev/null \
      || { echo "FAIL migration_pg_verify:$(basename "$f") verify 失败"; exit 1; }
  done
  echo "PASS migration_pg_fresh_apply:${i} 个迁移全部成功"
  echo "PASS migration_pg_verify:${v} 个 verify 全部通过"
  exit 0
fi

# ── 模式 1：静态顺序校验（默认） ─────────────────────────────────────────────
echo "[migration-fresh-install-check] 静态模式：解析 ALTER/CREATE 顺序（设置 EWOH_PG_URL 可启用真实空库执行）"
python3 - "${MIG_DIR}" <<'PYEOF'
import re
import sys
from pathlib import Path

mig_dir = Path(sys.argv[1])
files = sorted(
    [p for p in mig_dir.glob("*.sql") if not p.name.endswith(".rollback.sql")],
    key=lambda p: p.name,
)
assert files, "未找到迁移文件"

create_re = re.compile(r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w\"$]+\.)?[\"']?(\w+)[\"']?", re.I)
alter_re = re.compile(r"ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(?:[\w\"$]+\.)?[\"']?(\w+)[\"']?", re.I)
do_begin_re = re.compile(r"DO\s+\$\$")
do_end_re = re.compile(r"END\s+\$\$;")

created: dict[str, str] = {}   # 表名 → 首个 CREATE 所在文件
violations = []
alters_total = 0
guarded_total = 0

for f in files:
    text = f.read_text(encoding="utf-8")
    # 去注释行（行注释；块注释粗略剔除，避免其内 DDL 关键字干扰）
    lines = [re.sub(r"--.*$", "", ln) for ln in text.split("\n")]
    # DO 块区间标记：块内出现 to_regclass 守卫 → 块内 ALTER 视为守卫保护
    in_do = False
    do_guarded = False
    for idx, ln in enumerate(lines):
        if do_begin_re.search(ln):
            in_do = True
            do_guarded = False
        if in_do and "to_regclass" in ln:
            do_guarded = True
        m = alter_re.search(ln)
        if m:
            alters_total += 1
            table = m.group(2)
            if_exists = bool(m.group(1))
            # 动态 DDL（EXECUTE format 占位符目标 %I）：目标表由同块数组给出，
            # 无法静态解析具体表名，按守卫形态豁免（如 057 的 org_id 回填块）。
            dynamic_placeholder = "%I" in ln
            if if_exists or dynamic_placeholder or (in_do and do_guarded):
                guarded_total += 1
                continue
            first_create = created.get(table)
            if first_create is None:
                violations.append(f"{f.name}:{idx + 1}: ALTER TABLE {table} 但其 CREATE TABLE 未出现在任何更早编号文件（且无 IF EXISTS/to_regclass 守卫）")
        cm = create_re.search(ln)
        if cm and cm.group(1) not in created:
            created[cm.group(1)] = f.name
        if in_do and do_end_re.search(ln):
            in_do = False
            do_guarded = False

ok = True
if violations:
    ok = False
    for v in violations:
        print(f"FAIL migration_static_order: {v}")
else:
    print(f"PASS migration_static_order: {len(files)} 个迁移文件、{alters_total} 条 ALTER 全部满足「先建后改」或幂等守卫（守卫豁免 {guarded_total} 条）")
print(f"[migration-fresh-install-check] 静态表清单：{len(created)} 张表")
sys.exit(0 if ok else 1)
PYEOF
