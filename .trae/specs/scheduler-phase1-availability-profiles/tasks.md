# Tasks — Scheduler Phase 1 资源时间窗/数据真实性与版本化 Profile

> 原则：先核验现状 → 补测试暴露问题 → 改代码 → 回归。只收敛 Phase 1 的 5 项真实缺口；Phase 0 已确认在 main 交付，不重复。每个 Task 独立可运行、可验证。

- [ ] Task 1: 资源时间窗真实交集（P1-A）
  - [ ] 1.1 契约与 schema：新增 device maintenance window（migration `standalone_027_resource_time_windows`：`ewoh_device` 增 `maintenance_start_ms/maintenance_end_ms`，或 `maintenance_windows jsonb`；选最小且真实列）；`ResourceState` 增 `maintenanceWindows?: Array<{startMs:number;endMs:number}>`（shared/scheduler.ts）。
  - [ ] 1.2 `resource-projection.service.ts` 投影 maintenance windows 进 ResourceState（无数据显式空数组/undefined，不伪造）。
  - [ ] 1.3 `candidate-engine.service.ts`/`eligibility.service.ts` 时间窗交集升级：Task Window ∩ Horizon ∩ Person availableWindows ∩ Reservations ∩ Certification Validity ∩ Device availableWindows ∩ Maintenance ∩ Reservations ∩ Station availableWindows ∩ Capacity ∩ Reservations。**shift（schema 仅 nullable 字符串无时间语义）不参与硬交集**，在代码注释与 spec 记录契约；缺数据显式 UNKNOWN/不可派，不用评分弥补。
  - [ ] 1.4 新增测试：availability-intersection.spec.ts——maintenance 窗口排除设备候选、cert 有效期排除人员、shift 无语义不参与、station 容量交集、缺数据不伪造。
  - [ ] 验证：`npx jest modules/scheduler`（candidates/eligibility/availability-intersection）全绿 + `npx tsc --noEmit -p tsconfig.spec.json`。

- [ ] Task 2: ResourceState source 双维度 + safety fail-close（P1-B）
  - [ ] 2.1 `ResourceState` 新增 `source?: 'AUTHORITATIVE' | 'DERIVED'`（与 dataQuality 正交）；`resource-projection.service.ts`/`world-state.service.ts` 对派生字段（如型号白名单 capabilities、派生 safetyCritical 等）标 `source='DERIVED'` 并保留 `derived[]` 明细。
  - [ ] 2.2 safety-critical fail-close：候选评估中 safetyCritical 任务 + UNKNOWN/STALE 或关键 DERIVED（位置/能力/availability）→ 候选不可派（rejectReason 如 `stale_data`/`derived_data_fail_closed`）。
  - [ ] 2.3 新增测试：resource-source.spec.ts——source/dataQuality 正交；safetyCritical+STALE/UNKNOWN/DERIVED 拒绝；非安全任务正常。
  - [ ] 验证：`npx jest modules/scheduler`（resource-state/resource-freshness/resource-source/candidate）全绿 + tsc。

- [ ] Task 3: 版本化 Policy Profile（P1-C）
  - [ ] 3.1 `SchedulingPolicyConfig.profiles?: Record<string, { label: string; scale: Partial<ObjectiveWeights> }>`（ON_TIME/PRODUCTION_IMPACT/WORKLOAD_BALANCE/TRAVEL_MIN/MIN_CHURN/BALANCED；缺省 BALANCED=不缩放）；`scheduling-policy.service.ts` 默认配置与 `resolveProfiles`。
  - [ ] 3.2 `solver.service.ts solveVariants` 从配置读取 profiles（替代硬编码数组）；兼容 A=ON_TIME、B=WORKLOAD_BALANCE、C=BALANCED；plan 记录 `profileId`/`profileVersion`（SchedulingPlanV2 可选字段）。
  - [ ] 3.3 新增测试：policy-profile.spec.ts——每 profile 产出不同 objectiveWeights、profile 不影响 hard constraints（复用 solver-invariants）、缺省 BALANCED 回归、plan 记录 profileId/version。
  - [ ] 验证：`npx jest modules/scheduler`（solver/scheduler-run-profile/policy-profile）全绿 + tsc。

- [ ] Task 4: Command Map 接入 /context + STALE CONTEXT（P1-D）
  - [ ] 4.1 client `api/scheduler.ts` 增 `getSchedulerContext()`（GET /api/scheduler/context）；`useCommandMapSchedulerState` 或顶层 hook 拉取 context（React Query key）。
  - [ ] 4.2 Command Map 状态条/面板显示 snapshotVersion/resourceVersion/routeGraphVersion/policyVersion/asOf/SSE sequence；Plan 与 Resource 版本不一致时显示 `STALE CONTEXT` 标记（不静默混合）。
  - [ ] 4.3 新增/更新测试：context hook 拉取、版本不一致 → stale 标记；`openapi:no-drift` 通过。
  - [ ] 验证：client jest（相关 hook/组件）+ tsc（client 零新增错误）。

- [ ] Task 5: 人工干预版本 CAS 补齐（P1-E）
  - [ ] 5.1 核验 override/approve/retime 现有版本校验（PLAN_STALE/dispatch CAS）；为缺失的 mutation（override 应用、approve、retime/调整）增加 `expectedPlanVersion`/`expectedSnapshotVersion` 可选入参；过期返回结构化 `STALE_PLAN`/`STALE_SNAPSHOT`（ConflictException 语义），不自动应用。
  - [ ] 5.2 新增测试：override-cas.spec.ts——旧版本 override/approve 被拒（STALE_PLAN/STALE_SNAPSHOT）；新版本正常；无入参向后兼容。
  - [ ] 验证：`npx jest modules/scheduler`（overrides/plan/override-cas）全绿 + tsc。

- [ ] Task 6: 回归 + 契约 + 提交
  - [ ] 6.1 全量回归：scheduler jest（≥537 基线）+ 客户端 jest（≥730）+ `tsc --noEmit -p tsconfig.spec.json` + 改动文件 eslint。
  - [ ] 6.2 `npm run openapi:no-drift` 通过；migration runner 注册 027（`db/runner/run_migrations.js`）。
  - [ ] 6.3 排除调试残留与用户未提交改动（`update-readme-latest/*`），提交并推送 `main`。

# Task Dependencies
- [Task 1] 无依赖（时间窗交集，migration 027 先行）。
- [Task 2] 无依赖（source 维度）；并行于 [Task 1]。
- [Task 3] 无依赖（profiles 配置）；并行于 [Task 1/2]。
- [Task 4] 依赖 [Task 2] 的共享类型（ResourceState.source 可选）无强依赖，可并行。
- [Task 5] 无依赖；并行。
- [Task 6] 依赖全部。
