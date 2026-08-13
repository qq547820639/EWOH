# Tasks — Scheduler Phase 2 CP-SAT objective 分层

> 原则：先核验现状 → 新增纯 Python 分层模块 → 改 solver.py 目标构造 → 响应 breakdown 增项 → 补测试 → 回归。行为语义精确、改动最小。

- [x] Task 1: 新增纯 Python 模块 `objective.py`
  - [x] 1.1 `OBJECTIVE_LEVELS` 分层常量（0=unassigned；1=lateness；2=wait；3=travel；4=churn；5-8 预留）。
  - [x] 1.2 `compute_unassigned_scale(request) -> int`：从请求实际边界（任务数/horizon/权重/候选成本矩阵）计算 `soft_upper_bound + 1`，并夹在安全区间不溢出 int64。
  - [x] 验证：纯函数无副作用；`test_objective_lexicographic.py` 5 用例通过。

- [x] Task 2: 改 `solver.py` 目标构造为字典序
  - [x] 2.1 未分配项改用 `compute_unassigned_scale(request) * missed`（替代魔法数 1000）。
  - [x] 2.2 软目标项保持扁平求和，与未分配项合并为单一 `model.Minimize(...)`。
  - [x] 验证：目标构造逻辑正确，硬约束不变；cpsat 套件 27 passed / 10 skipped（ortools 未装属预期）。

- [x] Task 3: 响应 `objectiveBreakdown` 增 `unassigned` 项（在 solver.py 响应构造处，`contract.py` 的 `objectiveBreakdown: Dict[str, float]` 为自由字典，无需类型改动）
  - [x] 3.1 `objectiveBreakdown` 增加 `unassigned`（真实未分配贡献 `unassigned_scale * len(unassigned)`），保留既有 lateness/stationWait/travel/churn 键。

- [x] Task 4: 新增 `tests/test_objective_lexicographic.py`（位于 `src/edge_platform/tests/`）
  - [x] 4.1 `compute_unassigned_scale` 严格支配（scale > soft_upper_bound）。
  - [x] 4.2 scale 为 int 且不溢出（安全区间夹紧）。
  - [x] 4.3 不同请求（含大候选成本矩阵）边界正确。
  - [x] 验证：新增测试 5 用例全绿（无需 ortools）。

- [x] Task 5: 回归 + 契约 + 提交
  - [x] 5.1 `PYTHONPATH=src python3 -m pytest tests/test_objective_lexicographic.py tests/test_cpsat_contract.py tests/test_ts_python_contract_parity.py` 通过（22 passed）。
  - [x] 5.2 cpsat 套件回归 27 passed / 10 skipped；`cd ewoh-spark-app && npm run openapi:no-drift` 通过。
  - [x] 5.3 新增文件 ruff 通过（`objective.py`/`test_objective_lexicographic.py`）；提交并推送 `main`。

# Task Dependencies

- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖 [Task 1]（可与 Task 2 并行）。
- [Task 4] 依赖 [Task 1]。
- [Task 5] 依赖全部。
