# ADR-044：Capability 契约消费方投影接线（NO-12u，ADR-043 决策 2 后续）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-043（Canonical Capability Model 契约）、§3（Factory Truth）、
  §30（先契约后实现）、§33（禁止行为）

## 背景

ADR-043 已落地 CapabilityRecord 契约（双实现 + 511 门禁 + Golden
第 23 场景），决策 2 明确「既有消费方向契约逐点接线为后续轮次」。
本 ADR 完成第一条生产接线：世界快照投影面。

## 决策

### 决策 1：快照投影为唯一接线点（capability-projection 纯模块）

`capability-projection.ts` 三个纯投影函数（人员/设备/工位 → 
CapabilityRecord[] + issues[]）：
- person → skill 记录（providerType=person，subject=person:<id>）
  + certification 记录（expiresAt 来自 certificationExpiry 事实）；
- device.capabilities → device_capability 记录；
- station.capabilities → station_capability 记录。

### 决策 2：数据源缺口显式暴露（绝不伪造，§33）

- certification 无到期事实 → `certification_missing_expiry:<name>`
  显式缺口（不投影）；
- 人员数据源无 issuer 事实 → 契约门拒绝后改写为
  `certification_missing_issuer:<name>` 显式缺口（绝不伪造 issuer）——
  契约门的 fail-closed 恰好把数据源缺口显式暴露；
- 违规记录 → `projection_invalid:<capabilityId>:<errors>` 显式计数。

### 决策 3：快照 additive 扩展

WorldStateSnapshot 实体（person/device/station）+= `capabilityRecords?`
（契约合法记录）+ 顶层 `capabilityProjectionIssues?: string[]`——
世界契约自检（validateCloudWorldSnapshot）只校验 entityVersions/
身份引用，新字段 additive 不破坏既有消费方。

## 后果

- 正：能力事实首次以 Canonical CapabilityRecord 形态进入生产调用链
  （buildSnapshot 唯一投影点）；数据源缺口（认证缺 issuer/expiry）
  从隐式缺失变为显式计数（§3 可回答「为什么认为…」）。
- 负：快照 payload 增加（能力记录数组，量级与技能/能力列表相当）。
- 边界：匹配逻辑（eligibility/candidate-engine）仍按既有字段比较；
  Record 化匹配收敛为后续轮次（语义不变，纯结构收敛）。
