# 模型与规则版本治理及回滚运维

本文档说明「工厂具身智能操作系统」的模型与规则版本治理、生命周期管理、影子运行先于生效规则、回滚流程与审计追溯。对应 spec「算法分阶段实施」与「模型结果 100% 可追溯到模型和数据版本」，承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 7、9 节。

实现位于 `src/edge_platform/governance/model_registry.py`，纯 Python 标准库实现。

## 1. 模型生命周期

每个模型 / 规则版本的生命周期遵循以下状态机（`ModelStatus` 枚举）：

```
CANDIDATE → SHADOW → ACTIVE → RETIRED
```

| 状态 | 枚举值 | 含义 |
| --- | --- | --- |
| 候选 | `CANDIDATE` | 已登记，未上线；生命周期必须从候选开始 |
| 影子运行 | `SHADOW` | 只记录不执行，与现行方案对比 |
| 建议 / 生效 | `ACTIVE` | 建议模式生效；每个 `model_type` 至多一个 `ACTIVE` |
| 退役 | `RETIRED` | 退役，不再生效 |

合法模型类型（`VALID_MODEL_TYPES`，对应 spec「算法分阶段实施」涉及的模型 / 规则类别）：

| 模型类型 | 常量 | 阶段 |
| --- | --- | --- |
| 动作识别模型 | `action_classifier` | 第二阶段 |
| 负荷与疲劳趋势评分 | `fatigue_scorer` | 第三阶段 |
| 调度优化器 | `scheduler` | 第四阶段 |
| 规则集 | `rule_set` | 第一阶段（规则与统计模型） |
| 视觉检测器 | `vision_detector` | 视觉感知 |

`ModelRegistry` 提供生命周期流转方法：

| 方法 | 流转 | 说明 |
| --- | --- | --- |
| `register(model_record)` | → `CANDIDATE` | 登记模型版本；强制从候选开始，避免绕过影子运行直接生效 |
| `promote_to_shadow(model_id, audit_ref)` | `CANDIDATE` → `SHADOW` | 仅候选模型可进入影子运行 |
| `activate(model_id, audit_ref)` | `SHADOW` → `ACTIVE` | 仅 `SHADOW` 可激活；同时将同 `model_type` 的原 `ACTIVE` 自动置 `RETIRED` |
| `retire(model_id, audit_ref)` | 任意 → `RETIRED` | 退役 |
| `active(model_type)` | 查询 | 返回某 `model_type` 的当前生效模型（`ACTIVE`），无则 None |
| `history(model_type)` | 查询 | 返回某 `model_type` 的全部版本记录（按注册顺序） |

## 2. 影子运行先于生效

**影子运行未达标不得进入建议模式**（spec「影子运行未达标不得进入建议模式」）。`ModelRegistry.activate` 强制约束：

- 仅 `SHADOW` 状态的模型可激活为 `ACTIVE`；
- 若当前状态非 `SHADOW`（如直接从 `CANDIDATE` 激活），抛出异常「仅 SHADOW 可激活为建议模式…（影子运行未达标不得进入建议模式）」；
- 激活同时将同 `model_type` 的原 `ACTIVE` 自动置 `RETIRED`，保证每类至多一个生效模型。

该约束与调度层的影子运行纪律一致（调度先影子运行只记录不执行，达标后进入建议模式），详见 [docs/algorithms/scheduling.md](../algorithms/scheduling.md) 第 4 节。

## 3. 回滚流程

`ModelRegistry.rollback(model_type, to_model_id, audit_ref)` 执行版本回滚：

1. 校验目标模型 `to_model_id` 的 `model_type` 与入参一致；
2. 校验目标模型**曾进入 `ACTIVE` 或 `SHADOW`**（依据审计流转记录判定，`_was_active_or_shadow`）；仅允许回滚到曾 `ACTIVE`/`SHADOW` 的版本，不得回滚到从未上线的 `CANDIDATE`；
3. 将当前 `ACTIVE` 模型置 `RETIRED`（若与目标不同）；
4. 将目标历史版本重新置 `ACTIVE`，刷新 `activated_at`；
5. 全流程入审计（`audit_trail`）。

### 回滚约束

- 仅可回滚到**曾 `ACTIVE`/`SHADOW`** 的版本（不可回滚到从未上线的候选）；
- 回滚后原 `ACTIVE` 模型自动退役；
- 每次 `rollback` 写入一条审计条目（`action=rollback`，含 `from_status` / `to_status`）。

## 4. 版本可追溯性

每个 `ModelRecord` 携带完整的版本追溯链（spec「模型结果 100% 可追溯到模型和数据版本」）：

| 字段 | 说明 |
| --- | --- |
| `model_type` | 模型类型（如 `action_classifier`） |
| `version` | 模型版本号 |
| `model_id` | 模型唯一 ID（自动生成 `MODEL-{uuid8}`） |
| `data_version` | 训练数据版本 |
| `feature_version` | 特征版本 |
| `threshold_version` | 阈值版本（如动作识别阈值、负荷阈值） |
| `model_card_uri` | 模型卡 URI（含训练集划分、指标、限制） |
| `status` | 当前生命周期状态 |
| `activated_at` / `retired_at` | 激活 / 退役时间 |
| `audit_ref` | 关联的审计条目引用 |

`data_version` / `feature_version` / `threshold_version` / `model_card_uri` 共同构成追溯链，保证任意模型结果可追溯到产生它的模型版本与数据版本。

### 算法分阶段实施约束

- **第二阶段动作识别模型**：按人员划分测试集，不允许同一人员数据同时出现在训练和测试；每个模型有模型卡（`model_card_uri`）；保存数据 / 特征 / 模型 / 阈值版本；未知动作必须输出 `unknown`，不得强制分类；
- **第三阶段负荷与疲劳趋势评分**：只做趋势评分不做医学诊断，输出当前负荷 / 趋势 / 主要原因 / 建议；
- **第四阶段调度优化**：先约束优化和启发式，再考虑强化学习，首期不用强化学习。

## 5. 审计轨迹

`ModelRegistry.audit_trail` 记录每一次状态流转（append-only）：

| 字段 | 说明 |
| --- | --- |
| `log_id` | 审计条目 ID（`MAUD-{uuid8}`） |
| `model_id` | 涉及的模型 ID |
| `action` | 动作（`register` / `promote_to_shadow` / `activate` / `retire` / `retire(auto)` / `retire(rollback)` / `rollback`） |
| `actor_id` | 操作人 |
| `ts` | 时间戳 |
| `ref` | 关联的审计引用（`audit_ref`） |
| `from_status` / `to_status` | 流转前 / 后状态 |
| `detail` | 详情（如版本号、被取代的模型 ID） |

每次 `register` / `promote_to_shadow` / `activate` / `retire` / `rollback` 均写入审计条目，激活时若取代原 `ACTIVE` 模型，原模型的退役也单独记录（`action=retire(auto)` / `retire(rollback)`）。

## 6. 与验收的关联

本模块支撑以下验收指标（详见 [docs/acceptance/embodied_factory_acceptance.md](../acceptance/embodied_factory_acceptance.md)）：

- **模型结果 100% 可追溯到模型和数据版本**：由 `data_version` / `feature_version` / `threshold_version` / `model_card_uri` 保证；
- **影子运行未达标不得进入建议模式**：由 `activate` 的状态前置约束保证；
- **写操作审计覆盖率 100%**：由 `audit_trail` 对每次流转入审计保证；
- **审计覆盖 100% / 备份恢复 100%**：审计轨迹与版本历史支持完整恢复。

## 7. 实现参考

| 类 / 方法 | 职责 |
| --- | --- |
| `ModelRegistry.register` | 登记模型版本（强制 `CANDIDATE` 起步） |
| `ModelRegistry.promote_to_shadow` | `CANDIDATE` → `SHADOW` |
| `ModelRegistry.activate` | `SHADOW` → `ACTIVE`（前置约束 + 自动退役原 ACTIVE） |
| `ModelRegistry.retire` | 任意 → `RETIRED` |
| `ModelRegistry.active` / `history` / `get` | 当前生效 / 版本历史 / 按 ID 查询 |
| `ModelRegistry.rollback` | 回滚到曾 `ACTIVE`/`SHADOW` 的版本 |
| `ModelRegistry.audit_trail` | 全链路状态流转审计 |
| `ModelRecord` / `ModelStatus` | 模型记录与生命周期状态 |

## 8. 关联文档

- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 7、9 节）
- [docs/algorithms/scheduling.md](../algorithms/scheduling.md) — 决策与调度算法与人在回路
- [docs/governance/worker_data_policy.md](../governance/worker_data_policy.md) — 员工数据治理与隐私（训练数据单独授权）
- [docs/acceptance/embodied_factory_acceptance.md](../acceptance/embodied_factory_acceptance.md) — 验收指标（模型结果可追溯）
- [delivery/03_数据与算法/data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv) — 数据字典（模型卡字段）
