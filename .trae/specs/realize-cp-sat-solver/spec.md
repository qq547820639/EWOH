# 智能调度 Solver 落地与收敛 Spec

## Why

当前 EWOH 的智能调度（NestJS Scheduling V2）只有 `HeuristicSchedulingSolver` 一个求解器，
`CpSatOptimizer` 仍是回退到 Greedy 的占位；Phase 1/2/3（资源模型完整性、DecisionTrace、
实时闭环、benchmark）尚未落地。用户要求把一个真正可落地的 CP-SAT 求解器接入既有控制面，
并补齐资源/约束/实时/可解释/可观测能力，且必须保留 heuristic fallback 与人在回路。

## 目标架构决策

- **NestJS Scheduling V2 是唯一调度控制面 / Source of Truth**（负责 run/world-state/policy/
  constraint/plan 生命周期/reservation/approval/dispatch/audit/event/outbox/API）。
- **Python 仅作为优化算法 Worker**，承载 OR-Tools CP-SAT；通过稳定内部 HTTP 契约被 SolverService 调用。
- **不新增第四套调度模型**。`src/edge_platform/scheduler` 视作参考/兼容层，不在其内建第四套权威域。
- Python Worker 不可用/超时/异常时，NestJS 自动回退 `HeuristicSchedulingSolver`，且**明确标注实际使用的 solver**。

## What Changes

- 新增 Python OR-Tools CP-SAT worker（`src/edge_platform/scheduler/cpsat/`），实现任务→人员/设备/工位/时间求解。
- 定义并落地稳定的内部求解契约（request/response schema），含 `solverStatus/solveDurationMs/objective/objectiveBreakdown/hardViolations/optimalityGap/assignmentReasons/rejectedAlternatives/solverVersion`。
- 新增 NestJS `CpSatSchedulingSolver`（`SchedulingSolver` 新实现），负责调用 worker、标签、超时与 fallback。
- 统一并完成 ResourceState 模型（person/device/station/tool/vehicle/material；location/capabilities/
  availabilityWindows/reservations/battery/fault/telemetryUpdatedAt/version/freshness）。
- 补全任务模型 requiredDeviceCapabilities/candidateStations/resourceQuantity 等字段，并让 `requiredDeviceCapabilities` 真正参与筛选。
- 实现 DecisionTrace 持久化（JSONB）与按需详情。
- 收敛 legacy `/api/scheduler/plans` 为 deprecated + compatibility adapter。
- 实现 SSE `sinceSequence` / gap recovery / durable outbox 事件重放。
- 实现 ImpactAnalyzer + 局部重排（冻结 executing/locked，churn penalty）。
- 实现 Top-K 多方案（policy preset + weight profile + diversity + 可解释差异）。
- 新增调度 benchmark 脚本与可观测指标（run/plan/solver/fallback/replan/override 等）。
- Command Map 增加 Availability/Conflict/Diff/Explain/Override 展示（尽量复用现有地图，不重写）。

**BREAKING（受控）**：`/api/scheduler/plans` 标 deprecated，不再新增业务逻辑；功能迁移到 V2。

## Impact

- Affected specs capability：scheduler（V2 control plane）、routing、world-state、reservation、dispatch、replan、stream。
- Affected code：
  - Python：`src/edge_platform/scheduler/cpsat/*`（新增 worker）、`src/edge_platform/server.py`（挂载 worker 路由）。
  - NestJS：`server/modules/scheduler/*`（solver.service、heuristic-scheduling-solver、plan.service、
    replan-coordinator、eligibility.service、resource-projection、scheduler-stream、scheduler.controller、
    新增 cp-sat-scheduling-solver.ts、impact-analyzer.ts、benchmark）。
  - 共享类型：`ewoh-spark-app/shared/api.interface.ts`。
  - DB：`server/database/schema.ts` + `db/migrations/*`（DecisionTrace、top-k、events sequence、freshness）。
  - UI：`ui/command_map/*` 与 `ewoh-spark-app/client/src`（Availability/Conflict/Diff/Explain/Override）。

## ADDED Requirements

### Requirement: CP-SAT 求解 worker
系统 SHALL 提供基于 OR-Tools CP-SAT 的求解 worker，决策任务→人员/设备/工位及起止时间；
硬约束覆盖 no-overlap(人员/设备/工位)、availability、skills、certifications、capabilities、
predecessor、time window、reservation、forbidden zone、Safety Hold、executing/locked 不可移动；
目标最小化 lateness/travelTime/stationWait/workload imbalance/changeover/risk/energyRisk/schedule instability。

#### Scenario: 成功求解
- **WHEN** NestJS 调用 `/api/scheduler/solve`（内部契约）提交 snapshot+constraints+policy
- **THEN** 返回含 `solverVersion="cpsat-..."`、`solverStatus="OPTIMAL|FEASIBLE"`、objective breakdown、
  hardViolations=0、assignmentReasons、rejectedAlternatives 的结果

#### Scenario: 求解失败回退
- **WHEN** worker 超时/异常/依赖不可用
- **THEN** SolverService 回退 `HeuristicSchedulingSolver`，plan 标记 `solverVersion="heuristic-..."`、
  `solverStatus="FALLBACK"`，日志与 API 明确区分，不得冒充 CP-SAT 成功

### Requirement: Solver 选择可标识
求解结果 SHALL 明确标识实际使用的 solver 与状态，禁止把 fallback 描述为 CP-SAT 成功。

#### Scenario: 前端展示
- **WHEN** 查看 plan 的 solver 信息
- **THEN** 显示真实的 `solverVersion`/`solverStatus`（cpsat|heuristic，OPTIMAL|FEASIBLE|FALLBACK|INFEASIBLE|TIMEOUT）

### Requirement: ResourceState 完整模型
ResourceState SHALL 覆盖 person/device/station/tool/vehicle/material，含 location、capabilities、
skills、certifications、availableWindows、reservations、workload、fatigue、battery、risk、
sourceTs、freshnessMs、dataQuality、version。缺失/过期关键数据不得静默视为 AVAILABLE。

#### Scenario: 过期数据
- **WHEN** 设备 telemetry 超过 freshness 阈值
- **THEN** 状态标 `UNKNOWN/STALE` 或 `dataQuality=STALE`，不参与 AVAILABLE 候选

### Requirement: requiredDeviceCapabilities 生效
Eligibility SHALL 校验任务的 `requiredDeviceCapabilities`，不是仅检查外骨骼 model/exo_requirements。

#### Scenario: capability 不匹配
- **WHEN** 设备在线且电量足够但 capability 不匹配任务需求
- **THEN** 该设备不可执行该任务

### Requirement: DecisionTrace
每个 Assignment SHALL 持久化 DecisionTrace（selected/priority/candidates/selectedReason/
policyVersion/solverVersion/snapshotVersion），JSONB 存储，前端默认摘要、点击"为什么"加载详情。

### Requirement: Legacy 收敛
`/api/scheduler/plans`（POST/GET）与 confirm 相关老路径 SHALL 标记 deprecated，经 compatibility adapter 转接 V2；新功能不得依赖旧路径。

### Requirement: SSE sequence 恢复
SchedulingEvent/service 层 SHALL 支持 `sinceSequence`，sequence 缺口时前端停止增量→拉最新 snapshot→恢复，依赖 durable outbox。

### Requirement: 局部重排
ImpactAnalyzer SHALL 将事件映射到受影响任务，冻结 executing/dispatched/locked，仅重排受影响子图，solver 含 churn/stability penalty。

#### Scenario: 设备离线
- **WHEN** 设备离线事件发生
- **THEN** 仅受影响任务重排，无关任务不 churn，executing/locked 不变

### Requirement: Top-K 多方案
系统 SHALL 支持 policy preset + objective weight profile + solution diversity，多方案有真实差异与可解释差异。

### Requirement: 可观测指标
系统 SHALL 暴露 scheduler_run_total/duration、feasible_ratio、solver_timeout_total、fallback_total、
plan_approved/rejected/stale_total、replan_total、reservation_conflict_total、manual_override_total；
日志携带 runId/planId/snapshotVersion/policyVersion/solverVersion。

### Requirement: Command Map 调度增强
Command Map scheduling 模式 SHALL 展示 Resource Availability、Plan Route（current/confirmed/candidate + ETA/risk）、
Conflict（forbidden zone/blocked route/faulty device/reservation conflict/unassigned high-priority）、
Plan Diff（Current vs Candidate）、Explain Panel、Manual Override（调用后端 Constraint/Override API）。

### Requirement: Benchmark
系统 SHALL 提供可重复 benchmark 脚本，记录 task/person/device/candidate 数量、生成/求解/总延迟、
feasible rate，对比 heuristic vs cp-sat（lateness/travel/workload balance/station wait/changeover/changed/hard violations）。

## MODIFIED Requirements

### Requirement: Bug 修复 — replan 使用 fresh snapshot
Replan SHALL 始终获取最新 WorldStateSnapshot、冻结 executing/locked、绑定新 snapshotVersion，
不得默认复用旧 `_world_snapshot`。

### Requirement: 强化 WorldState 版本/新鲜度
WorldState 比较 SHALL 覆盖 person(status/location/workload/fatigue/skills)、device(status/battery/
location/capabilities)、task(status/priority/due/window/requirements)、reservation、station、
forbidden zones、safety blocks、route status/risk。Approval 时关键状态变化返回 `PLAN_STALE`。

### Requirement: 生产环境禁用静默 SAMPLE_DATA fallback
生产 backend 模式下，真实数据为空→empty/unknown/stale + data quality 提示，不得自动显示 sample 数据参与判断。

## REMOVED Requirements

（无删除；仅将 legacy `/api/scheduler/plans` 标记 deprecated 并转接，不立即下线路由。）