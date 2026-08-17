# Event Backbone 架构审计（arch-event）

审计日期：2026-08-17。范围：云端 ewoh-spark-app/server（NestJS + Postgres）、边缘 src/edge_platform（Python）、前端消费端、契约 contracts/events/ 与 ewoh-spark-app/shared/。只读取证，全部结论附 file:line。

核心问题：**事件骨干（outbox / pg_notify / SSE / canonical envelope / Edge uplink）是 Scheduler 私产还是共享 Event Backbone；canonical envelope 16 字段是否被各实现线真正覆盖。**

一句话裁决：**骨干传输层（outbox→pg_notify→SSE）被 Scheduler 完全垄断；envelope 契约（类型目录 + 信封校验）是全仓共享的，但只有「Edge 上行腿」和「ewoh_event 事实表腿」在用——两条腿互不相通，SSE 骨干上跑的是另一套私有命名的事件，未经契约门禁。**

---

## 一、事件链路全景图

```
┌───────────────────────── Edge（src/edge_platform）─────────────────────────┐
│  connectors/inference/rules → MessageBus.publish(stream)                    │
│    (edge/bus.py:86)                                                         │
│      ├─ STREAM_EVENTS（信封事件）→ EventUplink                               │
│      │    (edge/bridge/event_uplink.py:53-204)                              │
│      │    validate_envelope fail-closed(:146) + 离线队列断点续传(:84-124)     │
│      │    POST /api/ingest/events（≤100/批，X-Ingest-Key/X-Org-Id）          │
│      ├─ 遥测帧（非信封）→ edge_to_spark.py:283-298                           │
│      │    POST /api/ingest/exoskeleton/batch                                 │
│      └─ 指标快照（非信封）→ metrics_uplink.py:56-70                           │
│           POST /api/observability/edge-metrics（进程内 TTL 快照，无表）       │
│  edge 本地 SSE：routes/scheduler.py:80-110（bus 广播，TTL+心跳，与云骨干无关）│
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   ▼
┌───────────────────────── 云侧 Ingest 腿（共享）────────────────────────────┐
│  IngestGuard（ingest.guard.ts:36-97：X-Ingest-Key constant-time + fail-closed│
│    + 100 req/min + X-Org-Id→userContext）                                   │
│  IngestService.ingestEventBatch（ingest.service.ts:380-580）                │
│    ① validateEventEnvelope + catalog 白名单（:401,434；fail-closed→死信）    │
│    ② 幂等：ewoh_ingest_event_dedup (org,source,eventId) ON CONFLICT         │
│       （:464-477；schema.ts:1554-1568）                                      │
│    ③ 事实落账：insert ewoh_event（:546-558，信封整体嵌 evidenceJson）        │
│    ④ 投影：ExoSession 台账（:495-503）、edge Andon→canonical evidence       │
│       （:504-538）、DEVICE_OFFLINE→ReplanCoordinator（:1188-1194）           │
└──────────────────────────┬─────────────────────────────────────────────────┘
                           ▼
┌─────────────── 云侧 Domain 事实表腿（ewoh_event，共享「表」非骨干）──────────┐
│  写入者（buildEventEnvelope→envelopeForEvidence→insert ewoh_event，         │
│  信封只进 evidenceJson 列，无发布/订阅/推送）：                              │
│    rule-engine.service.ts:191-231（DeviceLowBattery 等 + ewoh_event_chain）  │
│    ingest.service.ts:1211-1239（DataQualityAlert）                           │
│    agent.service.ts:775-805（AgentTaskProposed/AgentDecisionRecorded）      │
│    agent-orchestrator.service.ts:327  maintenance.service.ts:193-220        │
│    quality.service.ts:185  workorder.service.ts:209  knowledge.service.ts:308│
│    identity.service.ts:271  inference.service.ts:180  oee.service.ts:316    │
│    simulation.service.ts:251  learning×3（:275/:419/:163）                   │
│    exo-config:300 / exo-session:222  dead-letter.service.ts:225             │
│  裸写者（无信封、eventType 私有）：mes.service.ts:1313-1327（'quality'）     │
│  消费者（拉取式，无订阅）：alert.service.ts:97-130（状态机流转+审计）        │
│    mes.service.ts:434-447（质检事件回查）  timeline.projection.ts:16-50（投影）│
└──────────────────────────┬─────────────────────────────────────────────────┘
                           ══ 两腿零交集体 ══
┌─────────────── Scheduler 私有骨干腿（ewoh_outbox→pg_notify→SSE）────────────┐
│  写入：13 个 enqueue 位点 100% 在 server/modules/scheduler/ 内：             │
│    dispatch-coordinator.service.ts:387,401（assignment.dispatched/          │
│      plan.dispatched）  plan.service.ts:517  execution.service.ts:313       │
│    conflict.service.ts:915  scheduler-query.service.ts:1148（conflict.detected）│
│    replan-coordinator.service.ts:333  scheduler-event-application.service.ts:115,294│
│    policy-activation.service.ts:305  shadow-policy.service.ts:167,276       │
│    solver.service.ts:518（policy.shadow.canary.rollback）                    │
│  OutboxService（scheduler/outbox.service.ts:33-229）：                       │
│    enqueue/enqueueThrottled（节流合并窗口）/publishPending/listSince/        │
│    listLatest/latestSequence；表 ewoh_outbox（schema.ts:2134-2157，          │
│    GLOBAL_SHARED、RLS 关闭、orgId 应用层过滤 :208-210）                      │
│  唤醒：standalone_024_scheduler_outbox_notify.sql:18-29                     │
│    AFTER INSERT trigger → pg_notify('scheduler_outbox','')                  │
│  LISTEN：scheduler/pg-notify.listener.ts:6,71（退避重试 :90-107）           │
│    仅 SCHEDULER_STREAM_NOTIFY=1 时装配（scheduler.module.ts:55-71；         │
│    deploy/.env.example:218 默认 0 → 纯 2s 轮询）                            │
│  泵：scheduler-stream.service.ts:151-240（2s 轮询兜底 + NOTIFY 即时 poll，  │
│    sequence 游标增量 + LRU 去重 + 追赶批 500×10）                            │
│  SSE：scheduler.controller.ts:594 @Sse('v2/stream')（全仓唯一 @Sse）        │
│    Last-Event-ID 重放/缺口 resync（:581-679）、org 过滤 fail-closed（:600-607）│
│  客户端：client/src/hooks/useSchedulerStream.ts:54（fetch+ReadableStream    │
│    手解析，因需 Authorization 头；断线→10s 轮询兜底）                        │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、Scheduler 垄断 vs 共享 Backbone 判定

### 判定：**传输骨干 = Scheduler 垄断；契约层 = 共享；两者脱节**

| 骨干组件 | 实现位置 | 归属 | 非 scheduler 使用方 |
|---|---|---|---|
| OutboxService | scheduler/outbox.service.ts | Scheduler 模块 provider（scheduler.module.ts:14） | **0 个**。Grep `OutboxService\|ewohOutbox` 命中 23 文件：21 个在 scheduler/（源码+测试），另 2 个是表定义 database/schema.ts 与其测试 |
| ewoh_outbox 表 | schema.ts:2134-2157 | GLOBAL_SHARED（standalone_057 裁决），但唯一写读方均为 scheduler | 0 个 |
| pg LISTEN/NOTIFY | migration standalone_024 + pg-notify.listener.ts | channel `scheduler_outbox` 硬编码（listener:6），类名/频道名/装配全部 scheduler 命名 | 0 个（全仓 LISTEN 仅此一处） |
| SSE 端点 | scheduler.controller.ts:594 `@Sse('v2/stream')` | 全仓唯一 @Sse；路由挂在 scheduler 控制器下 | 0 个（world/events/alert 等域均无 SSE，前端 world 走 10s HTTP 轮询 client/src/api/world.ts:4-11） |
| SchedulerStreamService | scheduler-stream.service.ts | scheduler 模块 | 0 个 |
| Canonical Envelope 契约 | contracts/events/envelope.schema.json + shared/event-envelope.ts + edge contracts/envelope.py（门禁 scripts/audit-event-envelope.js，双语言常量交叉校验） | **共享**：15 个云侧模块 + edge 上行 + ingest 校验共用 | 16+ 个 |
| Event Catalog | contracts/events/event-catalog.yaml（66 个 PascalCase 类型）+ shared/event-catalog.ts + events 模块只读 API | **共享**，但见下「命名分裂」 | — |

### 三处结构性脱节（垄断的实害证据）

1. **命名分裂**：outbox/SSE 轨使用私有 dot.case 类型（`plan.dispatched`、`assignment.dispatched`、`conflict.detected`、`policy.shadow.canary.rollback`、`replan.approval_required`、`execution.deviation`），catalog 是 PascalCase（`PlanDispatched`…）。outbox 写入路径**不经过** validateEventEnvelope/catalog 门禁（门禁只约束 test-vectors 与双语言实现，scripts/audit-event-envelope.js:5-12），即 SSE 骨干上的事件类型不受契约治理。
2. **目录悬空**：`WorldEntityUpdated`、`ResourceStateChanged` 在 catalog 有完整定义（event-catalog.yaml:790-846），但 server 端零 emit 位点（Grep `WorldEntityUpdated` 无匹配；scheduler/world-state.service.ts 无任何 outbox 引用）——世界态变化不产事件，前端靠轮询拉快照。
3. **双轨零互通**：Edge 上行/云侧域事件落在 ewoh_event（信封嵌 evidenceJson），SSE 只播 outbox；alert/timeline/mes 只拉 ewoh_event，SSE 消费者只见 scheduler 事件。同一「事件」概念在库内有两张事实表、两套 ID（`EVT-<uuid>` vs edge eventId）、两套类型命名，互不可见。

### 依赖事件数据的非 scheduler Domain（全部依赖 ewoh_event 表，无一依赖 outbox 骨干）

| Domain | 依赖方式 | 证据 |
|---|---|---|
| alert | ewoh_event 状态机流转（open→…）+ 审计 | alert.service.ts:97-130 |
| timeline | ewoh_event 行 → TimelineEvent 投影（纯函数） | timeline.projection.ts:16-50 |
| mes | 回查 ewoh_event 质检事件 + 裸写 'quality' 事件 | mes.service.ts:434-447, 1313-1327 |
| rule-engine | 消费 ewoh_telemetry → 写 ewoh_event | rule-engine.service.ts:130-236 |
| ingest | Edge 事件落账 + 投影 + 触发 replan | ingest.service.ts:380-580, 1188 |
| quality/maintenance/workorder/agent/knowledge/identity/inference/exo/oee/simulation/learning/reliability | 写 ewoh_event（信封嵌套） | 见链路图清单 |

---

## 三、envelope 字段覆盖矩阵

契约权威：contracts/events/envelope.schema.json:8-17（必填 5 字段）+ shared/event-envelope.ts:17-34（16 字段全形状）+ edge contracts/envelope.py:27。三条实现线逐字段对照（●=稳定填充 ◐=部分/近似 ✗=缺失）：

| # | 字段（契约名） | ① 契约定义 | ② Edge 上行/ewoh_event 腿 | ③ outbox/SSE 腿（SchedulingEvent，scheduler-stream.service.ts:242-269） |
|---|---|---|---|---|
| 1 | eventId | ● | ●（edge 生成，(org,source,eventId) 幂等键 ingest:464-477） | ●（outbox.eventId `EVT-<uuid>` outbox.service.ts:46） |
| 2 | eventType | ● | ●（catalog 白名单校验 ingest:401,434；mes 裸写 'quality' 例外） | ◐（私有 dot.case，**不命中 catalog，无门禁**） |
| 3 | schemaVersion | ●（const '1.0.0' 强校验 envelope.ts:60） | ●（buildEventEnvelope 默认 '1.0.0'） | ✗（SchedulingEvent 无此字段） |
| 4 | tenant（tenantId） | ●（可选） | ◐（云侧 emit 多不填；租户由 ewoh_event.org_id 承载） | ◐（→ orgId，org 过滤即租户隔离 controller:613） |
| 5 | factory（factoryId） | ●（可选） | ✗（仅 EntityDeclared payload 内出现） | ✗ |
| 6 | subject | ●（规范身份 kind:value，ADR-006） | ◐（rule-engine:198/agent:782/maintenance:200 填 `device:x`；多数调用缺省） | ✗（仅 entityId 裸 ID，非规范身份形态） |
| 7 | actor | ●（规范身份） | ✗（抽查全部 emit 位点无填充） | ✗ |
| 8 | source | ●（必填） | ●（'edge:*' / 'cloud:rule-engine' / 'cloud:ingest' / 'cloud:agent-runtime' / 'cloud:maintenance'） | ✗（SchedulingEvent 无 source；去重键 (source,eventId) 语义在 SSE 轨退化为 eventId 单键 stream:227） |
| 9 | occurredAt | ●（必填） | ●（edge 时间三态真实；云侧同刻生成 envelope.ts:95 注释） | ◐（payload 透传，缺省 server now stream:257-260） |
| 10 | observedAt | ●（可选） | ●（云侧同刻；edge 真实观测） | ✗ |
| 11 | receivedAt | ●（可选） | ●（ingest 落 dedup.receivedAt:472；isLate/clockDrift 全链路可审计 ingest:458） | ✗（近似物 sourceTs/serverTs stream:267-268，语义未对齐契约） |
| 12 | correlation | correlationId | ● | ◐（agent 填 currentTraceId:783；outbox 有专列 schema.ts:2149 + SSE 透传 stream:263-266） |
| 13 | causation | causationId | ● | ✗（仅 ewoh_event_chain.parentEventId 承载因果 rule-engine:223） | ✗ |
| 14 | confidence | ●（[0,1] 校验 envelope.ts:71-74） | ● 定义 ✗ 实填（仅 InferenceResultRecorded payload 数字段携带） | ✗ |
| 15 | payload | ● | ●（edge 上行整体透传 ingest:537,542） | ●（outbox.payloadJson） |
| 16 | evidence | ● | ◐（信封+semantics 嵌 evidenceJson envelope.ts:134-143；非独立 evidence 数组） | ✗ |
| 17 | data_quality（任务第 17 维，**契约无此字段**） | ✗（envelope 未定义） | ◐（ewoh_telemetry.data_quality 列 + ResourceStateChanged.payload.dataQuality 枚举，但该事件零生产者） | ✗ |

覆盖率小结：
- 契约定义层：**16/16**（data_quality 未入契约）。
- ②腿实际填充：必填 5 项稳定；常填 7/16（eventId/eventType/schemaVersion/occurredAt/observedAt/receivedAt/source），tenant/factory/actor/causation/confidence/evidence 基本空置 → **≈44%**。
- ③ SSE 骨干：命中的契约语义仅 eventId/eventType/occurredAt(近似)/payload/correlationId(部分)/tenant→orgId ≈ **6/16 ≈ 37.5%**，且缺 schemaVersion/source 双必填，去重键退化。

---

## 四、裁决与建议

### 维持项（现状设计正确，迁移时应保留）

- NOTIFY 只作 wake-up、2s 轮询兜底、sequence/replay/gap 语义为唯一事实源（standalone_024:10-13、scheduler-stream.service.ts:145-149）——这是正确的传输设计，与「谁拥有骨干」正交。
- ewoh_outbox 的 GLOBAL_SHARED + 应用层 org 过滤（outbox.service.ts:208-210）+ SSE fail-closed 租户防线（controller:600-607）组合有效，保持。
- Edge 上行腿的 at-least-once + 云端 (org,source,eventId) 幂等去重 + 离线队列断点续传（event_uplink.py:7-13）+ production 拒明文 http（:76-81）是全仓事件可靠性最强的一段，作为骨干范本。

### 建议抽共享 Event Backbone（有实害，值得做）

**目标边界**：新建 `server/modules/event-backbone/`（或扩展现有 events 模块），收编 OutboxService + PgNotifyListener + StreamService；ewoh_outbox 表保持原名（GLOBAL_SHARED 裁决不变），**增列** `schema_version/source/observed_at`（或直接加 `envelope_json` 列），SSE 端点泛化为 `/api/events/stream?types=...`，scheduler `v2/stream` 保留为兼容别名。

**迁移路径（三步，每步独立可回滚）**：
1. **搬家不改语义**：OutboxService/PgNotifyListener/StreamService 从 scheduler.module 移入 event-backbone.module（channel 更名 `ewoh_outbox`，旧频道 trigger 并发 NOTIFY 一个版本）；scheduler 改为注入。零行为变更，纯边界调整。
2. **类型收编**：outbox 写入方统一走 catalog 类型（dot.case→PascalCase 映射表过渡，SSE 侧双发新旧类型一个版本）；把 validateEventEnvelope 接到 enqueue 入口（eventType fail-closed 门禁下移到运行时）；补 `WorldEntityUpdated`/`ResourceStateChanged` emit 位点（world-state.service 投影变化处）或从 catalog 删除悬空类型。
3. **双轨合流**：ewoh_event 写入方（15 模块 + ingest 上行）在写事实表的同时双写 backbone（复用 buildEventEnvelope 已有产物，outbox 存 envelope 整体）；SSE 泛化端点按 org+eventType 订阅；alert/timeline 增量消费改订阅 backbone，拉取路径保留兜底。mes 的 `eventType:'quality'` 收敛为 `QualityFindingDetected`。

**envelope 补齐（伴随第 2 步）**：SchedulingEvent 增加 schemaVersion/source；sourceTs/serverTs 语义对齐 observedAt/receivedAt 命名；dataQuality 提升为契约可选字段（与 confidence 成对：置信度 × 数据质量）；actor/causationId 在关键写路径（人工审批、agent 决策）补填——agent 已有 correlationId 先例（agent.service.ts:783）。

### 若维持现状（次选）

至少消除三处脱节的最小修补：outbox enqueue 前做 catalog 白名单校验（新增映射即可，不改模块边界）；给 WorldEntityUpdated/ResourceStateChanged 补生产者或删目录定义；mes 裸写类型收敛。此路线保留「scheduler 事件流 + ewoh_event 事实表」双轨，但接受 SSE 消费者永远看不到域事件、envelope 覆盖率停在 44% 的现状。
