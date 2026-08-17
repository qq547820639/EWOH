# Architecture After — 二轮审计收敛后终态

> 生成时间：2026-08-18
> 数据来源：`findings.jsonl`（status=FIXED 项及 resolution_note）、`parts/fixlog-schcore.jsonl`、`parts/fixlog-schsvc.jsonl`、`parts/fixlog-db-contracts.jsonl`、`parts/fixlog-p1-closeout.jsonl`、`parts/fixlog-nz.jsonl`、`parts/fixlog-tenant.jsonl`、`parts/fixlog-srv-client.jsonl`、`p2p3-dispositions.md`；before 基线见 `architecture-before.md`。
> 本文回答三件事：哪些 split-brain 已收敛、哪些保持既定架构裁决、R2 修复对架构面的影响；与 before 逐项对照。

---

## 1. World Kernel — after

### 1.1 既定架构裁决：多投影形态保留，未合并为单 Kernel

本轮**没有执行** arch-world 底稿建议的「ResourceProjectionService 升格唯一资源投影内核 / 合并 project 与 projectForSnapshot 双装配」类收敛。该建议属系统性重构（约 400 行平行代码合并、A4 协议二选一、快照版本命名空间统一），不在本轮单迭代安全范围内；findings.jsonl 中无对应拆分/合并执行项。**终态：World 保持「7 张事实表 authoritative + 三链路投影 + A3 唯一物化快照」的既定形态**（见 `architecture-before.md` §1.2），边界事实不变。

### 1.2 已收敛的 split-brain（R2 对 World 面的实际影响）

| before 分裂点 | after 收敛动作 | 证据 |
|---|---|---|
| 资源投影的维护/质量附着全表扫描**无 org 过滤**，跨租户事实可附着进投影（R2-SSV-04） | loadActiveMaintenance/loadActiveQualityFindings 接收 ctx 并按 org_id 过滤；project 与 projectForSnapshot 调用处全部透传 ctx；ctx 缺省=系统后台流（GUC/RLS 兜底） | parts/fixlog-schsvc.jsonl R2-SSV-04（resource-projection.service.ts） |
| ResourceProjectionAdapter.getResources() 不接收 ctx，projectByType 全租户投影绕过 NEST-102（R2-SSV-22） | 适配器接口增 ctx? 参数并透传至 getUnifiedResourceState(ctx)（关闭旁路；ctx 缺省=系统流向后兼容） | parts/fixlog-schsvc.jsonl R2-SSV-22（resource-adapters.ts） |
| world.service.getEventChain 无租户谓词，任意认证用户持他租户 eventId 可枚举事件因果链（R2-SNZ-001） | getEventChain 增加 actor 参数复用 orgCondition（global_admin 放行、缺租户 400 fail-closed、他租户不可见） | parts/fixlog-nz.jsonl R2-SNZ-001（world.service.ts:217-241 一带） |
| getReplay 五表查询中 events 无 limit，单请求可拉数十万行（R2-SNZ-014） | events 查询补 .limit(5000) | parts/fixlog-nz.jsonl R2-SNZ-014 |
| 模拟器 world_state/environment 行落 NULL=legacy 全租户可见（R2-SNZ-004） | 行显式携带 orgId: simulatorOrgId()（EWOH_SIMULATOR_ORG_ID；缺配置 fail-closed） | parts/fixlog-nz.jsonl R2-SNZ-004 |
| ewoh_spatial_entity.entityId 全局唯一——跨租户同 entity_id 互相覆盖（R2-SOP-003/R2-SAM-003） | standalone_059 迁移为 (org_id, entity_id) 复合唯一 + onConflictDoUpdate target 同步——多租户事实层分裂消除 | parts/fixlog-ops.jsonl R2-SOP-003；db/migrations/standalone_059_spatial_entity_org_unique.sql |
| ewoh_spatial_entity / ewoh_environment 读面 org 缺失写 NULL 行（R2-SOP-022） | ingestEnvironment fail-closed 拒绝写入，与 camera/spatial/location 三路径对齐 | parts/fixlog-ops.jsonl R2-SOP-022 |
| 锁定任务状态集三方漂移（world-state 缺 received/paused/exception，impact 层含非契约 in_progress）（R2-SCH-011） | TASK_LOCKED_STATUSES 收敛 task-lifecycle 单一事实源：world-state/impact-analyzer/impact-propagation 三处同源化 | parts/fixlog-schcore.jsonl R2-SCH-011 |

**保持不变（如实登记）**：A4 world-cursor 空转协议面（预留未接线）未拆除；`WS-` 版本号云端/边缘两套分配器并存；`GET /api/world/snapshot` 与 `GET /api/resources/state` 端点重名异义保持；表名三连与"资源"双义保持。这些属 arch-world §四迁移路径第 1/4/6 步，本轮未排期。

---

## 2. Decision Kernel — after：仍为 Scheduler 私有托管，提升裁决维持"证据成立、暂不迁移"

- **边界终态**：decision-projection.ts / decision-ledger.ts / decision-history.service.ts 仍物理托管于 `server/modules/scheduler/`；AgentService/LearningProposalService 反向 import、AgentModule/LearningModule 模块依赖（agent.module.ts:21、learning.module.ts:17）保持——arch-decision §6.3 的"维持现状最低整改"路线中，本轮落地的是读面治理与下游缺口，**域提升（迁 server/modules/decision/）未执行**，作为既定架构裁决保留（底稿 §6.2 三步迁移路径备查）。
- **读面缓解落地（R2-SSV-23）**：DecisionHistoryService 方案决策加载按 createdAt 降序 + MAX_PLAN_SCAN=500 扫描上界——内存/延迟不再随方案库总量线性膨胀，DoS 面收敛。fixlog 明示 status=PARTIALLY_FIXED：完整修复（jsonb_array_elements + LATERAL 服务端分页/平表）需契约与索引迁移，DEFERRED 至后续迭代（parts/fixlog-schsvc.jsonl R2-SSV-23）。
- **写入语义加固**：decision 台账所在调度域的宿主事务边界经 R2-SCH-014（replan 的 persistPlan 并入同一 runInTransaction）进一步闭合——decision_records_json 与宿主业务行的原子性是当前设计优点（arch-decision §6.1"不迁"理由之一），本轮未削弱。
- **九要素缺口（outcomeRef 8/8、policyVersion 7/8、evidence 2/8）**：本轮无对应 FIXED 项，缺口如实保留（属契约字段投影扩展，非本轮范围）。
- 前端两套解释面（DecisionTrace vs DecisionRecord）并行保持。

---

## 3. Event Backbone — after：骨干仍 Scheduler 垄断（既定裁决），可靠性/租户面修补落地

### 3.1 保持的架构裁决

- outbox→pg_notify→SSE 传输骨干仍为 Scheduler 私有；未抽取共享 event-backbone 模块；ewoh_event 与 ewoh_outbox 双轨并存；catalog PascalCase vs outbox dot.case 命名分裂保持——arch-event §四"抽共享骨干"三步迁移未排期，本轮无对应执行项。
- 维持项（底稿判定"正确设计"）：NOTIFY 只作 wake-up + 2s 轮询兜底 + sequence/replay/gap 语义唯一事实源；GLOBAL_SHARED 表 + 应用层 org 过滤 + SSE fail-closed 租户防线组合。

### 3.2 R2 落地的骨干面修复

| 修复 | 内容 | 证据 |
|---|---|---|
| R2-SSV-21 | scheduler-stream 冷启动先 latestSequence() 对齐游标——重启后首 poll 不再从 sequence 0 重放至多 5000 条历史事件洪泛；历史重放仅经 replaySince 显式请求 | parts/fixlog-schsvc.jsonl |
| R2-SSV-24 | policy rollback 与 activate 对称留痕：outbox `policy.rolled_back` 事件 + 审计 + metrics——回滚不再在事件流/审计面不可见 | parts/fixlog-schsvc.jsonl |
| R2-SOP-002 | DataQualityAlert 事件写入 ewoh_event.values.orgId 且 org 缺失 fail-closed 拒写（不落 NULL=legacy 行）；events_triggered 如实反映 | parts/fixlog-ops.jsonl |
| R2-SSV-05 | applyExecutionAdvancement CAS UPDATE 加 .returning 命中校验——并发反馈不再产生重复 assignment 事件；eventId 改 EVT-${randomUUID()} | parts/fixlog-schsvc.jsonl |
| R2-SSV-06 | conflictId 统一 SHA-256 48-bit 折叠单一实现（删除 djb2 双事实源） | parts/fixlog-schsvc.jsonl |

envelope 覆盖率 44%/37.5% 的结构面（SchedulingEvent 缺 schemaVersion/source 等）未变。

---

## 4. Edge / Agent / Learning / Exo — after：before 的 5 项 P1 关闭 4 项域内缓解 + 1 项裁决转化

| before 缺口 | after 终态 | 证据 |
|---|---|---|
| ECA-P1-1 Control 回执可伪造 | 未在本轮 findings 中直接关闭（回执绑定设备凭证需 ingest key 按设备签发，属产品/协议面）；Control 域转而落地更高优先级的审批链与租户归属修复：R2-SMI-001（P0，高危指令审批链接入 ApprovalPersistenceService）、R2-SMI-002（deviceId 归属校验）、R2-SMI-009（请求行 CAS） | findings.jsonl R2-SMI-001/002/009；parts/fixlog-ctrl.jsonl |
| ECA-P1-2 上行桥批量失效+缓冲无界 | 底稿已注明"已文档化待修"（data-flow.md:69）；本轮 findings 无对应 FIXED 项，如实登记未关闭 | parts/arch-edge-agent.md §1.4 |
| AGT-P1-1 审批解析无角色约束（agent 侧） | agent 审批解析的租户/事实面经 R2-SBZ-002 收紧（getCurrentWorldState 透传 ctx，建议 facts 不再聚合全租户世界状态；runSupervisorSuggestion ctx 校验 401）；审批者角色∩rolesJson 校验本身未作为独立 FIXED 项落地（learning 侧同类已收，见下） | parts/fixlog-tenant.jsonl R2-SBZ-002 |
| EXO-P1-1 exo 高敏写无角色约束 | exo 会话/配置的事务与 CAS 面收紧：R2-SAM-005（terminate CAS）、R2-SAM-006（start/terminate recordEvent 同事务）、R2-SAM-007（activateProfile supersede 并入同一事务）；类级 @Roles 收敛在其他域推进（见 security-report.md），exo 控制器角色面本轮无对应 FIXED 项 | parts/fixlog-srv-client.jsonl R2-SAM-005/006/007 |
| LRN-P2-3 learning approve 无角色限定 | **已修**：approve/reject/rollback 加方法级 @Roles(workshop_lead, global_admin)（getAllAndOverride 覆盖类级 ANY_AUTHENTICATED）；propose/shadow 反馈腿保持全角色+人审下游 | parts/fixlog-p1-closeout.jsonl R2-SBZ-003 |
| LRN-P2-2 边缘 consent fail-open 面 | **已修**（超范围收口）：start_session 强制 consent_id 非空非空白 + governance consent_record 交叉校验（revoked/不存在即拒绝）；R2-ESC-005 consent 日志环形上限 | parts/fixlog-security.jsonl R2-EDM-06；parts/fixlog-edge-scripts.jsonl R2-ESC-005 |
| 边缘调度状态机（ESC-002/010） | confirm 白名单收敛 PLAN_PENDING_REVIEW + validate_plan_transition 统一转移校验；confirm 仅 SHADOW/PROPOSED 可确认，REJECTED/EXECUTED/CONFIRMED 终态拒绝（人工否决不可复活） | parts/fixlog-sched-tests.jsonl R2-ESC-002/010 |
| 影子评估事实窗口信任客户端（R2-SBZ-004） | facts 改由服务端从 ewoh_telemetry（org 作用域）重建窗口；客户端 facts 仅作对账提示不作证据；空窗口 fail-closed | parts/fixlog-srv-client.jsonl R2-SBZ-004 |
| 边缘解绑归属信任 body.endedBy（R2-ECO-001） | 归属校验只信任 token 会话身份，body 字段仅作记录不参与授权 | parts/fixlog-p1-closeout.jsonl R2-ECO-001 |

**P0-SCHED-OWNERSHIP 边界**（云端唯一调度写权限）保持：connected production 下边缘只读 advisory 不变；R2-ESC-008 仅收敛"删除持久化 plan 分支"的 advisory_only 条件（simulation 完整写模式云重连不删正式方案）。

---

## 5. before → after 逐项对照总表

| # | 架构面 | before（architecture-before.md） | after 终态 | 变化性质 |
|---|--------|----------------------------------|------------|----------|
| 1 | World 权威源形态 | 7 事实表 + 三链路投影，无单 Kernel | **保持**（既定裁决） | 不变 |
| 2 | 资源投影租户面 | 维护/质量附着无 org 过滤；adapter 绕过 NEST-102 | 双面修复（R2-SSV-04/22） | 收敛 |
| 3 | world 读面 | getEventChain 无租户谓词；replay 无界 | 谓词 + limit(5000)（R2-SNZ-001/014） | 收敛 |
| 4 | spatial_entity 唯一键 | entityId 全局唯一（跨租户覆盖面） | (org_id, entity_id) 复合唯一（standalone_059） | 收敛 |
| 5 | 锁定任务状态集 | 三方漂移 | task-lifecycle 单一事实源（R2-SCH-011/016） | 收敛 |
| 6 | A4 游标协议空转 | 有权限无数据 | **保持**（未接线未拆除） | 不变 |
| 7 | Decision 治理形态 | Scheduler 私有 + 跨域借用（6 位点） | **保持**；读面上界缓解（R2-SSV-23 PARTIALLY_FIXED，完整修复 DEFERRED） | 缓解 |
| 8 | Decision 九要素缺口 | outcomeRef 8/8、policyVersion 7/8 缺 | **保持**（无对应 FIXED 项） | 不变 |
| 9 | Event 骨干归属 | Scheduler 垄断，双轨零互通 | **保持**（既定裁决）；stream 冷启动/rollback 留痕/事件 org 注入落地（R2-SSV-21/24、R2-SOP-002） | 修补 |
| 10 | envelope 覆盖率 | ②腿 44%、③腿 37.5% | **保持** | 不变 |
| 11 | Agent 角色强约束 | AGT-P1-1/2 待收 | 部分收敛（R2-SBZ-002 ctx 链）；审批角色∩rolesJson 未独立落地 | 部分收敛 |
| 12 | Learning 审批角色 | LRN-P2-3 | @Roles(workshop_lead,global_admin) 落地（R2-SBZ-003） | 收敛 |
| 13 | 影子评估证据链 | 事实窗口信任客户端 | 服务端 org 作用域重建（R2-SBZ-004） | 收敛 |
| 14 | 边缘调度状态机 | confirm 白名单与转移表两处独立演化 | 单一转移校验 + 终态保护（R2-ESC-002/010） | 收敛 |
| 15 | Edge/Cloud 调度权 | 云端唯一（P0-SCHED-OWNERSHIP） | **保持且加固**（R2-ESC-008 advisory 条件化） | 保持 |
| 16 | 巨型多 Kernel 文件 | work-orchestration.service.ts 1592 LOC ≥6 职责；scale.service.ts 1720 LOC ≥7 职责 | **ADJUDICATED 不强拆**：先收敛缺陷面（租户谓词/幂等），拆分方案作后续 ADR 立项 | 裁决保留 |

## 6. 结论

本轮架构面收敛以**租户谓词补齐、状态机单一事实源、事务/幂等语义加固**为主线（详见 `refactor-report.md`）；四个 Kernel 的**形态级裁决**（World 多投影保留、Decision 不提升、Event 骨干不抽取、巨文件不强拆）全部维持既定架构判断，其中 Decision 读面与 stream 可靠性两点为"裁决保留 + 局部缓解"的混合终态。未收敛项已在 §5 如实标注"保持"，无新增悬空承诺。
