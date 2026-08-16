# ADR-042：审批前自动布局仿真预验证（调度决策自动消费仿真，NO-12s）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-025（SimulationRun 四评估器）、ADR-036（仿真控制台）、
  ADR-038（Shadow 隔离）、§8（Scheduler 闭环）、§13（advisory 验证）、§18（可解释）

## 背景

L6 仿真体系（契约/台账/评估器/控制台）已齐备，但调度决策从未自动消费
仿真结果——§13「高风险计划应尽可能先在 Simulation 环境验证」在审批
时刻没有机器支撑。方案审批（PlanService.approvePlan）是人工决策门
（§2），在门之前需要确定性、可审计的预验证事实。

## 决策

### 决策 1：审批前自动运行布局仿真（layout 评估器）作为 advisory 预验证

approvePlan 在全部硬守卫（shadow guard/PLAN_STALE/安全关键锁定）通过
之后、状态落库之前：
- 从方案分配（personId/stationId/plannedStart）+ 当前快照工位坐标推导
  「人员移动图」（纯函数 buildPlanLayoutParameters：按人员分组、按
  plannedStart 排序、相邻不同工位 = 一条 trips=1 移动边）；
- SimulationService.run({kind:'layout', baseRef:{snapshotVersion:0,
  scenarioId:`plan:${planId}`}, parameters})——runId 确定性 =
  `plan-approval:${planId}`（台账幂等回读，重复审批不重复评估）；
- 结果（runId/status/totalTravelDistanceM/routesCount/engineVersion）
  写入审批审计 after.preApprovalSimulation + getPlan 附字段
  preApprovalSimulation（台账回读）——求解器 walkingMeters 的独立
  确定性交叉可审计（§18：解释来自真实评估器而非 LLM）。

### 决策 2：advisory 语义显式（绝不阻断审批）

仿真失败/服务未装配/无多工位移动链 → 显式留痕（error /
skippedReason: no_multi_station_route | simulation_service_unavailable）
+ 审批照常执行——审批仍是人工决策门（§2/§13），预验证是证据不是门。
快照使用断言已通过的当前快照（assertFreshForApprove 之后），
baseRef.snapshotVersion=0 + scenarioId 承载方案身份（契约允许的
显式语义，不伪造版本号）。

### 决策 3：确定性 + 缺事实显式

- 缺 plannedStart/personId/stationId 的分配显式跳过计数；
- 工位 x/y 为 null（UNKNOWN）→ 相关移动边显式跳过计数（不伪造坐标）；
- 全部边不可推导 → 返回 null，调用方显式 skip 留痕。

## 后果

- 正：审批时自动获得独立确定性行程验证（台账 + 审计 + API 三面可见）；
  L6 从「控制台人工触发」升级为「决策时刻自动消费」；
  intelligence-l6-simulation 证据深化（矩阵计数不变 48/7/0/1）。
- 负：approvePlan 增加一次推导 + 仿真运行（内存评估 + 台账写，毫秒级）；
  getPlan 增加一次按 runId 的台账查询（无运行时不附加字段）。
- 边界：预验证仅 layout 一型（移动图可确定性推导）；capacity/
  material_flow/what-if 的计划派生需领域模型深化后逐型接入。
