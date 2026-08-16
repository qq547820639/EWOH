# ADR-029：边缘任务↔派工状态机同步（closed-loop execution feedback，R-3 收口）

- 状态：Accepted
- 日期：2026-08-16
- 关联：R-3（codebase-walkthrough 遗留）、§3（Factory Truth）、§6（边缘架构）、Phase 6 执行反馈闭环

## 背景

R-3 遗留：边缘调度闭环中 Task（schedule_task 事实）与 Assignment（派工事实）
存在两条独立写路径——

- `execute()`（plan→dispatched）创建正式派工（Assignment.status=dispatched），
  **但不推进对应 Task**（Task 停留在 pending_dispatch）→ 任务事实分叉；
- `update_task()`（任务 API 直接改 Task.status）**不推进其派工**
  （Assignment 停留在 dispatched/received）→ 反向分叉；
- `set_assignment_status()` 已同步 Task（received/executing/paused/completed/
  cancelled），但同步逻辑内联不可复用。

离线场景下（边缘重启 hydrate 后继续执行）同一任务存在两套互相矛盾的
状态事实，违反 §3 单一事实源。

## 决策

### 决策 1：Task 是任务事实的唯一权威；Assignment 是派工事实的唯一权威

两者状态机同源（models.py TASK_TRANSITIONS，与 contracts/state-machines/
task.yaml 一致）；任何一方推进时，另一方经**同一状态机校验**同步推进
（pending_dispatch→dispatched→received→executing→paused/completed/cancelled）。

### 决策 2：execute() 同步推进 Task（pending_dispatch → dispatched）

每个正式派工落账后，对应 Task 若存在且非 dispatched：沿状态机最短路径
校验（pending_dispatch→dispatched 合法）并以乐观锁（version）更新；
任务不存在（legacy 方案引用）→ 显式 warning 跳过（Assignment 仍为派工
事实权威，不假装任务已更新）；VersionConflict → 显式 warning 跳过
（下一状态推进自然收敛；不阻断派工主流程——与 set_assignment_status
现有边界一致）。

### 决策 3：update_task() 同步推进其派工（同状态机校验）

任务 API 推进 Task.status 时，该任务的所有 Assignment 沿同一状态机
（shortest_task_path + validate_task_transition）同步推进；Assignment
已处于终态/无法跟随 → 显式 warning 跳过（不强制拉回）；同步不回调
update_task（防递归）——抽取共享内部转换器 `_apply_assignment_transition`
供 set_assignment_status / update_task 复用（消除内联重复，§31）。

### 决策 4：同步失败 = 显式留痕，绝不静默

所有同步异常（任务缺失/版本冲突/状态机拒绝）以 logger.warning + 原因
显式记录；派工/任务主事实各自落账不被同步旁路阻断（同步是收敛动作，
非事实写入前提——与 R-3 修复目标一致：在线路径即时收敛，冲突路径显式
可查）。

## 后果

- 正：任务↔派工状态机单一事实（双向收敛），离线 hydrate 后继续执行
  不再分叉；共享转换器消除重复；R-3 收口。
- 负/边界：并发双写窗口内的冲突靠乐观锁 + 显式留痕承载（无分布式事务）；
  任务缺失的 legacy 方案派工不同步任务（显式 warning）。
