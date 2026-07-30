# 多模态数据 Schema V1（Multimodal Data Schema）

本文档定义「工厂具身智能操作系统」多模态数据的统一 schema：外骨骼数据分级、UWB、视觉骨架、MES/任务、环境传感器字段，统一语义模型示例，来源隔离规则，以及设备厂商协议确认要求。本 schema 是九层架构中「边缘适配层」与「感知融合层」的契约依据，承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 2、5 节。

字段表风格沿用 [data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv)（小写蛇形、单位/枚举显式标注、敏感级别、来源）。本系统为纯 Python stdlib 实现，所有原始字段进入平台前必须转换为统一语义，厂商私有字段不泄漏到上层业务。

## 1. 外骨骼数据分级

外骨骼数据分为四个层级，自底向上为设备级、运动级、负荷级、业务级。每条遥测消息可携带多级字段，但每级字段独立可缺省。

### 1.1 设备级（device tier）
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| device_id | string | 是 | | 设备 ID | 内部业务 | 设备 |
| device_model | string | 是 | | 设备型号 | 内部业务 | 设备 |
| firmware_version | string | 是 | | 固件版本 | 内部业务 | 设备 |
| hardware_version | string | 否 | | 硬件版本 | 内部业务 | 设备 |
| battery_percent | number | 否 | 0—100 | 电池电量百分比 | 内部业务 | 设备 |
| temperature_c | number | 否 | 摄氏度 | 设备温度 | 内部业务 | 设备 |
| fault_code | string | 否 | | 故障码 | 敏感 | 设备 |
| comm_quality | number | 否 | 0—1 | 通信质量 | 内部业务 | 设备 |
| online_status | enum | 是 | online/offline/degraded | 在线状态 | 内部业务 | 设备 |
| sensor_health | object | 否 | | 各传感器健康标志 | 敏感 | 设备 |

### 1.2 运动级（motion tier）
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| acceleration | array | 否 | m/s² | 三轴加速度（由 mg 换算） | 敏感 | 设备 |
| angular_velocity | array | 否 | dps | 三轴角速度 | 敏感 | 设备 |
| pitch_deg | number | 否 | degree | 躯干俯仰角 | 敏感 | 设备 |
| roll_deg | number | 否 | degree | 躯干侧倾角 | 敏感 | 设备 |
| yaw_deg | number | 否 | degree | 航向角 | 敏感 | 设备 |
| joint_angles | object | 否 | degree | 各关节角（髋/膝/腰等） | 敏感 | 设备 |
| gait_cycle | number | 否 | 秒 | 步态周期 | 敏感 | 设备/算法 |
| motion_frequency | number | 否 | Hz | 动作频率 | 敏感 | 算法 |
| body_tilt_deg | number | 否 | degree | 身体倾角 | 敏感 | 设备/算法 |

### 1.3 负荷级（load tier）
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| assist_level | number | 否 | 0—1 | 助力水平 | 内部业务 | 设备 |
| assist_output | number | 否 | N | 助力输出 | 内部业务 | 设备 |
| torque_nm | number | 否 | Nm | 助力力矩（腰部等） | 内部业务 | 设备 |
| pressure | object | 否 | Pa/N | 压力（肩/腰/手等部位） | 敏感 | 设备 |
| lift_count | integer | 否 | 次 | 搬运次数 | 敏感 | 算法 |
| high_load_duration_s | number | 否 | 秒 | 高负荷持续时长 | 敏感 | 算法 |
| cumulative_load | number | 否 | 0—1 | 累计负荷指标（积分） | 敏感 | 算法 |

### 1.4 业务级（business tier）
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| worker_id | string | 是 | | 匿名人员 ID | 敏感 | 业务 |
| task_id | string | 否 | | 当前任务 ID | 内部业务 | 业务 |
| station_id | string | 否 | | 当前工位 ID | 内部业务 | 业务 |
| start_time | datetime | 否 | ISO 8601 | 任务开始时间 | 敏感 | 业务 |
| end_time | datetime | 否 | ISO 8601 | 任务结束时间 | 敏感 | 业务 |
| progress | number | 否 | 0—1 | 任务进度 | 内部业务 | 业务 |
| anomaly_note | string | 否 | | 异常说明 | 敏感 | 业务/算法 |

### Scenario: 多级数据可用
- **WHEN** 调度器评估人员负荷
- **THEN** 可获取该人员当前动作、累计负荷、电量、健康状态等多级数据，均经统一语义转换，厂商私有字段不直接出现在上层业务代码。

## 2. UWB 字段
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| tag_id | string | 是 | | UWB 标签 ID | 内部业务 | 设备 |
| worker_id | string | 否 | | 绑定人员 ID | 敏感 | 业务 |
| x | number | 是 | 米 | X 坐标 | 敏感 | 设备 |
| y | number | 是 | 米 | Y 坐标 | 敏感 | 设备 |
| z | number | 否 | 米 | Z 坐标（楼层/高度） | 敏感 | 设备 |
| frame | string | 是 | | 坐标参考系 | 内部业务 | 平台 |
| error_ellipse | object | 否 | 米 | 定位误差椭圆 | 内部业务 | 设备 |
| anchor_ids | array | 否 | | 参与定位的基站 ID | 内部业务 | 设备 |
| confidence | number | 否 | 0—1 | 定位置信度 | 内部业务 | 平台 |
| timestamp | datetime | 是 | ISO 8601 | 采集时间 | 敏感 | 设备 |
| sequence | integer | 是 | | 帧序列号（丢包检测） | 内部业务 | 设备 |

## 3. 视觉骨架字段
视觉骨架在边缘侧完成人体检测与骨架提取，中心平台默认只保存结构化结果，不长期保存完整视频。每个识别结果附带置信度、摄像头 ID、模型版本。
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| camera_id | string | 是 | | 摄像头 ID | 内部业务 | 设备 |
| track_id | string | 否 | | 跨镜跟踪 ID | 内部业务 | 算法 |
| worker_id | string | 否 | | 绑定人员 ID（默认不识别人脸） | 敏感 | 业务 |
| keypoints | array | 是 | | 人体关键点（坐标+置信度） | 敏感 | 算法 |
| bbox_2d | object | 是 | 像素 | 人体检测框 | 敏感 | 算法 |
| pose_3d | object | 否 | 米 | 三维姿态（工厂坐标系） | 敏感 | 算法 |
| action_label | enum | 否 | stand/walk/bend/lift/unknown | 动作标签 | 敏感 | 算法 |
| confidence | number | 是 | 0—1 | 识别置信度 | 内部业务 | 算法 |
| model_version | string | 是 | | 模型版本 | 内部业务 | 算法 |
| timestamp | datetime | 是 | ISO 8601 | 采集时间 | 敏感 | 设备 |

### Scenario: 识别结果可追溯
- **WHEN** 任意视觉识别结果被使用
- **THEN** 结果附带置信度、摄像头 ID、模型版本，可追溯。

### Scenario: 视频最小化
- **WHEN** 无事件发生
- **THEN** 中心平台不长期保存完整视频，原始视频短缓存无事件自动覆盖；事件时保存授权范围短视频证据。

## 4. MES/任务字段
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| task_id | string | 是 | | 任务/工单 ID | 内部业务 | MES |
| task_type | string | 是 | | 任务类型（搬运/装配/巡检等） | 内部业务 | MES |
| station_id | string | 否 | | 关联工位 ID | 内部业务 | MES |
| assignee | string | 否 | | 分配人员 ID | 敏感 | MES |
| required_skills | array | 否 | | 所需技能/资质 | 内部业务 | MES |
| deadline | datetime | 否 | ISO 8601 | 截止时间 | 内部业务 | MES |
| priority | enum | 否 | P0/P1/P2/P3 | 优先级 | 内部业务 | MES |
| progress | number | 否 | 0—1 | 任务进度 | 内部业务 | MES |
| status | enum | 是 | pending/assigned/in_progress/done/canceled | 任务状态 | 内部业务 | MES |
| equipment_id | string | 否 | | 关联设备/PLC/AGV ID | 内部业务 | MES |

## 5. 环境传感器字段
| 字段 | 类型 | 必填 | 单位/枚举 | 说明 | 敏感级别 | 来源 |
| --- | --- | --- | --- | --- | --- | --- |
| sensor_id | string | 是 | | 传感器 ID | 内部业务 | 设备 |
| sensor_type | enum | 是 | temperature/vibration/noise/air_quality | 传感器类型 | 内部业务 | 设备 |
| station_id | string | 否 | | 关联工位/区域 ID | 内部业务 | 业务 |
| value | number | 是 | 见 sensor_type | 读数 | 内部业务 | 设备 |
| unit | string | 是 | | 单位（℃/m·s⁻²/dB/AQI） | 内部业务 | 设备 |
| timestamp | datetime | 是 | ISO 8601 | 采集时间 | 敏感 | 设备 |
| sequence | integer | 是 | | 帧序列号 | 内部业务 | 设备 |
| quality | enum | 否 | good/degraded/invalid | 数据质量 | 内部业务 | 平台 |

## 6. 统一语义模型（Unified Semantic Model）

所有原始字段进入平台前必须转换为统一语义模型。厂商私有字段不直接出现在上层业务代码。统一语义模型字段集：`entity_id / worker_id / event_time / source_type / pose / load / device / quality`。

### 示例 JSON
```json
{
  "entity_id": "worker-4f2a9c1e",
  "worker_id": "person-7d3e",
  "event_time": "2026-07-31T14:23:18.512+08:00",
  "source_type": "real",
  "pose": {
    "x": 12.340, "y": 8.750, "z": 0.000,
    "yaw_deg": 90.0, "frame": "factory-floor-1",
    "pitch_deg": 42.5, "roll_deg": 3.1,
    "keypoints_source": "vision+imu"
  },
  "load": {
    "assist_level": 0.6, "torque_nm": 18.2,
    "cumulative_load": 0.72, "lift_count": 14,
    "high_load_duration_s": 220
  },
  "device": {
    "device_id": "exo-ny-a1-0023",
    "device_model": "NY-EXO-A1",
    "firmware_version": "1.4.2",
    "battery_percent": 63,
    "online_status": "online"
  },
  "quality": {
    "status": "good",
    "confidence": 0.92,
    "packet_loss": 0.003,
    "clock_offset_ms": -4,
    "sources_present": ["uwb", "exo_imu", "vision"]
  },
  "binding": {
    "task_id": "task-2026-0731-018",
    "station_id": "station-3a2b1c0d"
  },
  "provenance": {
    "protocol_version": "ny-exo-a1/v1",
    "rule_model_version": "risk-rule-v0.2",
    "updated_at": "2026-07-31T14:23:18.600+08:00"
  }
}
```

### Scenario: 统一语义转换
- **WHEN** 外骨骼厂商私有字段进入平台
- **THEN** 字段被转换为统一语义模型（entity_id/worker_id/event_time/source_type/pose/load/device/quality），厂商私有字段不直接出现在上层业务代码。

## 7. source_type 来源隔离

| source_type | 含义 | 隔离要求 |
| --- | --- | --- |
| real | 真机/真实现场数据 | 可作为验收依据 |
| controlled_test | 受控测试数据 | 与 real 逻辑或物理隔离，不作为真机验收依据 |
| simulated | 模拟数据 | 与 real 逻辑或物理隔离，不作为真机验收依据 |

- 所有空间实体、感知融合结果、世界模型状态、调度方案、视觉识别结果必须携带 source_type；
- 摄像头、UWB、MES 数据同样适用来源标识与隔离；
- 页面与导出须显示来源标识；
- simulated/controlled_test 数据不得混入 real 验收统计。

### Scenario: 来源隔离
- **WHEN** 受控测试或模拟数据接入
- **THEN** 数据被标记为 controlled_test 或 simulated，与 real 数据物理或逻辑隔离，不作为真机验收依据。

## 8. 设备厂商协议确认要求

每类设备（外骨骼/UWB/摄像头/MES/环境传感器）厂商接入前必须提交以下协议确认材料，未提交完整材料不得进入 real 接入。确认材料登记到协议确认书目录（参考 [delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md](../../delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md)）。

| # | 项目 | 要求 |
| --- | --- | --- |
| 1 | 协议确认书 | 厂商签字确认的协议总览，含设备型号、协议名称、版本、对接责任人 |
| 2 | 字段字典 | 全部原始字段名、类型、单位、枚举、含义、是否必填、敏感级别 |
| 3 | 采样率 | 每类字段的标称采样率与抖动范围 |
| 4 | 单位 | 每个数值字段的物理单位与换算关系（如 mg→m/s²） |
| 5 | 精度 | 每个测量字段的精度/误差范围 |
| 6 | 异常值 | 异常值/越界值/缺省值的表示方式与处理约定 |
| 7 | 丢包策略 | 丢包检测（SEQ）、重传/补传策略、补传窗口、最大补传时长 |
| 8 | 缓存容量 | 设备本地缓存容量、缓存满策略、断网续传策略 |
| 9 | 时钟同步 | 时钟同步方式（NTP/PTP/手动）、同步精度、时钟偏移上报 |
| 10 | 固件兼容 | 固件版本兼容矩阵、升级策略、旧固件回退约定 |
| 11 | 命令白名单 | 平台允许下发设备的命令白名单（只读/配置类，不含安全控制） |
| 12 | 禁止写入列表 | 平台禁止写入设备的字段/命令列表（含安全控制类，明确不得平台下发） |

### 安全控制隔离（强制）
- 急停、限扭、关节实时控制、助力闭环、限速、失联安全态必须保留在设备控制器本地；
- 命令白名单**不得包含**任何安全控制类命令；禁止写入列表必须显式列出安全控制类命令；
- 平台下发实时关节或安全控制指令为 0；
- 所有原始字段在边缘适配层转换为统一语义后才能进入流处理层与上层。

## 9. 数据质量与置信度

每条统一语义消息必须携带 `quality` 对象：
- `status`：good / degraded / invalid（沿用 data_dictionary.csv 的 quality.status 枚举）；
- `confidence`：0—1，融合后整体置信度；
- `packet_loss`：0—1，按 SEQ 统计的丢包率；
- `clock_offset_ms`：设备与平台时钟偏移（ms）；
- `sources_present`：本次融合使用的来源列表（如 `["uwb","exo_imu","vision"]`）。

低置信度不向上游生成强建议；质量为 invalid 的消息不进入感知融合层，仅入审计。

## 10. 关联文档

- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 2 边缘适配层、第 5 感知融合层）
- [docs/spatial/coordinate_system.md](../spatial/coordinate_system.md) — 统一空间坐标体系（frame/坐标变换）
- [delivery/03_数据与算法/data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv) — 数据字典
- [delivery/03_数据与算法/event_dictionary.csv](../../delivery/03_数据与算法/event_dictionary.csv) — 事件字典（含传感器冲突事件）
- [delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md](../../delivery/02_技术规范/真实设备协议确认书_NY-EXO-A1.md) — 协议确认书范本
- [delivery/02_技术规范/device_protocol_spec.md](../../delivery/02_技术规范/device_protocol_spec.md) — 设备协议规范
