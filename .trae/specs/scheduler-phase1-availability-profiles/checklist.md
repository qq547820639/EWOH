# Checklist — Scheduler Phase 1 资源时间窗/数据真实性与版本化 Profile

## Task 1：资源时间窗真实交集
- [ ] `standalone_027_resource_time_windows.{sql,rollback.sql}` + verify 已新增（device maintenance window 真实列）；runner 已注册
- [ ] ResourceState 含 maintenanceWindows；resource-projection 已投影（无数据不伪造）
- [ ] Candidate availability 交集含 maintenance/cert 有效期/station 容量/reservation 等真实数据；shift 无时间语义不参与硬交集（契约说明）
- [ ] availability-intersection.spec.ts 通过（maintenance 排除、cert 排除、shift 不参与、容量交集、缺数据不伪造）
- [ ] candidates/eligibility 既有测试不退化

## Task 2：ResourceState source 双维度 + safety fail-close
- [ ] ResourceState.source: AUTHORITATIVE|DERIVED 已定义并与 dataQuality 正交
- [ ] resource-projection/world-state 对派生字段标 source=DERIVED（保留 derived[] 明细）
- [ ] safetyCritical + UNKNOWN/STALE/关键 DERIVED → 候选不可派（fail-close）
- [ ] resource-source.spec.ts 通过（正交性、safety fail-close、非安全正常）

## Task 3：版本化 Policy Profile
- [ ] SchedulingPolicyConfig.profiles 已定义（6 profile + BALANCED 缺省）；resolveProfiles 已实现
- [ ] solveVariants 消费配置 profiles（A/B/C 语义兼容）；plan 记录 profileId/profileVersion
- [ ] policy-profile.spec.ts 通过（不同 weights、hard 不变、缺省回归、plan 记录 profile）
- [ ] solver/scheduler-run-profile 既有测试不退化

## Task 4：Command Map 接入 /context + STALE CONTEXT
- [ ] client getSchedulerContext() + hook 拉取（React Query）
- [ ] Command Map 展示版本字段（snapshot/resource/routeGraph/policy/asOf/SSE sequence）；版本不一致显示 STALE CONTEXT
- [ ] context hook/组件测试通过；openapi:no-drift 通过；client tsc 零新增错误

## Task 5：人工干预版本 CAS
- [ ] override/approve/retime 支持 expectedPlanVersion/expectedSnapshotVersion（可选）
- [ ] 过期返回 STALE_PLAN/STALE_SNAPSHOT 且不自动应用；无入参向后兼容
- [ ] override-cas.spec.ts 通过（旧版本拒绝/新版本正常/兼容）

## Task 6：回归与提交
- [ ] 全量回归：scheduler jest（≥537）+ 客户端 jest（≥730）+ tsc + eslint 通过
- [ ] openapi:no-drift 通过；migration runner 注册 027
- [ ] 已提交并推送 `main`（排除调试残留与用户未提交改动）
