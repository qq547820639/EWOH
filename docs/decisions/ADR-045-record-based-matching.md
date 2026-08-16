# ADR-045：Record 化匹配收敛（eligibility/candidate 按 CapabilityRecord 结构比较）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-043（Capability 契约）、ADR-044（投影接线）、§3（Factory Truth）、
  §30（语义不变纯结构收敛）、§31（无重复语义）

## 背景

ADR-044 已把能力事实投影为快照 capabilityRecords；但匹配逻辑
（eligibility 技能/证书/设备能力/工位能力 + 求解器 personBySkill/
deviceByCapability 预筛索引）仍读 raw 字符串数组。NO-12v 完成结构
收敛：匹配改读契约形态，语义逐字不变。

## 决策

### 决策 1：名称集抽象（契约形态优先 + 同源回退）

capability-projection.ts 增补纯函数：capabilityNames(records, kind) /
personSkillNames / deviceCapabilityNames / stationCapabilityNames /
personCertificationExpiryMap——records（契约形态）优先；无 records 的
legacy 直呼路径就地经同一投影函数推导（§31 单一语义，无第二事实源）。
技能/设备/工位能力投影为 1:1（无契约缺口），两种来源语义逐字一致
（spec 等价断言锁定）。

### 决策 2：证书存在性与到期事实分工（语义精确保持）

- 存在性仍以 person.certifications 判定——certification 记录因缺
  issuer/expiry 被契约缺口丢弃（ADR-044），若改按记录存在性会错误
  拒绝有证书但数据源缺 issuer 的人员（语义改变，§30 禁止）；
- 到期事实优先契约记录（expiresAt），无记录回退 raw certificationExpiry；
  证书无到期事实 → 不视为过期（与既有语义一致）。

### 决策 3：快照索引与上下文同步收敛

- heuristic-scheduling-solver：personBySkill/deviceByCapability 预筛
  索引改经 personSkillNames/deviceCapabilityNames；
- candidate-engine + solver 的 EligibilityContext 增补
  stationCapabilityRecordsById（快照工位 capabilityRecords 透传），
  station 匹配经 stationCapabilityNames（records 优先）。

## 后果

- 正：能力匹配端到端走契约形态（快照投影 → 资格判定 → 预筛索引），
  §3 Canonical Capability Model 从「可投影」到「被消费」；raw 数组
  降级为 legacy 回退（同源投影，语义逐字一致）。
- 负：无（纯结构收敛，spec 等价断言 + 既有 scheduler 套件回归锁定）。
- 边界：证书存在性语义保持 raw（契约缺口丢弃记录是显式特性非 bug，
  ADR-044 已把缺口显式计数）。
