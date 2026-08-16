# ADR-053：Rule-based Scheduling Solver（求解器插拔阶梯第 3 类，NO-13d）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-003（CP-SAT 部署形态与激活阶梯）、§8（Scheduler 求解器
  插拔：CP-SAT / MILP / heuristic / rule-based）、§9（差异边界显式）、
  §18（可解释性）、§31（共享候选语义）、§33

## 背景

solver-pluggability 矩阵缺口：heuristic + CP-SAT 双求解器存在，但
§8 要求的 MILP/rule-based 未接入；CP-SAT 因 ortools 无环境从未真实
求解（OPEN-DECISIONS 唯一项，10 项测试 skip——部署环境阻塞，非本轮
可解）。本轮接入**rule-based**（L1 确定性规则求解器，stdlib 零外部
依赖，无环境阻塞）作为求解器阶梯第 3 类：策略显式可选
（policy.solverVersion='rule-based-v1'）的确定性地板。

## §29 十八问（实现前作答）

1. **Domain**：Scheduler 求解器插拔（§8）。
2. **Canonical Contract**：SchedulingSolver 接口（scheduling-solver
   .interface.ts）+ SchedulingPlanV2；候选语义共享 CandidateEngine
   .buildCandidatePool（§31 单一实现——与 heuristic/CP-SAT 同一硬
   约束过滤面，端点与求解器共享语义不重复）。
3. **Authoritative Source**：求解语义 = 本 ADR + solver spec 锁定
   （确定性断言）；评分/约束权威 = SchedulingPolicy（版本化）。
4. **如何改变 Factory World**：产出 SchedulingPlanV2（shadow 方案，
   与 heuristic 同生命周期：approve/reserve/dispatch 链路复用）；
   不直接改世界状态。
5. **Event**：schedule.proposed 等方案事件由既有运行编排发出（本
   求解器不新增事件；solverStatus=RULE_BASED 如实标记）。
6. **谁消费**：scheduler run 编排（策略选择）、fallback 预演、可
   解释性对照（为什么 rule-based 选了 A——first-eligible 规则）。
7. **失败会怎样**：无可行候选 → 该任务 assignment 不产出 +
   violations 显式（UNASSIGNED_RULE_BASED，§33 不伪造分配）；
   引擎异常显式抛出（不静默降级到其他求解器）。
8. **离线会怎样**：云侧求解（无环境依赖；边缘本地调度为独立边界，
   本求解器不承诺边缘运行）。
9. **重复消息会怎样**：确定性纯函数（同 snapshot+constraints+opts
   → 同方案，deep-equal 断言锁定）——天然幂等可重放。
10. **权限边界**：求解只读快照；产出 shadow 方案（审批/派工链路
    权限不变）。
11. **租户边界**：快照/策略均租户作用域（既有）。
12. **安全风险**：supervisory 调度推荐（§2 边界不变；safetyBlocked
    过滤沿用候选引擎）。
13. **Human Approval**：shadow → 审批流不变（§2）。
14. **如何解释 Decision**：决策规则显式——任务序（due 升序 →
    priority 降序 → id 字典序）+ 候选序（startMs 最早 → 资源 id
    字典序）+ first-eligible；DecisionTrace 完整（selectedReason/
    rejectedHard/权重快照）。
15. **如何测试**：rule-based-scheduling-solver.spec 确定性断言
    （重放 deep-equal / 技能硬约束拒绝 / 证书约束 / DAG 前置序 /
    工位容量 / 安全封锁 / 无可行显式 UNASSIGNED / solverVersion
    标记 / metrics 经统一评估器）。
16. **如何审计**：solverStatus=RULE_BASED + solverVersion=
    rule-based-v1 如实标记（绝不冒充 heuristic/CP-SAT，Phase C
    同纪律）；trace 留痕。
17. **如何迁移**：新求解器 additive；policy.solverVersion 新值——
    既有策略值不变（缺省仍 heuristic）；无 DB/OpenAPI/env 变更。
18. **如何回滚**：删除 solver.service 路由分支 + 新文件即回滚。

## 决策

### 决策 1：rule-based-v1 语义（§9 差异边界显式）

- **任务序**：前置 DAG 拓扑序内按 (dueAtMs 升序, priority 降序,
  taskId 字典序) 稳定排序——确定性；
- **候选序**：buildCandidatePool 的 eligible 候选中按 (startMs
  最早, personId, deviceId, stationId 字典序) 取**首个**——纯规则
  first-eligible，**不做软成本 argmin**（与 heuristic 的差异边界：
  heuristic 做 8 权重软目标优化，rule-based 只满足 hard 约束）；
- **可解释性**：DecisionTrace.selectedReason=['rule-based:first-
  eligible']，rejectedHard=候选引擎结构化拒绝原因（capped）；
  hardConstraints/weightsSnapshot 随策略快照；
- **产出**：status='shadow'，solverStatus='RULE_BASED'，
  solverVersion='rule-based-v1'；metrics/baselineDelta 经
  SchedulingObjectiveEvaluator（与 heuristic/CP-SAT 同一评估器，
  P0-5：同一 snapshot+assignments → 同一输出，§31）。

### 决策 2：策略显式选择（无隐式自动回退）

solver.service：policy.solverVersion === 'rule-based-v1' → 路由到
ruleBasedSolver（显式策略选择，审计可见）；缺省/其他值行为不变
（heuristic canonical）。不做"heuristic 失败自动回退 rule-based"的
隐式阶梯（§33 不把 unknown 当 normal——回退语义需要显式设计与
决策，未来轮次立项）。

### 决策 3：MILP 接入随真实求解器库立项（§33）

MILP 需要求解器依赖（如 OR-Tools 同环境阻塞）——不虚构接口、不
mock 求解；与 CP-SAT 生产启用同列 OPEN-DECISIONS（环境阻塞），
rule-based 落地后 solver-pluggability 剩余缺口精确化。

## 后果

- 正：§8 阶梯第 3 类落地（CP-SAT/heuristic/rule-based 三类可插拔，
  策略显式可选）；确定性地板可重放；solver-pluggability 证据深化
  （矩阵保持 Partial：MILP 环境阻塞 + CP-SAT 生产启用待部署环境）。
- 负：rule-based 不做软目标优化（差异边界显式；需要优化质量的
  场景仍走 heuristic/CP-SAT）。
- 无破坏性变更（全 additive；无 DB/env/OpenAPI 变更）。
