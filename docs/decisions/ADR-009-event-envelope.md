# ADR-009：Canonical Event Envelope（Phase 4 启动）

- **状态**：Accepted
- **日期**：2026-08-14
- **阶段**：Phase 4 — Event Backbone（NO-04）
- **关联**：总提示词 §5/§20/§21；ADR-006（Identity，actor/subject 引用）/
  ADR-007（confidence 语义）/ADR-008（状态事件化基础）；
  capability-matrix `event-backbone` / `time-semantics`

## Context（语义审计证据，2026-08-14 实测）

**边缘事件（inference/events.py EventEngine）**
- 事件记录：event_id/event_code/severity/status/person_id/device_id/start_time/
  end_time/trigger/evidence/handling/source_type——`start_time` 即 occurred 代理，
  无 observed/received 分离、无 causation/correlation/confidence/schema_version。

**云侧事件（ewoh_event 表 + outbox + world_delta_log）**
- `ewoh_event`：eventId/deviceId/eventCode/eventType/severity/title/status/
  createdAt（= 处理时间，§21「不得以 created_at 代替真实事件时间」的现状违反点）/
  sourceType/triggerRecordId/evidenceJson/orgId；
- 调度 outbox（sequence 单调 + SSE 重同步，standalone_021/024）已有传输信封但
  无 occurred/observed 语义；
- `ewoh_world_delta_log.occurredAt` 已单点存在（非全链路）。

**事件目录（contracts/events/event-catalog.yaml）**
- CloudEvents 1.0 + 35 事件类型；各消息 payload 含 occurredAt（部分含
  observedAt），但类型级字段不统一、无 envelope 层契约。

**分歧**：时间语义三态（occurred/observed/received）仅零星存在；causation/
correlation/confidence/schema_version 无统一表述；事件目录约束类型但不约束
信封形状；去重/Late Event 语义无契约。

## Decision（决策）

### 1. Canonical Event Envelope（contracts/events/envelope.schema.json）

- **必填**：eventId、eventType（必须命中 event-catalog x-event-types，门禁交叉校验）、
  schemaVersion、occurredAt、source。
- **可选**：observedAt、receivedAt、tenantId、factoryId、actor（规范身份引用）、
  subject（规范身份引用）、causationId（引用上游事件 eventId）、correlationId、
  confidence（[0,1]）、payload、evidence。
- **确定性规则（rules，机器可执行）**：
  1. 时间序：occurredAt ≤ observedAt ≤ receivedAt（时钟漂移容忍 CLOCK_DRIFT_TOLERANCE
     5min；越界 → 事件仍有效但显式标记 clockDrift=true，不静默改写时间）；
  2. Late Event：receivedAt − occurredAt > LATE_THRESHOLD_MS（默认 10min）→
     isLate=true（标记而非丢弃，§20 迟到事件语义）；
  3. 幂等/去重：同一 (source, eventId) 重放幂等——消费者按 eventId 去重，
     重放不得产生副作用（§20 Idempotency/Deduplication）；
  4. actor/subject 必须是规范身份（kind:value，ADR-006）否则拒绝；
  5. confidence ∈ [0,1]；schemaVersion 必须非空。
- envelope 不替代事件目录：目录 = 类型语义；envelope = 信封形状 + 时间/因果语义。

### 2. 交付模式（复刻 ADR-006/007/008 纪律）

契约唯一事实源 + Python（`src/edge_platform/contracts/envelope.py`）与
TypeScript（`ewoh-spark-app/shared/event-envelope.ts`）锁定实现 + 共享
test-vectors + `scripts/audit-event-envelope.js` 独立仲裁门禁（含与事件目录的
交叉校验）+ Golden Scenario 增补 `event_envelope_semantics`。

### 3. 生产接线（NO-04b，本回合只立契约）

- 边缘：EventEngine 产出 envelope 形状事件（occurred/observed 分离 + schema_version
  + 来源）+ bridge 上行 received 标注；
- 云侧：ewoh_event 增 envelope 列（standalone_033，成对 rollback）或
  evidenceJson 内嵌 envelope 字段（先行兼容策略：envelope 入 evidenceJson.envelope，
  不破坏既有列语义；随后独立列迁移）；ingest 入口 receivedAt 标注 + 去重键；
- SSE outbox 事件统一带 envelope。

## Alternatives Considered

1. **直接迁移 CloudEvents 完整实现**：引入 cloudevents SDK 双运行时重量级依赖，
   与零依赖边缘约束冲突；目录已是 CloudEvents 类型语义，信封层轻量自实现即可。**否决**。
2. **envelope 字段全部必填**：离线补传场景 receivedAt/observedAt 语义缺失时被迫
   伪造时间，违反 §33。**否决**（时间三态可选但序约束）。
3. **迟到事件丢弃**：违反 §20「Late Event 处理」且丢失事实。**否决**（标记不丢弃）。

## Consequences

- 正：时间/因果/置信度语义跨运行时收敛；去重与迟到处理成为可验证规则；
  为 Phase 9 Agent 协作与 Phase 12 Learning Loop 提供事件证据地基。
- 代价：既有事件写路径需在 NO-04b 逐点接入 envelope（兼容策略先行，存量事件
  保持现状，新事件带 envelope）。
- 风险：契约/实现漂移由门禁（audit-event-envelope + 目录交叉校验）持续封堵。

## Migration

1. 本轮：契约 + 双运行时实现 + 共享向量 + 门禁 + Golden Scenario（全新增）。
2. NO-04b：边缘 EventEngine/bridge 接线 + 云侧 evidenceJson.envelope 兼容层 +
   去重键（source,eventId）+ Late Event 标记落库。
3. 回滚：契约纯新增；接线逐点可回退。
