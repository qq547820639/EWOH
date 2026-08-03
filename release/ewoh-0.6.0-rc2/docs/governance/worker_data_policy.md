# 员工数据治理与隐私策略

本文档说明「工厂具身智能操作系统」的员工数据治理与隐私策略，包括数据最小化、边缘推理与中心存储策略、分层保留、员工数据权利与安全使用边界。对应 spec「数据治理与隐私扩展」（8.1—8.4），承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 10 节核心原则。

实现位于 `src/edge_platform/governance/`（consent / retention / model_registry），纯 Python 标准库实现。

## 1. 数据最小化原则

系统默认不采集下列数据（spec 8.1），仅在员工显式授权且与安全生产相关时才采集：

- 身份证等**强身份信息**；
- 无明确用途的**长期精确轨迹**；
- **持续保存的原始视频**；
- **非必要生理数据**；
- 与安全生产无关的个人信息。

每类数据用途均需员工显式授权。授权用途由 `ConsentPurpose` 枚举定义：

| 用途 | 枚举值 | 说明 |
| --- | --- | --- |
| 外骨骼遥测 | `TELEMETRY` | 设备级 / 运动级 / 负荷级遥测 |
| 原始视频 | `VIDEO` | 原始视频 / 事件短视频证据 |
| 视觉骨架 | `SKELETON` | 视觉骨架 / 姿态（边缘推理产物） |
| 人员位置 | `LOCATION` | 人员位置 / UWB 定位 |
| 任务绑定 | `TASK_BINDING` | 人员—设备—任务绑定关系 |
| 训练数据 | `TRAINING` | 模型训练数据（单独授权） |
| 跨天身份追踪 | `CROSS_DAY_TRACKING` | 跨天身份追踪（非必要不开） |

授权记录 `ConsentRecord` 显式记录 `purposes`（已授权用途）与 `fields`（允许采集/使用的字段路径），体现数据最小化。

## 2. 边缘推理与中心存储策略

采用「边缘推理 + 中心只存结构化结果」的策略（spec 8.2），降低原始数据留存与隐私风险：

- **边缘侧完成人体检测与骨架提取**：摄像头在边缘侧完成检测与骨架提取，中心平台只接收结构化结果（bbox + 骨架 + 置信度 + 摄像头 ID + 模型版本），不依赖原始视频，详见 [docs/spatial/camera_calibration.md](../spatial/camera_calibration.md)；
- **中心保存骨架与事件**：中心平台优先保存结构化骨架与事件，不默认长期保存完整视频；
- **原始视频短缓存自动覆盖**：无事件时原始视频短缓存自动覆盖（视频最小化场景）；
- **人脸默认模糊**：人脸默认模糊或不识别；
- **非必要不做跨天身份追踪**：跨天身份追踪（`CROSS_DAY_TRACKING`）需单独授权，非必要不开。

### Scenario: 视频最小化
- **WHEN** 无事件发生
- **THEN** 中心平台不长期保存完整视频，原始视频短缓存无事件自动覆盖。

### Scenario: 识别结果可追溯
- **WHEN** 任意视觉识别结果被使用
- **THEN** 结果附带置信度、摄像头 ID、模型版本，可追溯。

## 3. 分层保留策略

数据按分级分层保留（spec 8.3），默认保留天数见 `DEFAULT_RETENTION`（`governance/retention.py`）：

| 数据分级 | 枚举值 | 默认保留天数 | 说明 |
| --- | --- | --- | --- |
| 高频原始遥测 | `HIGH_FREQ_TELEMETRY` | 30 天 | 外骨骼设备/运动/负荷级高频遥测 |
| 分钟级聚合 | `MINUTE_AGG` | 365 天（12 个月） | 分钟级聚合统计 |
| 事件证据 | `EVENT_EVIDENCE` | 90 天 | 按事件闭环周期 |
| 调度与任务记录 | `SCHEDULE_TASK` | 365 天 | 按生产审计周期 |
| 审计日志 | `AUDIT_LOG` | 180 天 | 不少于 180 天，即便策略被改小也不得提前清理 |
| 三维底图 | `SPATIAL_BASEMAP` | −1（长期/版本化） | 按版本长期保存，不自动删除 |
| 训练数据 | `TRAINING_DATA` | −1（长期/版本化） | 单独授权和版本管理，不自动删除 |

说明：
- `retention_days = -1` 表示长期保留 / 版本化，不自动删除；
- **审计日志最低保留 180 天**：`RetentionManager.purge_due` 对 `AUDIT_LOG` 强制使用 180 天下限，即便策略被改小也不得提前清理；
- **永不自动清除** `SPATIAL_BASEMAP` / `TRAINING_DATA`：版本化管理，新版本不覆盖旧版本（`RetentionManager.register` 保留历史）；
- 保留策略版本化注册：`RetentionManager` 按 `data_class` 保留全部历史版本（`history()`），新版本不覆盖旧版本，便于回放与审计。

## 4. 员工数据权利

员工享有以下数据权利（spec 8.4），由 `ConsentManager` 提供查询与撤回能力：

| 权利 | 实现入口 | 说明 |
| --- | --- | --- |
| 知情 | `ConsentManager.list_for_person` | 返回该人员全部授权记录，可知采集哪些数据、用途与字段范围 |
| 用途 | `ConsentRecord.purposes` / `ConsentRecord.retention_rule` | 授权记录显式标注用途与对应保留规则 |
| 查看主要结论 | 世界模型层 / 事件中心 | 可查看与自身有关的主要结论（沿事件因果链追溯） |
| 更正 | 申诉/更正流程 | 对错误数据提出更正 |
| 申诉 | `Scheduler.reject` 记录理由 | 对误判进行说明，标记特殊情况 |
| 查询访问记录 | `ConsentManager.access_log` | 查询谁访问过敏感数据（每次 grant/revoke/check 均入审计） |
| 撤回授权 | `ConsentManager.revoke` | 在政策允许范围内撤回授权 |

### 授权撤回流程

`ConsentManager.revoke(record_id, reason, actor_id)` 执行撤回（spec「授权撤回」场景）：

1. 置 `ConsentRecord.status = REVOKED`，记录 `revoked_at` 与 `revocation_reason`；
2. 平台停止该人员新增采集（撤回后 `is_allowed` 返回 False）；
3. 产出 `RevocationJob`，按既定流程执行**删除 / 匿名化 / 移交**动作；
4. 全过程入审计（`access_log`）。

各用途默认撤回动作（spec「按既定流程执行删除/匿名化/移交」）：

| 用途 | 默认撤回动作 | 原因 |
| --- | --- | --- |
| `TELEMETRY` | delete（删除） | 高频遥测短保留，直接删除 |
| `VIDEO` | delete（删除） | 原始视频短缓存本就自动覆盖 |
| `SKELETON` | anonymize（匿名化） | 保留聚合统计 |
| `LOCATION` | anonymize（匿名化） | 位置轨迹匿名化 |
| `TASK_BINDING` | handover（移交） | 移交给班组长 / 生产审计 |
| `TRAINING` | anonymize（匿名化） | 版本化数据集则标记 |
| `CROSS_DAY_TRACKING` | delete（删除） | 跨天追踪直接删除 |

### Scenario: 授权撤回
- **WHEN** 员工撤回数据授权
- **THEN** 平台停止该人员新增采集，按既定流程执行删除/匿名化/移交，全过程入审计。

### Scenario: 数据权利可查
- **WHEN** 员工查询自身数据
- **THEN** 可知采集内容、用途、主要结论、访问记录，并可提出更正或申诉。

## 5. 安全使用边界

调度与负荷数据的使用须遵守以下安全边界：

- **不得用于处罚**：系统不得根据单次算法结果直接处罚员工（spec「人在回路与调度纪律」）；
- **不做个人排名**：指挥地图避免游戏化排名与过度监控（P 社式上帝视角但不排名）；
- **不做医学诊断**：负荷与疲劳趋势仅输出趋势评分与建议，明确不是医疗诊断，不使用「患病」「健康异常」等表述（spec「负荷趋势非诊断」场景）；
- **低置信度不生成强建议**：感知融合层低置信度结果不向上游生成强调度建议；
- **未经授权自动调度为 0**：调度须经班组长确认，详见 [docs/algorithms/scheduling.md](../algorithms/scheduling.md)。

## 6. 实现参考

| 模块 | 类 / 方法 | 职责 |
| --- | --- | --- |
| `governance.consent` | `ConsentManager`（`grant` / `revoke` / `is_allowed` / `list_for_person` / `access_log`）, `ConsentRecord`, `ConsentPurpose`, `RevocationJob` | 授权授予 / 撤回 / 查询 / 访问审计 |
| `governance.retention` | `RetentionManager`（`register` / `current` / `history` / `expire_by` / `purge_due`）, `RetentionPolicy`, `DataClass`, `DEFAULT_RETENTION` | 分层保留策略与到期清理 |
| `governance.model_registry` | `ModelRegistry`, `ModelRecord`, `ModelStatus` | 模型与规则版本治理，详见 [docs/operations/model_rollback.md](../operations/model_rollback.md) |

`ConsentManager.is_allowed(person_id, purpose, field)` 每次查询入访问审计（`access_log`，action=`check`），保证「查询谁访问过敏感数据」可追溯。

## 7. 关联文档

- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 10 节核心原则）
- [docs/algorithms/scheduling.md](../algorithms/scheduling.md) — 决策与调度算法与人在回路
- [docs/operations/model_rollback.md](../operations/model_rollback.md) — 模型与规则版本治理
- [docs/spatial/camera_calibration.md](../spatial/camera_calibration.md) — 摄像头接入与边缘视觉
- [delivery/04_安全合规/security_privacy_baseline.md](../../delivery/04_安全合规/security_privacy_baseline.md) — 安全与隐私基线
