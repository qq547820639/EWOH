# 悬而未决登记册（OPEN DECISIONS）

> 规范：只追加 + 就地关闭（OPEN → RESOLVED，补 Resolution 字段）。
> 每次 Phase 开始时，把未决项自动复现到工作上下文最前面（带「N 未决 + M 已决」汇总），逐条判断能否关闭。
> 已关闭的项可升格为 ADR（架构决策记录）。

当前汇总：**4 未决 + 0 已决**

| Date | Source | Open Item | Related Constraints | Current Leaning | Blocked By | Resolves When | Status |
|------|--------|-----------|---------------------|-----------------|------------|---------------|--------|
| 2026-08-08 | Batch 10.1 | 任务写路径（TASK_CREATED/UPDATED）自动触发重排：TaskModule 是依赖叶子（SchedulerModule imports TaskModule），反向注入成环；HTTP 自调用需鉴权改造 | 任务创建频率低，MANUAL/调度运行可覆盖 | 待模块解耦（任务事件经 outbox 轻量通道）后接线 | 模块解耦重构 | 调度模块拆分时 | OPEN |
| 2026-08-08 | Phase B/8 | 调度 V2 运行时表（9 张：outbox/world_state_snapshot/assignment_event/replan_trigger/scheduling_run 等）不在 RLS 白名单，多租户隔离仅靠应用层 org 过滤 | 快照/SSE 事件为全局共享语义（snapshot_version 全局唯一、outbox 全局序列）；补 RLS 需重新设计 org 边界 | 保持应用层隔离（已加 listRuns org 过滤缓解）；补 RLS 待多租户试点需求明确 | 多租户试点需求 | 需求明确后走 ADR | OPEN |
| 2026-08-08 | Phase B/9 | CP-SAT 求解器生产启用（worker 已就绪：HTTP 服务 + Dockerfile + compose optional profile） | 需服务器部署 OR-Tools 容器；启用前跑 solver-invariants 一致性测试；solverStatus 如实标记 | 部署 compose `--profile optional up -d cpsat`，影子评估一轮后激活 | 服务器环境 | 部署环境就绪后 | OPEN |
| 2026-08-08 | 走读 | 飞书侧车 lark-cli 同步调用（spawnSync）阻塞事件循环；异步化需全链路改造（所有调用方同步消费返回值） | 现有 40 tests 大量依赖同步语义；FEA1 风险 > 价值 | 维持同步（已知限制已记录 README）；多实例时随 PostgreSQL/Redis 迁移一并评估 | 部署规模决策 | 多实例改造时 | OPEN |

## 已关闭记录

（暂无）
