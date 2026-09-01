# PRD 可开发性评估 — 对象工作台（Object Workbench）

> 评估人：工程视角 ｜ 日期：2026-09-01 ｜ 评估对象：`docs/product/PRD-object-workbench.md` v1.0
> 方法：逐项验证 P0 需求的技术前提，**所有结论附 `file:line` 证据**，不依赖文档自述。

---

## 结论先行

**不建议按当前版本直接开工，但无需重写 PRD。**

PRD 的产品判断（选 A 做对象工作台）成立，价值逻辑自洽。但经代码验证，
存在 **3 个技术事实错误** 与 **2 个契约缺口**——照当前文档开发，会出现
「改了文件但功能上线零效果」「创建审批被服务端 400 拒绝」这类返工。

**修正成本约 1 天（纯文档，不动代码），之后即可开工。**

---

## 一、三个技术事实错误（必须修正）

### E-1 · OD-1 落点文件错误【严重】

| 项 | 内容 |
|----|------|
| PRD 写的 | `server/modules/approval/approval.service.ts` `createApproval` 增加可选 `subject` |
| 实际 | 该文件已 `@deprecated`，**不接 HTTP** |
| 证据 | `approval.service.ts:18-25` 文件头：「Synchronous in-memory approval service…**不接 HTTP、无 org/角色校验**——生产路径一律使用 ApprovalPersistenceService」 |
| 真实落点 | `approval.controller.ts:18-19` 注入的是 `ApprovalPersistenceService` → `approval-persistence.service.ts:155` `createApproval`，数据写入 `ewohEvent.evidenceJson`（`:206-212`） |

**后果**：照 PRD 改动会落在一个无人调用的废弃内存服务上，功能上线零效果。

#### 但真实落点比 PRD 估计的更简单（利好）

| 项 | 实际情况 | 对 PRD 的影响 |
|----|---------|-------------|
| 存储结构 | `evidenceJson` 是 JSON 列（`:206`） | 加字段**无需 DB 迁移** |
| 读取路径 | `listPending`（`:145-151`）已从 `evidenceJson` 取值 | 返回体加 `subject: evidence.subject ?? null` 一行即可 |
| 存量数据 | 老行无 `subject` → `?? null` | **天然兼容，PRD 风险 R-2「存量回填」可直接消除** |

→ 建议：PRD 中 R-2 风险项降级为「无需处理」，Q-2（是否回填存量）关闭。

**附带发现**：`approval-persistence.service.ts:193` 落库标题为
`title: \`Approval for ${entityType} ${entityId}\``——存进 DB 的就是裸 ID，可随 OD-1 一并改为 `subject.title`。

---

### E-2 · `ObjectDescriptor.objectType` 枚举与实际白名单不匹配【严重】

| 项 | 内容 |
|----|------|
| PRD 写的 | `'scheduling_plan' \| 'work_order' \| 'device' \| 'person' \| 'alert'` |
| 实际白名单 | `APPROVAL_ROLE_POLICY`（`approval-persistence.service.ts:38-46`）**仅三个键**：`task`、`dangerous_action`、`control_request` |
| fail-closed | `:173-178` — 未登记 `entityType` 直接抛 400：`Unknown approval entityType` |

**后果**：按 PRD 类型定义创建审批会被服务端 400 拒绝，五个类型**无一可用**。

**修正建议**：`objectType` 对齐白名单；若确需扩展对象类型，须同步在 `APPROVAL_ROLE_POLICY` 登记
（这是 fail-closed 设计，属于有意为之的安全约束，不可绕过）。

---

### E-3 · 「调度方案审批」这个需求前提不成立【严重，影响用户故事】

| 项 | 内容 |
|----|------|
| PRD 假设 | 审批台承载「调度方案审批」，审批人看不懂在批哪个方案（US-3 / US-4） |
| 实际 | **调度方案根本不进 approvals 系统** |

证据链：

1. 审批的创建方只有两个（`createApproval(` 全仓调用点）：
   - `approval.controller.ts` — HTTP `POST /api/approvals`
   - `control.service.ts` — `entityType: 'control_request'`（高危物理控制指令，INV-005）
2. 白名单内 `task` / `dangerous_action` / `control_request` **均非调度方案**（E-2）
3. 调度方案走的是**另一套**：`Scheduling.tsx:394-417` → `/api/scheduler/plans/:id/approve`（整方案批准，无会签）
4. 前端 `approvalConsoleLogic.ts:47` 把**所有非 agent 审批一律标为**「调度审批：${entityType} ${entityId}」

→ **「调度审批」是前端文案误导**：审批台里实际躺的是 `control_request`（高危控制指令）等，
却被标成"调度审批"。裸 UUID 问题**依然成立且更严重**——用户看到的标签本身还是错的。

**后果**：PRD 的 US-3 / US-4（班组长审批方案）场景需重写。
但这**不推翻需求价值**——恰恰相反，"审批对象不可辨识"的问题被证实存在于
`control_request` 这类**安全关键**审批上，优先级应当**上调**。

> 修正方向：把 PRD 场景从「审批调度方案」改为「审批高危控制指令 / 任务 / 危险作业」，
> 或明确将调度方案接入 approvals 系统（需产品决策，涉及 fail-closed 白名单扩展）。

---

## 二、两个契约缺口（需后端补充）

### G-1 · OD-6「异步可见」缺少生成状态字段【阻塞】

| 项 | 内容 |
|----|------|
| 现状契约 | `shared/scheduler.ts:1192-1194` 仅 `aiNarration?: string \| null` 与 `narrationSource?: 'llm' \| 'rule_fallback' \| null` |
| 缺失 | **无任何生成状态字段** |
| 生成机制 | `scheduling-narrator.service.ts:9`「异步调用（调用方 **fire-and-forget**），绝不阻断方案生成/审批响应」；仅在完成后 `persist()`（`:153`），**无中间态** |

**后果**：前端 `Scheduling.tsx:184` 的 `row.aiNarration && (...)` 在 `null` 时无法区分：

- 还在生成中（30–90s 窗口内，尚未 persist）
- 生成失败且规则兜底也失败
- 该功能未启用

→ **OD-6 无法由前端单独实现**，属 PRD 未识别的后端依赖。

**建议方案**（改动小）：plan 增加 `narrationStatus: 'pending' | 'done' | 'failed'`，
创建方案时置 `pending`，`persist()` 后置 `done`，异常路径置 `failed`。
后端约 1d，前端渲染约 0.5d。

### G-2 · OD-5「已过期」不是持久状态【实现澄清，非阻塞】

| 项 | 内容 |
|----|------|
| 状态枚举 | `shared/scheduler.ts:77-85` `PlanStatus` 共 8 态：`draft / shadow / approved / dispatched / executing / completed / rejected / superseded` |
| 关键 | **没有 `stale` / `expired`** |
| 「已过期」本质 | 操作时的 **409 `PLAN_STALE` 错误响应**（`Scheduling.tsx:117-123` `isPlanStaleError`），不是 `row.status` 的取值 |

**后果**：开发若按 PRD 表格去找 `status === 'stale'` 会一无所获。
必须实现为 **mutation 错误分支**（捕获 409 + 消息含 `PLAN_STALE`），而非状态渲染分支。

---

## 三、技术前提验证汇总

| PRD 项 | 验证点 | 结论 | 证据 |
|--------|--------|------|------|
| OD-1 | 生产 service 定位 | ❌ **落点错误** | `approval.service.ts:18-25` / `controller:18-19` |
| OD-1 | 是否需 DB 迁移 | ✅ 优于预期 | `evidenceJson` JSON 列（`:206`） |
| OD-1 | 存量兼容 | ✅ 天然兼容，R-2 可关闭 | `:145-151` `?? null` |
| OD-1 | objectType 白名单 | ❌ **枚举不符** | `:38-46` / `:173-178` |
| OD-2 | 路由可加 | ✅ 成立 | `app.tsx` 现有 20 条路由，新增 1 条无风险 |
| OD-3 | plan 详情 API | ✅ 已就绪 | `api/scheduler.ts:139` `getPlan(planId)` |
| OD-3 | 状态机枚举 | ✅ 成立（8 态） | `shared/scheduler.ts:77-85` |
| OD-4 | 依赖 OD-1 | ⚠️ **阻塞** | 需先修 E-1 / E-2 |
| OD-5 | 终态映射 | ✅ 成立 | 8 态明确 |
| OD-5 | 「已过期」态 | ⚠️ **需澄清** | G-2，非持久状态 |
| OD-6 | 生成状态字段 | ❌ **缺失，需后端** | `shared/scheduler.ts:1192` |

**统计：成立 5 项 · 错误 3 项 · 阻塞 2 项 · 需澄清 1 项**

---

## 四、开工切分建议

### 可立即开工（纯前端，零后端依赖）

| 项 | 说明 |
|----|------|
| OD-2 对象路由 | 加 1 条路由 |
| OD-3 工作台骨架 | `getPlan` 已就绪，状态机 8 态明确 |
| OD-5 终态行动条 | 8 态映射即可；「已过期」走 409 错误分支（G-2） |
| OD-7 指标卡 | 纯渲染改造 |

### 需后端配合（阻塞，建议并行启动）

| 项 | 后端工作量 | 说明 |
|----|-----------|------|
| OD-1 | **0.5d** | 改 `approval-persistence.service.ts` 两处，无迁移 |
| OD-4 | — | 依赖 OD-1 |
| OD-6 | **1d** | 新增 `narrationStatus` 字段与状态流转 |

### 需先修文档（否则开发走偏）

- E-1 落点（OD-1）
- E-2 objectType 枚举（OD-1）
- E-3 场景重写（US-3 / US-4）—— **需产品决策**

---

## 五、工作量估算

| 任务 | 前端 | 后端 | 备注 |
|------|------|------|------|
| OD-1 对象描述符 | — | 0.5d | 两处加字段，无迁移 |
| OD-2 对象路由 | 0.5d | — | |
| OD-3 工作台骨架 | 2–3d | — | 骨架 + 4 个 tab |
| OD-4 审批台接入 | 0.5d | — | 依赖 OD-1 |
| OD-5 终态行动条 | 1d | — | 含 409 分支 |
| OD-6 异步可见 | 0.5d | 1d | |
| OD-7 指标卡 | 1d | — | |
| 埋点（PRD §7 要求） | 1d | — | **不可省略，否则无法验证价值** |
| 单测 + E2E | 1.5d | — | 沿用 `navigation.ia.test.ts` 防回归惯例 |
| **合计** | **≈ 8d** | **≈ 1.5d** | **约 2 周**（1 前端 + 后端兼任） |

---

## 六、建议的下一步

| 顺序 | 动作 | 耗时 | 说明 |
|------|------|------|------|
| 1 | 修正 E-1 / E-2（技术事实纠错，无争议） | 0.5d | 可直接改 PRD |
| 2 | E-3 产品决策：场景重写 **或** 把调度方案接入 approvals | 待定 | **需产品拍板**，涉及 fail-closed 白名单 |
| 3 | 后端确认 G-1（`narrationStatus`）与 G-2（409 分支口径） | 0.5d | |
| 4 | 前端启动 OD-2 / OD-3 / OD-5 / OD-7，与后端并行 | — | 不依赖后端 |

---

## 七、评估中排除的误判（存档，避免重复排查）

| 一度怀疑 | 核实结果 |
|---------|---------|
| `resource_lock` / `parameter` 不在审批白名单 → 现存 bug | ❌ 误判。二者是 `appendAuditLog` 的 `entityType`（`parameters.service.ts:323`、`work-orchestration.service.ts:757`），与审批系统无关 |
| 审批实例存内存、重启丢失、无法存量回填 | ❌ 不适用于生产路径。生产走 `ApprovalPersistenceService`，落 `ewoh_event` + `ewoh_event_chain` 同事务（`:187-223`，R2-SMI-004） |

---

# 八、v1.1 复评（2026-09-01，对象：PRD v1.1）

> 上表第一至七章针对 v1.0。PRD 已升级 v1.1 并声称修正 C-1~C-8，本章**重新验证修正是否落地**，
> 不采信文档自述。

## 8.1 结论

**✅ v1.1 可以进行开发任务。** 前次 3 项错误 + 2 项缺口已全部修正到位，**无遗留阻塞项**。
唯一需开工前定夺的是 T3 的一处设计-数据不匹配（§8.3），不阻塞但会造成返工。

## 8.2 修正落实验证

| 声称修正 | 验证结果 | 证据 |
|---------|---------|------|
| C-1 OD-1 落点改 persistence service | ✅ **落实** | `approval.controller.ts:18-19` 注入 `ApprovalPersistenceService` |
| C-2 无需 DB 迁移 | ✅ **落实，且优于预期** | `schema.ts` — `evidenceJson: jsonb("evidence_json")`，**无 `$type<>()` 约束** → 加字段连 TS 类型都不用改 |
| C-3 存量 `?? null` 兼容 | ✅ **落实** | `approval-persistence.service.ts:145-151` 已从 `evidence` 取值并 `?? null` |
| C-4 objectType 对齐白名单 | ✅ **落实** | `APPROVAL_ROLE_POLICY:38-46` 恰为 `task` / `dangerous_action` / `control_request` |
| C-7 OD-6 需后端 `narrationStatus` | ✅ **缺口属实，已正确标注为后端任务** | `shared/scheduler.ts:1192-1194` 确无状态字段 |
| C-8 「已过期」为 409 分支 | ✅ **落实** | `PlanStatus` 8 态（`:77-85`）无 stale |
| C-5 / C-6 US-3·US-4 场景改写 | ✅ **属文档层修正，与代码一致** | 方案走 `/api/scheduler/plans/:id/approve`，不进 approvals |

> **工作量微调**：C-2 验证结果表明 T1 比 PRD 估计更简单——jsonb 无类型约束，
> 改动形式为「对象字面量加一个键」。**T1 实际约 0.25d**（含 `:193` title 改造与单测），
> PRD 的 0.5d 偏保守，可释放出约 0.25d。

## 8.3 新发现：T3 头部设计 2/4 字段不存在

PRD §5.2 对象工作台头部要求呈现「**责任人** · 触发源 · 更新时间 · **数据来源徽章**」。
逐字段核对 `SchedulingPlanV2`（`shared/scheduler.ts:1162-1224`）：

| 设计字段 | 是否存在 | 证据 |
|---------|---------|------|
| 触发源 | ✅ 存在 | `trigger: { type, entityId }`（`:1169`） |
| 时间 | ⚠️ 仅创建时间 | `createdAt: string`（`:1209`），**无 updatedAt** |
| **责任人** | ❌ **不存在** | 全接口无 `owner` / `operator` / `createdBy` / `assignedTo` |
| **数据来源徽章** | ❌ **不存在** | 无 `sourceType` / `dataSource`（Devices、RoleWorkbench 有，schedule plan 无） |

**这不是阻塞项**，但开发照设计实现时会卡住或自行发挥——建议开工前定夺。

### 建议：用现成高价值字段替代，不新增后端依赖

`SchedulingPlanV2` 已有且更有信息量的字段：

| 建议替换 | 字段 | 价值 |
|---------|------|------|
| 「责任人」→ **求解状态** | `solverStatus` + `fallbackReason`（`:1176-1178`） | 直接告诉用户这版方案是 CP-SAT 最优解**还是降级回退**——工业场景比"谁创建的"更关键 |
| 「数据来源徽章」→ **约束违反** | `violations: Array<...>`（`:1208`） | 一眼看到方案是否存在硬约束违反 |
| 「更新时间」→ 创建时间 | `createdAt`（`:1209`） | 语义改为"生成于"，避免误导 |

若坚持保留「责任人 / 数据来源」，需后端在 plan 上补字段——**属于新增依赖，建议放到 P1 或后续增强**。

## 8.4 开工条件检查

| 条件 | 状态 |
|------|------|
| 技术错误已清零 | ✅ |
| 后端依赖已明确且可控 | ✅（T1 0.25d、T5 1d） |
| 前端可独立启动项 | ✅（T2 / T3 / T4 / T8） |
| **T3 头部字段方案定夺** | ⚠️ **建议开工前确认**（0.5 小时，非阻塞） |
| Q-1 首批对象范围拍板 | ⚠️ 建议开工前（PRD 已建议 `scheduling_plan` 单种） |
| Q-6 埋点归属 | ⚠️ 建议开工前 |
| Q-5 用户访谈 | 不阻塞开工，**阻塞灰度放量** |

## 8.5 复评后工作量

| 任务 | 前端 | 后端 | 变更说明 |
|------|------|------|---------|
| T1 OD-1 | — | **0.25d** | ↓ 从 0.5d（jsonb 无类型约束） |
| T2 / T3 / T4 / T6 / T7 / T8 | 5–6d | — | 不变 |
| T5 OD-6 | — | 1d | 不变 |
| T9 埋点 | 1d | — | 不变 |
| T10 测试 | 1.5d | — | 不变 |
| **合计** | **≈ 8d** | **≈ 1.25d** | **约 2 周**（与 v1.1 估算一致） |
