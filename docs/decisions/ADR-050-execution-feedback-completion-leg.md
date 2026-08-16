# ADR-050：执行反馈完成腿（feedback→assignment→task 状态推进，NO-13a）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-049（Canonical Execution Model 语义审计，决策 3 的后续）、
  ADR-029（边缘双向同步语义对齐）、§5（事件驱动）、§20（幂等/重复消息）、
  §21（时间语义）、§33（不伪造/不吞异常）、§36

## 背景

ADR-049 审计确认：执行反馈（POST /api/scheduler/feedback/actuals →
SchedulingFeedbackService.recordActuals）是**纯观测型**回填——actualStart/
actualEnd 只写 ewoh_scheduling_feedback 行，assignment 永远停在 dispatched、
task 永远停在 dispatched/received。Execution→Outcome 闭环在云侧断点：
任务实际完成的事实已存在，但任务/派工状态不随事实推进（状态分叉在
反馈腿复现）。canonical-execution-model 据此保持 Partial。

## §29 十八问（实现前作答）

1. **Domain**：Execution 域（执行反馈 → 状态推进腿，云侧）。
2. **Canonical Contract**：contracts/state-machines/task.yaml
   （nextTaskStatus/TASK_ACTIONS 消费面，ADR-049 锁步）+ AssignmentStatus
   词汇表（ADR-049 决策 2 映射）。
3. **Authoritative Source**：task.yaml 为任务状态唯一事实源；assignment
   状态由 ADR-049 差异边界映射（执行事实 → 派工状态）。
4. **如何改变 Factory World**：任务/派工状态事实随真实执行事实
   （actualStart/actualEnd）推进——世界状态中 task/assignment 状态
   不再滞后于反馈事实。
5. **Event**：每次派工推进写 ewohAssignmentEvent（fromStatus→toStatus
   + actor + reason='execution feedback …'）；任务推进由
   transitionTaskState 既有审计留痕（task.receive/task.start/
   task.complete）。
6. **谁消费**：任务看板/地图执行图层（assignment 状态）、replan
   锁定判定（executing/completed 冻结）、KPI（acceptance/override）。
7. **失败会怎样**：推进失败显式 log（任务状态非法/缺失 → skip +
   logger.warn，绝不阻断反馈写入、绝不伪造中间状态）；反馈主流程
   不受影响。
8. **离线会怎样**：云侧腿；边缘离线执行事实经既有 store-and-forward
   到达云后回放推进（幂等）。
9. **重复消息会怎样**：幂等——状态已在目标态 → no-op；CAS（where id
   + status ∈ 允许源集）防并发双写；重复 actualStart/actualEnd 覆盖
   式更新（既有语义）+ 推进 no-op。
10. **权限边界**：复用 recordTaskActuals 既有鉴权路径（执行方提交
    自己的执行事实）；本腿不改授权模型。
11. **租户边界**：GUC（buildGucSettings(ctx)）既有；无新跨租户路径。
12. **安全风险**：supervisory 状态推进（§2 边界不变）；不触及任何
    实时闭环。
13. **Human Approval**：执行事实推进无需人审（start/complete 为
    worker 角色契约转换）；异常解除（resolve）为 dispatcher 角色——
    反馈腿**不隐式 resolve**（见决策 2 边界）。
14. **如何解释 Decision**：推进 = 反馈事实（actualStart/actualEnd
    存在）+ 契约状态机最短合法链——确定性规则，无 LLM、无猜测。
15. **如何测试**：taskActionPath 纯函数测试（路径/不可达/空路径）；
    服务层 advancement spec（assignment CAS 推进 + 事件 + task 链
    应用 + 越界/终态 skip + 幂等）。
16. **如何审计**：assignment 推进 → ewohAssignmentEvent 行；task
    推进 → transitionTaskState 既有审计（actor/before/after）；
    跳过 → logger.warn 显式留痕。
17. **如何迁移**：无 DB 变更（复用 ewoh_assignment_event）；additive
    行为（观测型回填不变，追加推进）。
18. **如何回滚**：移除 recordActuals 内推进块即回滚（回到观测型）。

## 决策

### 决策 1：推进腿落点 = recordActuals（反馈唯一写路径）

SchedulingFeedbackService.recordActuals 在反馈行回填后追加推进：
- 匹配受影响 assignment（assignmentId/planId/taskId 同源条件）；
- actualStart≠null 且 assignment.status='dispatched' → CAS 推进
  'executing' + ewohAssignmentEvent(fromStatus→executing)；
- actualEnd≠null 且 assignment.status∈{dispatched, executing} →
  CAS 推进 'completed' + 事件（dispatched→completed 单事件——中间
  executing 未被观测，不伪造中间事件）；
- task 推进经注入的 TaskService（可选依赖，缺失则跳过——既有构造
  兼容）：按决策 2 边界 + taskActionPath 最短合法链逐动作调用
  transitionTaskState（每步 CAS + 审计）。
- recordActuals 返回 summary（additive）：{advancedAssignments,
  advancedTaskSteps, skips[]}；recordTaskActuals 响应 additive 透出。

### 决策 2：推进边界（显式声明，不猜）

- **start**（actualStart）：task current ∈ {dispatched, received} →
  链到 executing（dispatched→receive→start / received→start）；
  executing 已一致 → no-op；pending_dispatch（反馈早于派工）/paused/
  exception/终态 → skip+log。
- **end**（actualEnd）：task current ∈ {executing, received, paused} →
  链到 completed（executing→complete / received→start→complete /
  paused→resume→complete）；completed/cancelled 已一致 → no-op；
  **exception → skip**（异常解除是 dispatcher 显式 resolve 动作，
  反馈不隐式解除——与 ADR-049 差异边界一致）；其余 → skip+log。
- assignment 源集 {dispatched}（start）/ {dispatched, executing}
  （end）——approved 未派工不收 start（反馈早于派工视为乱序，skip）。

### 决策 3：taskActionPath 纯函数（与边缘 shortest_task_path 同语义）

task.service.ts 新增 `taskActionPath(current, target)`：TASK_ACTIONS
图上 BFS 最短动作链（同图即 task.yaml 锁步图）；不可达 → null；
current==target → []。与边缘 shortest_task_path（状态图上最短补全）
语义一致（§31：同语义双实现，各自锁步于同一契约图）。

## 后果

- 正：Execution→Outcome 云侧断点收口（反馈事实 → 任务/派工状态
  推进，幂等 + 事件 + 审计）；canonical-execution-model §36 全绿
  升 Implemented（矩阵 50/5/0/1→51/4/0/1）。
- 负：exception 不隐式 resolve（显式边界；异常任务仍需 dispatcher
  处置后反馈才可推进完成）。
- 无破坏性变更（观测型回填不变；推进 additive；无 DB/env/OpenAPI
  变更）。
