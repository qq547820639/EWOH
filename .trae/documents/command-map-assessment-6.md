# 指挥地图问题盘点（第 6 轮）

> 说明：第 5 轮整改计划（`command-map-assessment-5.md`）大部分已落地并覆盖：
> 大脑建议「采纳」闭环（planId 回填 + `/brain/apply`）、任务编排节拍数据驱动（占用率推算）、
> LLM 增强状态提示、调度确认/驳回/下发、班组长工作台可操作化。
> 本轮在代码走读基础上，发现 1 处**编译阻塞**、若干第 5 轮**未完全落地项**，以及新的体验问题。

## 一、阻塞问题（P0）

### 1.1 `orchestrateTask` 重复声明 `workstationIds`，导致编译失败（TS2451）
- [gamification.service.ts](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L285) 与
  [同一函数第 330 行](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L330)
  在同一 try 块作用域内各 `const workstationIds = ...` 一次。
- 后果：`npm run build:server` 报 `Cannot redeclare block-scoped variable 'workstationIds'`，服务端无法编译。
- 说明：第 5 轮「构建验证」未覆盖此改动，属于上轮引入的回归。

## 二、第 5 轮未完全落地（P1）

### 2.1 任务编排节拍「数据来源」未标注
- 服务端 `orchestrateTask` 已用工位占用推算节拍，但：
  - `stationTakts.push` 时**未回填** `taktSource: 'telemetry' | 'default'`
    （[gamification.service.ts#L352-L359](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L352-L359)）。
  - 返回的 `ProcessNode` 也未携带来源字段。
- 前端 [TaskOrchestrationPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx)
  的 `stationTakts` 只展示 `taktSec`，无「真实遥测 / 默认值」标识。
- 后果：4.2「演示可复现且标注来源」只完成一半，用户无法分辨节拍是真实推算还是默认值。

### 2.2 调度方案面板 ↔ 地图调度模式无联动（4.4 未落地）
- [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx) 无「在图上查看」入口；
  [FactoryMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx#L560-L590) 的 `scheduling` 模式
  仍只响应「当前选中人员」，与方案列表脱节。
- 后果：指挥官确认某方案后，地图不展示该方案「受影响人员」分布，无法直观评估调度影响。

### 2.3 班组长工作台批准/驳回仍是硬编码 reason（4.5 未落地）
- [WorkbenchPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/WorkbenchPanel.tsx#L240-L264)
  直接提交「班组长确认／班组长驳回」，无意见输入框，审计记录丢失决策依据。

## 三、新发现的问题（P2）

### 3.1 L3/L4 进入守卫不一致
- 键盘 `handleLevelToggle` 在无选中时拒绝进入 L3/L4 并提示；
  但侧栏 [ModePanel](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/ModePanel.tsx) 的
  `onLevelChange={setLevel}`（[CommandMap.tsx#L527](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx#L527)）
  直接 `setLevel`，绕过守卫。点击侧栏 L3 会进入近景但无选中实体，画面与层级标签不一致。

### 3.2 `getDispatchStatus` 死代码（4.6 未落地）
- [scheduler.service.ts#L741-L792](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.service.ts#L741-L792) 与
  [scheduler.controller.ts#L39-L42](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.controller.ts#L39-L42) 定义
  `GET /api/scheduler/plans/:planId/dispatch-status`，全仓前端无调用（下发走 `gamification.dispatchPlan`）。

### 3.3 「AI 数据驱动」仍是次级按钮（4.6 未落地）
- [SchedulePanel.tsx#L226-L244](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L226-L244)
  主按钮仍为「生成方案」（模板），「AI 数据驱动」为 outline 次级。

### 3.4 面板默认高度未抬高（4.6 未落地）
- [CommandMap.tsx#L593](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx#L593) 默认仍为
  `h-[220px] lg:h-[280px]`，方案表 11 列在默认高度下拥挤需横向滚动。

### 3.5 `canConfirm` 残留 `shadow` 状态
- [SchedulePanel.tsx#L292](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L292)
  `canConfirm = status === 'shadow' || status === 'proposed'`，但筛选已移除 `shadow`，属遗留逻辑。

### 3.6 大脑建议异步增强并发竞态
- [gamification.service.ts](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L618-L643)：
  缓存 TTL 过期时，每次轮询（前端 10s）都会 `void enrichBrainSuggestionsWithLlmAsync(suggestions)`；
  若 LLM 耗时 >10s，会重复触发多次增强。应加「增强进行中则跳过」的守卫。

### 3.7 采纳生成的新方案可能不在当前筛选内
- [BrainPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/BrainPanel.tsx#L183-L203)
  采纳后 `onSelectPlan(res.planId)` 跳转调度面板；若用户当时筛选了非 proposed 状态，
  [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L113-L124)
  的 `focusPlanId` 找不到目标行，聚焦失败且无提示。

---

## 四、整改方案

### 4.1（P0）修复重复声明
- 删除第 330 行重复的 `const workstationIds`（复用第 285 行结果），或改名为 `assignedWsIds` 并复用。

### 4.2（P1）任务编排节拍来源标注
- 服务端 `stationTakts.push` 回填 `taktSource`；`ProcessNode` 增加可选 `taktSource`。
- 前端 `stationTakts`/节点卡片标注「遥测推算 / 默认值」徽标。

### 4.3（P1）调度方案 ↔ 地图联动
- SchedulePanel 每行加「在图上查看」：解析 `metricsJson.affectedEntities` 传入 CommandMap。
- CommandMap 设 `focusPlanPersons` 传给 FactoryMap；`scheduling` 模式高亮这些人员并连线，其余灰显。

### 4.4（P1）班组长工作台批准/驳回增加可选意见
- 复用确认/驳回 Dialog，允许填意见；留空用默认「班组长确认/驳回」。

### 4.5（P2）清理与体验
- 侧栏 L3/L4 也走 `handleLevelToggle` 守卫（无选中时提示并拒绝）。
- 删除 `getDispatchStatus` 死代码（服务端 + 控制器 + openapi 类型）。
- SchedulePanel 将「AI 数据驱动」设为主按钮，模板降为次级对照。
- 默认面板高度抬高至 260px。
- 移除 `canConfirm` 中 `shadow` 分支。
- 大脑增强加「进行中」守卫；SchedulePanel 聚焦失败时自动切到「全部」筛选并提示。

---

## 五、验证
1. `npm run build:server` 与 `npm run build:client:standalone` 通过（修复编译阻塞）。
2. 任务编排多次模拟稳定，且标注节拍数据来源。
3. 确认方案后「在图上查看」能高亮受影响人员并连线。
4. 班组长工作台批准/驳回可填意见，审计记录带理由。
5. 侧栏点 L3/L4 无选中时被拦截并提示；键盘/侧栏行为一致。