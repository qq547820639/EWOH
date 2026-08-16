# ADR-024：Dead Letter 体系（§20 Reliability 失败终态语义）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-009（Envelope）/ ADR-019（事件上行）/ §20 Reliability
- 驱动：NO-11a（Round 44，reliability-hybrid 收口：失败消息落库/重放/告警面）

## 背景

§20 要求 Dead Letter 语义明确。现状：
- 幂等（CAS/去重）、离线队列（edge uplink queue 断点续传）、乱序缓冲
  （SequenceBuffer）、回放补全（NO-04b/04c）已落地；
- 但**永久失败没有终态落点**：ingest 上行被 fail-closed 拒绝（信封契约
  违规 / 未知事件类型）的事件只返回 rejected 计数，**失败证据即消失**——
  无法审计"什么消息为何失败"，无法人审重放（修复上游后重新投递）。

## 决策

### 决策 1：Dead Letter 记录 = 契约（contracts/reliability/dead-letter.schema.json）

meta-contract 同风格，v1.0.0：
- **reasonRegistry**（封闭）：contract_violation / unknown_event_type /
  permanent_failure / ttl_expired / max_attempts_exceeded；
- **statusRegistry**：pending / requeued / discarded（重放语义三态）；
- **规则（机器可判定）**：envelope 快照必填（失败证据可审计，§3）；
  reason ∈ 注册表；attempts ≥ 1 整数（requeue 时 attempts+1——人审重放
  显式递增，杜绝自动无限重试）；discarded 必须带 discardedReason 非空
  （丢弃显式理由，§33 不静默）；sourceId 声明失败源（管道归属）；
  correlationId 可空（无云端关联的显式 null，与 ADR-022 同义）；auditTrail
  必须 true。
- Python/TS 双实现 + 共享向量 + audit-domain-contracts reliability 域 +
  Golden 第 18 场景（同既有契约域纪律，§31）。

### 决策 2：持久化 = standalone_043 `ewoh_dead_letter`

TENANT_SCOPED RLS（dead_letter_org_isolation，GUC idiom）+ CHECK
（reason/status 枚举 / attempts ≥ 1 / discarded 需理由）+ UNIQUE
(org_id, letter_id)。letterId 由 (source, eventId) 确定性推导
（`dl:{sourceHash}:{eventId}`）→ 同一失败消息幂等（重复上报不重复落账不
重复发事件）。完整快照落 record_json（审计同源）。

### 决策 3：v1 生产者 = ingest 事件上行永久失败（真实接线）

ingestEventBatch 的两个 fail-closed 拒绝分支（envelope_invalid /
unknown_event_type）→ DeadLetterService.record：
- 重试无意义（契约/目录不会因重试变化）→ 永久失败终态；
- 瞬时失败（dedup/event 写库失败）**不进** dead letter——边缘上行队列
  负责重试（职责边界显式：瞬时=retry，永久=dead letter）。
DeadLetterService 写入失败 best-effort（logger 留痕；ingest 响应已含
rejected 计数，死信落账失败不阻断上行主契约）。

### 决策 4：重放语义 = 人审触发（requeue）

POST /api/reliability/dead-letters/:letterId/requeue：人工修复上游后
（如目录注册新事件类型）重放——按 source 分发到注册的 handler
（v1：source cloud:ingest → 重新走 ingestEventBatch 同源逻辑；
attempts+1；状态 requeued）。**绝不自动重试**（自动无限重试 = 事实层
噪音源）；discard 必须带理由（人审决策留痕）。

### 决策 5：告警面 = DeadLetterRecorded 目录事件（55→56→57）

`com.ewoh.reliability.dead_letter_recorded`（56→57 类），channel
`reliability.dead_letter_recorded` + 双运行时投影。幂等重放不重复发事件
（与 035/039/040/041 同语义）。消费方：值班/告警面按 severity 订阅。

## 后果

- 正面：永久失败获得终态落点（可审计/可重放/可告警）；§20 五要素
  （幂等/重试/超时/离线队列/去重）+ Dead Letter + 乱序缓冲 + 回放补全
  全部落地 → reliability-hybrid 按 §36 升 Implemented（矩阵 41/14/0/1）。
- 代价：新契约 + 新表 + 新模块；ingest 拒绝路径多一次 best-effort 落账。
- 无破坏性变更（全 additive；ingest 响应形状不变）。

## Rejected Alternatives（否决方案）

1. **失败事件只打日志/计数**：失败证据不可审计不可重放（§3 追溯断裂）。
2. **自动重试队列（无限/指数退避自动 requeue）**：永久失败重试永不成功，
   制造事实层噪音；v1 人审重放 + 显式 attempts（§2 人审边界同源）。
3. **瞬时失败也进 dead letter**：瞬时失败归边缘上行队列重试（既有机制），
   混入 dead letter 会双写失败事实（§33）。
4. **死信表复用 ewoh_event**：死信是失败终态台账（status/attempts/requeue
   状态机），事件是发生事实流——语义不同，混用失去重放状态机。
