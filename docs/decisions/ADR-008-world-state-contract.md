# ADR-008：Canonical Factory World State Contract（Phase 3 启动）

- **状态**：Accepted
- **日期**：2026-08-14
- **阶段**：Phase 3 — World Model（NO-03）
- **关联**：总提示词 §4/§13/§21；ADR-006（Identity）/ADR-007（Risk/Location/Resource）；
  capability-matrix `factory-world-model` / `world-state-store-history`

## Context（语义审计证据，2026-08-14 实测）

**云侧（权威工厂级投影，真实产品级）**
- `WorldStateSnapshot`（shared/scheduler.ts）：snapshotVersion / ts / worldVersion /
  entityVersions（键形如 `person:<id>`，隐式 kind 前缀）/ reservations / persons /
  devices / stations / tasks / routeStatus / forbiddenZones / lockedAssignments /
  events / backlog；由 ResourceProjection（projectForSnapshot）聚合，status 已按
  ADR-007 收敛六态 + dataQuality 新鲜度。
- 快照版本原子分配（standalone_031 计数器）+ RLS 三分类（ADR-004）。

**边缘（本地运行时状态，库级未接线）**
- `world_model/state_store.py`：`WorldState` = state_id / entity_id / state_type /
  state_json / valid_from / valid_to（[valid_from, valid_to) 半开区间）/ source_type
  （real/simulated…）/ confidence / version；`set()` 关闭上一条 valid_to 并版本 +1；
  `at_time` / `history` / `snapshot` 查询；to_dict/from_dict 回放。
- `event_graph`（因果链）/ `replay`（时间轴重建+决策解释）/ `prediction`。

**分歧（契约必须收敛）**
1. 云侧快照数组用裸 `id`（uuid），仅 entityVersions 键带 kind 前缀——身份引用未契约化；
2. 时间语义双侧并存（云 ts+worldVersion / 边 valid_from..valid_to 双时态）无统一表述；
3. source_type/confidence 只在边缘有，云侧投影无来源维度（已在 ADR-007 补 source）；
4. state_type 自由字符串，无封闭注册表。

## Decision（决策）

### 1. 契约形态（contracts/world/world-state.schema.json）

- **StateRecord**（与边缘 WorldState 对齐的双时态核心，两侧通用）：
  `stateId、entityId（规范身份 kind:value，ADR-006）、entityType（封闭注册表）、
  stateJson、validFrom、validTo?（[valid_from, valid_to) 半开区间）、
  sourceType ∈ real|simulated|derived、confidence ∈ [0,1]、version ≥1、
  observedAt?（观察时间，§21 与 occurred/valid 分离的落点）`。
- **entityTypeRegistry（Phase 3 首覆盖 22 类）**：person / exo / machine / robot /
  agv / tool / material / container / inventory / order / operation /
  work_instruction / task / station / zone / route / factory / warehouse /
  sensor / event / risk / knowledge。
- **Snapshot**：`snapshotId、snapshotVersion、ts、worldVersion ≥0、entityVersions
  （Map<canonicalEntityId, version>，键必须规范身份）、states（StateRecord[]）、
  source ∈ AUTHORITATIVE|DERIVED`。
- **确定性规则（rules，机器可执行）**：
  1. 双时态区间合法性：validTo 缺失或 > validFrom；同 (entityId, stateType) 区间
     不得重叠（set() 语义：新状态开启时旧状态 validTo=新 validFrom）；
  2. 版本单调：同键新状态 version = 旧 version + 1；
  3. 模拟隔离（§13）：sourceType=simulated 的状态绝不参与 real 投影判定；
     混合来源快照必须显式标记；
  4. 新鲜度：投影可用性沿用 ADR-007（仅 AVAILABLE ∧ FRESH 可用）；
  5. fail-closed：未知 entityType/身份非法/confidence 越界 → 拒绝。

### 2. 权威性分工（防第二事实源）

- 云侧 `WorldStateSnapshot`（ResourceProjection/WorldStateService）= **工厂级权威投影**；
- 边缘 `world_model/StateStore` = **边缘本地运行时状态**（离线可用，store-and-forward
  上行）；
- 契约是**共享形状与校验语义**，不新建第三个状态存储；两侧各自持久化，经共享测试
  向量保证状态记录/快照语义一致（§31）。
- 模拟数据显式标记（sourceType=simulated）且绝不被云侧权威投影当作 real
  （§13 既有 isShadow/simulated source 纪律上升为契约规则 3）。

### 3. 交付模式（复刻 ADR-006/007 纪律）

契约文件为唯一事实源 + Python（`src/edge_platform/contracts/world.py`）与
TypeScript（`ewoh-spark-app/shared/world-contract.ts`）锁定实现 + 共享
test-vectors + `scripts/audit-domain-contracts.js` 扩展 world 域独立仲裁 +
Golden Scenario 增补 `world_state_projection_rules`（共享场景定义，双执行器）。

本回合交付契约与实现；生产接线（云侧 WorldStateSnapshot 构建时校验、
边缘 StateStore 接契约校验、entityVersions 键规范化）列为 NO-03b，
接线完成后 factory-world-model 按 §36 升 Implemented。

## Alternatives Considered

1. **统一存储（云侧替边缘/边缘替云侧）**：破坏离线能力（§20 Edge 离线必须可用）与
   现有 RLS/权威投影，重写成本无业务收益。**否决**。
2. **快照直接当世界模型**：快照是决策输入切片，非可回放的统一认知层；缺少双时态
   与因果链。**否决**（契约同时覆盖 StateRecord 与 Snapshot 两层）。
3. **state_type 开放字符串**：与 identity/risk 同理由，类型完整性丧失。**否决**。

## Consequences

- 正：世界状态记录/快照在双运行时收敛为共享契约；双时态、来源、置信度、模拟隔离
  上升为可验证规则；为 Phase 4 Event Envelope 与 Phase 9 Agent 依赖提供地基。
- 代价：云侧 snapshot 数组裸 id → 规范身份引用是接线工作量（NO-03b 逐点替换，
  兼容策略：数组内 id 保留 + 新增 entityId 规范引用字段，先并存后收敛）。
- 风险：若只立契约不接线，将重演「契约/实现漂移」——门禁持续强制注册表一致，
  接线前 capability 保持 Partial。

## Migration

1. 本轮：契约 + 双运行时实现 + 共享向量 + 门禁扩展 + Golden Scenario（全新增）。
2. NO-03b：云侧接线（snapshot 构建校验 + entityId 规范引用 + 边缘 StateStore
   校验器接入装配）+ 边缘 world_model 进入装配链决策。
3. 回滚：契约纯新增；接线逐点可回退（校验器在入口，删除即恢复直通）。
