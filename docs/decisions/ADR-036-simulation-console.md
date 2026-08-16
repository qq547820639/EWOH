# ADR-036：L6 仿真运行控制台（SimulationRun 体系的生产消费面）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-025（SimulationRun 契约与四评估器）、§10（Level 6 Simulation /
  Digital Twin）、§13（生产/仿真隔离）、§17（Factory Operating Console）、§36

## 背景

ADR-025 已把 SimulationRun 建成一等资产：契约 + standalone_044 台账 +
四类确定性评估器（what_if/capacity/layout/material_flow）+ 目录事件 +
`/api/simulation/runs*` 3 路由 + Golden #19 + §13 三层隔离。但
intelligence-l6-simulation 仍是 Partial——**客户端零消费**：操作员无法在
控制台触发/查看任何仿真运行，§17「高价值页面应支持 Action」与 §36
「实际进入生产调用链」不成立；台账是写路径但没有操作面（只写接口没有
真正闭环）。

## 决策

### 决策 1：新建仿真推演控制台（/simulation，决策支持组）

`/simulation` 页面两栏：运行面板（四类评估器选择 + 基准快照引用 +
参数 JSON 编辑 + 运行）+ 运行台账（本租户列表 30s 轮询 + 详情 +
原始参数）。角色 = dispatcher / workshop_lead / global_admin（决策
支持面，与审批控制台同级）。

### 决策 2：预检是 UX 提示，服务端仍权威 fail-closed

`validateSimulationParameters(kind, parameters)` 镜像四评估器输入契约
做客户端预检（错误码直接提示），但**绝不代替**服务端
validateSimulationRun + 评估器 fail-closed——预检通过也可能被服务端
拒绝（如事实语义），客户端如实呈现服务端 failureReason。

### 决策 3：展示层绝不重算仿真结果

结果摘要（buildResultSummary）只做字段提取 + 文案/语调映射（瓶颈/
利用率/差集计数等直接透传评估器输出）；字段缺失显式 '—'；未知
kind 显式透出 `unknown_kind:*`（§33 不当作正常）。参数示例模板是
显式标注的示例（预填可改写），且示例本身必须通过预检（测试锁定）。

### 决策 4：失败与幂等语义显式

- 运行失败（评估器抛错）→ failed + failureReason 显式横幅 + 列表头条，
  可重新运行（服务端新 runId；同 runId 幂等回读既有运行，不重复评估）；
- 台账加载失败 → 显式错误 + 重试按钮（无静默 mock/空态伪装）；
- 运行结果只来自权威台账（POST 响应 + GET 列表同源），客户端无本地
  结果副本状态。

### 决策 5：不新建契约/事件/迁移

L6 消费面复用 ADR-025 全部既有资产（契约/台账/事件/隔离），本轮零
服务端变更——补的是「操作员 → 评估 → 台账 → 可见」的生产调用链。

## 后果

- 正：四类确定性仿真首次进入生产操作面（§17 Action + §36 调用链）；
  intelligence-l6-simulation 按 §36 升 Implemented（矩阵 46/9/0/1）。
- 正：高风险计划审批前人工 what-if 验证有了实际入口（§13「高风险计划
  尽可能先在 Simulation 环境验证」的操作面支撑）；调度决策自动消费
  仿真结果（审批时自动预验证）为后续增强，不在本轮。
- 负：新增一个客户端页面与 30s 台账轮询（有界 500 行，服务端已限）。
- 边界：控制台只读/只写台账（ewoh_simulation_run），绝不触碰生产
  World State；isSimulation=true 仍由契约 + DB CHECK + 服务层三层强制。
