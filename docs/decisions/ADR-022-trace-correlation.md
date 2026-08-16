# ADR-022：全链路 Trace 贯通（§19 Correlation ID 传播契约）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-009（Envelope correlationId）/ ADR-004（GLOBAL_SHARED 先例）/
  审计哈希链（ewoh_audit_log.request_id）
- 驱动：NO-10a（Round 42，§19 Observability：UI→API→Domain→Event→DB→Edge→
  Device 全链路追踪 + Correlation ID）

## 背景

§19 要求"必须能够从一次用户操作追踪到 UI Request→API→Domain Command→
Event→Scheduler→Agent→DB→Edge→Device，必须使用 Correlation ID"。现状：
- TracingInterceptor 已为每个 HTTP 请求生成 traceId（x-trace-id 响应头）+
  内存 span（500 条上限，不可持久/不可审计）+ AsyncLocalStorage
  requestId 注入（审计链已自动关联 request_id）；
- 但 traceId **未贯通**：事件信封 correlationId 恒 null（六类生产者未接线）、
  span 不落库、无缝合查询面（无法从 traceId 反查全链）。

## 决策

### 决策 1：Correlation ID = HTTP traceId（单一 ID 端到端，不新建第二 ID）

TracingInterceptor 的 traceId 即全链路 correlation id（§19 单一关联键）：
- 审计：auditService.appendAuditLog 已默认 request_id ← ALS（既有，确认
  为契约面，不改动）；
- 事件：六类规范生产者（workorder/agent/knowledge/inference/reasoning/
  learning）buildEventEnvelope 时 correlationId = currentTraceId() ?? null
  （非 HTTP 路径显式 null，绝不伪造新 ID——伪造会制造无法溯源的关联）；
- 边缘本源事件（设备发起、无云端请求上下文）correlationId 显式 null；
  云端上行通道经 envelope correlationId 承载（设备事件无关联即 null，
  §21 时间语义不依赖关联）。

### 决策 2：span 持久化 = standalone_042 `ewoh_trace_span`

GLOBAL_SHARED（ADR-004 先例：观测基建全局可见、org_id 仅 lineage；访问
由 API 角色（global_admin/safety_admin）约束，不加 RLS 策略）：
- 列：trace_id/span_id/path/method/status_code/duration_ms/started_at/
  finished_at/error/org_id（lineage 可空）/request_user（lineage）；
- CHECK：status_code ∈ [100,599] / duration_ms ≥ 0；
- 唯一 (trace_id, span_id)；索引 (trace_id, started_at)；
- 保留：写入时按 7 天 TTL 清理 + 行上限防爆（service 层 bounded，
  observability 非审计资产——审计事实仍在 ewoh_audit_log，span 是追踪
  索引，允许 TTL）。
写入语义：interceptor 异步 best-effort（失败 logger 留痕不阻断响应——
  与审计留痕同语义；span 丢失不影响业务事实层）。

### 决策 3：缝合查询 = GET /api/observability/traces/:traceId

TraceQueryService.getTrace(traceId) 三面缝合：
- spans（ewoh_trace_span，按 trace_id）；
- events（ewoh_event，evidence_json->'envelope'->>'correlationId' = traceId）；
- audit（ewoh_audit_log，request_id = traceId）。
返回 {traceId, spans, events, audit}——"从一次用户操作追踪到…"的查询面。
角色：global_admin/safety_admin（与既有 traces 列表一致）。

### 决策 4：Domain Command/Scheduler/Agent 段 = 事件与审计面

Domain 命令本身不单独落 span（避免第二事实源）：其发生面由 audit
（action=agent.command.*/model.*/knowledge.*…）与事件（correlationId 已
贯通）共同承载；缝合查询把它们并到同一 trace 视图。Scheduler/Agent
专用 **指标**（计数/gauge）不在本轮（NO-10b：Scheduler/Agent/Connector
指标体系）。

### 决策 5：Edge→Device 段边界

Device 时间戳/事件由 envelope occurredAt 承载（§21 既有）；云端
correlation 不下发设备（设备事件为其本源事实）。Edge 侧 EventUplink 上行
的云端触发事件经 envelope correlationId 传递。本轮不引入新链路协议。

## 后果

- 正面：traceId 成为 §19 要求的端到端 correlation id（审计/事件/span 三面
  贯通 + 缝合查询）；span 持久化可重放（TTL 内）；observability 矩阵缺口
  的 trace 腿闭合（指标腿留 NO-10b，矩阵保持 Partial 直至其成体系）。
- 代价：新增一张 GLOBAL_SHARED 表 + span 写入（每 HTTP 请求一行，TTL
  清理）；六生产者各一行接线改动。
- 无破坏性变更（correlationId 默认 null，兼容）。

## Rejected Alternatives（否决方案）

1. **事件信封用独立 correlationId（非 traceId）**：两套关联键无法缝合，
   违反 §19 单一 Correlation ID。
2. **span 表加 RLS 租户隔离**：观测基建跨租户查询（全局管理员诊断）是
   核心诉求；ADR-004 GLOBAL_SHARED + 角色约束先例成立。
3. **Domain 命令单独落 span**：与 audit/event 重复事实源（§33）；audit +
   event 已覆盖该段。
4. **伪造非 HTTP 路径 correlationId**：制造无法溯源的关联（§33）；显式
   null 是合法状态。
