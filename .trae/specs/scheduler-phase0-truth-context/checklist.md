# Checklist — Scheduler Phase 0 事实源与安全一致性（scheduler-phase0-truth-context）

## Task 1：Scheduler DB RLS audit/fix + 覆盖
- [x] 已逐表审计 scheduler 域表 org 列并输出状态清单（发现 ewoh_schedule_plan 缺列，025 补齐；outbox/snapshot/assignment_event 保留非 RLS）
- [x] GUC 名不一致已修复：policy 统一 app.current_org_id（COALESCE 兼容旧名回退）
- [x] `standalone_025_scheduler_rls.{sql,rollback.sql}` + verify 已新增：8 张 org-scoped 表 RLS + org policy；非 RLS 表已注释说明
- [x] rls-org-filter.audit.spec.ts allowlist/文档已同步（NON_RLS 收敛为 3 张）
- [x] rls-policy.spec.ts（RLS 存在性 + GUC 一致性 + cross-org 过滤）6 用例通过
- [x] 集成期修复：ewohSchedulePlan schema 补 orgId；persistPlan + 两处 constraint insert 补写 org_id
- [x] scheduler jest（含 audit spec 73 suites/537）+ tsc 全绿

## Task 2：SchedulingContext + GET /api/scheduler/context
- [x] `SchedulingContext`/`SchedulingContextResponse` 类型已定义（版本字段齐全）
- [x] `scheduling-context.service.ts` 已实现单一 org 切片组装（版本字段真实取值，resource/route 版本以 worldVersion 同源代理并注释）
- [x] `GET /api/scheduler/context` 已暴露且 org 隔离
- [x] openapi:no-drift 通过（纯 TS 类型，无需重生成）
- [x] scheduling-context.spec.ts（5 用例：版本/集合/org/dataQuality）通过

## Task 3：Candidate horizon 配置化
- [x] candidate-engine 时间窗硬编码 480 已改为 config.horizonMinutes（缺省 480 回归）
- [x] horizon 配置生效测试（120/缺省 480）通过

## Task 4：Route matrix DB 全键唯一
- [x] `standalone_026_route_cost_matrix_full_key.{sql,rollback.sql}` + verify 已新增（部分唯一索引含 candidate_set_hash；补列；旧索引保留）
- [x] travel-cost persistMatrix 补写 routeGraphVersion/candidateSetHash，与逻辑全键对齐
- [x] route-matrix-key.spec.ts（5）+ travel-cost.spec.ts（+1）通过

## Task 5：Replan storm guard 跨实例
- [x] evaluateStormGuard 支持 pg_try_advisory_xact_lock（org 稳定 key），db.execute 抛错显式降级内存态（logger.warn）
- [x] durable 幂等由 ewoh_replan_trigger.triggerKey unique 承载（确认，无需新 migration）
- [x] replan-multi-instance.spec.ts（5 用例：双实例守卫权/降级/幂等）通过；既有 replan-storm 等不退化

## Task 6：Run 接口增强 + 核验项
- [x] CreateRunRequest 支持 objectiveProfile / mode(MANUAL|AUTO|SHADOW) / baselinePlanId；createRun 按 profile 筛单变体、SHADOW 不写正式 plan、baselinePlanId 作 churn 基线
- [x] station backlog 语义核验并修正为 queue.length（排队任务数），world-state-derive.spec.ts 补断言
- [x] version.json（0.6.0-rc4）与 package.json/helm/compose 单一事实源核验一致
- [x] scheduler-run-profile.spec.ts（9 用例）通过

## Task 7：回归与提交
- [x] 全量回归：scheduler jest 73 suites/537 tests + 客户端 95 suites/730 tests + tsc + eslint + migration runner 语法 + pytest parity 全通过
- [x] openapi:no-drift 通过
- [x] 已提交并推送 `main`（commit 4bbbbb8，35 files；排除 update-readme-latest 用户改动）
