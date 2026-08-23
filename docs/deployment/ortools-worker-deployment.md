# ortools Worker 部署方案

**文档版本**: 1.0
**创建日期**: 2026-08-24
**状态**: Draft

## 1. 概述

EWOH 调度系统支持 4 类求解器（§8）：
- **heuristic** — 启发式算法（canonical，8 权重软目标优化）
- **rule-based** — 确定性规则（ADR-053，L1 地板）
- **MILP** — HiGHS WASM 精确联合整数规划（ADR-058）
- **CP-SAT** — OR-Tools CP-SAT 约束求解器（需 ortools worker）

CP-SAT 代码已完备（`cp-sat-scheduling-solver.ts`），但需要 ortools worker 服务才能启用生产路径。

## 2. 部署形态

### 2.1 推荐方案：Docker 容器 + HTTP REST

```
┌─────────────────────┐     HTTP/JSON     ┌─────────────────────┐
│  ewoh-spark-app     │ ───────────────→  │  ortools-worker     │
│  (NestJS)           │                    │  (Python + ortools) │
│                     │ ←───────────────  │                     │
│  cp-sat-solver.ts   │   SolverResponse   │  cpsat/solver.py    │
└─────────────────────┘                    └─────────────────────┘
```

**理由**：
- 现有代码已使用 HTTP（`CPSAT_WORKER_URL` 环境变量，默认 `http://127.0.0.1:8000`）
- Python ortools 官方包原生支持，无需 gRPC 额外复杂度
- Docker 容器化便于 K8s 部署和弹性伸缩

### 2.2 备选方案：Kubernetes Deployment

适用于生产环境高可用需求：
- Deployment + HPA（基于 CPU 使用率自动伸缩）
- Service（ClusterIP 或 LoadBalancer）
- ConfigMap（求解参数配置）
- ResourceQuota（资源限制）

## 3. 资源规格

### 3.1 最小配置（开发/测试）

| 资源 | 规格 |
|------|------|
| CPU | 2 cores |
| 内存 | 2 GB |
| 磁盘 | 1 GB |
| 网络 | 100 Mbps |

### 3.2 推荐配置（生产）

| 资源 | 规格 |
|------|------|
| CPU | 4-8 cores |
| 内存 | 4-8 GB |
| 磁盘 | 5 GB |
| 网络 | 1 Gbps |

**说明**：CP-SAT 求解器是 CPU 密集型，内存需求取决于问题规模（变量数 × 约束数）。典型调度问题（100 任务 × 50 资源）约需 2-4 GB。

## 4. 通信协议

### 4.1 API 契约

**请求**（POST /solve）：
```json
{
  "request_id": "uuid",
  "tasks": [...],
  "resources": [...],
  "constraints": [...],
  "objective": {...},
  "timeout_ms": 8000
}
```

**响应**：
```json
{
  "request_id": "uuid",
  "status": "OPTIMAL|FEASIBLE|INFEASIBLE|TIMEOUT",
  "assignments": [...],
  "score": 0.85,
  "solver_time_ms": 1234,
  "solver_version": "cpsat-v1"
}
```

### 4.2 错误处理

| HTTP 状态码 | 含义 | 处理 |
|-------------|------|------|
| 200 | 成功 | 解析响应 |
| 400 | 请求畸形 | 记录日志，回退 heuristic |
| 408 | 超时 | 记录日志，回退 heuristic |
| 500 | 内部错误 | 记录日志，回退 heuristic |
| 503 | 服务不可用 | 熔断器打开，回退 heuristic |

### 4.3 超时机制

- 默认超时：8000ms（`CPSAT_TIMEOUT_MS` 环境变量）
- 请求级超时：可通过 `timeout_ms` 参数覆盖
- 超时后：回退到 heuristic 求解器

## 5. 灰度切换方案

### 阶段 1：影子模式（Shadow）

```bash
EWOH_SOLVER_ACTIVATION=SHADOW
CPSAT_WORKER_URL=http://ortools-worker:8000
```

**行为**：
- 同时运行 heuristic（生产）和 CP-SAT（影子）
- 对比两者结果（分配数、成本、约束满足率）
- 仅使用 heuristic 结果，CP-SAT 结果仅记录

**验证指标**：
- CP-SAT 求解成功率 ≥95%
- CP-SAT 求解时间 ≤10s（P95）
- CP-SAT 分配数 ≥ heuristic 分配数

**回滚条件**：
- 求解成功率 <90%
- 求解时间 >30s（P95）
- 连续 3 次求解失败

### 阶段 2：金丝雀模式（Canary）

```bash
EWOH_SOLVER_ACTIVATION=CANARY
CPSAT_WORKER_URL=http://ortools-worker:8000
```

**行为**：
- 10% 请求走 CP-SAT，90% 走 heuristic
- 监控 CP-SAT 求解质量和延迟
- 自动回退：熔断器打开时 100% 回退 heuristic

**验证指标**：
- CP-SAT 分配成本 ≤ heuristic 成本 × 1.1
- 用户无投诉
- 系统延迟无显著增加

**回滚条件**：
- 熔断器连续打开 3 次
- 用户投诉调度质量下降
- 系统延迟增加 >20%

### 阶段 3：全量模式（Production）

```bash
EWOH_SOLVER_ACTIVATION=PRODUCTION
EWOH_SOLVER_PRODUCTION_ENABLED=1
CPSAT_WORKER_URL=http://ortools-worker:8000
```

**行为**：
- 100% 请求走 CP-SAT
- 熔断器打开时回退 heuristic

**验证指标**：
- 求解成功率 ≥99%
- 求解时间 ≤5s（P95）
- 调度质量指标稳定

## 6. 降级策略

### 6.1 自动降级（熔断器）

`CpSatCircuitBreaker` 已实现（`cp-sat-circuit-breaker.ts`）：
- 连续 5 次失败 → 熔断器打开
- 冷却期 60s → 熔断器半开（允许 1 次试探）
- 试探成功 → 熔断器关闭
- 试探失败 → 熔断器重新打开

### 6.2 手动降级

```bash
# 紧急降级：回退到 heuristic
EWOH_SOLVER_ACTIVATION=OFF

# 或设置环境变量后重启服务
```

## 7. 监控与告警

### 7.1 关键指标

| 指标 | 说明 | 告警阈值 |
|------|------|----------|
| `cpsat_solve_duration_ms` | 求解时间 | P95 >10s |
| `cpsat_solve_success_rate` | 求解成功率 | <95% |
| `cpsat_circuit_breaker_state` | 熔断器状态 | OPEN 持续 >5min |
| `cpsat_worker_cpu_usage` | Worker CPU 使用率 | >80% |
| `cpsat_worker_memory_usage` | Worker 内存使用率 | >80% |
| `cpsat_fallback_count` | 回退次数 | >10/min |

### 7.2 告警规则

```yaml
alerts:
  - name: CP-SAT Worker Down
    condition: cpsat_worker_health == 0
    severity: critical
    action: 熔断器自动打开，回退 heuristic

  - name: CP-SAT Solve Timeout
    condition: cpsat_solve_duration_ms > 30000
    severity: warning
    action: 记录日志，检查问题规模

  - name: CP-SAT Circuit Breaker Open
    condition: cpsat_circuit_breaker_state == OPEN
    severity: warning
    action: 检查 Worker 健康状态
```

## 8. 部署检查清单

### 8.1 部署前

- [ ] ortools Python 包安装验证（`pip install ortools`）
- [ ] Worker 健康检查端点实现（`GET /health`）
- [ ] 求解接口实现（`POST /solve`）
- [ ] Docker 镜像构建并推送到镜像仓库
- [ ] K8s Deployment/Service YAML 准备
- [ ] 环境变量配置（`CPSAT_WORKER_URL`、`CPSAT_TIMEOUT_MS`）
- [ ] 监控指标暴露（Prometheus 格式）
- [ ] 日志格式统一（JSON 格式，包含 request_id）

### 8.2 部署后

- [ ] Worker 健康检查通过
- [ ] 求解接口连通性验证
- [ ] 影子模式运行 24h，对比结果
- [ ] 金丝雀模式运行 7d，监控指标
- [ ] 全量切换前人工评审
- [ ] 回滚方案验证（手动降级测试）

### 8.3 生产运行

- [ ] 监控告警配置
- [ ] 日志收集配置
- [ ] 备份策略（求解结果持久化）
- [ ] 扩容策略（HPA 配置）
- [ ] 安全审计（网络策略、RBAC）

## 9. 文件清单

| 文件 | 说明 |
|------|------|
| `ewoh-spark-app/server/modules/scheduler/cp-sat-scheduling-solver.ts` | CP-SAT 求解器（NestJS 侧） |
| `ewoh-spark-app/server/modules/scheduler/cp-sat-circuit-breaker.ts` | 熔断器 |
| `ewoh-spark-app/server/modules/scheduler/solver.service.ts` | 求解器路由 |
| `src/edge_platform/scheduler/cpsat/solver.py` | CP-SAT 求解器（Python 侧） |
| `docs/deployment/ortools-worker-deployment.md` | 本文档 |
