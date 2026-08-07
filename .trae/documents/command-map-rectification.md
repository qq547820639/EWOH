# 指挥地图整改计划（第 2 轮）

## 摘要
基于对指挥地图（Command Map）的全面走读，本轮整改聚焦 4 个已确认的问题域：
1. 清理未使用的死代码（L3L4View / FactoryMap3D 及随之释放的 Three.js 依赖）
2. 将「大脑建议·采纳」从纯 toast 空操作改为真实跳转/定位
3. 修正 L0/L1 层级语义，让层级梯度真正可感知
4. 统一模式定义并强化 `exoskeleton`/`device` 等模式的地图区分度

所有改动集中在 `ewoh-spark-app/client` 前端；后端无需改动（任务编排已在模拟时真实落库调度方案）。

---

## 现状分析

- **主容器** [CommandMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx)：管理模式/层级/选中/面板状态，L3/L4 近景已由 FactoryMap 内联处理（`isNearView` + `zoomToElement`）。
- **地图渲染** [FactoryMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx)：自适应 viewBox + 缩放平移；**L0 与 L1 视觉几乎无差别**（L0 也渲染全部工位/设备/人员）。
- **模式面板** [ModePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/ModePanel.tsx)：导出 `MODES`（对象数组）；而 CommandMap.tsx 又自建一份字符串数组 `MODES`，存在重复。
- **大脑建议** [BrainPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/BrainPanel.tsx)：`handleAccept` 仅 `toast`，有 `planId` 时只提示"跳转"但不真正跳转。
- **调度面板** [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx)：靠内部 `expandedId` 展开方案，无外部聚焦入口。
- **死代码**：`L3L4View.tsx`、`FactoryMap3D.tsx` 仅被自身引用，未被任何路由/组件使用（Grep 已验证）。`FactoryMap3D` 引入 `@react-three/fiber`、`@react-three/drei`、`three`。

---

## 变更方案

### 1. 清理死代码
- **删除** `/workspace/ewoh-spark-app/client/src/pages/CommandMap/L3L4View.tsx`
- **删除** `/workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap3D.tsx`
- **校验并清理连带死代码**：`L3L4View` 引入的 `./l3l4`（`filterRelatedPersons/filterRelatedDevices`）。实现时用 Grep 确认 `l3l4` 是否被其他文件引用；若无引用，一并删除 `l3l4.ts` 及 `l3l4.test.ts`。
- **清理 Three.js 依赖**：实现时用 Grep 确认 `three`、`@react-three/*` 无其他引用后，从 `package.json` 移除 `three`、`@react-three/fiber`、`@react-three/drei`（及必要的 `@types`）。若发现仍有引用则保留，并在计划执行中说明。
- 删除后重新构建前端，确认无编译错误。

### 2. 大脑建议「采纳」真实化
目标：采纳建议时真实定位到对应调度方案。
- **CommandMap.tsx**：
  - 新增状态 `const [focusPlanId, setFocusPlanId] = useState<string | null>(null)`。
  - 渲染 BrainPanel 时传入 `onNavigate={setActiveTab}` 与 `onSelectPlan={(planId) => { setFocusPlanId(planId); setActiveTab('schedule'); }}`。
  - 渲染 SchedulePanel 时传入 `focusPlanId={focusPlanId}` 与 `onFocusPlanConsumed={() => setFocusPlanId(null)}`。
- **BrainPanel.tsx**：
  - 新增 props `onNavigate?: (tab: string) => void; onSelectPlan?: (planId: string) => void;`。
  - `handleAccept`：若 `s.planId` 存在 → 调用 `onSelectPlan(s.planId)`，`toast.success('已定位到方案 ' + s.planId)`；否则 → `toast.info('建议已记录，等待人工评估')`（不再是无意义的空操作）。
  - 若 `onSelectPlan` 未提供（如独立使用场景），回退为原 toast 逻辑，保证不崩溃。
- **SchedulePanel.tsx**：
  - 新增 props `focusPlanId?: string | null; onFocusPlanConsumed?: () => void;`。
  - 用 `useEffect`：当 `focusPlanId` 变化且 `plans` 已加载时，找到匹配 `plan.planId` 的行，将其 `id` 设为 `expandedId`，并滚动到该行；随后调用 `onFocusPlanConsumed?.()` 清除聚焦态。

### 3. L0/L1 层级语义修正
- **FactoryMap.tsx**：
  - 新增 `const showDynamic = level !== 'L0';`（L1 起才显示动态人员/设备）。
  - 将「调度模式人员连线」「设备层」「人员层」「WIP/节拍脉冲」等动态图层用 `showDynamic` 门控；`flowLines` 本就由 `showDensity`(L2) 门控，保持。
  - 保持 `showPerception = L1 || L2`（摄像头/UWB 覆盖）、`showDensity = L2`。
  - 效果：L0 = 静态底图 + 工位（基础结构）；L1 = 结构 + 感知覆盖 + 动态人员/设备；L2 = 全量态势。层级梯度清晰。
- **ModePanel.tsx**：将层级说明文案改为 `L0 基础结构 · L1 感知/动态 · L2 全量态势 · L3 工位近景 · L4 人员跟随`，与新的语义一致。

### 4. 模式区去重与强化
- **CommandMap.tsx**：删除本地 `const MODES = [...]` 字符串数组，改为 `import { MODES as MODE_ITEMS } from './ModePanel'`；键盘快捷键处用 `const MODES = MODE_ITEMS.map((m) => m.key)` 派生。消除两处定义的分裂。
- **FactoryMap.tsx**（`getEntityColor`）：
  - `exoskeleton` 模式：仅当设备 entityId/名称含 `EXO`（外骨骼）时按在线状态着色（在线绿/离线灰），其余设备（AGV 等）统一 `#4b5563`。
  - `device` 模式：所有设备按在线状态着色（现状保持）。
  - 使两个模式在地图上呈现明显差异，而非此前完全相同的配色。

---

## 假设与决策
- 全部改动仅限前端，不触碰后端 API 与数据库 schema。
- 「采纳」需要定位到具体方案，通过新增 `focusPlanId` 状态 + SchedulePanel 聚焦 prop 实现；不引入路由参数，保持简单。
- 删除 Three.js 依赖以"构建仍通过"为前提；若实现时发现其他引用，则只删组件文件、保留依赖。
- L0 语义以"不显示动态人员/设备"为实现方式，工位仍作为结构展示。

## 验证步骤
1. `cd /workspace/ewoh-spark-app`
2. `npm run build:server`（确认服务端无回归）
3. `npm run build:client:standalone`（确认前端通过，无死代码/未用导入错误）
4. 重启服务（`STANDALONE=1` + Ark key），访问 `http://localhost:3000/`：
   - 切到 L0 / L1 / L2，确认动态人员/设备仅在 L1+ 出现。
   - 打开「大脑建议」，点击某条带 `planId` 的建议的「采纳」，应跳转调度面板并展开对应方案。
   - 切换 `exoskeleton` 与 `device` 模式，确认外骨骼设备着色有差异。
   - 键盘快捷键 1-9 切换模式仍正常（证明 MODES 去重无回归）。