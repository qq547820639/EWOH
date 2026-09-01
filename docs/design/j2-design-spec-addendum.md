# J2 风险旅程 — 设计规格补充（Design Spec Addendum）

> 版本：v1.0 ｜ 日期：2026-09-01 ｜ 作者：UI Designer
> 定位：**增量规格**——J1 已交付活组件库（JourneyRail / ObjectWorkbench 骨架 / MetricCard /
> `risk-*` 语义 Token），本文件只补 J2 PRD 尚未定义的**三个设计缺口** + DR-1 轻量收敛的互链模式。
> 补齐后 J2 与 DR-1 **无设计阻塞，可直接开发**。
> 关联：`PRD-risk-journey.md` v1.1、`ui-design-system.md`、`ui-prototype.html`（J1 原型）

---

## 0. 设计完备性结论（先回答"能不能直接开发"）

| J2 需求 | 设计状态 | 依据 |
|---------|---------|------|
| RK-2 流程带 | ✅ **零新设计** | `JourneyRail` 组件直接复用；5 态映射已在 PRD §5.2 表格定死 |
| RK-3 列表下钻 | ✅ 零新设计 | 行点击跳转，无新 UI |
| RK-4 设备下钻 | ✅ 零新设计 | `resolveObjectRoute('device', id)` 复用 |
| RK-5 风险面板去裸 ID | ✅ **比 PRD 预想更简单** | **Q-R2 已消解**：`WorkRisk` 接口有 `title` 字段（`api/work.ts:71-79`），纯前端字段替换 `risk.id` → `risk.title`，零后端改动 |
| RK-1 告警工作台 | ⚠️ **3 个缺口** | 见下节，本文件全部补齐 |
| DR-1 轻量互链 | ⚠️ 模式未定义 | 见 §4，一并补齐 |

---

## 1. 缺口一：严重度徽章映射表（RK-1 头部）

**问题**：`AlertRecord.severity: string | null`（`api/alerts.ts:7`）取值域未在 PRD 定义，
设计系统也没有 severity → token 的映射。

**规格**：采用**防御性五档 + 兜底**，不依赖服务端枚举确认（新增取值自动落兜底档）：

| severity 值 | 徽章文案 | Token 类 | 附加图标（不依赖颜色单通道，横切 X-4） |
|-------------|---------|----------|--------------------------------------|
| `critical` | 严重 | `border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground` | `Siren`（Lucide） |
| `high` | 高 | `border-risk-blocked-border bg-risk-blocked-soft text-risk-blocked-foreground` | `TriangleAlert` |
| `medium` | 中 | `border-risk-degraded-border bg-risk-degraded-soft text-risk-degraded-foreground` | `CircleAlert` |
| `low` | 低 | `border-risk-normal-border bg-risk-normal-soft text-risk-normal-foreground` | `CircleCheck`（仅图标，非"成功"语义，仅表低风险） |
| 其他 / `null` | 未知 | `border-risk-unknown-border bg-risk-unknown-soft text-risk-unknown-foreground` | `CircleHelp` |

**实现要求**：
- 落点为纯函数 `severityBadge(severity): { label; className; Icon }`，
  与 `PLAN_STATUS_BADGE` 同模式，放 `pages/Alerts/alertActions.ts`（与动作派生同文件，便于同测）；
- 禁止 Tailwind 默认色族（emerald/red/amber 等）——设计令牌闸门会拦；
- `critical` 与 `high` 共用同一 token 但**图标不同**：色彩通道已饱和（blocked），用形状通道区分等级。

---

## 2. 缺口二：告警工作台「概览」tab 的字段清单（信息架构）

**问题**：详情 API 返回原始 `ewohEvent` 行（约 20 字段，含 `orgId` / `schemaVersion` /
`correlationId` 等内部字段）。哪些进概览卡？——PRD 未定，这是信息架构决策。

**规格**：概览卡分两组，**明确不展示内部字段**（与工程评估 E-2 的收窄原则一致）：

**主信息组**（卡片上半，标签-值对）：

| 展示字段 | 来源 | 呈现 |
|---------|------|------|
| 告警标题 | `title` | 卡片标题（人类可读，禁止裸 UUID 原则天然满足） |
| 严重度 | `severity` | §1 徽章 |
| 状态 | `status` | `PLAN_STATUS_BADGE` 同款语义徽章（复用 statusLabel 中文映射） |
| 产生时间 | `createdAt` | 绝对时间（tabular-nums）+ 相对时间辅助（"3 小时前"） |

**关联组**（卡片下半）：

| 展示字段 | 呈现 |
|---------|------|
| 关联设备 | `deviceId` 可点击 chip → `/devices`（`resolveObjectRoute` 复用）；null 时显示"—" |

**明确排除**（不进概览卡）：`eventId`（仅小字等宽展示在标题下方作技术锚点，同 J1 模式）、
`orgId`、`schemaVersion`、`correlationId`、`causationId`、`triggerRecordId`、`handlerAction`、
`confidence`、`receivedAt` / `observedAt` / `occurredAt`（三者只取 `createdAt` 展示，避免三个时间戳并列造成困惑）。

**证据 tab（暂缓）**：告警的 `evidenceJson` 在事件表上由触发链路写入，结构不保证稳定——
**首轮不做证据 tab 的富渲染**，渲染为折叠的键值对（与 J1 证据面板同一组件模式），
键名不做翻译映射（避免为不稳定结构维护字典）。后续若访谈证明需要，再单独设计。

---

## 3. 缺口三：「关联对象」tab 的单类型简化

**问题**：J1 工作台的关联对象 tab 是三组结构（人员/设备/工位）。告警只有 `deviceId`
一种关联（FA-3，且 DR-4 已裁决不扩）。照搬三组结构会出现两个空分组。

**规格**：
- 告警场景**只渲染「关联设备」一组**，隐藏人员/工位分组标题（不渲染空组，而非渲染后置灰）；
- 空态文案："本告警未关联设备"（`deviceId` 为 null 时）；
- 该简化通过给 ObjectWorkbench 传入**关联分组配置**实现（`relatedGroups` prop），
  不做 boolean 开关硬编码——J2 之后接入 task 类型时同理传自己的分组配置。

---

## 4. DR-1 轻量收敛：三页互链的统一模式

**问题**：驾驶舱三页（指挥地图/指挥中心/数字世界）分工对用户不可见，且互相无跳转。

**规格**：统一「页头职责条」模式，三页一致：

```
┌──────────────────────────────────────────────────────────┐
│ [页面名]  本页回答：{一句话职责}                            │
│ 相关视图： [指挥地图 · 空间态势] [指挥中心 · 事件与KPI] [数字世界 · 拓扑] │
└──────────────────────────────────────────────────────────┘
```

- **职责一句话**（写死在文案常量，不放配置）：
  - 指挥地图："现场在哪里发生"（空间维度）
  - 指挥中心："发生了什么、规模多大"（数字与事件维度）
  - 数字世界："系统拓扑长什么样"（结构维度）
- **互链按钮**：当前页在按钮组中呈**选中态（aria-current="page"）且不可点击**，
  其余两枚可点击（React Router Link，SPA 内跳转不刷新）；
- 样式全部走语义 Token；触控 44px（复用 JourneyRail 的 min-h-11 约定）；
- **不做**：不做 Tab 化合并（那是 2 周 PV 数据后的 DR-1 二阶段决策）、
  不做自动跳转、不隐藏侧边栏入口（列表页保留原则同 XR-1）。

---

## 5. 横切要求（全部继承 J1 已确立的约束，此处仅汇总）

| 约束 | 要求 |
|------|------|
| 语义 Token | 新 UI 一律 `risk-*` / 语义色，禁 Tailwind 默认色族（闸门拦截） |
| 触控 | 移动端交互目标 ≥44px（`min-h-11 sm:min-h-0` 模式） |
| 状态三重编码 | 图标 + 文字 + 颜色，不依赖颜色单通道 |
| 数字 | `tabular-nums` |
| 无障碍 | `aria-current` 标注当前项；折叠区用 `<details>`/`<summary>` 原生语义 |
| 暗色/高对比 | 全部经语义 Token 自动生效，无需单独出暗色稿 |

---

## 6. 开工清单（给工程的一句话版）

1. RK-5：`RisksPanel.tsx:48` 的 `{risk.id}` → `{risk.title}`，`id` 降为小字等宽辅助信息（1 行改动）；
2. RK-1：按 §1/§2/§3 实现，`severityBadge` 落 `alertActions.ts`；
3. DR-1：按 §4 实现「页头职责条」（一个小组件，三页复用）；
4. 全程用语义 Token，完成后跑 `npm run lint:design-tokens` 确认不新增违规。
