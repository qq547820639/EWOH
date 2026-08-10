# Tasks — Scheduler Phase 1 资源时间窗/数据真实性与版本化 Profile

> 原则：先核验现状 → 补测试暴露问题 → 改代码 → 回归。只收敛 Phase 1 的 5 项真实缺口；Phase 0 已确认在 main 交付，不重复。每个 Task 独立可运行、可验证。

- [x] Task 1: 资源时间窗真实交集（P1-A）
  - [x] 1.1 契约与 schema：migration `standalone_027_resource_time_windows`（ewoh_device 增 maintenance_start_ms/maintenance_end_ms，幂等）+ `ResourceState.maintenanceWindows` + drizzle schema 同步。
  - [x] 1.2 `resource-projection.service.ts` 投影 maintenanceWindows（两列 NULL → 空数组，不伪造）与 source。
  - [x] 1.3 时间窗交集升级：`buildTimeWindows` = Task Window ∩ Horizon；`eligibility.check` 4g/4h——Task Window ∩ availableWindows 正空间 ∩ maintenance 负空间 ∩ station capacity；**shift 无时间语义不参与硬交集**（注释明确契约）；缺数据不伪造，空交集 → `time_conflict`。
  - [x] 1.4 新增 `availability-intersection.spec.ts`：maintenance 排除、cert 过期排除、shift 不参与、容量交集、缺数据不伪造。
  - [x] 验证：定向 7 套件 58/58 全绿（含 candidates/eligibility/candidate-engine-reject 回归）+ tsc。

- [x] Task 2: ResourceState source 双维度 + safety fail-close（P1-B）
  - [x] 2.1 `ResourceState.source?: 'AUTHORITATIVE' | 'DERIVED'` 已定义（与 dataQuality 正交）；projection 对派生字段（型号白名单 capabilities 等）标 DERIVED，person/station 标 AUTHORITATIVE。
  - [x] 2.2 safety-critical fail-close：`eligibility.check` 第 11 条——safetyCritical 任务 + STALE/UNKNOWN → `stale_data`；关键 DERIVED → `derived_data_fail_closed`（非安全任务不受影响）。
  - [x] 2.3 新增 `resource-source.spec.ts`：正交性（AUTHORITATIVE+FRESH / DERIVED+STALE）、safety fail-close、非安全正常。
  - [x] 验证：resource-state/resource-freshness/resource-source/candidate 相关全绿。

- [x] Task 3: 版本化 Policy Profile（P1-C）
  - [x] 3.1 `SchedulingPolicyConfig.profiles`（ON_TIME/PRODUCTION_IMPACT/WORKLOAD_BALANCE/TRAVEL_MIN/MIN_CHURN/BALANCED）+ `resolveProfiles()`（BALANCED 缺省兜底）；DEFAULT_PROFILES 6 预设。
  - [x] 3.2 `solveVariants` 从配置读取 profiles（A=ON_TIME/B=WORKLOAD_BALANCE/C=BALANCED 语义兼容）；plan 记录 profileId/profileVersion（随 baselineDelta.variant 落库可审计）。
  - [x] 3.3 新增 `policy-profile.spec.ts`（9 用例）：不同 weights、hard 不变、缺省回归、plan 记录 profile。
  - [x] 验证：policy-profile/scheduler-run-profile/solver-fixtures/policy-version 等 7 套件 80/80 + phase1-features/scheduler-domain 33/33。

- [x] Task 4: Command Map 接入 /context + STALE CONTEXT（P1-D）
  - [x] 4.1 client `getSchedulerContext()`（GET /api/scheduler/context）+ queryKeys + `useCommandMapSchedulerState` 拉取（staleTime 15s，透出 context）。
  - [x] 4.2 Command Map 徽标显示 S/R/G/P/asOf/SSE sequence；`isContextStale` 纯函数——方案与 context.snapshotVersion 不一致 → 红色 `STALE CONTEXT`。
  - [x] 4.3 测试：schedulerRealtimeCore.test.ts +6（isContextStale）、use-command-map-scheduler-state.test.ts +2（透出/降级）。
  - [x] 4.4 根因修复：client tsc 基线 18 个既有错误源于 `dist/shared/*.d.ts` 过期构建产物重定向——`npx tsc -b tsconfig.node.json` 重建后 client tsc 归零。
  - [x] 验证：client 95 suites/738 tests 全绿；tsc（root）0 错误。

- [x] Task 5: 人工干预版本 CAS 补齐（P1-E）
  - [x] 5.1 `PlanOverrideRequest`/`ApprovePlanRequest` 增 expectedPlanVersion/expectedSnapshotVersion（可选）；`applyOverrides`/`approvePlanV2` 校验——不一致 → `STALE_PLAN`/`STALE_SNAPSHOT`（ConflictException），不落库不重排；未提供 → 现状（向后兼容）。
  - [x] 5.2 新增 `override-cas.spec.ts`（10 用例）：旧版本拒绝、新版本正常、无入参兼容。
  - [x] 验证：overrides/plan-persistence/override-cas 全绿。

- [x] Task 6: 回归 + 契约 + 提交
  - [x] 6.1 全量回归：scheduler jest 77 suites/574 tests + 客户端 95 suites/738 tests + tsc（root+spec 0 错误）+ eslint（6 改动文件 0 输出）+ migration runner 语法 OK。
  - [x] 6.2 `openapi:no-drift` 通过（纯 TS 类型，无需重生成）；migration runner 已注册 027。
  - [x] 6.3 已提交并推送 `main`（commit 78285ab，30 files；排除 update-readme-latest 用户改动）。

# Task Dependencies
- [Task 1] 无依赖（时间窗交集，migration 027 先行）。
- [Task 2] 无依赖（source 维度）；并行于 [Task 1]。
- [Task 3] 无依赖（profiles 配置）；并行于 [Task 1/2]。
- [Task 4] 无依赖（前端）；并行于后端各任务。
- [Task 5] 无依赖；并行。
- [Task 6] 依赖全部。
