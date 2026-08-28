# EWOH 全仓库深度通读分析报告

> 审计方式：全量逐行通读（7 个子代理并行分域精读 + 主线核心链路亲自精读交叉验证 + P0 主张独立复核）
> 范围：src/edge_platform（Python 边缘平台）、ewoh-spark-app（NestJS + React 云控制面）、
> ewoh-feishu-app、ui/command_map、scripts/tools/db/contracts/openapi/deploy/delivery 全部源码、配置与依赖
> 基线验证：`python3.12 -m unittest discover -s src/edge_platform/tests` → **Ran 1005 tests, OK (46.3s)**；`ruff check src/` 仅 1 处测试文件未用变量
> 仓库卫生：git 仅跟踪 3195 文件 / 22.25MiB pack；node_modules、dist、demo.db 均未入库（demo.db 110MB 在本地存在但被 .gitignore 覆盖）

## 摘要（TL;DR）

**系统形态**：EWOH v0.6.0-rc4 是"边缘 + 云"双控制面平台——Python 纯标准库边缘平台（采集→推理→事件→advisory 调度，≈38.8k 行生产码）+ NestJS/React 云控制面（正式调度写/组织/RLS 多租户，≈227k 行 TS）+ 飞书 sidecar（独立，零代码耦合）+ 已归档 UI 原型。调度闭环安全红线（不写设备控制参数、人工确认、advisory-only）在代码层编码化，是全仓最扎实的设计资产。工程支撑层密度罕见（约 60 个门禁脚本、7 条 CI 流水线、68 对迁移 100% 回滚配套、29 个域契约 schema 三方消费）。

**总体质量判断**：安全默认值文化（fail-closed/默认拒绝/诚实降级）与审计整改留痕（EDGE-xxx/NEST-xxx 编号）贯穿各代码域，测试基线健康（1005 测试全绿、CI 门禁齐全）。但存在四条系统性主线问题：

1. **资源有界性缺失（长跑稳定性）**——边缘侧五处无界结构（世界模型 _history、管线/投影双 Queue、调度五内存字典、edge_to_spark 断网缓冲、多处审计 list）叠加"每帧一事务+单锁串行"的持久层，决定了边缘节点当前只能短周期重启运维；数据保留策略（EWOH_DATA_RETENTION_DAYS/PurgeExecutor/governance 四件套）全部是"有代码、无接线"的空转状态，demo.db 200k+200k 行是直接证据。
2. **并发正确性缺口（数据一致性）**——云侧 ValidationPipe 死配置（0 装饰器/148 内联 @Body）+ 整 handler 包 GUC 事务（池 20）+ dispatch 长事务；边缘侧调度服务层无锁 check-then-act + 非原子"乐观锁"；operations 域裸 read-modify-write；客户端 queryKey 污染/请求竞态/切换租户缓存串味。各域均存在"并发下丢更新/展示与状态不一致"的具体路径。
3. **协议/语义静默失真（数据正确性）**——时间戳 TEXT 双偏移族查询静默漏行、Sparkplug 负数解码失真与 degraded 粘滞、视觉反投影疑似镜像、battery 量纲双口径、契约时间解析器 10 份拷贝语义分裂——采集到消费的语义链上存在多个"不报错但数据错"的点。
4. **门禁"最后一公里"成批漏接（可信度）**——工程支撑层设计密度极高但接线靠手工复制维护，已实证成批失效：6 个迁移经 runner 不可执行、9 个 rollback 绕过守护开关、7 个 verify 断言必败、部署 Job 只装 5/68 迁移、十条防回归门禁未进任何 CI、证据聚合 fail-open 可把唯一 FAILED 洗成 ready、发布 SHA256SUMS 是占位文本，叠加 1 处真实 root 明文凭据泄露（ecs-exec.sh）。"看起来有防线"与"防线在生效"之间出现系统性裂缝。

**最优先行动**（详见第五章）：P0 六项——恢复 Spark 请求校验链、请求级事务收窄、边缘内存/背压治理、边缘持久层吞吐改造、凭据泄露处置与发布完整性、部署迁移链完整性修复；P1 七项聚焦调度域并发正确性、门禁接线、数据保留接线、dispatch/ingest、EAM 数据模型、时间戳列、HTTP 栈加固。

---

## 一、仓库构成与规模基线

| 代码域 | 技术栈 | 规模 | 角色 |
| --- | --- | --- | --- |
| `src/edge_platform` | Python 3.9+ 纯标准库 | 253 文件 / 57,848 行（其中 tests 19,047 行，生产码 ≈38.8k 行） | 边缘平台：采集→推理→事件→边缘调度→只读 API |
| `ewoh-spark-app/server` | NestJS + drizzle-orm + postgres + ioredis + highs | 55 模块 / ≈111.6k 行 TS（scheduler 模块独占 30.9k） | 云控制面：组织/租户/RLS/调度 V2/派工/审批 |
| `ewoh-spark-app/client` | React + react-query + vite | ≈115.4k 行 TS/TSX（其中 openapi.d.ts 19.5k 生成物） | Web 控制台 + Command Map 驾驶舱 + 离线移动端 |
| `ewoh-feishu-app` | Express + SQLite | 26 源文件 | 飞书轻量集成（验签 webhook + 消息） |
| `ui/command_map` | 原生 JS | ~20 文件 | 历史静态原型（非生产事实源） |
| 工程支撑 | Makefile/CI/scripts(28)/tools/db(225 SQL)/contracts(33)/openapi/deploy | — | 门禁、迁移、发布、契约 |

**双控制面架构**：Edge（Python，SQLite，advisory-only 调度）+ Cloud（NestJS，PostgreSQL，正式调度写）。
Ownership 通过 `EWOH_EDGE_SCHEDULING_WRITE` / `advisory_only` / repository readonly 三层 fail-closed 防止 split-brain（run.py:50-162, scheduler_service.py:150-165, repository.py:37-68）。

---

## 二、核心链路（主线精读结论，均带 文件:行 证据）

### 2.1 Edge 数据链（Python）
```
AdapterManager._read_loop（每适配器 1 线程，edge/manager.py:308-355）
  → storage.insert_telemetry（每帧 1 事务 + UPDATE device，edge/storage.py:339-355）
  → bus.publish(STREAM_TELEMETRY)（edge/bus.py:86-102 同步回调）
  → InferencePipeline 消费线程（inference/pipeline.py:564-605，无界 Queue 中转 :578）
      → 滑窗 40 帧/步长 20（2s 窗/1s 步 @20Hz）
      → extract_features → 模型 or 规则降级（pipeline.py:407-436）
      → unknown 六路触发（pipeline.py:205-232）
      → insert_inference（同步落库 :510）→ publish(STREAM_INFERENCE)
      → rules.on_inference → EventEngine.handle_draft（inference/events.py:162-234）
          → 开事件：insert_event + 证据窗口构建（±30s 查询 5000 条抽样 :111-159）
  → 世界模型投影 / Edge→Cloud 上行（run.py:271-332）
```

### 2.2 Edge 调度链（Python，advisory）
```
POST /api/scheduler/* → routes/scheduler.py → SchedulerService
  create_request(:387) → generate_plans(:418)
    → WorldStateService.build_snapshot（scheduler/world_state.py:72-114 全量聚合）
    → Planner(GreedyOptimizer)（scheduler/optimizer.py:127-281）k=3 影子方案
  confirm(:459) → 状态机校验（仅 pending_review 可确认 :473）→ 世界状态复核(:544-559)
    → ReservationService.reserve（scheduler/reservation.py:59-78，锁内二次校验防双预约）
    → execute(:583) → Assignment 派工 + Task 状态机同步（:813-866）
  事件 SSE：scheduler/events.py EventBus（有界队列 max_backlog）
```
关键事实：`run.py:150` 装配 `SchedulerService(audit=None)` → `_audit()` 恒 no-op（scheduler_service.py:380-383），
docstring 声称的"所有确认/驳回必须写 audit 记录"在当前装配下**不成立**（决策审计仅靠 `_record_decision` 落 schedule_decision 表）。

### 2.3 Cloud 调度链（NestJS，正式写，子代理精读验证）
```
请求 → standalone-main.ts:88-119(CORS/body 1MB) → RateLimitGuard(Redis 固定窗口)
  → AccessTokenGuard(JWT→userContext, access-token.guard.ts:47-73)
  → RolesGuard(@Roles→@FallbackRoles→类名映射三级回退, 空集默认拒绝 roles.guard.ts:24-46)
  → OrgContextInterceptor: SSE 直通；其余 handler 整体包 runInTransaction(org-context.interceptor.ts:104-108)
  → RequestDatabaseContext: statement_timeout 30s + set_config(local) 四 GUC + ALS(request-database-context.ts:110-165)
→ scheduler 闭环：trigger(冷却去抖+trigger_key 幂等 trigger.service.ts:96-160)
  → run-orchestrator(:76-130) → world-state 快照(7 表并行, 事件限 24h+500 条 world-state.service.ts:250-334)
  → constraint-loader/compile → priority-engine → eligibility(:98-510, 安全任务 stale fail-close :493-503)
  → routing(A* :35-98) → 求解器门面(solver.service.ts:73-120: CP-SAT worker(8s 超时+熔断+OFF→SHADOW→CANARY→PRODUCTION 激活阶梯)
     不可用回退 heuristic(2001 行) / 可选 MILP(HiGHS 同步 10s) / rule-based；统一目标评估)
  → plan.service persistPlan(决策投影) → approvePlan(新鲜度 assertFreshForApprove→stale 走 outbox+fire-and-forget replan :525-560
     → 审批前布局仿真 :430-486) → 资源预约(station 用 pg_advisory_xact_lock 容量计数 fail-closed, person/device 靠 EXCLUDE :88-170)
  → dispatch-coordinator 事务化派工(:84-460: 采集校验→CAS→逐分配预约→任务转移→事件)
  → outbox(全局 sequence) → SSE(2s 轮询/NOTIFY, Last-Event-ID 续传+缺口 resync, scheduler.controller.ts:594-707)
  → replan-coordinator(影响传播+风暴守卫 :60-160)
```
数据底座：schema.ts(2,639 行生成映射) ← db/migrations 136 文件链（80 表、109 条 RLS 策略走 ewoh_org_visible()、org_id uuid/varchar 双类型）；person/device 预占 EXCLUDE 硬约束；保留策略 retention.service.ts 每小时独立 owner 连接清理。

### 2.4 求解器双栈并存（架构异味）
- **栈 A（真实）**：`scheduler/cpsat/solver.py`（708 行，OR-Tools CP-SAT，routes/scheduler.py:39 `_SOLVE_EXECUTOR` max_workers=2 + 时间预算）+ worker.py（548 行）；
- **栈 B（占位）**：`scheduler/optimizer.py:306-329 CpSatOptimizer` —— solve() 直接回退 GreedyOptimizer 并打 warning，却是 `run.py:135-145` 默认装配进 SchedulerService 的对象。
两个同名"CP-SAT"语义完全不同；feature-status.yaml 声称 cpSat 已实现，对 Edge 默认链路而言是**占位回退**，文档口径存在误导风险。

---

## 三、主线亲自精读已验证的问题清单（与子代理报告合并去重）

> 交叉验证说明：本节为四条核心链路的亲自逐行精读结论；其中 R7（_append_denied 死代码）、R5（调度内存字典无界/无锁）、P1（单锁串行）、P2（每帧一事务）、M1（双 CP-SAT 栈）等均被对应域代理独立复核确认；主线曾假设的"confirm 预约 TOCTOU"经复核被排除（reserve() 锁内二次校验，reservation.py:61-65）——已从清单剔除，体现双向证伪。

### A. 性能
| # | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| P1 | edge/storage.py:286-291 | **单连接 + 单锁串行一切读写**：`self._lock` 包裹全部方法，ThreadingHTTPServer 的并发被完全串行化；WAL 的读写并发能力被应用层锁抵消 | 高 |
| P2 | edge/storage.py:339-355 + manager.py:341 | **每帧每事务**：insert_telemetry = 1 次 INSERT OR REPLACE + 1 次 UPDATE device + 每次提交；20Hz×N 设备下为提交速率瓶颈，且帧持久化失败仅重试 1 次（manager.py:339-351） | 高 |
| P3 | inference/pipeline.py:578 | **无界 Queue**：`_queue.Queue()` 无 maxsize；推理慢于采集时内存无界增长，无背压/丢弃策略/队列深度指标 | 高 |
| P4 | inference/pipeline.py:564-605 | **全设备共享单消费线程**：所有设备推理（含 insert_inference + 证据窗口查询）串行在一个 daemon 线程，慢盘/慢库直接拖垮整条推理链 | 高 |
| P5 | edge/storage.py:380-413 | **TEXT ISO 时间戳双偏移族**：ts 存本地偏移文本，窗口查询需发两条 BETWEEN（本地/UTC）再逐行 `_ts_ms` 重解析 + Python 端排序过滤；改 epoch 整数列可砍一半查询与全部重解析 | 中 |
| P6 | inference/events.py:111-159 | **开事件即查证据**：每次规则触发在推理线程上同步 query_telemetry(5000 上限)+排序+分段；规则风暴时推理延迟被证据构建放大 | 中 |
| P7 | services.py:154-238, 484 | **recommend 全量预取**：每次调用拉取全部设备全天遥测（每设备上限 20000 行）到内存；且已 deprecated 仍被白名单问答 answer()（"谁适合"）与 confirm_assignment 兜底路径调用 | 中 |
| P8 | edge/storage.py:415-424 | export_slice 硬上限 100,000 行全量进内存组装响应 | 中 |
| P9 | scheduler/world_state.py:72-114 | build_snapshot 每次全量聚合人员/设备/任务/派工/预约/200 事件；confirm 前校验（scheduler_service.py:556-559）再建一次完整快照 | 中 |
| P10 | edge/storage.py:1382-1394 | counts() 对 telemetry 等大表 COUNT(*)，供 metrics.snapshot 派生；表变大后每次快照成本线性增长 | 低 |
| P11 | edge/storage.py:698, 743, 770, 840 等 | 每次 INSERT 后再 SELECT * 回读整行（可由 RETURNING/已构造 dict 替代），审计高频路径多余一查 | 低 |

### B. 风险 / 正确性
| # | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| R1 | config.py:115 + 全库 grep | **EWOH_DATA_RETENTION_DAYS 无消费者**：storage 无按龄删除方法；governance/purge_executor.py 存在但仅被测试引用，未接入 run.py/路由/周期任务 → 遥测/审计表无界增长（demo.db 已 110MB） | 高 |
| R2 | run.py:354-378 | **世界状态仅在优雅退出时持久化**：只捕获 KeyboardInterrupt，无 SIGTERM 处理 → 容器 stop/kill 时 finally 不执行，worldstate.json 丢失（退回上次落盘） | 中 |
| R3 | scheduler/world_state.py:31-45 | `_safe_call` 吞掉 storage 全部异常返回空列表 → 数据库故障时生成"看起来合法的空世界状态"并继续出方案（fail-open）；is_stale 亦无法拦截（timestamp 是新的） | 中 |
| R4 | scheduler/repository.py:222-253 | **乐观锁非原子**：get→compare→upsert 三步无事务包裹，并发下可双写同版本（丢失更新）；只防"过期客户端"，不防并发写 | 中 |
| R5 | scheduler_service.py:143-146 | `_requests/_plans/_assignments/_feedback` 四个内存 dict **永不淘汰**（仅 reconcile 清空）且 plan 持有整份 `_world_snapshot` 引用 → 长运行进程内存缓慢无界增长；且无锁保护（HTTP 多线程写） | 中 |
| R6 | scheduler/reservation.py:142-154 | `expire_overdue` 仅测试调用：生产中过期预约 status 永远停在 active（靠 check_conflict 内 expires_at 比对兜底，语义正确但状态机腐化、list_active 返回陈旧数据） | 低 |
| R7 | inference/pipeline.py:294-299 vs 319,331 | `_append_denied`（带丢弃计数）从未被调用，consent 拒绝日志两处直接 append → `consent_denied_dropped` 恒 0，环形丢弃不可观测（与 R2-ESC-005 注释承诺不符） | 低 |
| R8 | inference/events.py:203 | `_open[(event_code, device_id)] = event_id` 覆盖旧 open 事件 id → 同码同设备重复开事件时，第一条永远无法自动收口（悬挂 open） | 低 |
| R9 | services.py:257, 283 | task_id 兜底 `TASK-HHMMSS` 秒级时间戳，同秒并发确认产生重复 ID（无唯一性保障） | 低 |
| R10 | server.py:632-639 | do_OPTIONS 不校验 Origin、不发 Allow-Origin，但返回 204 + 允许方法/头；与 CORS 策略口径不一致（宽松预检 + 严格实际请求），需确认前端跨端口场景依赖 | 低 |

### C. 可维护性 / 架构
| # | 位置 | 问题 | 严重度 |
| --- | --- | --- | --- |
| M1 | 全仓 | **双求解器栈同名并存**（见 2.4）：CpSatOptimizer 占位与 cpsat/solver.py 真实现语义冲突，认知负担与误用风险 | 中 |
| M2 | server/main.ts:13-50 | Spark 双装配路径：legacy 缺 12 模块 + 无 rate-limit 保证，仅打 warn 不阻止 → 生产误用 legacy 即静默降级 | 中（待子代理确认细节） |
| M3 | services.py:326-357 等 | 拦截式白名单（关键词 substring 匹配）+ 商业话术（"捷顺"对接线 :676-679）硬编码在代码中，属运营配置而非代码 | 低 |
| M4 | routes/registry.py:26-52 | 路由分发为有序 if 链数组，"精确路径在前"靠人工维持顺序，注释自述风险（新增参数路由遮蔽精确路由即回归） | 低 |
| M5 | run.py:165-378 | main() 380 行装配上帝函数：模式分支、适配器注册、投影、上行、调度装配全在一个函数，缺装配层抽象 | 低 |
| M6 | selfcheck.py:204-208 | 自检第 12 项"http:// 检查"是永真式（先 `html.replace("http://","")` 再断言其中不含 "http://"），仅 https:// 分支有效；CDN 引用检查实际失效 | 低 |

### D2. 量化佐证
- demo.db（本地演示库，110MB）：telemetry 200,350 行、inference 200,350 行、risk_event 4,207 行、audit_log 仅 15 行、scheduling_plan 9 行 —— 遥测/推理无保留清理的增长事实直接可见（R1）。
- `src/edge_platform/static/` 内含 `cm → ui/command_map` 符号链接：已归档原型经边缘服务 /cm 路径可达（演示便利，与"非生产事实源"定位并存）。

### D. 亮点（保持项）
- 三层调度写权 fail-closed（env → advisory_only → repository readonly），防 split-brain 设计完整（run.py:50-177）。
- request-database-context.ts：ALS + GUC + RLS 租户隔离，根句柄回落可 fail-closed（EWOH_DB_REQUIRE_TX），statement_timeout 默认 30s（NEST-516）。
- 推理契约自检 fail-closed：契约违约记录落库但不发布（pipeline.py:484-516，EDGE-108）。
- unknown 六路触发 + 真机通道子集修复（pipeline.py:57-85），诚实降级而非伪造。
- 客户端认证：refresh token 走 httpOnly cookie + 单飞刷新 + 401 重放防护（client/src/lib/http.ts）。
- 时间窗查询双偏移族修正（storage.py:380-402）与 EDGE 系列审计整改痕迹清晰、注释质量高。

---

## 四、子代理分域深读结果

### 4.1 Python edge+scheduler 域（61 文件 / 13,920 行，全量逐行）

**模块划分**：edge/ = storage(1403, 17 表唯一持久化) + manager(适配器监督) + bus(环形缓冲 pub/sub) + adapters/(ny_exo_a1 675+protocol/codec/injector、camera、environment、mes、uwb) + bridge/(edge_to_spark 394、event_uplink 373、metrics_uplink 202) + modeling/(定位融合/LiDAR/3DGS CLI) + exo_semantic/backfill/adapter_factory；scheduler/ = scheduler_service(929 闭环编排) + optimizer/constraints/candidate/scoring(求解栈) + repository/reservation/world_state/route_planner(支撑) + learning_loop/appeal/orchestrator(学习/申诉) + cpsat/(真 CP-SAT solver 708 + worker 548 + contract)。

**高严重度问题**：

| # | 位置 | 问题 |
| --- | --- | --- |
| P01 | edge/bridge/edge_to_spark.py:274-275, 248-258 | 断网缓冲 `_buffer` 无上限且**每入一帧全量重写队列文件**（O(n²) 写放大）；同仓库 event_uplink.py 已把同类问题定级 P1 并修复（JSONL 追加+有界），该文件未同步整改 |
| P02 | edge/storage.py:380-402 | 时间窗双偏移族 BETWEEN 仅覆盖 {服务器本地偏移, UTC}；适配器写入偏移可配置（默认 +08:00）——TZ 不一致/DST 历史行/多边缘汇总库场景下目标行落在文本区间外**被静默漏掉**（少行不报错） |
| P03 | scheduler/optimizer.py:203-238, 114-125 | 贪心资源冲突判定以 `task.earliest_start`（常为过去时刻）为基准 → 同一人员一次 solve 至多领 1 任务（顺延逻辑死路）；且 station_id/device_id 缺省 `""` 共享 occ 键——**无工位任务互相制造假性冲突直接进 violations** |

**中严重度问题（摘要）**：P04 SchedulerService/AppealChannel 内存注册表全程无锁、confirm/execute 为跨多行 check-then-act（多线程可双 confirm/双 execute）；P05 `_plans/_assignments/_feedback/_outcomes_map` 只增不减且 plan 挂全量 `_world_snapshot` 常驻（内存泄漏）；**P06 hydrate 不还原 `_world_snapshot`，重启后 confirm 的世界状态三重校验被静默跳过（过期方案可确认）**；P07 execute 循环无回滚（部分派工泄露后 plan 仍 approved）；P08 乐观锁 get→compare→upsert 非原子（丢失更新）；P09 snapshot_id 进程内序号重启归零 + ON CONFLICT UPDATE **静默覆写历史快照**；P10 advisory reconcile 调用的 `delete_schedule_plan` 全仓库不存在（hasattr 守卫静默 no-op，过期 advisory plan 永不清理）；P11 event_uplink 文件 I/O 在锁内（磁盘抖动拖慢采集→事件链）；P12 STATION_AUTH 硬约束空注册表 fail-open（与 SKILL fail-closed 极性相反）；P13 skills_registry 仅首次构建回写共享约束对象（新人技能变更永不生效）；P14 candidate.py 文档宣称的 P-PERF-001 三项优化一项不存在（仍 O(T×P×D) 全笛卡尔）；P15 每候选每次 calculate_route 且拓扑最近节点线性扫描 O(T×P×D×N)；P16 fixtures_generator import 不存在的模块致双编码实现漂移；P17 lidar_collector 未配准即返回 `aligned:True, error:0.0`（**虚假对齐结论上报**）；P18 申诉通道纯内存无持久化（自述审计失效）；P38 scheduler_service.py 929 行超长 + hydrate 缩进错位隐患。

**低严重度（要点）**：位置式 VALUES 全列插入与 schema 强耦合；quality_stats 裸 except 伪装故障；_read_loop 退避 sleep 不检查 stop_event；export_slice 10 万行进内存；downstream_blocking 分量读不存在的键（恒 0，防饥饿缺腿）；replan 裸字符串比较时间戳；resources.py dict 分支条件写反；bus tail/range 锁内全量拷贝；event_uplink 裸字符串 topic 违反自家契约；worker `_read_body` 负 Content-Length 可挂起线程；`_solve_cpsat` 464 行单函数 + 死表达式；reservation.expire_overdue 无生产调用方；Plan.to_dict 靠 getattr 动态属性序列化。

**亮点**：安全红线编码化（codec 拒下行帧、FORBIDDEN_WRITE_CAPABILITIES、advisory/readonly 双层守卫）；EventUplink 可靠传输（有界+O(1) 追加+原子重写+毒信封 dead-letter）；时间语义系统性防御；confirm 前三重防陈旧校验+预约反向释放；CP-SAT Worker 运行级加固（429 背压/413 上限/内存守卫/UNAVAILABLE 不冒充）。

### 4.2 Python 推理/感知/世界模型域（52 文件 / 11,225 行，全量逐行）

**模块划分**：inference/(features 特征提取、model 最近质心分类+ModelRegistry、rule_registry 规则版本化、rules 确定性规则引擎、events 事件引擎、fatigue 负荷趋势、spatial_rules 10 条空间规则 892 行、pipeline 管线、train 训练 CLI)；perception/(uwb_fusion、pose_fusion、quality、vision_adapter、ark_vision SSRF 防护)；spatial/(coordinate/entities/topology/asset_registry/multi_factory 联邦骨架)；world_model/(state_store 双时态、event_graph 因果图、prediction、projection 遥测投影、contract_store 契约校验、replay)；twin/、scenario/(metrics/comparison/simulator)、assistant/local_llm(769)、collection/、connectors/(sparkplug 纯 Python protobuf 解码 468、modbus/opcua/csvfile/webhook/runtime)。

**高严重度问题**：

| # | 位置 | 问题 |
| --- | --- | --- |
| P1 | world_model/state_store.py:70-91,184 + projection.py:283-295 | **遥测每帧 set_state 一次，`_history` 每 (entity,state_type) 无限追加无任何裁剪**；ContractWorldStore.snapshot() 每次全量遍历全部历史并整体契约校验——内存与成本随运行时间线性增长，长跑必然 OOM |

**中严重度问题（摘要）**：P2 `_append_denied` 死代码（与我主线发现交叉一致）；P3 Sparkplug field 9 负整数解码失真（32 位补码恢复式覆盖不了 int64 varint）；P4 Sparkplug inbox 满 `except queue.Full: pass` 静默丢帧且 `_dropped_messages` 从未递增（五适配器中唯一未整改）；P5 Sparkplug `self._lock` 创建后全文件未使用（会话状态并发读写）；P6 duplicate/out_of_order 标志粘滞不复位、重连不重置 last_seq → **设备一次乱序后永久 degraded**；P7 vision_adapter 反投影横向符号疑镜像（图像右侧的人投到相机左侧的系统偏差）；**P8 battery_pct 量纲 0..1(scenario) vs 0..100(inference) 双口径互斥误判**；P9 rule_registry 多版本并存时同规则每周期重复评估；P10 推理窗口按帧数触发但 `window_sec` 恒写常量 2（5Hz 设备实际 4s）；P11 EventEngine 重启后收口兜底只扫 list_events(200)，滑出即永久悬挂 open 且无日志；P13 pipeline+projection 两个无界 Queue 且消费循环无停止机制（线程不可回收）；P14 每推理窗都 `registry.active_version()` 全量读盘解析 JSON；P15 累计负荷积分规则空闲超时后 `last_ms` 不复位（恢复帧把整个空闲时长负荷一次性累入，瞬间冲高）+ `_open` 无收口；P16 SensorConflictRule 循环首行 return（max_per_call 永不生效）无去重无冷却；P17 ActionCountRule 按帧计数（2s lift 被计 40 次冲破 max_count 误报）；P18 StationDwellRule 离位不复位 `_open`（重返不告警+条目只增）；P12 dataset.py 严格/安全时间解析口径分裂（单条坏时间戳令整个导出失败）。

**低严重度（要点）**：model.mean/std 无 isfinite 校验（NaN 模型静默失效）；registry.json 非原子写（训练 CLI 崩溃面）；pipeline 0.6 复核 vs 模型 0.55 阈值口径不一致（评测与线上行为偏差）；OPC UA Bad 质量码映射 degraded 而非 invalid（不可用数据参与统计）；packet_loss ≤1 启发式换算边界歧义；fatigue ISO 字符串每样本重复解析 3-4 次 + recovery_minutes 量纲不一致魔数 0.01；train.py 静默丢样本；multi_factory 生产门禁用 assert（-O 下失效，违反仓库自家 EDGE-105/106 原则）；multi_factory/local_llm 审计 list 无上限；prediction 用本机时钟与设备 last_seen 相减（时钟混源）；五适配器生命周期样板重复 + reconnect() 恒真桩；CSV 缺时间戳静默 now_iso 冒充事件时刻；EVENT_CODE_CATALOG_TYPE 缺 4 个事件码映射；entered_event_judgment 滞后一窗；discover_manifests 单坏文件中止全部；local_llm prompt 无界拼接。

**亮点**：ts_to_ms_safe 统一时间防御体系；unknown 判定与降级链完整（永不强行归类）；训练治理闭环（防泄漏划分+只注册不自动激活+模型卡伦理边界）；ark_vision SSRF 防护链（固定 IP 直连消 DNS rebinding、逐跳重校验、跨 host 剥鉴权）；滞回+冷却事件状态机。

### 4.3 Python API/契约/横切域（58 文件 / ≈12,869 行，全量逐行）

**模块划分**：顶层 run/server(674 自研 HTTP 栈)/services/config/selfcheck/security(268 SecurityHeaders+限流+注入校验)/stubs；contracts/ 29 个"锁定投影+校验器"（envelope/identity/event_catalog/decision/world/simulation_run/reasoning_trace/state_machine_loader 等）；routes/ 13 文件（scheduler.py 629 含 SSE+进程内 CP-SAT、world、inference、replay、auth、exo、health、telemetry、andon、admin）；auth(PBKDF2 200k+内存会话)、rbac(14 动作×5 角色)、governance(consent/retention/purge/model_registry)、monitoring、policy(自研 Rego 子集)、backup、migrations、runtime(bootstrap 三态装配)、aas(AASX zip bomb 防御)。

**高严重度**：

| # | 位置 | 问题 |
| --- | --- | --- |
| C1 | server.py:660,24 | **并发模型缺陷**：ThreadingHTTPServer 每连接一线程、基类 HTTP/1.0 无 keep-alive（实测确认）、Handler 未设 timeout、无最大线程/连接数——Slowloris 慢连接可无限期占住线程与 FD；限流只限"已收到请求"的速率且仅 production 生效 |
| C2 | backup/manager.py:160-162 | **restore 先 `os.remove(db_path)` 再 copyfile**：不校验备份完整性、不清理旧 -wal/-shm、不要求停服——复制中途失败即当前库已被删且无回退；运行中残留 WAL 被错误应用到新库 |

**中严重度（摘要）**：routes/scheduler.py:243-273 `POST /api/scheduling/requests` 未捕 ReadonlyModeError 落 500（同类 create_task 均映射 403）；8 处路由层 `str(e)` 直接回传客户端（与 server 层脱敏口径冲突，exo bind 更把 SQLite 异常拼进 409）；/api/scheduler/v2/solve 假超时（`future.cancel()` 无效，CP-SAT 继续占 2-worker 池）+ 执行器队列无界；**契约域时间解析器约 10 份拷贝且 naive 时区语义分裂**（envelope/identity/world 视 naive 为 UTC，capability/decision/exo_config 经裸 `.timestamp()` 视为本地——跨契约时间比较可差一个时区）；RBAC 矩阵给 operator EXPORT_DATA=True 但 enforce_export_role 二次校验 Settings 白名单（默认 admin/safety_officer）——矩阵声明与实际生效不符；purge_executor 的 MINUTE_AGG 分级承诺"降采样后删除"但聚合从未实现（365 天后推理明细不可逆丢失）；backup JSON 副本全表 fetchall 明文落盘含 PII 无上限无轮转；/metrics 抓取路径 N+1（每设备一次 latest_telemetry）+ list_events(10000) 统计；telemetry 导出无行数上限（输入限 1MB 输出无界）；**migrations/upgrade_all 运行时从未调用（仅测试引用），治理表 DDL 与 storage.SCHEMA 双份手工维护必漂移**；**governance 四件套（Consent/Retention/Purge/ModelRegistry）均未接入真实装配链且全内存态**——"授权撤回/分层保留/模型治理"运行时实际不生效；路由参数 12+ 处手工字符串切片；全局可变状态散布（_scheduler_hook/Settings 单例/Handler._tokens/_SOLVE_EXECUTOR）。

**低严重度（要点）**：production 写请求先读 1MB body 后鉴权；do_POST 把畸形 JSON 也标 body_too_large；translate_path 不复核 realpath（Windows 反斜杠面）；登录时序侧信道（不存在用户跳过 PBKDF2 可枚举用户名）+ 反代后共享 60/min 限流配额；会话全内存重启全员登出；HEAD/OPTIONS 绕过限流；development CORS echo 任意 Origin+Credentials；世界状态仅正常退出持久化（同 R2）；PurgeExecutor 越层操作 storage._lock/_db；审计 best-effort 失败仅 print（与 180 天承诺不匹配）；validate_input 注入黑名单死代码；deprecated 的 recommend/confirm 仍被热路径调用；resolve_identity_mapping now=None 跳过时间窗校验；runtime_mode 魔法字符串散布 12+ 处且无取值校验（拼错静默当 development）；异常靠类名字符串匹配 + 仓内三个同名 ModelRegistry。

**亮点**：production fail-closed 体系完整（未映射路径默认拒绝 401、种子口令强制 env、production 无演示 token、SSE 20 连接上限+1h TTL）；契约校验 fail-closed + 稳定错误码 + bool/NaN 陷阱显式防御；路径穿越/zip bomb/SSRF 明确防御；三态装配反静默降级（stub 必须显式 ALLOW_STUB）；EDGE-xxx 整改留痕可追溯。

### 4.4 Spark NestJS 服务端（462 文件 / 111,613 行；精读 75 文件 ≈30k 行 + 49 模块结构化略读）

**模块划分**：database/(schema.ts 2,639 行 80 表生成映射 + request-database-context 租户核心)；common/（9 文件）+ shared/（20 文件：AccessTokenGuard/RolesGuard/OrgContextInterceptor/RateLimitGuard/Redis/Idempotency/AuditChain）；auth（JWT 双 token + jti 黑名单）；54 个业务模块——scheduler 58.7k 行（生产 ≈30.2k：world-state/resource-projection/eligibility/routing/heuristic 2001 行/cp-sat/milp/plan/dispatch/replan-coordinator/outbox/stream/pg-notify/policy）、operations 4.2k、work-orchestration 2.9k、ingest 2.5k、learning/scale/files/ai/mes 等各 1.5-2.3k，其余 40+ 模块 100-1.1k。

**高严重度**：

| # | 位置 | 问题 |
| --- | --- | --- |
| S1 | app.module.ts:98-101 等 | **全局 ValidationPipe 是死配置**：配置了 whitelist/forbidNonWhitelisted 但全仓 0 个 class-validator 装饰器，148 处 `@Body()` 用内联 TS 类型（运行时擦除）→ 校验链完全跳过，任意字段类型/缺参直达 service |
| S2 | shared/org-context.interceptor.ts:104-108 | **请求级事务包裹整个 handler**：求解（heuristic 秒级/HiGHS 同步 10s）、审批前仿真、AI 调用全部持有一条池连接+开启事务；池 max=20，少量并发重请求即打满连接池 |
| S3 | dispatch-coordinator.service.ts:228-399 | dispatch 单事务内 2 次全量世界状态采集 + 每任务循环 SELECT/预约/UPDATE/逐条 INSERT 事件——大方案=长事务+锁持有放大 |
| S4 | operations.service.ts:227-962 | **EAM 六类业务实体全部塞进 `ewoh_scheduler_config.configValue` 单行 JSONB**（key 前缀 eam.*）：history 数组无上限、每次转移整行重写、无外键无索引——配置表被当领域库用 |
| S5 | operations.service.ts:216-226 等 | 状态转移裸 read-modify-write（NEST-209 注释自认移除乐观锁谓词后无并发防护）——并发转移后写覆盖前写（状态+history 丢更新） |
| S6 | heuristic-scheduling-solver.ts | 上帝类 2001 行：候选枚举/锁定排除/技能预筛/评分/trace/metrics 全在一个类，调度正确性单点 |

**中严重度（摘要）**：HiGHS WASM 同步求解直接跑在事件循环上（time_limit=10s = 最坏 10s 全进程停摆，SSE 心跳全停）；ingestEventBatch 每事件 3-5 次串行 DB 往返（100 事件/批数百 RTT）；**raw_ref 幂等 SELECT-then-INSERT 且 (org_id,raw_ref) 无唯一索引** → 并发同帧重复遥测；work-orchestration 每个 GET 同步重索引整个 artifacts 目录（readdirSync 全量磁盘扫描，前端轮询下每次全扫）+ getEvidenceContent readFileSync 阻塞；world-state collectState 四表无 LIMIT 全量载入（104s 事故只收敛了事件侧，conflicts 直连无缓存仍触发全量重建，注释实测 29,405 行/次）；PlanService↔ReplanCoordinator forwardRef 循环依赖；SSE outbox 轮询定时器永不停止；scale.service.ts 1807 行 + work-orchestration 1617 行超长；**Ark API key 明文存 scheduler_config JSONB**（DB 拖库即泄露）；设备离线重排 org 回退 `EWOH_INGEST_ORG_ID` 环境变量（隐式租户常量）；retention 自建 owner 连接池绕过 RLS（不受 statement_timeout/监控治理）；scheduler-query.service 注入 13 依赖 + @Optional 内存回退双实现语义；固定窗口限流 2x 突刺 + Redis 回退实例数靠手工配置；角色判定回退控制器类名字符串映射（重命名即静默改权限）；org_id uuid↔varchar 类型漂移长期挂账（schema.ts 注释自认）。

**低严重度（要点）**：legacy 缺 12 模块仅 warn（配错 env 静默降容）；幂等并发等待 100ms 轮询 DB 占连接；冷启动全对 A* 预计算；legacy generatePlans 兼容入口触发全量重算；Execution 建档同步重试 3×500ms 阻塞审批响应；SSE 绕过 GUC 靠应用层过滤（新增 @Sse 易遗漏）；导出 store 缺 token 静默落 InMemory；审计与业务写非同事务；系统后台流触发键退化共享 `ALL` 前缀；DERIVED station 派生造数；4+ 套轮询机制并存。

**亮点**：租户隔离纵深防御成体系（ALS+4 GUC+109 条 RLS 策略+应用层双保险+NEST-504 fail-closed+systemGlobalAdminTransaction）；NEST/ADR/R2 编号就地留痕可溯源；outbox 全局 sequence+SSE Last-Event-ID 续传+缺口 resync+死信台账的可靠事件底座；求解器工程化（插拔阶梯+CP-SAT 激活门+熔断+响应形状校验+统一目标评估器）；默认拒绝文化贯彻（空角色拒绝/ingest key 未配置 503/station 预约锁失败 fail-closed）。



### 4.5 ewoh-feishu-app + ui/command_map（已返回）

**定位澄清**：feishu-app 是独立 sidecar（与 src/edge_platform、ewoh-spark-app **零代码级引用**，双向 grep 无命中），SQLite 为本地事实源，经 lark-cli 子进程与飞书多维表格双向同步；ui/command_map 为已归档原型（对话 8765 边缘 API）。

**问题清单（16+4 条，摘要关键项）**：

| 编号 | 严重度 | 位置 | 问题 |
| --- | --- | --- | --- |
| F1 | 高 | security.js:170-181, webhook.js:27-31 | **webhook 与飞书真实推送协议不兼容**：无 `{encrypt}` 密文 AES 解密分支、无 url_verification challenge 回显；encrypt_key 仅当签名盐用。真实飞书推送（配置 Encrypt Key 或不配置）都会被 401 全拒——当前验签只对本地构造的明文请求有效，测试即此形态，未经真实联调 |
| F2 | 高 | sync.js:484-495 | **遥测重复写入无水位**：30s 全量同步固定重发"最近 100 条"遥测（5s 批量通道已发过），无游标去重 → 飞书表最多每天重复追加 28.8 万行 |
| F3 | 中 | security.js:45-48 | 重放防线单点在内存 Set（重启清零），且防重放键(header.event_id)与幂等键(value.event_id)不同键空间 |
| F4 | 中 | webhook.js:98-111 | escalate 副作用顺序缺陷：先 createApproval 再 handleEvent，失败回滚 dedup 后重试必然重复创建飞书审批实例 |
| F5 | 中 | db.js:45,278 | telemetry 索引 (device_id,ts) 与 `ORDER BY ts DESC LIMIT 100` 全量同步/列表查询不匹配 → 全表扫描；COUNT(*) 随表线性变慢；无保留策略（模拟器 25.9 万行/天） |
| F6 | 中 | api.js:152,183 | **无真实数据入口**：/api 仅 2 个 POST（事件处置/班次报告），不存在遥测/设备采集端点，sidecar 数据面断头 |
| F7 | 中 | security.js:56-79 | 密钥可从 feishu-config.json 回退读取落盘，与 README"env 注入不落盘"承诺矛盾 |
| F11/F13 | 低 | webhook.js:53-54, 60-118 | 缺参返回 200 {ok:false}；dedup INSERT 与处置非同事务，崩溃后 processing 记录永久挡重试 |
| P1 | 中 | ui/scenario-panel.js:140-151 | 原型调度确认 actor 为自报文本框/硬编码 'operator'，无身份校验——误用为生产即"自报工号即可确认调度" |

**亮点**：六层验签纵深（常量时间比较+fail-closed+时间窗+rawBody 签名+重放窗口+DB 幂等）；lark-cli 调用工程化（20s 超时/并发信号量/熔断/有界重试）；单一事实源防漂移纪律（FS-017 漂移测试断言）；诚实健康探针；原型归档边界清晰（"生产模式空数据不静默填充样本"）。



### 4.6 工程支撑层（配置/脚本/DB/契约/部署：484 文件 / ≈137k 行，全量走读）

**规模**：根配置 10 文件；.github/workflows 7 条流水线 2,212 行（全 SHA 固定）；scripts/ 75 个 16,738 行（32 门禁审计 + 6 TCK + 6 truth 族 + 6 DDL + 6 运行时门禁 shell）；tools/ 19 个非 fixture 文件（work-indexer 1,010 行被 CI 与运行时共用）；db/ 215 文件（68 对迁移 100% 回滚配套 + runner 1,522 行）；contracts/ 91 文件（7 状态机 + envelope/AsyncAPI 目录 65 事件类型 + 29 域 schema + 双语言 test-vectors）；openapi/ewoh.yaml 18,700 行（319 paths/376 schemas）；deploy/ 36 文件；docs/ 432 文件。

**高严重度**：

| # | 位置 | 问题 |
| --- | --- | --- |
| F1 | scripts/ecs-exec.sh:4-6 | **root 明文口令硬编码 + 固定公网 IP + 禁用主机密钥校验**；.gitignore:71 已知悉却仅靠忽略清单，未轮换未清历史 |
| F2 | db/runner/run_migrations.js:286-775 | **063-068 六个迁移经 runner 完全不可执行**（漏加 EXECUTE_COMMANDS，门禁 exit(2)）；CI 正在调用其中两个，必挂 |
| F3 | run_migrations.js:231-477,791 | 9 个可执行 rollback 不在 ROLLBACK_COMMANDS 守护清单——`EWOH_ALLOW_DESTRUCTIVE_ROLLBACK` 双开关被架空 |
| F4 | db/verify/standalone_058..068 等 | 7 个 verify 断言必然失败（缺尾行 SELECT 1 AS okField / 列名错位），当前被 F2 的不可达性掩盖 |
| F5 | verify-backup-restore.mjs:101-115,186-188 | **备份/恢复运行时门禁结构性不可通过**：migrate target 硬编码、source 库无表即 seed——CI 双库真实运行也从未绿过 |
| F6 | helm/k8s/compose migration-job | **部署物迁移链严重不完整**：helm Job 仅 apply 001..005（缺 62 个迁移——调度 V2 全部表/RLS/域台账）；完整性检查只查 3 张表，无法发现 |
| F7 | release/…/SHA256SUMS.txt | 发布与交付完整性声明双双失效：release 校验文件全文是字面占位；delivery 清单 5/35 哈希 FAILED、24/64 未覆盖 |
| F8 | security.yml:119-131 | SBOM 校验步每次必失败：产物由另一 workflow 生成且无 artifact 传递，仓库中该文件不存在 |
| F9 | contracts/artifact-schemas/ | 全组 9 个 artifact schema + validate/loadAjv **全仓零引用的死契约**，README 却声称 single source of truth |
| F10 | semantic-rules/rules.js:490,493 | error 级 OpenAPI 计数漂移门禁双 dead read（读错 state 布局 + 解析器不支持缩进键）→ 实测漂移 401 vs 253 返回 0 findings |
| F11 | truth-manifest.js:51-59 | 证据聚合 **fail-open**：解析失败仅 warn 跳过；唯一 FAILED 记录损坏即 ProductionReady 翻绿，--check 不拦截 |

**中严重度（摘要）**：十条防回归主线门禁（租户隔离/SSRF/XSS/演示残留/事务边界等）**未接入任何 CI**，8 个 audit-* 脚本 CI 完全不跑（F12）；truth-gate 发布漂移三处弱化（opt-in exit 0 / mandatory 字段从未被写入 / 不校验 commitSha 旧记录可计入）；三道门禁把 runtime/admin 口令写进 output/*-report.json 且 `rsync output/` 打进发布产物；"Lockfile 有效性校验"步骤 `\|\| echo` 吞退出码恒过；许可证扫描 `--allow-unknown` 放行 unknown/strong-copyleft；soak 门禁把 4xx 计为成功（token 失效/404 全过）；backup restore 计数守卫恒真（ON CONFLICT 冲突行也照加）；k8s 清单浮动 `:latest` 违反自家版本固定纪律；四个安全审计白名单启发式有逃逸面（`orgId` 字样放行/`Boolean(` 整行放行/safe* 前缀豁免/弱口令不扫 server 面——实证 ai.controller.ts 存在 `|| 'admin123'` 回退而门禁免疫）；schema-manifest 漏登 2 表+061-068 零登记；RLS NULL 放行语义同库两代裁决并存（025 fail-open vs 057 移除 vs 067 又加回）；豁免体系过期豁免继续生效/bandit path 缺省全仓库豁免；Work Graph 门禁 env 可指任意工件副本+approver 同仓自注册自批；route-manifest 594≠401 双计 GET 活缺陷；交付包"技术规范"是 V0.5 Demo 世系（78 行 spec/23 张 SQLite 表）被当权威对外交付；architecture/current-state.md 内嵌统计过期（31 迁移 vs 实 68）。

**低严重度（要点）**：根 compose 自认 DEPRECATED 仍保留 sleep 占位服务+postgres:16 与全仓 17 不一致+挂载不存在的 nginx.conf/certs（与主线部署面发现一致）；根 package.json vestigial（npm 非法大写名、唯一依赖已停用）；OpenAPI 错误响应用文字键非状态码（1283 处）+info.version 双轨；两个同号 ADR-004 不同题；迁移 033/055 缺号无台账；severity 阶梯 4 份手拷贝且顺序相反、15 类 agentRole 两份逐字硬拷贝、learning 注册表硬编码进 migration CHECK。

**亮点**：契约即代码纵深（29 域 schema+共享 vectors 三方消费、OpenAPI controller 双向零漂移、env 交叉校验）；迁移工程纪律（68/68 回滚配套幂等、apply→verify→rollback→re-apply 反复演练、口令全程 env 注入 SQL 仅占位符）；CI 诚实失败文化（全部 SHA 固定+自检守护、BLOCKED≠FAIL 区分、perf 门禁硬失败）；Work Graph 工具链自洽自测（14 语义规则配 13 fixture 含防 vacuous pass）；运行时门禁全真环境（kind 集群全链 install→迁移→坏镜像回滚→canary、多租户 RLS 负向断言、双实例 CAS 真实 PG17）。

**总体判断**：设计水准显著高于同类仓库，但存在系统性模式——**门禁的"最后一公里"接线与守护清单靠手工复制维护，已出现成批漏接**（runner 6 处注册漏 18 命令、9 个 rollback 绕过守护、7 个 verify 必败、十条防回归门禁未进 CI、部署 Job 只装 5/68 迁移），叠加证据聚合 fail-open 与 1 处真实凭据泄露，构成当前最高优先级整改面之一。



### 4.7 Spark React 客户端（614 文件 / ≈115.4k 行；手写 473 文件 ≈79k 行 100% 精读）

**规模与形态**：React 19.2 + react-query 5 + zustand 5，strict TS，生产码约 0 处 any/@ts-ignore；测试 138 文件 15.7k 行（含 contractFidelity/leakAudit/a11yAudit/perfBudget 元测试）。31 页面族：CommandMap（壳 1176 + 底图 1263 + 27 面板 + 12 类调度图层 + 13 纯函数 VM + zustand 6-slice）、Operations（1143，8 tab 30 查询）、MobileWorkbench（离线优先 IndexedDB 队列）、WorkOrchestration/RoleWorkbench/Scale/System 等；lib/ 约 60 文件（离线工程 5 件套、http/auth、errorContract、sessionSecurity、observability、swCache、perfBudget、a11y）。

**高严重度**：

| # | 位置 | 问题 |
| --- | --- | --- |
| U1 | Devices.tsx:86 vs DeviceConfigDrawer.tsx:245 | 同一 queryKey `spatialEntities` 挂两个不同 queryFn（全量 vs type=person 过滤）——缓存互相污染，打开换绑抽屉后父列表可能拿到"只剩人员"的实体数组 |
| U2 | AiBrainPanel.tsx:209 | 方案操作成功后 invalidate 裸字符串 `['schedule-plans']`，真实 key 是 `queryKeys.schedulerActivePlans`——采纳/执行/取消后列表与地图永不刷新，只能等 30s 轮询 |
| U3 | SchedulePanel.tsx:560（OverridePanel/PlanComparePanel 同构） | 预览/对比请求无竞态守卫：慢的旧 promise 后到覆盖新结果——决策类 UI 展示与输入不一致 |
| U4 | resumableUpload.ts:173-175 | 分片上传不检查返回值：`{ok:false}` 的失败分片照样 finalize，残缺文件被当成功 |
| U5 | code-block-shiki.tsx:60-64 | `styles.join()` 逗号连接两段 CSS 声明非法被浏览器丢弃 → 暗色模式代码块 token 颜色全部失效 |
| U6 | commandMapStore.ts:232 → Shell:757 → MapViewport:192 | SSE 每次突发 → Shell 级订阅全量重渲 → overlay JSX 内联重建（未 memo）→ memo(FactoryMap) 的 overlay prop 恒变、memo 永不命中——整张 1263 行底图随每次突发重渲染 |
| U7 | SchedulerLayers.tsx:45 + entityColors.ts:24 | 图层 pointOf/着色对 persons/devices/stations 线性 find 且逐实体调用 → O(实体²)；spatialPointIndex 已有索引但这两条路径未用；叠加层还不接收 visibleBounds（剔除只覆盖底图） |
| U8 | MapViewport.tsx:195 等 10+ 处 | 调度叠加层整体 `pointerEvents="none" aria-hidden="true"`：逐 marker 的 `<title>` 鼠标永远到不了、屏幕阅读器不可见——冲突/偏差关键信息的唯一文本通道被自己关掉 |

**中严重度（摘要）**：Operations 8 路轮询不感知 tab/visibility + TopBar 每秒时钟重渲整栏；行内操作无 pending 防重（连点并发 mutation）；设备换绑三步非原子无回滚；门禁决策弹窗 reason 被 `void reason` 丢弃（TODO）+四处处置原因硬编码——审计链失真；offlineConflict 数组比较走引用相等（IDB 克隆永不等→冲突假阳性）；Devices/WorkbenchList/Scheduling 搜索无防抖直驱请求；queryKeys 调度族不带 org 维度（切租户命中上一组织缓存）；**viewer 角色缺失于 navigation.ts ALL_ROLES（types 权威源 7 角色）→只读访客全域 Forbidden**；initSessionSecurity 未传 onIdleTimeout（空闲锁屏永不触发）+offlineCrypto SensitiveCipher 零调用（离线数据明文）——两个安全机制设计了未接线；useOfflineWorkbench 每挂载 openDB 不 close；runtimeLifecycle scope 永久累积+StrictMode 下二次挂载复用已 dispose 的 scope（资源登记静默 no-op）；WorkGraphPanel wheel/pointer/ResizeObserver 三处生命周期缺陷；导出任务轮询无上限不清理；AI 流式问答无 AbortController；CSV 导出无公式注入防护（=+-@ 前缀）；富文本上传绕过 uploadGuard+失败空 catch+window.open 无 noopener；business-ui 第二套上传栈仅扩展名黑名单（不含 .html/.svg）→存储型 XSS 面；streamdown img src 未过 sanitizeUrl；双 API 栈并存（@lark-apaas toolkit 无 Bearer/单飞刷新/统一错误语义）；observability 埋点大面积零调用（可观测性仅 SSE 内部指标真实生效）；6 个超大组件合计 6400+ 行；formatTime 11 处实现+3 处硬编码时区+三套表单体系；conflict 虚拟列表固定行高展开错位；mark-toolbar asChild 内 div 失键盘语义；上传回填后撤销致 blob: 裂图；compressImageFile ImageBitmap 不 close；checksum 整文件读入内存叠加峰值；Login 直显后端 err.message 绕过 errorContract；SSE parseSseBlock 单行 data 假定+plan.* 批内无去重重复拉取。

**低严重度（要点）**：裸 queryKey 逃逸+约 20 处硬编码轮询魔法数；executionSync 断言密集 as-cast 消费；perfBudget shellRenderMs 预算 15s 恒 PASS；16 个重依赖未使用（已 tree-shake）；swCache 无字节预算；88 个 CDN 占位图 URL 零 import。

**亮点**：零 any 类型纪律+OpenAPI 双契约生成直连；认证/RBAC 成熟（httpOnly refresh+内存 access+单飞刷新+fail-closed 导航）；离线工程完整度罕见（idempotencyKey+退避+Retry-After+Web Locks 单 leader+原子事务+配额 TTL+泄漏审计断言）；SSE 内核纯函数化可测；138 测试文件含元测试四件套；StateFamily 四态统一。

---

## 五、优先级优化任务清单（按影响范围×收益从高到低）

> 排序依据：影响面（核心链路覆盖度/数据正确性/安全面）× 收益 × 实施成本。P0=立即排期，P1=近期，P2=中期，P3=打包清理。
> 状态：**最终版**——七个域全部合并，编号按插入序，同级内即优先序。

### P0-1 Spark：恢复请求校验链（安全，全 API 面）
- **现状**：全局 ValidationPipe 配置 whitelist/forbidNonWhitelisted，但全仓 0 个 class-validator 装饰器；148 处 `@Body()` 用内联 TS 类型（运行时擦除）→ 校验链死配置，任意字段类型/缺参直达 service（app.module.ts:98-101、scheduler.controller.ts:571、organization.service.ts:28）。
- **目标**：全部写路径建立 class-validator DTO（优先 admin/审批/派工/ingest/配置面）；e2e 断言未知字段 400。
- **收益**：关闭最大一类注入/脏数据入口；148 个端点输入契约从注释变代码；OpenAPI 文档真实性兜底。

### P0-2 Spark：请求级事务收窄（性能，全 API 容量上限）
- **现状**：OrgContextInterceptor 把整个 handler 包进 GUC 事务（org-context.interceptor.ts:104-108）——求解（HiGHS 同步 10s）、审批前仿真、AI 调用全程持池连接（max=20），少量并发重请求即打满连接池。
- **目标**：GUC 事务收窄到 DB 访问段（写路径强制、纯读短事务）；求解/仿真/AI 移出事务；HiGHS 移入 worker_threads（连带消除 10s 级事件循环阻塞，milp-scheduling-solver.ts:44-55）。
- **收益**：连接池利用率数量级改善；消除全局停摆；SSE 心跳与普通请求互不拖累。

### P0-3 Edge：世界模型/管线内存与背压治理（稳定性，长跑 OOM 根因）
- **现状**：① StateStore._history 每 (entity,state_type) 无限追加、snapshot() 全量遍历校验（state_store.py:70-91）——20Hz×设备数下必然 OOM；② pipeline/projection 两个无界 Queue、消费线程不可停止（pipeline.py:576-581、projection.py:114-129）；③ 全设备共享单推理消费线程，落库+证据构建在热路径。
- **目标**：history 条数/时长上限+归档；Queue maxsize+丢弃计数指标；消费循环停止机制；证据窗构建异步化。
- **收益**：边缘节点可无人值守长跑；规则风暴/慢盘下内存有界、延迟可控；队列深度/丢弃率可观测。

### P0-4 Edge：持久层吞吐改造（性能，Edge 全部读写链路）
- **现状**：单连接+单锁串行一切读写（storage.py:286-291）；每帧遥测=1 事务+1 UPDATE（:339-355）；推理记录同步落库在单消费线程。
- **目标**：读写连接分离（WAL）、遥测微批提交（100ms/100 条）、推理记录批量落库。
- **收益**：采集/推理吞吐提升 1-2 个数量级；慢 I/O 不阻塞 API 线程；支撑更多设备接入。

### P0-5 工程支撑层：凭据泄露处置与发布完整性（安全，最高紧急度之一）
- **现状**：① scripts/ecs-exec.sh:4-6 root 明文口令硬编码+固定公网 IP+禁用主机密钥校验（.gitignore:71 已知悉但未轮换未清历史）；② release/…/SHA256SUMS.txt 全文是字面 "placeholder checksums" 而 manifest 宣称指向它、delivery 清单 5/35 哈希 FAILED+24/64 未覆盖；③ 三道运行时门禁把 runtime/admin 口令写进 output/*-report.json，package-release.sh:53 `rsync -a output/` 将其打进发布产物。
- **目标**：立即轮换 ECS 口令并清 git 全历史、改 SSH 密钥注入；用实物重生成两处 SHA256SUMS 并加 `shasum -c` CI 门禁；报告只记口令指纹、发布打包白名单化 output/。
- **收益**：关闭唯一的真实凭据泄露面；发布完整性声明重新可信；演练凭据不随包外流。

### P0-6 工程支撑层：部署迁移链完整性修复（部署正确性）
- **现状**：helm/k8s/compose 的迁移 Job 仅 apply 001..005（缺 standalone_006..068 共 62 个迁移——调度 V2 全部表/RLS/域台账），CI 数据完整性检查只查 3 张表无法发现（helm migration-job.yaml:30-38）；同时 runner 的 063-068 命令漏注册 EXECUTE_COMMANDS 完全不可执行、9 个 rollback 绕过 DESTRUCTIVE 守护、7 个 verify 断言必败（run_migrations.js:286-791）。
- **目标**：部署 Job 改为消费 runner 导出的完整迁移序列；runner 改目录扫描+命名约定自动注册（消灭 6 处手工同步）；补 EXECUTE/ROLLBACK 清单与 7 个 verify 尾行断言；完整性检查对齐 schema-manifest 全表清单。
- **收益**：helm 部署出的库从"缺 62 个迁移"变完整可用；CI 从两步必挂/门禁表演变真实红绿；回滚守护双开关恢复意义。

### P1-5 Edge：调度域并发与数据正确性加固包（风险，advisory/仿真链数据可信度）
- **现状**：六项叠加——内存注册表无锁可双 confirm/双 execute（scheduler_service.py:143-146）；乐观锁非原子丢更新（repository.py:228-236）；hydrate 不还原 `_world_snapshot` 致重启后过期方案可确认（:551-553）；execute 无回滚（:598-625）；snapshot_id 重启归零静默覆写历史快照（world_state.py:64-70）；内存五字典只增不减。
- **目标**：服务层锁覆盖"状态检查+写入"；乐观锁改单语句 `UPDATE...WHERE version=?` 判 rowcount；hydrate 缺快照 fail-closed；execute 内存构建→单事务落库；snapshot_id 加随机分量；终态方案迁出内存。
- **收益**：并发下调度数据一致；重启后防陈旧校验真实生效；长运行内存有界。

### P1-6 工程支撑层：门禁"最后一公里"接线修复（CI 可信度）
- **现状**：① 十条防回归主线门禁（租户隔离/SSRF/XSS/演示残留/事务边界等）未接入任何 CI，8 个 audit-* 脚本 CI 完全不跑（Makefile:50-71，workflows 零引用）；② truth-manifest 聚合 fail-open——坏 gate 记录仅 warn 跳过，唯一 FAILED 记录损坏即 ProductionReady 翻绿（truth-manifest.js:51-59）；③ security.yml SBOM 校验必失败（产物在另一 workflow 生成、无 artifact 传递）；④ truth-gate 三处弱化（opt-in exit 0/mandatory 字段从未被写入/不校验 commitSha）；⑤ 备份恢复门禁结构性不可通过（verify-backup-restore.mjs:101-115,186-188 migrate 目标硬编码）。
- **目标**：test.yml 增加 `make audit-regression-gates` 步骤；聚合端解析失败按 NOT_RUN 计数>0 即非零退出；SBOM 校验前同 workflow 生成或下载 artifact；truth-gate 补 commitSha 一致性校验与 mandatory 登记字段；备份门禁迁移目标参数化+source 前置断言。
- **收益**：约 60 个门禁脚本从"纸面防线"变真实运行防线；证据链不可被坏记录洗白；CI 信号可信。

### P1-7 Edge：数据保留与治理接线（风险，磁盘/合规长期劣化）
- **现状**：EWOH_DATA_RETENTION_DAYS 无消费者（config.py:115）；PurgeExecutor 仅测试引用；governance 四件套未接入装配链且全内存态（dependencies.py:72-102）；migrations/upgrade_all 运行时从不执行、治理表 DDL 双份维护（migrations/__init__.py:54-84）；MINUTE_AGG 承诺降采样却直接删明细（purge_executor.py:125-126）。demo.db 已 200k+200k 行 110MB。
- **目标**：run.py 装配周期清理（先摘除或实现 MINUTE_AGG 聚合）；init_db 统一调 upgrade_all；consent/retention 持久化落表。
- **收益**：消除无界增长与 PII 无限留存；保留策略/授权撤回变运行时事实；DDL 单一事实源。

### P1-8 Spark：dispatch 长事务与 ingest 幂等硬后盾（性能+风险，派工/接入链）
- **现状**：dispatch 单事务内 2 次全量世界状态采集+每任务循环 SELECT/预约/UPDATE/逐条 INSERT（dispatch-coordinator.service.ts:228-399）；raw_ref 幂等 SELECT-then-INSERT 且无唯一索引→并发重复遥测（ingest.service.ts:156-179、1090-1109）。
- **目标**：新鲜度校验移事务前、事件/任务批量写、采集与 CAS 解耦；(org_id, raw_ref) 唯一索引+ON CONFLICT。
- **收益**：派工延迟与锁持有可控；数据层硬保证幂等（应用层判重失效时仍正确）。

### P1-9 Spark：operations 域数据模型与并发修复（风险，EAM 数据丢失）
- **现状**：EAM 六类实体存 scheduler_config JSONB 单行（history 无上限、整行重写、无外键索引，operations.service.ts:227-962）；状态转移裸 read-modify-write 无并发防护（NEST-209 自认移除乐观锁）→并发转移丢更新。
- **目标**：EAM 独立领域表+history 拆事件表；转移改条件 UPDATE/版本列。
- **收益**：资产/维保数据不再静默丢失；统计查询走索引而非全行 JSON 解析。

### P1-10 Edge：数据正确性三修复（风险，静默数据缺失）
- **现状**：① 时间窗双偏移族 BETWEEN 只覆盖 {本地,UTC}，其它偏移族静默漏行（storage.py:380-402）；② edge_to_spark 断网缓冲无上限+每帧全量重写文件 O(n²)（edge_to_spark.py:248-275；event_uplink 已有正确范式未同步）；③ 贪心求解器冲突判定以 earliest_start 为基准+空 station_id 共享 occ 键→每人至多 1 任务+假性冲突（optimizer.py:203-238）。
- **目标**：ts 加 epoch 整数列（双写迁移）；edge_to_spark 对齐 event_uplink（有界+追加写+周期压实）；冲突判定改顺延后 planned_start、occ 只登记非空资源。
- **收益**：窗口查询不漏数据（审计/回放/证据窗完整性）；断网续传可用；影子方案质量可信。

### P1-11 Edge：HTTP 栈并发模型加固（安全，Slowloris/资源耗尽）
- **现状**：ThreadingHTTPServer 每连接一线程、HTTP/1.0 无 keep-alive、Handler 无 timeout、无最大连接数（server.py:660,24）；限流仅 production 且 60/min 硬编码、HEAD 绕过。
- **目标**：Handler.timeout+daemon_threads+有界线程池/连接信号量；限流阈值 env 可配、覆盖 HEAD；或文档强制生产前置反代。
- **收益**：边缘单机服务 DoS 面收敛；限流行为可预期。

### P2-11 Spark：热点读路径缓存与同步 I/O 消除（性能）
- **现状**：work-orchestration 每个 GET 同步重索引整个 artifacts 目录+readFileSync 读证据（work-orchestration.service.ts:248-444）；world-state collectState 四表无 LIMIT 全量载入、conflicts 直连无缓存（注释实测 29,405 行/次、曾拖到 104s，world-state.service.ts:256-311、scheduler-query.service.ts:730-880）；SSE outbox 轮询永不停止。
- **目标**：索引 mtime 缓存+TTL；collectState 按视界过滤/路由图版本缓存；conflicts 复用 30s context 缓存；轮询引用计数。
- **收益**：读接口 P99 从秒级回常量级；消除空转负载。

### P2-12 Edge：数据语义与协议修复包（风险，采集面正确性）
- **现状**：Sparkplug 负整数解码失真（field 9 补码恢复式只覆盖 32 位，sparkplug.py:192-195）+ `_lock` 从未使用 + degraded 标志粘滞不复位 + inbox 满静默丢帧（:410-468）；vision 反投影横向符号疑镜像（vision_adapter.py:120-127）；battery_pct 量纲 0..1/0..100 跨模块分裂（scenario/metrics.py:159 vs rules.py:257）；规则多版本重复评估/按帧计数误报/多处 `_open` 不复位（rule_registry.py:63、spatial_rules.py:349,553,864）。
- **目标**：逐项修复+补协议测试（负数/重连/镜像标定用例）；battery 量纲写入遥测契约；规则注册新版本自动禁用旧版本、动作计数改转变沿。
- **收益**：采集数据源头正确；误报率下降；跨模块指标可比。

### P2-13 双向安全收尾包（安全）
- **现状**：Ark API key 明文存 DB JSONB（ark.service.ts:152-168）；ai.controller.ts:20 存在 `|| 'admin123'` 默认回退且四个安全审计脚本的白名单启发式对其免疫（audit 弱口令不扫 server 面）；路由层 8 处 `str(e)` 外溢+ReadonlyModeError 落 500（routes/scheduler.py:243-273 等）；导出权限双轨冲突（rbac/permissions.py:106 vs routes/auth.py:64-67）；登录时序侧信道（auth/identity.py:154-160）；backup restore 先删库后拷贝无校验（backup/manager.py:160-162）；Spark SSE 绕过 GUC 无强制 org 过滤装饰器（org-context.interceptor.ts:88-101）；角色判定回退控制器类名映射（roles.guard.ts:28-37）。
- **目标**：密钥入 KMS/env 引用；错误码收敛+日志分流；导出权限单一事实源；恒时登录；restore 改临时文件+verify+原子 rename；SseTenantGuard 强制声明 org 过滤。
- **收益**：拖库不泄密钥；错误信息不泄内部；备份恢复可信赖；权限矩阵不再有隐藏旁路。

### P2-14 架构治理项（可维护性）
- **现状**：双求解器栈同名异义（CpSatOptimizer 占位 vs cpsat/solver.py 真实现）；Spark legacy 装配缺 12 模块仅 warn（main.ts:32-36）；契约时间解析器约 10 份拷贝且 naive 时区语义分裂（contracts/*）；封闭注册表 Python/JSON Schema/TS 三源手抄仅 entity_model 有生成区；heuristic-solver 2001 行/scale.service 1807 行/scheduler_service.py 929 行上帝类；Plan↔ReplanCoordinator forwardRef 循环依赖；scheduler-query 13 依赖+内存回退双实现。
- **目标**：占位重命名/删除+feature-status 修正；legacy 设下线表或 fail-fast；时间解析收敛单一实现+注册表生成化（扩 GEN 块）；上帝类按域拆分；循环依赖抽端口解耦。
- **收益**：认知负担与回归面下降；文档口径与代码一致；演进成本降低。

### P2-15 集成层修复包（Feishu/工具）
- **现状**：feishu webhook 无 `{encrypt}` 解密分支与 challenge 回显（真实推送必 401）+ 遥测同步无水位（日均最多 28.8 万重复行）+ escalate 先建审批后处置的重放副作用（security.js:170-181、sync.js:484-495、webhook.js:98-111）；lidar_collector 未配准即返回 aligned:True（虚假上报，lidar_collector.py:56-65）；fixtures_generator import 不存在模块致双编码实现漂移（fixtures_generator.py:54-65）。
- **目标**：补协议分支+真实联调；同步水位游标；副作用顺序调整；未实现路径如实返回 aligned:False。
- **收益**：飞书集成真正可用；多维表格数据洁净；注册链路上报可信。

### P2-16 客户端：正确性与渲染性能修复包（React 控制面可信度）
- **现状**：① 同一 queryKey 双 queryFn 缓存污染（Devices.tsx:86 vs DeviceConfigDrawer.tsx:245）；② 方案操作后 invalidate 裸字符串 key 与真实 key 不匹配——采纳/执行/取消后列表与地图永不刷新（AiBrainPanel.tsx:209）；③ 三处预览/对比请求无竞态守卫（决策 UI 展示与输入不一致）；④ SSE 每次突发全量重渲 1263 行底图（store slice 换引用+overlay 未 memo，memo 永不命中）+图层着色 O(实体²)（索引已存在未用）；⑤ 分片上传不检查失败结果即 finalize；⑥ 调度叠加层 aria-hidden 关掉全部 `<title>`（a11y 唯一文本通道）；⑦ viewer 角色缺失于导航注册表→只读访客全域 Forbidden；⑧ sessionSecurity 空闲锁屏/offlineCrypto 加密两机制未接线；⑨ 门禁决策 reason 被 `void reason` 丢弃、处置原因硬编码——审计链失真；⑩ Login 直出后端 err.message；CSV 公式注入；富文本上传绕过守卫。
- **目标**：queryKey 规范（单一 key 单一 fn+org 维度统一）；invalidate 改 queryKeys 常量；请求序号/AbortController 守卫；store 窄订阅+overlay useMemo+索引 Map 化；上传结果校验；a11y 修复；ALL_ROLES 从权威源派生；接线 onIdleTimeout/SensitiveCipher；reason 随 mutation 上报。
- **收益**：决策 UI 展示与真实状态一致（操作员信任基础）；地图交互在实体数百规模下保持 60fps；只读访客可用；审计链真实；安全机制从摆设变生效。

### P3-17 杂项清理（低优先级打包，≤1 天/项）
**Edge/横切**：services.py 商业话术出码（:676-679）；selfcheck.py:204-208 永真断言；pipeline `_append_denied` 接线（:294-299）；EventEngine 悬挂 open 事件兜底精确检索+告警（events.py:207-216）；task_id 秒级时间戳去重（services.py:257）；reservation.expire_overdue 接周期任务（reservation.py:142）；delete_schedule_plan 缺失显式化（scheduler_service.py:198-200）；priority downstream_blocking 恒 0 修复（priority.py:90）；route_planner 速度常量统一（:182）；bus tail/range 临界区收窄；worker 负 Content-Length 校验（worker.py:383-387）；multi_factory assert→raise（:443-445）；candidate P-PERF-001 文档与实现对齐；storage 位置式 INSERT 改显式列名；4+ 套轮询机制统一 outbox+LISTEN/NOTIFY。
**支撑层**：soak 门禁 4xx 计成功改 2xx+阈值；"Lockfile 校验" `\|\| echo` 吞码移除；许可证扫描去 `--allow-unknown`；k8s `:latest` 钉版本；schema-manifest 补漏登 2 表+061-068 notes；route-manifest GET 双计修复；artifact-schemas 死契约接线或降级标注；counts-generative 双 dead read 修复+真实 fixture；package-release.sh 版本改读 version.json；根 compose 占位服务归档+PG16→17；根 package.json 处置；delivery 02_技术规范 标注 V0.5 世系；两个 ADR-004 换号；迁移 033/055 缺号台账。
**客户端**：约 20 处轮询魔法数收敛 queryConfig；perfBudget shellRenderMs 15s 恒 PASS 预算修正；16 个未用依赖移除；swCache 字节预算；formatTime 11 处收敛 lib/format.ts；三套表单体系统一；streamdown img src 走 sanitizeUrl；scanner Enter 空缓冲不吞事件；ImageBitmap close/撤销裂图修复；observability 埋点接线 http 拦截器或删减。
