# 本地故障重排闭环验证

本场景使用现有 Python Edge HTTP 路由、调度器、约束检查、SQLite 仓储和任务状态机，验证“设备异常 → 数据质量检查 → 影响范围 → 三种候选策略 → 评估 → 模拟人工批准 → 派工 → 现场回执 → 偏差记录 → 重启恢复”。它是主产品的集成验收场景，不替代 React/NestJS 产品，也不构成真实设备验收。

## 运行

在仓库根目录执行，要求 Python 3.9 或更新版本，无第三方 Python 运行依赖：

```sh
make demo-closed-loop
```

默认输出 `output/closed-loop-evidence.json`。脚本启动仅监听 `127.0.0.1` 随机端口的临时 Edge 服务，使用独立临时 SQLite 数据库，运行结束后关闭服务并清理数据库，保留 JSON 证据。既有数据库、真实设备及第三方系统均不参与。

```sh
python3 tools/run_closed_loop_demo.py --output output/fault-recovery.json
python3 tools/run_closed_loop_demo.py --serve
```

`--serve` 完成验证并写出证据后保持模拟 API 运行，终端显示监听地址，按 Ctrl-C 关闭。可以读取 `/api/scheduling/plans`、`/api/assignments` 和 `/api/tasks` 检查状态。Edge 根路径仍是历史界面，不是当前 React 主产品；不要用它验收主产品用户体验。

## 场景与证据

1. 创建搬运任务，种入使用 EXO-001 的中断派工关系。
2. 注入明确标记 `source_type=simulated` 的设备故障观测。质量不合格、超过 60 秒或超前超过 5 秒的观测不改变设备状态。相同观测 ID 重试复用事件，冲突内容拒绝处理。
3. 从中断派工关系推导受影响任务。调度只处理请求列出的任务，找不到任务事实时拒绝生成；不再构造只有 ID 的假任务。
4. 现有 Planner 生成交付、负荷平衡、均衡三种策略。策略数不代表一定产生三种不同的资源分配；可用资源有限时方案可能相同。
5. 验证影子方案不能直接批准或派工。通过公开评估接口检查任务覆盖、人员/设备可用性、路线、时间窗和资源重叠，符合条件才进入待审状态。
6. 由明确的模拟主管身份批准，再单独派工；不向外骨骼发送控制命令。审批后资源状态变化会阻止派工。
7. 通过公开任务状态接口接收开始、完成回执，任务与派工状态同步收敛。
8. 从已记录的执行时间计算预计/实际时长差，并保存幂等反馈。重建调度服务后从 SQLite 恢复同一反馈事实。

证据包包含观测、质量判定、受影响任务、候选计划、评估结果、HTTP 操作及状态码、SSE 事件、反馈与恢复结果。`correlation_id` 是本次场景运行标识；它组织证据包中的记录，尚不证明 Edge SSE 与平台统一事件信封已全链路贯通。

本场景以加速方式立即回执，实际时长是本地软件运行时长，不是物理搬运耗时。`learning.production_training_eligible=false`，禁止将这类数据作为现场节拍、收益指标或生产训练样本。学习阶段目前完成可追溯反馈记录，模型更新仍需使用平台既有评估、审批与版本管理流程。

## Edge API

| 操作 | 请求 | 成功结果 | 拒绝条件 |
| --- | --- | --- | --- |
| 检查并送审 | `POST /api/scheduling/plans/{id}/simulate`，`actor_id`、`reason` | `plan.constraint_summary.evaluation`；合格进入 `pending_review`，不合格保留 `shadow` | 缺理由、非影子状态、快照缺失/过期、只读模式 |
| 批准 | `POST /api/scheduling/plans/{id}/confirm` | `approved` 和资源预约 | 未送审、快照关键状态变化、资源冲突 |
| 派工 | `POST /api/scheduling/plans/{id}/execute` | `dispatched` 与正式任务分配 | 未批准、审批后现场关键状态变化、只读模式 |
| 汇总反馈 | `POST /api/scheduling/plans/{id}/feedback`，`actor_id`、`idempotency_key` | 从执行记录计算的 `feedback`；相同幂等键返回原结果 | 未派工、任务尚未完成/取消、时间记录无效、只读模式 |

评估是确定性可行性检查，并非设备动力学仿真或功能安全认证。评估通过不授予操作权限。生产模式的 RBAC 和 Edge advisory 写入边界继续生效；正式调度 authority 仍为 NestJS。不要将此处 `/api/scheduling` 路径误作平台 `/api/scheduler` 契约。

## 验证

```sh
PYTHONPATH=src python3 -m unittest edge_platform.tests.test_closed_loop edge_platform.tests.test_scenario -q
PYTHONPATH=src python3 -m unittest discover -s src/edge_platform/tests
make audit-regression-gates
git diff --check
```

新增回归覆盖请求任务范围、缺失任务拒绝、不可信电量、不可达路线、资源重叠、过期观测、并发反馈幂等、写入失败、技能撤销、审批后设备故障、快照跨实例唯一性及重启后继续评估。

## 下一步接线

- ~~将同一业务场景迁移为 React/NestJS 的真实 PostgreSQL 端到端验收~~ **已完成**：见
  [主产品闭环场景](main-product-closed-loop.md)（`make e2e-closed-loop`）。Edge 参考调度器
  仍不提升为第二个生产写控制面。
- 将平台事件与执行回执通过既有统一事件信封和组织身份关联，验证跨租户与跨工厂隔离。
- 使用既有 Connector SDK/TCK 替换模拟观测输入；设备实时急停、限扭、助力控制继续留在本地控制器。
- 在真实执行回执和样本量足够后，再评估节拍校准与模型训练；模拟反馈始终独立保留。
