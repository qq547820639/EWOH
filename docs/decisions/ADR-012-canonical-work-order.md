# ADR-012：Canonical Work Order（维护/质量 → 工单闭环，Event→Outcome）

- **状态**：Accepted
- **日期**：2026-08-16
- **阶段**：Phase 6 — Closed-loop Operations（NO-05e-a 契约层；NO-05e-b 表/接线随后）
- **关联**：总提示词 §3（Canonical Task/Execution Model）/§6（Maintenance Loop、
  Quality Incident Loop 必须从 Event 开始到 Outcome 结束）/§36；ADR-006（Identity）、
  ADR-007（Risk）、ADR-010（Maintenance/Quality）、ADR-011（质量入调度）

## Context（现状证据，2026-08-16 实测）

- MaintenanceCondition 生命周期含 `work_order_created` 状态与 `workOrderRef`
  裸字符串列（standalone_034）；QualityFinding 处置 `rework` 后无任何下游事实。
- 事件目录有 MaintenanceConditionDetected/Resolved、QualityFindingDetected/
  Dispositioned，但**没有工单实体与工单事件**：维护/质量闭环在"决策"处断链，
  无法回答「这个工单完成了没有」「处置产生了什么 Outcome」。
- 总提示词 §6 要求闭环 Event→Outcome；§3 要求 Canonical Task/Execution Model
  向统一 Contract 收敛——工单是维护/质量闭环的 Execution 载体，必须先契约化
  再接线（§30：先修领域模型/契约/边界，再修实现）。

## Decision（决策）

### 1. WorkOrder 契约（contracts/workorder/work-order.schema.json v1.0.0）

- **字段**：workOrderId（EWOH 生成，非空字符串，内部唯一；第三方工单号仅作
  alias 引用）、workOrderType ∈ {maintenance, quality_rework, inspection}、
  origin = {kind ∈ {maintenance_condition, quality_finding}, id}（必填，
  工单必须可追溯其起源事实）、subjectEntityId（规范身份，ADR-006）、
  severity（Canonical Risk 阶梯，ADR-007）、status 生命周期
  `created → scheduled → in_progress → completed → closed`（created/scheduled
  可 `→ cancelled`；in_progress 起不可取消——已开工必须走完成路径）、
  scheduledFor/completedAt（ISO 8601，可选）、cancelledReason（cancelled 必填）。
- **规则（机器可执行）**：origin 必填且 kind 封闭；completed/closed 必须带
  completedAt；cancelled 必须带 cancelledReason；severity 归一化失败拒绝。
- **语义边界（显式）**：WorkOrder 是 EWOH 的工单认知（Execution 事实），
  **不替代** MES 原生工单——MES 工单号经 identity mapping 作为 alias 关联
  （ADR-006 第三方 ID 不进内部 ID 的原则）。

### 2. 事件（Event→Outcome）

- `WorkOrderCreated`（com.ewoh.workorder.created）：工单创建即发布
  （maintenance 条件转 work_order_created、quality finding 处置为 rework 时）。
- `WorkOrderCompleted`（com.ewoh.workorder.completed）：工单 completed/closed
  时发布，载荷含 origin 引用——闭环 Outcome 可审计。

### 3. 交付纪律（与既有域一致）

- Python/TS 双实现 + 共享测试向量 + `audit-domain-contracts.js` 独立仲裁
  （JS 第三方重实现契约语义）+ Golden Scenario 第 8 场景 `workorder_loop`
  （双执行器消费同一份场景定义）。
- NO-05e-b（下一轮）：standalone_035 ewoh_work_order 表（TENANT_SCOPED RLS +
  成对 rollback + verify）+ 云侧 WorkOrder 模块 + maintenance/quality 服务
  事件接线扩展；本轮先落契约层 + 事件目录 + 云侧事件发端（无表，事件层先
  闭环，不虚构持久化）。

## Rejected Alternatives（否决方案）

1. **直接写 MES 工单接口**：无 Canonical 契约即对接 MES 会把 MES 语义直接
   泄漏进 EWOH（§30 边界错误）；且本机无 MES 环境，无法验证——先契约后适配。
2. **复用 ewoh_schedule_task 当工单**：调度任务是执行任务（派工语义），
   工单是维护/质量处置的 Execution 载体（决策→完成语义），混用会造成任务
   语义膨胀与调度事实污染。
3. **workOrderRef 裸字符串继续充当事实**：无状态机、无事件、无追溯——
   这正是本 ADR 要消除的断链。
