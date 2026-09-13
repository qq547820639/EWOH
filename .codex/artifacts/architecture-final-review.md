# Architecture final review — 2026-09-10

Trace: EWOH-2026-09-10-product-delivery
Role: Execution Agent（docs only）
Review basis: 当前工作树静态代码走读、`feature-status.yaml`、`current-delivery-state.json` 及本轮主代理更新。
Status: 文档范围已收口；产品完整闭环仍有接线与样本来源缺口，运行验收交由 Principal。

## Result

- 修正 `docs/architecture/embodied_factory.md`：React/NestJS/PostgreSQL 是主产品；Python/SQLite 是 Edge 基线；`ui/command_map/` 已归档；SSE 已有实现；九层设计与旧版本路线不作为完成声明。
- 新增 `docs/architecture/product-delivery-2026-09.md`：感知→影响→候选→审批→派工→执行→反馈→学习映射；World/Event/Command 权限与数据路径；模拟、影子、学习与现场证据的边界。
- 本轮仅修改上述两份架构文档和本报告。没有修改代码、README、feature-status、共享状态或提交 commit。

## 已有能力，不能再误报为缺失

- React 工厂运行台、指挥地图/决策驾驶舱、调度、审批、仿真、决策历史已有页面及 API 消费；代码入口 `ewoh-spark-app/client/src/app.tsx`。
- NestJS 调度已有世界快照、影响分析、硬约束、候选、审批版本校验、资源预约、派工与 Outbox/SSE；authority 在 `ewoh-spark-app/server/modules/scheduler/`。
- `scheduling-feedback.service.ts` 已有 actual 回填及 assignment/task 状态推进，并返回未匹配/跳过信息。不能沿用旧报告“完全没有完成反馈”的结论。
- `learning/learning-proposal.service.ts` 已有影子评估、人审、回滚及供推理读取的阈值覆盖；`scheduler/prediction/duration-model-training.service.ts` 已有统计时长重训与模型注册。不能写成学习只有日志、没有模型更新。
- `feature-status.yaml` 所列能力均 `productionEnabled=false`；其中 RLS、Edge、runtime gates 有既有 `runtimeVerified=true`。本报告不重放或重新认定这些旧验证。

## Genuine missing functionality / integration gaps

以下是静态走读发现，尚未做本轮数据库复现；排序按对完整产品闭环的影响。修复超出文档写权限，供 Principal 分派与核验。

### G1 — P1：执行回执与学习反馈缺统一应用路径

证据：

- `ewoh-spark-app/server/modules/scheduler/scheduler-dispatch-application.service.ts:22` 的 `executionUpdate` 只委托 `ExecutionService.update`。
- `ewoh-spark-app/server/modules/scheduler/execution.service.ts:142` 更新 `ewoh_scheduling_execution`，派生偏差并发 Outbox；该路径没有调用 `SchedulingFeedbackService.recordActuals`。
- `ewoh-spark-app/server/modules/scheduler/scheduler-event-application.service.ts:262` 的 `recordTaskActuals` 委托反馈服务并推送偏差；`scheduling-feedback.service.ts:298` 回填反馈及推进 assignment/task，没有更新执行表。
- 时长训练读取的是 `ewoh_scheduling_feedback`；地图反馈读取的是 `GET /api/scheduler/executions`。

影响：只通过 execution update 报完工，不能保证产生训练样本或推进任务；只通过 feedback/actuals 回填，也不能保证地图执行记录同步完工。现有两个接口不能被文档描述为一次回执即可完成统一闭环。

建议验收：以同一租户、planId、assignmentId、taskId 经授权派工后提交开始/结束回执，核验执行表、反馈表、assignment/task 与 UI 一致；重试不重复推进，异常/终态不被非法覆盖。若继续保留双接口，必须明确负责关联、幂等及失败恢复的调用方。

### G2 — P1：训练样本缺来源资格与现场证据筛选

证据：`ewoh-spark-app/server/modules/scheduler/prediction/duration-model-training.service.ts:54` 的 `loadSamplesWithTaskType` 仅按 org、非空 actualStart/actualEnd 查询，随后取有效非负时长；`ewoh-spark-app/server/database/schema.ts:2278` 的反馈表未包含专用 source/isSimulation/productionTrainingEligible 字段。当前读取路径也未联查来源或真实验收资格。

影响：有实际时间字段的人工/模拟回填可能成为时长训练样本。“真实反馈训练”这一注释或 API 命名不能证明来源真实。重训还会将注册表新版本设为 active 并刷新 provider，因此不是无影响的日志写入；其预测使用边界仍与派工授权分开。

建议验收：补齐可追溯样本来源与资格，证明 simulated/replayed/controlled_test 及无来源证据的反馈不会被作为生产训练样本；记录每个模型的样本谱系和可复核统计。样本不足继续显式失败，不从模拟数据补齐阈值。

### G3 — P2：React 主路径尚缺完整反馈与学习操作接线

证据：`ewoh-spark-app/client/src/api/scheduler.ts:450` 导出 `updateExecution`，当前 client 搜索没有页面调用；未发现 client 对 `/api/scheduler/feedback/actuals` 或时长 retrain 的调用。`pages/CommandMap/panels/DecisionCockpit.tsx` 读取 executions；`pages/DecisionHistory/` 读取学习提案历史；`pages/ModelManagement/` 处理模型记录；这些只覆盖查看或局部管理。`pages/MobileWorkbench/` 调用 MES mobile API，不能由页面名推定接通 scheduler 回执。

影响：现有 React 页面可贯通观察、决策和审批，但用户不能仅依靠当前操作面完成统一回执→评估→提案→重训流程。后端能力存在应写为 API 已有、产品接线待完成。

建议验收：提供明确的回执入口和角色权限，展示匹配/推进/失败状态；再接通所需学习评估、提案影子/审批/回滚或受控重训入口，并从具体 assignment 追踪至评估或模型版本。无需新建第二套调度或学习后端。

### 已知能力限制，和实现缺口分别处理

- `learning/learning.service.ts` 明确保留 `modelAccuracy=null`，原因是缺 outcome 标注；统计接受率/风险结局不等于已验证模型准确率或因果收益。
- `scheduler-plan-application.service.ts` 在派工后执行建档失败会短重试并返回 `executionSync.ok=false`。已有降级可观测性；尚需主代理在真实数据库场景验证恢复效果，不能宣称派工与执行跟踪总是无缝一致。
- 摄像头/定位接入、Edge 融合库和仿真评估器存在，但本轮硬件仍为模拟；设备身份、现场融合精度、人体负荷有效性与业务收益都缺本轮现场证据。这是验收限制，不是要求本任务增加设备控制。
- 归档地图仍出现在 `feature-status.yaml` 的 commandMap evidence 中；文档已解释其历史性质。清单及其他历史架构快照由相应 owner 后续收敛，本次未扩写范围。

## Principal verification handoff

主代理本轮已报告：本地 PostgreSQL 已启动；bootstrap 角色占位符由 Principal 修复；完整迁移链/compose 依赖由另一执行代理修复。以上是进行中协调信息，本报告未将其写成部署成功或测试通过。后续以修复后的代码和主代理证据替换进行中状态。

建议覆盖：空库完整 apply/verify、迁移身份与受限业务运行角色分离、事务级 GUC/RLS 跨租户拒绝、React→NestJS 审批/派工/回执流程，以及 G1/G2 的实际数据库断言。设备回执仍需明确 simulated 标记；不运行真实设备控制。Principal 决定修复顺序并发布最终测试证据。

## Assumptions / trace requests / verification

- Assumptions: 工作树并行修复仍在进行；本报告是该时间点的静态审查。新增首页属于本轮工作树，不把它说成已发布生产版本。
- Trace requests: 无需额外历史材料；需要 Principal 在最终交付补充本轮数据库/浏览器/测试结果，并确认 G1–G3 在后续修复后的状态。
- Verification: 本 Execution Agent 只做路径/文档及静态调用关系核对；未执行应用测试、数据库写入或浏览器验收，不提供“全测试通过”结论。
