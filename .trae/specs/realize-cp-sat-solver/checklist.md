# Checklist — 智能调度 Solver 落地与收敛

## 收敛与正确性 (Phase 0)
- [ ] Task/Resource/Constraint/Plan/Assignment 契约统一，版本字段（policyVersion/snapshotVersion/solverVersion/version/freshness/dataQuality）齐备
- [ ] Nest V2 为唯一控制面，Python 仅作优化 worker，未新增第四套调度模型
- [ ] replan 始终使用最新 WorldStateSnapshot，冻结 executing/locked，绑定新 snapshotVersion；不默认复用旧 snapshot
- [ ] 生产 backend 模式禁用静默 SAMPLE_DATA fallback；真实空数据→empty/unknown/stale + data-quality 提示
- [ ] WorldState 版本/新鲜度覆盖 person/device/task/reservation/station/forbidden/safety/route；关键变化→PLAN_STALE
- [ ] ResourceState 含 sourceTs/freshnessMs/dataQuality/version；过期关键数据不视为 AVAILABLE

## Solver 落地 (Phase 1)
- [ ] 内部求解契约定义（SolverRequest/SolverResponse，含 solverStatus/solveDurationMs/objective/objectiveBreakdown/hardViolations/optimalityGap/assignmentReasons/rejectedAlternatives/solverVersion）
- [ ] Python OR-Tools CP-SAT worker 实现决策变量、硬约束（no-overlap/availability/skills/certs/capabilities/predecessor/time-window/reservation/forbidden/safety/executing+locked 不可移动）与目标函数
- [ ] CP-SAT 不可用/超时/异常时，NestJS 回退 HeuristicSchedulingSolver，plan 明确标注 solverVersion/solverStatus（含 FALLBACK），不冒充 CP-SAT 成功
- [ ] requiredDeviceCapabilities 真正参与筛选（非仅 exo model）
- [ ] DecisionTrace 持久化（JSONB），前端摘要 + 按需"为什么"详情
- [ ] Top-K 多方案支持 policy preset + weight profile + diversity，权重来自版本化 Policy，差异可解释
- [ ] legacy `/api/scheduler/plans` 与 confirm 标 deprecated + compatibility adapter 转 V2，新功能不依赖旧路径

## 实时闭环与局部重排 (Phase 2)
- [ ] SST Event 含 entityType/entityVersion；SSE 支持 sinceSequence；durable outbox
- [ ] 前端 sequence 缺口→拉最新 snapshot→恢复；duplicate filtering/gap detection
- [ ] ImpactAnalyzer 冻结 executing/locked，只重排受影响子图，solver 有 churn/stability penalty
- [ ] DEVICE_OFFLINE 只重排受影响任务，无关任务不 churn，executing/locked 不变

## Benchmark / 可观测 / UI (Phase 3)
- [x] benchmark 脚本记录 task/person/device/candidate 数、候选生成/求解/总延迟、feasible rate；对比 heuristic vs cp-sat
- [x] 可观测指标（scheduler_run_total/duration、feasible_ratio、solver_timeout_total、fallback_total、plan_approved/rejected/stale_total、replan_total、reservation_conflict_total、manual_override_total）；日志含 runId/planId/snapshotVersion/policyVersion/solverVersion
- [x] Command Map 调度增强：Availability / Plan Route(current/confirmed/candidate+ETA/risk) / Conflict / Plan Diff / Explain / Manual Override（走后端 API）
- [x] UI 测试：candidate/current/confirmed 切换、stale 提示、conflict、explain、override

## 质量
- [x] lint / typecheck / test / build 全部通过，原有测试（646+）不退化
- [x] 排除调试残留文件；提交并推送 origin/main
- [x] 对 OR-Tools/worker 依赖暂不可用例：接口+架构落点+安全 fallback+明确 TODO+阻塞原因，无假数据冒充完成