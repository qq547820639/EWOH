# ADR-007：Canonical Risk / Location / Resource 契约（Phase 2 收尾）

- **状态**：Accepted
- **日期**：2026-08-14
- **阶段**：Phase 2 — Canonical Contracts（NO-02c）
- **关联**：总提示词 §3/§4/§23；ADR-006（Identity，三者 subject 均引用规范身份）；
  capability-matrix `canonical-risk-model` / `canonical-location-model` /
  `canonical-resource-model`

## Context（语义审计证据，2026-08-14 实测）

**Risk（严重度两套税制并存）**
- 边缘：L1/L2/L3（`inference/rules.py` 事件码表 + `inference/events.py:232`
  `sev_order = {"L1": 3, "L2": 2, "L3": 1}`——**L1 最严重**）。
- 云侧：`alert` 模块 severity 为裸 `string`（无枚举，`api.interface.ts:125/346`）；
  风险登记工件 `contracts/artifact-schemas/risk.schema.json` 用
  critical/high/medium/low。两套税制无映射、无统一状态机。

**Location（类型开洞 + 坐标系语义分散）**
- 云侧 `SpatialEntityType` 为开放联合 `| string`（类型逃生舱，`api.interface.ts:242`）；
  `ewoh_spatial_entity` 以 `entityType + parentId + coordinate_type
  (FACTORY_CARTESIAN/WGS84/UNKNOWN)` 建模（P0-3 已锁定坐标类型语义）。
- 边缘 `spatial/` 已定义统一坐标约定（米制，+X 东 +Y 北 +Z 上，yaw 自北顺时针）
  与层级（集团→工厂→车间→产线→区域→工位→设备/人员/任务），但未契约化跨运行时。

**Resource（语义已收敛，缺锁定）**
- 双侧已收敛同一状态枚举：`AVAILABLE|RESERVED|BUSY|DEGRADED|OFFLINE|MAINTENANCE`
  （边缘 `scheduler/models.py:115-120`；云侧 `shared/scheduler.ts` ResourceState），
  且云侧已有新鲜度语义（dataQuality FRESH/STALE/UNKNOWN、source
  AUTHORITATIVE/DERIVED、fail-close 注释）。缺契约层强制与共享测试向量。

## Decision（决策）

### 1. Canonical Risk（contracts/risk/risk.schema.json）

- **规范严重度阶梯**：`critical > high > medium > low`（封闭枚举）。
- **Legacy 映射（显式、唯一、可逆）**：`L1→critical`、`L2→high`、`L3→medium`
  （与边缘 sev_order L1 最严重一致）。`low` 无 legacy 对应（仅供规范侧使用）。
- **风险生命周期**：`open → acknowledged → resolving → resolved → closed`；
  `resolving/resolved → open` 允许（复开，对应云侧 reopened 语义）。
- **RiskRecord 核心形状**：riskId、severity（规范）、status、category
  （封闭注册表：posture/load/battery/offline/sensor_degraded/time_sync/
  packet_loss/action_anomaly/quality/equipment/other）、subjectEntityId
  （规范身份 kind:value，复用 ADR-006）、sourceSystem、occurredAt、observedAt?、
  confidence?、evidenceRef?。
- 解析/归一化函数（`normalizeSeverity`）：接受 L1/L2/L3（legacy）→ 规范值；
  接受规范值直通；未知值 → 拒绝（fail-closed，禁止猜测）。

### 2. Canonical Location（contracts/location/location.schema.json）

- **空间类型封闭注册表（v1，21 类）**：factory、building、floor、area、workshop、
  production_line、zone、workstation、station、dock、warehouse_location、route、
  restricted_zone、device、person、task、camera、sensor、uwb_station、charging_area、
  staging_area。云侧 `SpatialEntityType` 收敛为 `(typeof SPATIAL_KINDS)[number]`
  （移除 `| string` 逃生舱为后续接线项，本轮先立契约）。
- **坐标类型**：`FACTORY_CARTESIAN | WGS84 | UNKNOWN`（与 P0-3 锁定语义一致；
  UNKNOWN 语义 = 无坐标可用，禁止 0,0 冒泡）。
- **坐标记录**：`{coordinateType, x?, y?, z?, yawDeg?, confidence?}`；
  FACTORY_CARTESIAN 约定 = 米制、+X 东 +Y 北 +Z 上、yaw 自北顺时针 [0,360)；
  WGS84 约束 lat∈[-90,90]、lng∈[-180,180]。
- `validateLocationRecord`：类型必填；UNKNOWN 不接受坐标值；越界 → 拒绝。

### 3. Canonical Resource（contracts/resource/resource.schema.json）

- **状态封闭枚举**：`AVAILABLE|RESERVED|BUSY|DEGRADED|OFFLINE|MAINTENANCE|UNKNOWN`
  （锁定双侧已收敛六态 + UNKNOWN 合法态）。
- **新鲜度语义锁定**：dataQuality ∈ FRESH|STALE|UNKNOWN；source ∈
  AUTHORITATIVE|DERIVED。
- **可用性判定（确定性、共享向量）**：`status==AVAILABLE ∧ dataQuality==FRESH`
  才可视为可用；STALE/UNKNOWN 一律 fail-closed 不可用（与 scheduler.ts 既有注释
  语义一致，本次上升为契约）；其余状态不可用但区分原因（reserved/busy/…）。
- ResourceReference：`{resourceId: kind:value, resourceType: person|device|station|
  tool|material|vehicle}`。

### 4. 交付模式（复刻 ADR-006 纪律）

- 契约文件为唯一事实源 + Python（`src/edge_platform/contracts/{risk,location,
  resource}.py`）与 TypeScript（`ewoh-spark-app/shared/{risk,location,
  resource}.ts`）锁定实现 + 每域共享 test-vectors + `scripts/audit-domain-contracts.js`
  独立仲裁门禁（挂 `make truth-check` 与 CI）。
- 本回合交付契约与实现；生产接线（云侧 alert severity 枚举替换、SpatialEntityType
  收敛、ResourceState.status 锁定）列为 NO-02c-b，逐点替换后按 §36 升 Implemented。

## Alternatives Considered

1. **统一为 L1-L3**：与云侧/行业 reporting（critical/high）脱节，且 L1 最严重的
   反直觉序易错。**否决**（保留显式映射表双向转换）。
2. **空间类型保持开放联合**：类型完整性丧失（正是现状问题）。**否决**。
3. **资源状态新增过渡态**：六态已在双运行时稳定运行，加态破坏兼容。**否决**，
   UNKNOWN 作为唯一新增合法态（且永不视为可用）。

## Consequences

- 正：三个 Canonical Model 收敛为版本化契约，双运行时共享向量强制一致；
  subject 引用规范身份（与 ADR-006 形成契约族）。
- 代价：云侧三处松散类型（alert severity、SpatialEntityType、ResourceState.status）
  需在 NO-02c-b 逐点收敛，涉及存量数据/接口兼容（strategy：枚举校验在入口
  normalize，存量非法值 → UNKNOWN 显式标记，不静默改写）。
- 风险：若接线未完成即宣称契约生效，将产生「契约/实现漂移」——门禁持续强制
  注册表一致，接线前 capability 状态保持 Partial。

## Migration

1. 本轮：契约 + 双运行时实现 + 共享向量 + 门禁（全新增，零破坏）。
2. NO-02c-b：云侧入口归一化接线（alert/ingest/ResourceProjection）+ SpatialEntityType
   收敛 + 存量非法 severity 显式 UNKNOWN 化（不静默改写）。
3. 回滚：契约纯新增；接线逐点可回退（normalize 在入口，删除即恢复 legacy 直通）。
