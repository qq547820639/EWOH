# 指挥地图问题盘点（第 4 轮）

> 说明：第 3 轮整改计划（`command-map-assessment-3.md`）已落地（死代码清理、大脑建议采纳跳转、
> L0/L1 门控、模式去重与着色、面板最大化、L3/L4 需选中进入、环境空态）。
> 本轮在复核这些已实现的基础上，通过走读前后端代码，发现**业务闭环与权限**层面的新问题。

## 一、核心问题（P0，影响功能可用性）

### 1.1 调度方案「生成」走的是固定模板，而非数据驱动/AI 方案
- 前端 [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L129-L138) 的「生成方案」调用 `generatePlans({})`
  → `POST /api/scheduler/plans` → [scheduler.service.ts 的 generatePlans](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.service.ts#L64-L207)，
  生成的是**硬编码三部曲**（保持现状/产能优先/负荷均衡），节拍提升 0 / 8.5 / 3.2 是写死的。
- 真正基于实时遥测/电量的 `getDataDrivenPlans`（`POST /api/scheduler/plans/data-driven`）虽然存在且含 AI 推荐方案，
  **前端从未调用**。
- 后果：与「接入真实大模型调度」目标矛盾——指挥官点「生成方案」拿到的仍是模板，看不到 AI 数据驱动/LLM 增强的差异。

### 1.2 Gamification 控制器权限被锁死在 admin，班组长/调度员无法使用
- [gamification.controller.ts](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.controller.ts#L13) 全局 `@Roles('global_admin', 'safety_admin')`。
- 该控制器承载了：任务编排(`orchestrate`)、**调度下发(`dispatch`)、大脑建议(`brain/suggestions`)、资源分配(`allocate`)`。
- 而指挥地图的目标用户是 `dispatcher`（调度员）/ `workshop_lead`（班组长/车间主任）。这些角色一旦登录：
  - 大脑建议面板 → 403「加载失败」；
  - 任务编排「节拍模拟」→ 403；
  - 调度方案「下发」→ 403；
  - 资源池「提交分配」→ 403。
- 对比：调度方案的「确认/驳回」在 [scheduler.controller.ts](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.controller.ts#L20) **无任何角色门控**（任意登录可用）。
  同一看板上「能确认但不能下发/不能看大脑建议」自相矛盾。

### 1.3 任务编排「发布到调度审批」未聚焦到新方案
- `orchestrateTask` 已在 DB 插入 `proposed` 方案（`planId=ORCH-xxx`），但
  [TaskOrchestrationPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx#L422-L431) 的「发布到调度审批」仅 `onOpenSchedule()` 切 tab。
- 用户切到调度面板后需在 11 列表格中自行查找刚生成的方案，无法确认闭环成功。

## 二、体验问题（P1）

### 2.1 生产模式工位着色不反映实时节拍
- [FactoryMap.tsx getEntityColor](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx#L46-L97) 的 `production` 分支用**静态 `entity.status`** 着色工位；
  而 flowLines / WIP 气泡用的是 `worldState.workstations.occupancy`。
- 后果：默认「生产」模式（L1）工位颜色与实时产出脱节，只有切到 L2 才看到真实节拍态势，默认视角失真。

### 2.2 调度模式连线无真实语义
- [FactoryMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx#L551-L560) 在 `mode==='scheduling'` 时把**所有人员按列表顺序**连成一条折线，
  并非反映某个被选中方案的实际受影响人员关系，易误导指挥官。

### 2.3 L3/L4 键盘循环进入仍突兀
- 按 `L` 从 L2 到 L3 未选中实体时，地图停在 L3 但 `focus=null`，仅提示「请先选择工位/人员」。
  此时 L3 视觉与 L2 无异，层级指示与画面不一致，易迷失。建议未选中时自动回退 L2，或进入前必须选中。

### 2.4 事件处置后刷新不一致
- CommandMap 的 `handleEvent` 成功只 invalidate `['events']`；
  而 [EventCenterPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/EventCenterPanel.tsx#L109-L113) 用 `queryKeys.events(statusFilter)` 作为 key。
- 处置后事件中心的「待处理」过滤可能不立即刷新。

## 三、小问题（P2）

### 3.1 方案状态过滤含「影子」但生成的是「建议」
- [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L38-L44) 过滤含 `shadow`，但所有生成方案默认 `proposed`，选「影子」永远是空列表，易困惑。

### 3.2 班组长工作台「批准/驳回」硬编码 reason
- [WorkbenchPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/WorkbenchPanel.tsx#L240-L264) 直接以「班组长确认/班组长驳回」提交，无意见输入，审计丢失决策依据。

---

## 四、整改方案

### 4.1（P0）「生成方案」切换为数据驱动/AI 路径
- 前端 [api/scheduler.ts](file:///workspace/ewoh-spark-app/client/src/api/scheduler.ts) 新增 `generateDataDrivenPlans()`；
- SchedulePanel「生成方案」改调数据驱动接口（或保留模板按钮、新增「AI 数据驱动」按钮，二者并存便于对比）。
- 若仍需 LLM 增强，可复用已有的异步 LLM 增强模式（同大脑建议）。

### 4.2（P0）放宽 Gamification 角色门控
- 将 [gamification.controller.ts](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.controller.ts#L13) 的 `@Roles` 扩为
  `'dispatcher', 'workshop_lead', 'safety_admin', 'global_admin'`（资源分配/下发/编排/大脑建议均对指挥层开放）。
- 敏感操作（下发、资源分配）若需更严，可在方法级用 `@Roles('global_admin','safety_admin')` 单独收紧，而非整控制器锁死。

### 4.3（P0）任务编排发布后聚焦新方案
- `orchestrateTask` 返回 `planId`；TaskOrchestrationPanel 记录最新 `planId`，
  「发布到调度审批」改为 `onOpenSchedule(planId)`；
- CommandMap 把该 planId 传入 `SchedulePanel.focusPlanId`（复用现有聚焦逻辑）。

### 4.4（P1）生产模式工位按实时 occupancy 着色
- `getEntityColor` 的 `production` 分支改为读取 `worldState.workstations` 的 occupancy/status，
  与 L2 的 WIP 逻辑保持一致，使默认视角即反映真实产出。

### 4.5（P1）调度模式连线改为「受影响人员/选中方案」语义
- 仅当存在 `selectedEntityId` 或被采纳方案关联人员时连线，否则移除该折线或显示空态说明。

### 4.6（P1）L3/L4 未选中自动回退
- `handleLevelToggle` 进入 L3/L4 前校验 `selectedEntityId`，无选中则停留在当前层级并 toast 提示。

### 4.7（P1）统一事件刷新键
- CommandMap 处置后同时 invalidate `queryKeys.events(...)` 相关 key，或让 EventCenterPanel 复用同一 key。

### 4.8（P2）过滤/审批体验
- 移除或标注「影子」过滤项；WorkbenchPanel 批准/驳回可加可选意见输入（默认保留现有快捷文案）。

---

## 五、验证
1. `npm run build:server` 与 `npm run build:client:standalone` 通过。
2. 以 `dispatcher`/`workshop_lead` 登录：大脑建议、任务编排、下发、资源分配均可用。
3. 点「生成方案」应看到基于实时电量的 AI 数据驱动方案（非固定 8.5%/3.2%）。
4. 任务编排后「发布到调度审批」应自动定位到新方案。
5. 默认生产模式工位颜色反映实时节拍；调度模式无杂乱连线。