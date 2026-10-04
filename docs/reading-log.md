# 精读日志（reading log）

> 本文件是 `docs/long-cycle-implementation-prompt.md` 第六部分要求的交付件：每阶段完成后按
> 「职责／入口／数据流／异常分支／未解疑点」五要素入档。文中所有数字一律标「本轮现算」并附取数命令，
> 不抄任何历史快照。轮次：V353（2026-10-04）。

---

## §0 审阅口径与分母定案

### 0.1 `reviewed=true` 的机器定义（读 `scripts/audit-file-ledger.js` 原文，非推测）

| 失效原因 | 判据（读到的实际比较式） | 位置 |
|---|---|---|
| `not_reviewed` | `row?.reviewed !== true` | `scripts/audit-file-ledger.js:288` |
| `missing_review_hash` / `stale_review_hash` | `reviewed_sha256` 必须是 64 位 hex，且必须等于**当前内容** sha | `:289-290` |
| `stale_inventory_hash` | 账本里的 `content_sha256` 必须等于当前内容 sha | `:291` |
| `stale_line_count` | 账本里的 `line_count` 必须等于当前行数 | `:292` |
| `invalid_review_ranges` | 区间必须是 `[start,end]` 整数对、`1≤start≤end≤line_count` | `:293` + `validateRanges` `:262-282` |
| `incomplete_review_ranges` | 区间并集覆盖行数 `covered` 必须**恰好等于** `line_count` | `:294` + `:281` |
| `new_file_missing_from_ledger` | 现扫到但账本无该行 | `:287` |

**口径结论**：这里的「逐行读完」不是主观描述，而是「当前内容 sha 一致 ＋ 申报的审阅行区间并集覆盖文件每一行」。
`cmdGenerate` 每次都会用 `validateReview(old, base).verified` 重算 `reviewed`（`:367`），
所以**产品代码一改，旧的「已读完」标记就机械失效**——这是设计而非事故。
`merge` 侧同样硬拒：`reviewed=true` 但区间不全覆盖 ⇒ 抛错（`:414-416`）。

### 0.2 2026-08-18 → 09-21 的 `reviewed` 骤降：定案为**过期＋扩面，不是撤回**

一手读数（逐份 `git show` 后按 JSON 解析，非文本匹配）：

| 提交 | 日期 | 账本条目 | `reviewed` | 已读行数 |
|---|---|---|---|---|
| `0c0bf0c2` | 2026-08-18 | 2,095 | 2,095 | 399,261 |
| `ff361548` | 2026-09-21 | 2,722 | 597 | 113,250 |
| `c4133284` | 2026-09-21 | 2,722 | 629 | 124,976 |
| `7d0754a4` | 2026-09-29 | 2,730 | 712 | 145,758 |

三条独立证据支持「过期＋扩面」：
1. `docs/audit/current/final-assessment.md:11` 自述当时是「2095 个、399,261 行、reviewed=true 2095/2095、active_unread_files=0」——那是**当时内容**下的真读数，不是虚报；
2. 工具在 `generate` 时按 0.1 判据把内容变过的标记机械判回 false（`audit-file-ledger.js:367`、`:284-296`）；
3. 分母同期从 2,095 扩到 2,722→2,730→**本轮现扫 2,880**（新增文件先不入账，见 0.3 的 150 处）。

**推论（也是本文件给后续所有轮次的纪律）**：任何「全仓已逐行读完」的历史读数都不可继承；
今天的读数必须由 0.3 的命令现取。

### 0.3 当期分母（两个独立来源同数 ⇒ 可入门禁）

来源一：工具自身（只读子命令，`report` 会写 `coverage-report.md` 故未用）
```
$ node scripts/audit-file-ledger.js stats
total=2880 reviewed=666 unreviewed=2214 missing=0        # rc=0
```

来源二：本轮独立复算（python 逐文件重算 sha256 与行区间并集，**不复用工具代码**）
```
active=2880 verified=666 unverified=2214
total_lines=612315 verified_lines=119328 未过校验行数=492987
```
两来源一致 ⇒ 「活跃工程文件 2,880 个 / 612,315 行，其中经严格口径确认逐行读完 **666 个 / 119,328 行**」为当期真值。

其余三面（各自口径不同，不得混用）：

| 口径 | 分子 | 分母 | 说明 |
|---|---|---|---|
| 账本自述面（不做内容校验） | `reviewed=true` 712 | 条目 2,730 | 其中 **46 处已过期**（0.4 的 sha/行数不符者） |
| 账本记录行数面 | 未读 417,380 | 未读 2,018 | 账本里的 `line_count` 本身有 112 处过期（0.5） |
| 磁盘面 | 未读 420,953 | 未读 2,018 | 按磁盘重算行数 |
| **严格校验面（权威）** | 未过校验 2,214 | 活跃 2,880 / 492,987 行 | 0.1 的机器口径 |

**未入账读数**：`new_file_missing_from_ledger = 150` —— 现扫 2,880 与账本 2,730 之差。
这与登记册已开放的 `AUDLEDGER-01` 同族（V346 记 139、V348 记 140、本轮 **150**，仍在涨，仍开放）。

### 0.4 失效原因分布（本轮现算；一文件可同时命中多因，故 Σ > 文件数，不可当分母用）

`not_reviewed 2018` · `missing_review_hash 2011` · `incomplete_review_ranges 1048` ·
`stale_inventory_hash 119` · `stale_line_count 112` · `invalid_review_ranges 105` ·
`new_file_missing_from_ledger 150` · `stale_review_hash 53`

新读数一条：`invalid_review_ranges = 105` —— 这 105 个文件申报的审阅区间**形状本身非法**
（端点越界／非整数），即其「读完」主张在当前口径下结构上不可核验。此前各轮速览未见此读数被单独报过。

### 0.5 账本↔磁盘 `line_count` 漂移（112 处，节选）

| 文件 | 账本 | 磁盘 |
|---|---|---|
| `ewoh-spark-app/server/modules/control/control.service.ts` | 2,853 | **3,273** |
| `contracts/state-machines/alert.yaml` | 18 | 223 |
| `contracts/state-machines/plan.yaml` | 20 | 187 |
| `Makefile` | 255 | 536 |
| `scripts/audit-state-machine-roles.js` | 199 | 542 |
| `scripts/audit-scheduler-transactions.js` | 161 | 427 |
| `ewoh-spark-app/test/e2e/pg-temporary-failure.e2e.spec.ts` | 252 | 1,282 |
| `ewoh-spark-app/server/modules/scheduler/replan-coordinator.service.ts` | 1,178 | 1,394 |

⇒ 凡引用 `control.service.ts` 行数者，**3,273 是磁盘值、2,853 是账本过期值**；
`ewoh-spark-app/docs/refactoring-roadmap.md` 用的 3,273 与磁盘一致，无需更正。

### 0.6 对本轮更早一次对外读数的自我修正（诚信条款）

同一日更早一轮，我用「账本自述面」报过「未读 2,018 文件 / 417,380 行（磁盘 420,953）」并据此估过耗时。
按 0.1 的机器口径重算，**未过校验的逐行覆盖应为 2,214 文件 / 492,987 行**；
早前读数只在「不校验 sha 与行区间」这一面成立。据此，全仓逐字覆盖的工作量比早前的估算
多约 **18%（行数）/ 10%（文件数）**，档位结论不变、数字作废重取。

### 0.7 选型复核补齐（上一轮标「未本轮核验」的那一格）

`ewoh-spark-app/node_modules/typescript/LICENSE.txt` 前 3 行原文：`Apache License` / `Version 2.0, January 2004`
⇒ 树内 `typescript@5.9.2`（实测 `require('./ewoh-spark-app/node_modules/typescript/package.json').version`）
许可证为 Apache-2.0，与「不新增依赖、复用树内编译器 API」的决策相容。

### 0.8 对账来源增至四个

除 `ewoh-spark-app/docs/refactoring-roadmap.md`（21 项）、`docs/long-cycle-implementation-prompt.md`（阶段 0-5／Q1-Q7）、
《链级行为基线》§5.4（当期 185 行＝85 闭／100 开）之外，本轮发现**第四份清单**：
`docs/refactoring/refactoring-backlog-2026-08-30.md`（91 行，P0-1~P1-6 等）。
其中 P0-3「时间格式统一（12+ 文件）」疑似已在后续轮次完成（提交 `48adfeba`、`f570b902` 均为
`refactor(client): 时间…对齐 intl 共享常量`）——**此处只登记线索，判定交给 §1 的量具与判重，不在本文下结论**。

### 0.9 未解疑点（本轮未确认）

1. 105 处 `invalid_review_ranges` 是记账格式演进的遗留还是写入方 bug——未读第二遍审计的输入件生产者，**未定案**。
2. 46 处「账本仍写 `reviewed=true` 但内容已变」为何没被 `generate` 刷掉——推测是 09-29 之后未再跑 `generate`，
   属**推测，未核实**（无命令读数支持）。
3. 150 处未入账文件的域分布未读——§1 量具会按域输出，再定。

---

*§1 起为精读结论。标记沿用《基线》的四档：`已证实(源码·本人复核)` ＝ 本轮我亲手重读了该行区间；`走读定位(待复核)` ＝ 子代理逐行读并带行号、我未逐条回读（本项目实测子代理误报率约 1/3，两档不得混用）。*

## §1 调度域（生产主路径）

**职责**：`heuristic-scheduling-solver.ts` 是**当前唯一生产求解器**（`solver.service.ts` 缺省 `activation='OFF'`，CP-SAT 需 `EWOH_SOLVER_ACTIVATION=PRODUCTION` ∧ `EWOH_SOLVER_PRODUCTION_ENABLED=1` 双重门控，未过则 fail-closed 回退 heuristic）；`plan.service.ts` 负责方案落库与状态机；`world-state.service.ts` 负责快照聚合与新鲜度判定；`scheduler-run-orchestrator.service.ts` 串起触发→快照→求解→落库→闭合 run。
**入口**：HTTP `POST /runs`（经 `org-context.interceptor.ts` 把整个 handler 包进请求级事务）；后台触发走另一档（无 store ⇒ 各段独立提交）。
**数据流**：trigger 建行 `queued` → 快照持久化（版本号由计数器表 `ON CONFLICT (day)` upsert 分配）→ 约束装载 → 求解（只算不写）→ **单个事务内** `persistPlan` 循环 + `closeSchedulingRun` + `invalidate` → 提交后才经 outbox→pg_notify→SSE 可见。
**异常分支**：求解抛错 → catch 内另起事务写 `failed`，但该事务随请求事务回滚 ⇒ **HTTP 档无 DB 留痕**；`closeSchedulingRun` 返回 false 不抛（0 命中只打日志）且编排丢弃返回值 ⇒ 方案已提交而 run 仍 `queued` 的形状存在。
**未解疑点**：`EWOH_REQUIRE_CONSTRAINT_LOADER`／`EWOH_DB_REQUIRE_TX` 在生产是否置位（未查部署环境，属机制限制）；narration 与 30s TTL 缓存的两个竞态未实测。

| # | 结论 | 标记 | 依据 |
|---|---|---|---|
| 1 | 约束拆解 switch 的 `default: break` 不记 violation、不打日志、不抛错 ⇒ 未落 case 的类型静默 | 已证实(源码·本人复核) | `heuristic-scheduling-solver.ts:386-388` |
| 2 | `LOCKED_STATION` 已有 case 与消费点（roadmap A0-1 所述"缺 case"已被 `de5b1148` 修掉）| 已证实 | `:354-356` |
| 3 | `LOCKED_ASSIGNMENT` 要求 `taskId&&personId&&deviceId` 齐全、无 `stationId` 分支 ⇒ 与 `constraints.ts` 的"三字段各自独立"分叉（roadmap A0-2 成立）| 已证实 | `:361-366` |
| 4 | 内联候选路径未透传 `stationAvailableWindowsById` ⇒ `eligibility.service.ts` 的资源时间窗在该路径恒不生效；`bookedStationCounts` 从未被 eligibility 读取 | 走读定位(待复核) | `heuristic:1212-1245`、`eligibility.service.ts:461-471` |
| 5 | 事件影响范围取"全部 open 事件"、无任务 scope，`eventImpacts` 在本文件零出现；后果是一条高危事件给所有任务同等加分 | 走读定位(待复核)（`eventImpacts` 零出现一支我已用两种写法核过）| `heuristic:666-668`、`priority-engine.ts:146-161,274-292` |
| 6 | 快照行不存在（含 retention 48h 清理）被报成 `PLAN_STALE:CONTENT_CHANGED`；预占漂移的原因码两支同值 | 已证实 | `world-state.service.ts:644`、`:671`、`:761` |
| 7 | replan 作废旧方案是**仅身份谓词**的裸 UPDATE（无来源态、无 org、无 returning）⇒ 与开放行 `GUARD-01` 同一事实，且**该行抄的 `:1400-1403` 已漂到 `:1386-1389`** | 已证实 | `plan.service.ts:1386-1389` |
| 8 | 取消路径：assignment CAS 落空者被摘出 `cancelled` 并入 `irreversible`（CCAS-01 的修形已在位），方案行仍写终态 `cancelled` 且带来源态 `inArray` 守卫 | 已证实 | `plan.service.ts:898-912`、`:956-973` |

### 1.9 约束的四个消费面（V353 本轮逐行复核，替换上一版的"10 类静默丢弃"读数）

上一版按子代理读数写的是"heuristic 有 10 个 `default: break` ⇒ 10 类硬约束静默丢弃"。**我自己重读后收窄**：
`default: break` 只是"本求解器不按类型名消费"，其中五类另有消费点。把四类消费面分开数之后，结论如下。

分母自报：本轮按 `['"]<TYPE>['"]` 全仓枚举（`os.walk`，排除 `.git/node_modules/tmp/.codex/output/release/dist/.workbuddy`、排除 `*spec*` 与 `__tests__`），命中文件与次数逐条列在下面。

| 面 | 证据 | 读数 |
|---|---|---|
| ① 类型词表 | `shared/scheduler.ts:126`（硬 19）、`:151`（软 14，含重分类的 `EXCLUDED_RESOURCE`） | 去重 32 |
| ② 注册表（自称"启发式求解器**真实执行**的硬约束集合"） | `constraints.ts:17-41` 硬 19、`:44-59` 软 13 | 与①逐字同集，无幻影项 |
| ③ 编译层 | `constraint-compiler.ts:167/181/194/202/215/226` | 6 类：`REQUIRED_SKILL`·`REQUIRED_CERTIFICATION`·`SAFETY_BLOCK`·`PREDECESSOR`·`STATION_CAPACITY`·`EXCLUDED_RESOURCE`；调用方只有 `scheduler-run-orchestrator.service.ts` |
| ④ 两个求解器的本地 switch | `heuristic:344-386`（10 个 case＋`:388-391` 的 `MANUAL_BOOST` 在 switch 之外）、`cp-sat-scheduling-solver.ts:600-633`（6 个 case） | heuristic 覆盖硬 9 类；cp-sat 只覆盖 6 类 |

**⑤ 边缘 Worker 侧＝0 类。** `shared/scheduler.ts:465-466` 声明 `constraints?: Array<Record<string,unknown>>`，注释写"原始约束透传…供 CP-SAT Worker 消费相同语义"；`cp-sat-scheduling-solver.ts:803-808` 确实把它连同每条的 `supported` 标记一起发出，注释还写"不支持的约束显式标记，不静默忽略"。
而接收端 `src/edge_platform/scheduler/cpsat/contract.py:136-159` 的 `SolverRequest` **没有 `constraints` 字段**，`from_dict:161-192` 只按声明键 `.get(...)` 取数 ⇒ 整个数组连同 `supported` 标记在 Worker 侧不存在。
同函数内的不对称可反证这不是"整体宽容"：`tasks=[SolverTask(**t) …]` 对**项内**未知键会 `TypeError`（→400→降级熔断，有牙），只有**顶层**未知键被无声吞掉。⇒ 那句"不静默忽略"只在生产侧成立，消费侧无人接手，`supported` 标记是死载荷。

**⑥ 零消费者的五类。** 注册表 19 类硬约束里，`PERSON_AVAILABLE`·`DEVICE_AVAILABLE`·`RESOURCE_TIME_WINDOW`·`NO_DOUBLE_BOOKING`·`STATION_CAPABILITY` 五类，除①的词表行与②的注册表行外**全仓再无命中**（`STATION_CAPABILITY` 另在 `docs/scheduler-commandmap-upgrade/05-incremental-design-2026-08-10.md` 出现一次）。
这五类各自的语义确有**另一根轴**的实现（`eligibility.service.ts` 里 `availableFromMs`／`requiredStationCapabilities`／`capabilities.includes` 共 6 处），但那是按**资源数据**过滤，不是按**约束实例**消费——约束实例携带的参数（如 `RESOURCE_TIME_WINDOW` 的 start/end）没有任何读取点。

**⑦ 决策追踪把注册表当成"本次应用了的约束"。** `heuristic-scheduling-solver.ts:1513` `traceExt.hardConstraints = [...SUPPORTED_HARD_CONSTRAINTS]` ⇒ 追踪面恒报 19 类，与③④⑤的实际消费面（heuristic 本地 9＋编译层 5＋Worker 0）不同源。
`constraints.ts:99-106` 的 `supported` 判定又只看是否在注册表内，故这五类**永远判"支持"**、不会进 `heuristic:338-344` 的 `unsupported_constraint` violation ⇒ 从写入到追踪全程无人报。

**⑧ 可达性未证的一半**：约束写入路径是否按注册表校验类型（即客户端能否真提交这五类）本轮未读——已定位的注册表读侧只有 `constraint-loader.service.ts:175` 与 `plan.service.ts:1139`，两处都用 `isSoftConstraintType` 判 hard 标记、不校验取值域。**此项标 `未找到`，不是"证明不可达"**。

## §2 控制域与工单编排

**职责**：`control.service.ts`（磁盘 3,273 行；账本记 2,853 已过期）承载命令/请求双层状态、投递认领、回执、撤回、积压巡检；`work-orchestration.service.ts` 是 handoffs/git-sync/锁 的编排层。
**入口**：`control.controller.ts`（HTTP）＋ `control-delivery-backlog.worker.ts`（巡检腿）＋ 网关轮询 `/api/control/commands/pending`。
**数据流**：命令行 `pending→sent→gateway_received→executed/failed/timeout`，请求行按命令集合聚合；`delivered_at` 唯一写点在投递认领处，带 60s 窗口谓词。
**异常分支**：撤回腿在 `runDetachedTransaction` 里写，落空 ⇒ 整笔独立事务回滚、命令留 `sent`、`poll=409` 可见（`RVAGG-02` V325 已实测并据此**定案"不需要补锁→读→写"**）。

| # | 结论 | 标记 | 依据 |
|---|---|---|---|
| 1 | `transitionCommand` 不是命令状态的唯一收口：两处批量写不经它 | 已证实 | `control.service.ts:1057-1065`（无 org 谓词、无 `returning()`）、`:2268-2282`（有 CAS＋`returning`，无 org 谓词）|
| 2 | 子代理报的"撤回缺 `lockRequestRow` ⇒ 撤回丢失并返 500"**被已闭行的实测反驳**，不登记为缺陷 | 已证实(反驳依据为登记册实测) | `chain-behavior-baseline.md:11694`（RVAGG-02 口径定案段）|
| 3 | 工单编排 `*Durable`／legacy 配对：生产侧 6 对、测试侧 6/6 双侧覆盖；另有 3 个 Durable-only（其中 `createReplicationSessionDurable` 无调用方亦无测试）| 走读定位(待复核) | `work-orchestration.service.ts:397/427,517/575,726/776,756/832,900/1000,949/1068,1151` |
| 4 | `listHandoffs()` 确为无 `WHERE` 全表读，但性质是**"表根本没有 `org_id` 列"**（DDL 一手核对），且 `ewoh_git_sync_state`／`ewoh_evidence_metadata` 同缺 | 已证实 | `db/migrations/standalone_004_ewoh_domain.sql:44-58`、`domain-persistence.service.ts:432-440`；库内实测见 unified-backlog §四 |
| 5 | 读入口被 `@Roles('global_admin')` ＋ default-deny 守卫挡住 ⇒ roadmap A3"全租户数据可读"要改档 | 走读定位(待复核)（守卫在位一支我已见 `controller.ts:16` 字样）| `work-orchestration.controller.ts:16`、`app.module.ts:122-123` |

## §3 未做与欠账（写在这里，不留 in-memory）
1. §1 第 4/5 行、§2 第 3/5 行的 `走读定位(待复核)` 条目**本轮仍未逐条回读**——提升为 §5.4 登记行之前必须复核，否则会复刻 roadmap 那 1/3 误报率。本轮已自己回读并升级的是：§1 第 1/2/3/6/7/8 行与 §1.9 的④⑤⑥⑦四段（每条都重开过引用的行区间）。
2. ~~约束 case 表的完整矩阵未落到持久件~~ **本轮已落**：见 §1.9（四个消费面＋五类零消费者＋追踪面谎报＋Worker 顶层键丢弃，全部带 `文件:行`）。子代理原读数"10 类静默丢弃"被我收窄成"9 类本地消费＋5 类编译层消费＋5 类零消费者"，并补上了 Worker 侧那一面。
3. 本轮**未做**：全仓均匀逐字读（理由见 §0.6 的历史读数作废证据）；`control.service.ts` 拆分；任何产品码修改。
4. 本轮新增的两处**自我更正**：①`verify.sh` 启动行显式 `EWOH_DEPLOY_TARGET=standalone` 起初记成"V353 失败成因"，实测 `ewoh-spark-app/.env.local-standalone`（2,853 字节、`.gitignore:83`）内含该变量 ⇒ 该处**属对干净克隆的预防性加固**，本机失败成因另有其他；②A2 凭据扩散面第一遍我用 `grep`（BRE）匹配口令字面量，`*` 被当量词 ⇒ 产物面/记忆面都读成 0，改 `-F` 后才是下面的真读数。
5. A2 凭据扩散面（**本轮本人复算**，掩码 `Xq**68`）：tracked 面 `git grep -F` 于 `HEAD` **0 文件 0 行**（`git ls-files scripts/ecs-exec.sh` 空、`.gitignore:71` 排除）；历史面 `git log --all -S` **0 commit**（全仓 581 commits／8 refs），64 个不可达 blob 逐个 `cat-file` **0 命中** ⇒ **无历史可改写**；工作树面 **6 个文件全部 git-ignored**＝源脚本 1＋发布包内副本 2（`output/release-bundles/ewoh-0.6.0-rc4/` 外层与自嵌套内层）＋`.workbuddy/memory/` 3 个文件 4 行（2026-08-21/22/23，`.gitignore:37`）；roadmap A2 原述"扩散面 6 处"若指入库面则**不成立**。
6. 发布工序的两条泄漏路径（本人复算文件与行数）：`scripts/package-release.sh:44` 用 `rsync -a "${ROOT_DIR}/scripts/"` 整目录搬走 ⇒ 未跟踪的 `ecs-exec.sh`（含明文口令）直接进发布包；`:56` 把 `${ROOT_DIR}/output/` 搬进 `${OUT}`，而 `${OUT}` 本身就在 `output/release-bundles/` 下（`:7`），且 `:14` 刚 `rm -rf "$OUT"` ⇒ rsync 边走边读，把半成品树复制进自己的 `output/` 子树，**恰好嵌套 1 层**（内层 4,390 文件 vs 外层 8,776；内层缺 `:60-66/:74/:130` 的收尾件；两处 `ecs-exec.sh` 在 `SHA256SUMS.txt:6041`/`:7430` 同哈希 `0cfd321b…`）。`:69` 的守卫现只查 `.env`。
