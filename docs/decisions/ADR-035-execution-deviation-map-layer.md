# ADR-035：地图端执行偏差图层（planned vs actual 可视化，R-6）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-007（事件严重度阶梯）、ADR-029（任务↔派工状态同步）、
  ADR-034（Outcome 标注面）、§8（Scheduler 闭环）、§17（操作控制台）、§36（自我审查）

## 背景

执行反馈链在数据面已闭合：`ewoh_scheduling_execution`（standalone_046，
planned vs actual + deviationType 权威事实）+ GET /api/scheduler/executions +
决策驾驶舱消费（executionFeedbackVM / ExecutionDeviationList 列表）。
但地图端仍缺「动作执行以后是否达到预期」的空间表达：计划位置（工位）
与实际位置（执行人当前坐标）的偏差从未投影到工厂地图，闭环反馈的
最后一段视觉链路断裂（capability logistics-task-loop / closed-loop-
execution-feedback 据此保持 Partial）。

## 决策

### 决策 1：偏差图层是只读投影，不产生新事实、不新造偏差判定

地图偏差图层 = 既有权威事实（SchedulingExecution.deviationType/
deviationReason 由服务端判定）+ 既有坐标事实（WorldStateSnapshot
persons/devices/stations 的 x/y）→ 空间展示模型。客户端绝不重新判定
「是否偏差/何种偏差」；tone（critical/warning/neutral）与文案仅驱动
展示样式，不参与任何决策语义。§33：无第二事实源。

### 决策 2：纯 VM 装配（executionDeviationMapVM，node 可测）

- 纳入范围：deviationType != null → `deviated`（含终态，方案执行历史
  可见）；deviationType == null 且 STARTED/PAUSED → `ontrack`
  （进行中计划→实际进度连线）；无偏差终态不渲染（无信息量）。
- 坐标解析：计划点 = 任务工位（任务不在快照 → 回退 execution.stationId）；
  实际点 = 执行人当前坐标（无 → 回退设备）。工位 x/y 显式 null =
  UNKNOWN → 计划点 null；资源无坐标 → 实际点 null；两者皆记入
  `missingCoordinates`（显式记录，禁止 0,0 伪坐标）。
- delta 毫秒按偏差类型取事实对：START_DELAY=actualStart-plannedStart、
  END_DELAY=actualEnd-plannedEnd、TRAVEL_DELAY=actualTravel-plannedTravel；
  事实缺失 → null（不猜）。label 带符号（`+3.0min`/`-30s`，负=提前）。
- 未知 deviationType（运行时升级引入）→ label 原样透出 + tone=neutral
  （显式可见，绝不当作正常静默吞掉）。

### 决策 3：图层渲染多通道表达（非颜色唯一通道）

计划=空心方框、实际=实心圆点、计划→实际=虚线（偏差）/实线（进行中）
连接、偏差徽标文案 + delta + `<title>` 完整事实（task/status/偏差/原因/
时长）。critical（DEVICE_FAILURE/SAFETY_INTERRUPTION）红、
warning（时间/路线/可用性偏差）琥珀、neutral（资源变更）灰、
ontrack 绿。

### 决策 4：执行记录进入调度聚合状态（单一消费路径）

`CommandMapAggregate.executions`（+ `executionsError` 显式错误标记）由
useCommandMapSchedulerState 以 `GET /api/scheduler/executions?planId=`
拉取（enabled=有选中方案，30s 轮询），与列表面板同 queryKey 缓存复用
（React Query 去重，不产生第二请求源）。查询失败 → executions=[] 但
executionsError=true，图层开关旁显式「执行记录加载失败」提示
（§33 不静默 fallback）。查询失败不拉垮地图主体（hasError 不含此项，
面板/图层各自显式错误态）。

### 决策 5：图层开关（activeLayers 首次获得生产 UI）

`CommandMapLayer` 增加 `execution-deviation`；纯函数 `toggleLayer`
（开→追加保持顺序、关→移除、幂等、不可变、base 恒底层不可开关）；
地图视口左上新增桌面端图层开关 chip 组（含全部 11 个可开关图层 +
执行记录错误提示），移动端沿用既有小屏控件。选中方案切换时
selectedPlanId 变化自动带动 executions 查询换 key（selection owner
单一来源，无第二状态副本）。

## 后果

- 正：planned vs actual 偏差进入工厂地图空间表达，§37「执行到哪里 /
  结果如何」在地图端可答；logistics-task-loop / closed-loop-
  execution-feedback 缺口清零（矩阵 45/10/0/1）。
- 正：图层系统从「仅测试可写」变为生产可操作；执行偏差与列表面板
  同源同缓存，无第二事实源。
- 负：执行记录查询在选中方案存在时新增一个 30s 轮询请求（与列表
  面板共享缓存，无额外后端负载；无选中方案不请求）。
- 边界：图层仅展示事实，不提供任何写操作；偏差处理（replan 等）
  仍走既有服务端判定链路。
