# ADR-006：Canonical Industrial Identity（统一工业身份契约）

- **状态**：Accepted
- **日期**：2026-08-14
- **阶段**：Phase 2 — Canonical Contracts（第一项落地）
- **关联**：总提示词 §3/§22；capability-matrix `canonical-identity-model`；NO-02

## Context（背景）

现状（走读实测证据）：

1. 边缘运行时使用**裸不透明 ID**：`device_id` / `person_id` / `task_id`（来源为适配器
   设备序列号、配置注入或生成值），无统一格式；`governance/consent.py` 内存在
   `"person:{id}/purpose:{...}"` 目标标签字符串，但它只是审计标签，不是实体身份方案。
2. 云侧数据库以 `varchar(255)` 存 `device_id`（`ewoh_device.device_id` 唯一键），
   值为边缘上报的原样字符串；空间实体为 `entityId + entityType + parentId`；
   ingest 以 `frame.entity_id ?? frame.device_id` 解析，**把第三方/设备原生 ID 直接
   当作内部唯一 ID 使用**。
3. 第三方 ID 映射仅有字段级 `catalog/mappings/*.yaml`（erp→ewoh 两套），
   无实体级 Identity Mapping 契约，无解析顺序定义，无冲突处理语义。
4. Python / TS / DB / OpenAPI 对"实体身份"各有各的定义，违反 §3「Contract 是
   跨运行时的事实源」。

风险（为什么现在做）：身份是 Factory Truth 的地基。身份歧义会直接导致错误派工、
错误审计归属与跨租户事实污染；后续 World Model / Event Envelope / Agent Tools
全部依赖统一身份引用。地基不定，上层契约无法收敛。

## Decision（决策）

### 1. 统一身份语法（Canonical Identity）

- 规范形式：`kind:value`，恰好一个冒号，大小写敏感，字节相等即身份相等。
- `kind`：`^[a-z][a-z0-9_]{0,31}$`，**封闭注册表**（v1 共 42 类，见
  `contracts/identity/identity.schema.json` 的 `kindRegistry`）：person / exo /
  device / machine / robot / agv / tool / material / container / inventory /
  order / task / operation / work_instruction / station / zone / route / factory /
  warehouse / sensor / event / alert / incident / risk / quality_finding /
  maintenance_condition / reservation / assignment / plan / decision / approval /
  execution / outcome / policy / constraint / model / agent / knowledge / skill /
  certification / session / observation。
- `value`：`^[A-Za-z0-9][A-Za-z0-9._~@-]{0,127}$`（≤128 字符，禁止 `:`、`/`、
  空格与百分号编码）。
- `exo:` 独立 kind（外骨骼是一等实体，§7），不允许把外骨骼当 `device:`。
- 未知 kind → 拒绝（fail-closed），绝不猜测类型。

### 2. 内部 ID 与第三方 ID 分离（§22 硬约束）

- 内部唯一 ID 的 `value` **必须由 EWOH 生成**（推荐 UUID v4，允许租户/工厂前缀的
  受控命名空间 token），**不得**直接使用 MES ID / WMS ID / PLC Tag / 设备序列号。
- 第三方 ID 通过 Identity Mapping 记录关联（见下），只作为 alias，不进入内部身份。
- 既有存量值（边缘设备序列号等）视为 **legacy ID**，保持可读可写（非破坏兼容），
  新注册实体一律采用规范身份 + mapping 记录；存量值迁移由 reconcile 任务在
  后续阶段执行（§Migration）。

### 3. Identity Mapping 契约（第三方 ID → 规范 ID）

`contracts/identity/identity-mapping.schema.json` 定义映射记录：

- `mappingId`（`map:<token>`）、`version`、`source: {system, id, idKind?}`、
  `target: {entityId}`、`authority ∈ {registration, adapter, manual}`、
  `status ∈ {active, superseded, revoked}`、`recordedAt / validFrom / validTo?`、
  `evidenceId?`。
- **解析顺序（确定性，双运行时一致）**：
  1. 仅 `status == active` 且时间窗口有效（`validFrom ≤ now < validTo`）的记录参与解析；
  2. `(source.system, source.id)` 精确匹配；
  3. 恰好 1 条 → 返回 `target.entityId`；
  4. ≥2 条 → 抛出 `ambiguous_identity`（fail-closed，禁止猜）；
  5. 0 条 → 返回 `None`（未映射，fail-closed 拒绝，禁止静默把第三方 ID 当内部 ID）。
- 重复映射请求幂等：按 `(source.system, source.id)` 唯一；重复登记同映射为无操作，
  登记冲突目标 → `ambiguous_identity`。

### 4. 契约为唯一事实源 + 运行时锁定注册表 + 漂移门禁

沿用仓库既有「生成 + no-drift」纪律：

- 权威源：`contracts/identity/identity.schema.json`（注册表 + 语法 + 规则）与
  `contracts/identity/test-vectors.json`（跨语言一致性向量）。
- Python 实现 `src/edge_platform/contracts/identity.py` 与 TypeScript 实现
  `ewoh-spark-app/shared/identity.ts` 各携带**锁定注册表**（由 schema 生成语义上
  等价常量），两侧必须消费同一 test-vectors（§31 共享测试向量）。
- 门禁 `scripts/audit-identity-contracts.js`：schema 形状、vectors 一致性、
  Python/TS 注册表与 schema 逐项相等；接入 `make truth-check` 与 CI test.yml。

### 5. 事件与消费

- `contracts/events/event-catalog.yaml` 新增 `EntityIdentityMapped`（source system/id
  → canonical entityId，authority/recordedAt 入 payload）。
- 消费方（后续轮次接线，本轮只立契约）：边缘适配器注册、云侧 ingest 实体解析、
  world/scheduler 引用、reconcile 迁移任务。

## Alternatives Considered（备选）

1. **URI 形式 `ewoh://tenant/factory/kind/uuid`**：把租户/工厂烘焙进 ID，会导致同一
   物理实体跨工厂复用困难、ID 迁移成本高；租户上下文应由事件信封承载（§5 envelope
   已含 tenant_id/factory_id），ID 保持纯实体身份。**否决**。
2. **继续用裸 UUID/序列号 + 应用层映射表**：无法回答"这个 ID 是什么类型/谁生成"，
   正是现状问题；不满足 §22「统一 Industrial Identity」。**否决**。
3. **ULID/雪花 ID 替代 `kind:value`**：不解决类型表达，且引入时间戳泄漏（ULID 前 48
   位是时间）。**否决**（但允许 UUID v4 作为 value）。
4. **开放注册表（任意 kind 字符串）**：失去类型完整性，cross-runtime 校验弱化为
   纯正则。**否决**，封闭注册表 + 版本化扩展（新增 kind = contract 小版本变更 +
   两侧同步 + 门禁通过）。

## Consequences（后果）

- **正**：身份语义在 Python/TS/DB/OpenAPI 收敛为单一 contract；第三方 ID 与内部 ID
  显式分离、可审计、可解释；跨语言一致性由共享测试向量 + 门禁强制。
- **负/代价**：存量数据在 reconcile 前处于 legacy 与 canonical 并存期，消费者需
  容忍两种值（varchar 兼容，无破坏）；新增 kind 需走契约变更流程（这是特性，非缺陷）。
- **风险**：若两运行时实现出现语义分叉，门禁必须在 CI 失败（`audit-identity-contracts`
  已在 test.yml 与 truth-check 双挂载）。

## Migration（迁移）

1. 本轮：契约 + 双运行时实现 + 共享向量 + 门禁（全部新增，零破坏，无数据迁移）。
2. 下一轮（NO-02b）：云侧 `identity_mapping` 表（tenant-scoped，RLS，成对迁移
   `standalone_032_identity_mapping.sql` + rollback + verify），ingest 实体解析接入
   契约，`EntityIdentityMapped` 事件落库。
3. 后续：legacy 存量值 reconcile 任务（按 source.system 自动登记 mapping，
   可回滚：任务只增不改，原值不动）。
4. 回滚：契约为纯新增；库表迁移成对可回滚；reconcile 任务停止即冻结现状。
