# Tasks — Scheduler Phase 0 事实源与安全一致性（scheduler-phase0-truth-context）

> 原则：先核验现状 → 补测试暴露问题 → 改代码 → 回归。只收敛 Phase 0 的 6 项真实缺口，其余交付/条件性需求不重复实现。每个 Task 独立可运行、可验证，完成后立即跑相关测试。

- [ ] Task 1: Scheduler DB RLS audit/fix + 覆盖（P0-1）
  - [ ] 1.1 审计：逐表确认 scheduler 域表的 org_id 列（schema.ts：run/plan/assignment/reservation/policy/feedback/replan_trigger/constraint/outbox/world_state_snapshot/assignment_event），输出"RLS 状态 × org 列 × 建议"清单。
  - [ ] 1.2 修复 GUC 名不一致：确认 `buildGucSettings` 只设置 `app.current_org_id`，而 023 policy 读 `app.primary_org_id`；迁移中将 policy 改为读 `app.current_org_id`（并兼容回退旧名，如 `COALESCE(NULLIF(current_setting('app.current_org_id', true),''), NULLIF(current_setting('app.primary_org_id', true),''))`）。
  - [ ] 1.3 新增 migration `standalone_025_scheduler_rls.sql` + rollback + verify：对 org-scoped 调度表（run/plan/assignment/reservation/policy/feedback/replan_trigger/constraint）`ENABLE ROW LEVEL SECURITY` + `CREATE POLICY scheduler_<t>_org_isolation ... TO service_role USING (org_id = <guc> OR org_id IS NULL)`（幂等 DROP POLICY IF EXISTS / CREATE）；缺 org_id 列的表以增量列补齐（如需要，先核对 schema 实际列）；outbox / world_state_snapshot / assignment_event 保持非 RLS 并在注释中说明全局 sequence/版本键语义。
  - [ ] 1.4 更新 `rls-org-filter.audit.spec.ts`：非 RLS 表 allowlist 与文档同步（outbox/snapshot/assignment_event + 理由），确保静态审计不因新 RLS 政策误报。
  - [ ] 1.5 新增测试：`rls-policy.spec.ts`（或扩展 audit spec）——静态断言每个应启用 RLS 的表在 migration 中存在 policy（读 SQL 文本）；GUC 名一致性断言（policy 引用 GUC ⊆ buildGucSettings 设置的 GUC 集合）；cross-org 语义测试（约束/方案/预约 org 过滤，复用现有 fake db/静态审计基建）。
  - [ ] 验证：`npx jest modules/scheduler`（含 rls-org-filter.audit）全绿 + `npx tsc --noEmit -p tsconfig.spec.json`。

- [ ] Task 2: SchedulingContext 统一上下文 + GET /api/scheduler/context（P0-2）
  - [ ] 2.1 `shared/scheduler.ts` 新增 `SchedulingContext` 与 `SchedulingContextResponse` 类型（snapshotVersion/resourceVersion/routeGraphVersion/policyVersion/eventSequence/sourceTimestamp/tasks/resources/reservations/constraints/dataQuality）。
  - [ ] 2.2 新增 `scheduling-context.service.ts`：在单一 org 切片下组装 context（world-state snapshot + resource projection version + route graph version + active policy version + outbox latest sequence + constraints + dataQuality 汇总）；版本字段真实取值，禁止伪造。
  - [ ] 2.3 `scheduler.controller.ts` 新增 `GET /api/scheduler/context`（org 隔离）；`scheduler.module.ts` 注册服务。
  - [ ] 2.4 openapi 重生成 + route-manifest（如受影响）；前端类型透传确认。
  - [ ] 2.5 新增测试：context 组装（版本字段/任务资源约束集合/org 过滤）、resourceVersion/routeGraphVersion 与 source 一致。
  - [ ] 验证：`npx jest modules/scheduler`（新增 scheduling-context.spec.ts）全绿 + `npm run openapi:no-drift` 通过。

- [ ] Task 3: Candidate horizon 配置化（P0-3）
  - [ ] 3.1 `candidate-engine.service.ts` 时间窗 helper（~469 行 `now + 480*60*1000`）改为读取 policy config `horizonMinutes`（缺省 480 保持现状，与 199 行一致）；确认无其他硬编码 480。
  - [ ] 3.2 新增/更新测试：配置 horizonMinutes=120 时时间窗 end=now+120min；未配置时 480（回归）。
  - [ ] 验证：`npx jest modules/scheduler/__tests__/candidates.spec.ts` + 新增用例全绿。

- [ ] Task 4: Route matrix DB 全键唯一（P0-4）
  - [ ] 4.1 新增 migration `standalone_026_route_cost_matrix_full_key.sql` + rollback + verify：`CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_route_cost_matrix_full_key ON ewoh_route_cost_matrix (task_id, snapshot_version, policy_version, route_graph_version, candidate_set_hash) WHERE candidate_set_hash IS NOT NULL`（兼容存量 NULL 行）；保留旧索引不删。
  - [ ] 4.2 `travel-cost.service.ts` 矩阵写入（upsert）确认与全键对齐（逻辑 key 已含 5 维，核验 DB 写入列一致）。
  - [ ] 4.3 新增测试：migration SQL 含全键唯一索引（静态断言）+ 逻辑缓存 key 既有测试（travel-cost.spec.ts）不退化。
  - [ ] 验证：`npx jest modules/scheduler/__tests__/travel-cost.spec.ts` 全绿 + migration runner 注册（`db/runner/run_migrations.js`）。

- [ ] Task 5: Replan storm guard 跨实例一致性（P0-5）
  - [ ] 5.1 `replan-coordinator.service.ts`：`evaluateStormGuard` 增加 PostgreSQL advisory lock（`pg_try_advisory_lock(hashtext('<org>:replan_guard'))`，同一事务内取/释放；会话级锁需显式释放并处理异常路径）；advisory lock 不可用（非 PG/mock DB）→ 回退现有内存态并记录 reason（显式降级，不静默）。
  - [ ] 5.2 增加 durable 计数：守卫窗口内 replan 计数改为落库（复用 `ewoh_replan_trigger` org+triggerType 唯一键或新增计数行；读 schema 后选择最小方案），内存计数保留为降级缓存。
  - [ ] 5.3 新增测试：两个 coordinator 实例（共享 mock DB 的 lock 模拟）断言仅一个获得守卫权、另一被抑制；advisory lock 不可用时回退内存态（既有 replan-storm 测试不退化）。
  - [ ] 验证：`npx jest modules/scheduler/__tests__/replan-storm.spec.ts` + `replan-multi-instance.spec.ts` 全绿 + `npx tsc`。

- [ ] Task 6: Run 接口增强 + 核验项（P0-6）
  - [ ] 6.1 `CreateRunRequest`（shared/scheduler.ts）新增 `objectiveProfile?: string`（映射 solveVariants profile A/B/C：准时优先/负荷均衡/最少扰动）与 `mode?: 'MANUAL' | 'AUTO' | 'SHADOW'`；`createRun`（scheduler.service.ts）按 profile 选择变体、SHADOW 模式不写正式 plan（或标记 shadow）并记录 mode；`baselinePlanId` 传入作为 churn 基线（若现有 baselineAssignee 机制可承载则复用）。
  - [ ] 6.2 核验 `world-state.service.ts` station backlog 语义（backlog 应表达"工位排队任务数"，与 queue 列语义一致）并补回归测试（§八.10）。
  - [ ] 6.3 核验 `version.json` 与 runtime/config 单一事实源（版本号不应在多处硬编码；如有漂移记录并最小修正）并输出说明（§八.11）。
  - [ ] 6.4 新增测试：createRun 支持 objectiveProfile/mode=SHADOW；backlog 语义断言。
  - [ ] 验证：`npx jest modules/scheduler`（runs-snapshot/task-lifecycle 相关）全绿。

- [ ] Task 7: 回归 + 契约 + 提交
  - [ ] 7.1 全量回归：scheduler jest（≥503 基线）+ 客户端 jest（≥730）+ `tsc --noEmit -p tsconfig.spec.json` + 改动文件 eslint。
  - [ ] 7.2 `npm run openapi:no-drift` 通过（/context 端点与 CreateRunRequest 若暴露为 DTO 则重新生成 route-manifest）。
  - [ ] 7.3 排除调试残留与用户未提交改动（`update-readme-latest/*`），提交并推送 `main`。

# Task Dependencies
- [Task 1] 无依赖（RLS migration + 审计先行）。
- [Task 2] 无依赖（context 服务）；并行于 [Task 1]。
- [Task 3] 无依赖；并行。
- [Task 4] 无依赖；并行。
- [Task 5] 依赖 [Task 1] 无直接关系（独立 replan 模块）；并行。
- [Task 6] 依赖 [Task 2] 的 shared 类型上下文（CreateRunRequest 独立，可并行）。
- [Task 7] 依赖全部。
