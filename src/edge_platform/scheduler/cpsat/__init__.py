"""CP-SAT 优化求解 Worker（智能调度 Solver 落地）。

定位：EWOH 的优化算法 Worker，承载 OR-Tools CP-SAT。
NestJS Scheduling V2 是唯一调度控制面（Source of Truth），本 worker 只负责在
给定 world-state 快照 + 约束 + 策略权重下求解一个任务→人员/设备/工位/时间的最优/可行分配，
并返回结构化、可解释的 SolverResponse。

依赖说明：
- 生产环境需安装 `ortools`（`pip install ortools`）。
- 若未安装，`solve()` 返回 solverStatus="UNAVAILABLE"，由控制面（NestJS SolverService）
  安全回退到 HeuristicSchedulingSolver，绝不冒充 CP-SAT 成功。

安全边界：
- 本 worker 只产出任务建议/方案/Assignment，不写入任何急停、限扭、关节控制、
  设备实时安全控制参数；安全硬约束（Safety Hold / forbidden zone / executing+locked
  不可移动）作为代码级硬约束保留，不可被配置或求解绕过。
"""