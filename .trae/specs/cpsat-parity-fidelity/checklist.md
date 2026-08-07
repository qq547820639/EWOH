# Checklist — CP-SAT Parity & Fidelity

- [x] `SolverRequest.tasks[*]` 含 `skillMatchMode` 与 `effectivePriorityScore`，向后兼容 optional
- [x] `WorldStateSnapshot.tasks[*]` 含 `safetyCritical / preemptible / skillMatchMode / dueAtMs`
- [x] `WorldStateSnapshot.devices[*]` 含 `x / y / locationStationId / availableWindows`
- [x] `WorldStateSnapshot.stations[*]` 含 `capacity`
- [x] `world-state.service.ts` 快照构建透传上述真实字段（无假占位）
- [x] `cp-sat-scheduling-solver.ts#buildRequest` 用真实 `safetyCritical/preemptible/availableFromMs/device x-y/station capacity` 替换占位值
- [x] `SchedulingConstraint[]` 完整映射进 `SolverRequest`，`_constraints` 不再被忽略
- [x] 不支持的约束显式返回 unsupported，不静默忽略
- [x] CP-SAT 与 heuristic 消费同一 `PriorityEngine` 的优先级，移除静态 `priorityRank` 分叉
- [x] `eligibility.service.ts` 显式 `skillMatchMode`（ALL⇒every / ANY⇒some），不再硬编码 `.some()`
- [x] fallback 到 heuristic 后 LOCKED_* 约束不丢失
- [x] 新增测试：数据保真 / 约束透传 / 优先级一致 / 技能 ALL+ANY / fallback 锁定
- [x] `tsc --noEmit`、lint、scheduler 测试全部通过，既有 646+ 测试不退化
- [x] 排除调试残留文件，提交并推送 origin/main