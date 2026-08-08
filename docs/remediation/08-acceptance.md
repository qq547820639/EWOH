# EWOH 整改验收复核 + 残余安全闭环 + CP-SAT 决策 最终验收报告

审计日期：2026-08-08

## 2. Repository Baseline

```text
Repository: git@github.com:qq547820639/EWOH.git
Branch: main
Audit Base SHA:  ba7db6b81ede44238905ed2796b9dd7c4b6ba2db
Starting HEAD:   ff4ee6f（上一轮整改完成态）
Final HEAD:      3bc34ad（本轮验收完成态）
Commits since audit base: 16（上一轮 9 + 本轮 7）
Working Tree: CLEAN
Remote: origin git@github.com:qq547820639/EWOH.git
```

## 3. Previous P0/P1 Independent Verification Matrix

| # | Previous Claim | Current Code | Runtime/Test Verification | Status |
| -- | -------------- | ------------ | ------------------------- | ------ |
| 1 | Edge production real assembly | runtime/bootstrap + real Storage/Manager | `EWOH_RUNTIME_MODE=production python run.py` → rule_version=risk-rule-v0.2 | **VERIFIED** |
| 2 | No silent stub | RuntimeMode + RealAssemblyError | 无效 DB 路径 → EXIT=1，server 未启动 | **VERIFIED** |
| 3 | EventBus single handler contract | stubs.Bus.subscribe(stream,handler) = MessageBus | bus contract test | **VERIFIED** |
| 4 | StreamName centralized | runtime/protocols STREAM_* + ALL_STREAMS | 无业务裸 topic | **VERIFIED** |
| 5 | Subscriber exception observable | _record_handler_error log + counter + metric | event_bus_handler_errors_total 存在 | **VERIFIED** |
| 6 | Production assembly smoke | tests/test_production_assembly.py + CI gate | make production-smoke 11 passed | **VERIFIED** |
| 7 | Feishu webhook verified | verifyWebhookRequest (token+ts+signature+replay) | node:test 13 passed | **VERIFIED** |
| 8 | Feishu simulator off | FEISHU_SIMULATOR_ENABLED=false default; production double-switch | simulatorEnabled() 逻辑复核 | **VERIFIED** |
| 9 | Production simulator guard | ALLOW_SIMULATOR_IN_PRODUCTION required | 逻辑复核 | **VERIFIED** |
| 10 | Feishu CORS allowlist | resolveCorsOrigins() 禁止 `*` | 逻辑复核 | **VERIFIED** |
| 11 | CP-SAT fallback explicit | CpSatSchedulingSolver UNAVAILABLE/FALLBACK + fallbackReason | scheduler tests 日志确认 | **VERIFIED** |
| 12 | Solver metadata truthful | solverStatus/solverVersion/fallbackReason；新增 HEURISTIC 状态 | solver-invariants/runs-snapshot tests | **VERIFIED** |
| 13 | DecisionTrace no fake | 真实 PriorityEngine；UNKNOWN 显式（score:null） | cp-sat + heuristic 复核 | **VERIFIED** |
| 14 | Duration unified | policy.defaultTaskDurationMs 单一来源 | P1-SCHED-004 test | **VERIFIED** |
| 15 | Route fallback ETA | eta = distance / walkingSpeed | routing spec 10 passed | **VERIFIED** |
| 16 | Routing factors from policy | edgeCost 用 policy factors（refreshEdgeFactors） | routing spec | **VERIFIED** |
| 17 | World state DB-side latest | selectDistinctOn(entity_id) | 代码复核 | **VERIFIED** |
| 18 | Ingest batch optimized | 4 次固定 DB 往返；单次 insert 断言 | ingest 16 tests | **VERIFIED** |
| 19 | CommandMap write = V2 | WorkbenchPanel→V2；V1 api client 已删 | client tsc/jest | **VERIFIED** |
| 20 | ResourceProjection SSOT | /api/scheduler/resources/state + ResourcePool 消费 | resource-state 7 tests | **VERIFIED** |
| 21 | OpenAPI 301/301 | route audit undocumented=0 | audit-openapi-routes | **VERIFIED** |
| 22 | Stale plan protection | CAS + assertFreshForApprove | dispatch-integration PLAN_STALE test | **VERIFIED** |
| 23 | Reservation transaction | 事务内 check-then-insert | eligibility-reservation tests | **VERIFIED** |

## 4. Regressions Found

无。上一轮 23 项全部独立复核为 VERIFIED。

## 5. Ingest Security Closure

- **P1-INGEST-002**：`INGEST_API_KEY` 缺失时 fail-closed。
  - production：所有 ingest 请求 503 + 模块启动失败（OnApplicationBootstrap）。
  - 非 production：需显式 `INGEST_INSECURE_DEV_MODE=true` 才放行。
  - key 比较 constant-time（timingSafeEqual）。
  - compose `INGEST_API_KEY` 必填（`:?`）。
  - 新增 4 个安全测试（production 无 key / 非 production 无 key / 显式 dev mode / 错误 key）。
- Secret handling：key 不进日志/错误响应；`.env.example` 仅 placeholder；仓库无真实 key。

## 6. CP-SAT Production Readiness Decision

```
CP-SAT Production Ready? NO
Production Canonical Solver = HeuristicSchedulingSolver (heuristic-v2)
CP-SAT Status = OPTIONAL / EXPERIMENTAL
Reason: 零第三方运行时依赖硬约束 + 无 worker 部署拓扑 + heuristic 已覆盖全部 25 约束
Requirements before activation: 见 docs/remediation/06-cpsat-decision.md
```

本轮新增：`SolverStatus` 增加 `HEURISTIC`；heuristic 主路径 `solverStatus='HEURISTIC'`
（fallback 仍覆盖为 UNAVAILABLE/FALLBACK，绝不冒充 CP-SAT）。

## 7. Scheduler End-to-End Validation

- 真实闭环测试（dispatch-integration）：task→run→shadow→approve→reserve→dispatch→事件/outbox。
- Stale plan：PLAN_STALE 拒绝（方案状态不变）。
- Reservation conflict：事务回滚、无部分预约。
- Override：LOCK_*/EXCLUDE/PREFER/BOOST → constraint → replan（无直接 DB 改派）。
- DecisionTrace：真实 priority/candidates/rejectedAlternatives；不可得时 UNKNOWN。
- Solver metadata：solverVersion/solverStatus/fallbackReason/solveDurationMs/objective/snapshotVersion/policyVersion。

## 8. Resource / CommandMap Validation

- ResourceProjection 数据真实性修复：person/device/station 的 STALE/UNKNOWN 不再虚构
  available（→ unavailable/offline）；station 用真实 se.status；新增回归测试。
- CommandMap 写链仅 V2；WorkbenchPanel approve/reject 迁移 V2（带 version+snapshotVersion）。

## 9. Fault Injection Results

| 场景 | 测试 | 结果 |
| ---- | ---- | ---- |
| PERSON_UNAVAILABLE | failure-injection | violation，不派工 |
| DEVICE_OFFLINE / LOW_BATTERY | failure-injection | 回退手工/不派 |
| ROUTE_BLOCKED | failure-injection | violation |
| SAFETY_EVENT | failure-injection | 禁派 + 冻结 executing |
| DEADLINE_RISK | failure-injection | 优先级上升 |
| PLAN_STALE | dispatch-integration | 拒绝 |
| RESERVATION_CONFLICT | eligibility-reservation | 事务回滚 |

## 10. Performance Benchmark Results

- 当前环境无 PostgreSQL/Docker，未运行真实 DB benchmark（**不伪造数字**）。
- 可测证明：Ingest batch 100 帧 = 4 次固定 DB 往返（entity IN + raw_ref IN + devices
  upsert + telemetry insert），非 N×pipeline；测试断言单次 insert（3 行）。
- 新增 `scripts/perf/world-ingest-benchmark.js`（DATABASE_URL 门控，SKIPPED 时如实）。

## 11. Observability Improvements

- Python：event_bus_handler_errors_total + /metrics（PrometheusExporter）。
- NestJS Scheduler：scheduler_run_total（solver_version/status/feasible label）、
  scheduler_fallback_total、scheduler_solver_timeout_total、scheduler_run_duration_ms。
- Feishu：webhook 审计（成功/失败均记录，含 code/ip）。

## 12. Shared Types Refactoring

- Scheduler 域 47 类型物理移到 `shared/scheduler.ts`（api.interface 2049→1229 行）。
- api.interface.ts re-export + 5 个跨域类型 import type。
- `@shared/scheduler` 可直接导入（已验证）；92 个既有 importer 无改动。
- 其余域（auth/world/task/event）留待下迭代。

## 13. WorkOrchestration Refactoring

- 64 方法职责分类矩阵输出（07-work-orchestration.md）。
- work-core **不需要**（server 通过 createRequire 复用 tools/*，无重复实现）。
- 结构拆分（WorkQueryService 等）**DEFERRED**：方法高度耦合 + 81 个直接测试，
  需独立迭代安全迁移。

## 14. Legacy / Dead Code Findings

| Item | Runtime Reference | Safe to Remove? | Action |
| ---- | ----------------- | --------------- | ------ |
| 前端 V1 api client（generatePlans/getPlans/confirmPlan/rejectPlan/getAudit/getWeights/updateWeights） | 无 | 是 | **已删除** |
| server V1 端点（POST/GET /plans, /confirm） | deprecated 兼容 | 保留 | 保持（外部兼容） |
| gamification allocateResources（前端） | ResourcePool 只读推荐 | 保留 | 标注 deprecated/READ_ONLY |
| ui/command_map | 无生产引用 | 保留 | 标注 Prototype（见下） |
| Python orchestrator.Scheduler | learning_loop/__init__ 引用 | 保留 | Legacy reference |

## 15. Security Test Matrix

| 测试 | 结果 |
| ---- | ---- |
| production + no INGEST_API_KEY → 503 | PASS |
| 非 production + no key + no dev mode → 503 | PASS |
| 显式 dev mode → 放行 | PASS |
| wrong/missing X-Ingest-Key → 401 | PASS |
| Feishu missing token → reject（fail-closed） | PASS（security.test.js） |
| Feishu invalid token/signature/expired/replay → reject | PASS |
| Feishu valid → accepted once | PASS |

## 16. Test / Build / Runtime Results

| Command | Exit | Result |
| ------- | ----: | ------ |
| `python3 -m compileall src run.py tests` | 0 | OK |
| `python3 -m unittest discover -s src/edge_platform/tests` | 0 | 731 passed |
| `python3 -m pytest tests/` | 0 | 135 passed, 1 skipped |
| `make production-smoke` | 0 | 11 passed |
| `python3 src/edge_platform/selfcheck.py` | 0 | 24 passed |
| `EWOH_RUNTIME_MODE=production python run.py` | 0 | real assembly（rule=risk-rule-v0.2） |
| `EWOH_RUNTIME_MODE=production`（无效 DB） | 1 | fail-fast，无 stub |
| `npx tsc --noEmit --project tsconfig.node.json` | 0 | passed |
| `npx tsc --noEmit --project tsconfig.app.json` | 0 | passed |
| `npx jest --config client/jest.config.cjs` | 0 | 81 suites / 640 tests |
| `npx jest --testPathPattern scheduler/__tests__|test/unit/ingest` | 0 | 26 suites / 218 tests |
| `npx jest --testPathPattern work-orchestration` | 0 | 8 suites / 81 tests |
| `node scripts/gen-openapi.js --check` | 0 | in sync |
| `node scripts/audit-openapi-routes.js` | 0 | 301/301, undocumented=0 |
| `node --test ewoh-feishu-app/test/security.test.js` | 0 | 13 passed |

## 17. All Files Changed（本轮）

- `server/modules/ingest/ingest.guard.ts`（fail-closed + constant-time）
- `server/modules/ingest/ingest.module.ts`（production 启动校验）
- `deploy/cloud/docker-compose.standalone.yml`（INGEST_API_KEY 必填）
- `test/unit/ingest/ingest.guard.spec.ts`（4 个安全测试）
- `server/modules/scheduler/heuristic-scheduling-solver.ts`（solverStatus=HEURISTIC）
- `shared/api.interface.ts`（SolverStatus +HEURISTIC；Scheduler 域移出）
- `shared/scheduler.ts`（新，47 类型）
- `server/modules/scheduler/resource-projection.service.ts`（STALE→unavailable/offline）
- `server/modules/scheduler/__tests__/resource-state.spec.ts`（真实性测试）
- `client/src/pages/CommandMap/panels/WorkbenchPanel.tsx`（V2 approve/reject）
- `client/src/api/scheduler.ts`（删 dead V1 client）
- `test/unit/ingest/ingest.service.spec.ts`（单次 insert 断言）
- `scripts/perf/world-ingest-benchmark.js`（新）
- `.github/workflows/test.yml`（CI 门禁，commit 8）
- `docs/remediation/06/07/08-*.md`

## 18. All Commits（本轮，7 个）

```text
82f185c fix(security): fail closed when ingest api key is missing
96e97ba docs(scheduler): declare heuristic as canonical production solver
ad107bf refactor(command-map): workbench approve/reject on scheduler V2; resource projection truthful states
ee1b282 test(perf): strengthen batch round-trip assertion; add reproducible benchmark
c3ffce2 refactor(shared): extract scheduler contracts behind compatibility barrel
f3d084c docs(work): method->category matrix and split assessment
3bc34ad chore(command-map): remove dead V1 scheduler api clients
```

## 19. Final Source-of-Truth Matrix

| Domain | Authoritative Source |
| ------ | -------------------- |
| Edge Observation | edge_platform.runtime（真实装配，mode 驱动） |
| World State | ewoh_world_state + DISTINCT ON(entity_id)（DB 侧） |
| Production Business State | PostgreSQL (ewoh_*) |
| Resource State | ResourceProjectionService（/api/scheduler/resources/state） |
| Scheduler | NestJS Scheduler V2 |
| Solver | HeuristicSchedulingSolver（canonical）；CP-SAT OPTIONAL/EXPERIMENTAL |
| Route Cost | RouteCostProvider（policy factors） |
| Scheduling Policy | SchedulingPolicyConfig（versioned） |
| Database Schema | db/migrations(standalone) → schema.ts |
| API Contract | openapi/ewoh.yaml + shared types（301/301） |
| Event Contract | contracts/events（CI 审计） |
| CommandMap | React CommandMap（V2 写链） |
| Prototype UI | ui/command_map（无生产引用，UX Reference） |
| Delivery | 冻结资产，不参与运行时 |
| Release | 冻结快照，不参与运行时 |

## 20. Final Module Ownership Matrix

| Capability | Production | Edge | Legacy | Prototype | Demo | Archive |
| ---------- | ---------- | ---- | ------ | --------- | ---- | ------- |
| Scheduler | NestJS V2 (heuristic) | Python SchedulerService | NestJS V1 端点（deprecated） | Python orchestrator | — | — |
| Resource | ResourceProjectionService | Python resources | — | — | gamification 只读 | — |
| World State | NestJS world + snapshot | Python world_model | — | — | stubs.DemoSimulator | — |
| CommandMap | React (V2) | — | — | ui/command_map | — | client/public/command_map |
| 其余 | 见 08-acceptance（同上轮，无变化） | | | | | |

## 21. Remaining Risks

- **P0**：无。
- **P1**：
  - CP-SAT 激活依赖 ortools 部署（当前 heuristic 显式标记，非静默）。
  - Ingest 单帧路径仍逐帧 DB（batch 已优化）；若真机高频单帧需进一步评估。
- **P2**：
  - Shared types 其余域拆分（auth/world/task/event）。
  - WorkOrchestration 结构拆分（DEFERRED，职责矩阵已输出）。
  - CommandMap 世界状态 polling 2s（保留 poll fallback，符合要求）。
- **P3**：ui/command_map 归档标注；demo.db 清理；output 产物 gitignore。

## 22. Deferred Items

| Item | Reason | Required Context |
| ---- | ------ | ---------------- |
| WorkOrchestration 拆分 | 64 方法高度耦合 + 81 个直接测试，需依赖图迁移 | 独立 refactor 迭代 + 子域测试集 |
| Shared types 其余域 | 需按 domain 依赖边界逐步迁移 | 每域独立拆分 + tsc/jest 门禁 |
| CP-SAT 生产化 | 零第三方依赖硬约束 + 无 worker 拓扑 | 部署边界决策 + worker 容器 |

## 23. 30 / 60 / 90 Day Roadmap

- **30 天**：Shared types 其余域拆分（world/task/event）；WorkOrchestration 抽 WorkQueryService
  （纯读）并迁移 helper；Ingest 单帧路径评估（真机频率下的批量/缓冲策略）。
- **60 天**：CP-SAT 生产化决策复审（若试点规模增长）；world_state_history/current 表分离；
  SSE 事件模型统一（resource/task/world 纳入版本事件）；性能 benchmark 纳入 CI。
- **90 天**：WorkOrchestration 完整拆分为子服务；legacy V1 端点移除评估；RLS 策略审计加固；
  pilot 现场部署 + 可观测性基线。

## 51. 直接回答问题

1. 当前 HEAD：`3bc34ad`
2. 上一轮 P0 是否全部成立：是（23 项独立复核全 VERIFIED）
3. 发现 regression：无
4. Python Edge Production 真实运行：是（rule_version=risk-rule-v0.2）
5. Production 隐式进 Stub：不可能（fail-fast 实测）
6. EventBus 单一正式契约：是（MessageBus handler；SSE EventBus 为独立专用总线）
7. Subscriber exception 可观察：是（log + metric）
8. Feishu webhook fail-closed：是（未配 token 即拒绝）
9. Simulator 误入 Production：不可能（双开关）
10. INGEST_API_KEY 缺失时 Production 行为：启动失败 + 请求 503
11. Ingest fail-closed：是
12. CP-SAT 当前可用：否（ortools 未装，is_available=False）
13. Production Canonical Solver：HeuristicSchedulingSolver
14. OR-Tools 进生产依赖：否
15. CP-SAT/Heuristic hard constraints 一致：heuristic 全 25 约束；CP-SAT 未建模项显式 UNSUPPORTED
16. Solver metadata 真实：是（HEURISTIC/UNAVAILABLE/FALLBACK + fallbackReason）
17. DecisionTrace 占位：无（真实 priority/candidates；不可得 UNKNOWN）
18. stale plan 无法下发：是（CAS + PLAN_STALE）
19. duplicate reservation 阻止：是（事务内查重）
20. duplicate dispatch 阻止：是（CAS）
21. Route fallback ETA 真实：是（distance/walkingSpeed）
22. Policy 重复 magic number：无（routing factors 已收敛 policy）
23. World Current State DB 侧：是（DISTINCT ON）
24. Ingest batch 减少 round-trip：是（100 帧 4 次固定往返）
25. ResourceProjection 是 SSOT：是
26. CommandMap 写链仅 V2：是
27. SSE gap/resync 可用：是（useSchedulerStream 逻辑 + 缺口重同步）
28. Shared Types 拆分程度：Scheduler 域完成（47 类型）；其余待下迭代
29. WorkOrchestration 安全第一阶段：职责矩阵完成 + work-core 判定；结构拆分 DEFERRED
30. 剩余 P0/P1：无 P0；P1 仅"CP-SAT 激活依赖"与"Ingest 单帧高频评估"（均已缓解/显式）
31. 可进入下一轮生产验收：是（关键安全边界 fail-closed；全部验证通过）
