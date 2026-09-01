# J2 风险旅程 PRD — 可开发性评估

> 评估人：工程视角 ｜ 日期：2026-09-01 ｜ 对象：`docs/product/PRD-risk-journey.md` v1.0
> 方法：逐项验证 PRD 声称的技术前提，**不采信文档自述**，所有结论附 `file:line`。

---

## 结论先行

**流程上：不具备开工条件（按 PRD 自身的 Gate 约定）。**
**技术上：可以开发，且优于 PRD 预期——但发现 2 个 PRD 未覆盖的技术问题，其中 1 个严重。**

| 维度 | 结论 |
|------|------|
| **Gate（产品决策）** | ❌ G-1（埋点 2 周基线）、G-2（3–5 场访谈）**均未达成**——按 PRD §0 约定不得开工 |
| **技术可行性** | ✅ 可行 |
| **PRD 自述的"最大不确定性"** | ✅ **已消解**（Q-R1 有解，详见 §1） |
| **PRD 未覆盖的技术问题** | ⚠️ **2 个**（E-1 严重、E-2 中），详见 §2 |

> 这两个维度互不替代：**Gate 未达成是"该不该做"的问题，技术问题是"做的时候会踩什么坑"**。
> 即便 Gate 达成，E-1 也必须先解决，否则新页面会复制一个现存缺陷。

---

## 1. 好消息：Q-R1（PRD 标为最大不确定性）已消解

PRD §10 Q-R1 写道：「是否有告警详情 API？……**这是本 PRD 最大的不确定性**」。
经核实：**该 API 已存在**。

| 项 | 事实 | 证据 |
|----|------|------|
| 详情端点 | `@Get(':id')` → `getAlert(id, userContext)` | `server/modules/alert/alert.controller.ts:22-29` |
| 租户守卫 | `assertTenantVisible(row.orgId, actor, ...)`，跨租户拒绝 | `alert.service.ts:134` |
| 列表端点 | `@Get()` 带 `limit` / `since` 分页（clamp 1–500，默认 24h 窗口） | `alert.controller.ts:9-20`、`alert.service.ts:88-94` |
| 状态转移端点 | `@Post(':id/state')?action=` | `alert.controller.ts:31-38` |
| **设备关联字段** | `ewohEvent` 表**有** `device_id` 列 | `server/database/schema.ts:202` |

**影响**：

- PRD §9 RR-2 的缓解方案（"先做头部+流程带+关联，概览留空态"）**不需要启用**——
  详情数据可用，`概览` tab 可正常实现。
- PRD §5.3 RK-4（关联设备下钻）数据可用，`resolveObjectRoute('device', id)` 可直接使用。
- 前端缺口仅一项：`api/alerts.ts` 需补 `getAlert`（当前只有 `listAlerts` / `transitionAlert`）。

---

## 2. 新发现的两个技术问题

### E-1 · 动作区"复用 `actionFor`"会复制一个现存缺陷【严重】

#### 后端：状态机是角色感知 + fail-closed

`shared/alert-state-machine.ts`（ADR-031 单一事实源，有独立 spec `shared/alert-state-machine.spec.ts`）：

| 转移 | 允许角色 | 证据 |
|------|---------|------|
| `open → acknowledged` | **`handler`** | `alert-state-machine.ts:14-16` |
| `acknowledged → processing` | **`handler`** | `:17-19` |
| `processing → closed` | **`handler`** | `:20-22` |
| `closed → reopened` | **仅 `safety_admin`** | `:23-25`（唯一专属角色） |
| `reopened → acknowledged` | **`handler`** | `:26-29` |
| `reopened → processing` | **`handler`** | `:26-29` |
| 任何转移 | **无角色 → 拒绝（fail-closed）** | `roleSatisfies` `:39-44`、spec `:24`/`:28-29` |

**`handler` = `{ dispatcher, workshop_lead, device_ops }`**（`HANDLER_ROLES`，`:32-34`）。

> ⚠️ **勘误（2026-09-01）**：本表初版误写为「每个转移对应一个专属角色」
> （如 `open→acknowledged` 仅 `dispatcher`）——那是把 spec `:16-18` 的**示例用例**
> 当成了排他规则。实际三者皆可执行 handler 转移，**只有 `reopen` 是 `safety_admin` 专属**。
> 缺陷结论不受影响（见下），但具体表现已修正。

后端服务层同样强化：`nextAlertStatusForActor()` 在 `alert.service.ts:43-64`
按 `actor.roles` 逐项校验，不匹配返回 `null` → **400 Bad Request**；
`global_admin` 由 `:54-56` 单独短路放行。

#### 前端：`actionFor` 完全不感知角色

- `Alerts.tsx:15-25` 的 `actionFor(status)` **仅按 status 返回动作**，无角色维度；
- `Alerts.tsx` 全文**没有任何角色判断**——检索 `roles` / `hasRoleAccess` / `getAuthUser` 均无命中。

#### 后果：三处现存可复现缺陷

| # | 场景 | 旧前端 | 后端判定 | 结果 |
|---|------|--------|---------|------|
| ① | `safety_admin` 查看 `open` / `acknowledged` / `processing` 告警 | 渲染「确认 / 处置 / 关闭」 | `safety_admin` ∉ `handler` → **false** | **点击必 400** |
| ② | 非 `safety_admin`（如 `dispatcher`）查看 `closed` 告警 | 渲染「重开」 | `closed→reopened` 需 `safety_admin` → **false** | **点击必 400** |
| ③ | 任意 handler 角色查看 `reopened` 告警 | 只渲染「确认」（`default` 分支） | `reopened` 有 **2 个**合法转移 | **「处置」入口丢失** |

> 勘误：初版以「`device_ops` 点 `open` 的确认必 400」为例——该例**不成立**
> （`device_ops` ∈ `handler`，可以确认）。真实场景是上表 ①②：
> **`safety_admin` 在告警列表页几乎什么都做不了，但旧实现照样给它显示按钮。**

这是**现存的、已可复现的**前后端不一致，不是 J2 引入的，但 PRD §5.1 决定
「动作区分派**复用 `Alerts.tsx` 的 `actionFor` 映射`」——
**会把该缺陷原样复制到新建的告警对象工作台**。

#### ✅ 修复已落地（2026-09-01）

本项已按 §修正建议实现并合入：`client/src/pages/Alerts/alertActions.ts`
（`availableAlertActions(status, roles)`）+ `Alerts.tsx` 接入，
配套测试 `alertActions.test.ts`（13 例）。
验证：前端 143 套件/1270 用例、后端 290/2253、`tsc -b`、ESLint、令牌闸门全绿。

#### 修正建议

**不要复用 `actionFor`。改用真正的单一事实源：**

```ts
import {
  alertStateTransitionAllowed,
  alertActionToState,
} from '@shared/alert-state-machine';
```

按「当前状态 × 用户角色」过滤可渲染的动作：

1. 取当前用户角色（`lib/auth` 的 `getAuthUser()?.roles`，与后端 `actor.roles` 同一口径）；
2. 对每个候选 action，用 `alertActionToState(action)` 得到目标态；
3. 用 `alertStateTransitionAllowed(current, target, role)` 判定，仅渲染通过的；
4. `global_admin` 需单独短路放行（对齐 `alert.service.ts:54-56` 的服务端行为）。

> 该模块已在 `shared/` 且配有 spec，**前端可直接 import，无需后端配合**。
> 这同时符合 PRD §4.4 XR-5「不改状态机语义」——只是把后端已有的规则**在前端正确表达**。

**顺带建议**：同一修正应回补到 `/alerts` 列表页，修复现存缺陷（建议单独立项，不混入 J2）。

### E-2 · 详情 API 返回结构与列表不一致【中】

| 端点 | 返回 |
|------|------|
| 列表 | 映射后的 `AlertRecord`（7 字段：`id/eventId/deviceId/severity/title/status/createdAt`，`api/alerts.ts:3-11`） |
| 详情 | **原始 `ewohEvent` 表行**（`alert.service.ts:127-135` 直接 `return row`） |

原始行包含 `orgId` / `schemaVersion` / `correlationId` / `causationId` 等内部字段。

**影响**：前端需维护两套类型；直接消费原始行会把内部字段带进 UI 层，
违反 J1 已确立的原则（证据面板用结构化键值呈现，不向最终用户暴露内部结构）。

**建议**：前端定义 `AlertDetail` 并做一次收窄映射（只取工作台需要的字段），
与 `AlertRecord` 并列管理。若后续要统一，应由后端把详情也映射为 `AlertRecord` 的超集——
属于可选优化，不阻塞。

---

## 3. 修正后的工作量

| 任务 | 端 | 工作量 | 依赖 | 说明 |
|------|-----|--------|------|------|
| `api/alerts.ts` 补 `getAlert` + `AlertDetail` 类型 | 前端 | 0.5d | — | 含收窄映射（E-2） |
| 工作台接入 `alert` 类型（`SUPPORTED_TYPES`） | 前端 | 0.5d | 上一项 | 复用 J1 骨架 |
| **角色感知动作区**（E-1 修正） | 前端 | 1d | — | 复用 `shared/alert-state-machine` |
| 告警流程带派生（`alertJourney`） | 前端 | 0.5d | — | 与 `planJourney` 同构 |
| `/alerts` 列表行下钻 | 前端 | 0.5d | 工作台 | |
| 风险面板去裸 ID（RK-5） | 前端 | 0.5d | Q-R2 确认 | |
| 埋点 | 前端 | 0.5d | — | |
| 单测 + E2E | 前端 | 1d | 全部 | |
| **合计** | **前端** | **≈ 5d** | **后端 0d** | |

> 后端零改动——Q-R1 已消解、状态机规则已在 shared，这是 J2 相对 J1（后端 0.25d）更轻的原因。
> 若 Q-R2 结论为"风险数据无名称字段"，RK-5 按 J1 经验改用现有高信息量字段，仍保持后端零改动。

---

## 4. 开工条件检查

| 条件 | 状态 | 阻塞级别 |
|------|------|---------|
| **G-1** 埋点上线并采集 ≥2 周基线 | ❌ 未达成 | **强阻塞（产品决策）** |
| **G-2** 完成 3–5 场用户访谈 | ❌ 未达成 | **强阻塞（产品决策）** |
| G-3 核实 `approvePlan` 发起人回避 | ⚠️ 待后端确认 | 弱阻塞 |
| **E-1** 动作区改为角色感知 | ⚠️ PRD 需修正 | **技术强阻塞**（否则复制缺陷） |
| E-2 详情类型收窄 | ⚠️ PRD 需补充 | 技术中阻塞 |
| Q-R1 告警详情 API | ✅ **已消解** | 无 |
| Q-R2 风险数据是否含名称字段 | ⚠️ 待确认 | 影响 RK-5 实现方案 |
| Q-R3 告警是否需关联人员/工位 | ⚠️ 待产品定 | 影响关联对象区设计 |

---

## 5. 建议的下一步

| 顺序 | 动作 | 负责 | 阻塞 J2 开工？ |
|------|------|------|--------------|
| 1 | 修正 PRD：§5.1 动作区方案（E-1）、§5.4 详情类型（E-2） | 产品 + 工程 | 是 |
| 2 | 推进 G-1（埋点上线取基线） | 工程 | 是 |
| 3 | 推进 G-2（用户访谈，方案已就绪） | 产品 | 是 |
| 4 | 确认 Q-R2 / Q-R3 | 后端 / 产品 | 影响细节，不阻塞整体 |
| 5 | 修复 `/alerts` 现存角色盲区（E-1 的存量部分） | 工程 | 否（建议单独立项） |

---

## 6. 与 J1 评估的对比（供参考）

| 项 | J1（对象工作台） | J2（风险旅程） |
|----|-----------------|---------------|
| PRD 技术错误 | 3 个（落点 / 枚举 / 场景） | 2 个（动作区 / 类型） |
| 契约缺口 | 2 个 | 0 个（Q-R1 已消解） |
| 后端工作量 | 0.25d + 落库方案改为派生 | **0d** |
| 主要风险 | 改错文件、类型被 400 拒绝 | 复制角色盲区缺陷 |

**J2 的 PRD 质量明显高于 J1 v1.0**——J1 v1.0 有 3 个会让开发走偏的硬错误，
J2 的主要问题是 1 个"复用对象本身有缺陷"（E-1），属于继承性风险而非方向性错误。
