# Event Envelope 全链路透传审计报告

**审计日期**: 2026-08-24
**审计范围**: ewoh_event 表 7 个 Event Envelope 字段的写入→存储→读取→API 响应全链路
**审计人**: MiMo Agent (R-146/R-147)

## 1. 背景

standalone_066（R-126~128）为 ewoh_event 表补全 7 个 Event Envelope 字段：
- `occurred_at` (timestamptz) — 事件发生时间
- `observed_at` (timestamptz) — 事件观察时间
- `received_at` (timestamptz) — 云端接收时间
- `causation_id` (varchar) — 引起本事件的事件 ID
- `correlation_id` (varchar) — 关联事件组 ID
- `confidence` (numeric) — 事件置信度 (0-1)
- `schema_version` (varchar) — 事件模式版本

## 2. 写入路径逐条清单

### 2.1 ingest 服务 — 边缘事件上行（ingestEventBatch）

| 字段 | 值来源 | 文件:行 |
|------|--------|---------|
| occurredAt | `envelope.occurredAt`（边缘上报的设备时间） | ingest.service.ts:589 |
| receivedAt | `now`（云端接收时间） | ingest.service.ts:590 |
| observedAt | 未写入（NULL） | — |
| schemaVersion | `'1.0.0'` | ingest.service.ts:591 |
| correlationId | `envelope.correlationId`（边缘上报，可能为 null） | ingest.service.ts:592-593 |
| causationId | `envelope.causationId`（边缘上报，可能为 null） | ingest.service.ts:594-595 |
| confidence | `envelope.confidence`（边缘上报的 `frame.quality?.confidence`，可能为 null） | ingest.service.ts:596-597 |

### 2.2 ingest 服务 — DataQualityAlert

| 字段 | 值来源 | 文件:行 |
|------|--------|---------|
| occurredAt | `now` | ingest.service.ts:1307 |
| receivedAt | `now` | ingest.service.ts:1308 |
| observedAt | `now` | ingest.service.ts:1309 |
| schemaVersion | `'1.0.0'` | ingest.service.ts:1310 |
| correlationId | `null` | ingest.service.ts:1311 |
| causationId | `null` | ingest.service.ts:1312 |
| confidence | `null` | ingest.service.ts:1313 |

### 2.3 其余 23 服务（内部事件）

所有内部事件使用统一模式：

| 字段 | 值来源 |
|------|--------|
| occurredAt | `now`（当前时间） |
| receivedAt | `now`（当前时间） |
| schemaVersion | `'1.0.0'` |
| correlationId | `null` |
| causationId | `null` |
| confidence | `null` |

逐条清单（insert 行号 + insert(ewohEvent) 行号）：

| # | 服务 | 文件 | insert 行 |
|---|------|------|-----------|
| 1 | identity | identity.service.ts | 281 |
| 2 | quality | quality.service.ts | 195 |
| 3 | gamification | gamification.service.ts | 681 |
| 4 | learning | learning.service.ts | 286 |
| 5 | outcome-annotation | outcome-annotation.service.ts | 174 |
| 6 | learning-proposal | learning-proposal.service.ts | 585 |
| 7 | exo-session | exo-session.service.ts | 261 |
| 8 | exo-config | exo-config.service.ts | 313 |
| 9 | simulation | simulation.service.ts | 262 |
| 10 | oee (1) | oee.service.ts | 195 |
| 11 | oee (2) | oee.service.ts | 336 |
| 12 | world | world.service.ts | 621 |
| 13 | mes | mes.service.ts | 1335 |
| 14 | agent | agent.service.ts | 805 |
| 15 | agent-orchestrator | agent-orchestrator.service.ts | 337 |
| 16 | rule-engine | rule-engine.service.ts | 201 |
| 17 | workorder | workorder.service.ts | 220 |
| 18 | knowledge | knowledge.service.ts | 319 |
| 19 | simulator | simulator.service.ts | 695 |
| 20 | dead-letter | dead-letter.service.ts | 262 |
| 21 | inference | inference.service.ts | 191 |
| 22 | maintenance | maintenance.service.ts | 203 |
| 23 | erp (1) | erp.service.ts | 114 |
| 24 | erp (2) | erp.service.ts | 207 |
| 25 | approval | approval-persistence.service.ts | 190 |

## 3. 读取路径审计

### 3.1 数据库查询层（代码验证）

所有事件读取路径使用 `select().from(ewohEvent)` **无列过滤**。Drizzle `select()` 不带列参数时返回表的全部列，因此 7 个 envelope 字段自动包含在查询结果中。

关键证据：
- `world.service.ts:128` — `this.db.select().from(ewohEvent)`（无列过滤）
- `world.service.ts:344` — `this.db.select().from(ewohEvent)`（无列过滤）
- `alert.service.ts:112` — `this.db.select().from(ewohEvent)`（无列过滤）
- `tracing.service.ts:163` — `this.db.select().from(ewohEvent)`（无列过滤）
- `scheduler/world-state.service.ts:258` — `this.db.select().from(ewohEvent)`（无列过滤）
- `oee.service.ts:246,272,396,411` — 均为 `select().from(ewohEvent)`（无列过滤）

### 3.2 API 响应层（代码验证）

事件通过以下 API 端点返回：
- `GET /api/world/events/chain/:eventId` — `world.controller.ts:26` → `worldService.getEventChain()`
- `GET /api/world/replay/context/:eventId` — `world.controller.ts:45` → `worldService.getEventContext()`
- `GET /api/world/snapshot` — 包含 `eventByMinute` 事件映射

**验证方法**：检查控制器和服务代码，确认无 DTO 层过滤 envelope 字段。

**结果**：
- `getEventContext()` 使用 `select().from(ewohEvent).where(...)` 直接返回数据库行，无中间 DTO 转换
- `getEventChain()` 类似，直接返回数据库行
- snapshot 中的 `eventByMinute` 直接传递数据库查询结果

**结论**：envelope 字段在 API JSON 响应中**必然存在**（代码级验证）。建议后续补充一次实际 curl 验证作为端到端证据。

### 3.3 时间戳语义验证

envelope 字段的时间戳语义（ADR-009）：
- 边缘事件：`occurred_at`（设备时间）≤ `received_at`（云端 now）— 通过 `envelopeSemantics()` 验证
- 内部事件：`occurred_at` = `received_at` = `now` — 语义等价（同一时刻产生和接收）
- `observed_at`：仅 DataQualityAlert 写入 `now`，其余为 NULL（边缘未上行观察时间）

## 4. 发现的问题

### 4.1 OpenAPI 规范（已验证 ✅）
`EnvelopeEventDto`（openapi/ewoh.yaml:15385）已包含全部 7 个 envelope 字段。**无需修复**。

### 4.2 内部事件因果链缺失（Low）
23 个内部服务的 `correlationId`/`causationId` 为 null。这意味着无法追踪内部事件间的因果关系。

**建议**：后续可为关键事件流（如同一调度周期产生的所有事件）共享一个 `correlationId`。优先级低，不影响功能正确性。

### 4.3 缺少端到端 API 响应验证（建议补充）
本次审计基于代码级验证（确认无 DTO 过滤），建议后续补充一次实际 `curl` 调用 `GET /api/world/snapshot` 验证 envelope 字段出现在 JSON 响应中。

## 5. 结论

| 维度 | 状态 | 验证方式 |
|------|------|----------|
| 写入持久化 | ✅ 25/25 路径全覆盖 | 逐条代码审查 |
| 数据库存储 | ✅ 7 字段均存在 | standalone_066 迁移 |
| 查询返回 | ✅ 自动包含（无列过滤） | 代码级验证 |
| API 响应 | ✅ 自动序列化返回 | 代码级验证（无 DTO 过滤） |
| OpenAPI 文档 | ✅ EnvelopeEventDto 已包含 | 行号验证 |
| 时间戳语义 | ✅ ingest 验证通过 | envelopeSemantics() |
| 因果链/关联 | ⚠️ 内部事件为 null | 可选增强 |

**总体评估**：Event Envelope 全链路透传**功能完整且文档完备**。建议后续补充端到端 curl 验证作为发布前检查。
