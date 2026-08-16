# ADR-010：Maintenance / Quality 领域模型（Phase 6 闭环启动）

- **状态**：Accepted
- **日期**：2026-08-14
- **阶段**：Phase 6 — Closed-loop Operations（NO-05）
- **关联**：总提示词 §4（MaintenanceCondition/QualityFinding 实体）/§6（Maintenance
  Loop、Quality Incident Loop 高价值闭环）/§8（Scheduler 输入含 Maintenance State /
  Quality State）；ADR-006（Identity）/ADR-007（Risk）/ADR-008（World State）/
  ADR-009（Envelope）

## Context（现状证据，2026-08-14 实测）

- capability-matrix：`maintenance-loop` = **Missing**（无 MaintenanceCondition 实体 /
  EAM 连接器 / 维护任务闭环）；`quality-domain` = Missing（仅 catalog/scenarios/
  quality-trace 场景包，无 QualityFinding 域模型与 QMS 连接器）。
- 已有相关事实：`ewoh_device.maintenance_start_ms/end_ms`（维护时间窗，已进
  ResourceProjection 的 maintenanceWindows 与调度约束）；边缘故障码
  fault_code/fault_name（ny_exo_a1 adapter）；事件目录 41 类（无维护/质量域类型）。
- §8 调度输入（Maintenance State / Quality State）目前仅设备维护窗间接参与，
  无统一维护/质量域事实，无法回答「哪台设备维护逾期」「哪个质量发现未处置」。

## Decision（决策）

### 1. MaintenanceCondition 域模型（kind: maintenance_condition）

- **字段**：conditionId、subjectEntityId（规范身份：machine/exo/device/tool）、
  conditionType ∈ 封闭注册表 {wear, calibration_due, fault_recurring,
  overdue_inspection, battery_degradation, anomaly}、severity（Canonical Risk
  阶梯 critical/high/medium/low，ADR-007）、status 生命周期
  `detected → acknowledged → work_order_created → resolved → closed`、
  dueAt?、detectedAt、resolvedAt?、evidenceRef?、tenantOrgId。
- **语义规则**：
  1. severity 走 Risk 契约 normalize（L1-L3 legacy 映射）；
  2. 生命周期转移确定性（closed 终态；resolved 前必须 work_order_created）；
  3. 逾期判定：dueAt < now ∧ status ∉ {resolved, closed} → `overdue: true`
     （机器可执行，供调度维护状态输入）；
  4. subjectEntityId 必须是规范身份（ADR-006）。

### 2. QualityFinding 域模型（kind: quality_finding）

- **字段**：findingId、findingType ∈ 封闭注册表 {defect, dimension_out_of_tolerance,
  nonconformance, material_mismatch, process_deviation}、severity（Risk 阶梯）、
  disposition 生命周期 `open → under_review → dispositioned → closed` +
  disposition 决策 ∈ {accept, rework, scrap, return}（dispositioned 必带决策）、
  关联 links（order/material/station/task 规范身份引用数组）、detectedAt、
  dispositionedAt?、evidenceRef?、tenantOrgId。
- **语义规则**：dispositioned 必须携带 disposition 决策；closed 为终态；
  links 必须是规范身份；severity 同 Risk 契约。

### 3. 事件闭环（Phase 6 核心：Event → Outcome）

事件目录新增 4 类型（下轮与契约实现同轮交付）：
`MaintenanceConditionDetected` / `MaintenanceConditionResolved` /
`QualityFindingDetected` / `QualityFindingDispositioned`——每个闭环从事件开始
（检测事件）到 Outcome 结束（解决/处置事件 + 状态落库），信封遵循 ADR-009。

### 4. 调度集成（§8 输入）

- Maintenance State：ResourceProjection 的 maintenanceWindows 已有 → 升级为消费
  MaintenanceCondition（未 resolve 的 condition 生成维护约束，overdue 影响资格）；
- Quality State：QualityFinding（open/under_review 的 finding 关联设备/工位 →
  safety/质量约束与资格影响，fail-closed：质量发现未处置的工位不派发新任务，
  策略可配置）。

### 5. 交付计划（复刻契约族纪律）

- 下一轮（NO-05a）：contracts/maintenance + contracts/quality 契约 + 双运行时实现 +
  共享向量 + 门禁扩展 + Golden Scenario（maintenance_quality_loop）+ 事件目录 4 类型。
- 随后（NO-05b）：standalone_034 双表迁移（TENANT_SCOPED RLS，成对 rollback）+
  云侧 maintenance/quality 模块 + 调度集成接线。

## Alternatives Considered

1. **并入 Risk 域**（MaintenanceCondition 当风险事件）：维护有独立生命周期与
   调度语义（dueAt/overdue/work_order），并入 Risk 会污染风险状态机。**否决**。
2. **Quality 并入 workflow**：quality-trace 场景包是编排层，缺领域事实层与状态机。
   **否决**（先立域模型，workflow 编排消费之）。
3. **先做 EAM/QMS 连接器**：无域模型前接第三方系统即把第三方 ID/状态当内部事实
   （违反 ADR-006）。**否决**（域模型先行，连接器随后映射）。

## Consequences

- 正：维护/质量成为一等领域事实（可查询/可状态机/可调度输入/可审计），
  Phase 6 两个高价值闭环获得领域地基；实体补入 World Model 实体注册表
  （maintenance_condition/quality_finding 已在 identity registry v1 预留）。
- 代价：两张新表 + 两个模块 + 事件目录扩展（后续两轮交付）。
- 风险：若只立模型不接线（调度消费未接），闭环仍不成立——NO-05b 接线前
  maintenance-loop/quality-domain 保持 Partial/Missing 如实标注。

## Migration

1. NO-05a：契约 + 双实现 + 向量 + 门禁 + Golden Scenario + 事件目录 4 类型（全新增）。
2. NO-05b：standalone_034 成对迁移 + 云侧模块 + 调度集成 + RLS E2E。
3. 回滚：契约纯新增；表迁移成对可回滚；调度集成按策略开关可退。
