# ADR-004: Scheduler V2 运行时表多租户/RLS 边界（分类 + 派生归属 + 数据库级证据）

## Status: Accepted (2026-08-10)
Owner: 平台/交付负责人（Scheduler V2 域）

> 现行口径（2026-09-29 补，依 standalone_057 更正；下表与「要点 1」的 NULL 放行表述是 Accepted 当时的定义）：
> `db/migrations/standalone_057_rls_null_reject.sql` 重建了这批 policy，**去掉了 `OR org_id IS NULL` 放行分支**
> （该文件 :135 明写此意，:200-215 是 `ewoh_scheduling_plan_assignment` 的现行体），并对 :97-113 清单内
> 15 张调度表动态 `ALTER COLUMN org_id SET NOT NULL`（:126-129）。因此今天**不存在**「NULL 行对任意 org 可见」，
> GUC 未设置且非 global_admin 时表达式为 NULL ⇒ fail-closed 全拒。本 ADR 的三分类决定本身未变。
> 机器对账入口：`chain-baseline-doc-face` 的 `rls_adr_null_bypass` 逐行核本表这两类声明与迁移现行定义
> （出处《链级行为基线》§5.3n44，V336）。

## Background

Scheduler V2 运行时域共有 **11 张**表（此前 OPEN-DECISIONS 记为「9 张」为不精确计数，
实为 8 张 RLS 覆盖 + 3 张刻意非 RLS；本 ADR 按完整 11 张分类）。`standalone_025`
已对其中 8 张 org-scoped 表启用 RLS（policy `scheduler_<table>_org_isolation`，
FOR ALL TO service_role，读取 `app.current_org_id`、回退 `app.primary_org_id`，
`org_id IS NULL` 放行全局行），并修复了 `standalone_023` 的 GUC 名不一致：

- ewoh_scheduling_run / ewoh_schedule_plan（org_id 列由 025 补齐）/
  ewoh_scheduling_plan_assignment / ewoh_resource_reservation /
  ewoh_scheduling_policy / ewoh_scheduling_feedback / ewoh_replan_trigger /
  ewoh_scheduling_constraint

其余 3 张**刻意非 RLS**（理由见 `standalone_025` 头注释）：

- `ewoh_outbox`：全局 outbox_sequence_seq 事件日志（SSE 按 sequence 增量重放/缺口检测），
  RLS 会破坏跨 org 的全局序列键语义；
- `ewoh_world_state_snapshot`：snapshotVersion 全局唯一版本键（快照按版本存取）；
- `ewoh_assignment_event`：事件审计流（eventId 全局唯一，全量留痕）。

多租户试点需求已明确，本 ADR 落地 OPEN-DECISIONS 的待决项（RLS 白名单/org 边界设计），
并为非 RLS 表补齐**数据库可验证**的租户边界（`standalone_028` 派生归属 + 不变量）。

## Decision

对全部 11 张 Scheduler V2 运行时表做三分类（GLOBAL_SHARED | TENANT_SCOPED |
DERIVED_TENANT_OWNERSHIP），并落地到代码/清单/门禁：

| 表 | 分类 | RLS | org_id 语义 | DB 层证据 |
|----|------|-----|-------------|-----------|
| ewoh_outbox | GLOBAL_SHARED | 关闭 | 血缘记录（非隔离边界） | 025 明确排除；E2E 断言跨 org 可读 |
| ewoh_world_state_snapshot | GLOBAL_SHARED | 关闭 | 血缘记录（snapshotVersion 全局键） | 025 明确排除；E2E 断言跨 org 可读 |
| ewoh_replan_trigger | TENANT_SCOPED | 开（025） | org_id NOT NULL；隔离 | verify-025 + E2E org-b 0 行 |
| ewoh_scheduling_run | TENANT_SCOPED | 开（025） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_schedule_plan | TENANT_SCOPED | 开（025，列补齐） | 隔离；NULL=全局/存量 | verify-025 + E2E org-b 0 行 |
| ewoh_scheduling_plan_assignment | TENANT_SCOPED | 开（025） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_scheduling_constraint | TENANT_SCOPED | 开（025 重建 023） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_scheduling_feedback | TENANT_SCOPED | 开（025） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_scheduling_policy | TENANT_SCOPED | 开（025） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_resource_reservation | TENANT_SCOPED | 开（025） | 隔离；NULL=全局 | verify-025 + E2E org-b 0 行 |
| ewoh_assignment_event | DERIVED_TENANT_OWNERSHIP | **关闭**（保持） | 由归属推导（standalone_028 触发器） | verify-028 不变量 + E2E 派生断言 |

要点：

1. **TENANT_SCOPED（双保险）**：DB 层 RLS（GUC `app.current_org_id`，回退
   `app.primary_org_id`）+ 应用层 org 过滤 + 请求级 GUC（`org-context.interceptor.ts`
   `buildGucSettings`，事务内生效）三重叠加；`org_id IS NULL` = 全局/存量行对任意
   org 可见（policy 的 OR 分支），新写入行由 WITH CHECK 强制归属当前 org。
2. **GLOBAL_SHARED**：RLS 保持关闭；`org_id` 仅作血缘记录（`ewoh_outbox` 有列，
   `ewoh_world_state_snapshot` 物理表无 org_id 列，见 manifest 注记）。全局表**绝不
   可冒充租户本地**——若未来对某全局表启用 RLS，必须先重新设计其全局键语义（sequence/
   snapshotVersion）并走新 ADR。SSE 基于 outbox 的 sequence 重放天然跨 org，属设计语义。
3. **DERIVED_TENANT_OWNERSHIP（ewoh_assignment_event）**：租户边界从归属行推导——
   `assignment_event.assignment_id → plan_assignment.assignment_id →（plan_id, org_id）→
   plan.plan_id → org_id`（事件行无 planId/runId 列）。`standalone_028` 新增
   `org_id` 列 + `trg_assignment_event_derive_org`（AFTER INSERT OR UPDATE）在
   org_id 为 NULL 时派生；**无法解析归属则保持 NULL**（防御，绝不失败）。RLS 保持
   关闭以保留全局审计流（eventId 全量留痕），租户边界由**数据库可验证不变量**（非空
   org_id 恒等于归属 plan/assignment 的 org_id，verify-028 + E2E 双断言）+
   应用层过滤共同保证。
4. **清单对齐**：`schema-manifest.yaml` 补入 `ewoh_replan_trigger`（此前缺失），
   3 张全局表的 `org_id_policy` 由 "NOT NULL" 改为 "GLOBAL_SHARED"（不再暗示 RLS 隔离）。
5. **回滚语义**（standalone_028 rollback）：撤销触发器/函数/索引；`org_id` 列保留
   （additive safe，回滚后可安全重放 028）。

## Consequences

- 正面：租户边界在 DB 层可验证、可门禁（verify SQL + 真实 PG E2E），不再依赖
  「应用层过滤 + 走读」的唯一防线；GLOBAL_SHARED/DERIVED 语义显式记录，防止未来
  误开 RLS 破坏全局键/审计流。
- 代价：DERIVED 表的派生依赖归属链完整（assignment 存在且可联到 plan）；事件先于
  归属行写入时 org_id 会短暂为 NULL（触发器防御语义），依赖归属行的 E2E/审计查询
  需按不变量（非空 org_id 恒匹配）而非「全行非空」断言——verify-028 与 E2E 均按
  此语义编写。
- 兼容性：8 张 TENANT_SCOPED 表行为与 025 一致；3 张全局表行为不变；028 为纯增量
  （新列/索引/触发器），对既有读路径无影响。
- 未决后续：`ewoh_world_state_snapshot` 物理表无 org_id 列（manifest 业务键声明与
  物理 schema 的历史差异）——如需血缘记录列，走独立迁移，不在本 ADR 范围内。

## Related ADRs / Migrations

- ADR-002（事件驱动重排复用求解器）——assignment_event 事件流的消费方语义
- `standalone_023_scheduler_incremental.sql`（初版 RLS，GUC 名不一致，被 025 修复）
- `standalone_025_scheduler_rls.sql`（8 表 RLS + GUC 修复 + plan.org_id 补齐）
- `standalone_028_assignment_event_tenancy.sql`（派生归属：列/索引/触发器）
- `scripts/verify-scheduler-multitenant.mjs`（真实 PG 多租户 E2E 门禁）
