# 调度 V2 表 RLS 覆盖审计（Batch 8.1）

> 审计日期：2026-08-08 | 基线：main@f134fd1 + Batch5-7
> 结论：**RLS 白名单未覆盖调度 V2 运行时表（9 张）**，当前多租户隔离依赖应用层 org_id 过滤。

---

## 一、RLS 覆盖现状

### 已启用 RLS（standalone_001_schema.sql:1535 动态列表，50+ 张业务表）

`ewoh_ai_suggestion / ewoh_device / ewoh_device_binding / ewoh_environment / ewoh_event / ewoh_model_registry / ewoh_organization / ewoh_personnel / ewoh_production_task / ewoh_schedule_audit / ewoh_schedule_plan / ewoh_scheduler_config / ewoh_spatial_entity / ewoh_telemetry / ewoh_topology / ewoh_world_state / ewoh_notification / ...`（50+ 张）

策略：`ewoh_org_select`（authenticated 读）+ `ewoh_service_all`（service_role 全权），均基于 `public.ewoh_org_visible(org_id)`。

### 未启用 RLS（调度 V2 运行时表，9 张）

| 表 | org_id 列 | 建表位置 | 隔离方式 |
|----|-----------|----------|----------|
| `ewoh_outbox` | ✅ varchar(255) | standalone_001 ADD COLUMN | 应用层 |
| `ewoh_world_state_snapshot` | ❌（snapshot_version 唯一） | standalone_006:117 | 应用层（快照全局共享） |
| `ewoh_assignment_event` | ❌ | standalone_006:173 | 应用层 |
| `ewoh_replan_trigger` | ✅ notNull | 001/008 | 应用层（orgId 索引） |
| `ewoh_scheduling_run` | ✅ + org 索引 | 006:38 | 应用层 |
| `ewoh_scheduling_plan_assignment` | — | 007 | 应用层 |
| `ewoh_scheduling_constraint` | — | 007 | 应用层 |
| `ewoh_scheduling_feedback` | — | 007/010 | 应用层 |
| `ewoh_scheduling_policy` | ✅ + org 索引 | 007 | 应用层 |

## 二、风险分析

| 风险 | 等级 | 说明 |
|------|------|------|
| 多租户越界读 | 中 | 调度 V2 API 依赖应用层 org_id 过滤（`toOrgContext` + GUC），若某查询漏过滤可跨租户读到 run/plan/feedback |
| RLS 双重保险缺失 | 中 | 主产品设计原则是"事务 GUC + RLS 双保险"，调度 V2 运行时表缺第二道防线 |
| 快照/事件全局共享 | 低（设计） | `ewoh_world_state_snapshot` 无 org_id 是设计（快照版本全局唯一，如 WS-20260808-0001）；`ewoh_outbox` SSE 事件全局广播（前端按组织订阅） |

## 三、结论与建议

1. **不强行补 RLS**：调度 V2 表的 org_id 语义与快照/事件全局共享设计冲突，补 RLS 需重新设计 org 边界（快照跨 org 引用、SSE 全局序列），属架构级变更，需 ADR。
2. **缓解措施（建议下一迭代）**：
   - 审计调度 V2 service 层所有查询是否显式 org 过滤（`toOrgContext` + GUC 已覆盖写路径）
   - `ewoh_replan_trigger / ewoh_scheduling_run` 已有 org_id 索引，读路径补 `org_id = current_org` 条件即可低成本加第二道防线（应用层）
   - 对全局表（world_state_snapshot / outbox）声明为"全局共享表"并写入 SECURITY.md 边界说明
3. **记录 OPEN-DECISIONS**：调度 V2 表 RLS 覆盖策略（waiting-on-external-condition：多租户试点需求明确后决策）
