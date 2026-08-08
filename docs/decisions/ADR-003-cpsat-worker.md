# ADR-003: CP-SAT 求解 Worker（独立 HTTP 服务，可选启用）

## Status: Accepted (2026-08-08)

## Background
Scheduler V2 的 canonical 求解器为 HeuristicSchedulingSolver；CP-SAT（OR-Tools）为
OPTIONAL/EXPERIMENTAL。云侧 `CpSatSchedulingSolver` 调 `http://127.0.0.1:8000/api/scheduler/v2/solve`
但 worker 服务不存在（404 → 回退 heuristic）。README 承诺"solverStatus 如实标记，绝不冒充"。

## Decision
- 新增 `src/edge_platform/scheduler/cpsat/worker.py`：纯标准库 HTTP worker
  （ThreadingHTTPServer，零第三方运行时依赖，符合边缘平台哲学）
  - POST /api/scheduler/v2/solve：SolverRequest JSON → SolverResponse JSON
  - GET /health/live + GET /api/scheduler/v2/solver/health（可用性探针）
  - ortools 缺失时 solve 返回 UNAVAILABLE（云侧安全回退 heuristic，不冒充）
- 部署：`deploy/cloud/Dockerfile.cpsat` + compose optional `cpsat` profile
  （`docker compose --profile optional up -d cpsat`）
- 启用流程：部署 worker → 影子评估一轮 → 激活（solverStatus 可达 OPTIMAL）

## Consequences
- 正面：CP-SAT 可独立部署/回滚；UNAVAILABLE 语义保持诚实；worker 与语言无关（HTTP 契约）
- 负面：OR-Tools 镜像约 200MB；求解耗时受限于 HTTP 往返（8s 超时）
- 兼容性：未部署时行为与现状完全一致（FALLBACK/UNAVAILABLE）

## Related ADRs
ADR-002（事件驱动重排复用求解器）
