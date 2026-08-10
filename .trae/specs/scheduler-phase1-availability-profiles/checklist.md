# Checklist — Scheduler Phase 1 资源时间窗/数据真实性与版本化 Profile

## Task 1：资源时间窗真实交集
- [x] `standalone_027_resource_time_windows.{sql,rollback.sql}` + verify 已新增（device maintenance_start_ms/end_ms 真实列）；runner 已注册
- [x] ResourceState 含 maintenanceWindows + drizzle schema 同步；resource-projection 已投影（无数据不伪造）
- [x] Candidate availability 交集含 Task Window∩Horizon∩availableWindows∩reservation∩cert validity∩maintenance∩station capacity；shift 无时间语义不参与硬交集（契约说明）；空交集 → time_conflict
- [x] availability-intersection.spec.ts 通过（maintenance 排除、cert 排除、shift 不参与、容量交集、缺数据不伪造）
- [x] candidates/eligibility/candidate-engine-reject 既有测试不退化（定向 58/58）

## Task 2：ResourceState source 双维度 + safety fail-close
- [x] ResourceState.source: AUTHORITATIVE|DERIVED 已定义并与 dataQuality 正交
- [x] resource-projection 对派生字段标 source=DERIVED（保留 derived[] 明细）；person/station 标 AUTHORITATIVE
- [x] safetyCritical + STALE/UNKNOWN → stale_data；关键 DERIVED → derived_data_fail_closed（fail-close）
- [x] resource-source.spec.ts 通过（正交性、safety fail-close、非安全正常）

## Task 3：版本化 Policy Profile
- [x] SchedulingPolicyConfig.profiles 已定义（6 profile + BALANCED 缺省）；resolveProfiles 已实现
- [x] solveVariants 消费配置 profiles（A/B/C 语义兼容）；plan 记录 profileId/profileVersion（随 baselineDelta.variant 落库）
- [x] policy-profile.spec.ts（9）通过：不同 weights、hard 不变、缺省回归、plan 记录 profile
- [x] solver/scheduler-run-profile/solver-fixtures/policy-version/phase1-features/scheduler-domain 不退化

## Task 4：Command Map 接入 /context + STALE CONTEXT
- [x] client getSchedulerContext() + queryKeys + hook 拉取（React Query）
- [x] Command Map 展示 S/R/G/P/asOf/SSE sequence；isContextStale 纯函数，版本不一致显示红色 STALE CONTEXT
- [x] schedulerRealtimeCore.test.ts（+6）+ use-command-map-scheduler-state.test.ts（+2）通过；client 95 suites/738 tests
- [x] client tsc 归零（根因：dist/shared/*.d.ts 过期构建产物重定向，已重建）；openapi:no-drift 通过

## Task 5：人工干预版本 CAS
- [x] PlanOverrideRequest/ApprovePlanRequest 支持 expectedPlanVersion/expectedSnapshotVersion（可选）
- [x] applyOverrides/approvePlanV2 过期返回 STALE_PLAN/STALE_SNAPSHOT 且不落库不重排；无入参向后兼容
- [x] override-cas.spec.ts（10 用例）通过：旧版本拒绝/新版本正常/兼容

## Task 6：回归与提交
- [x] 全量回归：scheduler jest 77 suites/574 tests + 客户端 95 suites/738 tests + tsc（root+spec 0 错误）+ eslint 全绿
- [x] openapi:no-drift 通过；migration runner 注册 027（node --check OK）
- [x] 已提交并推送 `main`（commit 78285ab，30 files；排除调试残留与用户未提交改动）
