# UX-007 无障碍例外记录（WCAG 2.2 AA）

> 状态：待批准（Approval Pending）
> 批准人：**（待指定：产品负责人 / 无障碍负责人）**
> 批准日期：——

## 目的

依据 UX-007「无障碍与设计系统」7.8 要求，核心流程不得存在 Critical / Serious 级无障碍问题；对于当前无法在代码层面彻底修复的项，须形成经批准的例外记录。本文件列出例外项、原因、影响与批准人占位。

例外记录不代表「忽略无障碍」，而是对「何时、以何种方式接受已知限制」的透明披露。所有例外项均需在真实浏览器 axe 扫描与人工复核后复核是否仍成立。

---

## 一、静态扫描方法说明（重要）

`scripts/axe-scan.mjs` 默认以「静态启发式」模式扫描源码（无 DOM）。该模式是**近似**检测，**不能**替代真实浏览器 axe-core 运行，结论一律标注「待真实浏览器运行」。

静态规则存在两类已知误报，导致若干输入框被标记为 `input-without-label`（serious）：

1. **JSX 尖括号误截断**：规则使用 `/<input\b([^>]*)>/g` 捕获属性，但 JSX 赋值箭头函数 `onChange={(event) => ...}` 中含 `>`，导致捕获在 `=>` 处提前终止，其后的 `aria-label` 不被计入。
2. **组件名误匹配**：`/i` 的忽略大小写使规则匹配到 `<Input>`（UI 组件）而非原生 `<input>`；该组件由外层 `<label>` 提供可访问名称。

经源码核对，以下静态命中的输入框**均具备可访问名称**（`aria-label` 或包裹 `<label>`），故**不构成真实的 Critical/Serious 问题**：

| 文件 | 元素 | 真实可访问名称依据 |
| --- | --- | --- |
| `pages/WorkOrchestration/WorkGraphPanel.tsx` | 搜索框 | `aria-label="搜索因果图节点"` |
| `pages/Personnel/Personnel.tsx` | 人员搜索框 | `aria-label="搜索人员"` |
| `pages/RoleWorkbench/RoleWorkbench.tsx` | 筛选框 | `aria-label={'筛选'+label}` |
| `pages/MobileWorkbench/MobileWorkbench.tsx` | 异常照片文件选择 | `type="file"` + `aria-label="异常照片"` |
| `pages/Devices/Devices.tsx` | 关键字/区间/排序等 | 包裹 `<label>`（关键字、在线状态、电量区间、来源类型、排序） |
| `pages/Scheduling/Scheduling.tsx` | 查询输入 | 包裹 `<label>` |

> 结论依赖人工源码核对，最终确认须以真实浏览器 axe-core 运行为准（`node scripts/axe-scan.mjs --real <urls>`）。

---

## 二、例外项（EX-001 ~ EX-003）

### EX-001：3D 工厂场景（WebGL Canvas）非文本可访问性

- **位置**：`client/src/pages/CommandMap/FactoryMap3D.tsx`（react-three-fiber `<Canvas>` / WebGL）
- **WCAG**：1.1.1（非文本内容）、1.4.1（不使用颜色传达信息）
- **严重度**：Serious（潜在）
- **原因**：3D 场景为 WebGL 画布渲染，屏幕阅读器无法读取其内部节点/实体；三维交互（拖拽旋转、缩放）难以用键盘完整复现。
- **缓解**：页面提供 2.5D 地图与实体列表作为文本/结构化替代；本例外要求在 3D 场景旁提供同等的实体可达入口（列表/搜索），并确保非 3D 路径可完成全部核心操作。
- **批准人**：**（待指定）**

### EX-002：交互画布 `tabIndex={-1}` 的键盘可达设计

- **位置**：`pages/WorkOrchestration/WorkGraphPanel.tsx`（因果图画布节点）、`components/Layout.tsx`（主内容滚动容器）
- **WCAG**：2.1.1（键盘）、2.4.3（焦点顺序）
- **严重度**：Moderate
- **原因**：画布节点采用 `tabIndex={-1}`，是为避免大量节点进入 Tab 顺序造成焦点混乱；节点通过左侧「节点列表」`role="listbox"` 键盘浏览（方向键选择、Enter 打开），主内容容器 `tabIndex={-1}` 用于滚动恢复。
- **缓解**：键盘用户可通过列表完成全部节点选择/打开；画布视角仅作视觉辅助。保持该设计时键盘主路径完整可用。
- **批准人**：**（待指定）**

### EX-003：密集桌面工具条触控目标尺寸

- **位置**：多页管理工具栏（如 `WorkOrchestration/WorkGraphPanel.tsx`、`RoleWorkbench/RoleWorkbench.tsx` 的 `h-8`/`h-9` 控件）
- **WCAG**：2.5.8（目标尺寸，AA）
- **严重度**：Moderate
- **原因**：桌面管理端工具栏信息密度高，控件高度约 32–36px，低于 44px 启发式阈值；触控目标尺寸主要影响触屏设备。
- **缓解**：核心移动流程（`MobileWorkbench`）已采用大触控区域；桌面管理端控件间距提供足够容错，并在移动视口下继承大触控样式。若真实触控场景验收不达标，则回填本例外复审。
- **批准人**：**（待指定）**

---

## 三、复核与批准流程

1. 本文件的例外项须在真实浏览器 axe-core 扫描（`scripts/axe-scan.mjs --real`）与人工键盘/读屏复核后复核成立性。
2. 每项例外须由**产品负责人 / 无障碍负责人**签署批准（上表「批准人」占位）。
3. 任何例外项在核心用户路径上导致不可操作时，应取消例外并优先修复。
4. 例外结论不替代「核心流程无 Critical/Serious」红线；本例外的静态误报已核对，不构成真实红线违规。