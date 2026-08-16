# ADR-058：MILP Scheduling Solver（HiGHS 真实求解器接入，NO-13i）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-053（求解器插拔阶梯与 MILP 环境阻塞声明）、ADR-003
  （CP-SAT 部署形态）、§8（CP-SAT / MILP / heuristic / rule-based 插拔）、
  §9（差异边界显式）、§18（可解释性）、§31（共享候选语义）、§33

## 背景

NO-13i 再评估（§27 先读仓库事实）：solver-pluggability 剩余缺口 =
MILP 接入 + CP-SAT 生产启用。本轮核实环境事实：

- npm registry 可达；`highs`（highs-js 1.15.2，MIT）可用——HiGHS
  （爱丁堡大学高性能 C++ 求解器）的 WebAssembly 构建，**真实 MILP
  求解器**（非虚构接口，§33），无传递依赖，unpacked ~3.5MB；
- 本地冒烟验证：整数规划求解 Optimal / Infeasible / 同输入两次
  求解结果逐位一致（确定性可重放）。

因此 ADR-053 决策 3 的"MILP 环境阻塞"解除：MILP 接入本轮落地。
CP-SAT 生产启用仍为部署环境阻塞（OPEN-DECISIONS 保留）。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 求解器插拔（§8）。
2. **Canonical Contract**：SchedulingSolver 接口（scheduling-solver
   .interface.ts）+ SchedulingPlanV2；候选语义共享 CandidateEngine
   .buildCandidatePool（§31 单一硬约束面——与 heuristic/rule-based/
   CP-SAT 同一候选引擎）。
3. **Authoritative Source**：求解语义 = 本 ADR 决策 1-3 + spec 锁定
   （确定性断言）；评分/约束权威 = SchedulingPolicy（版本化）。
4. **如何改变 Factory World**：产出 SchedulingPlanV2（shadow 方案，
   与其余求解器同生命周期：approve/reserve/dispatch 复用）；不改
   世界状态。
5. **Event**：不新增事件；solverVersion='milp-v1' +
   solverStatus='OPTIMAL' 如实标记（与 rule-based 同纪律）。
6. **谁消费**：scheduler run 编排（策略显式选择）、求解质量对照
   （heuristic 贪心 vs MILP 精确最优）。
7. **失败会怎样**：任务无可行候选 → 该任务不产出 assignment +
   violations 显式 UNASSIGNED_MILP（§33 不伪造）；HiGHS 加载/求解
   异常或非 Optimal 状态 → **显式抛出**（不静默降级到其他求解器，
   §33 不把 unknown 当 normal）。
8. **离线会怎样**：云侧进程内求解（WASM 随包分发，无网络/外部
   服务依赖）；边缘本地调度为独立边界（本求解器不承诺边缘运行）。
9. **重复消息会怎样**：确定性纯函数（同 snapshot+constraints+opts
   → 同方案：LP 文本确定性构造 + threads=1 + random_seed=0 固定；
   同环境重放锁定；跨平台逐位一致不在承诺内，差异边界显式）。
10. **权限边界**：求解只读快照；产出 shadow 方案（审批/派工链路
    权限不变）。
11. **租户边界**：快照/策略均租户作用域（既有）。
12. **安全风险**：supervisory 调度推荐（§2 边界不变；safetyBlocked
    过滤沿用候选引擎）。
13. **Human Approval**：shadow → 审批流不变（§2）。
14. **如何解释 Decision**：MILP 目标函数 = 与 heuristic 同一
    per-candidate 加性评分（scoreBreakdown.total 七项线性组合）；
    冲突行显式（资源重叠/工位容量/DAG 时序）；DecisionTrace
    selectedReason=['milp:exact-optimal'] + rejectedHard + 权重
    快照；violations 区分 no_eligible_candidate /
    predecessor_unassigned / no_feasible_assignment_milp。
15. **如何测试**：milp-scheduling-solver.spec 确定性断言（最优性
    vs 穷举 / 容量冲突 / DAG 闭包与时序冲突 / 无候选显式 / 重放
    deep-equal / WASM 失败显式抛出 / solverVersion·solverStatus
    标记）；真实 HiGHS 求解（非 mock）。
16. **如何审计**：solverVersion='milp-v1' + solverStatus='OPTIMAL'
    如实标记（绝不冒充 heuristic/CP-SAT）；solveDurationMs +
    planId 链；objective 经统一评估器（与其余求解器同口径）。
17. **如何迁移**：新求解器 additive；policy.solverVersion 新值
    'milp-v1'——既有策略值不变（缺省仍 heuristic）；无 DB/OpenAPI/
    env 变更（SolverActivationState 联合 additive + 'MILP'）。
18. **如何回滚**：删除 solver.service 路由分支 + 新文件 + highs
    依赖即回滚。

## 决策

### 决策 1：milp-v1 语义（§9 差异边界显式）

- **候选面**：每任务经 CandidateEngine.buildCandidatePool 构建
  静态候选池（booked 数组由快照 reservations 播种——与 heuristic
  生产路径同语义；lockedPerson/lockedDevice 透传）；eligible 候选
  → 二元变量 x[t][c]。
- **约束（MILP 行）**：
  1. 每任务至多一候选：Σ_c x[t][c] ≤ 1；
  2. 人员重叠：两任务候选同 personId 且时间窗 [startMs,endMs)
     重叠 → x[a]+x[b] ≤ 1（人一次一任务）；
  3. 设备重叠：同 deviceId 重叠 → x[a]+x[b] ≤ 1；
  4. 工位窗口容量：station 容量 K（快照 station.capacity，null
     不限制）→ 对每个工位候选 c：Σ_{c' 同工位且与 c 窗口重叠}
     x[c'] ≤ K + |O(c)|·(1 − x[c])（K=1 退化为成对互斥；与候选
     引擎"同时段任务数 ≥ capacity 拒绝"语义一致）；
  5. DAG 闭包：边 a→b → Σ x[b] ≤ Σ x[a]（前置未分配则后继不得
     分配）；
  6. DAG 时序：c_a.endMs > c_b.startMs 的组合 → x[a][c_a] +
     x[b][c_b] ≤ 1（后继须在前置结束后开始）。
- **目标**：min Σ_{t,c} cost(t,c)·x[t][c] + M·Σ_t (1 − Σ_c
  x[t][c])，其中 cost(t,c) = scoreBreakdown.total（与 heuristic
  同一七项线性评分，§31），M = 1 + ⌈Σ_{t,c} cost⌉（成本非负 →
  M 严格大于任一可行解的全部成本差，**可证明**先最大化分配数、
  再最小化成本的字典序语义——不猜、不魔数）。
- **差异边界（§9 显式）**：heuristic = 顺序贪心 argmin（候选
  eligibility 随先占预订动态收紧）；MILP = 同一候选面/同一评分
  上的**联合精确整数规划**（资源占用为显式行而非贪心先占）。
  因此：无资源冲突时两者同解；有冲突时 MILP 可更优（贪心非精确）。
  目标函数一致，语义差异只在"联合 vs 贪心"。
- **求解器**：HiGHS 1.15.2（WASM，进程内，MIT），solve 参数固定
  output_flag=false / log_to_console=false / threads=1 /
  random_seed=0（确定性）。
- **状态映射**：Status='Optimal' → solverStatus='OPTIMAL'；其余
  状态（Infeasible/Unbounded/…——本模型恒可行，出现即实现缺陷）
  → 显式抛错，绝不产出伪造方案（§33）。
- **可解释性**：selectedReason=['milp:exact-optimal']；
  rejectedHard=候选引擎结构化拒绝原因（capped 12）；violations
  类型 UNASSIGNED_MILP，原因三分：no_eligible_candidate /
  predecessor_unassigned / no_feasible_assignment_milp（容量或
  时序冲突，含 eligibleCandidateCount）。
- **产出**：status='shadow'，solverVersion='milp-v1'，
  solverStatus='OPTIMAL'；metrics/baselineDelta 经
  SchedulingObjectiveEvaluator（与 heuristic/rule-based/CP-SAT
  同一评估器，§31）。

### 决策 2：策略显式选择（无隐式自动回退）

solver.service：policy.solverVersion === 'milp-v1' → 路由到
MilpSchedulingSolver（显式策略选择，审计可见；solverActivation
state='MILP' 如实记录）。不做"heuristic 失败自动回退 MILP"或
"MILP 失败回退 heuristic"的隐式阶梯（§33——回退语义需要显式设计
与决策）。

### 决策 3：CP-SAT 生产启用仍为环境阻塞

CP-SAT 真实求解与生产启用依赖 OR-Tools 服务器部署（OPEN-DECISIONS
保留，唯一项）；MILP 落地后 solver-pluggability 剩余缺口精确化为
CP-SAT 生产启用一项。矩阵保持 Partial（§36 不提前升 Implemented）。

## 后果

- 正：§8 阶梯第 4 类落地（CP-SAT/heuristic/rule-based/MILP 四类
  可插拔）；MILP 为真实求解器（非虚构接口）+ 精确最优（与贪心
  差异边界显式）+ 可重放 + 可解释；OPEN-DECISIONS MILP 阻塞解除。
- 负：HiGHS WASM ~3.5MB 依赖（构建产物随包分发）；MILP 行数随
  候选规模增长（成对冲突行 O(n²)，大规模实例性能未承诺——差异
  边界：heuristic 保持大规模 canonical 路径）；跨平台逐位确定性
  不承诺（同环境重放锁定）。
- 无破坏性变更（全 additive；无 DB/env/OpenAPI 变更；
  SolverActivationState 联合 additive）。
