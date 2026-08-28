# EWOH 平台全量代码深度审计与优化路线图

> 审计日期：2026-08-28　｜　代码基线：`main` @ `c77895f`
> 审计方式：三路并行深度通读（架构层 / 代码层 / 测试与风险层）+ 交叉验证
> 所有结论附 `文件:行号` 证据；无法证实的标注「未验证」。**本次审计未修改任何源码。**

---

## 一、执行摘要

### 1.1 代码规模实测

| 部分 | 文件 | 行数 | 说明 |
|---|---:|---:|---|
| `ewoh-spark-app/server` | 462 | 111,449 | NestJS，**53 个模块**（非 38） |
| `ewoh-spark-app/client` | 613 | 115,352 | React（含 19,505 行自动生成类型） |
| `ewoh-spark-app/shared` | 55 | 10,548 | 域模型契约 |
| `src/edge_platform` | 253 | 57,848 | Python 边缘平台 |
| `db/` + `contracts/` | 208 + 89 | — | 66 组迁移（全部配 rollback）/ 91 契约 |
| **合计** | — | **约 30 万行** | 测试 289 文件（后端 151 spec + 前端 138 test） |

### 1.2 七条核心结论

1. **调度派工存在两套并行实现**——`gamification` 模块内独立重写了派工全流程（`gamification.service.ts:537-620`），与 `scheduler.controller.ts:383` 形成同一状态跃迁的双实现，冲突检测逻辑不同。此前所有历史审计报告均未记录。
2. **求解器是 4 个而非 2 个**，且回退语义三套不一致：MILP 与 rule-based **无兜底**，配置命中即生产直接失败而非降级（`solver.service.ts:258-261`）。
3. **Python 侧 `scheduler/` 是重复实现而非合理分层**——决定性证据是云重连时边缘方案被**逐条 delete**（`scheduler_service.py:193-222`），不存在回流中心的通道。
4. **`dashboard/overview` 缓存是单槽变量不是 Map**，多租户下命中率趋近 0。历史实测中"未命中 0.799s"并非异常路径，**它才是常态路径**（`dashboard.service.ts:83`）。
5. **测试工程的真问题不是"没写"，而是"写了没接门禁"**：后端 2250 用例 + 前端 1173 用例均全绿，但前端测试无任何 workflow 调用，等于不在发布门禁内。
6. **生产环境模拟器未关**：105,269 条事件中 105,255 条为 simulated，真实告警仅个位数——告警体系实质失效，这是 `eventCritical` 计数异常增长的根因。
7. **数据架构健康度明显好于代码架构**：80 张表、66 组迁移全部配 rollback、RLS 角色模型正确（`NOBYPASSRLS`）。技术债集中在代码层与治理层。

### 1.3 一句话判断

> 这是一个工程质量**高于同类项目平均水平**的系统（跨运行时契约仲裁、E2E 绝不静默 SKIP、CP-SAT 与 advisory 边界守得扎实、289 个测试文件全绿），但它的债务是**隐性的**——不体现在 TODO 标记（全仓仅 4 个）或测试失败上，而沉淀在**双实现、死抽象、未接门禁、单槽缓存**这些"能跑但错了"的地方。

---

## 二、模块划分与依赖拓扑

### 2.1 耦合十字路口

| 维度 | 模块 | 数值 | 证据 |
|---|---|---:|---|
| 入度最高 | **shared** | 被 **52/53** 模块依赖，226 次 import | 全量 import 解析（跨模块共 304 条） |
| 出度最高 | **scheduler** | 依赖 5 个模块，**70 次**对外 import | 同上 |

### 2.2 循环依赖：20 条环，最小割点是 `shared`

`shared` 作为基础设施层却反向 import 业务层的 `observability`（`shared.module.ts:12`）与 `auth`（`access-token.guard.ts:10`），而全系统 52 个模块又 import `shared`，导致 **20 条环中 15 条经过它**。

| 环 | 严重度 | 证据 |
|---|---|---|
| `scheduler → ai → scheduler` | 🔴 含 Nest Module 级环 | `scheduler.module.ts:2` ↔ `ai.service.ts:17` |
| `shared → observability → shared` | 🔴 | `shared.module.ts:12`，经 scheduler（60 次）回流 |
| `shared → auth → shared` | 🟡 | `access-token.guard.ts:10` |
| 其余 17 条 | 🟡 | 均为「`shared → observability → X → shared`」形态 |

**影响**：无法对任何单模块做独立编译/测试/部署；`shared` 的任何改动都是全系统回归面。

### 2.3 职责重叠与命名混淆

| 混淆对 | 判定 | 证据 |
|---|---|---|
| `work-orchestration` | 🔴 **严重误命名**——名称指向制造工单域，实为 AI 智能体研发交付编排 | `work-orchestration.service.ts:36-60`（WorkItem/wave/agents） |
| `world` / `world-cursor` / `scheduler/world-state.service` | 🔴 **三处世界状态实现** | `world.controller.ts:11`；`world-cursor.controller.ts:16`；`scheduler/world-state.service.ts`（1072 行） |
| `task` / `workorder` / `work-orchestration` | 🟡 三者分属制造任务、工单、研发编排三个不同域，名称极易误导 | 见上 |
| `simulation` vs `simulator` | ⚠️ 前者只读查询、后者运行时控制，职责可辨但命名混淆 | `simulation.controller.ts:39`；`simulator.controller.ts:14` |
| `operations` | 🟡 单模块承载 4 类无关关注点（资产/角色工作台/导出/危险动作） | `operations.controller.ts` |

---

## 三、核心链路

### 3.1 调度主链路

```
POST /api/scheduler/runs
  → SchedulerRunOrchestrator.createRun()        scheduler-run-orchestrator.service.ts:75
  → TriggerService.evaluate()                   :89   触发评估 + 冷却去重
  → WorldStateSnapshotService.buildSnapshot()   :94   🔴 同步阻塞，请求线程内全量构建
  → ConstraintLoaderService.loadGlobalActive()  :98-101 🔴 缺失时静默降级为空约束，无告警
  → SolverService.solveVariants()               :125  三变体 Promise.all 并行（3× CPU）
  → 求解器选型 4 选 1                            :253/262/387-415 🔴 回退语义三套不一致
  → PlanService 落库 + Outbox 写事件
  → 审批 :373  →  派工 :383  →  执行反馈 :288  →  重排 :390
```

**链路上的单点与无补偿**：

| 问题 | 位置 | 说明 |
|---|---|---|
| 同步阻塞 | `world-state.service.ts` @ `:94` | 全量快照构建在 HTTP 请求线程内；连接池 max=20 时少量请求即可打满 |
| 静默降级 | `scheduler-run-orchestrator.service.ts:98-101` | `constraintLoader` 为 undefined 时返回空约束，**人工 LOCK 约束可能丢失且无任何告警** |
| 双路径审批 | `:373` approvePlan vs `:194` confirmPlan | legacy 与 V2 并存 |
| **双实现派工** | `:383` vs `gamification.controller.ts:41` | 见 §4.1 |
| 无补偿 | 求解成功但落库失败 | 未见显式补偿代码（**未验证**） |

### 3.2 实时推送链路：2 秒轮询，且绕过 RLS

| 事实 | 证据 |
|---|---|
| 全仓仅 **1 个** SSE 端点、**0 个** WebSocket | `scheduler.controller.ts:594`；`@WebSocketGateway` 零命中 |
| 底层是 **2 秒轮询 outbox 表** | `scheduler-stream.service.ts:10` `POLL_INTERVAL_MS=2000`、`:11` `POLL_BATCH=500` |
| 低延迟优化 LISTEN/NOTIFY **默认关闭** | `:25` `SCHEDULER_STREAM_NOTIFY_LISTENER` |
| 🔴 **SSE 绕过 RLS** | `org-context.interceptor.ts:99-101` 显式 return `next.handle()` 不进入事务，租户隔离完全依赖应用层内存过滤 |
| 🟡 单实例假设 | `lastSequence` 为进程内存态（`:50`），多副本水平扩展语义未定义 |

### 3.3 数据摄取链路

7 个入口统一收敛到 `IngestService`（1357 行，全仓第 5 大文件），双鉴权面（`ingest.guard.ts` 与全局 `AccessTokenGuard` 并行）。链路风险：`fireDeviceOfflineReplan`（`:1235`）为 **fire-and-forget**，重排触发无重试无补偿，失败即静默丢失。

### 3.4 边缘协同链路（NestJS ↔ Python）

双向 HTTP：边缘→中心 `edge/bridge/event_uplink.py:86`；中心→边缘 `cp-sat-scheduling-solver.ts:129` → `routes/scheduler.py:21-23`。
**分层破损点**：Python 侧自行暴露了与中心同构的调度 API 面（`routes/scheduler.py:9` 含 `/api/assignments/{id}/start|pause|complete|cancel|override`），形成**两个平行的调度 API 面**。

---

## 四、架构薄弱环节

### 4.1 🔴 调度派工两套并行实现（本轮最严重发现）

| | 正统路径 | 旁路路径 |
|---|---|---|
| 端点 | `scheduler.controller.ts:383` | `gamification.controller.ts:41-48` |
| 实现 | `SchedulerService.dispatchPlanV2()` | `gamificationService.dispatchPlan()` @ `gamification.service.ts:537-620` |
| 方案校验 | 调度域统一 | 自行 `select from ewohSchedulePlan`（`:544-548`） |
| 冲突检测 | 调度域统一 | **自行实现**（`:562-567`） |
| 状态落库 | 调度域统一 | 自行 update → `dispatched`（`:616-617`） |

**影响**：同一方案走 A 路径派工成功、走 B 路径报冲突；B 路径位于积分模块，**其授权/审计/限流面与调度域是否对齐从未被验证**；修复调度逻辑需改两处，漏改即行为分叉。

### 4.2 🔴 四求解器并存，回退语义三套不一致

| 求解器 | 行数 | 选型条件 | 回退 |
|---|---:|---|---|
| Heuristic | 2000 | **缺省兜底** | — |
| CP-SAT (Python ortools) | 925 | 策略 `cpSat.activation` 阶梯 | ✅ 有回退 + canary 归 0（`solver.service.ts:494-508`） |
| Rule-based | 354 | `solverVersion === RULE_BASED`（`:253`） | ❌ **无回退** |
| MILP (HiGHS WASM) | 659 | `solverVersion === MILP`（`:258`） | ❌ **无回退**，注释自认"不隐式回退"（`:259-261`） |

**风险**：策略配成 `milp-v1` 而 HiGHS WASM 加载失败时，生产链路**直接失败而非降级**。且四者在 `objectiveEvaluator` 缺省时各自 `new` 一个（`:123`、`:129`），存在评估语义漂移。

### 4.3 🔴 Python `scheduler/` 为被冻结的重复实现

两套完整、独立、可各自闭环的调度栈——领域模型、候选生成、贪心优化、评分、预约冲突、重排、世界状态、HTTP API、持久化**全面重复**。

**决定性证据（反证法）**：若为"边缘离线求解 vs 中心编排"的合理分层，边缘解必须有回流中心的路径。但实测 `scheduler_service.py:193-222`：advisory 模式下云重连时遍历 `list_plans()` **逐条 delete**。一个没有回流通道、重连即销毁的求解栈，只能是被冻结的第二套实现。

**代价**：Python 侧 6,812 行（scheduler 域）+ 19,047 行测试，维护一条永不上线的路径。潜在 split-brain 风险：`EWOH_EDGE_SCHEDULING_WRITE=1` 时 Edge 获得完整写权限（`run.py:118-124`）。

**建议保留**：`cpsat/`（唯一真实价值，是 NestJS 通过 HTTP 调用的 CP-SAT worker，属单一实现的客户端/服务端两侧）。

### 4.4 🟡 RLS 与租户隔离

| 问题 | 证据 | 影响 |
|---|---|---|
| RLS 覆盖 84.3%（86/102 表） | **5 张含 `org_id` 的表无 RLS**：`ewoh_scheduling_execution`/`_conflict`/`_kpi`/`_route_cost_matrix`/`_policy_activation`，且不在 `standalone_057:36-46` 已登记偏差名单内 | 跨租户泄漏风险 |
| 根句柄回落**仅告警** | `request-database-context.ts:44-58` 无 GUC 无 RLS 直连，默认只 `console.warn`；`EWOH_DB_REQUIRE_TX=1` 才 fail-closed 但**默认关闭**；全仓 `FORCE ROW LEVEL SECURITY` **零命中** | 新增代码绕过拦截器即静默丢失租户隔离 |
| 租户隔离 E2E 只覆盖 **1/102 表** | `org-rls-guc.e2e.spec.ts:64` | 守卫形同虚设 |
| org 作用域谓词**至少 5 处各自实现** | `world-state:78`、`scheduling-policy:527`、`mes:265`、`scale:172`、`dashboard:129-131` | 租户隔离逻辑重复实现，后果是安全性的 |

> **历史印证**：`standalone_025` 曾修复 `standalone_023` 的 GUC 名不一致（当时导致"过滤掉全部 org 行"），说明该链路确实缺自动化校验。

### 4.5 🟡 双入口与迁移治理

- **双入口**：legacy 装配 28 模块（`app.module.ts:50-96`），standalone 装配 48 模块（`standalone-app.module.ts:67-123`）。legacy 少 12+ 模块、缺 `TracingInterceptor`/`FilesModule`/`HealthModule`，且**默认已禁用**（`main.ts:48-53`）。
- **迁移断号**：`standalone_033`、`standalone_055` 缺失（目录实测 `032 → 034`、`054 → 056`），使"已应用到第几版"无法从文件系统判断。

---

## 五、性能瓶颈

### 5.1 P0-1 启发式求解器 O(T²×S×D)

`heuristic-scheduling-solver.ts:601`(任务) → `:951`(工位) → `:992`(人员) → `:1007`(设备) 四重嵌套。最内层 `:1048/1063/1079` 三次 `.some()` 线性扫描的是**随求解推进单调增长**的已预订槽位数组（每接受一个分配就 push，`:1280/1286/1293`）。

- T=1000, S=20, D=50 ≈ **3×10⁹ 次操作**
- 雪上加霜：`:685-711` 三个槽位索引在任务循环**体内**每次迭代从全数组重建，额外 O(T²)
- 这是 `conflicts` 接口曾实测 **104s** 的根因区（`world-state.service.ts:48-59` 有事故注释）

### 5.2 P0-2 ★ overview 缓存是单槽变量，多租户命中率趋近 0

`dashboard.service.ts:83`：`overviewCache: {...} | null = null`——**不是 Map，只能装 1 条**；命中条件 `:124` 比对 orgKey，任何 org 请求都覆盖上一条。

**这解开了历史数据的矛盾**：单租户压测很漂亮（缓存命中 0.07~0.17s），但生产多 org 交替访问时**命中率趋近 0**，"未命中 0.799s"根本不是异常路径，**它才是常态路径**。

对照：`scheduling-policy.service.ts:165` 用的就是正确的 `Map`——只有这里用了单槽，属实现不一致而非设计取舍。

### 5.3 P0-3 未命中路径缺复合索引 + 谓词位置错误

`dashboard.service.ts:134-174` 的 4 个聚合查询（已并行，历史优化生效）全部全表扫描：

- `:144,:147` 把 `status='open'` 写在 **`FILTER` 子句而非 `WHERE`** → 即使建复合索引也无法 index-only scan，PG 必须读出该 org 全部事件行（实测 29,405 行/次）
- `:156-159` 遥测聚合 `where org_id=? and ts>=now()-1h` 只有 `org_id` 单列索引，而遥测是**写入量最高**的表
- 现有迁移 `:1409/:1421/:1451` 全是单列 `org_id`，无 `(org_id,ts)`/`(org_id,status)`/`(org_id,online)`

> **冷启动 6.444s** = 缓存空 + shared_buffers 未预热 + 首次建连 + 4 个大表冷读。与"连接池 10→20 只改善 5.4%"一致：**瓶颈在扫描量，不在等连接**。

### 5.4 其余性能项

| # | 问题 | 证据 | 级 |
|---|---|---|---|
| P1-4 | 3 个高频预览接口误用**持久化** `buildSnapshot`，每次写完整世界状态进 JSONB；而 `buildSnapshotReadOnly`（`world-state.service.ts:105`）已存在却只有 2 处使用 | `override-preview:59`、`replan-preview:47`、`conflict-preview:75` | P1 |
| P1-5 | policy 30s 缓存的写入方未失效（`invalidateActiveRowCache` 仅 2 处调用，遗漏 `policy-activation.service.ts:285/299/418/430`、`shadow-policy.service.ts:91`）→ 策略激活后最长 30s 读到旧策略；进程内 Map 无跨实例通道 | `scheduling-policy.service.ts:534-560` | P1 |
| P1-6 | 列表接口 slim 化覆盖不全（仅 2 处），新增列表接口未强制走 slim = 历史 50MB 事故复发面 | `scheduler-query.service.ts:256,296` | P1 |
| P2-7 | `resourceProjection`（`world-state.service.ts:345`）在 `Promise.all` 之后串行，入参仅 ctx 可安全并入 | — | P2 |
| P2-8 | 78 个 env 无 schema 校验；`Number(process.env.DB_POOL_MAX \|\| 20)` 遇错变 NaN | `standalone.provider.ts:16` | P2 |

### 5.5 ★ 交叉发现：缓存问题的真正根因

`A3` 核查发现生产依赖中 **`@nestjs/cache-manager` 与 `cache-manager` 零引用**——装了成熟的缓存抽象却完全没用，于是各处手写缓存：`dashboard.service.ts:83` 手写单槽变量（多租户命中率→0）、`scheduling-policy.service.ts:165` 手写进程内 Map（无跨实例失效通道）。

> **P0-2 那个 10 行 bug 的根源，就是「有缓存抽象但没被采用」。** 现状（装了不用 + 手写且有 bug）是最差组合。

### 5.6 已核查为「已修复」的历史债（避免重复投入）

以下均在本次审计中被证实已闭环，不应再作为遗留债处理：

- **双 SSE**：已在 `SchedulerRealtimeProvider.tsx:38` 收敛为单条，`SchedulePanel.tsx` 零 stream 引用
- **事务内 LLM/网络调用**：18 个事务体扫描**零命中**
- **事件表全量拉取**：`world-state.service.ts:291-300` 已加 `open + 24h + limit 500`
- **`is_shadow` 与 status 不同步**：R2-SSV-03 已事务原子化 + DB CHECK 兜底，**且有测试把守**
- **trigger cooldown 无 entityId**：已实体感知化（`trigger.service.ts:73` triggerKey 含 entityId、`:92` 按 entityId 过滤）+ `.onConflictDoNothing`（`:123`）原子去重
- **CP-SAT 超时链路**：端到端正确——server 8s `AbortController`（`:130,685`，finally `:722`）→ worker `min(120s, timeLimitMs)`（`worker.py:255`）

---

## 六、可维护性问题

### 6.1 上帝文件拆分建议

> **已排除自动生成文件**：`database/schema.ts`(2639)、`client/src/types/openapi.d.ts`(19505)、`types/work-orchestration.d.ts`(1470) 均有 do not edit 头 + `openapi:no-drift` 门禁，**不计入可维护性债**。

| 文件 | 行数 | 拆分方案 | 风险 |
|---|---:|---|---|
| **`scale.service.ts`** | 1807 | 抽 `RegistryStore<T>` 泛型基类（4 组近乎同构的注册表 CRUD，`451-750`）可减 300~400 行；再切 `scale-fleet.service.ts`（`994-1246`）、`scale-sanitize.ts`（`1246-1357` 五个脱敏纯函数，安全相关值得独立审计） | **低（性价比最高）** |
| **`heuristic-scheduling-solver.ts`** | 2000 | ①`solver-pure.ts`（`1473-2000` 全部纯函数，零 `this` 依赖，**零风险且立刻可单测**）②`solver-constraint-binder.ts`（约束解析现摊成 12+ 个散落局部变量，是 solve() 臃肿主因）③`solver-resource-index.ts`（**与 P0-1 同构**——槽位索引改增量维护，**性能优化与拆分是同一次重构**）④RejectTrace 独立 | **中**（主循环有逐位一致性要求：`insertTopK` 稳定语义 `:1658-1663`、`candidateCompare` 全序 `:1993`） |
| **`mes.service.ts`** | 1379 | SOP 与 QualityScheme 是两份同构的「版本化文档」（`866-963` vs `1022-1126` 四件套逐一对齐），抽 `VersionedDocumentStore<T>` 减约 250 行，并防止两个域版本语义各自漂移 | **低** |
| **`ingest.service.ts`** | 1357 | 切 `ingest-adapters.ts`（`936-1047`）、`ingest-mappers.ts`（`667-731`）、`ingest-device-pipeline.ts`；顺序 2→1→3（`ingestEventBatch:408` 自身 260 行且是公共落地点） | **中** |
| **`work-orchestration.service.ts`** | 1617 | **最突出问题不是大而是 6 组双轨实现**（`getResources/getResourcesDurable`、`applyGitSync/applyGitSyncDurable` 等，配 `assertDurableReady:225`/`allowFileFallback:241`）。**建议先消双轨再谈拆分**（先减半） | **中** |

### 6.2 死抽象与重复实现

| 问题 | 实测 | 建议 |
|---|---|---|
| **`shared/pagination.ts` 零引用** | `parsePageQuery`/`parseCursorQuery`/`buildPageResponse` 调用点 **0**；散落 `.limit(` **173 处**、手写 pageSize **53 处** | **保留抽象、反向收敛，不要删**——173 处手写里很可能有无上限列表接口，这正是历史 `listRuns` 50MB 的同类风险面，属**稳定性问题而非整洁度**。先审计有无无上限接口，再分批迁移，最后加 ESLint 禁止字面量 limit |
| **org 作用域谓词 5 处各自实现** | `world-state:78`、`scheduling-policy:527`、`mes:265`、`scale:172`、`dashboard:129-131` | 这是**租户隔离逻辑**，重复实现的后果是安全性的，优先级高于一般重复代码 |
| **类型逃生舱** | `as unknown as` **148 处**（全仓 `any` 仅 11 处），集中在上帝文件 | 与上帝文件拆分同源 |
| **僵尸依赖** | `@nestjs/cache-manager` + `cache-manager` **零引用**（32 个生产依赖中确认 2 个僵尸） | 见 §5.5，与缓存问题二选一处理 |

### 6.3 技术债标记分布

`TODO/FIXME/HACK/DEPRECATED/XXX` 总数 **仅 4**（`WorkOrchestration` 2 + `client/src/lib` 2）；`console.log` 仅 2；但**空 catch 38 处**。

> **注释卫生度极高，恰恰说明债务是隐性的**——以上帝文件、双轨实现、死抽象的形式存在，而非显式标记。

空 catch Top：`replan-coordinator` 4、`ai.service` 3、`scale` 2、`identity` 2、`pg-notify.listener` 2。**核心编排链路吞异常值得注意**。

---

## 七、测试覆盖与风险画像

### 7.1 覆盖画像（实跑 HEAD，非静态推断）

| 层 | 实测结果 |
|---|---|
| 后端 | **290/290 套件、2250/2250 用例全绿**（622s） |
| 前端 | **138/138 套件、1173/1173 用例全绿**（13.9s） |
| Python | 测试/源码行数比 **0.64**；CP-SAT **充分**（含 `test_cpsat_solver_real.py` 真实求解器）；`advisory_only` 边界**有守卫**（`test_scheduler_ownership.py:171-246` 共 10 例含正向对照） |
| 契约 | OpenAPI **零漂移**（`gen:openapi:check` 实测 in sync） |

> ⚠️ 仓库内已提交的 `jest.results.json` 是**过期证据**（早 9 小时 / 17 个 commit，其中 `61efdfb` 改了 23 个服务的 25 处 insert），不应采信。

### 7.2 结构性问题（真问题所在）

| 问题 | 实测 |
|---|---|
| **前端测试不在 CI 内** | `test:client` 全仓仅出现在 `scripts/standalone-check.sh:17`，**7 个 workflow 零命中** → 1173 个已绿用例不在发布门禁内 |
| **覆盖密度 5.6× 失衡** | scheduler **3.9** spec/kLOC vs 非 scheduler **0.7** |
| **目录倒置** | `lib/` 85.9% ｜ `pages/` 42.7%（多为抽出的纯逻辑）｜ `components/` **5.7%**（211 源/12 测）｜ `api/` **8.3%**（24 源/2 测） |
| **盲区** | 前 35 大源文件中 **30 个零直接测试，共 21,282 行**；`CommandMap/` 12 个容器组件 8,000+ 行零直接单测 |
| **零覆盖率阈值** | 全仓 `coverageThreshold`/`--coverage` **0 命中** → "2250 全绿"无法换算成任何覆盖率数字，盲区不可治理 |
| **视觉回归门禁双重失效** | 配置声明 Linux 为金基线，但 18 个基线**全是 `-darwin`**（`-linux` 为 0）；且 "visual" 在全部 workflow 中 0 命中 |
| **测试环境静默跳过锁** | `kpi.service.ts:274`、`scheduling-feedback.service.ts:179` → 并发逻辑在单测中根本没执行 |
| **Makefile 门禁未接 CI** | `audit-regression-gates`（十条主线）、`audit-org-predicates.js` 定义在 Makefile 但**未接任何 workflow** |

### 7.3 运营与数据风险

| 风险 | 证据 | 级 |
|---|---|---|
| **生产模拟器未关** | 105,269 事件中 **105,255 为 simulated**，真实告警仅个位数 → 告警体系实质失效；这是 `eventCritical` 计数异常增长至 100,309 的根因 | **P1** |
| **shadow 方案永不清理** | `shadow-policy.service.ts:105`，全仓清理逻辑 grep = 0；对照 `shadow-evaluator.service.ts:218` 有 retention，证明是遗漏而非能力不足 | **P1** |
| **dispatch 后 Execution 建档在事务外** | `scheduler-plan-application.service.ts:337-391`（已有 3 次重试），降级字段 `executionSync` **client 侧 0 处引用** → 静默数据缺口 | **P1** |
| **前端钩子零测试** | `useOfflineWorkbench.ts`(705 行)、`useSchedulerStream.ts`(490 行 SSE+续传+重连) 状态机密集且零测试；`offlineDb` 数据层已测但**编排层未测** | **P1** |

### 7.4 ★ 成员交叉验证：trigger cooldown 的澄清

QA 判定"trigger cooldown 已实体感知化"**成立，但只对应一层**。冷却实际有**两层**：

| 层 | 位置 | 实体感知 | 跨实例 | 去重 |
|---|---|---|---|---|
| 触发层 | `trigger.service.ts:73-123` | ✅ 是（triggerKey 含 entityId） | DB 唯一约束 | ✅ `onConflictDoNothing` |
| **风暴守卫层** | `replan-coordinator.service.ts:229-289` | ❌ **仅 org 级** | ✅ 是 | advisory lock |

风暴守卫层 WHERE 只有 `orgId + triggerType != MANUAL`（`:263-266`），**没有 entityId 维度**，三个阈值全 org 级。
→ **同一 org 内不同实体密集触发仍会被 org 级抑制，实体感知只在触发层生效。** 若产品期望端到端实体感知，风暴守卫层需补 entityId 维度。

> 另：`scheduler-run-orchestrator.service.ts:83` 注释提到"被 ON CONFLICT DO NOTHING 永久去重（前端手动触发按钮失效）"，疑似"去重后无法再次触发"的已知问题，**建议后续确认**。

---

## 八、下一步优化任务清单（按收益/成本从高到低）

> 排序依据：`影响范围 × 收益 ÷ 实施成本`。T1–T5 为"低成本高收益"的立即行动项，T6–T8 为核心正确性/性能改造，T9–T12 为中长期架构治理。

---

### T1　把前端测试接入 CI　【成本：1 行 YAML｜收益：极高】

- **现状**：`npm run test:client` 全仓仅出现在 `scripts/standalone-check.sh:17`，7 个 workflow 零命中。1173 个已绿用例（13.9s 即可跑完）**完全不在发布门禁内**，任何人推代码都不会触发。
- **目标**：在 `.github/workflows/test.yml` 增加 `npm run test:client` 步骤。
- **预期收益**：**全审计中 ROI 最高的一项**——零风险地把 138 套件 1173 用例纳入质量网，且在 14 秒内完成，不拖慢 CI。

### T2　overview 缓存单槽变量改 Map　【成本：<10 行｜收益：极高】

- **现状**：`dashboard.service.ts:83` 单槽变量只能装 1 条，多 org 交替访问时命中率趋近 0，"未命中 0.799s"是**常态路径而非异常**。
- **目标**：改为 `Map<orgKey, entry>`（对齐 `scheduling-policy.service.ts:165` 的既有正确实现）。
- **预期收益**：多租户场景下 dashboard 从常态 ~800ms 回到 70~170ms；直接解开"为什么压测达标、生产不达标"的历史谜团。零风险。

### T3　关闭生产模拟器 + 补告警占比监控　【成本：1 个环境变量｜收益：极高】

- **现状**：105,269 条事件中 105,255 条为 simulated，真实告警仅个位数 → 告警体系实质失效，`eventCritical` 计数异常增长至 100,309 即由此而来。
- **目标**：生产置 `EWOH_SIMULATOR_ENABLED=0`，并加"simulated 事件占比"监控项。
- **预期收益**：恢复告警系统的信噪比，让 500 条 open 告警的清理工作变得可决策（当前无法分辨真假告警）。

### T4　收敛 gamification 派工旁路　【成本：中｜收益：高（正确性）】

- **现状**：`gamification.service.ts:537-620` 独立重写了方案校验、租户校验、冲突检测、状态落库，与 `scheduler.controller.ts:383` 形成同一状态跃迁的双实现，且其在积分模块内的授权/审计/限流面从未被验证。
- **目标**：删除 `gamification.dispatchPlan`，调用方收敛到调度域；若必须保留语义，改为依赖反转调用 `SchedulerService.dispatchPlanV2`。
- **预期收益**：消除"同一方案 A 路径成功、B 路径报冲突"的行为分叉；消除调度核心表被域外模块直接读写的边界破坏；后续调度逻辑修改只需改一处。

### T5　补齐 5 张表的 RLS　【成本：低｜收益：高（安全）】

- **现状**：RLS 覆盖 84.3%（86/102），`ewoh_scheduling_execution`/`_conflict`/`_kpi`/`_route_cost_matrix`/`_policy_activation` 共 5 张含 `org_id` 的表无 RLS，且不在已登记的偏差名单（`standalone_057:36-46`）内。
- **目标**：按 `standalone_056` 既有模式补 RLS，并把 `org-rls-guc.e2e.spec.ts:64` 参数化为表清单驱动（1/102 → 86/102）。
- **预期收益**：消除跨租户数据泄漏风险；把形同虚设的租户隔离 E2E 变为真正的守卫。

### T6　未命中路径索引与谓词优化　【成本：低（DDL + 查询改写）｜收益：高】

- **现状**：4 个全表聚合缺复合索引；`status='open'` 写在 `FILTER` 而非 `WHERE`（`:144,:147`）导致无法 index-only scan；遥测聚合只有单列索引（`:156-159`），而遥测是写入量最高的表。
- **目标**：补 `(org_id,ts)`/`(org_id,status)`/`(org_id,online)` 复合索引；把谓词从 FILTER 移入 WHERE。
- **预期收益**：直接压低 6.444s 冷启动与常态未命中耗时的主要来源——**瓶颈在扫描量不在连接池**（连接池 10→20 仅改善 5.4% 已证实这点）。

### T7　预览接口切换只读快照　【成本：3 行｜收益：高】

- **现状**：`override-preview:59`、`replan-preview:47`、`conflict-preview:75` 三个高频接口误用**持久化** `buildSnapshot`，每次把完整世界状态写进 JSONB；而 `buildSnapshotReadOnly`（`world-state.service.ts:105`）已存在却只有 2 处使用。
- **目标**：三个预览路径切到 `buildSnapshotReadOnly`。
- **预期收益**：消除写入放大，同时降低 `buildSnapshot` 版本分配的行锁热点压力（该路径用行锁 + 有界重试 3 次，`:130-176`）。

### T8　缓存抽象二选一（根治 P0-2 与 P1-5）　【成本：低～中｜收益：高】

- **现状**：`@nestjs/cache-manager` + `cache-manager` **零引用**（僵尸依赖），于是各处手写：`dashboard` 单槽变量（多租户命中率→0）、`scheduling-policy` 进程内 Map（写入方未失效、无跨实例通道）。**这是"装了不用 + 手写且有 bug"的最差组合。**
- **目标**：二选一——① 删除两个僵尸依赖 + 手写缓存统一改 Map 并补失效调用；② 真正引入 cache-manager，一并解决多租户缓存隔离与跨实例失效（`common/redis.service.ts` 已存在可用）。
- **预期收益**：一次性解决 P0-2（多租户命中率）与 P1-5（策略激活后 30s 读到旧值）两个问题，且消除供应链冗余。

### T9　启发式求解器复杂度治理　【成本：中高｜收益：高（规模化能力）】

- **现状**：O(T²×S×D) 四重嵌套 + 最内层三次 `.some()` 扫描单调增长的已预订槽位数组；且三个槽位索引在循环体内每次重建。T=1000 时约 3×10⁹ 次操作，是 `conflicts` 曾实测 104s 的根因。
- **目标**：分三步——① 槽位索引增量维护移出循环（**改动最小、收益最大**）② `.some()` 改区间树/有序数组二分 ③ 设备候选前置剪枝。
- **预期收益**：调度核心链路从"数据量增长即不可用"变为可水平扩展；**第①步与 §6.1 中 `heuristic-scheduling-solver.ts` 的拆分（抽 `solver-resource-index.ts`）是同一次重构**，应合并规划。

### T10　统一求解器选型与回退语义　【成本：中｜收益：高（生产稳定性）】

- **现状**：4 个求解器中 MILP 与 rule-based **无回退**（`solver.service.ts:258-261` 注释自认"不隐式回退"），配置命中且依赖不可用时**生产直接失败而非降级**；四者在 `objectiveEvaluator` 缺省时各自 `new`（`:123`、`:129`）存在语义漂移。
- **目标**：统一为"策略声明 solver → 单一激活阶梯 → 统一回退 heuristic"；`objectiveEvaluator` 强制单例注入。
- **预期收益**：消除"配错策略版本即生产故障"的悬崖式失败；让 4 个求解器的结果可对拍。

### T11　约束加载静默降级改 fail-closed　【成本：低｜收益：中高（正确性）】

- **现状**：`scheduler-run-orchestrator.service.ts:98-101` 中 `constraintLoader` 为 undefined 时**静默返回空约束**，无任何告警。
- **目标**：改为 fail-closed，或至少 `logger.error` + 指标上报。
- **预期收益**：人工 LOCK/EXCLUDE 约束可能在静默降级中丢失而不被发现——这是一类"错了但不报错"的高危缺陷。

### T12　shadow 方案清理 + Execution 建档完整性　【成本：低～中｜收益：中高】

- **现状**：① shadow 方案永不清理（`shadow-policy.service.ts:105`，清理逻辑 grep = 0，而 `shadow-evaluator.service.ts:218` 已有 retention 模式可复用）；② dispatch 后 Execution 建档在事务外（`scheduler-plan-application.service.ts:337-391`），降级字段 `executionSync` **前端 0 处引用**，形成静默数据缺口。
- **目标**：复用既有 retention 模式补 shadow 清理；前端读取 `executionSync.ok` 并提示 + 加对账告警。
- **预期收益**：消除数据腐化与静默缺口；让"plan DISPATCHED ⇒ Execution 数 == assignment 数"成为可断言的不变量。

---

### 中长期架构治理（T13–T16，建议纳入下个季度规划）

| # | 任务 | 现状 | 目标 | 收益 |
|---|---|---|---|---|
| T13 | **`shared` 反向依赖解环** | 20 条环中 15 条经过 shared（`shared.module.ts:12`、`access-token.guard.ts:10`） | 提取无依赖 `shared-kernel`；`slow-query.service` 与 `auth.service` 改 `@Optional()` 注入或接口下沉 | 一次性消除 15 条环，使模块可独立编译/测试/部署 |
| T14 | **Python `scheduler/` 核心域下线** | 6,812 行 + 19,047 行测试维护永不上线路径；重连即 delete | 保留 `cpsat/`；核心域冻结评估下线，或明确定位为仿真沙箱并从生产镜像移除 | 大幅降低维护成本，消除平行 API 面与潜在 split-brain |
| T15 | **上帝文件拆分** | 5 个 1300+ 行文件，其中 4 个承载多组无关关注点 | 按 §6.1 顺序：先 `scale`（低风险）→ `mes`（低风险）→ `heuristic`（与 T9 合并）→ `ingest` → `work-orchestration`（先消 6 组双轨） | 降低改动冲突率，使核心逻辑可单测 |
| T16 | **覆盖率阈值与门禁补全** | 零覆盖率阈值；视觉回归双重失效；Makefile 门禁未接 CI | 开分层阈值（scheduler 高 / 非 scheduler 40% / 前端 lib 70%、pages 30%）；修复视觉基线；Makefile 门禁接入 | 让"全绿"可换算为可治理的覆盖率数字，盲区可度量 |

---

## 九、审计过程中被证伪的既有认知

以下来自项目历史记忆/既往审计结论，本次用代码实测证伪，**建议更新相关文档**：

| 既有认知 | 实测结论 | 证据 |
|---|---|---|
| server 有 38 个模块 | **实际 53 个** | `server/modules/` 目录实测 |
| 双 solver 并存 | **实际 4 个**（heuristic/cp-sat/milp/rule-based） | `solver.service.ts:80-83` |
| NestJS 侧写路径 403 `SCHEDULING_READ_ONLY` | **不存在**（全仓 TS/JSON/YAML 零命中），该约束**只在 Python 侧单边强制** | Python `run.py:60-78` |
| 双 SSE 连接未收敛 | **已收敛**为单条 | `SchedulerRealtimeProvider.tsx:38` |
| `is_shadow` 与 status 不同步 | **已修复**且测试把守（R2-SSV-03 事务原子化 + DB CHECK） | `shadow-policy.service.ts:143-160` |
| 事务内含 LLM 调用 | **已修复**，18 个事务体零命中 | 全量扫描 |
| trigger cooldown 无 entityId | **部分成立**——触发层已实体感知，风暴守卫层仍仅 org 级 | `trigger.service.ts:73` vs `replan-coordinator.service.ts:263-266` |
| `schema.ts`/`openapi.d.ts` 是上帝文件 | **均为自动生成**，有 do not edit 头 + `openapi:no-drift` 门禁，不计入可维护性债 | 文件头 |
| 前端零测试覆盖 | **实际 138 文件 1173 用例全绿**（但不在 CI 内） | `client/jest.config.cjs` testMatch 为 `*.test.ts(x)` |

---

## 十、附：三份分项报告

| 报告 | 路径 | 规模 |
|---|---|---|
| 架构层深度测绘与薄弱点诊断 | `deliverables/audit-architecture-deep-dive.md` | 689 行 |
| 代码层深度通读（性能 + 可维护性 + 关键实现） | `deliverables/audit-code-deep-dive.md` | 775 行 |
| 测试覆盖与风险审计 | `deliverables/audit-risk-and-testing.md` | 由 QA 产出 |

---

*本报告由软件开发团队三路并行审计汇总：架构师（模块划分/依赖拓扑/链路）、工程师（性能/可维护性/关键实现）、QA（测试/风险）。审计过程未修改任何源码，临时产物仅写入 /tmp。*
