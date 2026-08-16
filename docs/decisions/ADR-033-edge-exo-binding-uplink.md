# ADR-033：边缘绑定事实→云 ExoSession 台账端到端贯通（§7 收口）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-032（ExoSession 契约）、ADR-009（信封/目录）、NO-04b（事件上行）、§7、§20

## 背景

ADR-032 建立了 ExoSession 契约与云侧台账，但绑定事实只在云侧 API
产生——边缘（外骨骼实际佩戴/归还的发生地）没有绑定事实生产面，
§7 闭环在 Edge→Cloud 方向断裂。

## 决策

### 决策 1：边缘绑定事实一等 API（显式领用/归还）

- 边缘新增 `exo_binding` 存储表（binding_id/exo_id/person_id/status/
  started_at/ended_at/ended_by/reason，CREATE TABLE IF NOT EXISTS 幂等）
  + Storage start_binding/end_binding/list_bindings；
- 边缘路由 POST /api/exo/bind + POST /api/exo/unbind：规范身份
  （device:/person: 前缀）fail-closed；同一外骨骼活跃绑定唯一
  （服务层冲突显式）；unbind 必须 ended_by + 状态机（active→ended）。

### 决策 2：绑定事实经事件骨干上行（复用既有通道，不新造上传路径）

绑定/解绑落本地账后，发射 Catalog 信封事件 ExoSessionStarted/Ended
（sessionId=exo-session:{edgeId}-{uuid}，payload 含 exoId/personId/
status/endedBy）经 STREAM_EVENTS → EventUplink（at-least-once +
断点续传队列，NO-04b/04c 既有语义）上行——绑定事实与其余 Catalog
事件同通道、同去重语义，§33 无第二上传路径。

### 决策 3：云侧 ingest 投影到 ExoSession 台账（幂等）

ingest 收到 ExoSessionStarted/Ended → ExoSessionService 投影：
- start 幂等：sessionId 已存在 → 回读返回（传输去重之外的第二层
  应用幂等，at-least-once 安全）；
- end 幂等：当前状态已是目标终态 → 原样返回（重复 ended 不报错）；
- 传输级 (org, source, eventId) 去重（standalone_036）已兜底重复投递，
  应用层幂等为第二道防线（§20）。

### 决策 4：目录 payload 增补 endedBy（additive）

ExoSessionStarted/Ended payload 增加可选 endedBy/startedAt/actualEndAt
字段（additive，不破坏既有 schemaVersion）——事件携带完整会话事实
供投影消费。

## 后果

- 正：§7 闭环 Edge→Cloud 端到端贯通（绑定事实在边缘产生、离线可续传、
  云端台账幂等落账）；worker-exoskeleton-loop 按 §36 升 Implemented。
- 负/边界：边缘本地绑定账与云台账经事件收敛（云为权威、边缘为
  采集面）；边缘未运行 EventUplink 时绑定仅留本地账（离线语义）。
