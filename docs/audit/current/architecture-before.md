# Architecture Before — 二轮审计收敛前架构基线

> 生成时间：2026-08-18
> 数据来源：`parts/arch-world.md`、`parts/arch-decision.md`、`parts/arch-event.md`、`parts/arch-edge-agent.md`（均为 2026-08-17 只读取证底稿，全部结论附 file:line）；`repository-truth.md`。
> 本文描述**本轮 R2 修复开始之前**的架构状态，作为 `architecture-after.md` 的对照基线。所有 file:line 均转引自上述底稿，未做二次臆测。

---

## 1. World State 清点结论（Factory World Kernel 基线状态）

核心问题：EWOH 中到底有几个 Factory World State，谁是 authoritative，哪些是 projection/derived。

### 1.1 World State 清单（A 云端 / B 边缘）

| # | 名称 | 位置/存储 | 写入者 → 读取者 | 新鲜度机制 | tenant-scoped |
|---|------|-----------|----------------|-----------|---------------|
| A1 | 逐实体状态流 | `ewoh_world_state`（schema.ts:737）append-only 行 | 模拟器 simulator.service.ts:553；摄像头/定位流 sensor-ingest.service.ts:99-119、230-259 | `ts` 列，无版本号 | 是（org_id，schema.ts:742） |
| A2 | 空间实体主数据 | `ewoh_spatial_entity`（schema.ts:768） | simulator.service.ts:519-522；sensor-ingest.service.ts:200-209 | `version` 列 + `_updated_at` | 是（schema.ts:797） |
| A3 | 调度世界快照 | `ewoh_world_state_snapshot`（schema.ts:1369）整快照 JSON | WorldStateSnapshotService.allocateAndPersistSnapshot（world-state.service.ts:102-108，事务内原子分配） | `WS-YYYYMMDD-NNNN` 按天计数（world-state.service.ts:736-750）+ entityVersions SHA-256 48-bit 折叠（:587-686） | 是（org_id 血缘列，:106） |
| A4 | 游标协议快照 | `ewoh_world_snapshot`（schema.ts:1386）+ `ewoh_world_delta_log`（schema.ts:1408） | 仅 world-cursor.service.ts:112/128/208——**applyUpsert/applyRemoval 生产代码零调用**（全仓仅测试命中） | 数值 snapshotVersion + seq 游标；CursorExpired → HTTP 410 | 是（NEST-609） |
| A5 | 统一资源投影（ResourceState 形态） | ResourceProjectionService.project()（resource-projection.service.ts:105-381），查询时计算 | 纯投影，无写入 | DEFAULT_FRESHNESS_POLICY（resource-projection.service.ts:47-59；STALE/UNKNOWN fail-closed） | 是（NEST-102 org 条件） |
| A6 | 快照形态资源投影 | projectForSnapshot()（resource-projection.service.ts:683-893） | 纯投影；scheduler 快照 persons/devices/stations 唯一来源 | 同 A5；附 source: AUTHORITATIVE/DERIVED | 是 |
| A7 | 调度资源预占 | `ewoh_resource_reservation`（resource-reservation.service.ts:7） | reserve（事务 + advisory lock + EXCLUDE，:76-100） | startMs/endMs 时间窗 | 是 |
| A8 | 物料库存/预占 | `ewoh_resource_binding` + `ewoh_resource_preorder`（resource.service.ts:12） | pg_advisory_xact_lock 防超卖（resource.service.ts:94-120） | 数量守卫条件更新 | 部分（写入带 org，读面 org 守卫属 NO-13ag 待办，resource.service.ts:70） |
| B1 | 契约世界模型 | ContractWorldStore（world_model/contract_store.py:47）双时态内存 | TelemetryWorldProjector（projection.py:51，fail-closed） | snapshotVersion 单调计数（EDGE-203）+ sourceProfile 隔离 | 是（tenant_id/factory_id 声明不可变） |
| B2 | 边缘调度世界快照 | WorldStateService.build_snapshot（scheduler/world_state.py:72-114），进程内不持久化 | 按需构建 | `WS-YYYYMMDD-NNNN` **进程内 _seq**（world_state.py:66-70）+ is_stale 300s | 否（单租户进程） |
| B3 | 边缘统一资源状态 | ResourceStateService（scheduler/resources.py:54-80） | 按需聚合 storage | per-resource 递增 version | 否 |
| B4 | 边缘设备/人员/事件读面 | routes/world.py:30-148，SQLite 直读 | edge/bridge | last_seen + offline_after_sec | 否 |

### 1.2 authoritative / projection / derived 判定（底稿 §二）

| 判定 | 对象 | 依据 |
|------|------|------|
| **authoritative（事实层）** | `ewoh_spatial_entity`、`ewoh_world_state`、`ewoh_personnel`、`ewoh_device`、`ewoh_production_task`、`ewoh_event`、`ewoh_resource_reservation` | 直接写入的业务事实表；模拟器与真实 ingest 双源同表，靠 source_type 区分（simulator.service.ts:533、sensor-ingest.service.ts:111） |
| **projection（可重建投影）** | A3 调度快照（7 表 + 资源投影重拼，world-state.service.ts:206-726）；A5/A6 资源投影；边缘 B2/B3；world.service.getCurrentState | 全部无独立事实，删除后可从事实层重建 |
| **derived（派生兜底字段）** | 快照内 safetyCritical/preemptible 等白名单派生（world-state.service.ts:305-342、763-869）；device capabilities 型号白名单派生（resource-projection.service.ts:229-234） | 派生字段带 `derived[]` 标记；source 双维度标记（P1-B） |
| **空转协议面** | A4 world-cursor（ewoh_world_snapshot/ewoh_world_delta_log） | 生产无写入者、无消费者；NEST-648 注释自称"有意并存"（world-cursor.service.ts:13-23）——有权限控制、无数据 |

**权威源一句话（before）**：不存在单一 Factory World Kernel；权威事实分散在 7 张业务表，"当前世界"由三条独立链路（world.service / scheduler world-state / 边缘 scheduler）各自即时拼装；A3 是唯一持久化、带版本与新鲜度校验的物化投影——事实上的调度权威快照，但仅 scheduler 域内有效。

### 1.3 重复拼装位点（before 的 7 项分裂）

1. **"当前世界状态"三处独立计算**（persons/devices 语义与新鲜度互不一致）：world.service.getCurrentState（world.service.ts:76-212）vs world-state.service.collectState（:206-726）vs 边缘 build_snapshot（world_state.py:72-114）。
2. **ResourceProjectionService 双形状双代码路径**：project() 与 projectForSnapshot() 重复实现维护/质量附着、坐标判别、状态归一——约 400 行平行代码（resource-projection.service.ts:105-381 vs :683-893）。
3. **快照版本号 `WS-YYYYMMDD-NNNN` 两套独立分配器**：云端 DB 计数器（world-state.service.ts:736-750）vs 边缘进程内 _seq（world_state.py:66-70）——同一版本串在两个系统指向不同快照。
4. **端点重名异义**：`GET /api/world/snapshot` 边缘=契约快照 vs 云端=游标协议快照；`GET /api/resources/state` 边缘=ResourceStateService vs 云端=ResourceProjectionService。
5. **表名三连混淆**：`ewoh_world_state` / `ewoh_world_state_snapshot` / `ewoh_world_snapshot`（schema.ts:737/1369/1386）。
6. **"资源"双义**：调度预占 ewoh_resource_reservation vs 物料库存 ewoh_resource_binding/preorder，world.service.getReplay 把后者混入世界时间轴（world.service.ts:328-343）。
7. **派生白名单多处散落**：SAFETY_CRITICAL_TASK_TYPES 等集中在 world-state.service.ts:763-833，与 device-capabilities.ts 同源语义两处维护。

**上行路径**：边缘世界事实无快照级上行，仅遥测帧（→A1）与信封事件（EventUplink）两条间接通道；边缘 B1 与云端 A3 之间没有共享版本空间。

---

## 2. Decision Kernel — before 状态

底稿（parts/arch-decision.md）总裁决：**Decision 已是事实上的跨域公共事实——契约三实现全局锁步、数据横跨 4 张表分属 scheduler/agent/learning 三域、agent 与 learning 反向 import scheduler 内的投影实现——但治理形态仍是 Scheduler 私有，形成 agent→scheduler、learning→scheduler 反向依赖。**

### 2.1 数据与写路径分布

- 存储 4 表：`ewoh_schedule_plan.decision_records_json`（S1，scheduler，schema.ts:704-708）、`ewoh_agent_approval.decision_json`（S2，agent，schema.ts:999-1004）、`ewoh_learning_proposal.decision_json`（S3，learning，schema.ts:1929-1934）、`ewoh_scheduling_policy.decision_json`（S4，schema.ts:2177-2182）。
- 6 条写路径全部经 decision-projection 契约门 validateDecision（唯一投影点 decision-projection.ts 八个 project* 函数；唯一台账 decision-ledger.ts:41-55 读-追加-回写，无 CAS）。
- 契约层三实现（contracts/decision/decision.schema.json + shared/decision.ts + edge contracts/decision.py）+ CI 仲裁门（scripts/audit-domain-contracts.js:1086-1219）——**契约层无漂移**。

### 2.2 跨域消费位点（6 处）

| # | 位点 | 方向 | 证据 |
|---|------|------|------|
| 1 | AgentService import scheduler 投影并写 agent 表 | agent→scheduler（代码） | agent.service.ts:16-19、:510-532、:556-584 |
| 2 | LearningProposalService import scheduler 投影 | learning→scheduler（代码） | learning-proposal.service.ts:15、:159/:201/:243 |
| 3 | DecisionHistoryService 直读 ewoh_agent_approval.decision_json | scheduler→agent（表） | decision-history.service.ts:133-143 |
| 4 | DecisionHistoryService 直读 ewoh_learning_proposal.decision_json | scheduler→learning（表） | decision-history.service.ts:146-154 |
| 5 | AgentModule/LearningModule imports SchedulerModule | 模块级耦合 | agent.module.ts:21、learning.module.ts:17 |
| 6 | client import @shared/decision 消费四表聚合 | 前端跨三域数据 | client/src/api/decisions.ts:2/:36 |

### 2.3 九要素完备性缺口（before）

- **Outcome 断链（8/8 全缺）**：outcomeRef 零写入；契约显式放行（schema.json:50 outcomeLinkOptional）但决策→结果闭环不存在。
- **Policy 缺失（7/8）**：policyVersion 仅 task_assignment 条件携带（decision-projection.ts:149）。
- **Evidence 缺失（2/8）**：task_assignment（:134-153）、plan_approval（:194-211）。
- **Context 浅表（7/8 无 snapshotRef）**；Options 仅 task_assignment 携带真实候选，其余 7 类为合成双选。
- 读面风险：DecisionHistoryService 四表全量 SELECT 无 LIMIT 下推、内存排序分页（decision-history.service.ts:119-176）。

### 2.4 边界判定（before 结论）

写实现与读实现物理托管在 `server/modules/scheduler/`，被跨模块文件级 import；**已满足提升独立 Decision Domain 的全部证据条件，但本轮开始前未提升**（迁移三步路径见底稿 §6.2；反方陈述见 §6.3）。

---

## 3. Event Backbone — before 状态

底稿（parts/arch-event.md）一句话裁决：**骨干传输层（outbox→pg_notify→SSE）被 Scheduler 完全垄断；envelope 契约是全仓共享的，但只有「Edge 上行腿」和「ewoh_event 事实表腿」在用——两条腿互不相通，SSE 骨干上跑的是另一套私有命名的事件，未经契约门禁。**

### 3.1 垄断证据

- OutboxService：Grep `OutboxService|ewohOutbox` 命中 23 文件，21 个在 scheduler/，另 2 个是表定义与其测试——非 scheduler 使用方 **0 个**。
- pg LISTEN/NOTIFY：channel `scheduler_outbox` 硬编码（pg-notify.listener.ts:6），全仓 LISTEN 仅此一处；仅 SCHEDULER_STREAM_NOTIFY=1 时装配（scheduler.module.ts:55-71；deploy/.env.example:218 默认 0 → 纯 2s 轮询）。
- SSE 端点：scheduler.controller.ts:594 `@Sse('v2/stream')` 为全仓唯一 @Sse；world/events/alert 等域均无 SSE，前端 world 走 10s HTTP 轮询（client/src/api/world.ts:4-11）。
- 13 个 enqueue 位点 100% 在 scheduler/ 内（dispatch-coordinator.service.ts:387,401；plan.service.ts:517；execution.service.ts:313；conflict.service.ts:915；scheduler-query.service.ts:1148；replan-coordinator.service.ts:333；scheduler-event-application.service.ts:115,294；policy-activation.service.ts:305；shadow-policy.service.ts:167,276；solver.service.ts:518）。

### 3.2 三处结构性脱节

1. **命名分裂**：outbox/SSE 轨使用私有 dot.case 类型（`plan.dispatched`、`conflict.detected` 等），catalog 是 PascalCase（65 类）；outbox 写入路径不经 validateEventEnvelope/catalog 门禁。
2. **目录悬空**：`WorldEntityUpdated`、`ResourceStateChanged` 在 catalog 有定义（event-catalog.yaml:790-846）但 server 端零 emit 位点。
3. **双轨零互通**：ewoh_event（15+ 模块写、alert/timeline/mes 拉）与 ewoh_outbox（scheduler 写、SSE 消费）两张事实表、两套 ID、两套命名，互不可见。

### 3.3 envelope 16 字段覆盖率（before）

- ② Edge 上行/ewoh_event 腿：必填 5 项稳定；常填 7/16 ≈ **44%**（tenant/factory/actor/causation/confidence/evidence 基本空置）。
- ③ outbox/SSE 腿（SchedulingEvent）：命中契约语义仅 ≈ **6/16 ≈ 37.5%**，缺 schemaVersion/source 双必填，去重键退化（stream:227 eventId 单键）。

依赖事件数据的非 scheduler 域（alert/timeline/mes/rule-engine/ingest/quality 等）**全部依赖 ewoh_event 表，无一依赖 outbox 骨干**。

---

## 4. Edge / Agent / Learning / Exo Kernel — before 状态

底稿（parts/arch-edge-agent.md）总裁决：四项均无 P0 违规；安全边界（云端无执行器直驱、Agent 无直写生产域表、训练租户隔离、Support Mode 不伪造）在机器层成立，但「人审/高敏写路由的角色强约束」普遍缺位（ANY_AUTHENTICATED_ROLES 粒度），构成 5 项 P1。

### 4.1 Edge/Cloud 权责边界（合规项）

- 归属：原始帧采集/设备健康/本地绑定账归边缘；ExoSession 权威台账、调度决策与派工写权限、Agent Runtime、审批/Learning 闭环归云端；安全闭环（急停/助力/限扭）永久属设备控制器（ADR-016:28-31）。
- 下行裁决合规：云侧唯一"设备命令"域 Control 是纯台账（control.service.ts:183-267 sendCommand 仅 insert 'sent'）；边缘仅监听 127.0.0.1:8765；connected production 下边缘调度强制只读（runtime-map.md:20-21）。
- 上行四链路 + IngestGuard（key constant-time + fail-closed + 100 req/min，ingest.guard.ts:36-97）。

### 4.2 Agent Runtime 受控性（before）

- 写路径全景：Manifest 注册/命令挂起/审批解析 CAS/record_evidence/propose_plan/create_work_order（经 WorkOrderService）/register_knowledge（经 KnowledgeService）/其余命令 fail-closed（agent.service.ts:388-389 tool_execution_not_implemented）。
- RLS/租户：agent 三表 TENANT_SCOPED + RLS（standalone_037/049/038）。
- **缺口**：AGT-P1-1 审批解析无角色强约束（agentApprovalRoles() 仅作通知收件人；控制器 ANY_AUTHENTICATED_ROLES——任何认证角色可批准任意 Agent 命令，agent.controller.ts:19,92-109）；AGT-P1-2 Manifest 注册无角色门槛；AGT-P2-1 步数预算进程内计数。

### 4.3 Learning Kernel tenant-safety（before）

- 四层防线已存在：训练查询 org 过滤（duration-model-training.service.ts:54-90）+ modelId org 命名空间 + provider org 键控 + 表级 RLS。
- 历史跨租户泄漏（全租户反馈混合训练全局模型）已被 ADR-070 修复（CHANGELOG.md:9-24）。
- **缺口**：LRN-P2-1 task 补查无显式 org 条件（duration-model-training.service.ts:69-74）；LRN-P2-2 边缘 consent 门控存在 fail-open 面（inference/pipeline.py:289-293）；LRN-P2-3 learning proposal approve 无审批者角色限定（learning-proposal.controller.ts:21,63-71）。

### 4.4 Exoskeleton 一等实体性（before）

- Person→ExoSession→Exoskeleton 绑定模型双侧齐备（partial unique index 防双绑定：边缘 storage.py:465-491、云端 standalone_046:63-66 + 23505 显式冲突 exo-session.service.ts:88-94）；Support Mode 只来自人工配置事实（8 词表，shared/exo-config.ts:15-24），协议层无 mode 字节有契约测试锁定（tests/test_ny_exo_a1_contract.py:692-715）；UNKNOWN 语义合规。
- **缺口**：EXO-P1-1 exo 会话/配置写路由 RBAC 仅 ANY_AUTHENTICATED_ROLES（exo-session.controller.ts:17-18、exo-config.controller.ts:17-18）；EXO-P2-1 activateProfile supersede 循环不在事务内；EXO-P2-2 NXP1 v1.0 无 joint_angles 等（协议边界，诚实声明）。

### 4.5 before 违规汇总（5×P1）

| 编号 | 域 | 一句话 |
|------|----|--------|
| ECA-P1-1 | Control | 设备回执由 API 客户端自报，无设备侧验证，可伪造执行事实（control.service.ts:269-329） |
| ECA-P1-2 | Edge Bridge | 上行批量失效（每帧即刷）+ 断线缓冲无界（edge_to_spark.py:251、:231-232） |
| AGT-P1-1 | Agent | 审批解析不校验审批角色 |
| AGT-P1-2 | Agent | Manifest 注册无角色门槛 |
| EXO-P1-1 | Exo | 会话/配置高敏写路由无角色约束 |

共性根因：**机器闸门（契约/状态机/CAS/RLS/审计）完备，但人审与角色强约束停留在 ANY_AUTHENTICATED_ROLES 粒度。**

---

## 5. before 状态小结（对照 after 的锚点）

| Kernel | before 判定 | 关键锚点 |
|--------|-------------|----------|
| World | 无单一 Kernel；7 张事实表 authoritative；A3 唯一物化投影；A4 空转协议面；7 项重复拼装位点 | parts/arch-world.md §一/§二/§三 |
| Decision | 事实跨域公共 + 治理 Scheduler 私有（6 处跨域位点、outcomeRef 8/8 缺、读面无界） | parts/arch-decision.md §三/§四/§五 |
| Event | 传输骨干 Scheduler 垄断；契约共享但双轨脱节；envelope 覆盖 44%/37.5% | parts/arch-event.md §二/§三 |
| Edge/Agent/Learning/Exo | 安全边界机器层成立；5 项 P1 集中于角色强约束缺位 | parts/arch-edge-agent.md §五 |

收敛后终态见 `architecture-after.md`；结构性修复清单见 `refactor-report.md`。
