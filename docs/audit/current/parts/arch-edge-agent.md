# Edge/Agent/Learning/Exo 架构审计（arch-edge-agent）

审计日期：2026-08-17。范围：边缘 `src/edge_platform`（Python）、云端 `ewoh-spark-app/server`（NestJS + PG17）、共享契约 `ewoh-spark-app/shared` + `contracts/`、迁移 `db/migrations`。只读取证，全部结论附 file:line。

前置说明：任务给出的不变量编号 **INV-002 未在仓库任何位置定义**（全仓 grep `INV-` 零命中，.codex/artifacts 亦无）；本审计按语义最近邻的权威文本对照——ADR-016 决策 1「Agent 不得直连数据库或域表；写路径走 Domain Service（Policy→Authorization→State Revalidation→Reservation→Dispatch→Audit 六步链）」（docs/decisions/ADR-016-agent-runtime.md:19-40,76-77）。

一句话总裁决：**四项均无 P0 违规；安全边界（云端无执行器直驱路径、Agent 无直写生产域表、训练租户隔离、Support Mode 不伪造）在机器层成立，但「人审/高敏写路由的角色强约束」普遍缺位（ANY_AUTHENTICATED_ROLES 粒度），构成 5 项 P1。**

---

## 一、Edge/Cloud 权责边界

### 1.1 事实与决策归属（证据表）

| 事实/决策 | 归属 | 证据 |
|---|---|---|
| 原始帧采集与统一语义（厂商字段不泄漏） | 边缘 | src/edge_platform/edge/exo_semantic.py:201-236（map_vendor_to_unified，未在 mapping 中的字段不出现在统一帧） |
| 设备健康/在线/固件元信息 | 边缘 | edge/manager.py:134-175（health 汇总）；edge/adapters/ny_exo_a1/adapter.py:566-568,639-641（IDENT/HEARTBEAT 维护 firmware）；edge/storage.py:352-354（last_seen/online） |
| 遥测/风险事件/绑定本地账（SQLite 9 表） | 边缘 | edge/storage.py:84-232（SCHEMA）；docs/architecture/data-flow.md:17 |
| 本地绑定事实（采集面第一写者） | 边缘 | routes/exo.py:59-101（bind 落 storage.exo_binding 后发事件）；storage.py:465-481 |
| ExoSession 权威台账 | 云端 | routes/exo.py:7-9（docstring：云侧 ewoh_exo_session 台账为权威）；ingest.service.ts:492-503（事件→投影） |
| 调度决策与派工写权限 | 云端（唯一） | docs/architecture/runtime-map.md:20-21（ensure_scheduling_write_permitted：connected production 下边缘调度只读 advisory，防 split-brain） |
| Agent Runtime | 云端（边缘不做） | ADR-016-agent-runtime.md:74-75 |
| 审批/Learning/模型注册/维护/质量闭环 | 云端 | server/modules/{approval,learning,model,maintenance,quality}；standalone_041/045/034 |
| 安全闭环（急停/助力/限扭） | 设备控制器（永久） | ADR-016-agent-runtime.md:28-31（§2：Agent Policy 不得授予 safety-critical 执行能力） |

### 1.2 上行链路清单

| 链路 | 通道 | 证据 |
|---|---|---|
| 外骨骼遥测帧 | POST /api/ingest/exoskeleton/batch（X-Ingest-Key + X-Org-Id） | edge/bridge/edge_to_spark.py:282-300 |
| Catalog 信封事件（风险事件/世界投影/ExoSession 起止） | POST /api/ingest/events（≤100/批） | edge/bridge/event_uplink.py:53-66；断点续传队列 :84-124；production 拒明文 http :76-81（EDGE-041） |
| 绑定会话事件 ExoSessionStarted/Ended | routes/exo.py:24-27,89-95 → STREAM_EVENTS → EventUplink | 同上 + ingest.service.ts:495-503（投影幂等） |
| 边缘指标快照 | POST /api/observability/edge-metrics | run.py:316-318（MetricsUplink 装配）；见 arch-event.md:23 |
| 云侧入口防护 | IngestGuard：key constant-time + fail-closed + 100 req/min + X-Org-Id→租户上下文 | ingest.guard.ts:36-97,100-105 |

### 1.3 下行链路与「绕过本地安全控制器」裁决

**判定：合规——不存在云端指令直接驱动执行器的路径。** 四重证据：

1. 云侧唯一的「设备命令」域 Control 是**纯台账**：`sendCommand` 仅 insert `ewoh_control_command(status='sent')`（control.service.ts:183-267），全文件无任何向边缘/设备的传输实现；
2. Exo 配置域显式声明边界：「配置事实记录绝不涉及实时助力闭环下发」（exo-config.service.ts:43）；
3. 边缘运行时仅监听 127.0.0.1:8765 本地 API（runtime-map.md:10），无下行命令接收端点；EventUplink/MetricsUplink 均为出站单向上行；
4. 边缘调度在 connected production 下强制只读（runtime-map.md:20-21），且边缘推荐面自我声明「最终派工须人工确认，平台不自动强制派工」（services.py:236）。

### 1.4 缺口与整改

| 编号 | 级别 | 发现 | 证据 | 整改建议 |
|---|---|---|---|---|
| ECA-P1-1 | P1 | **Control 回执可伪造**：POST /api/control/requests/:id/receipts 接受调用方自报 executed/failed，无设备侧身份/密码学验证；虽有角色 fallback（global_admin/dispatcher，route-role.policy.ts:17），但回执本质是设备事实却由 API 客户端断言 | control.controller.ts:35-49；control.service.ts:269-329 | 回执需绑定设备凭证（ingest key 按设备签发）或经边缘上行事件投影，云侧 API 只读 |
| ECA-P1-2 | P1（已文档化待修） | 上行桥批量失效（len>=1 即刷，批量化名存实亡）+ 断线缓冲无界（内存 list 无上限） | edge_to_spark.py:251（`if len(self._buffer) >= 1`）、:231-232；data-flow.md:69 已列为已知断点 | 改为攒批（≥N 或 T 秒）+ 缓冲上界丢弃策略；对齐 EventUplink 的持久化队列模式（event_uplink.py:84-124） |
| ECA-P2-1 | P2 | ControlController 无类级 @Roles，依赖 fallback 表（本例已覆盖 global_admin/dispatcher）；fallback 表属「不可编辑模块」的临时补丁，新增控制器默认拒绝之外的治理靠人工维护 | route-role.policy.ts:1-21；roles.guard.ts:28-36 | 逐步将 fallback 收敛为显式 @Roles 装饰器 |

---

## 二、Agent Runtime 受控性（对照 INV-002 / ADR-016）

### 2.1 写路径全景（逐操作证据表）

说明：位于 `ewoh-spark-app/server/modules/agent/`。「Kernel/Policy 检查」列映射 ADR-016 六步链中的机器闸门。

| 写操作 | 目标表 | Kernel/Policy 检查 | Approval | file:line |
|---|---|---|---|---|
| Manifest 注册（insert/update） | ewoh_agent_manifest | validateAgentManifest 契约 fail-closed（:127-130）+ Tool 注册表白名单（:131-136，agent-tools.ts:8-27）+ 版本单调/幂等（:142-150） | 无（登记类；审计 agent.manifest.register/update :168,188） | agent.service.ts:119-190 |
| 命令挂起（L1 或 approvalRequiredFor 命中） | ewoh_agent_approval(pending) | command∈writeScope.commands（:259-261）；L0 拒写（:262-263）；审批需求判定（:266-267）；rolesJson 快照（:272-281） | 是（台账落库 + 通知） | agent.service.ts:265-299 |
| 审批通知（旁路） | ewoh_notification | roles 仅用于通知目标；失败留痕不阻断（:439-445 NEST-341） | — | agent.service.ts:419-446 |
| 审批解析（CAS） | ewoh_agent_approval(approved/rejected/expired) | (org,approvalId) 定位（NEST-305 :459-470）+ pending CAS（resolveRow :565-583）+ TTL 24h 超期=拒绝留痕（:23,487-507）+ 决策投影 ADR-047（:542-554） | — | agent.service.ts:451-535 |
| 批准后重放执行 | 经 dispatchCommand | budget/timeout 强制（:603-615，NEST-327/329）；审计 agent.command.executed :619 | 已批 | agent.service.ts:586-632 |
| record_evidence | 仅审计行 | — | L1 人审后 | agent.service.ts:358-361 |
| propose_plan | **无落库**（返回 proposal 载荷） | — | L1 一律人审 | agent.service.ts:363-365 |
| create_work_order | ewoh_work_order（**经 WorkOrderService**） | 载荷 origin/subjectEntityId 契约校验（:369-371）→ Domain Service 权威写路径（ADR-016:76-77） | 按 manifest 阶梯 | agent.service.ts:366-374 |
| register_knowledge | ewoh_knowledge_entry（**经 KnowledgeService**） | kind/scope/title/body + sourceEvidenceIds 非空证据链（:379-384）→ Domain Service（RLS+五层 scope 双强制，:377） | L1 一律人审 | agent.service.ts:375-387 |
| 其余命令（reserve/dispatch/notify/simulation 等） | 无 | **fail-closed**：tool_execution_not_implemented（绝不静默假装执行） | — | agent.service.ts:388-389 |
| AgentTask 创建 | ewoh_agent_task | validateAgentTask 契约（:62-65）+ 依赖环 BFS 检测（:83-106）+ 并发预算（每角色≤10，advisory xact lock 串行化检查-插入 :112-128，NEST-324） | — | agent-orchestrator.service.ts:54-151 |
| AgentTask 状态推进 | ewoh_agent_task（CAS where status=当前） | 状态机 yaml 同源转移表（:170-174）+ actorRole 派生约束（SH-005 :177-182）+ 依赖门控 dispatch 前全 completed（:183-198）+ CAS（:199-213） | — | agent-orchestrator.service.ts:155-228 |
| 决策/编排事件 | ewoh_event（信封入 evidenceJson） | catalog 白名单（:771-774 / orchestrator:320-323） | — | agent.service.ts:757-809；agent-orchestrator.service.ts:313-361 |

RLS/租户：agent 三表均 TENANT_SCOPED + RLS（standalone_037_agent_manifest.sql:10,25-51；standalone_049_agent_approval.sql:11,15-42；standalone_038_agent_task.sql:27）；orgId 缺失显式 400（agent.service.ts:124-126；orchestrator:59-61）。

### 2.2 判定

**合规：不存在 Agent 直写生产域表、绕 RBAC/RLS/审批的路径。** 生产域写 100% 经 Domain Service（create_work_order→WorkOrderService.createWorkOrder :372；register_knowledge→KnowledgeService.registerEntry :385）；未接线命令一律 fail-closed（:389）；内置 Agent 均为 L1 建议型且写命令全列 approvalRequiredFor（BUILTIN_SUPERVISOR/KNOWLEDGE_MANIFEST :53-90）；L4 永不允许由契约层强制（ADR-016:39-40 + standalone_037:59）。

### 2.3 缺口与整改

| 编号 | 级别 | 发现 | 证据 | 整改建议 |
|---|---|---|---|---|
| AGT-P1-1 | P1 | **审批解析无角色强约束**：agentApprovalRoles()（默认 workshop_lead）仅作通知收件人（:26-33,431），resolveApproval 不校验 actor.roles∈rolesJson；控制器类级 ANY_AUTHENTICATED_ROLES → 任何认证角色可批准任意 Agent 命令（含 create_work_order） | agent.controller.ts:19,92-109；agent.service.ts:451-535 | resolveApproval 增加 `actor.roles ∩ rolesJson 非空` 校验，fail-closed 403 |
| AGT-P1-2 | P1 | **Manifest 注册无角色门槛**：任何认证用户可注册新 Agent（自带任意 writeScope.commands 与 riskLevel），风险仅靠执行期 L1 审批兜底 | agent.controller.ts:19,26-35 | 注册/版本升级限 global_admin/workshop_lead；或注册本身走 approval 状态机 |
| AGT-P2-1 | P2 | 步数预算进程内 Map 计数，重启清零（代码注释自认「防风暴护栏而非硬配额」）；多实例部署下计数不共享 | agent.service.ts:301-307,710-719 | 计数迁 Redis/DB（与 IngestGuard 限流同模式，ingest.guard.ts:107-122） |

---

## 三、Learning Kernel tenant-safety

### 3.1 证据表

| 维度 | 事实 | 证据 |
|---|---|---|
| 训练数据源（云侧时长模型） | ewoh_scheduling_feedback（actual_start/actual_end 双非空）+ **org_id 过滤**；taskType 事实自 ewoh_production_task | scheduler/prediction/duration-model-training.service.ts:54-90（eq(orgId) :62；task 查询 :69-74） |
| 训练数据源（边缘动作分类） | 本地数据集 windows.jsonl+manifest；**人员分组三集无交集断言（泄漏即退出）**；consent_id 记录于采集会话并写入模型卡 | inference/train.py:32-53（断言 :38-41）、:230-232 |
| 影子评估数据 | 历史事实窗口由调用方供给，评估器抛错则提案创建失败（fail-closed） | learning-proposal.service.ts:112-117,371-379 |
| 版本管理（云侧） | ewoh_model_registry 落版：supersede 旧 active + 版本递增；modelId org 命名空间 `task-duration-empirical:<orgId>`；orgIdFromModelId 解析归属 | duration-model-training.service.ts:93-141（:118-139 落版）；CHANGELOG.md:13-19（ADR-070）；schema.ts:602 |
| 版本管理（边缘） | ModelRegistry 状态机 CANDIDATE→SHADOW→ACTIVE→RETIRED；--register 仅登记候选**不自动激活**（EDGE-103）；仅 SHADOW 可激活 | governance/model_registry.py；inference/train.py:315-328；docs/operations/model_rollback.md:32-49 |
| shadow/production 隔离 | 预测 ShadowEvaluator **shadow-only**：canary 仅控制采样比例，生产预测输出仍为确定性 baseline；求解器激活阶梯 OFF→SHADOW→CANARY→PRODUCTION（PRODUCTION 需显式开关否则 fail-closed 回退） | shadow-evaluator.service.ts:39-45；runtime-map.md:50-52 |
| 学习指标台账 | v1 观测层：**绝不自动回写生产规则/策略**；modelAccuracy=null 显式 unknown 不伪造 | learning.service.ts:31,66；standalone_041_learning_evaluation.sql:51 |
| 提案激活闸门 | propose→shadow_evaluated→approved（人审 approvedBy 必填）→rolled_back；**无影子证据的激活被契约+DB CHECK 双拒绝**；激活唯一入口 getActiveThresholds（ReasoningService 消费，绝不隐式自动执行） | learning-proposal.service.ts:36-47,150-192,298-320 |
| 回滚机制 | 云侧：approved→rolled_back（人审+理由必填+决策投影 ADR-063 原子落库）；边缘：rollback 仅可回到曾 ACTIVE/SHADOW 的版本，原 active 自动退役，全链审计 | learning-proposal.service.ts:236-276；model_rollback.md:53-67 |
| 跨租户历史 | **曾存在真实泄漏**（retrain 无 org 过滤混合全租户反馈训练全局模型）→ ADR-070/NO-13u 修复：租户作用域训练强制（缺 orgId 400）、跨租户聚合显式 OFF、provider org 键控 | CHANGELOG.md:9-24；duration-model-training.service.ts:145-147,194-199；shadow-evaluator NEST-043 org scope（shadow-evaluator.service.ts:355-364） |
| RLS | learning 两表 TENANT_SCOPED RLS；model_registry 在 standalone_001 统一 RLS 组 | standalone_041:64-69；standalone_045_learning_proposal.sql；standalone_001_schema.sql:1528,1535-1539（ewoh_model_registry 在列） |

### 3.2 判定

**合规（含一次已修复的存量违规）：跨租户训练数据混合风险当前不存在**——训练查询强制 org 过滤 + modelId org 命名空间 + provider org 键控 + 表级 RLS 四层防线；历史泄漏（全租户反馈混合训练全局模型）已被 ADR-070 修复并有测试锁定（CHANGELOG.md:20-21「跨租户隔离 + 缺 org 400（9 例）」）。

### 3.3 缺口与整改

| 编号 | 级别 | 发现 | 证据 | 整改建议 |
|---|---|---|---|---|
| LRN-P2-1 | P2 | loadSamplesWithTaskType 的 ewoh_production_task 补查**无显式 org 条件**（依赖主键全局唯一 + 表级 RLS 兜底），防御纵深少一层 | duration-model-training.service.ts:69-74 | 补 eq(orgId) 与 feedback 同源过滤 |
| LRN-P2-2 | P2 | 边缘推理 consent 门控存在 fail-open 面：未注入 consent_manager 或帧缺 person_id → 放行（服务异常已 fail-closed，EDGE-107） | inference/pipeline.py:289-293（放行）vs :297-310（fail-closed） | production 装配强制注入 consent_manager；无 person_id 帧计入显式 unknown 审计而非直接放行 |
| LRN-P2-3 | P2 | 学习提案 approve 的 approvedBy 仅要求非空（取当前 userId），无审批者角色限定（与 AGT-P1-1 同类但影响面为阈值覆盖） | learning-proposal.controller.ts:21,63-71；learning-proposal.service.ts:151-155 | approve 路由限 workshop_lead/safety_admin 类角色 |

---

## 四、Exoskeleton 一等实体性

### 4.1 Person→ExoSession→Exoskeleton 绑定模型证据表

| 维度 | 边缘（采集面第一写者） | 云端（权威台账） |
|---|---|---|
| 绑定 API | POST /api/exo/bind / unbind；规范身份 device:/person: 前缀 fail-closed（routes/exo.py:30-35,69-72）；归属校验（EDGE-011：endedBy=本人或 admin，exo.py:124-130） | POST /api/exo/sessions(/end/abort)（exo-session.controller.ts:22-73） |
| 落库 | SQLite exo_binding（storage.py:465-491） | ewoh_exo_session（standalone_046_exo_session.sql:23-94；schema.ts:1818） |
| 并发保护（同外骨骼活跃唯一） | partial unique index `idx_exo_binding_one_active ON exo_binding(exo_id) WHERE status='active'` + 进程锁串行化 + 旧库重复显式告警 | partial unique index `uq_ewoh_exo_session_active_exo ON (org_id,exo_id) WHERE status='active'`（standalone_046:63-66）+ 23505 显式 conflict 异常（exo-session.service.ts:88-94，绝不静默双绑定） |
| 生命周期 | active→ended 状态机（end_binding where status='active'，storage.py:486-491） | active→{ended,aborted} 终态不可复开（shared/exo-session.ts:65-68）；endedBy/actualEndAt 必填（CHECK standalone_046:47-49 + terminate 校验 exo-session.service.ts:125-137） |
| 上下行一致性 | 绑定落本地账后发 ExoSessionStarted/Ended 信封事件（exo.py:38-56,89-95）；离线断点续传（event_uplink.py:84-124） | 事件投影幂等（同 sessionId 回读 / 同终态原样返回；投影失败留痕不阻断事件主事实，ingest.service.ts:492-503；exo-session.service.ts:76-84,131-135） |
| RLS | —（边缘单站点本地库，文件权限 0600，storage.py:291-296） | exo_session_org_isolation FOR ALL（standalone_046:73-94） |

### 4.2 Support Mode 厂商事实性

**判定：合规——Support Mode 只来自人工声明的配置事实（ADR-051 ExoConfigRecord），无 assist_pct 猜测路径；观测面诚实阻塞。**

- 厂商协议 NY-EXO-A1 TELEMETRY 20B 布局**无 mode 字节**（assist_pct 为助力强度连续量非模式分类）——协议确认书复核结论，CHANGELOG.md:25-30（NO-13t/ADR-069）；
- UnifiedExoFrame **无 supportMode 字段**；契约级锁定测试 3 例：TELEMETRY 无 mode 字节 / 统一帧无 support_mode / VENDOR_TO_UNIFIED 无 mode 语义路径（tests/test_ny_exo_a1_contract.py:692-715，协议升级即测试失败=漂移信号）；
- supportMode 只存在于配置域：封闭 8 词表（passive/lift_assist/carry_assist/stand_assist/balance_assist/upper_limb_assist/lower_limb_assist/vendor_specific，shared/exo-config.ts:15-24）；vendor_specific 必须带 vendorModeName（:128-135）；
- assist_level 数值事实照常观测（assist_pct/100 归一 [0,1]，adapter.py:622；量程校验 exo-config.ts:142-149），**与配置 mode 并列、不推导分类**（CHANGELOG.md:35-36）。

### 4.3 UNKNOWN 语义使用（合规）

- 帧缺省 device.health='unknown'、quality.status='unknown'（规范词表 good/degraded/invalid/unknown，exo_semantic.py:129-137,166-170）；
- 非安灯边缘上行事件 severity 显式 'unknown'（ADR-027：无风险判定不伪造，ingest.service.ts:518）；
- modelAccuracy=null 显式 unknown（台账无 outcome 标注绝不伪造，learning.service.ts:66）；
- 模型输出 unknown 三路径（data_quality/low_confidence/ambiguous；invalid>30% 窗口直接 unknown，train.py:229,239；评测含 unknown 率 :86-92）。

### 4.4 各域落点

| 域 | 落点 | 证据 |
|---|---|---|
| Fit | exo-config kind='fit'（pending/fitted/adjusted/invalidated；personId/fittedAt/fitter/measuredValues 契约必填校验） | shared/exo-config.ts:34,169-179；exo-config.service.ts:93-116 |
| Calibration | kind='calibration'（zeroing/load_cell/imu 封闭；result pending/passed/failed；nextDueAt≥calibratedAt 时间序校验） | shared/exo-config.ts:26-30,36,181-201 |
| Assist Profile | kind='assist_profile'（supportMode 封闭词表 + assistLevel∈[0,1]/torqueLimitNm≥0；activateProfile：同 (org,exo,mode) 既有 active CAS→superseded + 新 active 插入，主事实与事件同事务 NEST-431） | shared/exo-config.ts:32,125-168；exo-config.service.ts:142-225 |
| Battery | 帧 device.battery_pct（量程校验 invalid；低电 health degraded） | exo_semantic.py:124-131；adapter.py:580,608 |
| Health | device.health ∈ good/degraded/fault（fault_code 驱动） | adapter.py:606-611；exo_semantic.py:60 |
| Firmware | 帧 firmware_version（IDENT/HEARTBEAT 维护；模型卡/数据分级字段含 hardware/firmware_version） | adapter.py:566-568,640；exo_semantic.py:51-61 |
| Sensor | sensor_health 字段清单（TIER_DEVICE）；推理特征缺失通道容错不参与排序 | exo_semantic.py:60；inference/pipeline.py:270-272 |
| Maintenance | MaintenanceCondition 契约（ADR-010）+ ewoh_maintenance_condition + 云侧 maintenance 模块（lifecycle CHECK）+ 调度封锁投影 critical→OFFLINE fail-closed + WorkOrder 委托建单 | standalone_034_maintenance_quality.sql:26；docs/architecture/current-state.md:46 |

### 4.5 缺口与整改

| 编号 | 级别 | 发现 | 证据 | 整改建议 |
|---|---|---|---|---|
| EXO-P1-1 | P1 | exo 会话/配置写路由 RBAC 仅 ANY_AUTHENTICATED_ROLES：任意认证角色可开始/结束绑定、记录 fit/calibration、激活 assist_profile（状态机+审计+契约齐备，唯缺角色约束；对比 Control/Approval 域有 fallback 角色表） | exo-session.controller.ts:17-18；exo-config.controller.ts:17-18 | 高敏动作（activateProfile、fit/calibration 登记）限 device_ops/workshop_lead 类角色；bind/unbind 可保持宽松但 end/abort 应校验归属 |
| EXO-P2-1 | P2 | activateProfile 的 supersede 循环（逐行 update）不在事务内，多 active 并发窗口靠服务层+索引兜底（新 active 主落库已包事务 NEST-431） | exo-config.service.ts:168-202（循环）vs :204-223（事务） | supersede 循环并入同一事务 |
| EXO-P2-2 | P2（诚实声明） | NXP1 v1.0 不提供 joint_angles/temperature/cumulative_load——统一帧保持 None 待厂商扩展（非违规，记录为协议边界） | adapter.py:620-626 | 厂商协议升级时经契约测试（test_ny_exo_a1_contract.py）解锁 |

---

## 五、违规汇总

| 级别 | 编号 | 域 | 一句话 |
|---|---|---|---|
| P0 | — | — | 无 |
| P1 | ECA-P1-1 | Control | 设备回执由 API 客户端自报，无设备侧验证，可伪造执行事实 |
| P1 | ECA-P1-2 | Edge Bridge | 上行批量失效（每帧即刷）+ 断线缓冲无界（已文档化待修） |
| P1 | AGT-P1-1 | Agent | 审批解析不校验审批角色，任何认证用户可批准 Agent 命令 |
| P1 | AGT-P1-2 | Agent | Manifest 注册无角色门槛，任意认证用户可注册带写命令的 Agent |
| P1 | EXO-P1-1 | Exo | 会话/配置高敏写路由（含 assist profile 激活）无角色约束 |
| P2 | AGT-P2-1 / LRN-P2-1..3 / EXO-P2-1..2 / ECA-P2-1 | 各域 | 见各节缺口表 |

共性根因：**P1 全部集中于「已认证即可写高敏事实/审批」——机器闸门（契约/状态机/CAS/RLS/审计）完备，但人审与角色强约束（who may approve / who may register）停留在 ANY_AUTHENTICATED_ROLES 粒度**；建议作为一条专项整改线统一收口（复用 roles.guard + rolesJson 模式，与 access-matrix.yaml 对齐）。
