# ADR-043：Canonical Capability Model（机器/人员/外骨骼能力统一语义，NO-12t）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-006（规范身份）、ADR-007（Risk/Location/Resource 契约）、
  ADR-015（Entity Model）、§3（Factory Truth：Canonical Capability Model）、§4

## 背景

能力语义散落三处且无统一契约：人员技能/认证（personnel skills/
certifications）、设备能力（device capabilities：'exo-lift'/'vacuum'，
参与 exo 能力匹配）、工位能力（requiredStationCapabilities 匹配）——
§3 明确要求 Canonical Capability Model 作为跨运行时事实源。
canonical-capability-model 据此保持 Partial。

## 决策

### 决策 1：CapabilityRecord 契约（结构封闭 + 词表开放）

contracts/capability/capability.schema.json + 共享向量 + Python/TS
双实现 + audit-domain-contracts capability 域 + Golden 第 23 场景：
- kind 封闭注册表（skill / certification / device_capability /
  station_capability / exo_capability）；
- providerType 封闭注册表（person/device/exo/machine/robot/station/tool）；
- name 为**开放词表**（工厂技能/能力名天然开放——knownValues 为平台
  已知值登记，测试向量锁定已知集合；未知 name 合法且显式，绝不静默
  改写）——封闭性只约束结构（kind/providerType），不约束词表；
- certification 判定事实完整：issuer + expiresAt 必填（§33）；
- 时间不倒退（expiresAt >= grantedAt）；subject 规范身份形状
  （<prefix>:<value>，前缀语义深校验归 identity 域）；auditTrail 强制。

### 决策 2：契约层先行（运行时接线为后续轮次）

本轮交付契约层（schema/向量/双实现/门禁/Golden + 本机 pytest 回归），
既有消费方（人员技能/认证、设备能力匹配、工位能力匹配）向契约收敛
的逐点接线（映射函数）为后续轮次——先立单一事实源，再逐点收敛
（§30：先修契约再修实现）。

## 后果

- 正：§3 Canonical Capability Model 落地（结构注册表跨语言锁步 511/511
  门禁）；canonical-capability-model 按契约层里程碑升 Implemented
  （矩阵 48/7/0/1→49/6/0/1）。
- 负：词表开放使能力名不受注册表约束（由 knownValues 文档化锁定已知
  集合；未知名显式可见）。
- 无破坏性变更（全 additive）。
