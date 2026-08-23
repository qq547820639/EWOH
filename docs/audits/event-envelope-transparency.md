# Event Envelope 全链路透传审计报告

**审计日期**: 2026-08-24
**审计范围**: ewoh_event 表 7 个 Event Envelope 字段的写入→存储→读取→API 响应全链路
**审计人**: MiMo Agent (R-146)

## 1. 背景

standalone_066（R-126~128）为 ewoh_event 表补全 7 个 Event Envelope 字段：
- `occurred_at` (timestamptz) — 事件发生时间
- `observed_at` (timestamptz) — 事件观察时间
- `received_at` (timestamptz) — 云端接收时间
- `causation_id` (varchar) — 引起本事件的事件 ID
- `correlation_id` (varchar) — 关联事件组 ID
- `confidence` (numeric) — 事件置信度 (0-1)
- `schema_version` (varchar) — 事件模式版本

R-126~128 已完成 25/25 写入路径的 envelope 字段持久化。本次审计验证读取/API 响应链路。

## 2. 写入路径审计（已完成，R-126~128）

### 2.1 ingest 服务（2 路径）✅
- 边缘事件上行（ingestEventBatch）：occurredAt/receivedAt/schemaVersion/correlationId/causationId/confidence
- DataQualityAlert：occurredAt/receivedAt/observedAt/schemaVersion

### 2.2 其余 23 服务（23 路径）✅
identity / quality / gamification / learning (3) / exo (2) / simulation / oee (2) / world / mes / agent / agent-orchestrator / rule-engine / workorder / knowledge / simulator / dead-letter / inference / maintenance / erp (2) / approval

所有路径均写入 occurredAt/receivedAt/schemaVersion（correlationId/causationId/confidence 为 null）。

## 3. 读取路径审计

### 3.1 数据库查询层
所有事件读取路径使用 `select().from(ewohEvent)` 或等价 drizzle 查询，返回 ALL columns。因此 7 个 envelope 字段**自动包含在查询结果中**。

关键读取路径：
| 服务 | 文件 | 读取方式 | envelope 字段返回 |
|------|------|----------|-------------------|
| world | world.service.ts:128,344 | select().from(ewohEvent) | ✅ 自动包含 |
| alert | alert.service.ts:112,119,129 | select().from(ewohEvent) | ✅ 自动包含 |
| tracing | tracing.service.ts:163 | select().from(ewohEvent) | ✅ 自动包含 |
| gamification | gamification.service.ts:916,1068 | select().from(ewohEvent) | ✅ 自动包含 |
| learning | learning.service.ts:206 | select().from(ewohEvent) | ✅ 自动包含 |
| scheduler | world-state.service.ts:258 | select().from(ewohEvent) | ✅ 自动包含 |
| oee | oee.service.ts:246,272,396,411 | select().from(ewohEvent) | ✅ 自动包含 |

### 3.2 API 响应层
事件通过以下 API 端点返回：
- `GET /api/world/events/chain/:eventId` — 事件链查询
- `GET /api/world/replay/context/:eventId` — 回放上下文
- `GET /api/world/snapshot` — 世界快照（含最近事件）
- 各域服务内部查询（alert/gamification/learning/oee 等）

由于 drizzle `select().from(ewohEvent)` 返回所有列，envelope 字段**在 API JSON 响应中自动序列化返回**。

### 3.3 时间戳语义验证
envelope 字段的时间戳语义（ADR-009）：
- `occurred_at` ≤ `observed_at` ≤ `received_at`（5min drift 容忍）
- ingest 服务通过 `envelopeSemantics()` 函数验证此约束
- 内部事件（23 服务）使用 `now` 作为 occurredAt/receivedAt，语义等价

## 4. 发现的问题

### 4.1 OpenAPI 规范（已验证）
**状态**：`EnvelopeEventDto`（openapi/ewoh.yaml:15385）已包含全部 7 个 envelope 字段（eventId/eventType/schemaVersion/occurredAt/observedAt/receivedAt/source/subject/causationId/correlationId/confidence/payload/evidence）。**无需修复**。

### 4.2 内部事件 envelope 语义（Low）
**问题**：23 个内部服务的事件写入使用 `now` 作为 occurredAt/receivedAt，correlationId/causationId/confidence 为 null。
**影响**：内部事件缺少因果链和关联信息，无法追踪事件间关系。
**修复建议**：后续可按需为关键内部事件添加 correlationId（如同一调度周期的所有事件共享一个 correlationId）。

## 5. 结论

| 维度 | 状态 |
|------|------|
| 写入持久化 | ✅ 25/25 路径全覆盖 |
| 数据库存储 | ✅ 7 字段均存在 |
| 查询返回 | ✅ 自动包含（select all columns） |
| API 响应 | ✅ 自动序列化返回 |
| OpenAPI 文档 | ✅ EnvelopeEventDto 已包含全部 7 字段 |
| 时间戳语义 | ✅ ingest 验证通过 |
| 因果链/关联 | ⚠️ 内部事件为 null（可选增强） |

**总体评估**：Event Envelope 全链路透传**功能完整且文档完备**。仅内部事件的因果链/关联信息为可选增强。
