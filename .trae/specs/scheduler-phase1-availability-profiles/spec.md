# Scheduler Phase 1 — 资源时间窗 / 数据真实性与版本化 Profile（Availability & Profiles）Spec

> change-id：`scheduler-phase1-availability-profiles`
> 日期：2026-08-10 ｜ 依据：用户第六次提交需求（§一~§十一，含"Phase 0 Recovery + Phase 1"）+ 对 origin/main（HEAD=10da903）逐项源码核验
> 前置 spec（已完成并推送）：`scheduler-prod-convergence`（60c7808）、`command-map-final-acceptance`（87988a1）、`scheduler-phase0-truth-context`（4bbbbb8 + 10da903）

## 为什么不需要 Phase 0 Recovery（源码核验矩阵）

按用户要求执行 `git fetch/pull --ff-only` 后 HEAD=10da903，commit `4bbbbb8`（Phase 0 六项）+ `10da903`（文档）均在 origin/main。逐项源码核验（非日志）：

| Phase 0 项 | 源码证据（origin/main） | 结论 |
|---|---|---|
| 1. Migration 025/026 | `db/migrations/standalone_025_scheduler_rls.sql`、`standalone_026_route_cost_matrix_full_key.sql` 存在 | ✅ 已交付 |
| 2. SchedulingContext | `scheduler.controller.ts:93 @Get('context')` + `scheduling-context.service.ts` 存在 | ✅ 已交付 |
| 3. Candidate horizon | `candidate-engine.service.ts:124` `buildTimeWindows(task, fullState, config.horizonMinutes)`，`(horizonMinutes ?? 480)` 为配置缺省 | ✅ 已交付 |
| 4. Route Matrix 全键 | 026：`ADD COLUMN route_graph_version/candidate_set_hash` + partial unique index 5 维 | ✅ 已交付 |
| 5. Replan advisory lock | `replan-coordinator.service.ts:165` `pg_try_advisory_xact_lock(hashtext('<org>:replan_guard'))` | ✅ 已交付 |
| 6. Run API | `shared/api.interface.ts:1177-1188` `CreateRunRequest.objectiveProfile/mode(SHADOW)/baselinePlanId` | ✅ 已交付 |

用户"多项功能不存在或已回退"的判断基于过时信息；本 spec 不再重复 Phase 0，直接进入 **Phase 1 真实增量**。

## Phase 1 核验结论（本轮真实缺口）

| 需求（用户章节） | 现状（源码证据） | 结论 |
|---|---|---|
| §四 真实资源时间窗交集 | `ewoh_personnel.shift varchar(100)`（schema.ts:450，无时间语义）；**无 device maintenance window 字段/表**；availableWindows 主要来自 reservation 扣减 | ⚠️ 缺口 |
| §五 资源数据真实性 source 双维度 | `ResourceState` 有 `dataQuality(FRESH/STALE/UNKNOWN)` + `derived: string[]`，**无独立 `source: AUTHORITATIVE/DERIVED`**；无 safety-critical 对 DERIVED/UNKNOWN 的 fail-close 策略 | ⚠️ 缺口 |
| §六 版本化 Policy Profile | `solver.service.ts:88-130` profiles 硬编码数组（A/B/C：准时优先/负荷均衡/综合平衡），未版本化 | ⚠️ 缺口 |
| §八 Command Map 接入 /context | `CommandMap.tsx` 无 schedulerContext 引用；无版本一致/STALE CONTEXT 指示 | ⚠️ 缺口 |
| §九 人工干预 CAS | `PLAN_STALE` 冲突类型与 dispatch CAS 已存在；override/approve 的 expectedPlanVersion/expectedSnapshotVersion 结构化校验需核验补齐 | ⚠️ 部分缺口 |
| §七 CP-SAT 生产化准备 | worker contract/fallback/shadow eval 已存在（cp-sat-contract.spec.ts、shadow-evaluator）；worker health/benchmark 属观测增强 | ✅ 大体已交付（本轮不动） |

## What Changes（本轮范围 = Phase 1 五项收敛）

1. **P1-A 资源时间窗交集**：
   - 新增 device maintenance window 契约：schema 增量列 `maintenance_start_ms/maintenance_end_ms`（或等价 jsonb windows）+ migration `standalone_027_resource_time_windows`；`resource-projection.service.ts` 投影进 ResourceState（`maintenanceWindows`）。
   - Candidate availability 交集升级：Task Window ∩ Scheduling Horizon ∩ Person Shift（无时间语义时**不参与硬交集**，文档化契约）∩ Person availableWindows ∩ Person Reservations ∩ Certification Validity ∩ Device availableWindows ∩ Device Maintenance Window ∩ Device Reservations ∩ Station availableWindows ∩ Station Capacity ∩ Station Reservations；以真实数据取交集，缺数据显式 UNKNOWN 不伪造；不可用资源不用评分弥补。
   - 测试：时间窗交集（含 maintenance 窗口排除、cert 有效期排除、shift 无语义不参与）。
2. **P1-B ResourceState source 双维度**：
   - `ResourceState` 新增 `source?: 'AUTHORITATIVE' | 'DERIVED'`（与 `dataQuality` 独立维度）；world-state/resource-projection 对派生字段标 `source='DERIVED'` 并保留 `derived[]` 明细。
   - safety-critical fail-close：安全关键任务候选评估中，UNKNOWN/STALE 或关键 DERIVED（位置/能力/availability）→ 候选不可派（`rejectReason`），并补策略说明。
   - 测试：source 与 dataQuality 正交、safetyCritical + UNKNOWN/STALE/DERIVED 拒绝。
3. **P1-C 版本化 Policy Profile**：
   - `SchedulingPolicyConfig` 新增 `profiles?: Record<string, { label: string; scale: Partial<ObjectiveWeights> }>`（ON_TIME/PRODUCTION_IMPACT/WORKLOAD_BALANCE/TRAVEL_MIN/MIN_CHURN/BALANCED，缺省=BALANCED=不缩放），版本化可审计。
   - `solver.service.ts solveVariants` 从配置读取 profile（替代硬编码数组，兼容缺省 A/B/C 语义：A=ON_TIME、B=WORKLOAD_BALANCE、C=BALANCED）；plan 记录 profileId/profileVersion。
   - 测试：每个 profile 产出不同 objectiveWeights 且可审计；profile 不影响 hard constraints；缺省行为回归。
4. **P1-D Command Map 接入 /context + 版本一致指示**：
   - client `api/scheduler.ts` 增加 `getSchedulerContext()`；`useCommandMapSchedulerState` 或顶层拉取 context。
   - Command Map 显示 snapshotVersion/resourceVersion/routeGraphVersion/policyVersion/asOf/SSE sequence；当 Plan 与 Resource 版本不一致时显示 `STALE CONTEXT`（不静默混合）。
   - 测试：hook 拉取 context、版本不一致 → stale 标记。
5. **P1-E 人工干预 CAS 补齐**：
   - 核验 override/approve/retime 现有版本校验；为缺失的 mutation 增加 `expectedPlanVersion`/`expectedSnapshotVersion` 可选入参，过期返回结构化 `STALE_PLAN`/`STALE_SNAPSHOT`（沿用 ConflictException 语义），不自动应用。
   - 测试：旧版本 override/approve 被拒；新版本正常。

## Impact

- 受影响代码：
  - `ewoh-spark-app/server/modules/scheduler/`：`candidate-engine.service.ts`、`eligibility.service.ts`、`resource-projection.service.ts`、`world-state.service.ts`、`solver.service.ts`、`plan.service.ts`、`scheduler.service.ts`（override CAS）、`scheduling-policy.service.ts`（profiles 配置）、`scheduler.module.ts`
  - `ewoh-spark-app/shared/scheduler.ts`（ResourceState.source、SchedulingPolicyConfig.profiles、maintenanceWindows、version CAS 类型）
  - `ewoh-spark-app/client/src/`：`api/scheduler.ts`、`pages/CommandMap/`（context 拉取与版本一致指示）
  - 新增 `db/migrations/standalone_027_resource_time_windows.{sql,rollback.sql}` + `db/verify/`
  - 测试：新增 availability-intersection / resource-source / policy-profile / context-version / override-cas spec + client hook/组件测试
- 受影响既有 spec：`scheduler-phase0-truth-context`（已完成，本 spec 在其上增量）。

## ADDED Requirements

### Requirement: 资源时间窗真实交集
Candidate availability SHALL 以真实数据取交集（Task Window ∩ Horizon ∩ Shift[有时间语义时] ∩ Person availableWindows/Reservations/CertValidity ∩ Device availableWindows/Maintenance/Reservations ∩ Station availableWindows/Capacity/Reservations）；无真实 backing data 的约束不得伪造，不可用资源不得用评分弥补。

#### Scenario: maintenance/cert 窗口排除
- **WHEN** 设备处于 maintenance 窗口或人员证书过期
- **THEN** 对应候选不可派（结构化拒绝原因），时间窗交集不包含该区间

### Requirement: ResourceState source 双维度
资源状态 SHALL 同时携带 `source: AUTHORITATIVE | DERIVED`（字段来源）与 `dataQuality: FRESH | STALE | UNKNOWN`（新鲜度）两个正交维度；safety-critical 任务对 UNKNOWN/STALE/关键 DERIVED 事实 fail-close。

#### Scenario: 派生数据不冒充权威
- **WHEN** 设备位置为派生值（如型号白名单能力）或新鲜度非 FRESH
- **THEN** source=DERIVED / dataQuality=STALE 明确标注；safety-critical 候选评估拒绝该资源

### Requirement: 版本化 Policy Profile
求解目标 SHALL 通过版本化 `SchedulingPolicyConfig.profiles` 提供（ON_TIME/PRODUCTION_IMPACT/WORKLOAD_BALANCE/TRAVEL_MIN/MIN_CHURN/BALANCED），每个 profile 落到 objectiveWeights + policyVersion + profileVersion；profile 只影响 soft objective，绝不改变 hard constraints。

#### Scenario: Profile 可审计
- **WHEN** 选择 ON_TIME profile 求解
- **THEN** plan 记录 profileId/profileVersion 与对应 objectiveWeights，可确定性重放；切换 BALANCED 不改 hard 行为

### Requirement: Command Map 版本一致上下文
Command Map SHALL 消费 `GET /api/scheduler/context` 作为调度态统一版本边界，展示各版本字段；Plan 与 Resource 版本不一致时显式显示 `STALE CONTEXT`，禁止静默混合不同版本数据。

### Requirement: 人工干预版本 CAS
Override/approve/retime SHALL 支持 `expectedPlanVersion`/`expectedSnapshotVersion` 可选入参；过期返回结构化 `STALE_PLAN`/`STALE_SNAPSHOT`，不自动应用。

## MODIFIED Requirements

### Requirement: Solver 多方案（原 solveVariants 硬编码 A/B/C profiles）
由 SolverService 硬编码 profile 数组迁移为版本化 `SchedulingPolicyConfig.profiles`（A=ON_TIME、B=WORKLOAD_BALANCE、C=BALANCED 语义兼容）；plan 记录 profileId/profileVersion。

### Requirement: ResourceState（原 dataQuality + derived[]）
新增 `source: AUTHORITATIVE | DERIVED` 独立维度；`derived[]` 保留为明细。

## REMOVED Requirements
无（本轮全部为增量/修复）。

## 明确不做（ROADMAP，仅记录）
- CP-SAT 生产化（worker health/benchmark/canary）：已有 contract/fallback/shadow，放量按 ADR-003。
- tool/material/vehicle 真实资源：schema 无对应表，不伪造（用户 §五 明确"暂时不要伪造"）。
- SchedulerService/CommandMap 大文件拆分：strangler，本轮仅在自然边界处（context/profile）抽取，不做大爆炸。
- Redis 协调：不引入（advisory lock 已满足，用户 §一.5 允许）。
