# EWOH 界面设计方案（UI-DS-2026-09）

> 角色：UI 设计师
> 日期：2026-09-01
> 交互原型：`docs/design/ui-prototype.html`（可切换浅色 / 暗色 / 高对比三套主题）
> 关联：`docs/ux/ux-architecture-redesign.md`（UX 架构）、`client/src/tokens.css`（生产令牌）

---

## 一、执行摘要

**EWOH 不需要从零设计一套新视觉——已有的设计系统相当优秀，问题在于它没被用。**

审计数据：

| 指标 | 数值 | 说明 |
|------|------|------|
| 语义 Token 用量（`pages/`） | **94** | `risk-*` / `semantic-*` |
| Tailwind 默认语义色用量（`pages/`） | **368** | `emerald` / `amber` / `cyan` / `red` … |
| 比例 | **1 : 3.9** | 近 80% 的状态色绕开了项目令牌 |

**如果推倒重来设计新色板，会连带推翻 tokens.css 中已完成的全部无障碍工作**
（暗色提亮、高对比、反色表面、`--destructive-on-soft` 修复）。正确动作是**收敛**，不是重建。

---

## 二、现状资产盘点（已具备，无需新建）

| 资产 | 位置 | 状态 |
|------|------|------|
| 语义状态色（success/warning/danger/info） | `tokens.css:19-28` | ✅ 完备 |
| 风险状态六态 × 四维度（主色/前景/软底/边框） | `tokens.css:34-75` | ✅ 完备 |
| 暗色主题 | `tokens.css:183-234` | ✅ 含 risk-* 提亮 |
| 高对比模式 | `tokens.css:239-258` | ✅ 含双主题 |
| 反色表面作用域 | `tokens.css:88-96` | ✅ `[data-inverse-surface]` |
| 减少动效 | `tokens.css:263-272` | ✅ `prefers-reduced-motion` |
| z-index 刻度 | `tokens.css:101-108` | ✅ 6 级 |
| 中文字体栈 | `tailwind-theme.css:58-62` | ✅ PingFang SC 优先 |
| 圆角 / 阴影刻度 | `tailwind-theme.css:67-81` | ✅ |
| 基础组件库 | `components/ui/*` | ✅ 59 个 Radix 封装 |
| Tailwind 工具类映射 | `tokens.css:126-178` | ✅ `@theme inline` |

> 📌 更正：`docs/product/UX_DEEPENING_BACKLOG.md` §3.2 记载「无独立 Token 文件」为 **2026-08-04 的旧结论**，
> 现 `tokens.css`（271 行）已建立。该 backlog 条目应标记为已闭环。

---

## 三、核心问题：色板分裂（实测数据）

### 3.1 同一状态、两套颜色

| 语义 | Tailwind 色 | 白底对比度 | 项目 Token | 白底对比度 | 色差 ΔRGB |
|------|------------|-----------|-----------|-----------|----------|
| 成功 / 正常 | `emerald-500` | 2.54:1 | `risk-normal` | 3.18:1 | **113** ⚠ |
| 警告 / 降级 | `amber-500` | 2.15:1 | `risk-degraded` | 3.07:1 | 57 |
| 信息 / 离线 | `cyan-500` | 2.43:1 | `risk-offline` | 2.86:1 | 46 |
| 危险 / 阻塞 | `red-500` | 3.76:1 | `risk-blocked` | 3.51:1 | 23 |

> ΔRGB ＝ 三通道绝对差之和，**> 60 即肉眼可辨**。「成功」色差达 113，
> 用户在 Devices（绿 A）与 Scheduling（绿 B）之间切换时会感到"颜色不对劲"，但说不出原因。

### 3.2 但真正的问题不是可读性

两套组合作为徽章使用时**都达标**：

| 组合 | 对比度 | 判定 |
|------|--------|------|
| `risk-*-soft` + `risk-*-foreground` | **6.48 – 9.45:1** | PASS（余量充足） |
| `emerald-100` + `emerald-700` 等 | **4.51 – 5.30:1** | PASS（勉强过线） |

真正的差距是**功能性**的：

| 能力 | 语义 Token | Tailwind 硬编码 |
|------|-----------|----------------|
| 暗色主题适配 | ✅ `tokens.css:219-233` 提亮 | ❌ 不响应 |
| 高对比模式 | ✅ `:246-248` 加深 | ❌ 不响应 |
| 反色表面（指挥地图深色壳） | ✅ `:88-96` 重定向 | ❌ 不响应 |
| 无障碍专项修复 | ✅ `--*-on-soft`（destructive/warning/info/primary） | ❌ 不适用 |

**结论**：368 处 Tailwind 色所在的区域，三套主题**完全失效**。
车间暗光环境、需要高对比的弱视用户、指挥地图深色面板——这些场景当前是断的。

---

## 四、设计规范

### 4.1 四维度使用法则（唯一正确用法）

每个状态提供四个变量，**不可混用**：

| 用途 | 变量后缀 | 示例 | 对比度要求 |
|------|---------|------|-----------|
| 填充 / 图标 / 图表 | 无后缀 | `--risk-normal` | ≥ 3:1（非文本） |
| 背景底 | `-soft` | `--risk-normal-soft` | — |
| 边框 | `-border` | `--risk-normal-border` | — |
| **文字** | `-foreground` | `--risk-normal-foreground` | **≥ 4.5:1** |

⚠️ **禁止**用主色（如 `--risk-normal`）直接作文字色叠在 `-soft` 底上——
这正是 `tokens.css` 中 `--destructive-on-soft` 修复过的问题。同一规则覆盖
非 risk 色板：`bg-warning/*`、`bg-info/*`、`bg-primary/*` 等软底上的文字必须用
`text-warning-on-soft` / `text-info-on-soft` / `text-primary-on-soft`，
**不得**写 `text-warning` / `text-info` / `text-primary`。

实测（axe，2026-09）：深色外壳（`data-inverse-surface`）上 `bg-warning/20 text-warning`
= **4.16:1**（serious）、`bg-info/20 text-info` = 2.70:1、`bg-primary/20 text-primary`
= 2.70:1；改用 on-soft 令牌后分别 7.92 / 6.92 / 6.92:1。该门的回归测试是
`client/src/lib/softSurfaceContrast.test.ts`（数值计算 + 类名策略扫描）与
`test/browser/ux009-command-map-axe.spec.js`（真实 axe 运行）。

另外：**状态色调徽标禁用颜色过渡**。reduced-motion 全局规则只把 `transition-duration`
压到 0.01ms，而 `transition-property` 仍取初始值 `all`，于是每次换色都会生成一条
CSSTransition；帧饥饿时 `currentTime` 停在 0，computed style 会长时间返回**上一种
色调**的颜色（axe 因此偶发失败，也是"界面在说谎"）。新鲜度徽标用
`[transition-property:none]` 显式关闭过渡——色调是事实指示，必须立即生效。

### 4.2 收敛映射表

| Tailwind 色族 | 语义 Token | 业务状态 |
|--------------|-----------|---------|
| `emerald-*`、`green-*` | `risk-normal` | 正常 / 成功 / 已批准 |
| `amber-*`、`yellow-*`、`orange-*` | `risk-degraded` | 降级 / 警告 / 待处理 |
| `cyan-*`、`sky-*`、`blue-*` | `risk-offline` | 离线 / 信息 / 生成中 |
| `red-*`、`rose-*` | `risk-blocked` | 阻塞 / 危险 / 已驳回 |
| `violet-*`、`purple-*`、`fuchsia-*` | `risk-conflict` | 冲突 |
| `gray-*`、`slate-*` | `risk-unknown` | 未知 / 缺失 |

### 4.3 状态三重编码（不依赖颜色单通道）

```
● 圆点形状  +  中文文本  +  语义色彩
```

色觉障碍用户（男性约 8%）与车间强光环境下，仅靠颜色区分状态会失效。
所有状态标识必须同时提供形状与文字——见原型「徽章组件」区。

### 4.4 工业场景适配

| 约束 | 规范 | 场景依据 |
|------|------|---------|
| 触控目标 | 默认 **44px**，紧凑态 36px（仅桌面表格内） | 工业手套操作 |
| 数字排版 | 全部使用 `font-variant-numeric: tabular-nums` | 表格纵向对齐、数值扫读 |
| ID / 时间戳 | 等宽字体 + 12px | 便于口头核对与抄录 |
| 正文字号 | 14px / 行高 1.6 | 中文可读性最优区间 |
| 焦点可见 | `:focus-visible` 2px `ring` + 2px offset | 键盘操作与低视力 |

---

## 五、核心界面：对象工作台

承接 UX 架构 L1「对象解析层」，解决「内容与流程分居两页」的断点。

### 5.1 结构规格

```
┌─ Journey Rail ────────────────────────────────────────┐  常驻，48px 高
│  ①生成方案 ✓ → ②AI解读 ✓ → ③评审会签 ● → ④下发 ○ → ⑤执行 ○ │  当前环节高亮
├─ 对象头部 ────────────────────────────────────────────┤
│  焊装车间 A 线 · 白班排产   [待审批]        [审批通过][驳回] │  标题+状态+动作区
│  PLN-2026-0901-003 · v3                                  │
│  责任人 张伟 · 触发 交期风险 · 更新 2分钟前 · 来源 实时数据   │  元信息一行
├─ Tabs ────────────────────────────────────────────────┤
│  概览 | 关联对象 | 状态历史 | 证据                        │  URL 同步
├─ 视图区 ──────────────────────────────────────────────┤
│  指标卡（5 项）→ AI 解读 → 会签进度表                     │
└───────────────────────────────────────────────────────┘
```

### 5.2 关键设计决策

| 决策 | 理由 |
|------|------|
| **Journey Rail 常驻顶部** | 用户任何时候都知道"我在哪、已完成什么、下一步去哪"——直接治 UX 断点 B1/B4 |
| **动作区仅渲染当前状态允许的动作** | 复用既有状态机，不新增语义；杜绝"点了才发现不能操作" |
| **会签进度与对象内容同屏** | 审批人不再面对裸 UUID（治 UX 断点 B2/B3） |
| **关联对象可下钻** | 复用 `WorkbenchList.tsx:227` 已验证的 `resolveRowPath`，不新建机制 |
| **证据面板用结构化键值** | 保留可追溯性，但不向最终用户暴露原始 JSON（治 UX 断点 B7） |

### 5.3 指标卡：替换 JSON dump

`Scheduling.tsx:195-197` 当前直接渲染 `JSON.stringify(row.metrics)`。
指标卡将同组数据转为「大数字 + 单位 + 语义色 + 阈值提示」：

| 现状 | 目标态 |
|------|--------|
| 9 个字段平铺、无单位、无阈值、无优先级 | 关键项优先（延期/负荷置前），阈值着色，单位内嵌 |
| 调度员需阅读原始结构 | 扫读即可决策；原始结构折叠进「查看原始指标」供排查 |

---

## 六、落地路线

### P0 · 建立防回归闸门（1 天）

加 ESLint 规则，禁止新增 Tailwind 语义色：

```js
// 目标：pages/** 内禁止出现 Tailwind 默认语义色族
'no-restricted-syntax': ['error', {
  selector: 'Literal[value=/\\b(emerald|amber|cyan|rose|sky|lime|orange|teal|violet|fuchsia)-\\d{2,3}\\b/]',
  message: '请使用语义 Token（risk-* / semantic-*），见 docs/design/ui-design-system.md §4.2'
}]
```

> 例外：`pages/CommandMap/**` 的 canvas 图层（`FactoryMap`、`SchedulerLayers`、`entityColors`）
> 需要具体色值绘制，属于合理硬编码——`entityColors.ts` 已是集中调色板，建议加文件级豁免而非全局放行。

**先立闸门再收敛**，否则边改边增。

### P1 · 核心流程页收敛（368 处按优先级分批）

| 批次 | 范围 | 处数估算 | 用户触及频率 |
|------|------|---------|-------------|
| 1 | `Scheduling` + `ApprovalConsole` | 低 | 每日（调度员、审批人） |
| 2 | `WorkOrchestration` + `Alerts` | 中 | 每日 |
| 3 | `RoleWorkbench` + `MobileWorkbench` | 中 | 每日（一线） |
| 4 | `Devices` + `Personnel` | 中 | 每周 |
| 5 | 其余页面 | 高 | 低频 |

按 §4.2 映射表逐处替换，**视觉应无变化或更统一**（替换前后建议截图对比存档）。

### P2 · 组件层固化

把原型中的模式沉淀为可复用组件，避免各处重写：

| 组件 | 位置建议 | 复用场景 |
|------|---------|---------|
| `StatusBadge` | `components/ui/status-badge.tsx` | 所有状态展示 |
| `MetricCard` | `components/business-ui/metric-card.tsx` | 指标展示，替代 JSON |
| `JourneyRail` | `components/app-shell/journey-rail.tsx` | 三条 Journey 共用 |
| `ActionBar` | `components/business-ui/action-bar.tsx` | 终态出口 |
| `ObjectWorkbench` | `components/app-shell/object-workbench.tsx` | L1 骨架 |

---

## 七、验收标准

| 编号 | 验收项 | 判定方式 |
|------|--------|---------|
| V-1 | `pages/**` 内 Tailwind 语义色族归零（CommandMap canvas 除外） | ESLint 规则，CI 阻断 |
| V-2 | 三套主题下所有状态徽章对比度 ≥ 4.5:1 | axe 扫描 × 3 主题 |
| V-3 | 触控目标 ≥ 44px | axe / 静态检查 |
| V-4 | 状态标识具备形状 + 文本 + 色彩三重编码 | 人工抽查 3 页 |
| V-5 | 用户可见区域无 `JSON.stringify` 直出 | 静态扫描 |
| V-6 | 所有数字使用 `tabular-nums` | 样式审查 |
| V-7 | 键盘可达、焦点可见 | 键盘遍历 + axe |

---

## 八、明确不做

- **不新建色板** — 现有 tokens.css 已达标且含完整主题适配，重建等于推翻无障碍成果。
- **不动 `components/ui/*` 基础库** — 59 个 Radix 组件状态良好，仅在之上补业务组件。
- **不重做 CommandMap** — canvas 图层硬编码合理，且该模块量大（4664 行），不在本轮范围。
- **不改业务语义** — 状态机、权限、调度算法一律不动。
