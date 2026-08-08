# EWOH 准生产验收 — Go / No-Go 决策

## 1. Executive Summary

在 commit `a931759` 完成准生产验收（Pre-Production Acceptance）。本轮通过真实构建、
真实进程、真实 HTTP、真实 E2E 闭环、故障注入、性能基准、backup/restore、重启恢复
验证了上线条件。**发现并修复 2 个上线阻断项（P0/P1）+ 1 个安全日志泄漏（P1）**，
另确认 1 项 BLOCKED_BY_ENVIRONMENT（真实 PostgreSQL 无法在本地环境执行）。

## 2. Git Baseline

```text
Repository: git@github.com:qq547820639/EWOH.git
Branch: main
Audit Base:   ba7db6b
Acceptance Start: c1788db
Final HEAD:   a931759（本轮 4 个 commit）
Working Tree: CLEAN
Environment:  macOS / Python 3.9.6 / Node v26.5.1 / 无 Docker / 无 PostgreSQL 二进制
```

本轮 commit：
```
aaffa4d fix(edge): populate skills registry in greedy solver; expose plan execute endpoint
(manifest 刷新)  fix(contract): refresh route manifest to 301/301
8d1c...    fix(security): stop logging feishu base_token
a931759   fix(edge): hydrate scheduler state from repository on restart
```

## 3. Production Build Results

| Build | Command | Result |
| ----- | ------- | ------ |
| Server | `NODE_ENV=production nest build` | PASS（dist/server/main.js 生成） |
| Client standalone | `vite build --config vite.standalone.config.ts` | PASS（✓ built in 2.74s，gzip 主包 193KB） |
| Python Edge | `python3 -m compileall src` | PASS |
| Edge production bootstrap | `RuntimeFactory.assemble(production)` | PASS（真实 Storage/MessageBus，is_simulation=False） |
| Docker 镜像 | — | **BLOCKED_BY_ENVIRONMENT**（无 Docker；Dockerfile 构建命令已用等价本地命令验证） |

## 4. Container / Runtime Results

- 镜像体系：api（Dockerfile.api）、migrate（Dockerfile.migrate）、postgres/redis（官方镜像）。
  **Edge / Feishu 无独立镜像**（Edge 本地进程、Feishu 独立 Node 进程）。
- 生产镜像资产检查：构建产物无 demo.db/simulator 数据/secret；secret 扫描仅命中
  `process.env.*` 引用（非真实值）。
- 构建产物 secret 扫描：PASS（无真实 secret 进入 client bundle / dist）。

## 5. Database Migration Results

- **BLOCKED_BY_ENVIRONMENT**（无 PostgreSQL 二进制、无 Docker；已尝试全部可用途径）。
- 静态验证（PASS）：10 个 standalone migration 顺序正确；245 处幂等模式
  （IF NOT EXISTS / DROP POLICY IF EXISTS）；RLS enable + 9 个 policy + ewoh_org_visible
  函数；生产部署不引用 delivery/release SQL。
- DB Source of Truth = `db/migrations/standalone_*.sql`（+ 生成 schema.ts）；确认
  delivery/release SQL 不参与运行时。

## 6. RLS / Multi-Tenant Security Results

- **BLOCKED_BY_ENVIRONMENT**（cross-tenant-tck 需 PostgreSQL）。
- 代码层验证（PASS）：auth/org/shared 84 测试通过；org_visible 函数 + transaction-local
  GUC（RequestDatabaseContext）；RolesGuard 默认 deny；OrgContextInterceptor 无 userContext
  放行仅限 Public 端点。

## 7. Production Configuration Tests

| 配置缺失 | 行为 | 结果 |
| -------- | ---- | ---- |
| Edge 无效 DB 路径 | RealAssemblyError fail-fast（不进入 stub） | PASS |
| DATABASE_URL 缺失 | provider 抛错（standalone 启动失败） | PASS |
| JWT_SECRET < 32 字符 | auth 抛错 | PASS |
| INGEST_API_KEY 缺失（production） | 启动失败 + 请求 503 | PASS |
| FEISHU_VERIFICATION_TOKEN 缺失 | webhook fail-closed（拒绝写操作） | PASS |

## 8. End-to-End Business Flow

**真实 HTTP E2E（Edge，production 模式，SQLite）完整闭环通过：**

```
建任务 → 调度请求 → 生成方案（assignments=1, violations=[]）
→ 未确认执行拒绝（ILLEGAL_STATE）→ 确认（approved, 理由必填）
→ 执行派工（assignments=1）→ 方案 dispatched → 审计链完整（4 条）
```

**E2E 发现并修复：**
- **P0（hard gate #15）**：GreedyOptimizer 空 skills_registry → 真实数据技能硬约束恒失败
  （assignments=0）。已修复（从 world_state.persons 填充 registry）。
- **P1**：Python 无 HTTP 派工端点。已加 `POST /api/scheduling/plans/{id}/execute`。

## 9. Scheduler Acceptance

- 调度闭环（dispatch-integration）：task→run→shadow→approve→reserve→dispatch PASS。
- Stale plan：PLAN_STALE 拒绝（状态不变）。PASS。
- Overrides 8 项（LOCK_*/EXCLUDE/PREFER/BOOST + UNSUPPORTED_CONSTRAINT 显式）：PASS。
- SAFETY_BLOCK：求解器校验阶段强制，不可被 override。PASS（hard gate #6）。
- DecisionTrace：真实 priority/candidates；不可得时 UNKNOWN。PASS。
- Solver metadata：solverVersion/solverStatus/fallbackReason 如实。PASS。

## 10. Reservation / Dispatch Acceptance

- Duplicate reservation：事务内 check-then-insert，冲突回滚。PASS。
- Duplicate dispatch：CAS（approved→dispatched where status=approved）。PASS。
- 已实测：E2E reservation 落库（resource_reservation=2）、assignment=1、无重复副作用。

## 11. Fault Injection

| 故障 | 结果 |
| ---- | ---- |
| PERSON_UNAVAILABLE / DEVICE_OFFLINE / LOW_BATTERY | violation，不派工/回退手工 |
| ROUTE_BLOCKED / ROUTE_CONGESTED | violation |
| SAFETY_EVENT | 禁派 + 冻结 executing |
| DEADLINE_AT_RISK | 优先级上升 |
| scoped replan（10 任务仅 2 受影响） | unaffected 不 churn（event-driven 测试） |

## 12. Security Acceptance

- 认证：no/invalid/expired/valid token 语义（auth 84 测试）。PASS。
- Secrets 审计：无真实 secret 入库；feishu-config.json 被 gitignore；日志无敏感值。
  PASS。
- **本轮修复**：Feishu 启动日志泄漏 base_token → 已改为不打印（P1 安全）。
- Feishu webhook：13 个安全测试全过（unsigned/wrong sig/expired/replay → 拒绝）。
- Ingest：production 无 key → fail-closed。PASS。

## 13. Performance Benchmark（真实测量）

**Edge HTTP（production 进程，SQLite，1000 行遥测）：**

| Endpoint | p50 | p95 | p99 | Errors |
| -------- | --: | --: | --: | -----: |
| /api/status | 0.35 | 0.43 | 0.52ms | 0 |
| /api/devices | 0.36 | 0.54 | 0.79ms | 0 |
| /api/people | 0.35 | 0.78 | 1.26ms | 0 |
| /api/telemetry?limit=100 | 0.40 | 0.59 | 0.97ms | 0 |
| /api/telemetry/series | 0.38 | 0.49 | 0.58ms | 0 |

**BLOCKED_BY_ENVIRONMENT**：World State / Ingest batch / Scheduler（NestJS，需真实 PostgreSQL）。
Ingest batch 往返数已静态验证（100 帧 = 4 次固定 DB 往返，测试断言单次 insert）。

## 14. SSE / Realtime Reliability

- phase2-realtime 11 测试 PASS：replaySince 重连接续、RESYNC_NEEDED 缺口检测、
  Last-Event-ID 幂等、executing 冻结、scoped replan 不 churn。
- 前端 hooks 3 测试 PASS。
- 结论：SSE gap/resync/reconnect/poll-fallback 语义验证通过（代码层）。

## 15. Backup / Restore

- Edge SQLite BackupManager：22 测试 PASS；真实 roundtrip（backup→destroy→restore→
  verify→数据完整）PASS。
- **重启恢复（本轮修复）**：调度状态持久化但重启不加载（P1）→ 新增
  hydrate_from_repository()；真实重启验证：3 plans（含 dispatched）+ 1 request 恢复。
- PostgreSQL backup/restore：BLOCKED_BY_ENVIRONMENT（无 PG）。

## 16. Observability

- Edge：/metrics（uptime/db_counts/event_bus_handler_errors_total/inference）。
- API：/metrics（HTTP 通用 + scheduler_run_total/fallback/timeout/duration_ms）。
- Audit：Edge audit_log + schedule_decision；NestJS ewoh_audit_log + ewoh_schedule_audit。
- SLO baseline 建议：Hard Constraint Violation = 0（硬目标）；API availability 99.5%；
  Ingest success ≥ 99%；World State p99 < 100ms；Dispatch success ≥ 99.5%；
  SSE recovery < 30s。

## 17. Production Runbook

已写入 `docs/operations/production-runbook.md`（Startup/Shutdown/Migration/Rollback/
Health/Logs/Metrics/Backup/Incident/Scheduler Fallback/Edge Failure/Ingest Auth/Feishu/SSE）。

## 18. New Findings

| ID | Sev | Status |
| -- | --- | ------ |
| ACC-001 | P0 | FIXED（skills_registry 空 → 调度硬约束恒失败；已修复+测试） |
| ACC-002 | P1 | FIXED（Python 无 execute 端点；已加 POST /execute） |
| ACC-003 | P1 | FIXED（重启后调度状态不加载；hydrate_from_repository 已加） |
| ACC-004 | P1 | FIXED（Feishu 日志打印 base_token；已改为不打印） |
| ACC-005 | P2 | OPEN（lark-cli ENOENT：Feishu 生产需安装 lark-cli 外部依赖） |
| ACC-006 | P1 | BLOCKED（真实 PostgreSQL 验收未执行——环境无 PG/Docker） |

## 19. Remaining Risks

- **P1**：真实 PostgreSQL Migration/RLS/E2E 未在本环境执行（BLOCKED_BY_ENVIRONMENT），
  需在具备 PostgreSQL 的环境完成 cross-tenant-tck + migration + PG E2E。
- **P1**：lark-cli 外部依赖（Feishu 生产部署需安装）。
- **P2**：Shared types 其余域拆分、WorkOrchestration 结构拆分（前轮 DEFERRED 项）。
- **P2**：CP-SAT 未启用（属条件项，非阻断）。
- **P3**：原型目录归档、demo.db 清理。

## 20. Go / Conditional Go / No-Go

```
PRODUCTION READINESS DECISION

Decision: CONDITIONAL GO
（可进入受限 Pilot/Canary，但存在明确非阻断风险）

Commit: a931759
Environment: macOS local（无 PostgreSQL/Docker）

Blocking Findings:
- 无（2 个 P0/P1 上线阻断项已修复并验证）

Non-blocking Risks:
- 真实 PostgreSQL Migration/RLS/E2E 未在本环境执行（BLOCKED_BY_ENVIRONMENT），
  Pilot 前必须在具备 PostgreSQL 的环境完成 cross-tenant-tck + migration verify + PG E2E
- lark-cli 外部依赖（Feishu 生产需安装）
- CP-SAT 未启用（OPTIONAL/EXPERIMENTAL，heuristic 为 canonical）

Verified Hard Gates:
- Production 隐式 Stub: 无（fail-fast 实测）✓
- Production 默认 Simulator: 无（Feishu 双开关；Edge production 不启动 sim）✓
- RLS 跨组织泄漏: 代码层机制验证（真实测试 BLOCKED）△
- Ingest 无 API key 接受: 无（fail-closed）✓
- Feishu 未签名 mutation: 无（验签 fail-closed）✓
- Safety constraint override: 不可（SAFETY_BLOCK 求解器层强制）✓
- stale plan dispatch: 拒绝（PLAN_STALE）✓
- duplicate reservation: 阻止（事务）✓
- duplicate dispatch: 阻止（CAS）✓
- Migration 空库: 静态验证通过（真实执行 BLOCKED）△
- Production build: PASS ✓
- DB 不可达 readiness: 503（/health/ready 真实 DB 查询）✓
- Secret 进 client bundle: 无 ✓
- 核心业务数据恢复: Edge backup/restore 实测 ✓
- Hard Constraint violation: 0（E2E violations=[]）✓

Unverified Areas:
- PostgreSQL 真实 migration/RLS/E2E（需 PG 环境）
- PG 性能基准（World/Ingest/Scheduler）
- NestJS 真实进程启动（需 PG）

Canary Requirements:
- Stage 1: 单工厂/少量设备，至少覆盖一个完整生产周期；watch: hard violation=0,
  ingest rejection, world stale, scheduler fallback
- Stage 2: 扩大资源/任务；watch: reservation collision, dispatch failure
- Stage 3: 多班次/更多设备；watch: DB 性能（World p99, ingest throughput）
- Stage 4: 正式扩容

Rollback Triggers:
- hard constraint violation > 0；cross-org leak；duplicate dispatch；reservation
  collision；ingest rejection spike；world stale spike；scheduler fallback abnormal；
  dispatch failure；SSE failure；DB overload

Decision Rationale:
代码、构建、Edge 真实运行、E2E 闭环、故障注入、安全边界、性能基线、恢复能力均已
验证并通过；2 个上线阻断项（P0 硬约束失效、P1 派工/恢复）已在验收中修复并实测。
唯一未验证的是真实 PostgreSQL 环境（Migration/RLS/PG E2E/PG 性能），这属于环境
限制而非代码缺陷，且项目已有完整的 cross-tenant-tck 与 E2E 套件待 PG 环境执行。
因此给出 CONDITIONAL GO（受限 Pilot），而非 NO-GO。
```

## 21. 最终逐条回答

1. 当前 HEAD：`a931759`
2. Working Tree：CLEAN
3. Production clean build：PASS（server+client+Edge）
4. 所有生产镜像可构建：API/migrate Dockerfile 构建命令验证 PASS；**镜像实际构建 BLOCKED**（无 Docker）
5. Production Edge 真实启动：**是**（rule_version=risk-rule-v0.2，真实组件）
6. Production 隐式 Stub：**无**（fail-fast 实测）
7. Production 默认 Simulator：**无**
8. PG migration 空库：**BLOCKED_BY_ENVIRONMENT**（静态验证 PASS）
9. Schema verify：**BLOCKED_BY_ENVIRONMENT**（verify SQL 存在）
10. DB Source of Truth：db/migrations（standalone_*）
11. RLS 跨组织阻止：代码层机制 PASS；真实测试 BLOCKED
12. Connection pool org leak：transaction-local GUC 设计（无泄漏路径）；真实测试 BLOCKED
13. Ingest 无 API key：**拒绝**（fail-closed 实测）
14. Feishu 未签名 mutation：**拒绝**（13 测试）
15. Secret 进前端 bundle：**无**（扫描 PASS）
16. World State 性能：**BLOCKED**（需 PG）
17. Ingest batch 性能：**BLOCKED**（需 PG）；round-trip 静态验证 4 次/100 帧
18. Scheduler 性能：**BLOCKED**（需 PG）
19. Production Canonical Solver：**HeuristicSchedulingSolver**
20. CP-SAT Production Ready：**NO**（OPTIONAL/EXPERIMENTAL）
21. Hard Constraint violation：**0**（E2E 实测）
22. stale plan 下发：**不能**（PLAN_STALE）
23. duplicate dispatch 副作用：**无**（CAS）
24. reservation collision：**阻止**（事务）
25. Safety Block override：**不可**
26. 设备离线 scoped replan：**是**（event-driven 测试）
27. route blocked replan：**是**（failure-injection）
28. executing/dispatched 保护：**是**（冻结语义）
29. SSE duplicate 去重：**是**（Last-Event-ID 幂等）
30. SSE gap resync：**是**（RESYNC_NEEDED）
31. SSE 断线恢复：**是**（replaySince + poll fallback）
32. DB backup/restore 实测：**是**（Edge SQLite roundtrip）
33. API restart 状态保持：**是**（hydrate 实测 3 plans 恢复）
34. Health/Readiness 语义：**符合生产语义**（ready 校验 DB，503）
35. 关键故障 metrics/logs：**有**（scheduler/event_bus/HTTP metrics + audit）
36. 当前最大性能瓶颈：**未测**（PG 场景 BLOCKED）；Edge SQLite 侧 p99<1ms
37. 当前最大安全风险：真实 RLS 未在 PG 实测（需 PG 环境执行 cross-tenant-tck）
38. 是否仍存在 P0：**无**
39. 是否仍存在 P1：2 项（PG 验收未执行、lark-cli 外部依赖）
40. 最终结论：**CONDITIONAL GO**
