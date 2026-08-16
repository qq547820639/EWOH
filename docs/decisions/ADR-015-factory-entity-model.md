# ADR-015：Canonical Factory Entity Model（Phase 3 World Model 契约化启动）

- **状态**：Accepted
- **日期**：2026-08-16
- **阶段**：Phase 3 — World Model（NO-03a 契约层）
- **关联**：总提示词 §3（Canonical Entity Model 收敛）/§4（World Model 实体清单 +
  所有实体必须支持唯一 ID/类型/Tenant/Factory/时间语义/状态/来源/版本/置信度/
  可追溯关系/事件历史）/§13（模拟数据显式标记）；ADR-006（Identity）/
  ADR-008（World State 契约）。

## Context（现状证据，2026-08-16 实测）

- 已有：ADR-008 world-state 契约（StateRecord 双时态 + 22 类 entityTypeRegistry +
  sourceTypeRegistry {real, simulated, derived} + Snapshot）；边缘 world_model/
  （contract_store 已装配；state_store/replay/prediction/event_graph 库级未接线）；
  云侧 world 模块（当前世界状态 + 回放）。
- 缺口：§4 的 45 类实体清单（Person…Knowledge）没有**版本化注册表契约**；
  "所有实体必须支持"的字段要求（Tenant/Factory/来源/版本/置信度/可追溯关系/
  事件历史）散落在各域实现中，无统一判定器；跨运行时（Python/TS）无共同
  消费点——factory-world-model 仍 Partial。

## Decision（决策）

### 1. Canonical Entity Model 契约（contracts/entity/entity-model.schema.json）

- **entityKindRegistry（45 类封闭注册表）**：§4 全清单
  Person/WorkerCapability/Skill/Certification/Fatigue/Workload/ErgonomicRisk/
  Exo/Machine/Robot/AGV/Tool/Material/Container/Inventory/Order/
  ProductionOrder/Operation/Task/WorkInstruction/Station/Zone/Route/Factory/
  Warehouse/Sensor/Observation/Event/Alert/Incident/Risk/QualityFinding/
  MaintenanceCondition/Reservation/Assignment/Plan/Decision/Approval/Execution/
  Outcome/Policy/Constraint/Model/Agent/Knowledge（snake_case 规范名）；
- **分层关系（机器可执行）**：world-state 的 22 类快照实体 ⊂ entityKindRegistry
  （快照是实体模型的可观察投影子集）；identity 42 类 kind 是"可寻址主体"
  子集，两者经实体声明 entityId 关联；
- **实体声明字段契约**（validate_entity_declaration）：
  - entityId：规范身份（ADR-006）；
  - kind ∈ 注册表；tenantId / factoryId 必填非空（§4 Tenant/Factory）；
  - timeSemantics：validFrom 必填 ISO，validTo 可选且不得早于 validFrom
    （双时态，与 ADR-008 同源；解析失败拒绝）；
  - status 非空；source ∈ {real, simulated, derived}（与 ADR-008
    sourceTypeRegistry 同源，模拟数据显式标记 §13）；
  - version ≥ 1（单调治理）；confidence 可选 ∈ [0,1]（缺省 = 无标定，
    不得伪装确定答案）；refs / eventRefs：规范身份数组（可追溯关系/事件历史）。
- **交付纪律**：Python/TS 双实现 + 共享向量 + audit-domain-contracts 增 entity
  域独立仲裁（含快照 22 类 ⊆ 45 类交叉校验）+ Golden Scenario 第 11 场景。

### 2. 权威投影分工（显式声明，NO-03b 接线依据）

- 云侧 world 模块 = **权威投影**（当前世界状态 + 回放，consuming 快照 22 类）；
- 边缘 world_model = 本地认知（contract_store 已装配；state_store/replay/
  prediction/event_graph 逐步接线，NO-03b）；边缘本地状态绝不冒充云端权威
  （离线期间本地认知 + 上线 reconcile，与 §20 一致）；
- 实体声明（本契约）是两者共同的事实描述语言。

### 3. 后果

- 正面：§4 实体清单版本化、字段要求机器可判定、双运行时共同消费；模拟/真实/
  派生来源显式统一。
- 负面/代价：45 类注册表为 v1 初始清单，新增实体走契约版本演进（封闭注册表
  纪律与 conditionType 等同）。
- 无新表（契约层先行，§30）。

## Rejected Alternatives（否决方案）

1. **实体清单开放字符串**：无法统计/审计（同 ADR-013/014 纪律，封闭注册表）。
2. **各域各自定义实体字段**：§3 禁止多事实源——本契约是跨域统一判定器。
3. **confidence 缺省 1.0**：无标定不得伪装确定（§10/§33）。

## Amendment 1（Round 25 / NO-03b 运行时接线与投影分工加固）

### 动机

NO-03a 交付了契约层，但两个可执行面未闭合：
1. 声明 kind 与 entityId 的 kind 前缀之间没有机器强约束——`machine:...` 却声明
   kind=station 的脏事实无法被判定器拒绝；
2. 云侧粗粒度投影（person/device/station/task 桶）与 45 类实体注册表、身份
   42 类注册表的映射关系未显式化，device 桶（遗留身份桶）与设备类实体 kind
   （exo/machine/robot/agv/sensor）的边界只有注释没有机制。

### 决策

1. **kind 前缀一致性（新契约规则 kindPrefixConsistency）**：entityId 的 kind 前缀
   必须 ∈ entityKindRegistry 且等于声明 kind。身份专属 kind（device/session）不得
   承载实体声明（错误码 `kind_prefix_unknown`）；实体 kind 前缀与声明 kind 不一致
   拒绝（`kind_prefix_mismatch`）。检查顺序在 unknown_kind 之后（未知 kind 优先
   报 unknown_kind）。
2. **projectionDivision 实例值（schema 锁定）**：
   - stateProjectableKinds = world-state 22 类（可观察状态投影，集合恰等）；
   - identityOnlyKinds = {device, session}（仅身份发证域）；
   - entityOnlyKinds = {worker_capability, fatigue, workload, ergonomic_risk,
     production_order}（仅模型事实，无状态投影）。
   门禁以 identity 42 类 / entity 45 类两个注册表独立推导差集并与 schema 声明
   逐项核对（单一事实源，不允许第三份手维护清单）。
3. **projectionBuckets 实例值（schema 锁定）**：云侧粗粒度投影桶映射——
   personBucket=[person]、deviceBucket=[device, exo, machine, robot, agv, sensor]、
   stationBucket=[station]、taskBucket=[task]；`validateCloudWorldSnapshot` 改由
   桶映射校验 entityId kind（替代硬编码单 kind）。
4. **边缘运行时接线（ContractWorldStore.declare_entity）**：
   - 声明校验 fail-closed + 重复声明不变式（kind/tenantId/factoryId/source 不可变、
     version 严格递增、validFrom 不回拨）；
   - 已声明实体 set_state 交叉校验：kind 必须可状态投影
     （`entity_not_state_projectable`）、entityType == 声明 kind
     （`entity_type_mismatch`）、状态生效时间不得早于声明（`state_precedes_declaration`）；
   - to_dict/from_dict 状态+声明整体持久化（恢复时逐条重校验）。
5. **Predictor 接线**：预测目标 target_entity_id 必须是规范身份，非法 fail-closed
   抛 ValueError（预测是工厂事实候选，不携带不可追溯实体引用）。

### 后果

- 正面：投影分工从注释变成 schema 实例值 + 门禁强制 + 运行时 fail-closed；
  实体声明与状态写入在边缘本地认知层机器互锁。
- 代价：device:/session: 前缀实体必须先经身份映射转为实体 kind 才能声明/预测。
- 无迁移（契约层 + 边缘内存态；云侧无表变更）。

## Amendment 2（Round 26 / NO-03b 收口：生产调用链 + 生成器 + 因果事件）

### 动机

Amendment 1 之后实体模型仍是"可判定但未进生产调用链"：ContractWorldStore 已装配
却无 HTTP 写/读入口、event_graph 因果节点可携带裸 ID、注册表双实现仍为手写
（§31/§2：能由 Contract 或 Generated Code 解决的，不维护两套手写定义）。

### 决策

1. **因果事件规范实体引用**：build_shift_chain 与 ContractWorldStore.record_event
   强制 person_id/载荷 person_id·device_id·task_id·station_id·zone_id 为规范身份
   （fail-closed ValueError/WorldStoreContractError）；因果链是工厂事实载体，
   不携带不可追溯裸 ID。
2. **边缘生产调用链（routes/replay.py 六端点）**：
   GET /api/world/snapshot、POST /api/world/entities（declare_entity）、
   POST /api/world/states（set_state）、GET /api/world/replay（Replay.at）、
   POST /api/world/events（record_event）、POST /api/world/predictions
   （Predictor 派发，未触发阈值返回 null 而非伪造）。world_store 未装配一律
   503 fail-closed；server.Context 注入 world_store（缺省 None），run.py 真实装配。
3. **离线持久化**：run.py 启动时从 `<db>.worldstate.json` 恢复、停机时整体落盘
   （状态+声明+因果事件）；加载/保存失败显式 ERROR 记录（本地认知可由云端权威
   投影 reconcile 重建，不静默吞）。
4. **Entity Contract 生成器**：scripts/gen-contract-registries.js 以
   entity-model.schema.json 为单一事实源生成 Python/TS 注册表代码块（生成区
   标记夹住），--check 挂 make truth-check；audit-domain-contracts.js 保留为
   独立仲裁双保险（生成器与仲裁器互相独立实现，任一方漂移都会被拦）。

### 后果

- 正面：实体模型闭环（契约→生成→校验→HTTP 调用链→事件→持久化→Golden）；§36
  判据全绿，canonical-entity-model 升 Implemented。
- 代价：生成区手改会被 --check 拦截（注册表变更必须走 schema）。
- 无迁移（边缘 JSON 持久化为新增文件，不影响既有 sqlite 数据）。
