# Tasks — 智能调度 Solver 落地与收敛

> 复用并收敛既有 NestJS Scheduling V2 控制面，不新增第四套调度模型。Python 仅作 CP-SAT 优化 Worker。
> 实施顺序遵循用户 P0→P1→P2：先收敛正确性/契约，再落地 CP-SAT solver，最后 UI/可观测。
> 对依赖（OR-Tools、worker 运行环境）暂不可用的部分：完成接口与架构落点 + 安全 fallback + 明确 TODO + 阻塞原因，不得用假数据冒充完成。

## Phase 0 — 收敛与正确性

- [ ] Task 0.1: 统一 authoritative scheduling contract
  - [ ] 0.1.1 在 `shared/api.interface.ts` 收敛 Task/Resource/Constraint/Plan/Assignment 契约与版本字段（policyVersion/snapshotVersion/solverVersion/version/freshness/dataQuality）
  - [ ] 0.1.2 确认 Nest V2 为控制面，Python 定位为优化 worker（写入 spec 决策，代码层面不建第四套权威域）
  - [ ] 0.1.3 测试：契约类型编译通过、既有 646 测试不退化

- [ ] Task 0.2: replan 使用 fresh snapshot
  - [ ] 0.2.1 检查/replan-coordinator 与 plan.service.replan：始终取最新 WorldStateSnapshot、冻结 executing/locked、绑定新 snapshotVersion
  - [ ] 0.2.2 移除默认复用旧 `_world_snapshot` 的分支
  - [ ] 0.2.3 测试：旧快照重排返回 PLAN_STALE / 新快照 + 新 snapshotVersion

- [ ] Task 0.3: 生产禁用静默 SAMPLE_DATA fallback
  - [ ] 0.3.1 定位 CommandMap 与后端 SAMPLE_DATA fallback 触发点，生产 backend 模式改 empty/unknown/stale + data-quality 提示
  - [ ] 0.3.2 保留 demo/offline 专属模式入口
  - [ ] 0.3.3 测试：生产空数据不落入 sample 判断

- [ ] Task 0.4: 强化 WorldState 版本/新鲜度
  - [ ] 0.4.1 world-state.service 覆盖 person/device/task/reservation/station/forbidden/safety/route 的版本与摘要；approval 前关键变化→PLAN_STALE
  - [ ] 0.4.2 ResourceState 增加 sourceTs/freshnessMs/dataQuality/version；过期关键数据不视为 AVAILABLE
  - [ ] 0.4.3 测试：person/device/task/route 变化使旧 plan stale；过期数据标 STALE

## Phase 1 — Solver 落地

- [ ] Task 1.1: 内部求解契约
  - [ ] 1.1.1 在 `shared/api.interface.ts`（或 worker 共享 schema）定义 SolverRequest/SolverResponse：
    `solverStatus(OPTIMAL|FEASIBLE|FALLBACK|INFEASIBLE|TIMEOUT)/solveDurationMs/objective/objectiveBreakdown/hardViolations/optimalityGap/assignmentReasons/rejectedAlternatives/solverVersion`
  - [ ] 1.1.2 定义 Python worker 的稳定 HTTP 契约与 NestJS 客户端（超时/健康检查/错误分类）

- [ ] Task 1.2: Python OR-Tools CP-SAT worker
  - [ ] 1.2.1 新增 `src/edge_platform/scheduler/cpsat/`（model.py/constraints.py/objective.py/solver.py/contract.py）
  - [ ] 1.2.2 实现决策变量（task→person/device/station/start/end）与硬约束（no-overlap/availability/skills/certs/capabilities/predecessor/time-window/reservation/forbidden/safety/executing+locked 不可移动）
  - [ ] 1.2.3 实现目标函数（lateness/travel/stationWait/workload imbalance/changeover/risk/energyRisk/schedule instability）
  - [ ] 1.2.4 输出 solverVersion/status/objective/breakdown/violations/optimalityGap/reasons/rejectedAlternatives
  - [ ] 1.2.5 测试：小规模 fixture 求解硬约束=0；不可行返回 INFEASIBLE；确定性重放
  - [ ] 1.2.6 若 OR-Tools 不可用：保留接口 + 明确 TODO + 阻塞原因（不装依赖不硬编码冒充）

- [ ] Task 1.3: NestJS CpSatSchedulingSolver + fallback
  - [ ] 1.3.1 新增 `cp-sat-scheduling-solver.ts` 实现 `SchedulingSolver`，调用 worker（超时/异常→fallback）
  - [ ] 1.3.2 solver.service 调度：优先 cp-sat，失败/超时→heuristic，plan 明确标 `solverVersion`/`solverStatus`（含 FALLBACK）
  - [ ] 1.3.3 测试：worker 可用走 cp-sat；worker 超时/异常回退 heuristic 且标签正确；不把 fallback 冒充 cp-sat

- [ ] Task 1.4: requiredDeviceCapabilities 生效 + 资源模型
  - [ ] 1.4.1 eligibility.service 校验任务 `requiredDeviceCapabilities`（非仅 exo model）
  - [ ] 1.4.2 resource-projection 补全 device location/capabilities/availabilityWindows/battery/fault/telemetryUpdatedAt/version；任务含 candidateStations/resourceQuantity
  - [ ] 1.4.3 测试：capability 不匹配设备不可执行；在线+电量够但 capability 不符→不可派

- [ ] Task 1.5: DecisionTrace + 可解释
  - [ ] 1.5.1 每个 Assignment 持久化 DecisionTrace（selected/priority/candidates/selectedReason/policyVersion/solverVersion/snapshotVersion）JSONB
  - [ ] 1.5.2 前端默认摘要，点击"为什么"加载详情
  - [ ] 1.5.3 测试：DecisionTrace 生成与读取

- [ ] Task 1.6: Top-K 多方案
  - [ ] 1.6.1 支持 policy preset + objective weight profile + solution diversity；多方案有真实差异与可解释差异
  - [ ] 1.6.2 权重来自版本化 SchedulingPolicy，不固 A/B/C magic
  - [ ] 1.6.3 测试：两方案权重不同产生差异；差异可解释

- [ ] Task 1.7: 收敛 legacy API
  - [ ] 1.7.1 标记 `/api/scheduler/plans`(POST/GET) 与 confirm deprecated + compatibility adapter 转 V2
  - [ ] 1.7.2 新功能不依赖旧路径
  - [ ] 1.7.3 测试：V2 唯一路径，legacy 不新增业务逻辑

## Phase 2 — 实时闭环与局部重排

- [ ] Task 2.1: SSE sequence/gap recovery + durable outbox
  - [ ] 2.1.1 SchedulingEvent 含 entityType/entityVersion；SSE 支持 sinceSequence；outbox 持久化事件
  - [ ] 2.1.2 前端 sequence 缺口→拉最新 snapshot→恢复；duplicate filtering/gap detection
  - [ ] 2.1.3 测试：SSE 重连重放 / 缺口恢复 / 重复去重

- [ ] Task 2.2: ImpactAnalyzer + 局部重排
  - [ ] 2.2.1 统一异常类型（RESOURCE_OFFLINE/RESERVATION_CONFLICT/PLAN_STALE/ROUTE_BLOCKED）含 severity/affectedTaskIds/recommendedAction/canAutoReplan
  - [ ] 2.2.2 ImpactAnalyzer：事件→受影响任务→冻结 executing/locked→只重排受影响子图；solver 加 churn/stability penalty
  - [ ] 2.2.3 测试：DEVICE_OFFLINE 只重排受影响任务，无关任务不 churn，executing/locked 不变

## Phase 3 — Benchmark / 可观测 / UI

- [x] Task 3.1: Benchmark
  - [x] 3.1.1 新增可重复 benchmark 脚本（task/person/device/candidate 数、候选生成/求解/总延迟、feasible rate）
  - [x] 3.1.2 对比 heuristic vs cp-sat（lateness/travel/workload balance/station wait/changeover/changed/hard violations）
  - [x] 3.1.3 输出结果到 `output/` 并记录

- [x] Task 3.2: 可观测指标
  - [x] 3.2.1 暴露 scheduler_run_total/duration、feasible_ratio、solver_timeout_total、fallback_total、plan_approved/rejected/stale_total、replan_total、reservation_conflict_total、manual_override_total
  - [x] 3.2.2 日志携带 runId/planId/snapshotVersion/policyVersion/solverVersion
  - [x] 3.2.3 测试：指标计数正确

- [x] Task 3.3: Command Map 调度增强
  - [x] 3.3.1 Resource Availability Layer（Available/Busy/Reserved/Unavailable/Stale）
  - [x] 3.3.2 Plan Route Layer 增强（current/confirmed/candidate + ETA/risk/congestion/priority/affected）
  - [x] 3.3.3 Conflict Layer（forbidden/blocked/faulty/unavailable/reservation conflict/unassigned high-priority）
  - [x] 3.3.4 Plan Diff（P-001 ST-101→ST-105 walking +42m lateness -6min）
  - [x] 3.3.5 Explain Panel（skill/cert/capability/availability matched + ETA/workload/battery + 未选候选排除原因）
  - [x] 3.3.6 Manual Override（Lock/Exclude/Change resource/Change time/Replan → 后端 Constraint/Override API，非只改浏览器 CM.DATA）
  - [x] 3.3.7 测试：candidate/current/confirmed 切换、stale 提示、conflict、explain、override

- [x] Task 3.4: 质量门禁
  - [x] 3.4.1 lint / typecheck / test / build 通过，原有测试不退化
  - [x] 3.4.2 排除调试残留文件；提交并推送 origin/main

# Task Dependencies
- Task 0.2 依赖 0.1（契约）；0.3/0.4 依赖 0.1
- Task 1.1 依赖 0.1；1.2 依赖 1.1；1.3 依赖 1.2；1.4 依赖 0.4；1.5 依赖 1.3；1.6 依赖 1.3；1.7 依赖 0.1
- Task 2.1 依赖 0.4；2.2 依赖 1.3、0.2
- Task 3.1 依赖 1.3；3.2 依赖 1.3；3.3 依赖 1.5、1.6、2.1、2.2；3.4 依赖全部
- Phase 0 各 Task 相对独立可并行；Phase 1 内 1.4/1.7 可并行于 1.2/1.3