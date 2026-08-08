# Week 2 — Scheduler / Solver / Policy / Route

## Finding: P0-SCHED-001 CP-SAT 可用性 & solver 元数据

- **Verification**：当前环境 `ortools` 未安装；`scheduler/cpsat/solver.py` 返回 `UNAVAILABLE`；
  NestJS `CpSatSchedulingSolver` HTTP 调 `127.0.0.1:8000` 失败 → 回退启发式。
- **Conclusion**：CP-SAT 默认不可用，但 fallback 语义正确（`solverStatus=UNAVAILABLE/FALLBACK`，
  回退结果绝不被标记为 CP-SAT 成功）。P0-SCHED-001 核心要求（solverUsed/solverStatus/
  fallbackReason 明确报告）已满足，无需代码改动；保持现状并记录。
- **Tests**：`cp-sat-fallback.spec.ts`（UNAVAILABLE/FALLBACK/TIMEOUT/OPTIMAL 四态）通过。

## Finding: P0-SCHED-002 修 CP-SAT DecisionTrace

- **Old Evidence**：`cp-sat-scheduling-solver.ts` DecisionTrace 使用
  `priority: { level: 'computed', score: 0, factors: [] }, candidates: []` 占位。
- **Fix**：
  1. `priority-engine.ts` 新增 `computeEffectivePriorityResults`（完整 PriorityResult）；
  2. CP-SAT 路径使用同一 PriorityEngine 结果（真实 score/factors/level）；
  3. `candidates` 来自 worker 返回的 `rejectedAlternatives`（真实被拒候选）；
  4. 数据不可得时用 `null`/`UNKNOWN` 显式标记，禁止伪造 0/[]。
- **Type**：`shared/api.interface.ts` `DecisionTrace.priority.score` 与
  `candidates[].score` 放宽为 `number | null`。
- **Tests**：`cp-sat-fallback.spec.ts` 新增 DecisionTrace 完整性断言。

## Finding: P1-SCHED-004 统一 Duration

- **Old Evidence**：solver/CP-SAT 默认 30min（`1_800_000`），dispatch fallback 1h（`3600_000`）。
- **Fix**：`DispatchCoordinatorService` 注入 `SchedulingPolicyService`，
  fallback 时长 = `policy.defaultTaskDurationMs`（与 solver/policy 一致，30min）；
  policy 不可用时回退 `1_800_000`（与 SchedulingPolicyService 默认一致）。
- **Tests**：`dispatch-integration.spec.ts` 通过（含预占时长断言）。

## Finding: P1-ROUTE-001 修 Route fallback ETA

- **Old Evidence**：`routing.service.ts` euclidean fallback `etaSeconds: 0`。
- **Fix**：`euclideanRoute` 改为 async，ETA = distance / policy.walkingSpeedMps；
  返回 `source: 'euclidean_fallback'`，距离>0 时 ETA>0。
- **Tests**：`routing.spec.ts` 新增 ETA>0 / blocked 边 / congested 边 3 个测试。

## Finding: P1-ROUTE-002 Route Cost SSOT

- **Verification**：Solver 与 Candidate 均通过 `RouteCostProvider.estimate`
  （内部 RoutingService A*）；`RouteCostProvider` 已是唯一 route cost 出口。
  前端 `Math.hypot` 仅用于详情面板视觉估算，不参与正式评分。
- **Conclusion**：SSOT 已成立，无需改动；记录确认。

## Phase Status

| Command | Exit Code | Result |
| ------- | --------: | ------ |
| `npx tsc --noEmit --project tsconfig.node.json` | 0 | passed |
| `npx tsc --noEmit --project tsconfig.app.json` | 0 | passed |
| `npx jest --testPathPattern scheduler/__tests__` | 0 | 24 suites / 201 tests passed |
| `npx jest --testPathPattern scheduler/__tests__/routing` | 0 | 10 passed |

## Remaining Risks
- CP-SAT 生产可用性依赖 ortools 部署 + worker 进程；当前 heuristic 为实际求解器
  （已显式标记，非静默降级）。建议部署文档明确 CP-SAT 为可选增强。
