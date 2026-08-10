# Tasks — Command Map 智能调度升级（增量 Deepen）

> 原则：先补测试暴露问题 → 改代码 → 回归。后端改动聚焦 `ewoh-spark-app/server/modules/scheduler/`，前端改动聚焦 `ewoh-spark-app/client/src/`。每个 Task 独立可运行、可验证。

- [x] Task 1: PriorityEngine 事件 scope 化 + PriorityDecision 富化
  - [x] 1.1 在 `shared/scheduler.ts`（或 api.interface.ts）新增 `SchedulingEventImpact` 与 `PriorityDecision`（含 rank/reasonCodes/policyVersion；兼容保留 status）。
  - [x] 1.2 修改 `world-state.service.ts`：快照聚合事件时构建 `eventImpacts: SchedulingEventImpact[]`（从证据链 affectedPersonIds/affectedDeviceIds/affectedZoneIds/affectedStationIds/affectedTaskIds 解析；无证据时按 device→zone→task 传播）。
  - [x] 1.3 修改 `priority-engine.ts`：`computeEffectivePriorityResults` 不再把全部 open 事件传给每个任务；改为按 task 过滤与 `eventImpacts` 直接/传播相关的事件（person/device/station/zone 命中或 evidence 含 taskId）；L2/L3 对命中资源仍 fail-closed。
  - [x] 1.4 `PriorityResult` 增加 `rank` 与 `reasonCodes[]`（base_priority/deadline_risk/waiting_age/production_impact/event_severity/downstream_blocking/manual_boost），保持既有字段不变。
  - [x] 1.5 新增/扩充测试：
    - 无关安全事件不改变任务 priority；
    - 相关 person/device/zone 事件正确影响；
    - L2/L3 safety event 正确阻断；
    - resolved event 不继续影响新计划；
    - PriorityResult 含 rank/reasonCodes。
  - 验证：`npx jest modules/scheduler/__tests__/priority-engine.spec.ts` + 相关 spec 全绿（36 passed）；`npx tsc --noEmit`（server/spec 通过）。

- [x] Task 2: Scheduler SSE 单例 Provider（前端）
  - [x] 2.1 新增 `client/src/scheduler/SchedulerRealtimeProvider.tsx`：context + React Query invalidation，持有唯一 `useSchedulerStream` 连接；暴露 `useSchedulerRealtime()` hook（status/lastEventTime/snapshotVersion/triggerResync）。
  - [x] 2.2 `useSchedulerStream.ts` 状态对齐枚举：`CONNECTED / DEGRADED / RESYNCING / OFFLINE`（映射现有 idle/connecting/live/polling/error，向后兼容导出旧名）。
  - [x] 2.3 gap→resync 全量：确认 invalidation 覆盖 active plans / snapshot / resources / conflicts / routes / plan 详情 / run（现有 `triggerResync` 已含，补 routes 与 snapshotVersion 透出）。
  - [x] 2.4 轮询兜底：SSE 长期不可用时刷新全部决策关键 read models（现有仅 active plans，补 snapshot/resources/conflicts/routes）。
  - [x] 2.5 迁移调用方：`useCommandMapSchedulerState.ts`、`SchedulePanel.tsx`、`Scheduling.tsx` 移除各自 `useSchedulerStream()`，改由 Provider 上抛单连接；CommandMap 顶层挂载 Provider。
  - [x] 2.6 新增前端测试：单连接（同一 Provider 下只建一次）、状态切换、gap resync、polling 兜底刷新范围。
  - 验证：`schedulerRealtimeCore`（16 通过）、`use-command-map-scheduler-state`（2）、`schedule-panel`/`conflict-*`（16）通过；`tsc` 无新错误。

- [x] Task 3: FreshnessPolicy + ResourceProjectionAdapter
  - [x] 3.1 `shared/scheduler.ts` 新增 `FreshnessPolicy`（resourceType+signalType → thresholdMs）与 `ResourceProjectionAdapter` 类型。
  - [x] 3.2 `resource-projection.service.ts`：引入 FreshnessPolicy 判定帧（默认阈值表，可按类型覆盖）；stale/unknown 资源标记 `status=STALE/UNKNOWN`，不得自动 AVAILABLE；安全关键任务（safetyCritical）fail-closed。
  - [x] 3.3 新增 `resource-adapters.ts`：`ResourceProjectionAdapter` 接口 + Personnel/Device/Station 实现（复用现有投影数据源）；Tool/Material/Vehicle 返回显式 `NOT_AVAILABLE/UNKNOWN` 占位（不虚构数据、不查不存在的表）。
  - [x] 3.4 新增测试：不同类型阈值差异、stale 不视为 available、unknown 坐标不视为 available、safetyCritical fail-closed、adapter 占位语义。
  - 验证：`resource-state` + `resource-freshness`（19 通过）；全量 scheduler 429 tests 通过。

- [x] Task 4: RouteCost 缓存 key 版本化
  - [x] 4.1 `travel-cost.service.ts`：`getCachedMatrix` 判读 key 从 `(taskId, snapshotVersion)` 扩展为 `snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash`；命中仍要求候选数不缺。
  - [x] 4.2 candidateSetHash 从候选 id 有序拼接 + 稳定哈希生成（确定性）。
  - [x] 4.3 OpenAPI/route-manifest 如受影响同步重生成；`shared` 类型若涉及矩阵 key 字段同步。
  - [x] 4.4 新增测试：不同 policyVersion/candidateSetHash 不复用矩阵；相同输入命中缓存；确定性哈希。
  - 验证：`travel-cost.spec.ts`（10/10 通过）；`tsc` 通过。

- [x] Task 5: PredictionProvider（shadow only）
  - [x] 5.1 新增 `server/modules/scheduler/prediction/prediction-provider.ts`：接口 `predictTaskDuration/predictTravelTime/predictBatteryConsumption/predictStationQueueTime/predictExecutionRisk/predictFatigueRisk`，返回 `{ value, modelVersion, confidence, source }`；默认 `DeterministicPredictionProvider`（版本化 baseline，不依赖外部服务）。
  - [x] 5.2 在 `scheduler.module.ts` 注册（作为可选 provider）；求解器/候选仅当 confidence 达标时采用预测值，否则回退 baseline；不写生产调度。
  - [x] 5.3 新增测试：接口契约、confidence 不足回退、不可用回退、确定性重放、shadow 不写库。
  - 验证：`prediction-provider.spec.ts`（10/10 通过）；未接入 solver（shadow-only 保确定性）。

- [x] Task 6: 回归与契约
  - [x] 6.1 运行 `npx jest modules/scheduler` 全量（429 passed/57 suites）+ 客户端 scheduler 相关（22 passed）+ 全量 client（717 passed）+ `tsc --noEmit`（server/client 通过）+ 本次改动文件 eslint 全绿。既有测试不退化。
  - [x] 6.2 本次 `shared/scheduler.ts` 变更均为纯 TS 类型（SchedulingEventImpact/PriorityDecision/FreshnessPolicy/ResourceProjectionAdapter），未暴露为 HTTP DTO，无需重生成 `openapi/route-manifest.json` 与前端 `types/openapi.d.ts`。`openapi:no-drift` 失败与 `constraint-loader.service.ts` 的 lint error 均为 `main` 上既有问题（非本次改动引入），已核验不是本次改动所致。
  - [x] 6.3 提交并推送 `main`（项目约定；排除调试残留）。

# Task Dependencies
- [Task 1] 无依赖（共享类型先行）。
- [Task 2] 依赖 [Task 1] 的 contract（envelope/snapshotVersion 透出）；并行于 [Task 3-5]。
- [Task 3] 依赖 [Task 1]（shared 类型）。
- [Task 4] 无依赖；并行于 [Task 2/3/5]。
- [Task 5] 依赖 [Task 1]（shared 类型）。
- [Task 6] 依赖全部。