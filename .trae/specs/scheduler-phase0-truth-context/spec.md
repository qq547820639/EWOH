# Scheduler Phase 0 — 事实源与安全一致性（Truth & Context）Spec

> change-id：`scheduler-phase0-truth-context`
> 日期：2026-08-10 ｜ 依据：用户第五次提交的同源生产级调度升级需求（§一~§十）+ 对当前 main（HEAD=450bf33）逐项代码核验
> 前置 spec（已完成并推送）：`scheduler-prod-convergence`（60c7808）、`command-map-final-acceptance`（87988a1）

## Why

用户再次提交"指挥地图 + Scheduler V2 → 生产级智能调度"升级需求，明确要求 Phase 0（事实源与安全一致性）优先实施。经对 main 头代码逐项核验：

- ✅ 已交付（前三轮）：生产依赖 required fail-fast、RouteCost 三模式、TS↔Python golden parity、`ui/command_map` archived、ReplanStabilityBudget（freezeWindow/minImprovement/maxChangedAssignments）、standalone_024 LISTEN/NOTIFY + realtime 指标、Command Map 单 SSE + selection 单一 owner、world snapshot replay、dispatch CAS、PLAN_STALE。
- ⚠️ 本轮经代码确认仍为真实缺口（Phase 0 范畴）：
  1. **Scheduler 表 RLS 覆盖不完整且存在 GUC 名不一致 bug**：023 迁移仅对 `ewoh_scheduling_constraint` 启用 RLS，policy 读取 `current_setting('app.primary_org_id')`，而应用实际设置的是 `app.current_org_id`（[org-context.interceptor.ts:47](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/shared/org-context.interceptor.ts#L47)）——真实 PG 下约束表 RLS 将过滤全部 org 行；run/plan/assignment/reservation/policy/feedback 等表均未启用 RLS（`rls-org-filter.audit.spec.ts` 明示依赖应用层 org 过滤）。
  2. **无统一 SchedulingContext**：Command Map 分别读取 snapshot/resource/route/policy/KPI，无版本一致的上下文切片；无 `GET /api/scheduler/context`。
  3. **Candidate horizon 仍残留硬编码**：`candidate-engine.service.ts:469` `now + 480*60*1000`（line 199 已配置化，469 未改）。
  4. **Route cost matrix DB 唯一键不足**：`uq_ewoh_route_cost_matrix_task_snapshot` 仅 (task, snapshot)；逻辑缓存 key 已含 policyVersion/routeGraphVersion/candidateSetHash，DB 层未同步 → 不同策略/候选集矩阵可被覆盖。
  5. **Replan storm guard 为单进程内存态**（`replan-coordinator.service.ts` orgReplanStates Map），多 Pod 部署同一事件可产生多个有效重排。
  6. **Run 创建接口未支持** objectiveProfile / baselinePlanId / mode=SHADOW（现有仅 trigger/entityId/horizonMinutes）。

其余需求（availability 交集、tool/material/vehicle、objective profiles、CP-SAT shadow、dispatch expectedVersion CAS、feedback learning、CommandMap 拆分等）经核验已在 main 交付或属条件性需求（"如实际业务需要"），本 spec 记录为 roadmap 不在本轮重复实现。

## What Changes（本轮范围 = Phase 0 最小收敛）

1. **P0-1 Scheduler DB RLS audit/fix + 覆盖**：
   - 修正 GUC 名不一致（policy 与 `buildGucSettings` 统一为 `app.current_org_id`；兼容旧名 `app.primary_org_id` 回退）。
   - 新增增量 migration `standalone_025_scheduler_rls`：对 org-scoped 调度表（run/plan/assignment/reservation/policy/feedback/replan_trigger/constraint）启用 RLS + org policy（`org_id = current_setting('app.current_org_id', true) OR org_id IS NULL`，TO service_role，幂等）；outbox / world_state_snapshot / assignment_event 保留非 RLS（全局 sequence/版本键语义，应用层 org 过滤），在 migration 注释与 `rls-org-filter.audit.spec.ts` 中文档化。
   - 逐表审计 org_id 列存在性（schema.ts 已确认核心表均含 org_id），缺失列的表（如有）以增量列补齐。
   - 测试：静态 AST 审计扩展（非 RLS 表 allowlist 更新）+ 新增 RLS policy 存在性/一致性校验测试 + cross-org 语义测试（约束/方案/预约 org 隔离）。
2. **P0-2 SchedulingContext 统一上下文**：
   - 新增 `scheduling-context.service.ts`：聚合 snapshotVersion / resourceVersion / routeGraphVersion / policyVersion / eventSequence / sourceTimestamp / tasks / resources / reservations / constraints / dataQuality（org 过滤，单一时间切片）。
   - controller 新增 `GET /api/scheduler/context`；openapi 重生成 + route-manifest。
   - 测试：context 组装、版本字段一致性、org 隔离。
3. **P0-3 Candidate horizon 配置化**：`candidate-engine.service.ts:469` 硬编码 480 改为读取 `SchedulingPolicyConfig.horizonMinutes`（缺省 480 保持现状）；测试配置生效。
4. **P0-4 Route matrix DB 复合唯一键**：migration `standalone_026_route_cost_matrix_full_key` 新增复合唯一索引 `(task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash)`（`CREATE UNIQUE INDEX ... WHERE candidate_set_hash IS NOT NULL`，兼容存量行）；逻辑层写入对齐该 key；测试索引存在 + 逻辑缓存 key 已有单测覆盖。
5. **P0-5 Replan storm guard 跨实例一致性**：`replan-coordinator.service.ts` 风暴守卫/去抖增加 PostgreSQL advisory lock（`pg_try_advisory_lock` on org 稳定 key）与 durable 计数表（复用 `ewoh_replan_trigger` 唯一键或新增 `ewoh_replan_guard` 计数行）；advisory lock 不可用时回退内存态（显式降级）；多实例测试（两个 coordinator 实例共享 DB 断言仅一个获得守卫权）。
6. **P0-6 Run 接口增强 + 核验项**：
   - `CreateRunRequest` 增加 `objectiveProfile?: string`（映射现有 solveVariants A/B/C profile）与 `mode?: 'MANUAL' | 'AUTO' | 'SHADOW'`（SHADOW 不持久化正式 plan 或标记 shadow）；`baselinePlanId` 传入作为 churn 基线（现有 baselineAssignee 机制）。
   - 核验 `world-state.service.ts` station backlog 语义（§八.10）并补回归测试；核验 `version.json` / runtime config 单一事实源（§八.11）。

## Impact

- 受影响代码：
  - `ewoh-spark-app/server/modules/scheduler/`：`scheduler.controller.ts`、`scheduler.service.ts`（createRun 扩展）、`candidate-engine.service.ts`、`replan-coordinator.service.ts`、`travel-cost.service.ts`（矩阵写入 key）、新增 `scheduling-context.service.ts`、`scheduler.module.ts`
  - `ewoh-spark-app/shared/scheduler.ts`（SchedulingContext、CreateRunRequest 扩展、objectiveProfile/mode 类型）
  - `ewoh-spark-app/server/modules/shared/org-context.interceptor.ts`（如需 GUC 兼容名）
  - 新增 `db/migrations/standalone_025_scheduler_rls.{sql,rollback.sql}`、`standalone_026_route_cost_matrix_full_key.{sql,rollback.sql}` + 对应 `db/verify/`
  - 测试：`rls-org-filter.audit.spec.ts`、新增 `scheduling-context.spec.ts`、`candidate-horizon.spec.ts`、`replan-multi-instance.spec.ts`、`route-matrix-key.spec.ts`、cross-org RLS spec
- 受影响既有 spec：`scheduler-prod-convergence`、`command-map-final-acceptance`（已完成，本 spec 在其上增量）。

## ADDED Requirements

### Requirement: Scheduler 表 RLS 兜底隔离
生产调度表 SHALL 启用 PostgreSQL RLS，以 `org_id` 匹配 `app.current_org_id`（或 NULL 全局）实现租户隔离，RLS 作为应用层过滤的最终兜底；GUC 名必须与 `buildGucSettings` 一致，禁止 policy 引用应用未设置的 GUC。

#### Scenario: 跨租户不可见
- **WHEN** org A 请求读取调度 run/plan/assignment/reservation/policy/feedback/constraint
- **THEN** 仅返回 `org_id = A` 或 `org_id IS NULL` 的行；org B 行不可见（RLS 兜底）
- **WHEN** 应用设置 `app.current_org_id`（而非旧名）
- **THEN** policy 正确匹配 org 行（修复 GUC 名不一致 bug）

### Requirement: SchedulingContext 统一版本切片
系统 SHALL 提供 `SchedulingContext`（snapshotVersion/resourceVersion/routeGraphVersion/policyVersion/eventSequence/sourceTimestamp/tasks/resources/reservations/constraints/dataQuality）与 `GET /api/scheduler/context`，所有 Run/Candidate/Plan/Dispatch/Replay 均可关联到同一上下文，避免不同时间切片数据组合成伪"当前状态"。

#### Scenario: 上下文一致读取
- **WHEN** Command Map 拉取 `/api/scheduler/context`
- **THEN** 返回单一 org 切片下版本一致的 tasks/resources/plans/conflicts/dataQuality，各版本字段可审计

### Requirement: Candidate horizon 配置化
Candidate Engine 时间窗 SHALL 使用 `SchedulingPolicyConfig.horizonMinutes`（缺省 480），禁止硬编码常量。

### Requirement: Route matrix DB 全键唯一
`ewoh_route_cost_matrix` SHALL 以逻辑全键 `(task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash)` 建立复合唯一索引，防止不同策略/候选集矩阵互相覆盖。

### Requirement: Replan storm guard 跨实例一致
Replan 风暴守卫/去抖 SHALL 支持 PostgreSQL advisory lock + durable 计数（多 Pod 下同一事件至多一个实例执行有效重排）；advisory lock 不可用时显式降级为内存态并记录 reason。

#### Scenario: 多实例幂等
- **WHEN** 两个 scheduler 实例同时收到同一事件触发
- **THEN** 仅一个实例获得 guard 权并执行重排；另一实例被抑制（idempotent），重复事件不产生多个有效方案

### Requirement: Run 接口 Profile/Mode
`POST /api/scheduler/runs` SHALL 支持 `objectiveProfile`（映射 solveVariants profile）与 `mode: MANUAL | AUTO | SHADOW`（SHADOW 方案不进入正式派工链），并支持 `baselinePlanId` 作为 churn 基线。

## MODIFIED Requirements

### Requirement: 调度租户隔离（原应用层 org 过滤 + 023 约束表 RLS）
由"仅约束表 RLS + 应用层过滤"扩展为"核心调度表 RLS 兜底 + 应用层过滤"；修复 policy GUC 名不一致（`app.primary_org_id` → `app.current_org_id`，兼容回退）；outbox/world_state_snapshot/assignment_event 保持非 RLS（全局 sequence/版本键语义）并在审计测试 allowlist 中文档化。

### Requirement: RouteCost 矩阵持久化（原 uq (task, snapshot) 唯一键）
DB 唯一约束扩展为逻辑全键（兼容存量行：`WHERE candidate_set_hash IS NOT NULL` 部分唯一索引）；逻辑层已版本化的缓存 key 与 DB 键对齐。

## REMOVED Requirements
无（本轮全部为增量/修复）。

## 明确不做（ROADMAP，仅记录，理由见 spec §Why）
- SchedulerService（2203 行）/CommandMap（1164 行）/FactoryMap（1227 行）大文件拆分：遵循 strangler，本轮不做大爆炸重写；仅核验不迁移。
- availability 交集 / tool/material/vehicle 真实模型：条件性需求（"如实际业务需要"），维持现有 ResourceProjectionAdapter 占位。
- CP-SAT canary 放量 / 预测模型迭代：维持 shadow 模式，待 ADR-003。
- 前端 data-quality 五态视觉层：ResourceState 已带 dataQuality/derived，地图视觉深化归入后续 Phase 4。
