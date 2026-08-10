# EWOH 当前事实基线（Six-Dimension Fact Matrix）

> 生成时间：2026-08-10 · 基线：`main` @ `9283b8b`（2026-08-10 15:15:27 +0800）
> 环境：macOS（darwin-arm64），Node v26.5.1，Python 3.9.6；无 Docker / psql / Helm / kubectl / kind / k3d
> 原则：以源码 + 测试 + CI 为事实源，不依赖文档“已完成”标记；本文件为六维事实矩阵，
> 供 `deepen-scale-cockpit-closure` 阶段所有任务引用。

## 1. 事实源声明

- `delivery/`：冻结交付资产，不作为业务事实源（只读参考）。
- `ui/command_map/`：历史 UX 参考，`ui/command_map/README.md` 已标注 ARCHIVED / non-production。
- `output/release/`：生成物/发布快照，不反向成为业务事实源（benchmark 结果除外，作为性能证据记录）。

## 2. 六维事实矩阵

维度口径：CODE（代码已实现）/ TESTED（有自动化测试证据）/ DEPLOYABLE（有部署制品且可部署）/
PRODUCTION ENABLED（已生产启用）/ RUNTIME VERIFIED（真实运行验证过）/ DOCUMENTED（文档与代码一致）。

| 能力 | CODE | TESTED | DEPLOYABLE | PRODUCTION ENABLED | RUNTIME VERIFIED | DOCUMENTED | 证据 |
|---|---|---|---|---|---|---|---|
| Scheduler V2 调度闭环 | ✅ | ✅ | ✅ | ❌ | ⚠️（单元级；无真实工厂） | ✅ | server/modules/scheduler/（约 31k LOC，90+ spec）；README |
| HeuristicSchedulingSolver | ✅ | ✅ | ✅ | ✅（云侧生产调度权威） | ⚠️ 500 tasks=32.5s / 1000 OOM（2026-08-10 复现） | ✅ | heuristic-scheduling-solver.ts 1155 LOC |
| CP-SAT worker + adapter + fallback | ✅ | ✅（契约/fallback；真求解未验证） | ⚠️（Dockerfile.cpsat 存在但无 compose/k8s 清单、CI 不构建、ortools 版本漂移） | ❌（README：OPTIONAL/EXPERIMENTAL） | ❌（本机无 ortools；solver.py 自述 TODO） | ⚠️（CHANGELOG 声称 compose cpsat 无实物） | src/edge_platform/scheduler/cpsat/*、cp-sat-scheduling-solver.ts、Dockerfile.cpsat |
| Scheduler V2 RLS（8 张 org-scoped 表） | ✅ | ✅ | ✅ | ❌（多租户试点未启用） | ✅（CI standalone.yml PG17） | ⚠️（OPEN-DECISIONS 仍 OPEN；无正式 ADR） | standalone_025_scheduler_rls.sql、rls-policy.spec.ts |
| outbox / world_state_snapshot / assignment_event | ✅ | ✅ | ✅ | ❌ | ✅（CI 审计） | ⚠️（仅 migration 注释，无 ADR） | standalone_025 注释 |
| Prediction Shadow Learning | ✅（内存态） | ✅ | ⚠️（无持久化） | ❌（advisory-only） | ❌（重启即丢） | ✅（README L288 声明仅观测） | prediction/shadow-evaluator.service.ts（MAX_SAMPLES_PER_ORG=1000） |
| CommandMap 前端 | ✅ | ✅ | ✅ | ✅ | ⚠️（浏览器测试；无真实设备） | ✅ | client/src/pages/CommandMap/ |
| scheduler.service.ts 单体 | ✅（2288 LOC/53 方法） | ✅ | ✅ | ✅ | ✅ | ✅ | 需 Strangler Refactor（本阶段 Task 2） |
| Edge server（server.py） | ✅ | ✅ | ✅（零依赖部署） | ✅（edge 现场） | ⚠️ | ✅ | server.py 1692 LOC 单 Handler；39+39 pytest |
| Feishu sidecar | ✅（async execFile+timeout+breaker） | ✅ | ✅（单实例 SQLite） | ⚠️ | ⚠️ | ⚠️（OPEN-DECISIONS 滞后） | ewoh-feishu-app/server/feishu.js |
| Runtime Gates（Helm/canary/soak） | ⚠️（脚本已就绪） | ⚠️（静态审计） | ✅ | ❌ | ❌ BLOCKED（无集群） | ✅（docs/runtime-gates.md 如实 BLOCKED） | verify-helm-runtime.sh、canary-deploy.sh、soak-load.js |
| Repository Truth Gate（feature-status.yaml） | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 不存在（scripts/truth-gate.js 仅校验 evidence-manifest） |

## 3. Scheduler 性能基线（2026-08-10 复现，before）

命令（ewoh-spark-app 内）：
`TS_NODE_COMPILER_OPTIONS='{"module":"CommonJS","moduleResolution":"node"}' node -r ts-node/register -r tsconfig-paths/register scripts/benchmark-scheduler.ts --tasks N --persons P --devices D --runs 1 --seed 20260810`

| tasks | persons | devices | wallMs | feasible rate | candidateGenMs | solverStatus | 备注 |
|---|---|---|---|---|---|---|---|
| 10 | 3 | 2 | **4.82** | 1.0 | 0.01 | heuristic-v2 | — |
| 100 | 30 | 15 | **200.57** | 1.0 | 0.21 | heuristic-v2 | — |
| 500 | 150 | 75 | **32,473.90（32.5s）** | 1.0 | 5.56 | heuristic-v2 | 目标 <5s，超 6.5x |
| 1000 | 250 | 125 | **OOM（heap 溢出）** | — | — | — | 2GB heap 上限下复现 OOM |

参考：QA 报告 `docs/scheduler-commandmap-upgrade/07-qa-report-2026-08-10.md` 记录 500=46,032ms、
1000=OOM（当前实现）/ 8 分钟（b24cabc 基线 worktree）。

## 4. 关键结构性事实

1. **候选生成热点**：HeuristicSchedulingSolver 在 solve() 内联枚举 task×person×device×station 全笛卡尔积，
   `candidateGenMs`（routeCostProvider.estimate 累积）仅占 500 tasks 总耗时 ~0.02%，其余为内联候选构造/
   评分/工位判定/解释 trace 全量对象分配（O(T×P×D×S) 内存足迹是 1000 OOM 主因）。
2. **Benchmark 脚本漂移**：`scripts/benchmark-scheduler.ts` 此前因 `SchedulingPolicy.weights` 必填而无法编译
   （本次已修复 POLICY 常量）；未内置 10/100/500/1000 矩阵；未输出 peak heap / candidate count；未接入 CI
   （perf.yml 只跑 workbench 基准）。
3. **RLS 张力**：`ewoh_outbox` / `ewoh_world_state_snapshot` / `ewoh_assignment_event` 故意非 RLS（设计原因
   见 standalone_025 注释），但 schema-manifest.yaml 对这三张仍标 `org_id_policy: NOT NULL`；`ewoh_replan_trigger`
   不在 schema-manifest 中。OPEN-DECISIONS 的“9 表 RLS 白名单”仍标 OPEN。
4. **CP-SAT 漂移**：Dockerfile.cpsat 安装 `ortools>=9.8`，requirements.txt 锁定 `==9.11.4210`；CHANGELOG/
   worker.py 引用不存在的 `deploy/cloud/docker-compose.cpsat.yml`。
5. **OPEN-DECISIONS 滞后**：飞书 lark-cli 异步项（2026-08-08 仍 OPEN）与代码（2026-08-09 已 execFile 异步化）
   不一致。
6. **CommandMap 唯一状态源**：`CommandMap.tsx` 已实现“无效 selectedPlanId → null，绝不回退 plans[0]”，
   唯一残留为 `SchedulePanel.tsx` L437 打开对比面板时的 `plans[0]` 默认值。
7. **ShadowEvaluator**：内存环形缓冲，`backfillActual` 按 `(predictionType, createdAt)` 模糊匹配，重启即丢。

## 5. 门禁状态快照（docs/runtime-gates.md）

- ✅ CI 自动化：G1 migration 往返、G2 HTTP+PG E2E、G3 concurrency、G7 edge 断连/积压/重放。
- ⚠️ CI-only（本地不可复现）：G4 Docker health、G6 backup/restore、G10 生产迁移、G11 镜像安全。
- 🔴 BLOCKED：G5 Helm install/upgrade/rollback、G8 canary 回滚、G9 soak/load（本阶段 Task 8 尝试
  GitHub Actions ephemeral kind 闭环）。

## 6. 本阶段基线结论

- EWOH 处于“功能完整”阶段，未进入“规模可用 + 架构清晰 + 安全隔离 + 可解释决策 + 可长期运行”阶段。
- 500 tasks 32.5s / 1000 OOM 为**当前真实基线**（本文件为证据）；本阶段目标 500<5s / 1000<10s 且不 OOM。
- CP-SAT、shadow persistence、feature-status manifest、CommandMapStore/DecisionCockpit、
  scheduler.service 拆分、edge 8-domain 模块化均未实现，为本阶段任务范围。
