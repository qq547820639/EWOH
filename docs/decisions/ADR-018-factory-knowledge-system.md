# ADR-018 — Factory Knowledge System 目标架构与 Knowledge Entry 契约（NO-07 立项）

- 状态：Accepted
- 日期：2026-08-16
- 决策者：long-cycle-agent
- 关联：总提示词 §12（Factory Knowledge System）、§15（多租户）、§16（客户数据原则）、
  ADR-006（Identity）、ADR-009（Envelope）、ADR-015（Entity Model）

## 背景

能力矩阵唯一 Missing 项 = knowledge-system：异常、诊断、人工判断、决策、调度、
维修、质量处置、恢复、失败都应产生 Evidence，并逐步形成 Industrial Knowledge
Graph / Incident Library / Resolution Library / Decision History / Failure
Pattern Library / Process Knowledge / Factory-specific Knowledge。跨工厂知识
不得直接泄露客户数据，必须区分五层（Global/Industry/Customer/Factory/Private
Operational Data）。本 ADR 立项知识系统（契约层先行，运行时随后分轮落地）。

## 决策

### 1. 知识条目是 Evidence 之上的派生资产（Factory Truth 不变）

- 知识条目（Knowledge Entry）必须引用 sourceEvidenceIds（规范身份数组）——
  知识可追溯（§3：任何事实可回答"为什么"）；
- 知识条目不改写任何事实：状态机仅 draft→verified→superseded
  （人工 verifiedBy 可审计，无隐式生命周期）；
- relatedEntityIds 形成知识图边（实体层锚点），图遍历由 evidence 链 +
  实体引用保证（不引入独立的图数据库——先以关系契约满足 §12，图存储随
  运行时评估）。

### 2. 五层知识分类（跨工厂隔离政策进入契约层）

| scope | 语义 | tenantId | provenance 声明 |
|---|---|---|---|
| global | 平台级通用知识（EWOH 维护） | 禁止 | 必填（训练来源/匿名化/授权/版本） |
| industry | 行业级共享知识（跨客户） | 禁止 | 必填 |
| customer | 客户级知识（租户内） | 必填 | 可选 |
| factory | 工厂级知识（租户内） | 必填 | 可选 |
| private_operational | 私有运营数据派生的知识 | 必填 | 禁止（永不出租户，不参与共享） |

- 跨租户共享条目（global/industry）必须显式声明 provenance
  {trainingDataSources, anonymizationPolicy, dataAuthorization, modelVersion}
  ——§16 数据授权/§15 跨工厂共享模型政策的机器可判定执行面；
- private_operational 条目 **永不出租户**：运行时查询以 RLS 强制 + scope
  CHECK 兜底（standalone_039）。

### 3. Knowledge Entry 契约字段（contracts/knowledge/knowledge-entry.schema.json）

knowledgeId（规范身份 knowledge:value）/ kind（6 类封闭注册表）/ scope（5 层
有序阶梯）/ title/summary/body（非空）/ sourceEvidenceIds（规范身份数组，
可追溯证据链）/ relatedEntityIds（规范身份数组，知识图边）/ tags（1..64 字符
标签数组）/ version ≥1 / status（draft/verified/superseded）/ verifiedBy
（可选规范身份）/ timeSemantics 双时态（与 ADR-008 同源）/ provenance
（global/industry 必填，private_operational 禁止，其余可选）/
auditTrail 必须 true / tenantId（customer/factory/private_operational 必填，
global/industry 禁止）。

### 4. 运行时边界（后续轮次实现，本 ADR 锁定）

- 云侧 knowledge 模块（standalone_039 ewoh_knowledge_entry：TENANT_SCOPED
  RLS + scope/kind/status CHECK + scope 与 tenant_id 一致性 CHECK）；
- Knowledge Agent（15 角色之一，ADR-016 Manifest 注册）作为检索/沉淀入口，
  写路径经正式 Command（record_evidence 同源）；
- 检索 API：按 scope 阶梯（租户内可见 global+industry+customer+factory，
  绝不越过 private_operational 边界）；跨租户检索 fail-closed。

### 5. 交付纪律

Python（contracts/knowledge.py）+ TypeScript（shared/knowledge-entry.ts）双
实现 + 共享向量 + audit-domain-contracts knowledge 域独立仲裁 + Golden
Scenario 第 14 场景（双执行器）。事件目录类型随运行时接线（KnowledgeEntryCreated）。

## 后果

- 正面：knowledge-system 与 cross-factory-knowledge-isolation-policy 进入
  Partial（契约层）；矩阵 Missing 清零；五层隔离成为机器规则（不再依赖纪律）。
- 代价：6 类 kind/5 层 scope 为 v1 封闭注册表，演进走契约版本。
- 无迁移（契约层先行；运行时 standalone_039 随实现轮 lockstep）。

## Rejected Alternatives（否决方案）

1. **知识条目无证据引用**：违反 §3 可追溯（知识必须回答"为什么"）。
2. **共享知识不声明 provenance**：违反 §15/§16 跨工厂共享政策。
3. **自由文本知识库**：不可机器校验/不可审计，违反既有契约纪律。
4. **立即引入图数据库**：先以关系契约 + 实体引用满足 §12，图存储由问题驱动
   （运行时评估）。

---

## Amendment 1（NO-07b，Round 38：Knowledge Runtime 落地）

### 决策 1：standalone_039 硬化既有表，而非新建表

仓库事实审计发现 `ewoh_knowledge_entry` / `ewoh_knowledge_base` 自原始
受管表包（standalone_001 / 001_ewoh_managed_tables）起已物理存在
（ewoh_knowledge_entry：org_id uuid NOT NULL + entry_id 全局唯一 + base_id
NOT NULL + content/text 列 + 通用 RLS 策略 ewoh_org_select/ewoh_service_all）。
因此 standalone_039 为 **ALTER 硬化迁移**（additive 列 + CHECK + RLS 策略
替换 + 唯一键重定义），绝不新建同义表（§33 禁止重复事实源）。

### 决策 2：共享层（global/industry）的租户归属 = 平台保留 org 哨兵

契约层规定共享条目禁止 tenantId；但 ewoh_knowledge_entry.org_id 必须保持
NOT NULL（001_verify 的 nullable_org / missing_org_request_defaults 不变量 +
request 级 GUC 缺省）。决议：共享条目 org_id = 保留哨兵 UUID
`00000000-0000-4000-8000-000000000000`（既有先例：uq_ewoh_system_config_org_key
的 coalesce 哨兵）。scope-tenant 一致性 CHECK 落 DB：
- scope ∈ {global, industry} → org_id = 哨兵 UUID；
- scope ∈ {customer, factory, private_operational} → org_id ≠ 哨兵 UUID
  （真实租户 org；行级归属由 RLS GUC 匹配强制）。
该 CHECK 把 §15/§16 跨租户隔离政策的"共享层无租户归属/租户层必有租户"
变成数据库不变量。

### 决策 3：RLS 策略替换（本表专用五层隔离策略）

替换本表遗留通用策略（ewoh_org_select / ewoh_service_all）为：
- `knowledge_entry_tenant_read`（authenticated SELECT）：
  `ewoh_org_visible(org_id) OR (scope ∈ {global, industry} AND org_id = 哨兵)`；
- `knowledge_entry_service_all`（service_role FOR ALL，GUC idiom 与
  standalone_025/032-038 一致）：
  `org_id::text = COALESCE(current_org, primary_org)`（租户层）或
  `scope ∈ {global, industry} AND org_id::text = 哨兵`（共享层）。
结果：租户行仅本租户可见；共享行全租户可读（写路径仅知识模块/平台角色）；
private_operational 与 customer/factory 行永不出租户（数据库级强制）。

### 决策 4：检索阶梯（service 层与 RLS 双强制）

- 租户内检索：可见 = 共享层（global+industry）∪ 本租户层
  （customer/factory/private_operational）；
- 共享检索（无 org 上下文）：仅 global+industry，**绝不返回
  private_operational/customer/factory**（fail-closed：共享请求带租户层
  scope 过滤时显式拒绝）；
- 跨租户数据物理不可见由 RLS 兜底，语义阶梯由 service 层显式执行（双层，
  非单一纪律）。

### 决策 5：遗留数据映射（显式、可追溯，非静默归一）

- content → body（RENAME，单一事实源）；
- kind ← 'process_knowledge'（遗留 general 知识语义），scope ← 'factory'，
  status ← {verified, superseded} 保持、其余归一 'draft'；
- summary ← title（仅当 summary 为空，映射记录于迁移注释）；
- valid_from ← _created_at；source_evidence_ids ← '[]'（遗留无证据链：
  检索返回时显式标记 `legacyWithoutEvidence=true`，绝不伪造证据）；
- base_id 置 NULL 允许（新条目无知识库归属）；
- entry_id 全局唯一 → UNIQUE (org_id, entry_id)（多租户同一 knowledgeId
  不再冲突，与 ADR-006 规范身份租户化语义一致）。
回滚：body→content 反向 RENAME + 删列/约束 + 恢复通用策略 + 恢复全局唯一。

### 决策 6：契约注册表扩展 register_knowledge（向后兼容）

Agent commandRegistry（schema + Python + TS 三处 lockstep）新增
`register_knowledge`（Knowledge Agent 的正式写命令，L1 一律人审）。已有
向量不受影响（未知命令负例仍为未注册值）；audit-domain-contracts agent 域
为一致性比较（非计数），扩展后保持全绿。

### 决策 7：KnowledgeEntryCreated 目录事件

events 目录新增 `KnowledgeEntryCreated`（com.ewoh.knowledge.entry_created，
channel knowledge.entry.created，53→54 类）+ 双运行时投影
（shared/event-catalog.ts / contracts/event_catalog.py lockstep）。创建幂等：
唯一 (org_id, entry_id) 冲突回读既有行、不重复发事件（与 standalone_035
工单同语义）。

### 决策 8：状态转移语义（人工 verifiedBy 可审计）

- draft → verified：必须提供 verifiedBy（规范身份）；verified 无需再 verify；
- draft/verified → superseded；superseded 终态（不可再转移）；
- 共享层条目（global/industry）对租户只读（平台维护），租户转移显式拒绝
  （shared_entry_readonly）；转移仅作用于本租户层条目。
