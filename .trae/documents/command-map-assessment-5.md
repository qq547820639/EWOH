# 指挥地图问题盘点（第 5 轮）

> 说明：第 4 轮整改计划（`command-map-assessment-4.md`）已全部落地并验证：
> 数据驱动/AI 方案并存、Gamification 角色放开、编排发布聚焦、生产模式实时着色、
> 调度连线语义化、L3/L4 需选中进入、事件刷新统一、影子过滤移除。
> 本轮在前几轮基础上继续走读前后端，聚焦**建议转化闭环、真实数据驱动、面板面板联动与死代码清理**。

## 一、核心问题（P0）

### 1.1 大脑建议「采纳」闭环是空的——建议从不携带 planId
- [BrainSuggestion.planId](file:///workspace/ewoh-spark-app/shared/api.interface.ts#L879) 为可选字段，
  但 [gamification.service.ts](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L604-L799) 的
  `buildRuleSuggestions` 与 `enrichBrainSuggestionsWithLlm` **均不设置 planId**。
- 前端 [BrainPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/BrainPanel.tsx#L170-L179) 的「采纳」逻辑
  `if (s.planId && onSelectPlan)` 永远走不到，实际永远提示「建议已记录，等待人工评估」。
- 后果：评估 4.3 已实现的「采纳 → 定位到调度方案」功能**从未生效**；且建议无法一键转化为可审批的调度方案，
  指挥官看完建议后仍需手动去「调度方案」逐字段新建，闭环断裂。

### 1.2 任务编排节拍模拟是伪随机，非数据驱动
- [orchestrateTask](file:///workspace/ewoh-spark-app/server/modules/gamification/gamification.service.ts#L283-L286) 中
  `estimatedTakt = n.estimatedTakt ?? 30 + Math.random() * 30`，未分配到工位/人员的节点节拍为随机数。
- 后果：同一编排多次「节拍模拟」结果不可复现，且与真实工位负荷/设备遥测无关联，
  与「接入真实大模型调度」目标矛盾，演示易被质疑为「编出来的」。

## 二、体验问题（P1）

### 2.1 大脑建议无「LLM 增强中」状态提示
- 服务端采用「先返回规则建议、LLM 后台异步增强后回写内存缓存」的机制（见 1.1 服务端注释），
  但前端 [BrainPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/BrainPanel.tsx#L163-L168) 仅轮询展示，
  无任何「正在用大模型增强…」的加载态。
- 后果：用户看到的是规则建议，却不知道 AI 增强正在进行，误以为「AI 没生效」。

### 2.2 调度方案面板与地图调度模式无联动
- [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx) 只负责表格操作；
  [FactoryMap.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx#L559-L590) 的 `scheduling` 模式仅响应当前选中人员。
- 后果：指挥官确认某个方案后，地图上不会展示该方案「受影响人员」的分布，
  「调度影响态势」与方案列表脱节，无法直观评估。

### 2.3 班组长工作台批准/驳回硬编码 reason
- [WorkbenchPanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/WorkbenchPanel.tsx#L240-L264) 直接提交
  「班组长确认/班组长驳回」，无意见输入框，审计记录丢失决策依据（评估 4.8 的 P2 项未完全落地）。

## 三、小问题（P2）

### 3.1 `getDispatchStatus` 后端端点前端未调用（死代码）
- [scheduler.service.ts](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.service.ts#L741-L792) 与
  [scheduler.controller.ts](file:///workspace/ewoh-spark-app/server/modules/scheduler/scheduler.controller.ts#L39-L41) 定义了
  `GET /api/scheduler/plans/:planId/dispatch-status`，但全仓无前端调用（下发用的是 `gamification.dispatchPlan`）。
- 建议删除，或补上前端「下发冲突详情」展示以盘活。

### 3.2 「生成方案」主按钮仍是固定模板，且与数据驱动大量重复
- [SchedulePanel.tsx](file:///workspace/ewoh-spark-app/client/src/pages/CommandMap/panels/SchedulePanel.tsx#L226-L244) 主按钮为「生成方案」（模板）、次级为「AI 数据驱动」。
- 服务端 `generatePlans` 与 `getDataDrivenPlans` 逻辑高度重复（同为查设备/遥测/事件后生成 3 方案）。
- 建议：将「AI 数据驱动」设为主按钮直连真实数据，模板保留为对照；或合并两方法。

### 3.3 调度方案表格列过多、默认高度下拥挤
- 方案表 11 列（含操作），默认面板高 220px，需横向滚动且纵向可视行少。
- 建议：默认面板高度抬高，或对 metrics 列做折叠/省略。

---

## 四、整改方案

### 4.1（P0）打通「大脑建议 → 调度方案」转化闭环
- 服务端：`getBrainSuggestions` 返回前，为每条建议尝试关联最近 `proposed` 方案：
  - 若建议类型命中 `load_balance`→查 `strategy='load_balance'`、`battery_swap` 等，回填 `planId`；
  - 无匹配时，可新增转换接口 `POST /api/gamification/brain/:suggestionId/apply`，把规则建议落库为一条 `proposed` 方案再返回。
- 前端：BrainPanel「采纳」在有 planId 时定位到方案（现状）；无 planId 时调用转换接口生成方案后跳转。
- 目的：让「采纳」真正闭环，指挥官可一键把建议变成可审批方案。

### 4.2（P0）任务编排节拍改为数据驱动
- `orchestrateTask`：未指定节拍的节点，依据其 `assignedWorkstationId` 从 `ewoh_spatial_entity`/`ewoh_telemetry`
  取该工位最近 1h 平均占用/节拍作为基准，而非 `Math.random()`；无数据时用默认 30s 并标注「默认值」。
- 前端模拟结果增加「数据来源」标注（真实遥测 / 默认值），提升可信度。

### 4.3（P1）大脑建议增加「LLM 增强中」状态
- 服务端 `getBrainSuggestions` 返回中增加 `enhancing: boolean`（存在未完成的异步增强且缓存未命中时为 true）。
- 前端 BrainPanel 收到 `enhancing` 时展示顶部加载条「正在调用大模型增强…」，增强完成后刷新。

### 4.4（P1）调度方案面板与地图调度模式联动
- SchedulePanel 暴露「在图上查看」按钮：传入 `planId` 受影响人员（从 `metricsJson.affectedEntities` 解析）。
- CommandMap 设 `focusPlanPersons`，传给 FactoryMap；`scheduling` 模式仅高亮这些人员并连线，其余人员灰显。

### 4.5（P1）班组长工作台批准/驳回增加可选意见
- 复用确认/驳回 Dialog，允许填写意见；留空时用默认「班组长确认/驳回」文案。

### 4.6（P2）清理与体验
- 删除 `getDispatchStatus` 死代码（或前端补「下发冲突详情」）。
- SchedulePanel：将「AI 数据驱动」设为主按钮；合并 `generatePlans`/`getDataDrivenPlans` 重复逻辑。
- 默认面板高度抬高至 260px，方案表 metrics 列折叠进展开行。

---

## 五、验证
1. `npm run build:server` 与 `npm run build:client:standalone` 通过。
2. 大脑建议「采纳」能生成/定位到一条 `proposed` 方案，调度面板自动聚焦。
3. 任务编排多次模拟结果稳定（非随机），且标注数据来源。
4. 大脑建议面板在 LLM 增强期间显示加载态。
5. 确认方案后在调度模式地图上高亮受影响人员。