# Checklist — Command Map 智能调度升级（增量 Deepen）

## Task 1：PriorityEngine 事件 scope + PriorityDecision
- [ ] `SchedulingEventImpact` 与 `PriorityDecision` 共享类型已定义（含 rank/reasonCodes/policyVersion）
- [ ] WorldStateSnapshot 携带 `eventImpacts`（含 affectedTaskIds/PersonIds/DeviceIds/StationIds/ZoneIds）
- [ ] PriorityEngine 只消费与当前任务直接或经 zone/resource 传播相关的事件
- [ ] 无关安全事件不改变任务 priority（测试）
- [ ] 相关 person/device/zone 事件正确影响任务（测试）
- [ ] L2/L3 safety event 正确阻断资源（测试）
- [ ] resolved event 不继续影响新计划（测试）
- [ ] PriorityResult 含 rank 与 reasonCodes[]，既有字段向后兼容

## Task 2：Scheduler SSE 单例 Provider
- [ ] 存在唯一 `SchedulerRealtimeProvider`，页面树只建立一条 SSE 连接
- [ ] CommandMap / SchedulePanel / Scheduling 不再各自调用 `useSchedulerStream` 创建连接
- [ ] 连接状态枚举 `CONNECTED / DEGRADED / RESYNCING / OFFLINE` 可用并展示
- [ ] sequence gap 时暂停增量并全量拉取 snapshot/active plans/resources/conflicts/routes 后恢复
- [ ] SSE 长期不可用时轮询兜底刷新全部决策关键 read models（非仅 active plans）
- [ ] UI 展示 connection state / last event time / snapshotVersion / stale 警告
- [ ] 前端测试：单连接、状态切换、gap resync、polling 兜底范围

## Task 3：FreshnessPolicy + ResourceProjectionAdapter
- [ ] `FreshnessPolicy` 按 resourceType+signalType 差异化阈值
- [ ] stale/unknown 资源不得自动视为 AVAILABLE（测试）
- [ ] 安全关键任务 fail-closed（测试）
- [ ] `ResourceProjectionAdapter` 接口 + Personnel/Device/Station 实现；Tool/Material/Vehicle 显式 NOT_AVAILABLE/UNKNOWN 占位
- [ ] 既有 `resource-state.spec.ts` 不退化

## Task 4：RouteCost 缓存 key 版本化
- [ ] 缓存判读 key = snapshotVersion + policyVersion + routeGraphVersion + taskId + candidateSetHash
- [ ] candidateSetHash 确定性生成；命中条件保持候选数不缺
- [ ] 不同 policyVersion/candidateSetHash 不复用矩阵（测试）；相同输入命中缓存（测试）
- [ ] OpenAPI/route-manifest 同步（如受影响）

## Task 5：PredictionProvider（shadow only）
- [ ] `PredictionProvider` 接口 + `DeterministicPredictionProvider` baseline 已实现
- [ ] 预测返回 `{ value, modelVersion, confidence, source }`
- [ ] 预测不可用/低置信度自动回退 baseline（测试）；shadow 不写生产调度
- [ ] 调度仍可确定性重放（测试）

## Task 6：回归与提交
- [x] `npx jest modules/scheduler` 全量全绿（既有 719+ 不退化）
- [x] `npx tsc --noEmit` + lint 通过（本次改动文件；仓库既有 lint/openapi 问题非本次引入）
- [x] 契约变更同步 openapi & 前端类型（如涉及）——本次为纯 TS 类型，无需同步
- [x] 已提交并推送 `main`（排除调试残留）