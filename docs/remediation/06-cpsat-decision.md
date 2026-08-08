# CP-SAT Production Readiness Decision（Phase C）

## 决策

```
CP-SAT Production Ready? NO
```

## 当前事实（基于 HEAD ff4ee6f + 本轮验证）

| 项 | 值 |
| -- | -- |
| OR-Tools 是否安装 | 否（`import ortools` 失败） |
| `pyproject.toml` dependencies | `[]`（零第三方运行时依赖，CI 有护栏断言） |
| CP-SAT `is_available()` | `False` |
| 部署 worker 容器 | 无（Dockerfile/Helm 无 Python worker） |
| 当前实际 solver | HeuristicSchedulingSolver（`solverVersion=heuristic-v2`） |
| 状态标记 | heuristic 主路径 `solverStatus=HEURISTIC`；CP-SAT 不可达时 `FALLBACK/UNAVAILABLE` + `fallbackReason` 明确 |

## 决策

```
Production Canonical Solver = HeuristicSchedulingSolver
CP-SAT Status = OPTIONAL / EXPERIMENTAL
Reason:
  1. 项目硬约束为「纯 Python 标准库、零第三方运行时依赖」（pyproject + CI 护栏），
     OR-Tools 为重依赖（数百 MB），与当前部署边界冲突。
  2. 当前无 Python worker 部署拓扑（无 Dockerfile/Helm worker），引入 CP-SAT 需
     新增独立 worker 服务 + 健康检查 + 资源限制，超出受控试点范围。
  3. HeuristicSchedulingSolver 已实现全部 25 个约束（16 hard + 9 soft）的真实评估，
     hard constraint violation = 0（既有测试覆盖），满足当前调度正确性要求。
  4. 运筹优化收益（最优性）在当前试点规模（≤100 任务）下不构成生产风险；
     若未来规模化需要 CP-SAT，可按下方激活条件引入。

Requirements before activation:
  1. 明确部署边界决策：新增独立 Python CP-SAT worker 服务（Dockerfile + Helm worker
     + health/readiness + timeout + memory limit + graceful failure）。
  2. 安装并固定 OR-Tools 版本（如 9.x.x），CI 增加 worker smoke test。
  3. 补齐 CP-SAT 对 MIN_BATTERY / MAX_WORKLOAD / SAFETY_BLOCK / EXCLUDED /
     PREFERRED_RESOURCE / MANUAL_BOOST 的建模（当前仅透传，UNSUPPORTED 显式标记）。
  4. 补全 CP-SAT DecisionTrace 的真实 priority 数据（当前已使用真实 PriorityEngine，
     但 CP-SAT 路径仍需与 heuristic 相同的候选/淘汰明细）。
  5. 建立 solver parity 测试：同一 fixture 下 CP-SAT 与 heuristic hard violation 均 = 0。
```

## 状态标记语义（保证如实）

| solverStatus | 含义 | 何时出现 |
| ------------ | ---- | -------- |
| `HEURISTIC` | heuristic 作为当前 canonical solver 主路径 | 默认生产路径 |
| `FALLBACK` | CP-SAT worker 可达但返回非最优/不可用 | worker 异常响应 |
| `UNAVAILABLE` | CP-SAT worker 不可达/未部署 | 默认（无 worker） |
| `OPTIMAL/FEASIBLE` | CP-SAT 求解成功（激活后） | 未来激活 |
| `INFEASIBLE/TIMEOUT` | CP-SAT 不可行/超时 | 未来激活 |

**禁止**：heuristic 结果冒充 CP-SAT 成功。`fallbackReason` 必须如实。
