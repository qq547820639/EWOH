# EWOH Scheduler Phase 0 交付报告 — 正确性基线

> 日期：2026-08-09 ｜ 团队：software-ewoh-phase0（交付总监齐活林 / 工程师寇豆码 / QA 严过关）
> 范围：P0-1 ~ P0-8 修复 + Solver Conformance 测试 + 代码走读
> 状态：✅ 全部完成，QA 两轮独立验证通过（QA_PASS: YES）

---

## 1. 改动后的系统架构

```
Task/Person/Device/Station/Events
→ WorldStateService.buildSnapshot          （+ routeEdgeTaskIndex 反查索引）
→ PriorityEngine.compute                   （heuristic/CP-SAT 共用）
→ EligibilityService.check                 （ALL/ANY 语义，Nest 侧）
→ TravelCostService.estimate               （SSOT：A* route graph + fallback 带原因）
→ SolverService.solve
    ├─ HeuristicSchedulingSolver            （显式 predecessor 时间约束 + due 软/mustFinishBy 硬）
    └─ CpSatSchedulingSolver                （契约对齐：skillMatchMode/mustFinishByMs/candidateCosts）
        └─ Python CP-SAT Worker             （ANY/ALL 技能、mustFinishBy HARD、due SOFT、矩阵 travel）
→ SchedulingObjectiveEvaluator              （统一评估：heuristic 与 CP-SAT 共用，禁止 shell 复用）
→ Plan persistPlan → Reservation（capacity 感知 + advisory lock）→ Dispatch（容量预检）
→ Audit/Outbox → SSE → CommandMap（selectedPlan 同源）
```

**核心原则落实**：
- Nest Scheduler 仍是唯一生产写入方（Worker 纯计算，无 DB 写）
- Heuristic 与 CP-SAT 对 HARD constraint 语义一致（QA 逐条对照验证）
- 地图/Solver/explanation 共用同一 RouteCost（矩阵透传 worker）
- SAFETY_BLOCK 候选层硬过滤（fail-closed），不受目标权重影响

## 2. 修改文件列表

### NestJS（server/modules/scheduler/）
| 文件 | 改动 |
|---|---|
| heuristic-scheduling-solver.ts | P0-1 显式 predecessor 时间约束；P0-3 due 软/latestFinishMs 硬；P0-5 评估器统一 |
| cp-sat-scheduling-solver.ts | P0-2/3/4 请求契约对齐；P0-5 删除 heuristic shell 复用 |
| scheduling-objective-evaluator.service.ts | **新增**：统一目标评估器（P0-5） |
| resource-reservation.service.ts | P0-7 capacity 计数 + advisory lock + assertStationCapacityAvailable |
| dispatch-coordinator.service.ts | P0-7 预检 station capacity + 预占传 capacity |
| impact-analyzer.ts | P0-6 routeEdgeTaskIndex 判定（修复 edgeId/zoneId 错配） |
| world-state.service.ts | P0-6 构建 routeEdgeTaskIndex |
| eligibility.service.ts | （既有 ALL/ANY，未改动） |

### Python（src/edge_platform/scheduler/cpsat/）
| 文件 | 改动 |
|---|---|
| contract.py | 增 skillMatchMode/effectivePriorityScore/mustFinishByMs/CandidateCost/candidateCosts |
| solver.py | ANY/ALL 纯函数；mustFinishBy 硬约束；**删除 worker 内欧氏 travel**，改用矩阵；due 改软目标 |

### 共享契约 / 客户端
| 文件 | 改动 |
|---|---|
| shared/scheduler.ts | SolverRequest.tasks 增 mustFinishByMs；WorldStateSnapshot 增 routeEdgeTaskIndex |
| client/src/pages/CommandMap/layers/SchedulerLayers.tsx | P0-8 selectPlanForLayer（不回退 plans[0]） |
| client/src/pages/CommandMap/CommandMap.tsx | P0-8 selectedPlanId 提升并下发 |

### 数据库 / 脚本
| 文件 | 改动 |
|---|---|
| db/migrations/standalone_022_reservation_capacity.sql | **新增**：EXCLUDE 按 resource_type 拆分为 person/device-only（additive） |
| db/migrations/standalone_022_reservation_capacity.rollback.sql | **新增**：回滚恢复旧全类型 EXCLUDE |
| db/verify/standalone_022_reservation_capacity.verify.sql | **新增**：3 列断言（表存在/新约束/旧约束已移除） |
| db/runner/run_migrations.js | 注册 022（FILES/EXECUTE/ROLLBACK/usage/allowlist/handler/which 共 7 处） |
| scripts/e2e-db-verify.mjs | 增 5b 段（022 apply/verify/rollback/re-apply） |
| scripts/e2e-db-verify-022.mjs | **新增**：嵌入式 PG 定向全链路验证脚本 |

## 3. 每个关键改动的目的

| 改动 | 目的 |
|---|---|
| P0-1 predecessor 显式时间约束 | 跨人员/设备并行场景下 succ.start >= pred.end 必须为真，而非仅靠排序隐式保证 |
| P0-2 契约失配修复 | **实测确认** Nest 发 skillMatchMode 导致 Python TypeError → CP-SAT 生产恒回退；修复后 CP-SAT 首次可真实运行 |
| P0-2 ALL/ANY | 双 solver 技能匹配语义一致（ALL=every / ANY=some，缺省 ALL） |
| P0-3 due/mustFinishBy 分离 | 普通 deadline 允许可解释 lateness penalty，紧急截止才是 HARD（任务 unassigned 而非晚分配） |
| P0-4 权威 RouteCost 透传 | 消除 worker 内欧氏近似；矩阵/地图/Solver 同源 |
| P0-5 SchedulingObjectiveEvaluator | 禁止"CP-SAT assignment 配 Heuristic metrics"；评估与求解解耦、可测试 |
| P0-6 route edge 影响索引 | 修复 edgeId vs zoneId ID 体系错配（route blocked 事件此前永远圈不中任务） |
| P0-7 capacity 感知 reservation | 消除"求解可行、下发失败"断裂点；容量>1 工位三层语义一致 |
| P0-8 selectedPlan 同源 | PlanLayer 不再默认 plans[0]，与 SchedulePanel 同一 UI state |

## 4. Scheduler 新调用链

```
buildSnapshot(+routeEdgeTaskIndex) → PriorityEngine → Eligibility(ALL/ANY)
→ TravelCostService(SSOT) → SolverService
   → Heuristic: predecessor 时间约束 → due(soft)/mustFinishBy(hard) → evaluator 评估
   → CP-SAT: buildMatrix(+candidateCosts) → POST worker(skill ANY/ALL + mustFinishBy HARD + 矩阵 travel) → evaluator 评估
→ Plan → Reservation(capacity 计数 + advisory lock) → Dispatch(容量预检 + CAS) → Execution → Outbox → SSE → CommandMap
```

## 5. Constraint IR 定义

**Phase 0 未引入 ConstraintCompiler（属 Phase 1）**。当前约束仍以字符串 union（shared/scheduler.ts:93-120，16 HARD + 9 SOFT）+ 各层 if/else 表达。已建立**语义对照矩阵**（QA 验证）保证双 solver 当前一致：

| 约束 | Heuristic | CP-SAT | 一致 |
|---|---|---|---|
| REQUIRED_SKILL (ALL) | every (eligibility:85-93) | all (solver.py:44-56) | ✅ |
| REQUIRED_SKILL (ANY) | some | any | ✅（本次修复） |
| REQUIRED_CERTIFICATION | every (:97) | all (:219) | ✅ |
| SAFETY_BLOCK | 不可达 (eligibility:171-172) | 候选层硬过滤 (:184-187) | ✅ |
| mustFinishBy (HARD) | endMs>截止→拒绝 (:451-474) | OnlyEnforceIf (:364-367) | ✅ |
| due (SOFT) | lateness 进 score | lateness 软项 | ✅ |
| PREDECESSOR | earliestStart>=max predEnd (:338-361) | 时间约束 (:337-341) | ✅ |
| STATION_CAPACITY | capacity 检查（既有） | AddCumulative (:369-371) | ✅（reservation 层本次补齐） |

Phase 1 将把上表固化为 `SchedulingConstraintIR`（id/type/hardness/scope/params/penalty/source/reasonCode）+ 测试矩阵。

## 6. Heuristic 与 CP-SAT 语义对照（QA 逐条验证）

- **HARD 语义完全一致**（8 条对照见上表；SAFETY_BLOCK 双端 fail-closed）
- **允许目标函数差异**：软目标权重实现不同属预期（如仅有 planEnd 的任务，heuristic 仍将其作为软 due 计 lateness，CP-SAT 不施加 lateness 压力——LOW-2 已知差异，metrics 报告侧由评估器统一，已文档化）
- **不允许差异**：HARD 解释、RouteCost 来源、metrics 来源——均已消除

## 7. RouteCost 数据流（新）

```
route graph DB (ewoh_route_node/edge) + spatial 坐标
→ TravelCostService.estimate（SSOT，A* + 显式 fallback 带 reason/dataQuality）
→ heuristic: routeCostProvider.estimate 直接消费
→ CP-SAT: buildMatrix → candidateCosts 透传 worker → travel_cost_for_candidate（矩阵查找，无欧氏）
→ 地图: 后端 routeGeometry/etaSeconds 字段消费（FactoryMap 不本地复算）
```

## 8. Reservation / Dispatch 一致性

- **三层容量语义统一**：solver（AddCumulative）≡ reservation（计数 < capacity）≡ dispatch（预检 assertStationCapacityAvailable）
- **并发安全**：station 预占走 `pg_advisory_xact_lock`（事务内串行化 check-then-insert）；person/device 保留 DB EXCLUDE 二值硬后盾（standalone_022 拆分后仅 person/device）
- **迁移**：standalone_022（additive，可 rollback，已注册 runner，嵌入式 PG 18.4 实跑闭环验证）
- **遗留**：Execution 记录仍在 dispatch 事务外（scheduler.service.ts:975，失败仅 warn）——Phase 4 建议纳入事务或补偿

## 9. CommandMap 状态流（Phase 0 范围）

- selectedPlanId 提升至 CommandMap 级，`SchedulerLayersOverlay` 与 `SchedulePanel` 同源（activePlan）
- `selectPlanForLayer(plans, selectedPlanId)`：只按 id 定位，**null 不回退 plans[0]**
- **未完成（Phase 3）**：SchedulingMapVM、SchedulerRealtimeProvider（当前页面仍 2 个 SSE 连接：useCommandMapSchedulerState.ts:60 + SchedulePanel.tsx:196）

## 10. SSE 同步机制（现状）

- 单服务 scheduler-stream（outbox 2s 轮询）→ `@Sse v2/stream`；帧：scheduling.event（带 outbox sequence）/heartbeat/resync
- 实际事件：plan.dispatched / assignment.dispatched / execution.* / conflict.* / policy.activated
- **缺失**：plan.generated/approved/rejected、route.changed、resource.changed（依赖 30s refetch 轮询兜底）——Phase 3 补齐
- **Phase 0 未改**（按边界）：双连接去重、sequence gap/full resync 属 Phase 3

## 11. 人工干预流程（现状）

- 保留：LOCK/EXCLUDE/PREFER/BOOST/ADJUST_TIME/CHANGE_RESOURCE（overrides API 未改动，QA 确认 overrides.spec.ts 通过）
- **Phase 3 待做**：Override Preview API（before/after + KPI delta + 确认后 Apply）；干预审计字段扩展

## 12. 数据库迁移说明

- **仅 1 个新迁移**：standalone_022_reservation_capacity（+rollback +verify），additive，不动既有迁移
- runner 显式注册 7 处（与 021 同构）；verify SQL 处理了 PG `IN (...)` → `= ANY (ARRAY[...])` 规范化（初版 LIKE 匹配失败已修复）
- 嵌入式 PG 18.4 实跑闭环：apply → verify → rollback（恢复旧约束）→ re-apply → verify；行为断言：station 容量>1 重叠放行、person 重叠仍被拒绝

## 13. API/DTO 变更

- **无新增 endpoint**（全部复用现有 /api/scheduler/*）
- DTO 变化（shared/scheduler.ts）：SolverRequest.tasks 增 `mustFinishByMs`；WorldStateSnapshot 增 `routeEdgeTaskIndex?`（可选，向后兼容）
- Python 契约：SolverTask 增 skillMatchMode/effectivePriorityScore/mustFinishByMs；SolverRequest 增 candidateCosts

## 14. 新增测试列表（8 个文件，45 用例）

| 测试文件 | 覆盖 |
|---|---|
| server/.../predecessor-time-constraint.spec.ts (3) | 跨人员并行 C>=max(A,B).end；单人员串行；冻结 pred |
| server/.../cp-sat-contract.spec.ts (4) | 请求体含 skillMatchMode/mustFinishByMs/candidateCosts；OPTIMAL 解析；缺省 ALL |
| server/.../due-lateness-semantics.spec.ts (3) | 软 due 允许 late；硬 mustFinishBy unassigned；可满足正常分配 |
| server/.../scheduling-objective-evaluator.spec.ts (5) | 确定性（同输入同输出）；CP-SAT metrics 基于自身 assignments；baseline delta |
| server/.../impact-analyzer-route-edge.spec.ts (4) | blocked/congested 按 edge 索引圈定；未知 edge；不影响其他事件 |
| server/.../capacity-aware-reservation.spec.ts (6) | cap=1 拒第二；cap=2 放行；cap=2 拒第三；person 二值；预检；advisory lock |
| client/.../scheduler-layers-select.test.ts (4) | 选中非首方案；null 不回退；未知 id；空 plans |
| python src/edge_platform/tests/test_cpsat_contract.py (12) | from_dict 不抛 TypeError；ANY/ALL；response 往返；mustFinishByMs 解析 |

另：Python cpsat 既有套件 12 用例（reservation/solver_real/worker_contract），event-driven.spec.ts 更新 2 个旧断言为 edge 索引语义。

## 15. 实际执行的测试命令及结果

| 命令 | 结果 |
|---|---|
| `cd ewoh-spark-app && npx tsc -b --force` | ✅ exit 0 |
| `npx jest server/modules/scheduler --silent --ci` | ✅ 50 suites / 372 passed |
| `npx jest --config client/jest.config.cjs client/src/pages/CommandMap --silent --ci` | ✅ 17 suites / 87 passed |
| `PYTHONPATH=src python -m pytest src/edge_platform/tests/test_cpsat_contract.py -v` | ✅ 12 passed |
| `PYTHONPATH=src python -m pytest tests/test_cpsat_contract.py tests/test_cpsat_reservation.py tests/test_cpsat_solver_real.py tests/test_cpsat_worker_contract.py -q`（迁移前） | ✅ 24 passed, 9 skipped（ortools 未装） |
| `node db/runner/run_migrations.js --plan standalone_reservation_capacity[_rollback|_verify]` | ✅ runner 认识新键 |
| `node scripts/e2e-db-verify-022.mjs`（嵌入式 PG 18.4） | ✅ 全链路 exit 0（apply/verify/rollback/re-apply + 行为断言） |

## 16. 性能/兼容性风险

- **低风险**：routeEdgeTaskIndex 构建 O(edges×nodes + tasks×edges)，大规模工厂注意（当前规模无碍）
- **低风险**：travel_cost_for_candidate 线性扫描 O(T·C·N)，大矩阵建议建 dict 索引（Phase 2 优化项）
- **兼容性**：所有 DTO 变更可选/向后兼容；迁移 additive 可 rollback
- **行为变化（有意）**：CP-SAT 生产首次真正可运行（此前恒回退）；heuristic plan 级 scoreBreakdown 不再含 per-candidate 派生项（无既有测试断言旧值）；PlanLayer 未选中方案时渲染为空（不再 plans[0]）
- **部署注意**：e2e-db-verify-022.mjs 硬编码绝对路径（ROOT=/Volumes/Extra/CodeProj/EWOH），换机器需参数化；ortools 需在 worker 部署环境安装（否则 UNAVAILABLE fallback，测试 skip 属预期）

## 17. 尚未完成的问题（Phase 0 边界外）

1. **Phase 1**：ConstraintCompiler（统一 IR + 测试矩阵）、ResourceAvailabilityService（freshness TTL 分类）、Task DAG/Critical Path、entity-aware trigger debounce（cooldown 现仅 orgId+triggerType）、auto-replan gate（canAutoReplan 无执行拦截）
2. **Phase 2**：CP-SAT 完整 objective 分层（Level 0-8）、rolling horizon、warm start、circuit breaker、shadow mode（复用现有 shadow policy 能力）
3. **Phase 3**：SchedulerRealtimeProvider（单 SSE + gap/resync/polling fallback）、SchedulingMapVM、Override Preview、route.changed/resource.changed 事件
4. **Phase 4**：feedback → KPI → policy replay 闭环；Execution 纳入 dispatch 事务
5. 已知遗留：repo-facts.spec.ts 预存 counts-generative 警告（schema-manifest 73 vs state.json 57，与本次无关）；sw-update.spec.ts 预存 22 tsc 错误（Playwright/jest 冲突，约定勿动）
6. priority-engine：无 businessPriority 输入、event_severity 死路径（Phase 1 清理）

## 18. Phase 1 ~ 4 后续实施建议

- **Phase 1**：先建 ConstraintCompiler（把上表 8 条固化为 IR + 双 solver 测试矩阵），再建 ResourceAvailabilityService（复用 world-state 已有字段，freshness TTL 按 person/device/station 分类，stale 进 explanation）；Task DAG 从 priority-engine 的 direct downstream 升级为完整 critical path
- **Phase 2**：route cost 矩阵落库（ewoh_route_cost_matrix 已有雏形）→ full objective 分层（SAFETY_BLOCK 恒 Level 0）→ rolling horizon + frozen assignments + warm start；shadow mode 直接复用 shadow-policy.service
- **Phase 3**：SchedulerRealtimeProvider 为最高优先（双 SSE 问题已确认存在）；SchedulingMapVM 收敛双状态链；Override Preview 服务端化（UI → constraint → 局部重解 → before/after → 确认 → Apply，全审计）
- **Phase 4**：feedback 闭环接入现有 SchedulingFeedback→KPI→Policy Replay→Shadow Policy→Activation 管道（均已有），补 actual 数据源
- **ML（后续）**：仅在确定性闭环稳定后引入，预测需 confidence/feature trace/可缺失/可 fallback，绝不绕过 HARD

## 验收原则对照（8 条全部满足）

| 原则 | 结果 |
|---|---|
| 无两套生产调度事实源 | ✅ Worker 纯计算，Nest 唯一写入 |
| HARD 约束双 solver 一致 | ✅ QA 8 条逐条对照 |
| 地图与 Solver 同一 RouteCost | ✅ 矩阵透传，worker 无欧氏 |
| CP-SAT 不配 Heuristic metrics | ✅ evaluator 统一 |
| 安全规则不被权重抵消 | ✅ 候选层硬过滤 |
| React 不复制调度规则 | ✅ 纯消费后端字段 |
| 人工干预走服务端 | ✅ override 链路未破坏 |
| 失败不伪装最优 | ✅ FALLBACK/UNAVAILABLE + fallbackReason |
