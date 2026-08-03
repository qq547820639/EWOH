# 决策与调度层算法说明

本文档说明「工厂具身智能操作系统」决策与调度层（九层架构第 7 层）的多目标调度算法、硬约束过滤、调度流水线与人在回路纪律。对应 spec「决策与调度层」「人在回路与调度纪律」与「安全边界（扩展，不可变）」，承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 7 节。

实现位于 `src/edge_platform/scheduler/`（constraints / candidate / scoring / explanation / orchestrator），纯 Python 标准库实现，不依赖 OR-tools / pulp 等求解器；约束过滤与评分均为手写规则，可解释、易验收。

## 1. 多目标目标函数

调度采用线性加权的多目标评分函数（spec 3.7）：

```
J = w1·产量 + w2·准时率 − w3·安全风险 − w4·人体负荷 − w5·移动距离 − w6·换岗成本
```

- **正向收益项**：产量（预期产量提升）、准时率（准时完成概率）；
- **负向代价项**：安全风险、人体负荷（当前累计负荷）、移动距离、换岗成本。

各分量均为可解释的简单公式，取自评分上下文 `ctx` 的真实值，不虚构：

| 分量 | 取值来源 | 公式说明 |
| --- | --- | --- |
| production_score | `ctx.expected_production_uplift` | 预期产量提升，标准化 0..1 |
| on_time_score | `ctx.on_time_probability` | 准时完成概率 0..1 |
| safety_risk | `ctx.safety_risk`，否则 `min(1.0, 0.2 × 近期风险事件数)` | 无显式值时由近期风险事件数推导 |
| body_load | `ctx.current_load` | 当前累计负荷评分 0..1 |
| travel_distance | `ctx.distance_to_station`，否则 `distance(person_pose, station_pose)` | 米；复用 `edge_platform.spatial.distance` |
| changeover_cost | `is_changeover` 时为 1.0，否则 0.0 | 是否换岗 |

加权后总评分 `total = w1·production + w2·on_time − w3·safety − w4·body_load − w5·travel − w6·changeover`，各加权贡献之和等于总评分（`score_breakdown` 中 `total` 字段）。

### 权重配置与审计

权重 `w1..w6` 可由工厂配置，但**每次调整必须记录调整前后值、操作人、时间、原因，权重不得由算法自行隐藏决定**（spec「权重可审计」场景）。默认权重见 `ScoringWeights`：

| 权重 | 字段 | 默认值 |
| --- | --- | --- |
| w1 | `w1_production` | 1.0 |
| w2 | `w2_on_time` | 1.0 |
| w3 | `w3_safety_risk` | 1.0 |
| w4 | `w4_body_load` | 1.0 |
| w5 | `w5_travel_distance` | 0.05 |
| w6 | `w6_changeover_cost` | 0.5 |

权重调整通过 `Scorer.set_weights(new_weights, actor_id, reason)` 完成，每次调用写入一条 `WeightAuditEntry`（前值 / 后值 / 操作人 / 原因 / 时间）到 `WeightAuditLog`，可通过 `WeightAuditLog.history()` 审计回溯。

## 2. 八项硬约束

调度前先做硬约束过滤，任意一条违规即取消候选资格（验收要求「硬约束违规为 0」）。被拦截人员不进入评分，但保留违规原因供理由生成解释「为何某人被排除」（spec「评分明细中体现拦截原因」）。

`HardConstraints.check(person, task, device, ctx)` 逐条判定，返回 `ConstraintViolation` 列表（空表示全部通过）。八项硬约束：

| 约束 | 常量 | 判定逻辑 |
| --- | --- | --- |
| 技能资质 | `SKILL` | 人员技能集须包含任务 `required_skills`，缺失即拦截 |
| 工位授权 | `STATION_AUTH` | 人员须取得任务 `station_id` 的作业授权 |
| 健康禁忌 | `HEALTH_TABOO` | 任务 `load_level` / `action_type` 不得命中人员健康禁忌清单 |
| 禁区 | `FORBIDDEN_ZONE` | 任务所在区域不得为全员禁区，也不得为该人员个人禁区（如医疗限制不得进入冷库） |
| 班次休息 | `SHIFT_REST` | 连续作业不得超过班次 `max_continuous_minutes`；每小时须满足 `rest_minutes_per_hour` 休息 |
| 外骨骼型号兼容 | `EXO_MODEL_COMPAT` | 设备 `model` 须满足任务 `exo_requirements` 兼容标签 |
| 设备故障 | `DEVICE_FAULT` | 当前故障设备（`device_faults` 集合）不可调度 |
| 安全规则 | `SAFETY` | 人员处于安全冻结（`safety_hold`）、整体安全态势冻结（`ctx.safety_block`）、人员被单独拦截（`safety_block_persons`），或安全关键作业未取得授权（`safety_approved_persons`）即拦截 |

### Scenario: 硬约束拦截
- **WHEN** 某人员不具备任务所需技能或资质
- **THEN** 该人员不进入候选，评分明细体现拦截原因（`ConstraintViolation.constraint_type` 与中文 `reason`）。

### Scenario: 权重可审计
- **WHEN** 调度权重被调整
- **THEN** 系统记录调整前后值、操作人、时间、原因（`WeightAuditEntry`），权重不得由算法自行隐藏决定。

## 3. 调度流水线

调度按以下顺序执行（spec「决策与调度层」）：

```
硬约束过滤 → 候选生成 → 多目标评分 → 方案模拟 → 理由生成 → 人工确认 → 结果回流
```

1. **硬约束过滤**：`HardConstraints.check` 对每个 `(person, task, device)` 组合逐条判定，违规候选标记 `passed=False` 并保留 `violations`。
2. **候选生成**：`CandidateGenerator.generate` 遍历 `persons × devices` 笛卡尔积，每个组合产出一个 `Candidate`；失败候选不删除（保留以解释拦截原因），调用方排序时仅取 `passed=True`。
3. **多目标评分**：`Scorer.score(candidate, ctx)` 仅对通过硬约束的候选计算 `total` 与 `score_breakdown`（含各分量原值与加权贡献）。
4. **方案模拟**：由场景仿真层（`src/edge_platform/scenario/`）生成至少三个方案并计算分项指标，详见 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 8 节。
5. **理由生成**：`explain_candidate` / `explain_plan` 基于候选的 `score_breakdown` / `violations` 生成中文理由，引用真实计算值（评分、累计负荷、移动距离等），不虚构。
6. **人工确认**：班组长在指挥地图上比较方案并确认（`Scheduler.confirm`），必须填写理由。
7. **结果回流**：执行后通过 `Scheduler.feedback` 记录实际产出，用于学习闭环校准规则/模型/调度参数。

候选排序规则：通过候选按 `score` 降序在前；未通过候选置后（保留以解释拦截原因）。

## 4. 人在回路纪律

调度遵循强制的人在回路纪律（spec「人在回路与调度纪律」与「安全边界（扩展，不可变）」）。`ScheduleRequest.status` 在以下状态间流转：

```
SHADOW → PROPOSED → CONFIRMED → EXECUTED
                    ↘ REJECTED
```

| 状态 | 含义 |
| --- | --- |
| `SHADOW` | 影子运行：只记录不执行（`Scheduler.propose` 产出，首期默认状态） |
| `PROPOSED` | 影子指标达标后升级为建议模式（`Scheduler.promote_to_proposed`，仅 `SHADOW` 可升级） |
| `CONFIRMED` | 班组长已确认（`Scheduler.confirm`，必须填写理由） |
| `REJECTED` | 班组长已否决（`Scheduler.reject`，人工可在任何阶段否决） |
| `EXECUTED` | 已执行（`Scheduler.execute`，仅标记，不触碰设备安全控制） |

### 影子运行先于建议

调度首期上线时仅记录建议不执行，与班组长实际方案对比达标后方可进入建议模式（`promote_to_proposed`）。**未经授权自动调度为 0**。

### 确认审计

- `Scheduler.confirm(request_id, plan_id, actor_id, reason)`：`reason` 为空则拒绝确认（spec「班组长确认时必须选择或填写理由，形成审计记录」）；
- `Scheduler.execute`：仅 `CONFIRMED` 状态可执行；非 `CONFIRMED` 状态返回拒绝记录，状态保持不变，**无任何自动执行旁路**；
- `execute` 仅标记 `EXECUTED` 用于结果回流，**不向设备下发任何安全控制指令**（急停/限扭/关节实时控制等保留在设备控制器本地）；
- 员工应能申诉、标记误判或说明特殊情况（`Scheduler.reject` 支持记录理由）。

### Scenario: 影子运行
- **WHEN** 调度器首期上线
- **THEN** 仅记录建议不执行（`SHADOW`），与班组长实际方案对比，达标后方可进入建议模式（`PROPOSED`）。

### Scenario: 确认审计
- **WHEN** 班组长确认调度方案
- **THEN** 必须选择或填写理由，形成审计记录，未经确认不得自动执行。

## 5. 算法分阶段原则

调度优化为算法第四阶段（spec 6.4「算法分阶段实施」）：**第一阶段使用约束优化 + 启发式，首期不用强化学习**。本实现即采用此原则：

- 约束过滤为逐条规则判定（`HardConstraints.check`），不依赖外部求解器；
- 评分为线性加权公式（`Scorer.score`），可解释、易验收；
- 候选排序按评分降序，配合场景仿真多方案对比；
- 强化学习在首期范围外，后续版本再考虑。

## 6. 实现参考

| 模块 | 类 / 方法 | 职责 |
| --- | --- | --- |
| `scheduler.constraints` | `HardConstraints`, `ConstraintViolation` | 八项硬约束逐条判定 |
| `scheduler.candidate` | `CandidateGenerator.generate`, `Candidate` | 候选生成与违规填充 |
| `scheduler.scoring` | `Scorer.score`, `Scorer.set_weights`, `ScoringWeights`, `WeightAuditLog`, `WeightAuditEntry` | 多目标评分与权重审计 |
| `scheduler.explanation` | `explain_candidate`, `explain_plan`, `Explanation` | 分项理由生成（引用真实值） |
| `scheduler.orchestrator` | `Scheduler`（`propose` / `promote_to_proposed` / `confirm` / `reject` / `execute` / `feedback` / `get_request`）, `ScheduleRequest` | 人在回路编排与状态机 |

约束类型常量：`SKILL` / `STATION_AUTH` / `HEALTH_TABOO` / `FORBIDDEN_ZONE` / `SHIFT_REST` / `EXO_MODEL_COMPAT` / `DEVICE_FAULT` / `SAFETY`。

## 7. 关联文档

- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 7 节决策与调度层、第 8 节场景仿真层）
- [docs/governance/worker_data_policy.md](../governance/worker_data_policy.md) — 员工数据治理与隐私
- [docs/operations/model_rollback.md](../operations/model_rollback.md) — 模型与规则版本治理、回滚
- [docs/acceptance/embodied_factory_acceptance.md](../acceptance/embodied_factory_acceptance.md) — 验收指标（硬约束违规为 0、采纳率等）
- [delivery/03_数据与算法/data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv) — 数据字典
