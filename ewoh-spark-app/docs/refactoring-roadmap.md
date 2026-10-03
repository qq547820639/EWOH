# EWOH 实施清单（第九轮 · 基于 9 个子代理并行分析 + 中心化核实）

> **本清单的每一条都经过我亲自读取代码核实。** 子代理结论未核实者一律标「待核实」。
> 生成时间：2026-10-03｜基线：`tsc -b` 0 错误｜后端 jest 420 套件 3722 用例｜前端 177 套件 1751 用例
> 分析范围：server 375 文件/10.0 万行、client 533 文件/12.2 万行、shared 55 文件/1.5 万行、**src/edge_platform 298 文件/7.3 万行**（此前七轮完全遗漏）

---

## 摘要：核实后的真实问题分布

| 级别 | 数量 | 说明 |
|---|---|---|
| 🔴 A 级（安全/正确性） | 5 | 含 1 个正在发生的用户可见故障、1 个凭据泄露 |
| 🟡 B 级（架构/可维护性） | 6 | 含约束语义三套实现、超大文件 |
| ⚪ C 级（性能/工程化） | 5 | 边缘侧性能债为主 |
| ❌ 已修复 | 3 | 5 周前报告已过期，勿重复做 |
| ⚠️ 待核实 | 4 | 子代理结论我未能定位或证伪 |

**核实率**：子代理结论约 **1/3 存在高估、误报或符号不准**（infra 误报 docker secret、control 符号 `startWorkflow` 不存在、business 误报 workorder 无 org 过滤且符号大小写错）。**中心化核实不可省。**

---

## 🔴 A 级 — 安全与正确性

### A0. 约束静默失效（调度域，最高优先）★调度域完整研读后新增

调度域实际规模 **84 文件 / 34,958 行**（此前误记为 29 文件 / 2.4 万行）。
经逐行核实，三个约束在生产主路径上**静默失效**——不报错、不记 violation、用户无感。

| # | 缺陷 | 位置 | 证据 |
|---|---|---|---|
| **A0-1** | heuristic **丢弃 `LOCKED_STATION`** | `heuristic-scheduling-solver.ts:344-381` | switch 无该 case，落 `default: break`；`lockedStationByTask` 变量**全文件 0 次**（连容器都没有）。而 `constraints.ts:31` 已把它列入 `SUPPORTED_HARD_CONSTRAINTS` → `checkConstraintSupported` 返回 supported → **不记 violation**。生产可达：OverridePanel LOCK_STATION → `scheduler-plan-application:502` |
| **A0-2** | heuristic `LOCKED_ASSIGNMENT` **需三字段齐全** | `heuristic:356-361` vs `constraints.ts:274-280` | IR/CP-SAT 三字段**各自独立**生效；heuristic 要求 `personId && deviceId` 齐全且**无 stationId 分支** → UI「更换资源」功能在默认求解器上完全无效；且 `override-preview:199-204` 预览显示"已改派"但实际未改 |
| **A0-3** | CP-SAT **不执行三类约束** | `cp-sat-scheduling-solver.ts` + `src/edge_platform/scheduler/cpsat/contract.py` | TS 侧 `isExcludedResource`/`excludedPerson`/`maxContinuousLoad`/`preferredPerson` **全 0 命中**；Python `contract.py` 含 `constraint` **0 命中** → `EXCLUDED_RESOURCE`/`PREFERRED_RESOURCE`/`MAX_WORKLOAD` 在 CP-SAT 路径既不生效也不报错，跨进程契约里字段根本不存在 |

**改动量**：A0-1 约 30 行（补 case + 变量 + 消费点）；A0-3 需动 TS↔Python `SolverRequest` 契约，约 100 行

**是否真在生产生效（我已核实激活阶梯，这决定优先级）**：
- `solver.service.ts:392` 缺省 `activation = cpSat?.activation ?? 'OFF'`
  → **heuristic 是默认且当前唯一生产主路径**
- CP-SAT 需**双重门控**：`EWOH_SOLVER_ACTIVATION=PRODUCTION`（:363）**且**
  `EWOH_SOLVER_PRODUCTION_ENABLED=1`（:354-356）；未过门控时 fail-closed 回退
  heuristic（:443-447，回退设计正确）

| 缺陷 | 当前是否生效 | 处置时机 |
|---|---|---|
| A0-1 heuristic 丢 LOCKED_STATION | 🔴 **正在生效**（heuristic 是主路径） | **立即修**（已派修） |
| A0-2 LOCKED_ASSIGNMENT 语义分歧 | 🔴 **正在生效** | 需先答 Q3 再定改法 |
| A0-3 CP-SAT 丢三类约束 | ⚪ **当前不可达**（CP-SAT 未激活） | **开启 CP-SAT 生产档之前必须先修**，不必现在做 |

**前置**：
- A0-1 **无需裁决**（漏实现，已在支持词表）→ 已派修
- A0-2 **需产品裁决**（见 Q3）——`constraints.ts` 与 heuristic 哪个是产品意图，代码里无答案
- A0-3 修法明确（补 `SolverRequest` 字段或 TS 侧预过滤，比照 `MIN_BATTERY` `:258-260`），但排序靠后

### A1. 活跃方案列表混入非调度方案【用户可见，正在发生】
- **涉及文件**：`server/modules/scheduler/scheduler-query.service.ts:284-303`（`getActivePlans`）
- **问题**：只按 `status IN ACTIVE_PLAN_STATUSES` 过滤，无 `strategy` 过滤。而 `gamification.service.ts:297/485` 写入 `status:'proposed'`、策略为 `resource_alloc`/`task_orchest` 的行，且 `proposed` 在 `scheduler-query.service.ts:80` 属活跃态 → 前端"活跃调度方案"列表出现非调度方案
- **影响**：UI 污染、活跃方案指标失真
- **改动量**：单方法 + 1 测试，约 20 行
- **前置**：无（已授权派修）
- ⚠️ **不是跨租户泄露**：`gamification:312` 已显式设 `orgId`（NEST-330），`assertActorForHttp:115-121` 强制 actor。子代理最初定性错误，已纠正

### A2. 生产凭据明文硬编码 + 已扩散到发布产物
- **涉及文件**：`scripts/ecs-exec.sh:4-7`
- **问题**：root 密码明文 + `StrictHostKeyChecking=no`（可被中间人劫持）+ 生产 IP 硬编码
- **扩散面（实测 6 处）**：本体（`.gitignore:71` 已排除 ✅）→ **已进 `output/release-bundles/`（含递归嵌套）** → 已进我的记忆文件
- **影响**：凭据从未轮换，已泄漏 ≥5 周
- **改动量**：轮换口令（需人工）+ 清理产物 + 打包白名单化 `output/`
- **前置**：**需你决策**——轮换生产口令我不能代做
- ⚠️ 发布包存在**递归嵌套**（`rsync -a output/` 把产物打进产物自身）

### A3. `ewoh_handoffs` 表无 `org_id` 且查询无谓词
- **涉及文件**：`db/migrations/standalone_004_ewoh_domain.sql:44-58`（表定义）、`server/modules/work-orchestration/domain-persistence.service.ts:432-440`（`listHandoffs`）
- **问题**：表**无 `org_id` 列**（同文件 `ewoh_resource_locks:15` 有，说明是遗漏）；`listHandoffs()` 全表 select 无 org 谓词
- **影响**：全租户数据可读（**待确认是否有 RLS 兜底**）
- **改动量**：加列迁移 + 查询加谓词，约 60 行 + 1 迁移
- **前置**：需确认现网数据量与是否需回填 org_id

### A4. 推理富字段静默丢弃
- **涉及文件**：`src/edge_platform/edge/storage.py:684`、`src/edge_platform/inference/pipeline.py`
- **问题**：`insert_inference` 取 `res.get("meta", {})`，而 `pipeline.py` 构造 `"meta"` 键 **0 次** → `rules_fired`/`model_latency_ms`/`sensor_freshness` 全丢
- **影响**：规则风暴与性能诊断能力实际不存在（字段静默丢失）
- **改动量**：pipeline 侧补 meta 构造，约 30 行
- **前置**：需先确认下游是否已有消费者（若无人消费，补字段是"新增能力"而非"修 bug"）

### A5. `resourceType` 无任何约束 + 求解器静默忽略 → 容量超卖
- **涉及文件**：`db/migrations/standalone_017_scheduling_tables_fix.sql:35`、`shared/scheduler.ts:460`、`server/modules/scheduler/heuristic-scheduling-solver.ts:612-628`
- **问题**：三层全缺——① DB `varchar(50) NOT NULL` 无 CHECK；② 契约层 `resourceType: string` 非联合类型；③ 求解器 if/else-if 链**无 else 兜底**
- **影响**：未知类型（如 `'tool'`）落库后被求解器忽略 → 容量超卖（**静默**，无告警）
- **改动量**：DDL CHECK + 联合类型 + else 兜底，约 40 行
- **前置**：需确认现网是否已有非法值（否则加 CHECK 会失败）

---

## 🟡 B 级 — 架构与可维护性

### B1. 约束语义三套实现，测试无法发现分歧
- **涉及文件**：`shared/scheduler.ts`（或 `constraints.ts:184-315`）、`heuristic-scheduling-solver.ts:335-380`、`constraint-compiler.ts`
- **证据**：`constraints.ts:180-181` 自述"消除静默忽略约束"的共享 IR；`constraint-compiler.ts:4-5` 自述"单一事实源"但明写"**绝不参与决策逻辑**"；heuristic 自成一套内联 switch
- **已确证分歧**：`LOCKED_ASSIGNMENT` 只传部分字段时，`constraints.ts:274-280` 各字段**独立生效** vs `heuristic:356-361` 要求三者**齐全才生效**且无 `stationId` 分支
- **为何长期未发现**：`hard-constraints.spec.ts:332` 测试**只测三字段齐全**的用例，恰好绕过分歧点
- **改动量**：先补测试（各约束类型的部分输入），约 150 行；再统一实现
- **前置**：需**业务裁决**——"部分锁定是否应生效"

### B2. `buildEventEnvelope` 零校验
- **涉及文件**：`shared/event-envelope.ts:96-133`
- **问题**：允许 `subject: null`、`eventType`/`occurredAt` 为裸 `string`，无任何运行时校验
- **实测**：20 个调用点**实际 0 处传 null**（子代理报"19/21 违规"**高估**）
- **真实问题**：防御性缺失 + CI 无门禁（`audit-event-catalog.js` 不检查 subject）
- **改动量**：加校验 + 目录加门禁，约 80 行
- **前置**：需裁决"历史数据已有 null 时，校验应 fail-closed 还是 fail-open"

### B3. 三套状态词表描述同一张表
- **涉及文件**：`shared/scheduler.ts:44-48`（`SchedulePlanStatus` 4 值）、`:88-98`（`PlanStatus` 9 值）、`db/migrations/standalone_017:17-22`（DDL CHECK）
- **问题**：三处独立维护，无单一事实源；`SchedulePlan.status: SchedulePlanStatus | string`（`:55-56`）被迫放宽
- **影响**：新增状态需改三处，漏改即不一致
- **改动量**：从 DDL CHECK 生成 TS 联合类型，约 60 行
- **前置**：需确认两个 TS 词表能否合并（语义可能确实不同）

### B4. `control.service.ts` 3273 行待拆分
- **涉及文件**：`server/modules/control/control.service.ts`
- **拆分边界（子代理给出，已核实方法数与依赖）**：投递与回执(≈500)/命令 CRUD(≈600)/设备绑定(≈400)/请求与聚合(≈400)/巡检(≈500)/能力与台账(≈300)/孤儿请求(≈300)/授予与撤回(≈200)
- **前置**：开 `noImplicitAny`（会暴露约 300 处隐式 any）
- **风险**：中间 seam（CAS 落点、环境与 GUC 变量、审计/事件写入）是高耦合点

### B5. 事件信封样板散落 13 个 service
- **证据**：88 处 `ADR-009/standalone_066` 标记；16 个 12 行块被 13 个 service 共享
- **已有封装**：`buildEventEnvelope` / `envelopeForEvidence`
- **改动量**：先建基线分类（88 处逐个），再对齐，约 200 行改动 + 1 工具
- **前置**：无（低风险，可并行做）

### B6. `resource-projection.service.ts` 1257 行零测试覆盖
- **涉及文件**：`server/modules/scheduler/resource-projection.service.ts`
- **问题**：**实测 0 个 spec**（`find` 确认为 0）
- ⚠️ 我此前说 `replan-coordinator` 也零覆盖是**错的**——实测有 **11 个** `replan-*` spec
- **改动量**：补特征化测试，约 300 行

---

## ⚪ C 级 — 性能与工程化（均来自 5 周前报告，已核实仍存在）

| # | 位置 | 问题 | 核实 |
|---|---|---|---|
| C1 | `edge/storage.py:311` | 单个 `RLock` 串行全部读写（覆盖 :335/372/385/411/442/460） | ✅ 仍存在 |
| C2 | `inference/pipeline.py:589` | `_queue.Queue()` 无 `maxsize`，无背压 | ✅ 仍存在 |
| C3 | `config.py:115` | `data_retention_days` 无消费者（仅 `tests/test_config.py:113`）→ 表无界增长 | ✅ 仍存在 |
| C4 | `scheduler/scheduler_service.py:161-164` | 四个内存 dict 无锁无淘汰 | ✅ 仍存在 |
| C5 | `.deploy/runtime/docker-compose.yml` | 迁移链 58 条 apply vs `db/migrations/` 214 sql，**无逐条 `--apply-standalone-NNN`**，靠手工同步 | ✅ 仍存在 |

---

## ✅ 已修复（勿重复做）

| 原报告结论 | 现状 | 证据 |
|---|---|---|
| R7 `_append_denied` 死代码 | **已修复** | `pipeline.py:323/335` 已调用 |
| P0-5 `SHA256SUMS` 为占位 | **已修复** | 现为真实 sha256 |
| P0-6 helm 迁移 Job 硬编码 001..005 | **已修复** | 改用 `--apply-standalone` 消费完整链 |

---

## ⚠️ 待核实（我不采信，交由你判断是否投入）

1. **历史数据修复**：`getActivePlans` 修好后，历史页/看板仍会展示 gamification 方案（数据仍在库）。清理需**产品决策**（清哪些、改成什么、是否影响已审批链）
2. **方案排序缺陷**（sched-domain 发现但未修）：同 `createdAt` 时跨 status 顺序不稳定
3. **`CAMP` 相关疑似 bug**：符号在当前文件已不存在，无法定位
4. **敏感 env 未设 `required`**、`tls.internal.secret` 12 天过期（infra 代理，核实成立但影响面待定）

---

## 需要你确认的开放问题

| # | 问题 | 为什么需要你决策 |
|---|---|---|
| Q1 | **生产口令轮换**（A2） | 涉及生产凭据，我不能代做 |
| Q2 | `ewoh_handoffs` 加 `org_id` 列（A3） | 破坏性变更；需确认现网数据量与回填策略 |
| Q3 | **"部分锁定"是否应生效**（B1） | 这是产品语义决策，不是技术选择。`constraints.ts` 与 `heuristic` 现在行为不同，**必须裁定哪个对** |
| Q4 | 终态语义（B1 相关）：`shadow`/`superseded`/`cancelled` 是否都算终态 | 影响状态机判定，变更会改变现有行为 |
| Q5 | 边缘侧是否算"在支持范围"（C1~C4 全在 Python 侧） | 若边缘侧已停止演进，这些 P0/P1 不该占当前优先级 |
| Q6 | A4 是否已有下游消费者 | 决定它是"修 bug"还是"新增能力" |

---

## 执行顺序建议

**第 1 批（本周，只做已授权的）**
1. A1 活跃方案口径修复（已派发，含失败→通过对照）
2. 三轮重构成果提交（29 文件，拆 3 commit）—— 保住已有工作
3. `gen:openapi:check` 漂移同步 + 补跑 9 类闸门（含 `test:browser:mock` 关闭渲染盲区）

**第 2 批（需先答 Q3/Q4）**
4. B1 约束语义统一（先补能红的测试，再改实现）

**第 3 批（需先答 Q2）**
5. A3 `ewoh_handoffs` org 隔离
6. A5 `resourceType` 三层约束

**第 4 批（需先答 Q5/Q6）**
7. C1~C4 边缘侧性能债
8. A4 推理字段

**第 5 批（低风险，可并行）**
9. B5 事件信封收敛、B2 信封校验、B6 补测试、C5 迁移链治理

---

## 附：本轮方法论教训（8 次自我纠错）

| # | 我的错误 | 根因 |
|---|---|---|
| 1 | "前端测试不在 CI" | 依据过期记忆未实查 |
| 2 | "页面孤岛/导航断裂" | `ls \| head -1` 取到子组件 |
| 3 | "4 求解器各自重写约束" | 只数重复块，未读注释里的设计意图 |
| 4 | "部署形态分叉是债" | 未读 `resolveBootstrapMode` 的禁用逻辑 |
| 5 | control N+1 **30 处** | awk 未读控制流（实为 3 处） |
| 6 | "replan 零测试" | glob 模式与实际命名不符（实为 11 个） |
| 7 | "裸 toLocaleString 全是数值" | 看到前几个就外推（15 处确为 Date） |
| 8 | "`proposed` 是越界状态值" | 只读 `PlanStatus` 就外推，漏了 `SchedulePlanStatus` |

**共同根因：用模式匹配替代阅读。** grep/awk/glob 给出的数字看起来精确，
但我从未验证"取样对象是否是我以为的那个"。这 8 次错误已全部落盘项目记忆，
作为后续自查清单。
