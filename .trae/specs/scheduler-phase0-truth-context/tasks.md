# Tasks — Scheduler Phase 0 事实源与安全一致性（scheduler-phase0-truth-context）

> 原则：先核验现状 → 补测试暴露问题 → 改代码 → 回归。只收敛 Phase 0 的 6 项真实缺口，其余交付/条件性需求不重复实现。每个 Task 独立可运行、可验证，完成后立即跑相关测试。

- [x] Task 1: Scheduler DB RLS audit/fix + 覆盖（P0-1）
  - [x] 1.1 审计：逐表确认 scheduler 域表 org 列，输出清单（发现 `ewoh_schedule_plan` 缺 org_id 列，025 补齐；outbox/snapshot/assignment_event 保留非 RLS）。
  - [x] 1.2 修复 GUC 名不一致：025 policy 读 `app.current_org_id`（COALESCE 兼容旧名 `app.primary_org_id` 回退），与 buildGucSettings 一致。
  - [x] 1.3 新增 `standalone_025_scheduler_rls.{sql,rollback.sql}` + verify：8 张 org-scoped 表 ENABLE RLS + `scheduler_<t>_org_isolation` policy（USING/WITH CHECK + GUC 回退，TO service_role，幂等）+ GRANT；非 RLS 表注释说明。
  - [x] 1.4 更新 `rls-org-filter.audit.spec.ts`：NON_RLS_TABLES 收敛为 3 张 + allowlist 清理。
  - [x] 1.5 新增 `rls-policy.spec.ts`（6 用例）：RLS 启用断言、GUC 名一致性断言、cross-org 三条读路径过滤。
  - [x] 验证：rls-org-filter.audit + rls-policy 全绿（10/10）；tsc 零错误。
  - [x] 集成期补充修复：`ewohSchedulePlan` drizzle schema 补 orgId 列；persistPlan 与两处 scheduling_constraint insert 补写 org_id（原先未写，RLS 会空转）。

- [x] Task 2: SchedulingContext 统一上下文 + GET /api/scheduler/context（P0-2）
  - [x] 2.1 `SchedulingContext`/`SchedulingContextResponse` 类型已新增（版本字段齐全）。
  - [x] 2.2 新增 `scheduling-context.service.ts`：单一 org 切片组装（snapshot/resource/route/policy/eventSequence/constraints/dataQuality 真实取值）。
  - [x] 2.3 `GET /api/scheduler/context` 已暴露（org 隔离）；scheduler.module.ts 注册。
  - [x] 2.4 openapi 确认：纯内部 TS 类型，`openapi:no-drift` 通过，无需重生成。
  - [x] 2.5 `scheduling-context.spec.ts`（5 用例）通过。

- [x] Task 3: Candidate horizon 配置化（P0-3）
  - [x] 3.1 `candidate-engine.service.ts` 时间窗 helper 硬编码 480 → `config.horizonMinutes`（缺省 480）；Grep 确认无其他生产路径硬编码。
  - [x] 3.2 新增 2 用例（horizon=120 生效 / 缺省 480 回归）。

- [x] Task 4: Route matrix DB 全键唯一（P0-4）
  - [x] 4.1 `standalone_026_route_cost_matrix_full_key.{sql,rollback.sql}` + verify：部分唯一索引 `(task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash) WHERE candidate_set_hash IS NOT NULL`；补列 + 旧索引保留。
  - [x] 4.2 travel-cost `persistMatrix` 补写 routeGraphVersion/candidateSetHash（原先仅编码在 matrixId 前缀）。
  - [x] 4.3 `route-matrix-key.spec.ts`（5 用例）+ travel-cost.spec.ts（+1）通过。

- [x] Task 5: Replan storm guard 跨实例一致性（P0-5）
  - [x] 5.1 `evaluateStormGuard` 增加 `pg_try_advisory_xact_lock(hashtext('<org>:replan_guard'))`（事务级，提交自动释放；db.execute 抛错 → logger.warn 显式降级内存态）。
  - [x] 5.2 durable 幂等确认：`ewoh_replan_trigger.triggerKey` unique 已覆盖 (org, triggerType, entityId)，无需新增 migration。
  - [x] 5.3 `replan-multi-instance.spec.ts`（5 用例）：双实例仅一个获守卫权、降级路径、durable 幂等（顺序/并发唯一约束）。

- [x] Task 6: Run 接口增强 + 核验项（P0-6）
  - [x] 6.1 `CreateRunRequest`（api.interface.ts）新增 objectiveProfile / mode(MANUAL|AUTO|SHADOW) / baselinePlanId（可选）；createRun 按 profile 筛单变体、SHADOW 不 persistPlan、baselinePlanId 作 churn 基线。
  - [x] 6.2 station backlog 语义核验并修正：原为"工位全量任务数且键名错位"→ 修正为 `queue.length`（排队任务数），消费方兼容；world-state-derive.spec.ts 补断言。
  - [x] 6.3 version.json 单一事实源核验：0.6.0-rc4 与 package.json/helm/compose 一致；无冲突。
  - [x] 6.4 `scheduler-run-profile.spec.ts`（9 用例）通过。

- [x] Task 7: 回归 + 契约 + 提交
  - [x] 7.1 全量回归：scheduler jest 73 suites/537 tests + 客户端 95 suites/730 tests + tsc（spec 零错误）+ eslint（6 改动文件零输出）+ migration runner 语法 + pytest parity 5 passed。
  - [x] 7.2 `openapi:no-drift` 通过（/context 与 CreateRunRequest 为纯 TS 类型，无需重生成）。
  - [x] 7.3 已提交并推送 `main`（commit 4bbbbb8，35 files；排除 update-readme-latest 用户改动；推送前 rebase 并入远端 f7d07c9）。

# Task Dependencies
- [Task 1] 无依赖（RLS migration + 审计先行）。
- [Task 2] 无依赖（context 服务）；并行于 [Task 1]。
- [Task 3] 无依赖；并行。
- [Task 4] 无依赖；并行。
- [Task 5] 无依赖（独立 replan 模块）；并行。
- [Task 6] 无依赖（CreateRunRequest 独立）；并行。
- [Task 7] 依赖全部（含集成期 RLS org_id 写入修复）。
