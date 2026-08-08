# 01 - Findings Status

Status ledger. One line per finding, updated as work progresses.
See `00-baseline.md` for the status vocabulary.

| ID | Sev | Status | Fixed In | Verified In | Notes |
| -- | --- | ------ | -------- | ----------- | ----- |
| P0-EDGE-001 | P0 | VERIFIED | commit 1 | 2026-08-08 | 真实装配通过 runtime/bootstrap；run.py 顶层 import 已修复；edge/storage.py+manager.py 已建 |
| P0-EDGE-002 | P0 | VERIFIED | commit 1 | 2026-08-08 | RuntimeMode production/development/simulation；production 失败 fail-fast 实测 |
| P0-EDGE-003 | P0 | VERIFIED | commit 1 | 2026-08-08 | 唯一 handler 契约；stubs.Bus 对齐；协议测试通过 |
| P0-EDGE-004 | P0 | VERIFIED | commit 1 | 2026-08-08 | ALL_STREAMS 统一；inference/device_status/world_state 已登记 |
| P0-EDGE-005 | P0 | VERIFIED | commit 1 | 2026-08-08 | 异常记录 logger + event_bus_handler_errors_total metric |
| P0-EDGE-006 | P0 | VERIFIED | commit 1 | 2026-08-08 | tests/test_production_assembly.py 5 passed；Makefile production-smoke |
| P0-SEC-001 | P0 | IN_PROGRESS | | | Feishu webhook 验签待实施 |
| P0-SEC-002 | P0 | IN_PROGRESS | | | Feishu simulator 默认关闭待实施 |
| P0-SEC-003 | P0 | IN_PROGRESS | | | Feishu CORS allowlist 待实施 |
| P0-SCHED-001 | P0 | VERIFIED | commit 4 | 2026-08-08 | CP-SAT 默认 UNAVAILABLE，fallback 显式标记，四态测试通过 |
| P0-SCHED-002 | P0 | VERIFIED | commit 4 | 2026-08-08 | DecisionTrace 使用真实 PriorityEngine 结果；占位 0/[] 已移除 |
| P1-SCHED-003 | P1 | OPEN | | | Policy magic numbers 集中化（部分已随 P1-SCHED-004 收敛） |
| P1-SCHED-004 | P1 | VERIFIED | commit 4 | 2026-08-08 | Dispatch fallback 时长 = policy.defaultTaskDurationMs |
| P1-ROUTE-001 | P1 | VERIFIED | commit 4 | 2026-08-08 | euclidean ETA = distance / walkingSpeed；3 个新测试 |
| P1-ROUTE-002 | P1 | VERIFIED | commit 4 | 2026-08-08 | RouteCostProvider 已为唯一出口，确认无改动 |
| P1-WORLD-001 | P1 | VERIFIED | commit 6 | 2026-08-08 | getCurrentState 改 DISTINCT ON(entity_id) |
| P1-INGEST-001 | P1 | VERIFIED | commit 6 | 2026-08-08 | batch 批量预检+批量 insert；4 个回归测试 |
| P1-CMAP-001 | P1 | VERIFIED | commit 6 | 2026-08-08 | 写链已收敛 V2；gamification 标注 deprecated |
| P1-CMAP-002 | P1 | VERIFIED | commit 6 | 2026-08-08 | /api/scheduler/resources/state 暴露 + ResourcePool 消费投影 |
| P1-CMAP-003 | P1 | VERIFIED | commit 6 | 2026-08-08 | SSE/polling 分工明确；保留 poll fallback |
| P2-SHARED-001 | P2 | OPEN | | | |
| P2-WORK-001 | P2 | OPEN | | | |
