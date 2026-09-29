# EWOH Data Flow Map（数据流地图）

> 维护规范：本文件记录跨运行时数据流与持久化落点；以 08-14 走读实测链路为基线，
> 数据落点变更（新表/新存储/新流）时更新。最后更新：2026-09-12（第 44–53 轮逐轮追加行：
> 提醒终态/审批到期/安灯升级/责任人/班次维度/交接快照/数据质量待核实提醒/运行记忆信号/改进行动项/多模态感知融合/环境多源与逾期提醒/订单链与对账/经验回流）。

## 1. 主数据流总览

```text
┌ 现场/边缘 ─────────────────────────────────────────────────────────────┐
│ 物理设备/传感器/MES                                                      │
│   │ Adapter(codec/protocol，源标识 source)                              │
│   ▼                                                                     │
│ MessageBus ──telemetry──▶ InferencePipeline（2s 滑窗/1s 步长，规则+模型）│
│   │                            │(features→rule→model，consent 门控)     │
│   ▼                            ▼                                        │
│ Storage(SQLite WAL)  ◀──  EventEngine（风险事件 L1-L3，±30s 证据窗口）  │
│   │(telemetry/inference/risk_event/person/device/audit/调度 9 表…)      │
│   ▼                                                                     │
│ 本地 HTTP/SSE API（routes/*，离线可用）                                  │
│   │ EventBus(SSE) ──▶ GET /api/command-map/stream                       │
│   ▼ Edge Bridge（edge_to_spark.py，批量≤100，断线补传/回填）             │
└───────────────┬─────────────────────────────────────────────────────────┘
                ▼ POST /api/ingest/*（X-Ingest-Key fail-closed + X-Org-Id）
┌ 云端/主产品 ────────────────────────────────────────────────────────────┐
│ IngestGuard → ingest.service → 遥测/事件表（PG17，RLS+GUC）              │
│ React SPA → NestJS（TokenGuard→RolesGuard→OrgContext→RequestDatabase-  │
│   Context→RLS→Service→DB）                                              │
│ Scheduler V2：run 触发(冷却+幂等) → WorldStateSnapshot(版本原子分配)     │
│   → 约束过滤 → A/B/C 求解(heuristic canonical / CP-SAT 阶梯 fail-closed)│
│   → plan → approve(version+snapshot 双校验) → dispatch(CAS+容量预占)    │
│   → Outbox(DB 序列) → SSE(sequence/Last-Event-ID/resync/2s 轮询兜底)    │
└───────────────┬─────────────────────────────────────────────────────────┘
                ▼ webhook/推送
┌ 飞书侧车 ───────────────────────────────────────────────────────────────┐
│ 验签(4 道) → 卡片处置 → lark-cli(异步+并发4+熔断) → Base/审批/文档        │
│ better-sqlite3 本地缓存；flushTelemetry 失败保留 buffer                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 关键链路清单

| 链路 | 起点 → 终点 | 一致性机制 |
|---|---|---|
| Web 请求链 | React → NestJS → PG | JWT + RBAC + 请求级事务 GUC + RLS |
| 实时设备数据链 | Device → Edge → /api/ingest → 遥测/事件表 | source 标识、X-Ingest-Key、限流 100/min |
| 身份解析链（NO-02b） | ingest 设备 ID → ewoh_identity_mapping（org 内 active 映射）→ ewoh_telemetry.entity_id | 契约解析规则（ambiguous_identity fail-closed）；未映射 → NULL（legacy 行为不变） |
| 调度闭环 | Task/Person/Device/Spatial → 快照 → 求解 → 审批 → 派工 → SSE | snapshotVersion 双校验、CAS、Outbox 序列 |
| 世界回放 | WorldState+Events+ScheduleTask+TaskStep+ResourceBinding → Replay Timeline | 时间归并、事件前后快照 |
| 边缘离线链 | 本地 SQLite → Bridge 补传 | 回填/backfill、离线判定 10s、批量≤100 |
| 感知融合链（NO-56a/c/59a） | UWB 定位 + 外骨骼 IMU（俯仰+关节角→动作）+ 视觉检测/骨架/动作 + 工位语义 + 任务上下文 + 环境传感 → `ewoh_perception_fusion` 快照 | 源策略（权重/TTL/质量因子）、置信度**按源**计权（每源一次，多维度不叠加）、冲突逐条保留、过期/不可信显式排除；快照号 = 主体+窗口桶（幂等） |
| 感知门控链（NO-58b） | 融合快照 → 推理事实 `perceptionGate` → 结论 `advisoryOnly`；→ 调度冲突面 `perception_inconsistent` | 门控一致性契约校验（不许强建议 ⇒ 必须标 advisory 且给原因）；冲突为提示层（不阻断调度）、与在飞任务无关的主体不进冲突面、读取失败如实降级 |
| 控制命令**投递**链（NO-62a/b） | 人工下发（授权范围指纹固化）→ 网关轮询 → **投递前复核**（审批时效 + 指纹 + 租户）→ 不过则撤回（独立事务提交 + `delivery_rejected` 结果行 + 审计 + `NTF-CTRL-*`）→ 通过则按优先级投递（`stop` 插队）→ ack（指纹原样回传）→ 回执（执行了但授权已失效 → 额外落 `authorization_violation`） | 复核失败原因封闭词表（`authorization_expired`/`authorization_revoked`/`approval_missing`/`approval_not_granted`/`fingerprint_mismatch`/`fingerprint_key_missing`/`request_terminal`/`device_org_mismatch`）；撤回必须独立事务（请求事务会因 4xx 回滚）；投递顺序即安全语义 |
| 新鲜度分档闸门（NO-64a） | 快照 `entityVersions`（全量摘要）+ `entityContentVersions`（**内容版本**：排除新鲜度派生字段与证据时钟）+ `entityEvidence`（来源时间/质量/状态）→ 审批/派工共用 `stalenessVerdict`：内容不同 → 拒绝（`CONTENT_CHANGED`）；仅证据老化且**方案依赖**该资源且其 `dataQuality≠FRESH` → 拒绝（`EVIDENCE_STALE`）；与方案无关 → 不阻断并如实报告 | 老快照缺内容版本 → 严格判定（fail-closed）；"心跳/沉默"不再被当成"世界变了"，但**依赖资源的证据过期仍然拒绝** |
| 方案过期诊断链（NO-62c） | 方案 snapshotVersion → `describeStaleness`（entityVersions + reservations 差异）→ `GET /plans/{id}/staleness` / 审批 409 `error.planStaleness` → 页面差异面板 → 一键重排（新方案 + 新快照） | 与审批同一实现；区分外部变化 / 本方案自身执行效果；快照行缺失 → `snapshotFound=false` 且明说"无法比较"，不假装新鲜 |
| 执行机构调度链（NO-61a） | 状态帧（位置/电量/故障）→ `projectActuatorDeviceState` → `ewoh_device`（位置/电量/故障）→ 世界快照设备能力 `transport.move` → 候选/资格评估 → 方案 assignment | 设备新鲜度 **60s**（过期判 OFFLINE 不派工）；电量/位置用 COALESCE 保留已知值；任务须走状态机到 `pending_dispatch`；能力停用即不参与匹配 |
| 执行机构命令链（NO-59b） | 平台控制命令域（审批/幂等） → 边缘 `POST /api/actuators/{id}/commands` → `ActuatorAdapter`（授权校验）→ `Transport`（回环模拟 / Modbus / OPC-UA / 厂商 API） | 高危命令必须带平台授权号（403/400 区分"没给"与"给错"）；`stop` 免授权（安全优先）；接受与被拒都写审计；未注册设备 404、传输未就绪 503、故障态 409 |
| 命令下行链（NO-60a） | 平台 `sendCommand`（命令 + payload 落库） → 边缘网关轮询 `GET /api/control/commands/pending`（平台签发授权号 `control:<requestId>`） → `ControlAgent` 核对授权号 → 执行机构 | 只投递"本租户 + 目标设备 + sent + 请求非终态"的命令；授权号与 requestId 不一致即拒绝且不碰设备；孤立命令（无对应请求）根本不投递 |
| 投递确认/回执链（NO-60a） | 边缘 `POST /api/control/commands/:id/ack`（gateway_received/failed） + `POST /api/control/commands/:id/receipt`（executed/failed） → 平台台账与 `ewoh_control_result` | 投递确认与执行结果**分两条事实**（resultType=gateway_ack / command_receipt）；未投递必须给原因；重复 ack 幂等（alreadyAcked）、终态 409；机器身份走网关密钥面（不是人面 Bearer） |
| 执行机构状态链（NO-59b） | 边缘适配器统一帧（device/motion/business）→ `normalize_frame`（`FRAME_KIND_ACTUATOR`）→ 桥接上行 → `POST /api/ingest/actuator` → `ewoh_world_state.state_json.actuator` + 设备/能力登记 | 状态词表封闭（词表外拒绝并回显，不默认 idle）；缺租户/时钟漂移拒绝；record_id 幂等；位置/电量/故障/最后授权号逐帧留痕 |
| 行动项复发度量链（NO-58a） | 复盘 incident `target_id` → 行动项 `subject_type/subject_id` → `ewoh_scheduling_execution` 偏差计数（完成前后各一窗口） | 归属成对 + 封闭词表（CHECK）；无归属 = 不可度量、样本 < 3 不给结论、计数下降只作事实（≠ 因果） |

## 3. 持久化落点（权威事实源）

| 存储 | 位置 | 内容 | 权威源 |
|---|---|---|---|
| SQLite WAL（边缘） | `EWOH_DB_PATH`（默认 demo.db） | 遥测/推理/风险事件/人员/设备/调度/治理/审计 | `src/edge_platform/edge/storage.py` + migrations/v001 |
| PostgreSQL 17（云侧） | `DATABASE_URL` | 56 张表（业务+scheduler 运行时 11 张+审计哈希链） | `db/migrations/standalone_001..031` |
| better-sqlite3（飞书） | 侧车本地 | 同步缓存/事件缓冲 | `ewoh-feishu-app/server/db.js` |
| 文件/对象 | `deploy/` 卷 | 上传文件（upload 安全校验） | docs/architecture/file-storage.md |
| 内存态 | — | 影子评估、预测 provider（advisory，不激活候选） | scheduler/prediction/* |

## 3.5 边缘 ↔ 平台韧性契约（2026-09-10 收口）

现场会遇到断网、迟到、重发与时钟漂移。两侧行为**显式约定**如下（都有回归测试）：

| 现场事实 | 边缘行为 | 平台行为 | 可观测性 |
|---|---|---|---|
| 断网 / 平台不可达 | 帧进有界队列（`MAX_BUFFER`，满时丢最旧）、入队即落盘、指数退避重试；恢复后 `retarget` 原地续传（不换实例，避免订阅空窗） | —（未收到） | `sensor_uplink.health()`：`buffer`/`stats.dropped_overflow`/`stats.retried`；`/health` 暴露 |
| 网络重发（at-least-once） | 同一帧重发携带**确定性 `record_id`**（`edge:<kind>:<dev摘要>:<ts_ms>:<seq或载荷摘要>`） | 按 `(org_id, scope, record_id)` 认领：重放返回 `skipped=true` 且不写第二行 | 平台响应 `skipped`；边缘 `stats.duplicates`；库内 `record_id` 恰一行 |
| 迟到（落后 >10min） | 原样上行（不丢弃） | 写入并把 `data_quality` 降级为 `degraded`、响应带 `is_late=true`（ADR-009：标记不丢弃） | 响应 `is_late`；行内 `ts` 可核 |
| 时钟漂移（超前 >5min） | 原样上行 | **显式拒绝**：`accepted=false` + `error=CLOCK_DRIFT_FUTURE_TS`（未来时间戳会污染"最新位置/新鲜度"排序） | 边缘转 dead-letter 文件 + `stats.rejected`；平台无未来时间行 |
| 写入瞬时失败（DB/连接） | 重试同一帧（幂等安全） | 释放幂等认领并返回 `retryable=true`；重试可成功 | 响应 `retryable`；边缘 `stats.retried` |
| 永久拒绝（非法帧/租户缺失） | 转 `<queue>.dead-letter.jsonl` + 计数，不阻塞队头 | 返回 `accepted=false`（无 `retryable`） | 死信文件可人工重放（平台幂等，重放安全） |
| 设备身份登记 | 归一化帧携带物理设备 id（定位帧含 `tag_id`） | 首次摄入即登记 `ewoh_device`（类别由 kind 唯一映射；重复只更新在线/最近遥测，**不覆盖**已登记类别与型号） | 设备页/在线率；`/api/devices?category=...`；无电池设备 `battery_pct=NULL`（UI 显示"不适用"，不得写 0/100） |
| 解释与拒绝原因（现场可读） | 唯一词表 `shared/reject-reason.ts`：候选拒绝原因（`CANDIDATE_REJECT_REASONS`，运行时数组派生类型）、冲突类型、决策痕迹硬约束、调度触发码、求解器违反项 | `Record<...>` 编译期穷尽文案——**新增原因不补文案即编译失败**；词表覆盖面由单测扫描 eligibility/候选引擎/冲突服务/四套求解器源码守卫 | 未登记**码型**键显示"未登记原因（key）"并保留原码（不静默、不伪装已知）；自由文本原样展示；历史键（`device_data_unavailable`→`battery_unknown`）经别名仍可读 |
| 能力消费（调度/世界模型） | 资源视图与快照由唯一解析器 `resolveDeviceCapabilities` 合成，两条投影路径共用。**语义一分为二**：`capabilities` = **执行/交互**能力（设备"能做什么"），`observedCapabilities` = **观测**能力（设备"能看到什么"，`mode='observation'`）。合成规则：台账执行/交互能力 ∪ `ewoh_device.capabilities` 列；**列非空时为权威声明**（操作员显式登记，型号猜测不参与——型号含 `exo` 的起重机不得被补上 `exo-lift`）；列空时才用型号白名单兜底（标记 derived） | 快照 `devices[].capabilities` 供 `requiredDeviceCapabilities ⊆ capabilities` 匹配；`observedCapabilities` 与 `capabilityRecords`（含 subject/evidence）供世界模型/AI 解释；台账缺口进 `capabilityProjectionIssues`；观测能力进世界状态摘要（设备换传感器对调度可见） | 设备身份双命名空间：调度键 = `ewoh_device.id`（uuid，任务/方案引用），业务设备号 = `deviceId` 字段（边缘遥测/能力台账用它）——快照同时给出两者作为显式 join 键 |
| 执行能力的权威登记（NO-15c） | 执行类能力（`exo-lift`/`exo-lite`/`vacuum`/`crane`）登记进 `contracts/capability` knownValues（21 值），`deviceObservationFields` 为空数组（不产生观测列） | 三者一致：schema ↔ `shared/capability.ts` ↔ `src/edge_platform/contracts/capability.py`（`audit-domain-contracts` 584 项精确比对） | 由此"能做什么"的能力可被契约校验、可被人工停用/恢复；型号白名单退化为**兜底派生**（列/台账都没有时），且**人工停用优先于派生** |
| 方案级未派工解释（NO-15c） | 三套求解器（规则/MILP/启发式）的未派工条目都写平铺 `rejectReasons` + `capabilityNotes` | 冲突层 `buildPlanIssueItems` 聚合为"无法派工 · 没有合格候选资源 · 任务 X（候选拒绝：… ×N ｜ 能力：哪个能力、谁/何时/为何停用）" | 历史方案（只有嵌套 `alternatives[].reasons`）回退展开，升级不丢旧数据解释；解释**不因求解器实现路径而不同** |
| 能力的"缺失 ≠ 停用"（解释边界） | 台账读取保留**全部状态**：`names`/`records` 只收 active，`disabledNames`/`disabledLifecycle` 收人工停用事实 | 快照设备项透出 `disabledCapabilities` + 停用留痕；世界状态摘要纳入停用能力（能力变化 → 旧方案 stale） | 资格判定分流原因：所需能力**全部**被停用 → `capability_disabled`（去复核停用决定/恢复），否则 `missing_device_capability`（去查设备/加装）；候选解释附 `capabilityNotes`（哪个能力、谁/何时/为何停用）——绝不把人工决定说成设备缺陷 |
| 库存精确聚合与单位对齐（NO-29a/29b） | 库存在**数据库侧**按物料聚合全部历史流动（`sum`/`count`/`array_agg`，jsonb 字段直接聚合），不再取"最近 N 条事件"在内存里投影 | 响应新增 `aggregationComplete`/`aggregationNote`（声明覆盖全量、不截断）；BOM 行可声明 `unit`（可选，非法值入口 400）→ 影响面新增 `unit_mismatch`（库存单位 ≠ BOM 单位，或 BOM 自身多单位）**优先于缺口计算** | 隐形窗口 = 静默失真（原则 7 红线），改为精确聚合；不同单位**不比较**（把 15 kg 与 60 件相比得出的缺口是编造）；证据保留每物料最近 20 条事件 id；无法解析载荷独立计数且不受窗口影响 |
| 佩戴中的外骨骼 = 派工硬约束（NO-34a） | 资源投影并行加载 `ewoh_exo_session`（status=active，org 作用域），按 `device:<业务设备号>` 与 `ewoh_device.device_id` join → 快照设备项 `activeExoSession{sessionId,personId,startedAt}` | 候选引擎把它透传进资格判定；设备有活跃会话 → 拒绝原因 **`device_in_active_session`**（封闭词表 + 中文文案，缺文案编译失败） | 一台外骨骼物理上不能同时被两人穿戴 → **硬约束不是提示**；无会话 → null（不伪造"没人用"），终态会话不算佩戴中，形状不符的会话忽略不猜；解除方式=结束会话或把任务交给佩戴者（当前候选模型不支持指定佩戴者，因此一律拒绝并说明）；e2e 验证"进快照 → 被拒 → 结束后解除" |
| 外骨骼会话闭环的产品面（NO-33a） | `POST/GET/end/abort /api/exo/sessions`（ADR-032/033，会话绑定是显式、临时、可审计事实）→ 前端 `/exo` 作业台 | 进行中优先、同进行中按**时长最长**优先；时长口径=进行中至今/终态起止差（时间非法→未知）；**进行中 ≥4 小时**告警"核实是否忘记收工"；中止必须写理由；终态不可复开 | 平台**只管理会话绑定**，不下发关节/力矩/助力/限速指令（设备本地安全控制留在控制器）；缺设备/人员/结束人如实标"未记录"；设备与人员都必选（不猜）；e2e 抓到并修复"同设备第二活跃会话返回 500"（drizzle 事务包装错误导致 23505 漏判 → `extractPgErrorCode` 沿 cause 链取码） |
| 外骨骼会话 = 提交时刻的执行边界（NO-36a） | 派工事务内复查 `txWorld.devices[].activeExoSession`；任务创建/指派写入走 `ExoSessionService.findActiveSessionsForDevices`（`ewoh_exo_session` ⋈ `ewoh_device`，按 `'device:' || device_id` join） | 规则单点 `exo-assignment-guard.findExoAssignmentConflicts`：佩戴者本人 = 合法（人机同体）；指派别人 → `wearer_mismatch`；有会话但没指派人员 → `assignee_missing`。派工 409 `EXO_SESSION_DISPATCH_CONFLICT`（事务前 fail-fast）/ `…_TX`（事务内复查，回滚无半成品）；任务创建 409 `EXO_SESSION_ASSIGNMENT_CONFLICT`，未装配会话服务则 503 `EXO_SESSION_GUARD_UNAVAILABLE` | 候选池用**世界模型快照**预检、提交时刻用**权威会话事实**判定（TOCTOU 实测：审批期间有人戴上设备）；规则一条实现、两个事实适配器（派工走快照 `activeSessionFactsFromDevices`，任务写入走会话表直读，避免 TaskModule→SchedulerModule 反向依赖成环）；缺数据（设备号/佩戴者引用不可解析）**不据此放行**，报冲突并说明 |
| 预计 vs 实际：会话偏差进运行记忆（NO-36b） | `projectExoSessionTiming`（`shared/exo-session.ts` 纯函数）：时长、偏差、`deviationState ∈ {unknown,early,on_time,over}`（容差 ±5 分钟）、进行中 `overdue/overdueMs/remainingMs` | 会话 API 每行带 `timing`；结束事件 `evidenceJson` 写入 `expectedEndAt/actualEndAt/durationMs/deviationMs/deviationState`（可复盘/可学习）；`/exo` 作业台逐条显示"已超时 X / 距预计结束还有 Y / 超时 Z 结束 / 未记录预计结束时间（无法比较）" | 没填预计结束时间 → `deviationState=unknown` 且文案明确"无法比较"，**绝不冒充准时**（原则 7）；开始时间不可解析只影响时长，偏差仍按"预计+实际"如实给出；前端与服务端同源同一函数，避免"接口说超时、界面说准时" |
| 交接班前的责任人核对（NO-52a） | `GET /api/device-responsibilities/coverage?shiftId=…`：`summarizeResponsibilityCoverage`（共享纯函数，与提醒路由同口径）+ 无责任关系设备清单（跨表 join，注意 `ewoh_device.org_id` 是 uuid、责任表是 varchar → 显式 `::text`）；交接创建时把快照写进 `ewoh_shift_handover.responsibility_snapshot_json`（迁移 085） | 覆盖 = 本班或全天责任人（**不要求已绑定账号**——账号缺口由提醒链路回答，两处口径在 notes 写明）；他班责任人计为缺口并给出具体班次；班次未知 → `shiftUnknown=true`（不猜默认班）；缺口设备排前，可一键写进交接遗留事项（人提交） | 快照**存交接时刻**而不是回看时重算（审计问的是"当时知不知道"）；快照计算放在**嵌套事务（savepoint）**里——普通 try/catch 拦不住"事务已中止"，会连带拖垮交接插入（实测）；页面读取失败显式报错，不显示成"无人负责" |
| 数据质量"待核实提醒"：叫到人 + 判定即闭环（NO-53a） | 摄入侧开 `DataQualityAlert`（ENTITY_NOT_FOUND 等）→ `DataQualityNotificationService.sweep`（`POST /api/data-quality/gap-sweep` + worker 默认 10 分钟）扫 **open 的告警**→ 共享契约 `shared/data-quality-notification.ts`（前缀 `NTF-DQ-<告警号>-`、桶 `quality_alert`、`requiresHumanVerification` 只打扰需要人核实的码、严重度→收件角色：critical/high 加安全员）→ 责任人（复用 NO-49a/51a 班次路由）+ 角色兜底 → 确定性通知号 `ON CONFLICT DO NOTHING`；人在工作台判定 → `DataQualityService.confirm` 把判定事实与提醒终态放**同一事务**，返回 `resolvedNotificationCount` | 收件人=责任人(user, 班次感知)+角色兜底；无账号责任人进 `unresolvedResponsiblePersons`、他班责任人进 `outOfShiftResponsiblePersons`（**缺口不阻塞提醒**）；跨租户扫描经 `ewoh_open_quality_alert_orgs(interval)`（SECURITY DEFINER，迁移 086）再逐租户 GUC 事务读明细；处置码 `data_quality_confirmed` / `data_quality_contested`；confirmed 按 ADR-031 合法链 `open→acknowledged→processing→closed` 了结同源告警 | **只读业务事实**（不改告警状态、不写 evidence，只写提醒与 `data_quality.notify_sweep` 审计）；contested = **数据不可信，相关决策需复核**（告警保持 open 继续可见），不是"没事"；`read` ≠ `resolved`；缺字段/缺源事件号如实写出（不猜、不假装能确认）；投递失败在页面显式提示"不能视为已经叫到人"；同一告警的多个收件人合并展示 |
| 学习回路接线：运行记忆 → 信号 → 提案（NO-54a） | `LearningSignalService.scan`（`POST /api/learning/signals/scan`）读三类实测记忆：①`ewoh_notification` 窗口行 → **与治理页同一个**共享纯函数 `summarizeNotificationDisposition`（口径唯一）；②数据质量：open `DataQualityAlert` 数 + `NTF-DQ-%` 未处置提醒数；③`ewoh_scheduling_execution` 按 (对象, 偏差类型) 聚合复发次数 → 共享契约 `shared/learning-signal.ts` 派生信号 `SIG-<KIND>-<subject>-<window>d-<severity>` → 幂等 upsert `ewoh_learning_signal`（迁移 087，TENANT_SCOPED + RLS）；人点 `POST …/:signalId/promote`（目标值由人给）→ 创建 `ewoh_learning_proposal` → 既有影子评估 → 人审激活阶梯 | 信号 = 实测快照 + 证据引用（含时间，未知则 null）+ 样本量 + 可信度 + 方向（raise/lower/investigate）+ 假设/预期影响/风险；`confidence=null` ⟺ 样本 < 5（契约 CHECK 兜底），此时 `actionable` 必为 null 且必须写理由；重复扫描只刷新快照，`promoted/dismissed` 的人决定永不覆盖；严重度升级 → 新信号号 | **信号 ≠ 提案**：扫描不创建任何提案、不激活任何策略（原则 4/6）；**平台不替现场定数值**（只给方向，目标值由人给）；promote 前重新读取生效阈值并与扫描时基线比对，漂移 → 409（信号依据过期必须重扫）；忽略必须给理由（§33）；扫描**只读业务事实**（不改告警/偏差/提醒），只写信号与 `learning.signal_scan` 审计 |
| 经验 → 行动：改进行动项（NO-55a） | `ImprovementActionService.scan`（`POST /api/learning/actions/scan`，支持 `{retrospectiveIds}` 聚焦）读 `ewoh_retrospective`（status=published）的 `lessons_json`（severity=warning|critical）与 `assembled_json.gaps` → 共享契约 `shared/improvement-action.ts` 派生行动项 `ACT-<lesson|gap>-<复盘号>-<标题slug>` → 幂等 upsert `ewoh_improvement_action`（迁移 088，TENANT_SCOPED + RLS）；人 `accept`（负责人+期限+验收判据）/`complete`（结果说明）/`decision`（拒绝/放弃+理由）；`GET /api/learning/actions/overdue` 给接班班组长看逾期待办 | 行动项 = 来源（复盘号）+ 证据（复盘/条目/缺口，含时间）+ 建议类型（`kindSource=suggested`，人接受时可改）+ 优先级（critical→high、warning→medium）+ 责任/期限/判据/完成痕迹；info 级经验只作记忆保留（不把每条总结变成待办） | **只读复盘记录**（不改 lessons/gaps），只写行动项与 `learning.action_scan` 审计；重复扫描只刷新来源事实，责任/期限/完成/拒绝痕迹**永不覆盖**；接受/完成/拒绝的必填事实由 DB CHECK 兜底（§33 不静默作废、"做完了"必须能被别人判断）；错误顺序统一 404 → 409（状态）→ 400（缺事实） |
| 多模态感知融合（NO-56a，§5） | `PerceptionFusionService.sweep`（`POST /api/perception/fusion/sweep`）读窗口内的`ewoh_world_state` 定位行（`state_json ? 'locator'`）与相机 person 检测行（`state_json ? 'camera_id'`）、`ewoh_telemetry` 外骨骼行（`entity_id`=佩戴人）、`ewoh_spatial_entity`（工位/相机，相机坐标→覆盖工位=显式绑定）、`ewoh_production_task` 非终态任务（任务上下文）→ 共享纯函数 `fusePerception`（`shared/perception-fusion.ts`）→ 幂等 upsert `ewoh_perception_fusion`（迁移 089，快照号 `FUSE-<主体>-<窗口桶>`）| 输出：一致性（consistent/partial/conflict/insufficient）、位置/姿态/工位（各带依据）、可解释加权置信度（可用源权重和/应有源权重和；**不是概率**）、冲突明细（各源取值都保留）、被排除证据（stale/untrusted/dimension_mismatch，逐条带原因）、缺失源、五条规则留痕、`strongAdviceAllowed` | **只读感知事实**（不改 world_state/telemetry/工位/任务），只写快照与 `perception.fusion_sweep` 审计；无可用源 → `unknown`+`score=null`（不显示 0%）；坐标超半径 → 工位未知（不猜最近工位）；视觉 track 未绑定主体 → 如实计数（不按最像的人分配）；低置信/有冲突 → 上游不得生成强建议（§5 规则 5）|
| 环境多源（区域级）+ 行动项逾期提醒（NO-56b） | ①`ewoh_environment`（温度/振动/噪声/空气质量）→ 区域主体 `station:<工位>`/`area:<实体>` 的 `ambient` 通道聚合（同通道多台传感器：一致→代表值均值+极差；不一致→conflict 且代表值 null；单台→single_source）；②数据质量扫描对 >24h 未了结告警补发 `quality_aging` 桶；③`POST /api/learning/actions/overdue-sweep` + worker（30 分钟）对逾期行动项发 `NTF-ACT-…-action_overdue-…`（负责人账号经受控函数反查 + 班组长兜底），完成/放弃按前缀落 `action_completed`/`action_dropped` | 环境通道阈值（温度 35/振动 8/噪声 85/空气质量 150）只报事实并写明「由现场按规程决定」；源「应有集合」按主体类型（人员 vs 区域）判定缺失；逾期提醒收件人缺账号进 `unresolvedOwners` | action 的完成/放弃与提醒终态**同一事务**；worker 逐租户开 GUC 事务（租户清单走 `ewoh_improvement_action_orgs`，迁移 090）；aging 与 overdue 扫描均**只读业务事实**，只写提醒与审计 |
| 订单链消费面（NO-57a，§6） | `OrderChainService`（`GET /api/world/order-chains`）复用 `MaterialsService.getSnapshotFacts`（订单=未完工 ERP_ORDER 事件、物料=MRP 缺口行）**并修好投影**：`WorldSnapshotOrder.taskIds`/`remainingOperations` 现在真读`ewoh_schedule_task`（订单号=排产任务号）与 `ewoh_schedule_task_step`（未完成工序数）| 链路视图含任务/工序计数/物料缺口/逾期与**封闭缺口词表**（task_link_missing / steps_missing / material_link_missing / due_at_missing）；Operations 页面「订单链」卡片逐单显示 | 只读查询面（不写业务事实）；投影失败保持显式缺口并留痕（绝不编造任务号）；未完工订单词表 `OPEN_ORDER_STATUSES` 为唯一口径（共享常量）|
| 预计 vs 实际对账（NO-57b，§7） | `PlannedVsActualService`（`GET /api/scheduler/planned-vs-actual`）读 `ewoh_scheduling_execution`（计划/实际时间戳 + 偏差类型）→ 共享纯函数 `summarizePlannedVsActual` | 可比覆盖率、绝对偏差中位/均值/P90、超时-提前-准时计数、不可比分类（缺计划/计划为0/缺实际/未完工）、偏差类型分布、系统性倾向提示；班次工作台卡片展示 | **样本不足（可比<5）不给比率**（null+notes）；缺失不当 0；读取触顶显式说明"不是全体"；没有任何执行行时不下"数据缺失"结论 |
| 经验回流知识（NO-57c，§9） | 行动项 `complete` → `KnowledgeService.registerEntry`（scope=factory、kind=process_knowledge、证据=**规范身份** event:/task:/…）→ 条目号写回 `ewoh_improvement_action.outcome_ref`/`outcome_kind`（迁移 091）| 行动项带回流引用；知识条目可经既有知识 API 检索（tags 含 improvement_action）；页面区分"已完成且已回流"与"已完成但未回流" | 回流失败**不阻断完成**，如实记 note 且 outcome_ref 为空；没有规范证据时不造知识条目；CHECK 兜底：outcome_ref/kind 成对且仅 completed 可带 |
| 责任人的班次维度（NO-51a） | `ewoh_device_responsibility.shift_id`（空串=全天；唯一索引升级为 (org, device, responsibility, shift_id) WHERE active）+ 共享纯函数 `planResponsibilityRecipients(…, {currentShiftId})`；当前班次经 `ShiftService.resolveCurrentShift`（共享 `resolveShiftAt`）解析 | 路由语义：**本班优先 → 全天兜底 → 他班只报缺口**；每个收件人带 `matchedBy`（current_shift/all_shift/shift_unknown）；缺口进 `outOfShiftPersons`；班次未知 → 不猜默认班，按全天兜底并标注 `shiftUnknown`；页面可选班次并显示"·班次 <id>" | 只覆盖他班的责任人**不发提醒**（不叫不该当班的人），但必须报出来（原则 7）；班次域不可用不阻塞提醒；换人只影响同一班次那一条（另一班事实不被覆盖） |
| 设备责任人页面（NO-50a） | `GET /api/device-responsibilities?deviceIds=…`（批量读，避免 N+1；租户作用域来自调用者上下文）+ 既有写接口；台账页新增"责任人"列与设置面板（`client/src/pages/Devices/ResponsibilityDialog.tsx` + `responsibilityLogic.ts` 纯函数） | 已登记 → "姓名（职责）等 N 项"；**未登记 → "未登记责任人（提醒只能发到角色）"**；顶部汇总"未登记责任人的设备 N 台"；面板三职责固定顺序 + 空位保留 + 按职责收回 | 缺失显式（不留白）；解析不到姓名显示 id（不猜）；读取失败显式报错（不伪装成"未登记"）；面板写明影响面（责任人直接收到安灯/升级提醒，无绑定账号只进缺口） |
| 设备责任人 → 提醒点名到人（NO-49a） | 迁移 `standalone_083_device_responsibility`：(设备, 职责, 人) 三元组，同一设备同一职责唯一 active（部分唯一索引，换人保留历史）；`DeviceResponsibilityService` 提供读写 + **收件人解析**（责任关系 + `ewoh_find_active_users_by_person` 反查账号 → 点名到人 + 缺口清单）；云侧开灯（`OeeService.openAndon`）、边缘安灯（`ingest`）、SLA 升级（`AndonSlaService`）三处统一用它 | 收件人 = 责任人（user）+ 角色兜底；通知号含 `role\|user` + 收件人段（多收件人各自独立幂等）；无账号绑定的责任人进 `unresolvedResponsiblePersons`；换人同事务 CAS，命中 0 行 → 409；设备不在台账 → 404（不建影子设备） | **缺口不阻塞提醒**（角色照发，缺口显式列出，绝不假装通知到了）；`_created_by` 等审计列存**登录账号 id（varchar）**，不是 uuid；写权限收窄到班组长/安全员/管理员 |
| 安灯"没人接手"升级 + 重新开灯提醒（NO-48a） | `AndonSlaService.sweep`（`POST /api/oee/andons/sla-sweep` + worker）：扫 `AndonRaised`/`andon` 且 **status=open** 的事件 → 共享纯函数 `evaluateAndonSla`（>1×SLA→L1，>2×SLA→L2）→ 确定性通知号 `NTF-ANDON-<安灯>-<桶>-<role\|user>-<收件人>-<渠道>`（桶 `sla_breach_l1`/`sla_breach_l2`；L1=班组长+调度，L2 追加安全员）+ `oee.andon.sla_breach` 审计；`transitionAndon` 的 `closed→reopened` 在同事务发 `reopened` 桶提醒 | 跨租户扫描经 `ewoh_open_andon_orgs(interval)`（SECURITY DEFINER，只返回 org_id）再逐租户 GUC 事务读明细；`openedAt` 无法解析 → `undecidable`（不用"现在"当开启时间）；未记录 SLA → 默认 15 分钟并在正文说明 | **只升级未接手**（acknowledged/processing 不重复升级）；**只读业务事实**（不改状态/evidence，只写提醒与审计）；升级与开灯分桶共存（互不覆盖）；升级提醒同样随关灯进入 `andon_cleared` 终态 |
| 安灯/Agent 提醒的确定性身份与处置闭环（NO-47a） | 安灯：`NTF-ANDON-<安灯号清洗>-<桶>-<渠道>`（桶 `raised`/`sla_escalation`）+ `ON CONFLICT DO NOTHING`；`OeeService.transitionAndon` 把状态 CAS 与 `resolveNotificationsFor(tx, …)` 放同一事务（`closed` → `andon_cleared`）；Agent：`NTF-AGENT-<审批号清洗>-pending-app`，`resolveRow` 台账 CAS 与提醒终态同事务（`agent_approval_decided` / `agent_approval_expired`） | 通知号族在 `NOTIFICATION_ID_FAMILIES` 登记，并由 `test/unit/notification/notification-id-families.spec.ts` 双向门禁（源码前缀⊆族表；族样本→类型；类型→族覆盖；前缀不重叠）；共享假 DB 谓词助手 `test/helpers/drizzle-fake-matcher.ts` 对未识别形态抛错 | **`acknowledged`/`processing` 不关闭提醒**（告警仍有效）；`reopened` 不复活旧提醒（新事实重新处置）；随机 id 一律不允许（既不幂等也无法归类）；安灯与 Agent 提醒各自只关自己的（前缀 + external_ref 双限定） |
| 提醒治理与处置度量（NO-46a） | `GET /api/notifications/metrics?days=N`：服务端按**创建时间窗口**（1–365 天，默认 30）+ 与列表**同一可见性作用域**取行（2000 上限 + `truncated`）→ 共享纯函数 `summarizeNotificationDisposition` 聚合 | 输出 totals（已处置/待处理/已读未处置/投递失败）、`dispositionRate`（样本 <3 → **null**）、处置时长中位/均值（**仅可比样本**，不可比单独计数）、待办账龄（1h/8h/24h/超 24h/时间未记录）、按类型计数（id 约定分类：`session_overdue`/`telemetry_wearer_mismatch`/`approval_expiring`…，未登记 → `other`/`unknown`）、反复出现的对象 Top 5、口径 notes；前端审批控制台「提醒治理」卡片逐项展示 | 度量**不得比明细看得更多**（同作用域）；缺时间戳/时间倒流**不按 0 参与**统计；样本不足不给比率（页面"证据不足"）；零值账龄桶不渲染；类型来自确定性 id 规则、不从标题猜；读取失败明说失败且不显示 0 |
| 处置即闭环（第二类提醒：授权到期，NO-45a） | 通用 `notification-resolution.link.ts`（`resolveNotificationsFor` + `escapeLikePattern`）由外骨骼与审批两侧共用；到期扫描发现授权失效 → 关闭 `NTF-EXPR-<审批>-expiring` 桶（`approval_expired`，`resolvedBy=system:expiry-sweep`）；审批决策事务内按"同一 (entityType, entityId) 且仍挂待办提醒"的**更早审批**关闭（`approval_superseded`，`resolutionRef`=新审批号） | 处置码按主事实命名空间化（`session_*` / `approval_*`）；`expired` 桶**保持待办**（"已失效请重新申请"是待决策事实）；候选集直接从通知表反查（不按时间取"最近 N 张"）；`resolution IS NULL` 保证第一次处置依据不被覆盖；扫描结果新增 `resolved` | **LIKE 前缀必须转义**（`_`/`%` 是通配符）：不转义会误关"看起来像"的兄弟提醒（真库 e2e 用 `NO45_A` vs `NO45XA` 对照验证）；不同语义的提醒绝不一起关；只关提醒、不动审批事实（状态/时效/用量全留） |
| 处置即闭环：提醒的终态（NO-44a） | 迁移 `standalone_081_notification_resolution`：`ewoh_notification` 增加 `resolution`/`resolved_at`/`resolved_by`/`resolution_ref` + `(org_id, external_ref) WHERE status='pending'` 部分索引；`exo-session-notification-link.ts` 在**会话处置的同一事务**内按"租户 + `external_ref=会话号` + `NTF-EXO-` 前缀"把待处置提醒落到 `status='resolved'`（pending→resolved）或仅补写处置四列（read 行状态不动） | 处置码封闭：`session_ended` / `session_aborted` / `session_corrected`（更正时 `resolution_ref`=新会话号，可反查那次交接）；收工/中止/更正响应带 `resolvedNotificationCount`（关闭待办数）与 `annotatedNotificationCount`（已读补痕数），事件证据同组事实；`GET /api/notifications?status=resolved` 可查；通知中心"已处置"独立分组并显示处置人/时间/指向 | **`read` 与"已处置"互不替代**（看过 ≠ 了结）；`sent`/`failed` 是投递事实，处置不碰（否则投递失败被悄悄吞掉）；幂等路径**不返回计数**（"没发生处置" ≠ "关闭 0 条"）；未知处置码原样透出；`markRead` 不得把已处置降级成已读 |
| 按实际佩戴人更正会话（NO-43a） | `POST /api/exo/sessions/{sessionId}/correct-wearer` → `ExoSessionService.correctWearer`：单事务内 CAS 结束旧会话（写 `reason`/`endedBy`/`recordJson.correctedTo`）→ 锁设备行（与开始会话/派工同一把锁）→ 复查在飞任务边界 → 按实际佩戴人开新会话（`recordJson.correctedFrom`/`correctionReason`，继承 `task_id` 与仍在未来的 `plan_end`）→ 返回 `{corrected, fromPersonId, toPersonId, reason, ended, started}` | **交接语义而非改字段**：旧会话永久保留（谁戴过/谁核实的都可追溯），新会话是新的活跃事实；响应透出 `correctedTo`/`correctedFrom`（未经过更正的会话不返回）供审计与页面显示链路；裸人员 id 与 `person:<uuid>` 等价（ADR-006）；同人 → 400 `EXO_SESSION_WEARER_UNCHANGED`；非进行中 → 409 `EXO_SESSION_NOT_ACTIVE`；并发终结 → CAS 失败回滚；`/exo` 仅在 `wearer_mismatch` 时出现「按遥测佩戴人更正」，确认面板展示来源/时间/影响面/风险/对象 | **权限更严**：仅 `workshop_lead`/`safety_admin`/`global_admin`（更正会替**别人**建立佩戴事实，比收工敏感）；**平台不会自动调用**：遥测只是证据，人核实后才能落成事实（原则 4/5）；`activity_only`/`stale_telemetry`/`no_telemetry` 没指名别人 → **不给更正动作**（缺证据 ≠ 事实，不替人指认）；新佩戴人同样受"在飞任务"执行边界约束；设备**不会**因更正自动交回，收工仍须按常规流程结束新会话 |
| 遥测冲突进入主动提醒 + 处置动作 + 可比样本率（NO-42a） | `ExoSessionReminderService.sweep` 同时扫**时间维度**（overdue/long_running）与**证据维度**（复用 NO-41a 的 `listTelemetryConsistency`）；偏差复盘新增 `plannedCoverageRate`（可比 / 已收工） | 标签封闭：`telemetry_wearer_mismatch`（high）/ `telemetry_inactive_suspect`（medium）；`consistent`/`activity_only`/`stale_telemetry`/`no_telemetry` **不打扰**；每条标签一个确定性通知 id（幂等）；`/exo` 冲突会话提供「核实并收工」，结束理由写入校验判定与依据；卡片展示可比样本率 | 账号↔人员解析覆盖**全部活跃会话**（此前只覆盖时间桶命中者 → 刚佩戴的冲突发不到本人，实测修复）；提醒只报事实与建议动作，不代替人收工；可比样本率无样本 → null（不是 0%） |
| 佩戴事实双源校验：会话声明 × 遥测（NO-41a） | 摄入接收 `worker_id` → `ewoh_telemetry.worker_id`（standalone_080，可空 + `(org_id, device_id, ts DESC)` 索引）；`GET /api/exo/sessions/consistency` 用 `DISTINCT ON (device_id)` 取每台设备最近一帧 → 纯函数 `classifyExoTelemetryConsistency` 判定 | 六种判定：`consistent` / `wearer_mismatch`（硬冲突，需人核实）/ `activity_only`（有人在用但未上报佩戴人）/ `inactive_suspect`（疑似未佩戴）/ `stale_telemetry`（证据过期）/ `no_telemetry`（无佐证）；`/exo` 会话行逐条展示判定与理由，冲突标红 | **缺遥测 = 无佐证，不是"没有佩戴"**；证据过期不下结论；"疑似"绝不升格为事实；平台不替会话或遥测任何一方下结论 |
| 会话 ↔ 任务关联与预计结束继承（NO-40a） | `ewoh_exo_session.task_id`（standalone_079，可空 + `(org_id, task_id)` 索引，**无外键**：任务可回退、会话是既成事实）；`GET /api/exo/sessions/device-context` 返回在飞任务与可绑定建议；`POST /api/exo/sessions { taskId }` 绑定任务 | 未填 `expectedEndAt` → 继承任务 `plan_end`（来源 `task_plan_end`）；现场手填优先（来源 `operator`）；任务不存在 → 400 `task_not_found`；任务设备与会话设备不一致 → 409 `EXO_SESSION_TASK_DEVICE_MISMATCH` | 多张在飞任务**不给绑定建议**（选择是人的决定）；计划结束时间已过期/缺失 → 不继承并如实说明；`/exo` 页面默认勾选"绑定并继承"、会话行标注任务与来源——直接提升偏差复盘的可比样本率（此前实测 90 条已收工会话仅 23 条可比） |
| 会话开始的反方向边界 + 双向互斥锁（NO-39a） | 开始会话事务内：先 `SELECT ... FOR UPDATE` 锁住台账设备行（按 `device:<业务号>` 定位，org 或 NULL），再查该设备的**在飞任务**（`ewoh_production_task`，status ∈ dispatched/received/executing/paused/exception）；派工事务对本波设备行按 id 排序后同样加锁 | 规则单点 `findExoSessionStartConflicts`：受派人 = 佩戴者 → 合法（人机同体）；受派人 ≠ 佩戴者 → 409 `EXO_SESSION_TASK_CONFLICT`（消息含任务号/标题/状态/受派人/佩戴者与解决方向）；在飞任务无受派人 → 同样拒绝 | 预派发状态（draft/pending_*）**不是执行边界**（原则 6），不阻塞现场佩戴，其真被下发时由派工侧事务内复查拦住；设备不在台账则不判定（不猜不阻塞）；两方向共用同一把设备行锁 → 串行化，"任务已下发给 A + B 正在佩戴"不再可能出现 |
| 偏差复盘：预计 vs 实际 → 经验（NO-38a） | `GET /api/exo/sessions/deviation-summary`：只取**已收工**且 `started_at` 在窗口内的会话（默认 30 天，上限 2000 行 + `truncated` 标记）→ 纯函数 `summarizeExoSessionDeviations` 按设备/人员分组 | 返回 totals + groups（会话数/可比/准时/提前/超时/不可比、平均/中位偏差、最差超时）+ `minSample` + 口径 notes；`/exo` 作业台「偏差复盘」卡片按设备/人员切换展示，样本不足组标"证据不足" | 只有**同时**有预计结束与实际结束的会话才可比，缺时间戳计入不可比并在 notes 说明；可比样本 < 3 条 → `onTimeRate = null`（**绝不用 0% 冒充**）；实测本地库 62 条已收工会话中47 条不可比，系统如实说明"无证据"而不是给假比率 |
| 人机同体配对的正向说明（NO-38b） | 候选引擎在设备处于外骨骼会话且**候选人员 = 佩戴者**时生成 `sessionNotes`（设备号/会话号/开始时间 + "换人需先结束会话或改派佩戴者"） | `TaskCandidateResource.sessionNotes` → `candidateExplainVM` → 任务智能面板；拒绝侧仍是 `device_in_active_session`（他人），两侧互补 | 只解释不判定（eligible 由资格服务决定）；非佩戴者不产生该说明，避免"人人都能用这台设备"的错觉 |
| 外骨骼会话主动提醒（NO-37a） | 扫描**只读**读取活跃会话（`ewoh_exo_session`，status=active）→ `classifyExoSessionReminder`（共享纯函数：`overdue` = 超过预计结束 +15 分钟；`long_running` = 连续佩戴 ≥4 小时）→ 写 `ewoh_notification` | 收件人 = 角色 `workshop_lead` + **佩戴者本人账号**（`ewoh_user.person_id` ↔ 会话 `person_id`，经 SECURITY DEFINER 函数 `ewoh_find_active_users_by_person` 受控反查）；未绑定账号的佩戴者如实进 `unresolvedWearers`。幂等键 `NTF-EXO-<会话号>-<桶>[-user-<收件人>]-<渠道>` + `notification_id` 唯一约束；投递面 `POST /api/exo/sessions/reminder-sweep` + 定时 worker（默认 10 分钟） | 阈值/宽限与页面同源（`shared/exo-session.ts`），不会"页面说正常、通知说超时"；只提醒不改状态（不代替人收工）；终态不提醒、开始时间不可解析不猜；**后台 worker 必须逐租户开系统事务设 GUC**——否则 RLS 挡住全部行，表现为"接口正常、worker 静默 0 提醒"（2026-09-11 实测；租户清单另经受控函数 `ewoh_active_exo_session_orgs()` 获取，只返回 org_id） |
| 通知可见范围与点名到人（NO-32a） | `resolveNotificationScope`（纯函数）解析读取范围；到期扫描为每条授权写"角色 + 发起人本人"两类通知 | `GET /api/notifications`：`all`（global_admin，仍受 org 过滤）/ `role+user`（角色通知 ∪ 点名给自己）/ `user` / `none`（fail-closed）；用户级通知 id 含收件人（`NTF-EXPR-…-user-<who>-<渠道>`） | 放宽到用户级**只到调用者自己的 id**（他人通知不可见，e2e 断言不串号）；发起人缺失或为 `system` 时不写（不凭空造收件人）；角色列表去重；幂等语义与渠道规则不变 |
| 高危控制审批的时效闸门（NO-31a） | `control_request` 下发前：`findLatestForEntity('control_request', requestId)` + 共享 `verifyApprovalFreshness`（状态 approved 且通过时间在 24 小时内） | 超期或缺通过时间 → **409 `APPROVAL_INVALID`**（写明通过时刻/有效期/请重新审批）；重放防护由控制请求状态机 CAS（`pending_approval → approved` 仅一次）承担 | 控制类审批**没有能力指纹但同样有时效**（半年前的"同意"不等于现在）；授权视图 `CAPABILITY_CHANGE_ENTITY_TYPES` 扩为三类（设备恢复/任务放宽/高危控制），因此控制授权同样出现在审批台并享受到期主动提醒；前端标签 `control_request → 高危控制指令` |
| 授权到期主动提醒（NO-30a） | 扫描 `GET /api/approvals/authorizations` 的结果：剩余 ≤2h → `expiring`；过期 ≤24h → `expired` | 生成 `ewoh_notification` 行（收件人 `safety_admin`，app 恒发、lark/email 按配置），正文含剩余时间/审批号/覆盖范围/发起人/已消耗数；`POST /api/approvals/authorizations/expiry-sweep` 手动触发，定时 worker（默认 5 分钟）调用同一实现 | 幂等由 `NTF-EXPR-<审批号>-<桶>-<渠道>` 确定性 id + `notification_id` 唯一约束 + `ON CONFLICT DO NOTHING` 保证（重复扫描只增 duplicates）；离失效还远/过期太久/待批/驳回都不提醒；扫描**只读**（不改变授权状态、不代替人重新审批）；worker 逐租户失败隔离并留痕 |
| 物料需求与缺口影响面（NO-28a） | 未完工 ERP 订单事件的 `bom` + `bomBasis`（口径显式）→ `projectMaterialDemand` 聚合需求 → 与库存合并为 `buildMaterialImpact` | `GET /api/materials/inventory` 增补 `impact[]`（状态/现有量/再订货点/需求/缺口/受影响订单/逾期标记）与 `demand.{demands,unknownBasisOrders,invalidOrders}` | BOM 口径必须显式（缺省 per_unit 且**写明**在事件里，非法值 400）；口径未声明的历史订单**不参与计算**并单列；需求 > 库存 → `below_demand`（优先于 `below_threshold`）；未知库存 ≠ 0；单位不一致不合并；前端 `/materials` 页按"需要处置/无法判定"分层展示并可追溯订单号 |
| 物料流动 → 库存 → 短缺推理（NO-27a） | ERP 出站事件（`inventory_receipt`/`material_consumption`）→ `shared/material-inventory.ts` 契约解析 → 库存投影（入库累加、领用累减，零新表） | `GET /api/materials/inventory`：每物料 `onHand`/`unit`/`minThreshold`（最近声明）/`receipts`/`consumptions`/`negative`/`mixedUnits`/`evidenceIds` + `unparsable[]`；推理侧 `collectMaterialFacts` 产出 `material:<id>` 事实 | 数量缺失/非法 → 400（fail-closed），历史自由格式载荷 → 放行但标 `legacy` 且列入 `unparsable`；**多单位不求和**（拒绝 kg+件）；**无再订货点不判定短缺**（`no_threshold`），不编默认阈值；负库存如实标记（不当 0）；物料投影失败降级可见（`material_projection_failed`）且不牵连其它结论；证据用注册表内的 `event:` 身份 |
| 主数据（ERP/MES/WMS）能力导入（NO-26a） | `POST /api/master-data/capabilities/import`：外部设备能力清单 → 既有能力台账（零新表），逐行判定 | 逐行结果：`applied` / `updated` / `unchanged` / `skipped_human_disabled` / `skipped_unknown_device` / `skipped_unknown_capability`（含笔误建议）/ `skipped_contract_violation` / `skipped_missing_field`，**按输入顺序返回**；`?dryRun=1` 只预览不写库 | 来源封闭注册表 erp/mes/wms/manual_file + `sourceRef` 必填（防伪造）；词表 fail-closed；只写本租户已有设备；**人工停用永远优先**（不复活，回报谁/何时/为何）；同批次幂等 `unchanged`；超类别能力写入但提示核对；台账写 `provenance{channel,source,sourceRef,importedAt,importedBy}`；全过程审计（含预览） |
| 观测 → 推理（实时）（NO-25a） | `shared/observation-facts.ts` 纯投影：环境读数（`ewoh_environment`，最近 15 分钟、≤500 行）→ 机器类事实；世界模型列 → 资源类事实（人员负荷/电量/工位质量/未处置告警） | `POST /api/reasoning/evaluate-live`（评估 + L4 落账）与 `GET /api/reasoning/live-facts`（只读，不落账）；响应含 `evidence[]`（数值/阈值/单位/观测时间/数据质量/来源）与 `skipped[]`（原因：过期/低置信/未知对象/未声明能力/无值） | 六道闸才产出事实（有值→超阈值→新鲜→可信→可映射→**已声明观测能力**）；不合格一律进 skipped，绝不凑事实；阈值显式（振动 7.1 mm/s，ISO 10816 类 II）；温度/噪声/空气质量不产出事实（无对应已注册规则）；`snapshotVersion` 由 `worldVersion` 无符号重解释（32 位哈希可为负，负值会被推理契约 400 拒绝）；前端 `/reasoning` 区分「立即评估」（人工触发、落台账）与「查看事实」（只读） |
| 执行边界授权视图（NO-24a） | `GET /api/approvals/authorizations`：按 `evidenceJson->>'entityType'` 过滤 `device_capability_change`/`task_capability_change` 的审批实例行；消耗明细 = `event_type='approval_usage' AND causation_id = 审批号` 的事件行 | 每行给出 `status`/`approvedAt`/`expiresAt`/`expired`/`remainingMs` + 对象描述符快照（指纹）+ `usage[]`（对象键/操作人/时间/备注）；只有 approved 才有通过时间 | 已过期授权**保留并标记**（不隐藏、不仍显示有效）；排序 最快过期→有效→已过期→待批/终态；客户端审批台分五态展示（有效/即将过期 2h 内/已过期不可用/待批不可用/已驳回）并列出用量，读取失败显式报错；无新表、无新事件类型 |
| 批量恢复能力（NO-23a） | 设备页「批量恢复能力」从世界模型快照的 `disabledCapabilities` + `disabledCapabilityLifecycle` 聚合待恢复批次（无新端点、无新表） | 高风险批次：一张覆盖**选中设备名单**的审批（指纹 = 排序 `deviceIds`）+ 逐台 `POST /api/devices/:id/capabilities/:key/status`；低/中风险直接逐台恢复 | 高风险排前、同批按"停用最久优先"（避免长期停用被遗忘）；缺业务设备号的停用项单独计数（数据缺口显式）；结果如实区分全部成功/部分成功/全部失败并给出逐台原因，「失败项未消耗审批额度、可直接重试」由服务端同事务语义保证；前端不做放行判定 |
| 授权时效与消耗（NO-22a） | 审批实例投影 `approvedAt`（= 最后一步放行时刻；步骤带 `decidedAt`）；消耗记录 = `ewoh_event` 行 `event_id='approval_usage:<审批号>:<消耗键>'` | 有效期 24 小时（`CAPABILITY_APPROVAL_VALIDITY_MS`）：超期或**缺少通过时间** → 409（无法判断时效的凭证不算有效凭证）；重复使用 → 409 `APPROVAL_ALREADY_CONSUMED`（回读"谁在何时因何用过"） | 唯一性由 `ewoh_event.event_id` **唯一约束**保证（非先查后写，无竞态窗口）；消耗与业务写入**同事务**（写失败则消耗回滚，不白烧授权）；批量审批按设备逐台消耗；幂等 no-op 判定在闸门之前（重复点击不消耗）；审计增记 `approvalApprovedAt`/`approvalExpiresAt`；时效文案由 shared 单一实现供**设备抽屉与任务候选面板**共用（两处均显示剩余有效期，过期/已消耗时清空旧审批号并提示重新申请） |
| 高风险恢复的设备侧审批闸门（NO-21a/21b） | `POST /api/devices/:id/capabilities/:key/status` 的恢复分支：`deviceCapabilityChangeNeedsApproval`（目标 active + 原状态非 active + `capabilityRisk=high`） | 无审批号 → 409 `HIGH_RISK_CAPABILITY_RESTORE_REQUIRES_APPROVAL`（含 `entityType:'device_capability_change'`、`entityId:'capability:<能力名>'` 与带 `deviceIds` 指纹的审批请求）；带号 → 核对审批已通过（无未完成步骤）+ 对象为该能力 + **本设备在获批名单内**，否则 409 `APPROVAL_INVALID` | 与任务侧同一套审批模块（`APPROVAL_ROLE_POLICY.device_capability_change = ['safety_admin']`，零新表）；**一次审批可授权一批设备**（`metrics.deviceIds` 排序逗号列表逐字比对）；恢复审计带 `approvalId`；**停用是收紧，不加流程**；装配缺失（漏 import ApprovalModule）单独报 503 `APPROVAL_PORT_UNAVAILABLE`，不伪装成"审批无效"；前端对话框打开即告知、可就地发起审批并显示"还在等谁"，未通过时禁止提交（后端仍兜底） |
| 高风险放宽的审批闸门（NO-20a） | `PATCH /api/tasks/:id/requirements` 计算"被放宽的高风险能力"（去掉才算放宽；新增是收紧不拦） | 无审批号 → 409 `HIGH_RISK_CAPABILITY_RELAXATION_REQUIRES_APPROVAL`（含可照做的审批请求）；带号 → 核对审批已通过 + 对象为本任务 + **变更指纹逐字一致**，否则 409 `APPROVAL_INVALID` | 复用既有审批模块（`APPROVAL_ROLE_POLICY.task_capability_change = ['safety_admin']`，零新表）；发起人回避/管理员代安全角色沿用既有规则；审计记录 `approvalId` 与 `relaxedHighRiskCapabilities`；前端提供发起审批/检查状态/带号重试，**平台不自动放宽也不自动代发起** |
| 能力安全等级与放宽政策（NO-19a） | 契约 `capabilityRiskLevels` + `capabilityRisk`（21 项逐项定级）+ `rules.highRiskRelaxationRequiresSafetyReview`；TS spec 与 Python 常量对账 | 放宽建议带 `risk` / `requiresSafetyReview`：high → "需安全负责人确认，调度员不得单独决定"，medium → 与安全/工艺确认，未登记等级 → `risk=null` 且如实说明 | 前端建议行首标注风险与确认要求；设备抽屉每个能力显示风险徽标——**建议 ≠ 授权**：平台不替现场降低执行边界，高风险放宽必须由对应责任人决定 |
| 能力要求的反事实建议（NO-17a / NO-18b） | 零合格候选且拒绝原因含能力时，对每项设备能力要求做**反事实评估**（去掉后重跑同一 `buildCandidatePool`/资格判定） | `TaskCandidatesResponse.capabilityRelaxationSuggestions`：单项建议（按收益排序，最多 5 条）；**单项全零时继续评估能力对**（≤5 项要求、≤6 对、命中即停）并返回 `kind='combination'` + `capabilities[]`，文案写明"需同时放宽 N 项才有效"；每条都带"新增候选数 + 那些设备实际具备的能力 + 边界说明" | **只建议、不自动放宽**：任务要求不变（e2e 断言），改要求仍是人工动作并触发重排；建议里列的是"设备实际具备的能力"，供现场判断可替代性，不是等价声明 |
| 能力名笔误提示（NO-18a） | 能力名精确匹配：分隔符/大小写差异（`exo_lift` vs `exo-lift`）会让任务永远匹配不到资源 | 纯函数 `suggestSimilarCapabilityNames`（归一化分隔符与大小写 → Levenshtein → 排除精确命中的已知名） | 任务能力要求 warnings 与设备能力停用 404 给出"疑似笔误：是否指 X？"；**只提示不自动改写**（命名是现场语义） |
| 任务能力要求（人工写入口） | `POST /api/tasks`（创建即可带要求）与 `PATCH /api/tasks/:id/requirements` | 规范化：去空白/去空项/去重保序，非法形状 400（不猜不截断）；开放词表——未登记/当前无法匹配的名称允许写入但返回 `warnings`；审计 `task.create` / `task.requirements.update`；成功后发 `TASK_UPDATED` 触发重排 | 指挥地图「候选资源」面板可就地查看/修改要求（候选为空时同样可见），保存后刷新候选并显示 warnings；`TaskCandidatesResponse` 回传当前要求（与调度匹配同一来源） |
| 能力生命周期（人工纠正） | `POST /api/devices/:id/capabilities/:capabilityKey/status`（`active`/`disabled`，理由必填） | 停用写 `effective_to` 并保留台账行；恢复前按权威契约重新校验（词表外能力名 409 拒绝恢复），历史脏字段按词表自愈并在 `repairedFields` 列出；审计 `device.capability.disable|restore`；幂等（状态相同 → `changed=false`，不写库不记审计） | **人工停用优先于自动声明**：摄入 `ON CONFLICT` 不覆盖 `status`，且 `capability_value` 用 jsonb `||` 合并（刷新权威字段但不擦除 `lifecycle` 留痕）；停用后调度快照的 `observedCapabilities`/`capabilities` 立即不含该项，设备详情仍显示"已停用 + 谁/何时/为什么" |
| 能力声明（权威契约 ADR-043） | 摄入帧的类别决定能力名（`shared/device-capability.ts` 词表，已登记进 `contracts/capability` knownValues）；字段路径按**平台摄入 DTO 口径**登记（`deviceObservationFields`） | 写入前 `validateCapability` fail-closed（kind/providerType/subject/evidence 逐字段合规）；幂等写 `ewoh_device_capability`（只刷新"见过"时间与来源字段，**不复活**被人工停用的能力）；设备详情返回能力清单 | `/api/devices/:id` 的 `capabilities`（含 `registered` 标记与 `fields` 来源）；未登记类别不声明 |
| 不可归一化帧（固件字段漂移） | 写 `frame_dead_letter` 表 + `manager.dead_lettered_total` + 该设备 health `degraded` | —（不产生时也不应产生平台事实） | 边缘 `/health.frame_dead_letters`；设备 health `dead_lettered` |
| 摄入限流（429） | 退避重试，绝不丢帧也绝不转死信 | 429 + 生效限额文案 | 边缘 `stats.retried`；平台 `INGEST_RATE_LIMIT` 可配 |

配置：`EWOH_SENSOR_UPLINK_URL`（缺省回落到 `EWOH_EVENT_UPLINK_URL`）/`_KEY`/`_ORG_ID`、
`EWOH_SENSOR_UPLINK_INCLUDE_EXO`（默认 0：外骨骼走 `edge_to_spark` 专用回填通道）、
平台侧 `INGEST_RATE_LIMIT` / `INGEST_RATE_LIMIT_WINDOW_SEC`（默认 100/60s 不变——
多源机群共用一个出口 IP 时需按规模上调，否则会被 429 限流拖成队列堆积）。

## 4. 数据流治理规则

1. 模拟数据显式标记（source=simulated / isShadow），禁止混入生产 World State 投影。
2. 事件写路径必须可回放：重要状态可从事件或可审计事实重建（outbox/审计哈希链已具备）。
3. 跨运行时数据必须经过契约层映射（catalog/mappings + contracts/mapping schema），
   禁止运行时私造字段语义。
4. 断点登记（走读实测 → 收口状态）：
   - ~~非 exo 适配器帧与 insert_telemetry 契约不兼容被静默丢弃~~ **已修复（2026-09-10）**：
     新增 `edge/modeling/sensor_frames.py` 作为唯一帧→契约转换点（环境/摄像头/定位/外骨骼
     四类显式映射），不可归一化帧进 `frame_dead_letter` 表 + 计数 + health 降级；
     非外骨骼设备首次出现即 `ensure_device` 自动登记。回归见
     `tests/test_sensor_frame_contract.py`（14 例）。
   - ~~edge_to_spark 批量失效（len≥1 即刷）~~ **已修复（2026-08-19 P2）**：
     恢复 BATCH_SIZE 语义；~~断连缓冲无界~~ **本轮补齐**：多源上行桥
     （`edge/bridge/sensor_uplink.py`）以 `MAX_BUFFER` 为界、满时丢最旧并计数
     `dropped_overflow`，入队 O(1) 单行落盘、跨重启断点续传、4xx 转死信。
   - ~~边缘 query_telemetry/query_inference 全表加载~~ **已修复（EDGE-004/005）**：
     改 SQL `WHERE device_id + BETWEEN + LIMIT`，走 `idx_*_device_ts` 索引。

## 5. NO-62a/b/c（2026-09-12 第 62 轮）：执行边界在**投递路径**上 fail-closed

```
人/调度：POST /api/control/requests            （高危命令 → pending_approval）
        └─ 审批（另一身份）→ approve
        └─ POST /api/control/requests/{id}/commands
                 └─ 授权范围指纹 = fnv1a64(请求|设备|命令|审批实例|参数)  ← 下发时固化
                        ↓ 落 ewoh_control_command{auth_fingerprint, auth_verified_at}
边缘网关：GET /api/control/commands/pending?deviceId=…   （**投递前复核**）
        ├─ 复核审批：实例存在 / 已通过 / 未过期 / 租户一致 / 指纹一致
        │       └─ 不过 → 撤回（status=revoked + 原因码 + delivery_rejected 结果行 + 审计 + NTF-CTRL-*）
        │                **独立事务提交**（请求事务会因 4xx 回滚，安全决策不能跟着消失）
        └─ 通过 → 按**优先级**排序返回（stop=0 安全停机插队 → … → dispatch_task=5）+ 积压可见性
                └─ 边缘侧再排一次并核对平台顺序（不一致 → platformOrderViolation）
        ↓ 执行（回环模拟 / Modbus-TCP 真帧 / 厂商 API）
        ├─ POST /commands/{id}/ack      指纹原样回传；复核不过 → 409 + 撤回（不记成"正常投递"）
        └─ POST /commands/{id}/receipt  设备真的动了 → 回执**照记**（事实不丢）
                                        + 若此时已无有效授权 → 额外落 authorization_violation（未授权执行）违规

方案过期（NO-62c，与审批**同一实现**）：
GET /api/scheduler/plans/{planId}/staleness → {stale, changes[], externalChangeCount, selfInflictedCount}
POST /plans/{id}/approve（过期）→ 409 { error: { code: PLAN_STALE, planStaleness, replanAvailable } }
                                    ↓ 页面：摊开差异（外部变化在前）+ 一键重排（重排仍走完整审批链）
```

**数据契约要点**：`ewoh_control_command.authorization_fingerprint / authorization_verified_at /
revoked_reason / revoked_at`（迁移 093，撤回原因封闭词表 + 投递部分索引）；
`ewoh_control_result.resultType ∈ {gateway_ack, command_receipt, delivery_rejected, authorization_violation, delivery_expired}`
（`delivery_expired` = F-02 过期收敛这一事实本身，与"设备做过什么"的回执分列）。

