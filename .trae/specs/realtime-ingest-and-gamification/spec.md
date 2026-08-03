# 真机数据直连 + 游戏化体验 + 飞书闭环 Spec

> 创建于 2026-08-01。承接 `deepen-embodied-factory-os`，聚焦用户提出的五个核心问题：
> 1. 外骨骼+传感器数据能否直接用？
> 2. 具体操作流程是怎样的？
> 3. 现在的模拟数据有吗？
> 4. 能否像玩游戏一样直观高效做工厂管理？
> 5. 还需要做到哪些事？

---

## 1. 现状基线（一句话定位）

`ewoh-spark-app` 是一个**模拟器驱动的、可演示的、构建产物就绪**的 NestJS + React 指挥地图应用；真实设备协议适配能力存在于 `src/edge_platform` Python 子工程中且达到真机就绪级别，但**两套系统没有任何数据通路连接**，spark-app 的 schema 也未承接真机字段，现场交付所需的 CAD 导入、摄像头标定、协议对接桥接均仅有文档与占位骨架。

### 1.1 已具备的能力

| 能力 | 实现位置 | 状态 |
| --- | --- | --- |
| 模拟数据生成 | [simulator.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/simulator/simulator.service.ts) | 每 4s 遥测 + 10s 环境 + 概率异常注入，活数据 |
| 11 张表 schema | [schema.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/database/schema.ts) | 设备/遥测/事件/空间/调度/模型治理覆盖完整 |
| 9 模式指挥地图 | [CommandMap](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx) | 生产/人员/外骨骼/负荷/安全/设备/环境/调度/数据质量 |
| L0/L1 层级 + 摄像头视锥/UWB 覆盖 | [FactoryMap.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx) | L1 渲染视锥三角形 + 覆盖圈 |
| 时间轴回放 | [TimelinePanel.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/panels/TimelinePanel.tsx) | 1/2/5x 倍速、暂停、点击选时刻 |
| 实体选中 + 脉动光环 | FactoryMap.tsx | 点击高亮 + animate 光环 + 详情面板 |
| 事件中心 + 调度审批 + 班组长工作台 | panels/*.tsx | 筛选/确认理由/4 卡片工作台 |
| NY-EXO-A1 真机适配器 | [adapter.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/adapters/ny_exo_a1/adapter.py) | 643 行，CRC/丢包/重连/统一帧，真机就绪 |
| 统一语义帧 UnifiedExoFrame | [exo_semantic.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/exo_semantic.py) | 四级数据分组 + 标准消息扩展字段 |
| 构建产物 | dist/ | 与源码同步，可 `npm run build` |

### 1.2 核心缺口

| 缺口 | 影响 |
| --- | --- |
| spark-app 无真机接入接口（无 HTTP/MQTT/WS 接收端点） | 真机数据进不来 |
| `ewoh_telemetry` 仅 3 个运动字段，缺 `joint_angles_deg/gyro_norm_dps/assist_level/torque_nm` 等 | UnifiedExoFrame 字段无处落库 |
| `ewoh_device/telemetry/event` 三表无 `source_type` 列 | 无法区分真实/受控测试/模拟数据 |
| 缺 `record_id/ingested_at/raw_ref` 标准消息扩展字段 | 无法双向追溯原始帧 |
| Python adapter 与 NestJS 零集成 | 两套系统割裂 |
| 地图不能平移/缩放、不能拖拽实体、无 L2 三维、无搜索 | 游戏化体验不足 |
| 飞书告警卡片不能跳回指挥地图 | 飞书闭环断裂 |
| CAD 导入、摄像头标定仅有文档 | 现场交付受阻 |

---

## 2. 核心目标

将当前"模拟驱动的演示系统"升级为"**工厂即具身机器人**"：皮肤（传感器）感知世界、内脏（设备）执行制造、肢体（外骨骼）身体共生、大脑（调度平台）推理决策。真实场景被数据涌现为与现实孪生的"游戏"，玩家在游戏中做生产调度，虚拟与现实双向同步。兑现五个闭环：看得见、看得懂、能预测、能建议、能学习。

### 2.1 用户五问的对应方案

| 用户问题 | 对应方案 | 本 spec 章节 |
| --- | --- | --- |
| 真机数据能直接用吗？ | 不能，需建 Ingestion 桥接 + schema 扩展 | §3 |
| 具体操作流程？ | 边缘适配器 → Ingestion API → 字段映射 → 落库 → 规则引擎 → 告警 | §3.3 |
| 模拟数据有吗？ | 有，SimulatorService 每 4s/10s 生成活数据，可现场演示 | §1.1（已具备） |
| 能像玩游戏一样管理？ | 工厂即具身机器人范式：数据涌现为孪生游戏场景，玩家执行资源分配/任务编排/实时决策/事件响应/学习进化五玩法 | §4 |
| 还需要做哪些事？ | 真机直连(皮肤/内脏) + 场景直接建模(孪生) + 游戏玩法(大脑) + 外骨骼终端(肢体) + 飞书闭环 五线并进 | §3-§6 |

---

## 3. 真机数据直连方案

### 3.1 设计原则

1. **source_type 三态隔离**：`real`（真机）/ `controlled_test`（受控测试）/ `simulated`（模拟）三态在 schema、API、前端全链路贯通，模拟数据与真机数据可并存、可过滤、可对比。
2. **厂商字段不泄漏**：边缘适配器产出 `UnifiedExoFrame` 统一帧后，厂商私有字段不进入 spark-app；spark-app 只认统一帧。
3. **标准消息扩展**：每条记录带 `record_id`（全局唯一）/ `ingested_at`（平台接收时刻）/ `raw_ref`（原始帧 SHA256），支持双向追溯。
4. **数据质量分级**：`quality.status` 统一为 `good/degraded/invalid/unknown`，前端 `data_quality` 模式直接着色。
5. **向后兼容**：模拟器继续运行，schema 扩展采用 `ALTER TABLE ADD COLUMN ... DEFAULT`，不破坏现有数据。

### 3.2 Schema 扩展（必须先做）

对 `ewoh_device` / `ewoh_telemetry` / `ewoh_event` / `ewoh_environment` 四表增加字段，承接 `UnifiedExoFrame`：

#### ewoh_telemetry 扩展（核心）

```sql
ALTER TABLE ewoh_telemetry
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS record_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS ingested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS raw_ref VARCHAR(64),
  ADD COLUMN IF NOT EXISTS joint_angles JSONB,        -- {"left_knee": 45.0, ...}
  ADD COLUMN IF NOT EXISTS angular_velocity_dps REAL, -- 角速度
  ADD COLUMN IF NOT EXISTS assist_level REAL,         -- 助力水平 0-1
  ADD COLUMN IF NOT EXISTS torque_nm REAL,            -- 力矩 N·m
  ADD COLUMN IF NOT EXISTS cumulative_load_score REAL,-- 累计负荷指标
  ADD COLUMN IF NOT EXISTS temperature_c REAL,        -- 设备温度
  ADD COLUMN IF NOT EXISTS fault_code VARCHAR(50),    -- 故障码
  ADD COLUMN IF NOT EXISTS packet_loss_pct REAL,      -- 丢包率
  ADD COLUMN IF NOT EXISTS data_confidence REAL,      -- 数据置信度
  ADD COLUMN IF NOT EXISTS data_quality VARCHAR(20) DEFAULT 'good'; -- good/degraded/invalid/unknown
```

#### ewoh_device 扩展

```sql
ALTER TABLE ewoh_device
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS firmware_version VARCHAR(50),
  ADD COLUMN IF NOT EXISTS hardware_version VARCHAR(50),
  ADD COLUMN IF NOT EXISTS protocol_version VARCHAR(50),
  ADD COLUMN IF NOT EXISTS temperature_c REAL,
  ADD COLUMN IF NOT EXISTS fault_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS last_raw_ref VARCHAR(64);
```

#### ewoh_event 扩展

```sql
ALTER TABLE ewoh_event
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS trigger_record_id VARCHAR(64), -- 触发该事件的遥测记录 ID
  ADD COLUMN IF NOT EXISTS evidence_json JSONB;           -- 证据快照（遥测+环境+上下文）
```

#### ewoh_environment 扩展

```sql
ALTER TABLE ewoh_environment
  ADD COLUMN IF NOT EXISTS source_type VARCHAR(50) DEFAULT 'simulated',
  ADD COLUMN IF NOT EXISTS record_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS data_confidence REAL;
```

#### 索引

```sql
CREATE INDEX IF NOT EXISTS idx_telemetry_source ON ewoh_telemetry(source_type, ts DESC);
CREATE INDEX IF NOT EXISTS idx_telemetry_record ON ewoh_telemetry(record_id) WHERE record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_source ON ewoh_event(source_type, created_at DESC);
```

### 3.3 Ingestion 服务（新建模块）

新建 `server/modules/ingest/` 模块，提供真机数据接入网关：

#### 3.3.1 HTTP 接收端点（V1，最小可用）

```
POST /api/ingest/exoskeleton   — 接收单个 UnifiedExoFrame
POST /api/ingest/exoskeleton/batch — 批量接收（≤100 条/请求）
POST /api/ingest/environment   — 接收环境传感器数据
POST /api/ingest/camera        — 接收摄像头结构化检测结果
POST /api/ingest/mes           — 接收 MES 工单事件
```

请求体为 `UnifiedExoFrame` 的 `to_storage_dict()` 序列化格式（见 [exo_semantic.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/exo_semantic.py) 第 13-30 行示例）。

**字段映射规则**（UnifiedExoFrame → ewoh_telemetry）：

| UnifiedExoFrame 路径 | ewoh_telemetry 列 | 说明 |
| --- | --- | --- |
| `entity_id` | `device_id` | 设备 ID |
| `event_time` | `ts` | 设备产生时刻 |
| `ingested_at` | `ingested_at` | 平台接收时刻 |
| `record_id` | `record_id` | 全局唯一记录 ID |
| `raw_ref` | `raw_ref` | 原始帧 SHA256 |
| `source_type` | `source_type` | real/controlled_test/simulated |
| `pose.trunk_pitch_deg` | `pitch_deg` | 躯干倾角 |
| `pose.angular_velocity_dps` | `angular_velocity_dps` | 角速度 |
| `pose.joint_angles_deg` | `joint_angles` | 关节角 JSONB |
| `load.assist_level` | `assist_level` | 助力水平 |
| `load.torque_nm` | `torque_nm` | 力矩 |
| `load.cumulative_load_score` | `load_score` + `cumulative_load_score` | 负荷指标双写 |
| `device.battery_pct` | `battery_pct` | 电量 |
| `device.temperature_c` | `temperature_c` | 设备温度 |
| `device.fault_code` | `fault_code` | 故障码 |
| `quality.packet_loss_pct` | `packet_loss_pct` | 丢包率 |
| `quality.confidence` | `data_confidence` | 置信度 |
| `quality.status` | `data_quality` | good/degraded/invalid/unknown |
| `worker_id` | （关联 ewoh_device.worker_name） | 通过 device_id 反查 |

#### 3.3.2 数据质量校验

Ingestion 服务在写入前校验：
- `entity_id` 非空且在 `ewoh_spatial_entity` 中存在（否则拒绝 + 告警）
- `event_time` 不能超前当前时间 +5 分钟（时钟漂移保护）
- `battery_pct` 范围 0-100，超界标记 `data_quality='invalid'`
- `packet_loss_pct > 5` 时自动标记 `data_quality='degraded'`
- `raw_ref` 重复（同 SHA256）时跳过（幂等去重）

#### 3.3.3 规则引擎触发

Ingestion 写入遥测后，同步触发规则引擎（复用 SimulatorService 的事件触发逻辑，抽出为 `RuleEngineService`）：
- 低电量：`battery_pct < 20` → `LOW_BATTERY` 事件
- 高负荷：`load_score > 0.8` → `HIGH_LOAD` 事件
- 异常姿态：`pitch_deg > 45` → `POSTURE_RISK` 事件（新增）
- 设备失联：`ingested_at - event_time > 10s` → `DEVICE_OFFLINE` 事件
- 数据质量退化：`data_quality='degraded'` 持续 3 条 → `DATA_DEGRADED` 事件（新增）

事件写入 `ewoh_event`，`source_type` 继承自触发它的遥测记录，`trigger_record_id` 记录触发帧，`evidence_json` 保存触发时刻的上下文快照。

### 3.4 模拟器适配（向后兼容）

修改 `SimulatorService`：
- 写入 `ewoh_telemetry` 时补充 `source_type='simulated'`、生成 `record_id`、`data_quality='good'`
- 事件触发逻辑迁移到 `RuleEngineService`，Simulator 调用 `RuleEngineService.evaluate(telemetryRow)`
- 模拟器与真机数据可在同一张表共存，前端通过 `source_type` 过滤

### 3.5 边缘侧桥接脚本

新建 `scripts/edge_to_spark.py`（Python，放在 `src/edge_platform/`），将 Python 适配器产出推送到 spark-app Ingestion API：

```python
# 伪代码
from edge_platform.edge.adapters.ny_exo_a1.adapter import NyExoA1Adapter
from edge_platform.edge.exo_semantic import to_storage_dict
import requests

adapter = NyExoA1Adapter(config)
adapter.start()
while True:
    frame = adapter.read_message()  # UnifiedExoFrame
    if frame:
        resp = requests.post(
            "http://spark-app-host:3000/api/ingest/exoskeleton",
            json=to_storage_dict(frame),
            timeout=5
        )
```

支持：断线重连、批量缓冲（断网时本地队列，恢复后批量补传）、`source_type` 透传。

---

## 4. 工厂即具身机器人：数据涌现游戏与具身智能范式

### 4.1 核心范式：工厂 = 具身机器人

将"具身智能"概念注入工厂，让工厂本身成为一台具身机器人。工厂每一层结构都拥有明确映射关系：

| 身体部位 | 工厂对应 | 职能 | 系统落点 |
| --- | --- | --- | --- |
| **皮肤** | 传感器/检测设备 | 感知温度、压力、振动、位移等一切物理世界信息 | 边缘适配器 + Ingestion + ewoh_telemetry/environment |
| **内脏** | 生产设备/执行机构 | 承担制造核心机能 | ewoh_spatial_entity(device) + MES 接入 + 调度下发 |
| **肢体** | 外骨骼 | 人-工厂实时信息交互纽带，能力增强器+安全守护者，下一代终端形态 | 外骨骼适配器 + 触觉/语音/AR 反馈通道 |
| **大脑** | 人员调度平台 | 汇聚海量传感器数据，因数据持续涌现而进化为具备推理决策能力的本地化大模型，自主调整、自我迭代、自我感知 | SchedulerModule + RuleEngineService + AI 推理层 |

**外骨骼的关键角色**：它不仅是数据采集设备，更是工厂与人之间的"身体共生"接口——让连接从"手持屏幕"进化为"身体共生"。它是当下手机终端的下一代形态，是"工厂游戏"的玩家手柄。

**数据是基石**：成千上万传感器持续运转，积累海量、高维、与真实物理场景深度耦合的数据资产。数据涌现是迈向智能涌现的关键一步。

### 4.2 数据涌现：从数据到游戏场景

"游戏化"不是表层 UI 交互，而是：**真实场景在系统里被数据涌现为"游戏"，接入 AI 后游戏场景实时、动态且与现实世界孪生**。

涌现路径：
```
传感器持续运转（皮肤）
  → 海量高维数据流入（Ingestion + ewoh_telemetry/world_state）
  → 时空世界模型实时构建（数据涌现为孪生场景）
  → 游戏化可交互场景（玩家在孪生场景中执行生产调度玩法）
  → AI 辅助决策（大脑从数据涌现进化为智能涌现）
  → 决策下发执行层（内脏/肢体执行，虚拟→现实同步）
```

### 4.3 场景直接建模（多源融合重建，孪生场景的几何与纹理基础）

**设计转变**：不再依赖 CAD → GLB 传统导入，而是用已有的摄像头/AI/传感器能力对真实工厂**直接建模**。既然基础设计已具备，直接建模才是"看得见"闭环的正确兑现方式。

#### 4.3.1 多源融合建模技术栈

| 技术 | 作用 | 精度 | 产出物 |
| --- | --- | --- | --- |
| **3D Gaussian Splatting (3DGS)** | 多视角照片重建高写实视觉场景 | cm 级 | `.ply`/`.splat` 高斯点集，可实时渲染 |
| **LiDAR 点云扫描** | 工厂级几何骨架，精确尺寸 | mm 级 | `.las`/`.pcd` 点云，可配准拼接 |
| **UWB 定位** | 人员/设备实时位置（已有基础设计） | 10-30cm | 实时坐标流，驱动动态实体移动 |
| **Wi-Fi RSSI 指纹定位** | 备选/补盲定位 | 1-3m | 位置概率热力图 |
| **毫米波雷达** | 存在检测/微动检测 | 30cm | 占据栅格，禁区/在岗检测 |
| **视觉 SLAM** | 移动设备建图 + 定位 | cm 级 | 关键帧 + 位姿图 |
| **摄像头 + AI 检测** | 人员骨架/动作/在岗（已有基础设计） | 像素级 | bbox + 骨架关键点 |

#### 4.3.2 分层建模策略（兑现 L0/L1/L2/L3 架构）

- **L0 2D 俯视图**（已有）：SVG 平面图，基于空间实体 bbox
- **L1 2.5D**（已有）：摄像头视锥 + UWB 覆盖圈叠加
- **L2 轻量三维**（本期新建）：**3DGS 全景 + 点云几何骨架**融合
  - 用 3D Gaussian Splatting 重建工厂全景（拍摄几百张照片离线训练 splat）
  - 点云提供精确几何边界（碰撞/尺寸校验）
  - 动态实体（人员/设备）用 UWB 实时坐标驱动
  - 三者统一到工厂坐标系（见 [coordinate_system.md](file:///Volumes/Extra/CodeProj/EWOH/docs/spatial/coordinate_system.md)）
- **L3 高写实局部**（重点工位事故复盘）：高密度 3DGS + RGB-D 细化

#### 4.3.3 L2 渲染实现

引入 `@react-three/fiber` + `@react-three/drei` + `three`：
- L2 模式下隐藏 SVG，显示 Three.js Canvas
- **静态场景层**：用 `@sparkjsdev/spark-three` 或自实现 GaussianSplat 加载器渲染 `.splat`/`.ply`（先占位用简单盒子，后接实拍 splat）
- **几何骨架层**：点云用 `Points` + `PointsMaterial` 渲染（可选叠加，半透明）
- **动态实体层**：
  - 摄像头视锥用 ConeGeometry 半透明渲染（数据来自 ewoh_spatial_entity extra.fov_deg/range）
  - UWB 覆盖用 SphereGeometry 半透明球（extra.coverage_r）
  - 人员位置用 CapsuleGeometry + 实时移动（worldState 每 2s 刷新）
  - 设备在线状态颜色区分（绿在线/灰离线/红故障）
- **交互层**：OrbitControls 鼠标轨道控制 + 射线检测点击实体 → 选中高亮（发光边框）
- L2/L1 切换平滑过渡

#### 4.3.4 时空世界模型融合

直接建模的产出统一落入 `ewoh_spatial_entity` + `ewoh_world_state`：
- `ewoh_spatial_entity.source_type` 扩展取值：`seed` / `lidar_scan` / `gaussian_splat` / `uwb_located` / `visual_slam`
- `ewoh_spatial_entity.extra` 承载建模元信息：`{ splat_url, pointcloud_url, capture_at, scan_device, alignment_error_mm }`
- `ewoh_world_state.state_json` 承载实时定位：`{ locator: 'uwb'|'wifi'|'visual', confidence, x, y, z }`
- 置信度 `confidence` 字段驱动 `data_quality` 模式着色（定位精度高的实体更亮）

#### 4.3.5 建模数据采集管线（边缘侧）

新建 `src/edge_platform/edge/modeling/` 模块：
- `splat_collector.py`：3DGS 采集指引（多视角照片序列拍摄 + Colmap 预处理 + splat 训练任务下发）
- `lidar_collector.py`：LiDAR 扫描数据接收 + 点云配准（ICP）+ 坐标系对齐
- `locator_fusion.py`：UWB + Wi-Fi + 视觉定位融合（扩展卡尔曼滤波或因子图）
- 产出统一推送到 spark-app 的 `POST /api/ingest/spatial-scan`（新增接口）

### 4.4 游戏层级体系

游戏场景由四层叠加涌现，每层对应不同的玩家视野与玩法深度：

| 层级 | 名称 | 数据来源 | 玩家视野 | 玩法 |
| --- | --- | --- | --- | --- |
| **L0 渲染层** | 2D 俯视战略图 | ewoh_spatial_entity bbox | 厂长/车间主任全局 | 产能规划、资源调配 |
| **L1 渲染层** | 2.5D 战术图 | + 摄像头视锥/UWB 覆盖 | 车间主任/班组长 | 实时调度、负荷均衡 |
| **L2 渲染层** | 3D 孪生操作图 | + 3DGS/点云直接建模 | 班组长/操作员 | 沉浸式巡检、事件处置 |
| **L3 渲染层** | 高写实复盘图 | + 高密度 3DGS/RGB-D | 安全/培训 | 事故复盘、培训演练 |
| **L-玩法层** | 游戏机制层 | 全量数据 + AI 推理 | 所有玩家 | 资源分配、任务编排、实时决策、学习进化 |

L-玩法层是新增的核心层，它不渲染场景，而是定义玩家如何在 L0-L3 场景中"玩"——把工厂管理变成有规则、有反馈、有进化的游戏。

### 4.5 玩家角色与核心玩法机制

#### 4.5.1 玩家角色（三档）

| 角色 | 定位 | 玩法层次 | 核心玩法 |
| --- | --- | --- | --- |
| **班组长**（战术玩家） | 当班实时调度 | L1/L2 | 事件响应、人员调配、节拍调整 |
| **车间主任**（战役玩家） | 多班次排产 | L0/L1 | 排产优化、负荷均衡、瓶颈突破 |
| **厂长**（战略玩家） | 产能规划 | L0 | 资源调配、产线规划、KPI 对齐 |

玩家通过飞书工作台进入指挥地图，角色权限决定可见层级行与可执行操作。

#### 4.5.2 核心玩法机制（五项）

1. **资源分配**：人员/设备/工位三维资源池，玩家拖拽分配（L0/L1 地图上直接操作），AI 评估分配合理性
2. **任务编排**：工单分解为工序，工序编排到工位/人员，节拍可视化（甘特/网络图），玩家可调整顺序与分配
3. **实时决策支持**：大脑（AI）基于实时数据涌现生成调度建议方案（proposed），玩家确认/调整后下发（confirmed → 执行），形成"建议-决策-执行-反馈"闭环
4. **事件响应**：异常事件触发 → 即时告警弹窗 → 玩家处置 → 闭环回写 → 大脑学习
5. **学习进化**：历史调度数据 + 结果反馈训练大脑，建议方案质量持续提升（数据涌现 → 智能涌现）

### 4.6 生产调度玩法（资源分配 / 任务编排 / 实时决策）

#### 4.6.1 资源分配玩法

- 资源池视图：人员/设备/工位三维资源卡片，显示当前负荷/电量/状态
- 玩家在 L0/L1 地图上拖拽资源到工位（复用 @dnd-kit）
- AI 实时评估：负荷均衡度、技能匹配度、电量续航，给出红/黄/绿评分
- 分配结果写入 ewoh_schedule_plan（strategy='resource_alloc'）+ ewoh_spatial_entity 关联更新

#### 4.6.2 任务编排玩法

- 工单视图：MES 工单接入（/api/ingest/mes）→ 自动分解为工序
- 工序编排画布：拖拽工序节点，连线表示先后依赖，分配到工位/人员
- 节拍模拟：编排后 AI 模拟产线节拍，预测瓶颈工位与完成时间
- 编排结果写入 ewoh_schedule_plan（strategy='task_orchest'）+ metrics_json 含节拍/瓶颈/完成时间

#### 4.6.3 实时决策支持

- 大脑基于实时 world_state + telemetry 涌现生成调度建议（已有 SchedulerService.generatePlans）
- 建议方案在 SchedulePanel 展示，含节拍提升/负荷/产量指标
- 玩家确认/拒绝/调整，确认后状态下发执行层
- 执行结果回流，更新方案 status + metrics，喂给大脑学习

### 4.7 虚拟-现实双向同步映射

游戏场景与现实生产场景必须双向同步：

| 方向 | 机制 | 数据通路 |
| --- | --- | --- |
| **现实→虚拟** | 传感器数据实时涌现到孪生场景 | 皮肤(传感器)→Ingestion→ewoh_telemetry/world_state→地图实时刷新(2s) |
| **虚拟→现实** | 玩家决策下发执行层 | 玩家确认方案→ewoh_schedule_plan(confirmed)→调度下发→MES/设备/外骨骼 |

**同步保障**：
- 现实→虚拟：2 秒 refetchInterval + 事件触发即时推送，确保孪生场景延迟 < 5s
- 虚拟→现实：决策下发带时间戳与版本号，执行层回传执行确认，形成闭环审计（ewoh_schedule_audit）
- 冲突处理：当现实数据与虚拟决策冲突（如人员已离线但方案仍分配），大脑自动标记冲突并提示玩家

### 4.8 外骨骼：下一代终端（身体共生）

外骨骼从"数据采集设备"升级为"人-工厂身体共生接口"，它是"工厂游戏"的玩家手柄：

| 通道 | 方向 | 能力 | 实现 |
| --- | --- | --- | --- |
| 数据上行 | 人→工厂 | 姿态/负荷/位置/动作实时上报 | UnifiedExoFrame → Ingestion |
| 触觉反馈 | 工厂→人 | 负荷过高震动告警、禁区进入阻止、节拍提醒 | 外骨骼下发触觉指令（需厂商协议支持） |
| 语音交互 | 双向 | 语音指令（"申请换电""报告异常"）+ 语音播报告警 | 飞书语音 + 外骨骼扬声器 |
| AR 投影 | 工厂→人 | 工位指引、工序提示、安全警示叠加到视野 | AR 眼镜/外骨骼 HUD（远期） |
| 状态共生 | 双向 | 外骨骼即玩家状态机，在线=玩家在线，负荷=玩家负荷 | ewoh_device + ewoh_world_state 实时映射 |

外骨骼适配器需扩展下行通道（当前 codec.py 仅上行，安全红线禁止下行控制命令——但触觉/语音/AR 提示属信息层非控制层，可放开）。

### 4.9 大脑：本地化大模型推理决策

人员调度平台因数据持续涌现而进化为大脑：

- **感知层**：汇聚 skin(传感器) + limb(外骨骼) 全量实时数据
- **记忆层**：历史 telemetry/event/schedule 数据沉淀，形成工厂记忆
- **推理层**：基于实时数据 + 历史记忆，生成调度建议、风险预测、瓶颈分析
- **决策层**：proposed 方案 → 玩家确认 → confirmed → 下发
- **学习层**：决策结果反馈训练模型，建议质量持续提升（数据涌现→智能涌现）

本期实现范围：
- 感知层：Ingestion + RuleEngine（已规划）
- 记忆层：ewoh_telemetry/event/schedule 数据积累（已具备）
- 推理层：SchedulerService.generatePlans 增强（从固定模板→数据驱动建议）
- 决策层：SchedulePanel 确认/拒绝闭环（已具备）
- 学习层：远期，本期记录决策结果供后续训练

### 4.10 地图操控与即时反馈（玩家手柄的桌面端）

桌面端指挥地图是玩家在 L0-L3 场景中的操作台，需支撑玩法机制：

#### 4.10.1 平移与缩放

引入 `react-zoom-pan-pinch`：滚轮缩放（0.5x-5x）、拖拽平移、双击实体居中放大、缩放 <1.5x 隐藏标签、右上角 +/-/重置 控件。

#### 4.10.2 实体拖拽（资源分配玩法的操作方式）

利用 `@dnd-kit/core`：工位/设备/人员可拖拽（admin 模式），拖拽时显示对齐网格（10px），拖拽结束 `PATCH /api/spatial/entities/:id` 更新 x/y + toast 确认 + 5 秒撤销。资源分配玩法（§4.6.1）直接复用此拖拽。

#### 4.10.3 实体搜索与快捷键

搜索框：输入 entity_id/名称 → 高亮+居中。快捷键：1-9 切模式、L 切层级、T 切回放、空格暂停、Esc 取消选中、F 全屏、`?` 提示。

#### 4.10.4 实时告警弹窗（事件响应玩法的即时反馈）

L3 事件触发时右上角弹红色告警卡片（标题/实体ID/时间/查看详情/快速处置），5 秒收起到告警铃铛（带未读 badge），地图对应实体闪烁箭头指示。

#### 4.10.5 数据流可视化（生产玩法的状态呈现）

production 模式下：工位间流动虚线（物料流向 animate）、产线节拍颜色脉冲（绿快/黄中/红慢）、在制品数量数字气泡。

---

## 5. 飞书闭环增强

### 5.1 告警卡片跳转指挥地图

当前飞书 IM 告警卡片只能跳仪表盘，需增加「查看指挥地图」按钮：
- 卡片按钮 `action` 带 `event_id` 参数
- 跳转 URL: `https://xqjyctsd.aiforce.cloud/app/app_17b7bgq1e4a?event_id=xxx`
- 指挥地图加载时读取 `event_id` query param，自动选中对应实体 + 滚动到事件时刻

### 5.2 处置闭环回写

飞书审批/卡片按钮回调 → spark-app `POST /api/events/:id/handle`：
- 接收 `handler_action` / `handler_note`
- 更新 `ewoh_event.status='handled'`、`handler_action`、`handled_at`
- 同步回飞书多维表格（若已配置 Base 同步）

### 5.3 飞书工作台应用入口

确保妙搭应用在飞书工作台可搜索"EWOH"打开，带自动登录。

---

## 6. 场景直接建模交付（多源融合，分阶段实现）

**设计转变**：不再走 CAD → GLB 传统导入，而是用摄像头/AI/传感器/雷达/UWB/Wi-Fi 等已有基础能力对真实工厂**直接建模**。下表从"占位"升级为"分阶段交付计划"：

### 6.1 本期可实现（代码侧准备）

| 任务 | 产出 | 说明 |
| --- | --- | --- |
| L2 三维渲染骨架 | FactoryMap3D.tsx + Three.js | 支持加载 `.splat`/`.ply`/点云，先占位盒子验证渲染管线 |
| 建模数据接入接口 | `POST /api/ingest/spatial-scan` | 接收扫描产物元信息，写入 ewoh_spatial_entity |
| 定位融合接口 | `POST /api/ingest/location` | 接收 UWB/Wi-Fi/视觉定位坐标流，写 ewoh_world_state |
| source_type 扩展 | schema 注释 | 支持 lidar_scan/gaussian_splat/uwb_located/visual_slam |

### 6.2 现场采集阶段（需实地作业）

| 任务 | 产出 | 依赖 |
| --- | --- | --- |
| 3DGS 全景采集 | 工厂全景 `.splat` 文件 | 多视角照片序列（几百张）+ 离线训练 |
| LiDAR 点云扫描 | 工厂点云 `.pcd`/`.las` | LiDAR 扫描仪 + 多站位配准（ICP） |
| UWB 基站部署 + 标定 | 基站坐标 + 场强地图 | 现场布站 + TDOA 标定 |
| Wi-Fi 指纹采集 | RSSI 指纹库 | 网格化走采 + 指纹训练 |
| 摄像头标定 | 内参 + 工厂坐标系外参 | [camera_calibration.md](file:///Volumes/Extra/CodeProj/EWOH/docs/spatial/camera_calibration.md) 文档已完整 |
| 坐标系统一 | 全局工厂坐标系 | [coordinate_system.md](file:///Volumes/Extra/CodeProj/EWOH/docs/spatial/coordinate_system.md) 已定义 |

### 6.3 融合与上线阶段

| 任务 | 产出 |
| --- | --- |
| 点云 + Splatting 配准 | 几何边界 + 视觉纹理统一坐标系 |
| 动态实体定位融合 | UWB + Wi-Fi + 视觉 EKF 融合，输出实时 (x,y,z,confidence) |
| L2 实景上线 | 指挥地图 L2 加载真实 splat + 实时人员 |
| 外骨骼实机对接 | Python adapter 现场联调 + edge_to_spark 桥接 |
| 员工授权 | 飞书通讯录 + 权限矩阵 |

---

## 7. 实施原则

1. **schema 先行**：所有真机字段先落库，模拟器与 Ingestion 共用扩展后的 schema。
2. **source_type 贯通**：从 schema 到 API 到前端，三态可过滤、可对比、可切换。
3. **规则引擎复用**：Simulator 和 Ingestion 共用 `RuleEngineService`，避免事件触发逻辑重复。
4. **游戏化渐进**：先平移缩放 + 搜索快捷键（低成本高体验），再 L2 三维（高成本）。
5. **飞书闭环优先**：告警卡片跳转 + 处置回写是用户感知最强的闭环，优先做。
6. **向后兼容**：所有 schema 变更用 `ADD COLUMN ... DEFAULT`，不破坏现有模拟数据。
7. **不偷懒**：每个功能都要完整实现，不留 stub，不放过边角。

---

## 8. 验收标准

### 8.1 真机数据直连

- [ ] `ewoh_telemetry` 等 4 表完成 schema 扩展，含 `source_type` 等字段
- [ ] `POST /api/ingest/exoskeleton` 可接收 `UnifiedExoFrame` 格式并正确落库
- [ ] 数据质量校验生效（超界/重复/漂移被正确标记或拒绝）
- [ ] Ingestion 写入后触发规则引擎，事件含 `trigger_record_id` + `evidence_json`
- [ ] 模拟器写入的数据 `source_type='simulated'`，与真机数据可共存
- [ ] `edge_to_spark.py` 桥接脚本可从 Python adapter 推送到 spark-app

### 8.2 工厂即具身机器人 + 场景直接建模 + 游戏玩法

**场景直接建模（孪生）**
- [ ] L2 三维模式可渲染 Three.js Canvas + OrbitControls + 实体选中
- [ ] L2 静态场景层支持加载 `.splat`/`.ply`（占位盒子先验证渲染管线）
- [ ] L2 动态实体层人员/设备由 worldState 实时驱动移动
- [ ] `POST /api/ingest/spatial-scan` 接收扫描产物元信息写入 ewoh_spatial_entity
- [ ] `POST /api/ingest/location` 接收定位坐标流写入 ewoh_world_state
- [ ] ewoh_spatial_entity.source_type 支持 lidar_scan/gaussian_splat/uwb_located/visual_slam

**玩家手柄（桌面端操控）**
- [ ] 地图支持滚轮缩放（0.5x-5x）+ 拖拽平移
- [ ] 实体可拖拽调整位置（admin 权限）+ 位置持久化
- [ ] 搜索框可按 entity_id / 名称搜索并居中高亮
- [ ] 快捷键 1-9/L/T/空格/Esc/F/? 生效

**游戏玩法机制**
- [ ] 班组长/车间主任/厂长三角色权限区分可见层级与可执行操作
- [ ] 资源分配玩法：可拖拽人员/设备到工位 + AI 红/黄/绿评分 + 写入 ewoh_schedule_plan(strategy='resource_alloc')
- [ ] 任务编排玩法：MES 工单接入 + 工序编排画布 + 节拍模拟预测瓶颈
- [ ] 实时决策玩法：大脑生成 proposed 方案 + 玩家确认/拒绝 + 下发执行 + 结果回流
- [ ] 事件响应玩法：L3 事件触发右上角弹告警卡片 + 实体闪烁箭头 + 处置闭环
- [ ] 学习进化：决策结果记录到 ewoh_schedule_audit 供后续训练

**虚拟-现实双向同步**
- [ ] 现实→虚拟：传感器数据到孪生场景延迟 < 5s
- [ ] 虚拟→现实：确认方案下发执行层 + 执行确认回传 + 闭环审计
- [ ] 冲突处理：人员离线但方案仍分配时大脑标记冲突并提示

**外骨骼身体共生（肢体）**
- [ ] 数据上行通道：UnifiedExoFrame → Ingestion 正常
- [ ] 触觉反馈通道：外骨骼可接收触觉指令（负荷过高/禁区/节拍）
- [ ] 语音交互通道：语音指令 + 语音播报
- [ ] 状态共生：外骨骼在线=玩家在线，负荷=玩家负荷实时映射

**大脑推理决策**
- [ ] 感知层：Ingestion + RuleEngine 汇聚全量实时数据
- [ ] 记忆层：telemetry/event/schedule 数据持续积累
- [ ] 推理层：SchedulerService.generatePlans 从固定模板升级为数据驱动建议
- [ ] 决策层：proposed→confirmed→执行→结果回流闭环

**production 模式数据流可视化**
- [ ] 工位间有流动虚线物料流向
- [ ] 产线节拍颜色脉冲（绿快/黄中/红慢）
- [ ] 在制品数量数字气泡

### 8.3 飞书闭环

- [ ] IM 告警卡片含「查看指挥地图」按钮，跳转带 `event_id`
- [ ] 指挥地图读 `event_id` query param 自动选中实体 + 滚动到事件时刻
- [ ] `POST /api/events/:id/handle` 处置回写 + 状态更新
- [ ] 飞书工作台可搜索"EWOH"打开应用

---

## 9. 技术栈新增依赖

| 依赖 | 用途 | 安装位置 |
| --- | --- | --- |
| `react-zoom-pan-pinch` | 地图平移缩放 | client |
| `@react-three/fiber` + `@react-three/drei` | L2 三维渲染 | client |
| `three` | Three.js 核心 | client |
| `@dnd-kit/core`（已装） | 实体拖拽 | client（启用） |

后端无新增依赖（NestJS 原生 HTTP 即可承接 Ingestion）。
