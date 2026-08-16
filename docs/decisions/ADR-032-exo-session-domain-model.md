# ADR-032：外骨骼↔人员 Session 域模型（§7 一等实体绑定）

- 状态：Accepted
- 日期：2026-08-16
- 关联：§7（外骨骼一等实体）、ADR-006（身份）、ADR-009（事件）、§15（多租户）

## 背景

§7 要求：外骨骼与 Person 的绑定必须是显式、临时且可审计的 Session，
不得永久假定一台设备属于某个人。现状：`ewoh_device_binding` 为通用
设备绑定表（deviceId/targetId/bindingType + 时间字段），无 Session
状态机、无"一台外骨骼同时只绑定一人"的机器强制、无契约面——绑定是
隐式的行记录而非一等事实。

## 决策

### 决策 1：ExoSession 一等契约（canonical，跨运行时）

新契约 `contracts/exo/exo-session.schema.json`：
- 字段：sessionId、exoId（device:... 规范身份）、personId（person:...
  规范身份，ADR-006）、status ∈ {active, ended, aborted}、startedAt、
  expectedEndAt?、actualEndAt?、endedBy?、reason?、operatorId、
  auditTrail；
- 机器规则：active 会话同一外骨骼唯一（服务层 + DB 部分唯一索引双强制）；
  ended/aborted 必须 actualEndAt；actualEndAt ≥ startedAt；status 状态机
  active→{ended, aborted}（终态不可复开——会话是新事实不重开旧会话）；
  auditTrail 必须 true。

### 决策 2：持久化 standalone_046 ewoh_exo_session（TENANT_SCOPED）

org_id NOT NULL + RLS exo_session_org_isolation + CHECK（status/exoId/
personId 规范身份前缀 device:/person:、ended/aborted 必须 actual_end_at、
actual_end_at ≥ started_at）+ 部分唯一索引 UNIQUE (org_id, exo_id)
WHERE status='active'（机器强制一台外骨骼同时一个活跃会话）。

### 决策 3：云侧 ExoSessionService（唯一权威写路径）

startSession（契约 fail-closed + 活跃冲突显式 conflict_exo_session_active
——23505 映射，绝不静默双绑定）/ endSession / abortSession（状态机 +
endedBy 必填 + actualEndAt 落账）/ listSessions（org 作用域，含历史）。

### 决策 4：目录事件 +2（61→63）

ExoSessionStarted / ExoSessionEnded（payload.status ∈ {ended, aborted}），
双运行时投影；事件是会话事实的事件载体（§5）。

### 决策 5：与既有 ewoh_device_binding 的关系

ewoh_device_binding 继续承载通用设备↔目标绑定（工作站/模型等），
外骨骼↔人员绑定迁移为 ExoSession 唯一事实源（新会话写入不再写
device_binding 的 person 绑定行——避免第二事实源；历史行保留只读）。

## 后果

- 正：§7 绑定契约从"隐式行记录"升为"显式可审计 Session 事实"（状态机 +
  唯一性机器强制 + 事件）；外骨骼一等实体的会话面闭环。
- 负/边界：边缘侧 session 事件上行与使用统计贯通留后续轮次（本 ADR 交付
  契约 + 台账 + 云侧写路径）；历史 device_binding 行不迁移（只读保留）。
