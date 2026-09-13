# 2026-09 主产品交付与权威边界

更新：2026-09-10。本文按当前工作树代码走读建立能力映射，承接 [九层目标架构](embodied_factory.md)。它不发布本轮测试结果，也不声明现场或生产验收完成。

> 运行方式与场景判读见 [主产品闭环场景](../operations/main-product-closed-loop.md)：
> 迁移链 → 运营账号（含账号↔人员绑定）→ `make e2e-closed-loop`（Golden Path +
> 执行回执闭环）→ 现场作业台 `/field-operations`。

## 1. 当前基线与事实来源

主产品是 `ewoh-spark-app/` 的 React 19 + NestJS 10 + Drizzle/PostgreSQL 应用；Python Edge 负责现场接入、本地推理与离线缓存。connected production 的调度写权限唯一归 NestJS。这里的 authority 是代码与业务写权限归属，不能理解为“已经生产启用”。

| 要确认的事实 | 应查来源 | 使用边界 |
| --- | --- | --- |
| 当前用户入口、服务行为 | `ewoh-spark-app/client/src/app.tsx`、`ewoh-spark-app/server/standalone-main.ts`、各业务模块 | 以本轮工作树为准；代码存在不等于端到端通过 |
| 功能交付状态 | `feature-status.yaml` | 所有条目 `productionEnabled=false`；`tested` 是清单记录的证据，不代表本轮全测通过 |
| 数据库结构与运行身份 | `db/migrations/standalone_*.sql`、`db/runner/run_migrations.js`、`ewoh-spark-app/server/database/request-database-context.ts` | 迁移身份与业务运行身份分离，业务请求需事务级租户上下文与 RLS；实际角色、完整迁移链由主代理验收 |
| API、事件与状态机 | `openapi/ewoh.yaml`、`contracts/events/event-catalog.yaml`、`contracts/state-machines/*.yaml` | 校对实现时使用；不能仅凭契约声明判断现场接线完成 |
| 本轮交付意图与协调 | `.codex/artifacts/current-delivery-state.json`、本轮主代理指令 | 记录工作范围与待验事项，不替代运行证据；旧 `.codex/artifacts/understanding.md` 和历史轮次报告不作为当前验收结果 |
| 历史设计 | `ui/command_map/`、旧版本架构快照 | 仅参考；归档地图不承载生产逻辑，旧模块数、表数、测试数不沿用 |

`feature-status.yaml` 中 `schedulerRls`、`edgeServer`、`runtimeGates` 已记录 `runtimeVerified=true`，其他所列业务能力仍为 `false`。这是清单现状，不重新背书旧证据。`commandMap.evidence` 仍包含 `ui/command_map/`，该路径只能解释为历史参考；有效实现是 React `pages/CommandMap/`。本轮未修改清单。

本轮主代理已报告本地 PostgreSQL 启动，并在修复 bootstrap 角色占位符和完整迁移/compose 依赖链。本文不据此更新部署或运行验收结论；最终数据库、浏览器与测试证据由主代理发布。硬件运行仍为模拟。

## 2. 用户核心路径与能力映射

产品主路径：**感知 → 影响分析 → 候选方案 → 审批 → 派工 → 执行 → 反馈 → 学习**。下表区分已有模块与尚需接通的用户闭环。路径简写：`C/` = `ewoh-spark-app/client/src/`；`S/` = `ewoh-spark-app/server/modules/`。

| 阶段 / 用户操作 | 当前代码与接口 | 产物与限制 |
| --- | --- | --- |
| 感知：从 `/factory-operations` 查看异常，进入 `/alerts`、`/command-map` 或 `/digital-world` | `C/pages/FactoryOperations/FactoryOperations.tsx`；`S/ingest/ingest.service.ts`、`sensor-ingest.service.ts`；`POST /api/ingest/*` | 总览聚合概况、事件、活动方案；遥测、相机、定位/MES 有接入代码。相机与定位写入世界状态不等于现场多传感器融合已经验收 |
| 影响：识别故障、低电量、人员不可用和下游任务 | `S/scheduler/impact-analyzer.ts`、`replan-coordinator.service.ts`、`resource-projection.service.ts`；`POST /api/scheduler/events`、`POST /api/scheduler/replan/preview` | 输出受影响/冻结任务、冲突和建议动作；自动触发重排不授予派工权限 |
| 候选：在 `/scheduling` 或地图决策驾驶舱比较方案 | `C/pages/Scheduling/Scheduling.tsx`、`C/pages/CommandMap/panels/DecisionCockpit.tsx`；`S/scheduler/scheduler-run-orchestrator.service.ts`、`eligibility.service.ts`、`solver.service.ts`；`POST /api/scheduler/runs`、`GET /api/scheduler/tasks/:id/candidates` | 版本化快照、资格/硬约束、路线、评分和 A/B/C 变体；显式 profile 可缩小变体范围，不承诺每次都恰有三个可行方案 |
| 审批：确认方案，处置审批步骤 | `C/pages/ApprovalConsole/ApprovalConsole.tsx`；`S/scheduler/plan.service.ts`、`S/approval/`；`POST /api/scheduler/plans/:planId/approve` | 方案审批校验版本、快照与权限；审批台还聚合 Agent/分步审批，这些记录不能互相替代。过期或不可行方案不能因 UI 确认而获得派工权 |
| 派工：批准后显式下发业务任务 | `S/scheduler/dispatch-coordinator.service.ts`、`resource-reservation.service.ts`、`scheduler-plan-application.service.ts`；`POST /api/scheduler/plans/:planId/dispatch` | 状态校验、资源预约、assignment、反馈基线与执行记录；执行建档可能返回 `executionSync.ok=false`，必须处理降级，不能只看到派工成功就结束 |
| 执行：查看任务和执行偏差，接收执行方回执 | `S/scheduler/execution.service.ts`；`GET /api/scheduler/executions`、`POST /api/scheduler/executions/:assignmentId/update`；`C/pages/CommandMap/vm/executionFeedbackVM.ts` | 执行记录保存计划/实际时间和偏差，地图读取这些记录。`C/pages/MobileWorkbench/` 是 MES 工序工作台，不能默认视为 scheduler assignment 回执已接通 |
| 反馈：回填计划与实际差异，推进 assignment/task | `S/scheduler/scheduling-feedback.service.ts`、`scheduler-event-application.service.ts`；`POST /api/scheduler/feedback/actuals` | 回填 `ewoh_scheduling_feedback`，返回 `matched`、推进数量和 `skips`；缺基线不凭空补造。此接口与 execution update 分离，当前不能承诺提交一次回执同步完成两套记录 |
| 学习：评估结果、提出受控变更、训练时长统计模型、结果标注 | `S/learning/learning.service.ts`、`learning-proposal.service.ts`、`outcome-annotation.service.ts`；`S/scheduler/prediction/duration-model-training.service.ts`；`POST /api/scheduler/predictions/task-duration/retrain` | 已有评估台账、阈值提案影子评估/人审/回滚、租户与任务类型分组时长模型、结果标注面（`POST /api/learning/annotations`，判定人取服务端会话——请求体不可伪造，2026-09-11 修复）；`/learning-console` 已接通全部用户流程（标注/评估/提案/重训）。准确率缺标注时为 `null`，不是已实现通用自学习 |

`/simulation` 对应 `C/pages/Simulation/SimulationConsole.tsx` 与 `S/simulation/simulation.service.ts`，提供 what-if/capacity/layout/material-flow 的确定性评估。`/decision-history` 对应 `C/pages/DecisionHistory/DecisionHistoryConsole.tsx`，汇总方案、Agent 审批、学习提案和策略记录。两者支持比较和追溯，不证明物理执行或业务收益。

## 3. World / Event / Command 的权威归属

| 对象 | 事实与代码落点 | 谁可改变它 |
| --- | --- | --- |
| Observation：观测 | Edge `edge/manager.py`、`inference/pipeline.py`、`edge/bridge/edge_to_spark.py` → `S/ingest/`；遥测/事件保留来源与质量 | 经鉴权与租户上下文的接入链；传感器报告不等于调度授权 |
| World：当前展示投影 | `S/world/world.service.ts` 聚合空间实体、最新 `ewoh_world_state` 和事件；`S/timeline/` 提供回放 | 由接入与领域服务写入基础事实；React 读取投影，不能维护第二套权威状态 |
| World：决策快照 | `S/scheduler/world-state.service.ts`、`resource-projection.service.ts` → `ewoh_world_state_snapshot` | NestJS 基于任务、资源、约束和事件创建版本化快照；与地图当前投影职责不同，审批引用具体快照 |
| Event：领域事实与通知 | `contracts/events/event-catalog.yaml`；`S/ingest/ingest.service.ts`、`S/scheduler/outbox.service.ts`、`scheduler-stream.service.ts` | 领域服务发布与持久化；SSE 通知使前端刷新，不等于消费方已经执行业务命令，也不保证所有事件都有完整物理因果链 |
| Command：调度、审批、派工 | `S/scheduler/scheduler.controller.ts` → 应用服务 → `plan.service.ts` / `dispatch-coordinator.service.ts`；`S/approval/`、`S/agent/` 处理各自审批命令 | 有权限的操作者或受政策约束的服务；后端权限、状态与快照校验为准。Edge advisory 和 LLM 文本不能直接成为派工 authority |
| Execution / Outcome：回执 | `ewoh_scheduling_execution` 与 `ewoh_scheduling_feedback`；`S/scheduler/execution.service.ts`、`scheduling-feedback.service.ts` | 执行方经各自接口回填；当前缺统一回执应用路径，需核对两侧记录及 assignment/task 状态 |
| Learning：评估与变更 | `S/learning/`、`S/reasoning/`、`S/scheduler/prediction/`、`policy-activation.service.ts` | 评估本身不修改规则；阈值提案与策略激活有各自审批/门禁；时长模型重训会落为 active 并刷新预测 provider，不能称其仅写一条学习日志 |

原始观测、世界投影、决策快照、命令与回执应通过 entity/task/run/plan/assignment ID 关联。已有这些 ID 和事件契约不代表整个系统已经成为可从任意事件完整重建的事件溯源系统。

## 4. 真实、模拟与学习限制

- **真实接入**：`source_type=real` 是来源声明；仍需具体设备、固件、时间同步、质量、身份与回执证据。本轮没有物理设备控制或现场结果验证。急停、限扭、关节控制和失联安全态始终在设备本地。
- **模拟与影子分别识别**：模拟数据来源、`SimulationRun.isSimulation=true`、候选方案状态 `shadow`、求解器/预测 `isShadow` 是不同维度。`S/simulation/` 的独立仿真写路径不能推导所有 ingest、World、反馈和学习路径都已强制隔离。不要把模拟观测送入真实业务租户以补足演示数据。
- **Edge 闭环**：[本地闭环运行说明](../operations/local-closed-loop.md)、`tools/run_closed_loop_demo.py` 与 `src/edge_platform/scenario/closed_loop.py` 提供模拟集成材料；软件立即回执不等于工人搬运耗时。Edge `/api/scheduling` 与 NestJS `/api/scheduler` 不是同一个契约，不能把 Edge 结果提升为主产品验收证据。
- **求解与仿真**：启发式求解器是默认 canonical；MILP 需显式策略选择；CP-SAT 是清单所述 OPTIONAL/EXPERIMENTAL，激活阶梯受显式配置约束。算法求解、可行性检查和仿真比较均不是设备动力学、功能安全或现场收益认证。
- **学习已有范围**：评估输出接受率、完成率、延误、风险结局等统计；`modelAccuracy=null` 明确表达缺 outcome 标注。学习提案支持阈值变更的人审与回滚；时长模型以至少 5 个有效时长样本训练中位数/p90，并按租户/任务类型登记版本，预测仍属于 advisory/shadow 使用边界。
- **学习闭环用户面（2026-09-11 复核）**：`/learning-console` 已覆盖"结果标注 → 评估 → 提案 → 影子 → 人审 → 回滚 → 重训"全流程（此前文档记录的"反馈提交/标注无 UI"缺口已闭合）。剩余无 UI 的只有只读面：单提案详情 `GET /api/learning/proposals/:id`、按目标查标注 `GET /api/learning/annotations?targetType&targetId`、调度反馈 KPI 行级读面。
- **运行注意（2026-09-11 修复后）**：注意力列表把系统审计事件（学习/仿真台账）与现场异常分组展示（不混同）；执行回执与现场作业台展示任务标题/人员姓名（服务端批量回填，解析不到如实显示"未知"）；迁移链已可整链重跑（standalone_002 函数守卫 + standalone_009 验证接受最终形态）。

## 5. 本轮验收交接

本文完成代码/文档对应关系的静态审查；具体缺口与复验条件记录于 `.codex/artifacts/architecture-final-review.md`。主代理负责补充：完整迁移与受限运行角色、真实 PostgreSQL 下 API 的组织隔离/审批/派工/回执一致性、React 用户路径、模拟来源隔离及所执行测试的实际结果。结果缺失或失败时应如实保留，不能借用历史“全绿”记录。
