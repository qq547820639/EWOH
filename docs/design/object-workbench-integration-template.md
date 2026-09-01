# 对象工作台接入模板（Object Workbench Integration Template）

> 版本：v1.0 ｜ 日期：2026-09-01 ｜ 维护：架构（ArchitectUX）
> 用途：**新增一个对象类型接入 `/o/:objectType/:objectId` 的标准作业程序（SOP）**。
> 目标：后续每个域（工单 / 设备 / 任务 / 告警 / …）的接入从"重新设计 ≈5 天"
> 降为"套模板 ≈2 天"，并保证不走样（单一事实源、语义 Token、fail-closed 不回退）。
> 参考实现：`scheduling_plan`（首建，J1）、`alert`（J2 PRD v1.1，未开工）。

---

## 0. 分工边界

| 步骤 | 负责 | 产出 |
|------|------|------|
| 选对象类型、定指标 | **产品** | 该域的接入决策 + 指标口径 |
| 本模板全部步骤 | **架构 + 工程** | 可运行的接入 + 测试 |
| 验收 | **架构复核** | 走样检查（见 §4） |

---

## 1. 产品侧前置决定（开工前 3 个问题，各 ≤0.5h）

| # | 问题 | 影响 |
|---|------|------|
| Q1 | 对象详情 API 是否已存在？返回结构是什么？ | 决定步骤 3 的工作量；**返回原始 DB 行的必须收窄**（E-2 教训） |
| Q2 | 该对象是否需要走审批 / 有状态机？ | 决定步骤 4 是否需要接 shared 状态机；新类型进审批须在 `APPROVAL_ROLE_POLICY` 登记（fail-closed） |
| Q3 | 该对象是否自带人类可读标题字段？ | **自带 → 不需要对象描述符**（告警的 `title` 即此类）；需要跨页引用且只有 ID → 走 OD-1 描述符 |

---

## 2. 工程侧标准步骤（按序执行）

### 步骤 1 · 详情数据接入
- 前端 `api/<domain>.ts` 补 `getXxx(id)`；
- 若后端返回原始行：定义 `XxxDetail` 并**收窄映射**，内部字段（orgId/schemaVersion/…）不得进入 UI 层。

### 步骤 2 · 工作台路由注册
- `pages/ObjectWorkbench/ObjectWorkbench.tsx` 的 `SUPPORTED_TYPES` 加类型名（1 行）；
- 未支持类型的"暂不支持"空态已内建，无需处理。

### 步骤 3 · 动作单一事实源（⚠️ 全模板最重要的一步）
- 新建 `pages/<Domain>/<x>Actions.ts`：
  - `xActions(status, id)`：返回该状态的动作数组（含导航型 `route`）；
  - **写操作的可用性判定一律委托 `shared/` 既有状态机**（如 `alertStateTransitionAllowed`），
    **禁止在前端硬编码角色-动作矩阵**（B1 教训：后端是 fail-closed，前端自己编矩阵必然漂移）；
  - `global_admin` 短路放行需对齐服务层行为；
- `WRITE_ACTIONS` 集合 + 变体（primary ≤1 / secondary / ghost / danger）沿用 `planActions.ts` 模式。

### 步骤 4 · 流程带派生
- `xJourney(status, …, id)`：**由状态派生环节，不新增持久状态**（planJourney 同构）；
- `todo` 环节一律不给 `route`（不产生死链）；每个状态 ≤1 个 current。

### 步骤 5 · 状态徽章
- `X_STATUS_BADGE` 映射，**全部走 `risk-*` / `semantic-*` 语义 Token**，
  禁 Tailwind 默认色族（`npm run lint:design-tokens` 会拦）。

### 步骤 6 · 埋点（两处白名单同步，漏一处即静默丢失）
- 前端 `lib/telemetry.ts` 的 `TelemetryEventName` 加事件名；
- 后端 `server/modules/telemetry/telemetry.service.ts` 的 `ALLOWED_EVENT_NAMES` **同步加**；
- 调用点：工作台曝光、动作点击（导航型 + 写操作型）。

### 步骤 7 · 测试（契约即用例）
- `xActions.test.ts`：**用 shared 状态机 spec 的既有用例做断言**（渲染结果须与后端判定一致），
  覆盖：无角色 fail-closed / global_admin / 每状态 ≥1 出口 / 终态有导航出口；
- `xJourney` 测试：恰好 ≤1 个 current、todo 无 route。

---

## 3. 零新增复用清单（直接 import，不复制代码）

| 组件/模块 | 位置 | 用途 |
|-----------|------|------|
| `JourneyRail` | `components/app-shell/JourneyRail.tsx` | 流程带（传派生 steps） |
| `MetricCard` / `PlanMetricGrid` | `components/business-ui/MetricCard.tsx` | 指标卡（OD-7 模式） |
| `QueryState` | `components/QueryState.tsx` | 加载/错误/空/过期四态 |
| `resolveObjectRoute` | `pages/Scheduling/planActions.ts` | 关联对象下钻路由 |
| `NarrationPanel` 三态模式 | `ObjectWorkbench.tsx` | 异步产物 pending/.done/unavailable |
| 埋点 sink | `lib/telemetry.ts`（已全局挂载） | 无需接线，track 即达 |
| `installBatchedTelemetrySink` | 同上 | 批量上报已内建 |

---

## 4. 验收走样检查单（架构复核用）

- [ ] 全页面用户可见区**无裸 ID**（描述符缺失时回退渲染，但不新增裸 ID 出口）
- [ ] 动作判定 100% 来自 shared 状态机，前端零角色矩阵硬编码
- [ ] 无角色 → 不渲染动作 + 显示明确说明（不留白、不堆禁用按钮）
- [ ] 每个状态至少 1 个后继出口；终态必有导航出口
- [ ] 颜色 100% 语义 Token；`lint:design-tokens` 对该文件 0 违规
- [ ] 移动端触控 ≥44px（`min-h-11 sm:min-h-9` 模式）
- [ ] 埋点事件名前后端白名单**同时**更新
- [ ] 路由无 `RequireRole`（未注册路径 fail-closed；租户隔离由后端守卫保证）
- [ ] `tsc -b` / 两端 Jest / ESLint 全绿

---

## 5. 成本参考

| 情形 | 工作量 |
|------|--------|
| 首建域（如 scheduling_plan，含基础设施） | ≈2 周（已沉没，勿重复计算） |
| 第二个域（alert，含详情 API 补齐） | ≈5d |
| **后续常规域**（详情 API 已存在、状态机已在 shared） | **≈2d** |
| 无状态机的静态对象（如纯档案页） | ≈1d（跳过步骤 3/4 的状态机部分） |

> **产品侧含义**：对象工作台的边际成本已压到 ≈2 天/域。
> "20+ 孤岛"的收敛不再受工程瓶颈约束，受**产品选择与 Gate** 约束——
> 每选一个域，2 天后交付一个走样受控的接入。
