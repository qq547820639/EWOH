# Checklist — Command Map 智能调度闭环

## Phase A: Server authoritative run list + snapshot
- [x] `GET /api/scheduler/runs` 返回分页 run/plan 历史与活跃方案，复用 V2 类型
- [x] `GET /api/scheduler/snapshot` 返回地图/调度器共用 authoritative operational state（freshness/dataQuality/entityVersion/reservations）
- [x] client `getRuns`/`getSnapshot` + React Query keys 齐备
- [x] runs/snapshot 单测通过

## Phase B: 统一 SchedulingConflict
- [x] shared `SchedulingConflict` 类型定义（type/severity/scope/resolution/…）
- [x] `GET /api/scheduler/conflicts`、`GET /api/scheduler/conflicts/:id` 从 reservation/stale/offline/route 汇聚
- [x] CommandMap 冲突层消费统一 conflict 源，不再各面板自行推断
- [x] conflicts 集成测试通过

## Phase C: 人工 override → constraint + replan
- [x] `POST /api/scheduler/plans/:planId/overrides`：人工动作→约束(+audit)→replan→before/after diff
- [x] `EXCLUDED_RESOURCE`/`PREFERRED_RESOURCE` 约束类型存在（缺失则补）
- [x] BrainPanel apply 最终落进 V2 链路，不绕过 Scheduler
- [x] override 集成用例：lock→replan→diff→approve→dispatch

## Phase D: Scheduling 页面 V2 收口
- [x] `Scheduling/Scheduling.tsx` 改用 createRun + SchedulingPlanV2 + approve/reject/replan/dispatch
- [x] legacy api 保留兼容导出，新页面不再依赖；调度事实源为服务端 run/plan
- [x] 前端构建 + 组件/手测通过

## Phase E: 事件驱动 replan 扩充
- [x] 扩充 trigger：TASK_CREATED/TASK_UPDATED/BOTTLENECK/DEADLINE_AT_RISK/ZONE_RESTRICTED/route blocked·congested/reservation conflict
- [x] 走 ImpactAnalyzer→局部 replan，冻结未受影响/已执行 assignment，保留 debounce/cooldown
- [x] impact-analyzer / replan 集成测试通过

## Phase F: 策略版本化 + 影子评估
- [x] `SchedulingPolicyConfig` 有版本化（缺失则补列/migration）
- [x] `GET /api/scheduler/policy` + 候选版本 + compare/shadow（只读）
- [x] 激活需人工审批后才切换 active policyVersion；feedback 不自动改生产策略
- [x] policy 版本化单测 + shadow 只读断言

## Phase G: 质量与交付
- [x] `npm test`、type:check、lint、build 全部通过，既有 739+ 测试不退化
- [x] OpenAPI route-manifest 与 route audit 已更新
- [x] 排除调试残留文件，提交并推送 origin/main
- [x] 未引入平行 Scheduler；未伪造数据；新调度功能只依赖 Scheduling V2