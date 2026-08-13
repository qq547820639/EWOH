# [scheduler-phase1-entity-aware-debounce] 实体感知的触发冷却去抖 Spec

## Why

`TriggerService.evaluate` 的冷却去抖（`triggerCooldownMs`）当前仅按 `(orgId, triggerType)` 判定「最近一次触发在窗口内则合并」（[trigger.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/scheduler/trigger.service.ts#L68-L79)），而幂等去重的 `triggerKey` 却是实体感知的（`${orgId}:${triggerType}:${entityId}:${eventVersion}`，第 59 行）。两者粒度不一致导致：同一 org 内不同实体（如两个不同人员）在同一冷却窗口内触发同类型事件时，第二个会被错误合并（返回 null），丢失本应发生的重排。这是 phase-0 报告 §17 明确点名的「entity-aware trigger debounce（cooldown 现仅 orgId+triggerType）」缺口。

## What Changes

- **冷却去抖实体感知化**：在 `TriggerService.evaluate` 的冷却去抖查询 `WHERE` 中追加 `entityId` 维度（与 `triggerKey` 的 entityId 维度一致），使「同实体同类型」才去抖，「不同实体同类型」不再互相合并。
- **保留 org 级风暴上限**：不改动 `replan-coordinator` 的 org 级风暴守卫（`maximumReplansPerWindow`），它仍负责限制单 org 总重排频率；本改动只修冷却去抖的实体粒度。
- **新增回归测试**：验证「同实体同类型窗口内去抖」与「不同实体同类型窗口内不去抖」两种语义。
- **不引入 BREAKING 变更**：不改动 OpenAPI、状态机、DB 迁移语义；`entityId` 列已存在（插入时已写 `entityId ?? 'ALL'`）。

## Impact

- 影响规格：调度触发幂等/去抖语义（事件驱动重排正确性）。
- 影响代码：`server/modules/scheduler/trigger.service.ts`（冷却去抖查询）、新增回归测试。
- 影响契约：无（不改动任何冻结契约语义）。

## 边界（不可违反）

1. 只改冷却去抖查询的实体维度；幂等去重（`triggerKey`）语义保持不变。
2. 不改动 org 级风暴守卫、`triggerCooldownMs` 语义、`replanDebounceMs` 语义。
3. 无实体（`entityId=null`）的触发仍按 `orgId+triggerType` 去抖（退化为现状，避免无实体触发风暴）。
4. 不修改 OpenAPI、状态机、DB 迁移 SQL。
5. 所有改动需通过 scheduler jest 套件、`tsc -b --force`、`openapi:no-drift`。

## ADDED Requirements

### Requirement: 实体感知的冷却去抖
系统 SHALL 使触发冷却去抖按 `(orgId, triggerType, entityId)` 判定，使同一实体的同类触发在窗口内合并，不同实体的同类触发不再互相抑制。

#### Scenario: 同实体去抖
- **WHEN** 同一 org 内同一 `entityId` 的同一 `triggerType` 在 `triggerCooldownMs` 窗口内重复触发
- **THEN** 第二次被合并（`evaluate` 返回 `null`），不创建重复 run。

#### Scenario: 不同实体不去抖
- **WHEN** 同一 org 内不同 `entityId` 的同一 `triggerType` 在窗口内先后触发
- **THEN** 各自创建独立 run（`evaluate` 返回非 null），不丢失第二次重排。

#### Scenario: 无实体退化
- **WHEN** `entityId` 为 null 的触发（如全局瓶颈/截止风险）
- **THEN** 仍按 `orgId+triggerType` 去抖，避免无实体触发风暴。

## MODIFIED Requirements

### Requirement: 触发幂等去重（保持）
`triggerKey = ${orgId}:${triggerType}:${entityId}:${eventVersion}` 的幂等去重语义保持有效；本规格仅使冷却去抖与幂等去重共享同一实体维度，不改动幂等去重本身。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。
