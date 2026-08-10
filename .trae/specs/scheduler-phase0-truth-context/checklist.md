# Checklist — Scheduler Phase 0 事实源与安全一致性（scheduler-phase0-truth-context）

## Task 1：Scheduler DB RLS audit/fix + 覆盖
- [ ] 已逐表审计 scheduler 域表 org 列并输出状态清单（run/plan/assignment/reservation/policy/feedback/replan_trigger/constraint/outbox/snapshot/assignment_event）
- [ ] GUC 名不一致已修复：policy 与 buildGucSettings 统一 app.current_org_id（兼容旧名回退）
- [ ] `standalone_025_scheduler_rls.{sql,rollback.sql}` + verify 已新增：org-scoped 表 RLS + org policy；outbox/snapshot/assignment_event 非 RLS 已注释说明
- [ ] rls-org-filter.audit.spec.ts allowlist/文档已同步
- [ ] RLS policy 存在性 + GUC 一致性 + cross-org 过滤测试通过
- [ ] scheduler jest（含 audit spec）+ tsc 全绿

## Task 2：SchedulingContext + GET /api/scheduler/context
- [ ] `SchedulingContext`/`SchedulingContextResponse` 类型已定义（版本字段齐全）
- [ ] `scheduling-context.service.ts` 已实现单一 org 切片组装（版本字段真实取值）
- [ ] `GET /api/scheduler/context` 已暴露且 org 隔离
- [ ] openapi/route-manifest 已同步（openapi:no-drift 通过）
- [ ] scheduling-context.spec.ts（版本/集合/org）通过

## Task 3：Candidate horizon 配置化
- [ ] candidate-engine 时间窗硬编码 480 已改为 config.horizonMinutes（缺省 480 回归）
- [ ] horizon 配置生效测试通过

## Task 4：Route matrix DB 全键唯一
- [ ] `standalone_026_route_cost_matrix_full_key.{sql,rollback.sql}` + verify 已新增（部分唯一索引含 candidate_set_hash）
- [ ] travel-cost 写入与逻辑全键对齐；旧索引保留
- [ ] travel-cost.spec.ts 不退化 + migration 静态断言通过

## Task 5：Replan storm guard 跨实例
- [ ] evaluateStormGuard 支持 PG advisory lock（org 稳定 key），不可用时显式降级内存态
- [ ] durable 计数已落库（复用或新增计数机制）
- [ ] 多实例测试：仅一个实例获得守卫权、另一被抑制；既有 replan-storm 不退化

## Task 6：Run 接口增强 + 核验项
- [ ] CreateRunRequest 支持 objectiveProfile / mode(MANUAL|AUTO|SHADOW)；createRun 按 profile/mode 执行（SHADOW 不写正式 plan）
- [ ] baselinePlanId 作为 churn 基线（复用现有机制）
- [ ] station backlog 语义核验 + 回归测试；version.json/config 单一事实源核验说明
- [ ] 相关 jest 用例通过

## Task 7：回归与提交
- [ ] 全量回归：scheduler jest（≥503）+ 客户端 jest（≥730）+ tsc + eslint 通过
- [ ] openapi:no-drift 通过
- [ ] 已提交并推送 `main`（排除调试残留与用户未提交改动）
