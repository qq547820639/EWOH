# EWOH 最终生产验收 — 环境判定（FINAL ACCEPTANCE NOT COMPLETED）

> 2026-08-08 · commit `6da3aaf` · HEAD 与上一轮验收一致（无新增 commit，无 regression）

## 1. Git Baseline

```text
Repository: git@github.com:qq547820639/EWOH.git
Branch: main
Current HEAD: 6da3aaf376b27b3be287e93b00fca07c5ccd3bf5
Previous Acceptance HEAD: 6da3aaf（无新增 commit）
Commits Since Previous Acceptance: 0
Working Tree: CLEAN（## main...origin/main）
Remote: origin git@github.com:qq547820639/EWOH.git
Timestamp: 2026-08-08
```

HEAD 未变化 → 上一轮全部已验证能力保持有效，无需重新评估旧 Finding。

## 2. Phase 0 回归门禁（本轮实跑，全部 PASS）

| Gate | Result |
| ---- | ------ |
| Python unittest | 733 passed |
| pytest contract | 135 passed, 1 skipped |
| production-smoke | 11 passed |
| selfcheck | 24 passed |
| server tsc | PASS |
| client tsc | PASS |
| scheduler + ingest jest | 26 suites / 218 tests |
| OpenAPI route audit | 301/301, undocumented=0 |
| gen-openapi --check | in sync |
| Feishu security | 13 passed |

结论：核心回归门禁无 regression。

## 3. Acceptance Environment 探测（穷尽所有途径）

```text
Docker:        NOT AVAILABLE（docker / podman / colima / orbstack / lima / nerdctl 均不存在）
PostgreSQL:    NOT AVAILABLE
  - psql/postgres/initdb: 不存在
  - /opt/homebrew/opt/postgresql@17、/usr/local/bin/psql: 不存在
  - /Applications/Postgres.app、/Library/PostgreSQL、conda: 不存在
  - 运行中实例 5432/5433: CLOSED
Package Manager: brew NOT AVAILABLE（无法安装 postgresql/docker）
```

已穷尽：容器运行时（docker/podman/colima/orbstack/lima/nerdctl）、PG 二进制
（brew/postgres.app/conda/libpq）、运行中实例。**全部不可用。**

## 4. FINAL ACCEPTANCE NOT COMPLETED

```text
FINAL ACCEPTANCE NOT COMPLETED

Reason:
  执行环境无法提供真实 PostgreSQL 与 Docker，且无任何可用安装途径
  （无 brew、无容器运行时、无 PG 二进制、无运行中实例）。本轮无法对
  PostgreSQL/Docker 相关 Hard Gates 执行真实验收。

Missing Environment:
  - Docker（docker/podman 等任意容器运行时）
  - PostgreSQL 16/17（任意可启动的实例或可安装来源）

Outstanding Hard Gates（共 14 项，均需 PostgreSQL/Docker）:
  1.  Docker image actual build（API / migrate / frontend）
  2.  Docker/Compose production startup（PG + migration + API + Redis）
  3.  PostgreSQL fresh migration（空库 → migration runner → verify）
  4.  PostgreSQL upgrade migration
  5.  PostgreSQL schema verify（真实 DB metadata 对比）
  6.  PostgreSQL RLS 真实启用 + policies
  7.  Cross-tenant real DB isolation（User A/B + Global Admin，HTTP + DB 双层）
  8.  Connection pool org context isolation（100~1000 次交替请求 + 并发）
  9.  NestJS production HTTP startup on PG（/health/live + /health/ready + /metrics）
  10. Real HTTP E2E on PG（Auth→Org→Ingest→World→Task→Scheduler→Plan→Approve→Reservation→Dispatch→Audit）
  11. Real Scheduler/Reservation/Dispatch on PG（含 duplicate dispatch / stale plan / reservation collision 真实 DB 故障注入）
  12. Real PostgreSQL benchmark（World State 100/1k/10k entities、Ingest 1~1000 帧、Scheduler 10/50/100）
  13. Real PostgreSQL backup/restore + restore 后 RLS 验证
  14. Process/container restart recovery（PG 持久状态 + SSE 网络级验证）

停在此事实边界。不将任何未执行项标记为 PASS。
```

## 5. 代码级状态（不影响上述判定的已验证据）

- Production Canonical Solver = **HeuristicSchedulingSolver**；CP-SAT = NOT PRODUCTION READY（未安装 OR-Tools，未启用）。
- Edge production runtime 真实装配（rule_version=risk-rule-v0.2），无效 DB fail-fast，无隐式 Stub。
- Edge HTTP E2E 完整闭环已实测（task→request→plan→confirm→execute→dispatched→audit）。
- Edge SQLite backup/restore/verify roundtrip 实测通过。
- Scheduler restart hydration 已修复并实测（3 plans 恢复）。
- Feishu 验签 fail-closed / simulator 默认 OFF / Ingest fail-closed / secrets 扫描干净。
- OpenAPI 301/301；Contract 与 repo facts 门禁通过。

## 6. 补齐验收的可执行路径（供具备 PG/Docker 的环境执行）

在具备 Docker + PostgreSQL 的环境按序执行：

```bash
# 1. Docker 构建
docker compose -f deploy/cloud/docker-compose.standalone.yml build

# 2. 一键启动（PG + migrate + API + Redis，migrate job 自动跑 migration+verify+seed）
docker compose -f deploy/cloud/docker-compose.standalone.yml up -d

# 3. Fresh migration 验证（migrate 容器日志 + verify 输出）

# 4. RLS / Cross-tenant 真实验收（需 PG；仓库已有等价套件）
EWOH_E2E_OWNER_DATABASE_URL=... EWOH_E2E_RUNTIME_DATABASE_URL=... bash scripts/cross-tenant-tck.sh

# 5. NestJS HTTP E2E on PG
cd ewoh-spark-app && npm run test:e2e

# 6. PG 性能基准（已有脚本，DATABASE_URL 门控）
DATABASE_URL=postgresql://ewoh_api:...@localhost:5432/ewoh node scripts/perf/world-ingest-benchmark.js

# 7. PG backup/restore（pg_dump / pg_restore，恢复后重跑 cross-tenant-tck）

# 8. 重启恢复 + SSE 网络级验证
docker compose restart api
```

完成后按 `docs/acceptance/10-go-no-go.md` 的 Hard Gate Matrix 复核，即可做出 GO / NO-GO 最终判定。

## 7. 判定

```text
Decision: FINAL ACCEPTANCE NOT COMPLETED
（无法在本环境升级上一轮 CONDITIONAL GO，也无法判定 NO-GO；
  PostgreSQL/Docker 硬验收未执行，不伪造 PASS，不重复 Conditional GO 作为完成。）
```
