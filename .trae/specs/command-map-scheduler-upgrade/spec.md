# Command Map 智能调度升级 — 增量 Deepen Spec

> change-id：`command-map-scheduler-upgrade`
> 日期：2026-08-10 ｜ 依据：用户 25 章需求 + `docs/command-map-upgrade-prd-2026-08-10.md`（Phase 0 完整 + Phase 1 核心已交付）+ 现状核验

## Why

用户提出"指挥地图智能调度升级"。经代码核验，绝大部分基座已在仓库落地（git log T01-T05 已交付，719+ 测试在册）：

- Phase 0：ResourceProjection SSOT、持久化约束生命周期、坐标统一、TaskRequirement 权威化、SSE gap/resync
- Phase 1：PriorityEngine（productionImpact/waiting/event severity/policyVersion）、CandidateEngine（端点与求解器共享语义）、启发式求解器 station 决策、Conflict/局部 Replan、Override Preview、Plan Compare、TravelCost 显式 fallback + 缓存

因此本 spec **不重复修已完成事项**，聚焦经代码确认仍存在的**真实缺口**，以最小、可验证的增量交付，严格遵循"先补测试→改代码→回归"。

**安全/边界不变**：NestJS 是生产调度唯一写 authority；Python Edge advisory-only；Safety hard constraint 永不可被普通 override 绕过；UNKNOWN/STALE 不得自动视为 AVAILABLE；不引入无数据来源的虚假数据。

## What Changes（本轮范围）

1. **P0-4 (真实缺陷) Scheduler SSE 单例化**：当前 `useSchedulerStream()` 在 3 处独立调用（`useCommandMapSchedulerState.ts:60`、`SchedulePanel.tsx:196`、`Scheduling.tsx:125`）→ 会创建多个 SSE 连接。收敛为单一 `SchedulerRealtimeProvider`（context/store），组件经 hook 消费；连接状态补齐 `CONNECTED / DEGRADED / RESYNCING / OFFLINE`；gap→resync 全量拉取 active plans/snapshot/resources/conflicts/routes；轮询兜底刷新全部决策关键 read models。
2. **P0-2 事件影响必须有 scope**：`priority-engine.ts:236-249` 把 `snapshot.events` 的全部 open 事件传给**每个**任务（`events: openEvents` 全局），导致无关 L2/L3 事件影响所有任务。引入 `SchedulingEventImpact`（eventId/severity/affectedTaskIds/affectedPersonIds/affectedDeviceIds/affectedStationIds/affectedZoneIds），PriorityEngine 只消费与当前任务直接或经 zone/resource 传播相关的事件；安全阻断仍 fail-closed。
3. **Phase 6：FreshnessPolicy + ResourceProjectionAdapter**：`resource-projection.service.ts` 已有 freshnessMs/dataQuality，但无按 `resourceType+signalType` 的差异化阈值。新增 FreshnessPolicy（按类型定阈值，`STALE != AVAILABLE`、`UNKNOWN != AVAILABLE`、安全关键任务 fail-closed）；建立 `ResourceProjectionAdapter` 接口（Personnel/Device/Station 真实现，Tool/Material/Vehicle 为显式 NOT_AVAILABLE/UNKNOWN 占位，不虚构数据）。
4. **Phase 7：RouteCost 缓存 key 版本化**：`travel-cost.service.ts:118` 目前仅按 `(taskId, snapshotVersion)` 读缓存，缺 `policyVersion/routeGraphVersion/candidateSetHash`，存在错误复用矩阵风险。补齐 key 维度。
5. **Phase 11：PredictionProvider 接口（shadow 模式）**：新增接口 `predictTaskDuration/predictTravelTime/predictBatteryConsumption/predictStationQueueTime/predictExecutionRisk/predictFatigueRisk`，返回带 `modelVersion/confidence/source`；不可用/低置信度时自动 fallback 到版本化 deterministic baseline；仅为 Optimizer 输入，不替代 hard constraints、不写生产调度。
6. **PriorityDecision 富化**：在现有 `PriorityResult`（score/level/factors/explanation/policyVersion）基础上，补 `rank` 与 `reasonCodes[]`，供 Candidate API / Heuristic / CP-SAT 消费同一规则。

## Impact

- 受影响代码：
  - `ewoh-spark-app/server/modules/scheduler/priority-engine.ts`（scope 化 + PriorityDecision）
  - `ewoh-spark-app/server/modules/scheduler/world-state.service.ts`（snapshot 携带 SchedulingEventImpact）
  - `ewoh-spark-app/server/modules/scheduler/resource-projection.service.ts`（FreshnessPolicy + Adapter）
  - `ewoh-spark-app/server/modules/scheduler/travel-cost.service.ts`（cache key 版本化）
  - 新增 `ewoh-spark-app/server/modules/scheduler/prediction/prediction-provider.ts`（接口 + deterministic baseline）
  - `ewoh-spark-app/shared/scheduler.ts` / `shared/api.interface.ts`（新增共享类型）
  - `ewoh-spark-app/client/src/hooks/useSchedulerStream.ts`（单例化入口）
  - 新增 `ewoh-spark-app/client/src/scheduler/SchedulerRealtimeProvider.tsx`（context/provider）
  - `ewoh-spark-app/client/src/pages/CommandMap/hooks/useCommandMapSchedulerState.ts`、`panels/SchedulePanel.tsx`、`pages/Scheduling/Scheduling.tsx`（改消费 Provider）
- 受影响既有 spec：`command-map-scheduling-cockpit`、`cmd-map-intelligent-scheduling`（已交付基座，本 spec 在其上增量）。

## ADDED Requirements

### Requirement: Scheduler SSE 单例实时 Provider
系统 SHALL 提供唯一 `SchedulerRealtimeProvider`，整个页面树只建立一条 `GET /api/scheduler/v2/stream` 连接；组件通过 context hook 消费，禁止各面板分别调用 `useSchedulerStream` 创建独立连接。

#### Scenario: 单连接 + 状态可视
- **WHEN** CommandMap 与 SchedulePanel 同时挂载
- **THEN** 只存在一条 SSE 连接；连接状态在 `CONNECTED / DEGRADED / RESYNCING / OFFLINE` 间切换，UI 展示 connection state / last event time / snapshotVersion / stale 警告。

#### Scenario: sequence gap 全量恢复
- **WHEN** SSE 检测到 sequence 缺口
- **THEN** 暂停应用不可信 delta，依次拉取 authoritative snapshot / active plans / unified resources / conflicts / routes，完成后恢复增量。

### Requirement: SchedulingEventImpact scoped 事件
系统 SHALL 在 WorldStateSnapshot 中保留 `SchedulingEventImpact`（eventId/severity/affectedTaskIds/affectedPersonIds/affectedDeviceIds/affectedStationIds/affectedZoneIds），PriorityEngine 只据此消费与当前任务直接或经 zone/resource 传播相关的事件。

#### Scenario: 无关安全事件不改变 priority
- **WHEN** 存在与任务无任何关联的 L2/L3 事件
- **THEN** 该任务 priority score/factors 不受影响；相关 person/device/zone 事件正确影响；L2/L3 仍阻断安全对于的资源；resolved 事件不继续影响新计划。

### Requirement: FreshnessPolicy + ResourceProjectionAdapter
系统 SHALL 提供按 `resourceType + signalType` 差异化阈值的 FreshnessPolicy，并定义 `ResourceProjectionAdapter`（Personnel/Device/Station 真实接入；Tool/Material/Vehicle 显式 NOT_AVAILABLE/UNKNOWN 占位）。

#### Scenario: STALE/UNKNOWN 不可视为可用
- **WHEN** 某资源 freshness 超过其类型阈值或坐标未知
- **THEN** 该资源标记 STALE/UNKNOWN，不得自动视为 AVAILABLE；安全关键任务 fail-closed。

### Requirement: PredictionProvider（shadow only）
系统 SHALL 提供 `PredictionProvider` 接口并默认使用版本化 deterministic baseline；预测结果仅作 Optimizer 输入参数，不替代 hard constraints、不写生产调度；每个预测记录 `modelVersion/confidence/source`。

#### Scenario: 预测不可用自动回退
- **WHEN** 预测服务不可用或 confidence 不足
- **THEN** 自动 fallback 到 deterministic baseline，调度仍可确定性重放。

## MODIFIED Requirements

### Requirement: RouteCost 缓存 key 版本化（原 (taskId, snapshotVersion)）
将 `travel-cost.service.ts` 的缓存判读键扩展为 `snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash`，避免不同候选集合/策略错误复用矩阵；命中条件保持"候选数不缺"。

### Requirement: PriorityDecision 输出（原 PriorityResult）
在现有 `PriorityResult` 基础上新增 `rank` 与 `reasonCodes[]`，保持 score/level/factors/explanation/policyVersion 不变（向后兼容），Heuristic 与 CP-SAT 消费同一决策结果。

## REMOVED Requirements
无（本轮无移除，全部为增量/修复）。

## 明确不做（ROADMAP，仅记录）
- Phase 3 CP-SAT Canary 灰度激活：占位，待 shadow 一轮评估 + 人工 activate（ADR-003）。
- Phase 12 拆分 SchedulerService/CommandMap 巨型文件：遵循 strangler，本轮不动超 900 行组件，避免大爆炸回归。
- 前端重算后端权威调度逻辑/引入无来源虚假工厂数据：禁止。