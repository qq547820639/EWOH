# ADR-002: 事件驱动智能重排（局部重排 + 世界状态级联）

## Status: Accepted (2026-08-08)

## Background
走读发现 13 类 trigger 仅 MANUAL 走真实链路；`ReplanCoordinatorService.handleTrigger`
已实现局部重排（影响分析 → 冻结无关任务 → 子图求解 → 熔断）但无业务入口。
任务/路由/预占变化不会自动触发重排，调度是"按下才转"。

## Decision
- `POST /api/scheduler/events` 事件注入端点（M2M），`injectSchedulingEvent` service 层入口：
  事件 → 局部重排（仅重排受影响任务，无关任务不 churn）→ 世界状态级联
  （routeStatus blocked/congested + reservation 冲突 → scoped 重排，TriggerService 冷却去抖防风暴）
- 与 `POST /runs`（MANUAL 全量重排）形成「手动全量 / 事件局部」双路径
- 幂等 + 冷却由 TriggerService 保证（triggerKey 去重 + 冷却窗口，跨进程可靠）
- 失败熔断：run 置 failed + 日志，不抛错阻断事件源（真机数据接入优先）
- ingest 设备故障/离线转换自动触发 DEVICE_OFFLINE 重排（fire-and-forget）

## Consequences
- 正面：任务/路由/预占变化自动触发重排；事件路径开销小（局部子图）；事件源不阻塞
- 负面：级联可能触发多次 scoped 重排（受冷却去抖限制）；行为变化最大的一批，需影子评估后激活
- 安全：SAFETY_BLOCK 派工熔断（dispatch 拒绝涉及 L2/L3 阻断资源的派工）不可被覆盖绕过

## Related ADRs
ADR-001（权重收敛）、ADR-003（CP-SAT worker）
