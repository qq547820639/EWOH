# EWOH 长周期实施提示词

> 用途：作为**长周期实施任务的输入提示词**，交给执行者（人或 AI）逐阶段推进。
> 生成时间：2026-10-03｜基线 commit `ae636248`｜`tsc -b` 0 错误
> 使用方式：阶段 0 完成后必须先回答 Q5，才能进入阶段 1；其余阶段按表推进。

---

## 第一部分：不可跳过的前置事实

### 1.1 仓库真实规模

| 部分 | 文件 | 行数 |
|---|---|---|
| `ewoh-spark-app/server` | 597 | 154,262 |
| `ewoh-spark-app/client/src` | 710 | 146,412 |
| `src/edge_platform`（Python 边缘侧） | 298 | 72,628 |
| `scripts` | 160 | 47,033 |
| `docs` | 349 | 66,481 |
| `db/migrations` + `verify` + `seed` | 332 | 22,272 |
| `ewoh-spark-app/shared` | 95 | 22,305 |
| `contracts` | 128 | 13,454 |
| `ewoh-feishu-app` | 44 | 8,737 |
| `tools` | 164 | 6,602 |
| **合计（剔除依赖/产物/生成物）** | **2,877** | **约 60 万** |

**明确不读**（非本仓代码或脚本生成）：
- `node_modules`(2.7G)、`output/`(141M)、`dist/`(181M)、`demo.db`(112M)、`.git`(32M)
- `client/src/types/openapi.d.ts`（23,598 行，头部写明 `DO NOT EDIT`）
- `client/src/types/*.d.ts`（25,135 行，同上）
- `server/database/schema.ts`（3,121 行，头部写明 `auto generated, do not edit`）——**列定义不读，但表间关系与索引要查**

### 1.2 双栈架构（决定一切优先级）

EWOH 是**云端 + 边缘侧双栈**：

| | 云端 | 边缘侧 |
|---|---|---|
| 位置 | `ewoh-spark-app/server` | `src/edge_platform` |
| 技术 | NestJS + Drizzle + PostgreSQL | Python + SQLite(WAL) |
| 职责 | 正式调度事实、排程、派工 | 设备接入、推理、**仅 advisory 建议** |

**边缘侧的调度写保护是硬约束**（`src/edge_platform/run.py:53-75`）：production 模式下设 `EWOH_EDGE_SCHEDULING_WRITE=1` 会抛 `SchedulingWriteProhibitedError`，不静默降级。`repository_readonly = mode != "simulation"`（`:242-248`）。`scheduler_service.py:160` 起 `_assert_writable()` 拦截 confirm/execute/replan。**这条边界比任何报告描述的都严格，是本仓最扎实的设计。**

### 1.3 求解器激活阶梯（决定哪条缺陷紧急）

`server/modules/scheduler/solver.service.ts:392`：缺省 `activation = cpSat?.activation ?? 'OFF'`

| 档位 | 行为 |
|---|---|
| `OFF`（**缺省=当前生产**） | 仅 heuristic 求解 |
| `SHADOW` | 影子求解不入库 |
| `CANARY` | `stableHash(orgId)%1000` 采样 |
| `PRODUCTION` | CP-SAT |

**CP-SAT 需双重门控**：`EWOH_SOLVER_ACTIVATION=PRODUCTION`（`:363`）**且** `EWOH_SOLVER_PRODUCTION_ENABLED=1`（`:354-356`）。未过门控时 fail-closed 回退 heuristic（`:443-447`，`fallbackReason=production_not_gated`）——**回退设计正确，不要改**。

> **推论：heuristic 是当前唯一生产主路径。任何 heuristic 的缺陷都是"正在发生"；CP-SAT 的缺陷是"开启前必须先修"。这是定级的硬依据。**

### 1.4 两条已完成的 P0 修复（勿重复做）

| commit | 内容 |
|---|---|
| `de5b1148` | heuristic 补齐 `LOCKED_STATION` 约束执行（含 `lockedStationByTask` 容器声明 + 消费点 + 复用路径校验 + 传参给 `buildCandidatePool`） |
| `0922b695` | `getActivePlans` 按 `strategy` 白名单隔离多域共用表 |

---

## 第二部分：强制工作准则（违反即作废）

### 准则 1：grep 不等于阅读

**禁止**用 `grep -c` / `awk` 的统计结果直接支撑架构判断。
这些只能用于**定位**，不能用于**结论**。

**本项目已付出 9 次纠错的代价**（全部记录在 `.workbuddy/memory/2026-10-03.md`）：

| # | 曾经的错误结论 | 根因 |
|---|---|---|
| 1 | "前端测试不在 CI" | 依据过期记忆未实查 |
| 2 | "页面孤岛/导航断裂" | `ls \| head -1` 取到子组件而非主页面 |
| 3 | "4 求解器各自重写约束" | 只数重复块，未读注释里的设计意图 |
| 4 | "部署形态分叉是债" | 未读 `resolveBootstrapMode` 的禁用逻辑 |
| 5 | "control N+1 有 30 处" | awk 未读控制流（实为 3 处） |
| 6 | "replan-coordinator 零测试" | glob 模式与实际命名不符（实为 11 个） |
| 7 | "裸 toLocaleString 全是数值格式化" | 看到前几个就外推（24 处中 15 处确为 Date） |
| 8 | "`proposed` 是越界状态值" | 只读 `PlanStatus` 就外推，漏了 `SchedulePlanStatus` |
| 9 | **"strategy 白名单应含 4 个求解器版本名"** | **把 `strategy` 与 `solver_version` 搞混** |

**准则 1 的执行形式**：每条结论必须能回答"我读到了哪几行"。
写不出行号的结论，标注为「推测，待核实」。

### 准则 2：子代理结论必须独立核实

**本项目子代理误报率约 1/3**，且包含**定性错误**（不只是细节错）：

| 子代理结论 | 核实结果 |
|---|---|
| "裸 Docker secrets 明文" | **误报**（`passwordFromSecretKeyRef` 正确接线） |
| "`startWorkflow` 不幂等" | **该符号在文件中不存在** |
| "workorder 列表无 org 过滤" | **误报**（三重防护），且符号大小写写错 |
| "19/21 处 subject 违规" | **高估**（实测 0 处） |
| "P0 属跨租户泄露" | **定性错误**（写入侧已设 orgId + actor 强制）→ 降级为"同租户内混淆" |

**核实清单**（每条子代理结论逐项过）：
1. `grep` 目标符号**是否存在**
2. 上下文条件是否成立（写侧是否已设值？调用链是否强制？）
3. 该路径**当前是否真被激活/使用**（定级前必查）
4. 定性（安全/正确性/性能）是否准确

### 准则 3：修复必须先红后绿，且要做变异测试

**禁止**先改实现再补测试（那会得到"永远绿"的假测试）。

**验收标准不是"测试通过"，而是"注入缺陷后测试变红"**：

```bash
# 变异测试：临时破坏实现，确认测试能捕获
cp <file> /tmp/bak
python3 -c "<把修复点改坏>"
jest <相关测试>    # 必须变红
cp /tmp/bak <file> # 恢复
jest <相关测试>    # 必须全绿
```

参考实例：`de5b1148` 的变异测试（移除 `LOCKED_STATION` case 体 → 精确 1 failed）、
`0922b695` 的变异测试（白名单首元素改 `heuristic-v2` → 4 failed）。

### 准则 4：派发任务书前核实每个事实断言

**错误写进任务书会被子代理执行放大**。准则 9 的教训：我在任务书里写"白名单应含 4 个求解器版本名"，子代理若照做会**把全部真实调度方案过滤掉**（比原 bug 更严重）。它拦下来了，但不该由子代理来兜底。

**任务书里"应该包含什么"这类描述最危险**，因为它听起来无害却决定实现方向。

### 准则 5：区分缺陷的"存在性"与"可达性"

- **存在但不可达** → 不排当前优先级（`A0-3` CP-SAT 丢三类约束即此类）
- **存在且正在生效** → 立即修（`A0-1`、`A1` 即此类）
- **存在但需产品裁决** → 列入待决，**不擅自决定**（`A0-2` 即此类）

### 准则 6：范围受限，不自行扩大

被派修一个缺陷时，**发现相邻问题要报告而不是顺手改**。
`fix-locked-station` 顺手补了 `buildCandidatePool` 传参（因为不补则修复无效），这是**正确的例外**——但它也明确报告了"未动 A0-2，因为超出范围"。

### 准则 7：不确定就标注，不推测填空

"待核实""无法定位""需产品确认"是合法结论。
子代理返回的符号若在当前文件不存在，**记为待核实并停止追踪**，不要用它构建新结论。

---

## 第三部分：阶段化实施计划

### 阶段 0：建立追踪表 + 回答 Q5（前置，0.5-2 小时）

**为什么先做**：Q5（边缘侧是否活跃）决定 4 条 P 级问题该不该做，杠杆最高。

**动作**：
1. 建 `docs/reading-log.md`，字段：`文件 | 行数 | 读完时间 | 异常分支数 | 未解疑点`
2. 逐行读 3 个文件（共 2,029 行）：
   - `src/edge_platform/run.py`（421 行）—— 入口装配与关停协议
   - `src/edge_platform/edge/manager.py`（498 行）—— 适配器注册与线程模型
   - `src/edge_platform/scheduler/scheduler_service.py`（1,110 行）—— advisory 边界与内存状态

**交付**：Q5 答案 + 依据行号。**Q5 未答不得进入阶段 3**（边缘侧相关全部挂起）。

**判断标准**：
- 边缘侧仍在演进（近 3 月有提交、有真实设备对接、advisory 建议被消费）→ C1~C4 需修
- 边缘侧已冻结/实验性/无部署 → **C1~C4 标为"不修"**，这本身是有价值的结论

### 阶段 1：调度域通读（生产主路径，约 5,700 行）

**为什么第一**：heuristic 是当前唯一生产主路径；A0-2 的裁决、约束统一方案、"还有没有第 4 个静默失效"都依赖它。

| 顺序 | 文件 | 行数 | 读它回答什么 |
|---|---|---|---|
| 1 | `server/modules/scheduler/heuristic-scheduling-solver.ts` | 2,157 | **完整 case 表**；除 `LOCKED_STATION` 外还有哪些 case 缺失/语义分歧；person/device 锁定的消费链是否完整 |
| 2 | `server/modules/scheduler/plan.service.ts` | 1,777 | 方案落库与状态机（`persistPlan` 硬编码 `strategy:'scheduling_v2'` 已在此 `:131`） |
| 3 | `server/modules/scheduler/world-state.service.ts` | 1,788 | 快照聚合；**数据正确性源头**（N+1 嫌疑点） |
| 4 | `server/modules/scheduler/scheduler-run-orchestrator.service.ts` | 385 | 主编排（虽小但串起全链，385 行性价比最高） |

**重点核对**（子代理报告，我未完整核实）：
- `heuristic:430-435` 优先级计算是 1 跳 vs `task-dag.ts:26` 传递闭包 → **语义不等价待证**
- `heuristic:660-664` 事件影响范围 vs `priority-engine.ts:274-292` 的 `eventImpacts` → heuristic 全文 `eventImpacts` grep 为 0，待证
- `heuristic:403-411` O(tasks × lockedAssignments) 扫描（同文件 `:414` 已建 Map，此处疑似漏改）
- `rule-based:162` while 循环 O(n²)（4 求解器中唯一无 fast-path）

**交付**：
- 完整约束 case 表（类型 × 求解器 × 判定语义 × 是否静默）
- **A0-2 的产品语义建议**（附证据，但**由用户裁定**）
- 修正或确认"A0-3 当前不可达"（若发现 CP-SAT 已被启用，立即上报）

### 阶段 2：控制域通读（约 5,000 行）

| 文件 | 行数 | 读它回答什么 |
|---|---|---|
| `server/modules/control/control.service.ts` | 3,273 | 3273 行真实拆分边界；N+1 是否真只有 3 处；状态机三套口径是否漂移 |
| `server/modules/work-orchestration/work-orchestration.service.ts` | 1,723 | 17 对 `*Durable`/legacy 双实现是否受控 |

**必须自己核实**（我只有片段）：
- `listPendingCommands:2572` / `:2692` / `expireBacklogCommands:1376` 三处 N+1（子代理修正过我的 30 处高估）
- 状态出口 `transitionCommand:887` 是否唯一
- `revokeUndeliveredCommand:2204-2229` 的 `runDetachedTransaction` 例外是否正确

### 阶段 3：数据层与多租户（视阶段 1/2 发现决定深度）

**优先级最高的未修项**（`ewoh_handoffs` 跨租户）：

| 位置 | 问题 |
|---|---|
| `db/migrations/standalone_004_ewoh_domain.sql:44-58` | `ewoh_handoffs` 表**无 `org_id` 列**（同文件 `ewoh_resource_locks:15` 有，说明是遗漏非设计） |
| `server/modules/work-orchestration/domain-persistence.service.ts:432-440` | `listHandoffs()` 全表 select 无 org 谓词 |

**前置**：需用户答 **Q2**（加列是破坏性变更；需确认现网数据量与回填策略）。
**同时核查** `ewoh_git_sync_state` / `ewoh_evidence_metadata` 是否同缺 `org_id`。

**加固项**（阶段 1 完成后附带）：
- `orgCondition` 12 份独立实现（其中 2 份 fail-open）→ 收敛为 `shared/org-condition.ts`
- `verifyToken` 的 `roles` 数组**未校验白名单**（`access-token.guard.ts:282-283` 只校验"是字符串数组"）
- `EWOH_DB_REQUIRE_TX=1` 生产未开 → 建议启动时断言

### 阶段 4：边缘侧（**Q5 答"要修" 才启动**）

| 文件 | 行数 | 优先级依据 |
|---|---|---|
| `src/edge_platform/edge/storage.py` | 1,571 | C1（`:311` 单 RLock 串行全部读写，覆盖 `:335/372/385/411/442/460`）＋ C3（`:494-516` TEXT ISO 双偏移族，每窗口查询翻倍） |
| `src/edge_platform/inference/pipeline.py` | 616 | C2（`:589` `_queue.Queue()` 无 maxsize，无背压）＋ A4（`:684` 存 `res.get("meta",{})` 而 pipeline 构造 `"meta"` **0 次** → `rules_fired`/`model_latency_ms`/`sensor_freshness` 全丢） |
| `src/edge_platform/scheduler/scheduler_service.py` | 1,110 | C4（`:161-164` 四 dict 无锁无淘汰） |
| `src/edge_platform/config.py` + `governance/purge_executor.py` | 135 + ≤200 | C3 根因：`data_retention_days`（`config.py:115`）**全仓仅 `tests/test_config.py:113` 引用**，`purge_executor.py` 未接入任何运行时 → 表无界增长 |

**A4 注意**：修它是"修 bug"还是"新增能力"取决于是否有下游消费者（**Q6**）。

### 阶段 5：低风险收敛（可与 1-4 并行）

| 项 | 位置 | 改动量 |
|---|---|---|
| B1 事件信封收敛 | 13 个 service / 88 处 `ADR-009` 标记 | 先建基线分类，再对齐，约 200 行 |
| B2 `buildEventEnvelope` 加校验 | `shared/event-envelope.ts:96-133` | 约 80 行 + 目录门禁 |
| B3 三套状态词表合并 | `shared/scheduler.ts:44-48`(4值) / `:88-98`(9值) / DDL CHECK | 从 DDL CHECK 生成 TS 联合类型，约 60 行 |
| B6 补 `resource-projection` 测试 | 1,257 行**实测零 spec** | 特征化测试，约 300 行 |
| C5 迁移链治理 | `.deploy/runtime/docker-compose.yml` 58 条 apply vs 214 sql | 改用 `standalone-chain.js --apply`，约 40 行 |
| A2 凭据清理 | `scripts/ecs-exec.sh:4-7` | 清理发布产物 + 打包白名单化（**轮换需人工**） |

---

## 第四部分：需用户决策的开放问题

**这些问题不答会阻塞对应工作。实施者遇到时应停下询问，不得自行决定。**

| # | 问题 | 阻塞 | 为什么必须用户答 |
|---|---|---|---|
| **Q1** | 生产 root 口令轮换 | A2 完整修复 | 涉及生产凭据，我不能代做。泄漏面已核实 6 处（本体已 gitignore 但**已进发布产物与记忆文件**） |
| **Q2** | `ewoh_handoffs` 是否加 `org_id` 列 | 阶段 3 | 破坏性变更；需确认现网数据量与回填策略 |
| **Q3** | **`LOCKED_ASSIGNMENT` 只传部分字段时是否应生效** | A0-2、约束统一方案 | **产品语义决策**。`constraints.ts:274-280`（各字段独立）与 `heuristic:356-361`（需齐全）现在行为矛盾，代码里无答案 |
| **Q4** | 终态语义：`shadow`/`superseded`/`cancelled` 是否都算终态 | 状态机统一 | 改变判定会变更现有行为。（我倾向：`shadow` 是旁路标记非终态；`superseded`/`cancelled` 都是终态。但需你确认） |
| **Q5** | **边缘侧（Python 7.3 万行）是否在支持范围** | 阶段 3/4 全部 | C1~C4 四条 P 级问题全在那里。若已停止演进，不该占当前优先级 |
| **Q6** | 推理富字段是否有下游消费者 | A4 | 决定它是"修 bug"还是"新增能力" |
| **Q7** | 历史遗留的 gamification 方案数据是否清理 | A1 后续 | 清需数据回填决策（清哪些、改成什么、是否影响已审批链）。**本轮明确不动** |

---

## 第五部分：已排除项（勿重复投入）

| 项 | 排除理由 |
|---|---|
| 前端时间格式收敛（41 处裸调用） | 其中 **15 处接收者确为 Date**（`Materials.tsx:47`、`ShiftWorkbench.tsx:318`、`learningConsoleLogic.ts:610/650` 等），会随浏览器时区漂移（实测 UTC 10:00 → NY 06:00 / SH 18:00，**差 12 小时**）。**此项需要做**，但优先级低于阶段 1-2 |
| 类型安全专项 | `any` 仅 15 处 / 9 文件。真正的杠杆是开 `strict`（当前 preset 里 `strict: false`），但那是一次性大爆炸，需单独立项 |
| 包装 `toLocaleString` 等标准 API | 会损失类型推断与 tree-shaking；只收敛其配置常量（已做：`client/src/lib/intl.ts`） |
| `constraint-compiler.ts` 删除 | 需先确认它是否真无消费者；且"单一事实源却绝不参与决策"是**契约层问题**，不是删文件能解决的 |
| 拆分 3273 行的 `control.service.ts` | 阶段 2 读完再定。现在拆等于盲拆 |

---

## 第六部分：交付物规范

每个阶段完成后必须产出：

1. **`docs/reading-log.md` 更新**（五要素固定格式：职责 / 入口 / 数据流 / 异常分支 / 未解疑点）
2. **修正或确认既有结论**——明确写"原结论 X，经读 N 行后**确认/推翻/修正为** Y，依据 file:line"
3. **新增发现**须附 file:line + 可复现路径
4. **不确定项**列入「待核实」，不用推测填空
5. **独立 commit**，message 里写清"为何这么改"与"边界为何这么划"（参考已入库的 8 个 commit）

**验收三件套**（每次修复）：
```bash
cd /Volumes/Extra/CodeProj/EWOH/ewoh-spark-app
./node_modules/.bin/tsc -b                                    # 期望 0 错误
./node_modules/.bin/jest --silent                              # 后端全量
./node_modules/.bin/jest --config client/jest.config.cjs --runInBand   # 前端全量
node scripts/gen-openapi.js --check                            # 契约漂移
```

---

## 第七部分：执行摘要（给执行者的一段话）

> 你接手的是 EWOH——一个约 60 万行的云端（NestJS + PostgreSQL）与边缘侧（Python + SQLite）双栈工业调度平台。当前基线 `ae636248`，`tsc -b` 0 错误，后端 421 套件/3731 用例、前端 177 套件/1751 用例全绿。
>
> **最重要的一件事**：此前的分析大量依赖 grep 统计与子代理报告，已实证子代理误报率约 1/3、分析者自身有 9 次误判（全部记录在 `.workbuddy/memory/2026-10-03.md`）。**你的首要任务不是继续找问题，而是把关键路径真正读一遍，验证或推翻既有结论。**
>
> **优先级由一个客观事实决定**：heuristic 是当前唯一生产调度器（`solver.service.ts:392` 缺省 `activation='OFF'`），CP-SAT 需双重环境变量门控。所以 **heuristic 的缺陷是"正在发生"，CP-SAT 的缺陷是"开启前必须先修"**。
>
> **遇到需要产品判断的（如 Q3 约束语义），停下询问，不要自行决定**——这类决策错了会改变业务行为，且无法靠技术手段回退。
>
> **修 bug 必须先写红测试、再改实现、再做变异测试**（注入缺陷确认测试会红）。"测试通过"不等于"测试有效"。
>
> 阶段 0 的 Q5（边缘侧是否活跃）决定 4 条 P 级问题的取舍，**先答它**。
