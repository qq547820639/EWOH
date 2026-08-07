# 指挥地图问题盘点（第 3 轮）

> 说明：第 2 轮整改计划（`command-map-rectification.md`）已编写但**尚未落地执行**（
> 死代码仍在、采纳仍是空操作、L0/L1 语义未门控、MODES 仍重复、模式着色未强化）。
> 本轮在复核这些待办**仍然存在**的基础上，新增了走读中发现的新问题。

## 一、第 2 轮待办：仍存在（未实现）

| # | 待办 | 现状核实 |
|---|------|----------|
| 1 | 清理死代码 L3L4View / FactoryMap3D / l3l4 / three 依赖 | `L3L4View.tsx`、`FactoryMap3D.tsx`、`l3l4.ts`、`l3l4.test.ts` 仍在；`package.json` 仍含 `three`/`@react-three/*`。FactoryMap3D 仅被自身引用，确认为死代码。 |
| 2 | 大脑建议「采纳」真实跳转 | `BrainPanel.handleAccept` 仍仅 `toast`；`CommandMap` 渲染 `<BrainPanel/>` 未传 `onSelectPlan`，`<SchedulePanel/>` 未传 `focusPlanId`。 |
| 3 | L0/L1 层级语义门控 | `FactoryMap` 无 `showDynamic`；`persons`/`devices` 层在**所有层级**无条件渲染，L0 与 L2 视觉几乎相同。 |
| 4 | 模式区去重 + 着色强化 | `CommandMap.tsx` 仍保留本地 `const MODES=[...]` 字符串数组，与 `MODE_ITEMS` 分裂；`exoskeleton` 与 `device` 着色逻辑相同。 |

---

## 二、本轮新发现的问题

### 2.1 设备/人员图层完全忽略模式着色（比待办 4 更严重）
- [FactoryMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx#L648-L677) 设备层用**硬编码** `online ? '#10b981' : '#6b7280'`，人员层仅处理 `body_load/scheduling/person/data_quality`。
- 结果：`getEntityColor` 中 `device`/`exoskeleton`/`environment` 分支在 SVG 上**实际不生效**（死逻辑）。切到「设备」「外骨骼」模式，地图配色与「生产」几乎无差别。
- 与「命令地图」的定位（模式=不同视角）相悖：模式切换对地图几乎没有可感知变化。

### 2.2 外骨骼模式语义错误
- ModePanel 中 `exoskeleton` 名为「外骨骼」、描述「设备在线状态」、色 `#8b5cf6`（紫），但渲染时却按设备在线态显示**绿色**（与 `device` 模式一致），并未按外骨骼设备（EXO）做区分。
- 两种模式对外观完全一致，用户无法理解差异。

### 2.3 L3/L4 近景进入方式突兀
- 通过 `L` 键在 L0→L4 循环，进入 L3/L4 时 `FactoryMap` 自动 `zoomToElement` 到**第一个**工位/人员（未选中时随机聚焦）。
- 用户在 L1/L2 浏览中多按一下 `L`，地图突然放大到某个随机对象，**无明确预期**，易造成迷失。

### 2.4 L0 与 L1 可感知差异过弱
- `showPerception = L1||L2` 只控制摄像头视锥/UWB 覆盖圈；但这些是静态实体，L0 下直接消失，而动态人员/设备却全层级显示 → **层级梯度反向**（L0 反而更"满"）。

### 2.5 底部面板高度过矮，列数过多
- 底部面板固定 `h-[220px]`/`lg:h-[280px]`。`SchedulePanel` 表格含 11 列、`EventCenterPanel` 事件列表+详情、`TimelinePanel` 时间轴，全部挤在 220px 内，**信息密度过高、可读性差**。
- 建议：面板高度可拖拽/可最大化，或按需压缩列。

### 2.6 环境模式无真实数据却按区域着色
- `getEntityColor` 的 `environment` 分支把所有 `zone` 统一着 `#1e3a5f`，与真实温湿度无关，易误导指挥官。

---

## 三、整改方案

### 3.1 落地第 2 轮全部待办（见原计划）
- 删除 4 个死代码文件 + 清理 `three`/`@react-three/*` 依赖（构建通过为前提）。
- 大脑建议「采纳」→ 状态 `focusPlanId` + `SchedulePanel` 聚焦展开。
- L0 门控 `showDynamic = level !== 'L0'`，persons/devices 仅 L1+ 显示；ModePanel 文案改为「L0 基础结构 · L1 感知/动态 · L2 全量态势 · L3 工位近景 · L4 人员跟随」。
- `CommandMap` 删除本地 `MODES`，由 `MODE_ITEMS.map(m=>m.key)` 派生。

### 3.2 修复设备/人员图层模式着色（新）
- 设备层改用 `getEntityColor(e,'device',worldState)`；人员层补 `exoskeleton`/`device`/`production` 分支。
- 让 `exoskeleton` 与 `device` 真正区分：
  - `exoskeleton`：仅实体名/ID 含 `EXO` 的外骨骼按其在线态着色，其余设备统一灰 `#4b5563`。
  - `device`：所有设备按在线态着色。
- 删除 `getEntityColor` 中无效分支或统一其调用点。

### 3.3 外骨骼模式语义修正（新）
- 明确外骨骼模式 = 只展示外骨骼设备及其佩戴者，描述改为「外骨骼装备与佩戴关系」。

### 3.4 L3/L4 进入方式优化（新）
- 方案 A：L3/L4 改为需要先选中目标实体才进入（未选中时提示「请先选择工位/人员」）。
- 方案 B：保留循环但进入时若不满足条件则 toast 提示并停留在当前层级。

### 3.5 面板高度优化（新）
- 底部面板改为可拖拽调整高度（min 200px / max 60vh），或增加「最大化」按钮。

### 3.6 环境模式空态兜底（新）
- 无真实环境数据时明确显示「暂无温湿度数据」，不误导着色。

---

## 四、优先级建议
1. **P0（影响演示效果）**：3.1（死代码/层级语义/采纳真实化）、3.2（模式着色）。
2. **P1（体验）**：3.3、3.4、3.5。
3. **P2（正确性提示）**：3.6。

## 五、验证
1. `npm run build:server` 与 `npm run build:client:standalone` 通过。
2. 重启后逐项核验：L0/L1 差异、模式切换配色差异、采纳跳转、L3/L4 进入体验、面板拖拽。