# 悬而未决登记册（OPEN DECISIONS）

> 规范：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution 字段）。
> 每次 Phase 开始时，把未决项自动复现到工作上下文最前面（带「N 未决 + M 已决」汇总），逐条判断能否关闭。
> 已关闭的项可升格为 ADR（架构决策记录）。

当前汇总：**1 未决 + 3 已决**

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-08-09 | Batch 10.1 | ~~任务写路径（TASK_CREATED/UPDATED）自动触发重排~~ | 已用桥接方案解决：TaskService 暴露 onTaskEvent 回调（task 模块零依赖）+ TaskSchedulingBridge（scheduler 模块）注册回调 → injectSchedulingEvent，无循环依赖 | 桥接已实施（task-scheduling.bridge.ts），createTask/transitionTaskState 成功后 fire-and-forget 触发重排 | — | 2026-08-09 已关闭 | **RESOLVED** |
| 2026-08-08 | Phase B/8 | ~~调度 V2 运行时表（11 张：outbox/world_state_snapshot/assignment_event/replan_trigger/scheduling_run 等；原记 9 张为不精确计数）不在 RLS 白名单，多租户隔离仅靠应用层 org 过滤~~ | ADR-004 三分类落地：8 张 TENANT_SCOPED 由 standalone_025 RLS 兜底（app.current_org_id GUC + 应用层过滤双保险）；3 张全局表保持非 RLS（outbox 全局 sequence / world_state_snapshot 全局版本键 / assignment_event 派生归属）；standalone_028 为 assignment_event 增加 org_id 派生触发器 + 数据库可验证不变量 + 真实 PG E2E 门禁 | ADR-004 + 028（列/索引/触发器/verify/rollback）+ verify-scheduler-multitenant.mjs（已接入 standalone.yml）+ schema-manifest 对齐（replan_trigger 补录、3 张全局表标记 GLOBAL_SHARED） | — | 2026-08-10 已关闭 | **RESOLVED** |
| 2026-08-08 | Phase B/9 | CP-SAT 求解器生产启用（worker 已就绪：HTTP 服务 + Dockerfile + compose optional profile） | 需服务器部署 OR-Tools 容器；启用前跑 solver-invariants 一致性测试；solverStatus 如实标记 | 部署 compose `--profile optional up -d cpsat`，影子评估一轮后激活 | 服务器环境 | 部署环境就绪后 | OPEN |
| 2026-08-08 | 走读 | ~~飞书侧车 lark-cli 同步调用（spawnSync）阻塞事件循环；异步化需全链路改造（所有调用方同步消费返回值）~~ | P1-2 已解决（2026-08-09）：larkCli 由 spawnSync 改为异步 execFile（20s 超时 + SIGTERM 回收，maxBuffer 16MB 语义不变），调用链全部 async 化；并发上限 MAX_CONCURRENT=4（手写信号量）+ 连续失败 ≥5 次熔断 30s | 异步化已实施（feishu.js P1-2）；多实例部署时随 PostgreSQL/Redis 迁移一并评估 | 部署规模决策 | 2026-08-10 已关闭 | **RESOLVED** |

## 已关闭记录

| Date | Open Item | Resolution | Closed By |
|------|-----------|------------|-----------|
| 2026-08-16 | MILP 求解器接入（ADR-053 决策 3：与 CP-SAT 生产启用同列环境阻塞） | R-79 再评估解除（ADR-058）：npm `highs`（HiGHS 1.15.2 WASM，MIT，无传递依赖）可用且本地冒烟验证真实求解（Optimal/Infeasible/同输入重放一致）→ milp-v1 落地（共享候选面 + 联合行精确整数规划 + 策略显式选择）；CP-SAT 生产启用仍为唯一 OPEN（部署环境） | ADR-058 + ewoh-spark-app/server/modules/scheduler/milp-scheduling-solver.ts + milp-scheduling-solver.spec.ts（9 例真实 HiGHS）
| 2026-08-09 | 任务写路径接线（10.1） | TaskService.onTaskEvent 回调注册表（task 模块零依赖）+ TaskSchedulingBridge（scheduler 模块）注册 → injectSchedulingEvent（TASK_CREATED/TASK_UPDATED），fire-and-forget 不阻塞任务写路径 | 桥接方案实施 + 3 测试
| 2026-08-10 | 调度 V2 运行时表多租户边界（RLS 白名单） | ADR-004 三分类（GLOBAL_SHARED / TENANT_SCOPED / DERIVED_TENANT_OWNERSHIP）：8 张 TENANT_SCOPED 由 standalone_025 RLS 兜底（scheduler_<table>_org_isolation，app.current_org_id GUC + 应用层过滤双保险）；3 张全局表保持非 RLS（ewoh_outbox 全局 sequence、ewoh_world_state_snapshot 全局 snapshotVersion 键、ewoh_assignment_event 派生归属）；standalone_028 为 ewoh_assignment_event 新增 org_id 列 + trg_assignment_event_derive_org 派生触发器（assignment → plan_assignment → plan）+ 数据库可验证不变量 + verify；真实 PG E2E 门禁 verify-scheduler-multitenant.mjs 已接入 standalone.yml；schema-manifest 补录 ewoh_replan_trigger 并将 3 张全局表标记 GLOBAL_SHARED | ADR-004 + standalone_028（apply/verify/rollback）+ scripts/verify-scheduler-multitenant.mjs + standalone.yml 步骤 + runtime-gates.md §3.3
| 2026-08-10 | 飞书侧车 lark-cli 同步调用异步化（走读项） | P1-2（2026-08-09）：larkCli 由 spawnSync 改为异步 execFile（20s 超时 + SIGTERM 回收，maxBuffer 16MB 语义不变），调用链全部 async 化；并发上限 MAX_CONCURRENT=4（手写信号量）+ 连续失败 ≥5 次熔断 30s，消除请求路径对事件循环的同步阻塞 | feishu.js（P1-2）+ 并发/熔断回归测试（node --test __test 钩子）
