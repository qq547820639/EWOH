# ADR-004：MES → Scheduling V2 事实源收敛

- 状态：**ACCEPTED（待实施）**
- 日期：2026-08-08
- 关联：走读第 2 项 "MES Schedule → Scheduling V2 收敛"；前轮审计 P0 "Scheduler 多套语义并存"

## 背景与问题

当前 MES 工单在代码中同时存在**两条互相独立的写入路径**：

| 路径 | 入口 | 写入表 | 数据形态 |
| ---- | ---- | ------ | -------- |
| MES 正式域 | `POST /api/mes/work-orders`（`MesService.createWorkOrder`） | `ewoh_schedule_task` + `ewoh_schedule_task_step` | 完整工单：标题/描述/优先级/来源='mes'/工序(SOP/物料/人员/设备)/trace/inspections |
| Ingest 残留 | `POST /api/ingest/mes`（`IngestService.ingestMes`） | `ewoh_schedule_plan`（strategy='mes_order'，status='proposed'） | 仅 3 字段（planName/reason），无任务、无工序、无资源 |

### 后果

1. **双事实源**：同一 MES 工单（`order_id`）既存在于 `ewoh_schedule_task`（正式域），又可能作为残缺 plan 存在于 `ewoh_schedule_plan`，两者无关联、状态不同步。
2. **语义污染 Scheduling V2**：`ewoh_schedule_plan` 是 Scheduler V2 的方案事实表（含 snapshotVersion/policyVersion/solverVersion 等），MES 残片混入后，`GET /api/scheduler/plans` 会返回无法审批/下发的 `mes_order` 伪方案，破坏 V2 状态机语义。
3. **无法进入调度闭环**：`mes_order` plan 无 assignments、无 snapshot，SchedulePanel/Workbench 无法操作，属于 dead data。

## 决策

### 1. SSOT（单一事实源）

- **MES 工单的唯一事实源 = `ewoh_schedule_task`（+ `ewoh_schedule_task_step`）**，由 `MesService`（`/api/mes/*`）独占写入。
- **Scheduling V2 的唯一事实源 = `ewoh_schedule_plan` + `ewoh_scheduling_plan_assignment`**，由 `SchedulerService`/`PlanService` 独占写入。
- **禁止 Ingest 层再生成任何 scheduling truth。**

### 2. 目标数据流

```text
MES Order / Operation
        ↓  (仅一条路径)
MesService.createWorkOrder            → ewoh_schedule_task + step   [Canonical Production Task 投影]
        ↓  (由调度侧显式触发，非 MES 写调度表)
Scheduler V2 createRun / replan       → ewoh_schedule_plan + assignment  [Scheduling V2 权威]
        ↓
Dispatch → Reservation / Assignment
```

### 3. 遗留路径处置

- `POST /api/ingest/mes`（`IngestService.ingestMes`）：
  - **标记 deprecated**，停止写入 `ewoh_schedule_plan`。
  - 兼容行为：若需保留 M2M 接入，改为转发到 `MesService.createWorkOrder`（映射为 canonical `ewoh_schedule_task`），不再直接写 scheduling 表。
  - 最终移除（见迁移计划）。

### 4. 表语义澄清

| 表 | 角色 | 拥有者 | 状态 |
| -- | ---- | ------ | ---- |
| `ewoh_schedule_task` | **MES 工单 / Production Task Canonical** | `MesService` | 保留（事实源） |
| `ewoh_schedule_task_step` | 工单工序（含 SOP/物料/资源） | `MesService` | 保留（事实源） |
| `ewoh_production_task` | 通用生产任务（非 MES 专属） | `TaskService` | 保留（并行域，与 MES 工单的关系待 ADR-005 澄清） |
| `ewoh_schedule_plan` | **Scheduling V2 方案权威** | `SchedulerService` | 保留（**禁止 MES/Ingest 写入**） |
| `ewoh_scheduling_plan_assignment` | 方案内排程 | `PlanService` | 保留 |

### 5. 不变量

- 任何写入 `ewoh_schedule_plan` 的代码必须来自 scheduler 域（`SchedulerService`/`PlanService`/`DispatchCoordinatorService`）。
- `strategy='mes_order'` 的存量行：一次性清理或迁移（见迁移计划）。
- MES 到调度的衔接通过**显式调用 Scheduler V2**（`createRun(taskIds=[...])`），由调度侧从 `ewoh_schedule_task` 构建 snapshot，MES 不直接触碰调度表。

## 兼容性与迁移计划

1. **Step 1（不改 DB）**：`ingestMes` 改为转发到 `MesService.createWorkOrder`（映射字段：order_id→orderId, product_code→productCode, quantity→orderQty），不再写 `ewoh_schedule_plan`；保留响应兼容（`{accepted, record_id}`）。
2. **Step 2（数据清理）**：提供一次性 SQL/脚本删除存量 `ewoh_schedule_plan WHERE strategy='mes_order'`（无 assignments 的残片），或迁移为 `ewoh_schedule_task`。
3. **Step 3（移除）**：确认 `POST /api/ingest/mes` 无外部调用方后，移除端点或保留为纯代理（deprecated 标记）。

## 影响面

- `IngestService.ingestMes`（改）→ 需注入 `MesService`（新增依赖）
- `ewoh-spark-app/server/modules/ingest/ingest.module.ts`（改，import MesModule）
- OpenAPI `/api/ingest/mes`（更新 schema 注释/语义）
- 存量数据清理脚本（新增 `db/` 或 `scripts/`）

## 验证

- 单测：`ingestMes` 不再写 `ewoh_schedule_plan`；转发后 `ewoh_schedule_task` 有对应行。
- 集成：MES 工单创建后调用 Scheduler V2 `createRun`，确认 plan 只来自 scheduler 域。
- 迁移后：`SELECT count(*) FROM ewoh_schedule_plan WHERE strategy='mes_order'` = 0。

## 备选方案（未采纳）

- **A：保留双写但加关联键** —— 无法解决"两个事实源"根本问题，且污染 V2 状态机，拒绝。
- **B：Ingest 直接调 SchedulerService.createRun** —— 引入 ingest→scheduler 跨域耦合，且 MES 工单应先成为 canonical task，拒绝。
