# ADR-049：Canonical Execution Model 语义审计 + 跨运行时锁步（NO-12z）

- 状态：Accepted
- 日期：2026-08-16
- 关联：ADR-029（边缘 task↔assignment 双向同步）、§3（Canonical
  Execution Model）、§9（多 Scheduler 语义审计 + 跨语言 Conformance）、
  §31（重复实现 → 共享测试向量）、§30（先修契约/边界）

## 背景

canonical-execution-model 的矩阵记录停留在 R-3 遗留（"边缘 execute 不
推进 Task 状态，task↔assignment 状态分叉"）。本轮按 §9 纪律先做语义
审计（不直接改代码），审计结论与矩阵记录的差异是：

### 审计结论（§9，逐实现读码，不猜）

| 事实 | 状态 | 证据 |
|---|---|---|
| task.yaml ↔ Python TASK_TRANSITIONS | **已锁步**（contract-state-machine 门禁 + 负测试） | src/edge_platform/scheduler/models.py + tests/test_state_machine_contract.py |
| task.yaml ↔ TS nextTaskStatus | **未锁步**（手写 switch，无一致性门禁——语义当前一致但漂移不可检测） | ewoh-spark-app/server/modules/task/task.service.ts |
| 边缘 execute → Task 状态推进 | **已收口**（ADR-029：execute→_sync_task_status_on_dispatch；set_assignment_status↔update_task 双向同步，乐观锁失败显式留痕） | src/edge_platform/scheduler/scheduler_service.py:536-586, 703-815 |
| 云侧 dispatch → Task 状态推进 | **已收口**（dispatch-coordinator 第 7 步：assignee/device 更新 + pending_dispatch → transitionTaskState('dispatch')，CAS + 审计） | dispatch-coordinator.service.ts:298-315 |
| 云侧执行反馈 → assignment/task 完成推进 | **未收口**（assignment 无 executing/completed 推进路径；ewoh_scheduling_execution 独立词汇表 PLANNED/…/COMPLETED/CANCELLED/FAILED 与 task/assignment 状态机不联动） | execution.service.ts / feedback 路径 |
| 三套执行词汇表（task 状态机 / assignment 9 态 / execution 词汇表） | 并存且**无显式映射声明** | task.yaml、shared/scheduler.ts AssignmentStatus、execution.service.ts |

即：R-3 遗留本身已收口；真实剩余缺口 = (a) TS↔契约无锁步门禁
（§31 违反），(b) 云侧执行反馈完成腿未接线（Execution→Outcome 断点），
(c) 三词汇表映射未声明（§9 差异边界缺失）。

## §29 十八问（实现前作答）

1. **Domain**：Execution 域（task 状态机 + assignment/execution 词汇表）。
2. **Canonical Contract**：contracts/state-machines/task.yaml（唯一
   事实源；Python 已锁步，本轮补 TS 锁步）。
3. **Authoritative Source**：task.yaml；TS 运行时表 = 契约消费面
   （锁步 spec 逐条比对，§31 单一语义）。
4. **如何改变 Factory World**：本轮不改世界状态——锁步门禁使 TS
   状态机与契约不可漂移；差异边界声明使三词汇表映射可审计。
5. **Event**：无新事件（执行反馈完成腿的事件面随 NO-13a 立项）。
6. **谁消费**：task.service（nextTaskStatus）、scheduler
   task-lifecycle 分类、dispatch/反馈路径。
7. **失败会怎样**：锁步 spec 失败 = 构建失败（漂移显式暴露）；
   运行时状态机语义不变（数据化重构行为逐字一致）。
8. **离线会怎样**：状态机纯函数，无 IO 依赖（边缘/云同语义可离线
   判定）。
9. **重复消息会怎样**：nextTaskStatus 幂等纯函数（同输入同输出）；
   并发由调用方 CAS 处理（既有）。
10. **权限边界**：状态机无权限概念（role/condition 语义保留在
    task.yaml 注释面；运行时权限由服务层执行）。
11. **租户边界**：状态机无租户概念（调用方 org 上下文既有）。
12. **安全风险**：不触及任何实时闭环（§2 边界不变）；只约束
    任务状态事实。
13. **Human Approval**：approve/reject 转换的角色（approver）语义
    保留在契约；本轮不改审批路径。
14. **如何解释 Decision**：状态转换合法性由契约逐条判定（可引用
    task.yaml 转换行解释）。
15. **如何测试**：TS 锁步 spec（yaml 逐条比对 + 穷举负例 + 检查器
    负测试——与 Python 负测试同纪律）。
16. **如何审计**：转换经 transitionTaskState 既有审计路径；
    锁步 spec 是构建门禁。
17. **如何迁移**：无 DB 变更；nextTaskStatus 数据化重构行为逐字
    一致（task.service.spec 回归锁定）。
18. **如何回滚**：还原 switch 实现即回滚（锁步 spec 同时失效——
    回滚 = 删除 spec + 还原实现）。

## 决策

### 决策 1：TS nextTaskStatus 数据化为契约消费面 + 锁步 spec

- task.service.ts：nextTaskStatus 改由 `TASK_ACTIONS`（action →
  from → to 数据表）驱动；cancel 的 any_non_terminal 语义由
  TASK_NON_TERMINAL 显式表承载（行为与既有 switch 逐字一致，
  task.service.spec 回归锁定）。
- 新增 `ewoh-spark-app/test/unit/task/task-state-machine-contract.spec.ts`：
  - 加载 contracts/state-machines/task.yaml（js-yaml）逐条比对：
    每个显式转换必须在 TASK_ACTIONS 中有一致 action 映射；TASK_ACTIONS
    不得存在契约外转换；terminal 集合一致；
  - 穷举负例：11 状态 × 14 动作的期望值由 yaml 推导，nextTaskStatus
    与推导逐格一致（漂移即失败）；
  - 检查器负测试：人为缺失转换的伪表必须被检查器检出（与 Python
    test_contract_drift_is_detected 同纪律）；
  - task-lifecycle.ts 分类集合（schedulable/locked/dispatchable/
    executing/terminal）与 yaml 状态集锁步（历史别名 pending/queued/
    done 显式声明为兼容别名，非契约状态）。

### 决策 2：差异边界显式声明（§9）

三套执行词汇表并存是当前架构事实，本轮不强行合并（§30 避免无目的
大重写）——在 ADR 中声明映射边界：

- task 状态机（task.yaml，11 态）= **任务事实**的唯一状态机；
- AssignmentStatus（9 态）= **派工协调**词汇表；与 task 的映射：
  dispatched→dispatch 动作、cancelled→cancel 动作（仅显式动作触发，
  计划拒绝不隐式取消任务——与边缘 set_assignment_status 语义对齐，
  声明为边界）；
- execution 词汇表（PLANNED/IN_PROGRESS/COMPLETED/CANCELLED/FAILED）
  = **执行观察**词汇表；与 task 的联动（feedback 完成 → task
  complete）为 NO-13a 立项（需要 feedback→assignment→task 推进链 +
  事件面设计，本轮不做语义猜测）。

### 决策 3：执行反馈完成腿 = NO-13a（后续轮次）

云侧 assignment/task 的 executing/completed 推进（Execution→Outcome
闭环断点）需要 feedback 应用路径 + 幂等/冲突语义设计，单独立项；
本轮先立锁步与边界声明（§30：先修契约/边界再修实现）。

## 后果

- 正：§31 违反项清零（TS 状态机与契约锁步，漂移构建期暴露）；
  §9 语义审计完成（三实现状态明示 + 差异边界可审计）；矩阵
  canonical-execution-model 证据与剩余缺口精确化（R-3 遗留已收口的
  审计事实入档）。
- 负：执行反馈完成腿未接（canonical-execution-model 保持 Partial，
  剩余缺口 = NO-13a）。
- 无破坏性变更（数据化重构行为逐字一致；无 DB/env/OpenAPI 变更）。
