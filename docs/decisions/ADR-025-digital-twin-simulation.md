# ADR-025：Digital Twin Simulation 体系（§13 仿真能力面成体系）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-008（World State 契约）/ ADR-020（推理层）/ §13 Digital Twin
- 驱动：NO-12a（Round 45，Phase 10：What-if/容量/布局/物料流仿真成体系 +
  模拟数据显式隔离的数据库级强制）

## 背景

§13 要求 Digital Twin 承担 State Reconstruction/Replay/What-if/Scheduling/
Capacity/Layout/Material Flow/Risk/Maintenance/Production Simulation/Agent
Sandbox，且"生产系统和 Simulation 系统必须明确隔离，模拟数据必须显式标记，
绝不能被生产 World State 当成真实数据"。现状：
- State Reconstruction/Replay 真实（world/timeline 模块）；
- twin/package.py（twin 资产 manifest 校验）+ 边缘 simulator + 场景评估为
  库级/工程自测——**仿真运行不是一等资产**（无契约/无台账/无事件/无隔离
  数据库级强制）；What-if/容量/布局/物料流仿真未成体系。

## 决策

### 决策 1：仿真运行 = 契约（contracts/simulation/simulation-run.schema.json）

meta-contract 同风格，v1.0.0：
- **kindRegistry**（封闭）：what_if / capacity / layout / material_flow
  （v1 四类；scheduling/risk/maintenance/production 场景随引擎扩展走契约
  小版本——绝不注册无引擎的空类型）；
- **statusRegistry**：created / running / completed / failed；
- **规则（机器可判定）**：isolation 强制——record.isSimulation 必须 true
  （§13 模拟数据显式标记的契约面）；baseRef 声明基准世界快照（what_if 可
  追溯"从什么状态改了什么"）；parameters 必填对象；completed 必须带
  results；failed 必须带非空 failureReason；auditTrail 必须 true。
- Python/TS 双实现 + 共享向量 + audit-domain-contracts simulation 域 +
  Golden 第 19 场景（含跨语言引擎执行仲裁，同 ReasoningTrace 模式）。

### 决策 2：持久化 = standalone_044 `ewoh_simulation_run`

TENANT_SCOPED RLS（simulation_run_org_isolation）+ CHECK（kind/status 枚举
/ **is_simulation = true 强制**——§13 隔离的数据库级不变量）+ UNIQUE
(org_id, run_id)。runId 由服务端生成（sim:{ts}:{rand}）；结果落
result_json（审计同源）。**仿真运行绝不写生产 World State 表**：结果只在
台账内（隔离由表级强制 + 契约面双保险）。

### 决策 3：v1 四类确定性评估器（§18 同源：公式来自事实，非 LLM）

双运行时锁定语义一致（TS 生产引擎 + Python 标准库独立实现供跨语言仲裁，
同 Scheduler/Reasoning TCK 模式）：
- **what_if**：基准事实 + 场景 delta → 推理引擎（ADR-020 evaluateReasoningRules）
  对基准与扰动事实分别评估 → 结论差集 = what-if 结果（新增/消失/强度变化
  结论，可解释）；
- **capacity**：站点产能 min(capacityPerHour) = 线节拍瓶颈；utilization =
  demand / bottleneck（>1 显式过载）；
- **layout**：给定站点坐标 + 搬运次数 → 总运输距离；delta 布局 → 距离差；
- **material_flow**：各站点 inflow vs capacity → 瓶颈负载比（max 负载站点
  显式命名）。
输入经参数契约校验（fail-closed：缺参数/未知字段拒绝，不猜测）。

### 决策 4：事件 = SimulationRunCreated / SimulationRunCompleted（57→59）

`com.ewoh.simulation.run_created` / `com.ewoh.simulation.run_completed` +
channel + 双运行时投影。创建/完成幂等（与既有台账同语义）。

### 决策 5：云侧 `simulation` 模块 = 唯一权威运行面

SimulationRunService（create 契约 fail-closed + 隔离强制 → 事件；complete
契约校验（results/隔离）→ 事件；list 租户作用域）+ WhatIf/Capacity/
Layout/MaterialFlow 四评估器（纯函数，契约化输出）+ OpenAPI 路由。
租户边界 orgId + RLS 双保险。

## 后果

- 正面：仿真运行成为一等资产（契约 + 台账 + 事件 + 隔离数据库级强制）；
  What-if/容量/布局/物料流四类确定性仿真成体系（可解释/可仲裁/可审计）；
  digital-twin-simulation 按 §36 升 Implemented（矩阵 42/13/0/1）。
- 代价：新契约 + 新表 + 新模块；四评估器为 v1 简单确定性模型（演进走
  契约小版本与模型注册表）。
- 无破坏性变更（全 additive）。

## Rejected Alternatives（否决方案）

1. **仿真结果写生产 World State 表**：违反 §13 隔离红线；隔离由
   standalone_044 表级 + isSimulation 契约 + 不写生产表三层强制。
2. **注册无引擎的 scenario 类型**：接口空壳违反 §33/§36（只写接口没有
   真正闭环）；v1 四类全部有确定性评估器。
3. **LLM 生成仿真结果**：违反 §18（公式/结果必须来自真实事实与确定性
   模型）；LLM 只允许解释。
4. **仿真运行仅内存/日志**：不可审计不可重放（§3）。
