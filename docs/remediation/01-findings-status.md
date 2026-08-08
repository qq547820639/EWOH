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
| P0-EDGE-006 | P0 | VERIFIED | commit 1 | 2026-08-08 | tests/test_production_assembly.py 5 passed；Makefile production-smoke；CI 门禁已加 |
| P0-SEC-001 | P0 | VERIFIED | commit 2 | 2026-08-08 | Feishu webhook 验签（token+timestamp+Encrypt-Key+replay，fail-closed）；13 个安全测试通过；本轮独立复核通过 |
| P0-SEC-002 | P0 | VERIFIED | commit 2 | 2026-08-08 | Simulator 默认关闭；production 双开关；本轮独立复核通过 |
| P0-SEC-003 | P0 | VERIFIED | commit 2 | 2026-08-08 | CORS 显式 allowlist（禁止 * + credentials）；本轮独立复核通过 |
| P0-SCHED-001 | P0 | VERIFIED | commit 4 | 2026-08-08 | CP-SAT 默认 UNAVAILABLE，fallback 显式标记，四态测试通过 |
| P0-SCHED-002 | P0 | VERIFIED | commit 4 | 2026-08-08 | DecisionTrace 使用真实 PriorityEngine 结果；占位 0/[] 已移除；本轮复核 UNKNOWN 显式 |
| P1-SCHED-003 | P1 | VERIFIED | commit 8 | 2026-08-08 | PolicyConfig 全部参数；routing edgeCost 改用 policy factors |
| P1-SCHED-004 | P1 | VERIFIED | commit 4 | 2026-08-08 | Dispatch fallback 时长 = policy.defaultTaskDurationMs |
| P1-ROUTE-001 | P1 | VERIFIED | commit 4 | 2026-08-08 | euclidean ETA = distance / walkingSpeed；3 个新测试 |
| P1-ROUTE-002 | P1 | VERIFIED | commit 4 | 2026-08-08 | RouteCostProvider 已为唯一出口，确认无改动 |
| P1-WORLD-001 | P1 | VERIFIED | commit 6 | 2026-08-08 | getCurrentState 改 DISTINCT ON(entity_id)；本轮复核确认 selectDistinctOn |
| P1-INGEST-001 | P1 | VERIFIED | commit 6 | 2026-08-08 | batch 批量预检+批量 insert；强化"单次 insert"断言；benchmark 脚本 |
| P1-INGEST-002 | P1 | VERIFIED | commit 11 (82f185c) | 2026-08-08 | INGEST_API_KEY 缺失 fail-closed（production 503 + 启动失败）；constant-time compare；compose 必填 |
| P1-CMAP-001 | P1 | VERIFIED | commit 6+10 | 2026-08-08 | 写链 V2；WorkbenchPanel approve/reject 迁移 V2；dead V1 api client 已删 |
| P1-CMAP-002 | P1 | VERIFIED | commit 6+10 | 2026-08-08 | /api/scheduler/resources/state + ResourcePool 消费；person/device/station STALE→unavailable/offline（不虚构） |
| P1-CMAP-003 | P1 | VERIFIED | commit 6 | 2026-08-08 | SSE/polling 分工明确；保留 poll fallback |
| P2-SHARED-001 | P2 | IN_PROGRESS | commit 12 (c3ffce2) | 2026-08-08 | Scheduler 域 47 类型物理移到 shared/scheduler.ts；api.interface 2049→1229 行；@shared/scheduler 可直接导入；其余域待下迭代 |
| P2-WORK-001 | P2 | DEFERRED | | 2026-08-08 | 方法→分类矩阵已输出（07-work-orchestration.md）；work-core 无需（server 复用 tools）；结构拆分需独立迭代 |
| Phase D 复核 | — | VERIFIED | | 2026-08-08 | stale plan / reservation 冲突 / override / 故障注入 / ResourceProjection 数据真实性测试全过 |
| Phase E 复核 | — | VERIFIED | | 2026-08-08 | 可观测性覆盖（scheduler_run_total/fallback/timeout + bus handler metric）；benchmark 脚本 |
