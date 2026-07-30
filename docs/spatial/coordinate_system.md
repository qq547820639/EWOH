# 统一空间坐标体系（Unified Spatial Coordinate System）

本文档定义「工厂具身智能操作系统」的统一空间层级、实体字段契约、坐标变换 API、静态/动态分离、空间资产格式与三维建模分级。本规范是九层架构中「空间数字底座」层的实现依据，承接 [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) 第 4 节。

本系统为纯 Python stdlib 实现，坐标变换与几何运算使用标准库数学计算，不依赖第三方几何库；空间实体与拓扑表保持 SQLite 兼容。

## 1. 空间层级

系统建立七级空间层级，自顶向下为：

```
集团（Group）
  └─ 工厂（Factory）
       └─ 车间（Workshop）
            └─ 产线（Line）
                 └─ 区域（Zone）
                      └─ 工位（Station）
                           ├─ 设备（Device）
                           ├─ 人员（Worker）
                           └─ 任务（Task）
```

- 前 6 级（集团→工位）为**静态空间容器**，由 CAD/BIM/平面图/设备布局资料构建，按版本长期保存；
- 第 7 级（设备/人员/任务）为**挂载在工位上的实体**，其中设备外形为静态、设备状态为动态；人员与任务为动态实体。
- 每个实体有且仅有一个父级空间（parent_id），形成树形层级；跨层级引用通过唯一 ID 解析。
- CAD 资料完整时优先由 CAD 生成空间底图，资料不完整时才进行现场扫描。

## 2. 实体必填字段契约

每一个空间实体（无论层级）必须具备以下 10 个字段。字段命名沿用 [data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv) 的风格（小写蛇形、单位/枚举显式标注）。

| 字段 | 类型 | 必填 | 单位/枚举 | 说明 |
| --- | --- | --- | --- | --- |
| entity_id | string | 是 | | 唯一 ID，全局唯一，格式 `{type}-{uuid8}` 如 `station-3a2b1c0d` |
| parent_id | string | 是 | | 父级空间 entity_id；集团层为空字符串 |
| entity_type | enum | 是 | group/factory/workshop/line/zone/station/device/worker/task | 实体类型 |
| pose | object | 是 | | 坐标与朝向，见 §3 |
| bbox | object | 是 | | 边界框（最小外接矩形/盒），见 §3 |
| status | enum | 是 | active/idle/fault/offline/maintenance/blocked | 实体当前状态 |
| source_type | enum | 是 | real/controlled_test/simulated | 数据来源类型，受控测试与模拟数据须隔离 |
| confidence | number | 是 | 0—1 | 实体状态置信度；静态实体为 1.0 |
| updated_at | datetime | 是 | ISO 8601 | 更新时间（平台时间，带时区） |
| version | integer | 是 | | 实体记录版本号，单调递增，用于乐观锁与回放 |

补充字段（按实体类型附加，不计入 10 必填）：
- 设备：device_model、firmware_version、protocol_version、safety_local（布尔，恒真，表示安全控制本地化）；
- 人员：worker_id（匿名）、skills、consent_status、current_task_id；
- 任务：task_id、assignee、deadline、progress；
- 工位：station_no、allowed_skills、exoskeleton_models（兼容型号列表）；
- 区域：zone_kind（生产/通道/禁区/休息/消防）、capacity；
- 摄像头视锥与 UWB 基站覆盖区：作为静态子资产挂在工位/区域下，含 frustum/coverage 几何。

### Scenario: 空间实体可追溯
- **WHEN** 任意地图实体被选中
- **THEN** 可查看其 entity_id、parent_id、坐标、朝向、边界框、状态、source_type、置信度、更新时间与版本，并能沿 source_type 与 entity_id 追溯到原始数据来源。

## 3. 坐标、朝向与边界框

### 坐标系约定
- 全厂统一采用**右手系米制坐标系**（单位：米），原点与朝向在工厂层定义并冻结；
- 坐标 `pose` 对象：
  ```json
  {
    "x": 12.340,
    "y": 8.750,
    "z": 0.000,
    "yaw_deg": 90.0,
    "frame": "factory-floor-1"
  }
  ```
  - `x/y/z` 为三维坐标（米）；二维地图 z 恒为 0；
  - `yaw_deg` 为偏航角（度，0 = 朝向 +X，逆时针为正），表达朝向；
  - `frame` 为坐标参考系名称，用于跨楼层/跨车间坐标变换。

### 边界框 `bbox`
```json
{
  "min": {"x": 11.0, "y": 8.0, "z": 0.0},
  "max": {"x": 13.5, "y": 9.5, "z": 1.8},
  "crs": "factory-floor-1"
}
```
- 静态容器使用世界坐标轴对齐边界框（AABB）；
- 动态人员可用圆/胶囊近似，但 bbox 字段统一存 AABB 以便空间索引。

## 4. 坐标变换 API 契约

空间数字底座提供统一坐标变换 API，所有上层（感知融合/世界模型/调度/仿真/UI）坐标转换必须经过本 API，不得自行实现坐标换算。API 契约（纯函数、无副作用）：

```
transform(point, src_frame, dst_frame) -> {point, residual, method}
transform_bbox(bbox, src_frame, dst_frame) -> {bbox, method}
register_frame(frame_id, parent_frame_id, transform_params, source_type, version) -> frame_id
list_frames() -> [frame_id]
get_frame_chain(frame_id) -> [frame_id, ...]   # 从根到本帧的链路
```

- `point` 为 `{x,y,z}`；返回新增 `residual`（残差/不确定性，米）与 `method`（如 `cad-static` / `uwb-trilateration` / `vision-pnp`）；
- 变换参数 `transform_params` 含平移 `(tx,ty,tz)`、旋转 `(rx,ry,rz_deg)`、缩放 `(sx,sy,sz)`、以及 `confidence` 与 `source_type`；
- 帧注册须带 source_type 与 version；simulated/controlled_test 帧不得用于 real 验收；
- 静态帧变换参数按版本长期保存；动态实体只挂载在某个帧上，不修改帧本身。

### 实现约束
- 变换链路组合必须是可结合的；变换矩阵在 SQLite 中按帧邻接表存储，查询时沿 `get_frame_chain` 串联；
- 任一变换的 `residual` 须回传给感知融合层用于置信度计算；
- 坐标变换不得修改实体状态，仅返回新坐标。

## 5. 静态/动态分离

| 层 | 内容 | 更新频率 | 存储 |
| --- | --- | --- | --- |
| 静态空间底图 | 厂房结构、产线、设备外形、工位、通道、禁区、摄像头视锥、UWB 基站覆盖区、拓扑邻接 | 按版本，低频 | 长期保存，按版本不可变 |
| 动态实体层 | 人员位置骨架、外骨骼状态、AGV/叉车/物料、当前任务、告警、风险热力图、预测轨迹 | 高频（秒级） | 分层保留（高频 7—30 天/分钟聚合 6—12 月） |

### Scenario: 静态动态分离
- **WHEN** 人员位置高频更新
- **THEN** 静态空间底图不被重新构建，仅动态实体层刷新；坐标变换帧链路不变，仅实体 pose 与 status 更新。

实现要点：
- 静态底图加载后缓存在内存，动态实体通过 entity_id 关联到静态底图节点；
- 三维场景渲染时静态层只加载一次，动态层每帧只更新 pose/bbox；
- 静态底图变更必须生成新版本号，旧版本保留以支持回放。

## 6. 空间资产格式

系统统一输出以下空间资产格式，每种格式有明确适用场景，不允许混用：

| 格式 | 适用场景 | 说明 |
| --- | --- | --- |
| GeoJSON | 二维区域、路线、工位多边形、禁区、UWB 覆盖区 | 默认二维指挥地图底图；坐标用 [x, y] 米制 |
| GLB / glTF | 轻量三维（设备、工位、L2 场景） | 可交互三维资产，单文件，浏览器可直接加载 |
| 3D Tiles | 大规模场景分块（整个车间/工厂三维） | 按瓦片分块加载，支持 LOD |
| 点云 / Gaussian Splat | 局部高写实（L3 重点工位） | 仅用于事故复盘/培训/复杂空间分析 |
| JSON 拓扑 | 工位路线邻接、通道连通图 | 调度路径计算与移动距离评估使用 |

- 所有资产文件在对象存储中按 `{entity_id}/{version}/{asset_type}` 路径存放，并登记到空间资产注册表；
- 每个资产须携带 source_type、生成方法、精度（米）、生成时间、关联 entity_id；
- 首期以二维（GeoJSON）或 2.5D 指挥地图为主，三维仅对重点工位启用 L2/L3。

## 7. 三维建模分级（L0—L3）

| 级别 | 名称 | 内容 | 用途 | 精度要求 |
| --- | --- | --- | --- | --- |
| L0 | 二维地图 | 工位/设备/人员/路线/区域状态 | 日常指挥地图、调度 | 平面布局准确 |
| L1 | 2.5D | 楼层/设备高度/摄像头视锥/简单三维 | 设备高度感知、视锥可视化 | 高度近似 |
| L2 | 轻量三维 GLB | CAD 或扫描建立的可交互三维 | 日常调度、方案可视化 | 重点工位误差 ≤10cm |
| L3 | 高写实局部场景 | 点云/摄影测量/Gaussian Splat | 事故复盘、培训、复杂空间分析 | 重点工位误差 ≤10cm |

### 验收要求（三维验收）
- **WHEN** 执行三维验收测试
- **THEN** 重点工位地图误差不超过 10 厘米、场景加载不超过 5 秒、普通办公终端流畅交互、所有地图实体可追溯到原始数据来源。

### 分级使用原则
- L0/L1 为首期默认；L2 仅对需要三维交互的重点工位启用；L3 仅用于事故复盘/培训/复杂空间分析，不用于日常调度；
- 不追求全工厂高写实三维，避免采集与维护成本失控；
- CAD 资料完整时优先由 CAD 生成 L0/L1/L2，资料不完整时才进行现场扫描。

## 8. 数据来源与隔离

- 所有空间实体与资产必须携带 source_type（real / controlled_test / simulated）；
- controlled_test 与 simulated 实体在地图上以不同样式标识，且不作为真机验收依据；
- 静态底图变更须保留旧版本，回放历史班次时使用该班次对应的底图版本，而非最新版本；
- 坐标变换帧注册时若 source_type 非 real，须在帧元数据中显式标记，且不得参与 real 验收的精度统计。

## 9. 实现对齐现状（空间模型 V1）

本节记录 §1—§8 的规范口径与 `src/edge_platform/spatial/` **当前代码实现**之间的对应关系与差异。规范为目标态，代码为现状；两者不一致处在 §9.3 列出，须由架构评审裁定收敛方向后再改代码或改规范，**不得各自默认自己正确**。

### 9.1 模块映射

| 规范章节 | 实现文件 |
| --- | --- |
| §1 空间层级、§2 实体字段 | [`spatial/entities.py`](../../src/edge_platform/spatial/entities.py) |
| §3 坐标与边界框、§4 坐标变换 | [`spatial/coordinate.py`](../../src/edge_platform/spatial/coordinate.py) |
| §6 JSON 拓扑 | [`spatial/topology.py`](../../src/edge_platform/spatial/topology.py) |
| §6 资产格式、§7 三维分级 | [`spatial/asset_registry.py`](../../src/edge_platform/spatial/asset_registry.py) |
| 跨工厂扩展（V2.0 骨架） | [`spatial/multi_factory.py`](../../src/edge_platform/spatial/multi_factory.py) |

### 9.2 代码实际字段契约

以下为**代码中真实存在**的字段，序列化键名与此完全一致。

**`coordinate.Pose`**：`x` / `y` / `z`（米，float，默认 0.0）、`yaw_deg`（度，默认 0.0）、`source`（str，如 `uwb` / `vision` / `imu_fusion` / `cad`）、`confidence`（0—1，默认 1.0）。提供 `to_dict()` / `from_dict()`。

**`coordinate.BoundingBox`**：`min_x` / `min_y` / `max_x` / `max_y`（米，四个均必填）。方法 `contains(pose)`（含边界端点）、`intersects(other)`。

**坐标变换函数**：`world_to_local(pose, origin)`、`local_to_world(pose, origin)`（平移 + 绕 Z 轴 yaw 旋转，互为逆变换）、`distance(a, b)`（XY 平面欧氏距离，**忽略 z**）。`source` 与 `confidence` 在变换中原样传递。

**`entities.SpatialEntity`**：`entity_id`、`entity_type`（`EntityType` 枚举）、`parent_id`（默认 `None`）、`name`、`pose`（可空）、`bbox`（可空）、`status`（默认 `"active"`）、`source_type`（默认 `"real"`）、`confidence`（默认 1.0）、`updated_at`（空值时取 `now_iso()`，UTC 毫秒精度）、`version`（默认 1）。`touch()` 递增 `version` 并刷新 `updated_at`。

**`entities.SpatialRegistry`**：`register`（`parent_id` 非空时校验父级必须已存在，否则抛 `ValueError`，故注册须自顶向下）、`get` / `children` / `ancestors` / `descendants` / `by_type` / `all`。

**`topology`**：`TopologyNode(node_id, label)`；`TopologyEdge(from_id, to_id, distance_m, route_geojson)`。**边按无向处理**；`shortest_path()` 为 Dijkstra，返回 `(distance_m, path)`，不可达返回 `(None, None)`。`to_geojson()` 输出 `FeatureCollection`，**仅带几何的边**输出 `LineString`，`properties` 含 `from_id` / `to_id` / `distance_m`。

**`asset_registry.SpatialAsset`**：`asset_id`、`name`、`asset_type`（`AssetType` 枚举：`GEOJSON` / `GLB` / `TILES_3D` / `POINTCLOUD` / `GAUSSIAN_SPLAT` / `TOPOLOGY_JSON`）、`lod`（`LOD` 枚举 `L0`—`L3`）、`spatial_scope`、`uri`、`version`（**由注册表自动分配**，手工赋值会被覆盖）、`source_type`、`created_at`、`checksum`（`compute_checksum(bytes)` 算 sha256）、`provenance`。`AssetRegistry` 按 `(name, asset_type)` 维护版本历史，`by_scope()` / `by_lod()` 每个键只返回最新版本。

> **实现范围说明**：平台**不生成也不解析** GLB / 3D Tiles / 点云 / Gaussian Splat 二进制，仅通过 `uri` 引用外部文件并记录版本与校验和；这些资产由离线建模流程产出。
>
> **GeoJSON 坐标系**：`to_geojson()` 输出的是**工厂局部米制 XY**，非 WGS84 经纬度。RFC 7946 默认 CRS 为 WGS84，本系统输出属自定义局部 CRS，前端须按局部坐标渲染，不得直接叠加经纬度底图。

### 9.3 规范与实现的差异清单（待收敛）

| # | 项 | 规范（§1—§8） | 代码现状 | 说明 |
| --- | --- | --- | --- | --- |
| 1 | `entity_type` 取值 | 小写 `group`…`worker`/`task` | 大写 `GROUP`…**`PERSON`**/`TASK` | 大小写与 worker/PERSON 命名须统一，涉及接口契约 |
| 2 | `yaw_deg` 基准 | 0 = 朝向 **+X**，**逆时针**为正 | 0 = 面朝**正北 +Y**，自北**顺时针** | **口径相反，风险最高**，须优先裁定并加回归测试 |
| 3 | `pose.frame` | 必填，跨帧变换依据 | **不存在**；`Pose` 有 `source` / `confidence` | 多坐标帧未实现，当前只支持单一工厂帧 |
| 4 | `bbox` | `{min:{x,y,z}, max:{x,y,z}, crs}` 三维 | `min_x/min_y/max_x/max_y` **二维 AABB**，无 z、无 crs | 高度维缺失，视锥/货架高度类需求受限 |
| 5 | 坐标变换 API | `transform` / `register_frame` / `list_frames` / `get_frame_chain`，帧邻接表 + `residual` | 仅 `world_to_local` / `local_to_world` / `distance`，**无帧注册表、无 residual** | 帧图与残差回传未实现，感知融合置信度暂无残差输入 |
| 6 | 集团层 `parent_id` | 空字符串 `""` | `None` | 序列化差异，须统一 |
| 7 | `status` 枚举 | `active/idle/fault/offline/maintenance/blocked` | 默认 `"active"`，**代码不做枚举校验** | 建议补校验，防脏值入库 |
| 8 | `entity_id` 格式 | `{type}-{uuid8}`，如 `station-3a2b1c0d` | `new_id(prefix)` → `STN-a1b2c3d4`，前缀由调用方传 | 前缀口径未强制，存在不一致风险 |
| 9 | 资产精度字段 | 须携带「精度（米）」 | `SpatialAsset` **无精度字段** | 三维验收 ≤10cm 指标当前无字段承载 |
| 10 | 资产存储路径 | 对象存储 `{entity_id}/{version}/{asset_type}` | `uri` 为自由字符串，注册表为**内存态** | 未持久化，重启丢失 |
| 11 | 静态/动态分离（§5） | 静态底图版本化 + 动态层高频刷新 | `SpatialRegistry` 单层内存表，**未做静态/动态分离** | 回放历史班次用对应底图版本的能力尚未具备 |

### 9.4 待现场数据补全项

以下内容**当前环境无法完成**，需现场测绘 / CAD / 标定数据到位后填充。字段骨架已就绪，届时只需填数，不需改结构。

| # | 待补项 | 依赖输入 | 影响范围 |
| --- | --- | --- | --- |
| 1 | 各工厂坐标系原点与轴向对齐 | 现场测绘基准点（含高程基准） | §3，全部 `Pose` 绝对值 |
| 2 | 车间/产线/区域/工位边界框实际数值 | 厂区 CAD 图纸 | `bbox` 全部实例 |
| 3 | 空间实体层级实例（真实工位清单） | 产线工艺布局文件 | §1 全部实体数据 |
| 4 | 工位拓扑边与实际行走距离 | 现场路径实测 / CAD 通道中心线 | `distance_m`、`route_geojson` |
| 5 | UWB 基站坐标与标定参数 | 基站安装测量 + 标定报告 | 定位精度、`Pose.confidence` |
| 6 | 摄像头外参（安装位姿）与视锥几何 | 相机标定（见 [camera_calibration.md](camera_calibration.md)） | 视觉结果 → 工厂坐标系转换 |
| 7 | L2/L3 三维资产文件 | 三维扫描 / CAD 导出 | `uri`、`checksum`、`provenance` |
| 8 | 重点工位 ≤10cm 精度验收实测 | 现场验收测试 | §7 三维验收要求 |

> 拓扑距离 `distance_m` 是**行走路径长度**，与 `coordinate.distance()` 的直线距离不同；调度计算必须使用前者。
>
> **当前仓库中的空间数据均为 `simulated` / `controlled_test`，不得作为真机验收依据。**

## 10. 关联文档

- [docs/architecture/embodied_factory.md](../architecture/embodied_factory.md) — 九层架构（第 4 节空间数字底座）
- [docs/data/multimodal_schema.md](../data/multimodal_schema.md) — 多模态数据 schema V1（含 UWB/视觉字段）
- [delivery/03_数据与算法/data_dictionary.csv](../../delivery/03_数据与算法/data_dictionary.csv) — 数据字典
- [delivery/02_技术规范/database.sql](../../delivery/02_技术规范/database.sql) — 数据库表结构（空间实体/拓扑表）
