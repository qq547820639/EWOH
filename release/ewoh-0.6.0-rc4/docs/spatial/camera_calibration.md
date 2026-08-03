# 摄像头接入与坐标标定

本文档说明「工厂具身智能操作系统」的摄像头接入流程、相机坐标标定、边缘视觉推理、三维验收与降级融合策略。对应 spec「摄像头接入与边缘视觉」（4.3）与「感知融合层」之降级融合场景，承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 5 节与 [docs/spatial/coordinate_system.md](coordinate_system.md)。

实现位于 `src/edge_platform/perception/`（vision_adapter / pose_fusion / quality），纯 Python 标准库实现（仅用 `math.atan2`），无 numpy。

## 1. 摄像头接入十步流程

摄像头按以下十步接入（spec 4.3），每步均为必要环节，不得跳过：

| 步骤 | 环节 | 说明 |
| --- | --- | --- |
| 1 | 资产台账 | 建立摄像头资产台账（ID / 位置 / 安装高度 / 视锥 / 覆盖工位） |
| 2 | 协议确认 | 确认视频协议 / 分辨率 / 帧率 / 访问范围 |
| 3 | 内参标定 | 摄像头内参标定（焦距 / 主点 / 畸变） |
| 4 | 工厂坐标系标定 | 位置朝向标定到工厂坐标系（外参 `location_pose`，见 §2） |
| 5 | 跨镜跟踪 | 跨摄像头目标跟踪关联 |
| 6 | 遮挡逆光夜间反光测试 | 遮挡 / 逆光 / 夜间 / 反光等复杂光照场景测试 |
| 7 | 边缘侧人体检测骨架提取 | 默认在边缘侧完成人体检测与骨架提取 |
| 8 | 中心保存结构化结果 | 中心平台优先保存结构化结果，不默认长期保存完整视频 |
| 9 | 事件时保存授权范围短视频证据 | 仅在事件发生时保存授权范围内的短视频证据 |
| 10 | 识别结果附带置信度 / 摄像头 ID / 模型版本 | 每个识别结果附带置信度、摄像头 ID、模型版本，可追溯 |

### Scenario: 视频最小化
- **WHEN** 无事件发生
- **THEN** 中心平台不长期保存完整视频，原始视频短缓存无事件自动覆盖。

### Scenario: 识别结果可追溯
- **WHEN** 任意视觉识别结果被使用
- **THEN** 结果附带置信度、摄像头 ID、模型版本，可追溯。

## 2. 坐标标定：相机外参到工厂坐标系

摄像头外参（`location_pose`，即相机在工厂坐标系中的位置与朝向）通过 `project_to_floor` 将像平面检测框反投影到工厂地面坐标系。

### 结构化检测结果

边缘侧人体检测与骨架提取后，上报结构化结果 `VisionDetection`（`perception/vision_adapter.py`）：

| 字段 | 说明 |
| --- | --- |
| `camera_id` | 摄像头 ID（资产台账登记） |
| `track_id` | 跨镜跟踪 ID |
| `bbox_xyxy` | 检测框（归一化 `[0,1]` 坐标，左上 (0,0)、右下 (1,1)，y 向下） |
| `skeleton_json` | 骨架 `{关节名: [x, y, conf]}`（如 `hip` / `neck`） |
| `confidence` | 检测置信度 |
| `ts` | 时间戳 |
| `source_type` | 数据来源（real / controlled_test / simulated） |
| `model_version` | 视觉检测模型版本（可追溯） |

### 反投影函数

`project_to_floor(bbox_xyxy, camera_pose, camera_height_m, fov_v_deg)` 将检测框反投影到工厂地面坐标 `(world_x, world_y, confidence)`，返回 None 表示投影失败：

- **输入**：
  - `bbox_xyxy`：归一化图像坐标 `[0,1]`（像素坐标须调用方先归一化）；
  - `camera_pose`：相机外参（`Pose`，含 `x` / `y` / `yaw_deg`），即 `location_pose`；
  - `camera_height_m`：相机安装高度（米）；
  - `fov_v_deg`：垂直视场角（度）。
- **关键假设**（V0.8 简化模型，文档化清晰）：
  1. 相机光轴水平（无俯仰角），仅 `yaw_deg` 决定水平朝向；
  2. 取检测框底边中心为脚部像点（人立于地面 z=0）；
  3. 垂直方向归一化焦距 `fy = 0.5 / tan(fov_v/2)`，假设方形像素 `fx = fy`。
- **反投影步骤**：脚部像点 → 光轴下方俯角 → 水平距离 → 水平方位 → 侧向距离 → 经相机 `yaw` 旋转到工厂坐标系。
- **置信度**：基准 0.6；俯角过小（过远）或过大（过近 / 畸变）时降至 0.36；输出裁剪到 `[0,1]`。

### 骨架到姿态

`skeleton_to_posture(skeleton_json)` 由 `hip` → `neck` 向量相对竖直方向的倾角估计躯干俯仰角：

- 返回 `{"trunk_pitch_deg": float, "lean": str}`；
- `lean` 分级：`upright`（<15°）/ `leaning`（<45°）/ `bent`（≥45°）；
- 骨架不完整（缺 `hip` / `neck`）返回 None。

该姿态在感知融合层与外骨骼 IMU 躯干俯仰角交叉验证，姿态优先取视觉骨架，其次外骨骼 IMU。

## 3. 三维验收

摄像头标定与三维建模验收要求（spec「三维验收」场景）：

- **重点工位地图误差 ≤ 10 厘米**：CAD / 扫描标定精度，L2 / L3 重点工位适用；
- **场景加载 ≤ 5 秒**：三维场景加载时间（普通办公终端）；
- **普通办公终端流畅交互**：不要求专用图形工作站；
- **所有地图实体可追溯到原始数据来源**：每个实体携带 `source_type` / 置信度 / 更新时间 / 版本。

三维建模分 L0—L3 四级，首期以二维（GeoJSON）或 2.5D 指挥地图为主，三维仅对重点工位启用 L2/L3，详见 [docs/spatial/coordinate_system.md](coordinate_system.md) 第 7 节。

### Scenario: 三维验收
- **WHEN** 执行三维验收测试
- **THEN** 重点工位地图误差不超过 10 厘米、场景加载不超过 5 秒、普通办公终端流畅交互、所有地图实体可追溯到原始数据来源。

## 4. 降级融合

摄像头不可用时，感知融合层自动降级到 UWB + 外骨骼 IMU 继续推断（spec「降级融合」场景）。

`PoseFusion.degrade_on_camera_lost(state)`（`perception/pose_fusion.py`）执行降级：

1. 移除 `sources_used` 中的 `vision` 来源；
2. 按降级质量乘数降低置信度，质量标记为 `DEGRADED`；
3. 刷新时间戳，**不中断输出**；
4. 若 `unified_pose` 存在，同步更新其 `confidence`。

### 融合规则（可解释）

`PoseFusion.fuse(person_id, uwb_sample, vision_det, exo_imu, station_id_hint, task_ctx)` 融合 UWB + 视觉 + 外骨骼 IMU + 工位 / 任务上下文，输出 `FusedState`：

- **UWB 与视觉同工位** → 高置信（位置置信度加权平均 + 一致性奖励），质量 `GOOD`；
- **UWB 与视觉工位不一致** → 产生传感器冲突事件（`SensorConflict`），采纳高置信度源，整体降级，质量 `DEGRADED`；
- **仅 UWB** → 用 UWB 位置，基站数 ≥3 为 `GOOD`，否则 `DEGRADED`；
- **仅视觉** → 用反投影地面位置，置信度较低，质量 `DEGRADED`；
- **二者皆无** → 质量 `UNKNOWN`，`pose` 为 None；
- **姿态**：优先视觉骨架，其次外骨骼 IMU 躯干俯仰角，皆无则为 None。

### Scenario: 传感器冲突事件
- **WHEN** UWB 显示人员在 A 工位而视觉显示在 B 工位
- **THEN** 系统产生传感器冲突事件，记录冲突详情与各源置信度，不静默丢弃。

### Scenario: 降级融合
- **WHEN** 摄像头不可用
- **THEN** 系统自动降级到 UWB 与外骨骼数据继续推断，标识置信度下降，不中断输出。

## 5. 实现参考

| 模块 | 类 / 函数 | 职责 |
| --- | --- | --- |
| `perception.vision_adapter` | `VisionDetection`, `project_to_floor`, `skeleton_to_posture`, `bbox_center` | 结构化检测结果、像平面到地面反投影、骨架到姿态粗估 |
| `perception.pose_fusion` | `PoseFusion`（`fuse` / `degrade_on_camera_lost`）, `FusedState` | 多源位置与姿态融合、摄像头丢失降级 |
| `perception.quality` | `QualityStatus`, `SensorConflict`, `ConflictDetector`, `confidence_from_quality` | 质量分级、传感器冲突检测、置信度映射 |
| `perception.uwb_fusion` | `fuse_uwb_positions`, `estimate_uwb_confidence` | UWB 多帧融合与置信度估计 |
| `spatial.coordinate` | `Pose`（`x` / `y` / `z` / `yaw_deg` / `source` / `confidence`） | 空间位姿，相机外参 `location_pose` 与融合位置共用 |

## 6. 关联文档

- [docs/spatial/coordinate_system.md](coordinate_system.md) — 统一空间坐标体系（Pose / 坐标变换 API / 三维建模分级）
- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 5 节感知融合层）
- [docs/data/multimodal_schema.md](../data/multimodal_schema.md) — 多模态数据 schema（视觉 / UWB 字段）
- [docs/governance/worker_data_policy.md](../governance/worker_data_policy.md) — 视频最小化与人脸模糊策略
- [docs/acceptance/embodied_factory_acceptance.md](../acceptance/embodied_factory_acceptance.md) — 三维验收与降级验收指标
