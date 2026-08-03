# Spec：具身智能工厂操作系统 — 数据直用 · 直接建模 · 游戏化指挥

> 本文档回答用户三个核心问题，并将每个概念映射到当前已落地的代码实现。
> - Q1：外骨骼+传感器数据能否直接用？操作流程？模拟数据？能否像玩游戏一样管理工厂？还需做什么？
> - Q2：为什么不能直接用高斯泼溅（3DGS）、雷达探知（LiDAR）、Wi-Fi 定位进行场景直接建模？
> - Q3：游戏化层级体系、玩家交互、核心玩法、生产调度、虚拟-现实双向同步；工厂即具身机器人范式。

---

## 一、Q1：数据直用 / 操作流程 / 模拟数据 / 游戏化管理 / 待办

### 1.1 外骨骼+传感器数据能否直接用？——能，且已落地

**结论：能直接用。** 系统已建成完整的「边缘采集 → 统一语义帧 → Ingestion 网关 → 落库 → 规则引擎 → 看板/指挥地图」链路。真机数据与模拟数据通过 `source_type` 字段（`real` / `controlled_test` / `simulated`）共存且可区分，切换零代码改动。

**关键实现：**
- 统一语义帧 `UnifiedExoFrame`：[edge/exo_semantic.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/exo_semantic.py) 把异构外骨骼原始字节流归一化为姿态/负荷/电量/关节角/温度/故障码等标准字段。
- 真机适配器 `NyExoA1Adapter`：[edge/adapters/ny_exo_a1/adapter.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/adapters/ny_exo_a1/adapter.py) 负责协议解码 → 语义帧。
- Ingestion 网关：[server/modules/ingest/ingest.controller.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/ingest/ingest.controller.ts) 暴露 `POST /api/ingest/exoskeleton[/batch]`、`/environment`、`/camera`、`/mes`、`/spatial-scan`、`/location` 六类端点。
- 数据质量校验：[ingest.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/ingest/ingest.service.ts) 实现 entity 存在性校验、时钟漂移（>+5min→invalid）、电量范围、丢包率>5%→degraded、`raw_ref` SHA256 幂等去重。
- 规则引擎触发：落库后立即调用 [rule-engine.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/rule-engine/rule-engine.service.ts) 评估 5 条核心规则（高负荷/低电量/姿态异常/数据质量/离线），自动生成事件。

### 1.2 具体操作流程（真机接入 5 步）

```
┌─────────────┐   字节流    ┌──────────────┐  UnifiedExoFrame  ┌──────────────┐  HTTP POST  ┌──────────────┐
│ 外骨骼设备  │ ──────────▶ │ NyExoA1Adapter│ ────────────────▶│ edge_to_spark│ ──────────▶ │ Ingestion 网关│
│ (TCP/串口)  │            │ (协议解码)   │                  │  (桥接脚本)  │  X-Ingest-Key│  (/api/ingest)│
└─────────────┘            └──────────────┘                  └──────────────┘             └──────┬───────┘
                                                                                            │
                     ┌──────────────────────────────────────────────────────────────────────┘
                     ▼
            ┌─────────────────┐   规则评估   ┌──────────────┐   30s 轮询   ┌──────────────┐
            │ ewoh_telemetry  │ ──────────▶ │  ewoh_event  │ ───────────▶ │  指挥地图/看板│
            │ ewoh_device     │             │ (告警事件)   │              │  (飞书应用)   │
            └─────────────────┘             └──────────────┘              └──────────────┘
```

**操作步骤：**

1. **配置设备**：编写 `devices/exo001.json`（device_id / model / firmware_version / worker_id / source_type=real）。
2. **启动桥接脚本**（真机模式）：
   ```bash
   python src/edge_platform/edge/bridge/edge_to_spark.py \
       --spark-url http://<spark-app地址>:3000 \
       --ingest-key <INGEST_API_KEY> \
       --device-config devices/exo001.json \
       --source-type real
   ```
   脚本内置断线重连（指数退避≤60s）、批量缓冲（断网本地队列，恢复后≤100条/批补传）。
3. **数据自动落库**：Ingestion 网关完成字段映射 → `ewoh_device` upsert + `ewoh_telemetry` insert。
4. **规则自动触发**：高负荷(>0.8)/低电量(<20%)/姿态异常(>45°)等自动生成 `ewoh_event`。
5. **看板实时呈现**：指挥地图 30s 轮询刷新，告警弹窗（AlertToast）实时推送 L3 事件。

### 1.3 现在的模拟数据有吗？——有，两条路径

| 路径 | 入口 | 说明 |
|------|------|------|
| **应用内模拟器** | `POST /api/simulator/start` | [simulator.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/simulator/simulator.service.ts) 每 4s 生成设备遥测、每 10s 生成环境数据，模拟人员移动、设备离线(2%概率)、事件生成。无需真机即可端到端演示。 |
| **边缘桥接模拟源** | `edge_to_spark.py --source-type simulated` | [edge_to_spark.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/bridge/edge_to_spark.py) 内置 `SimulatedExoSource`，模拟 NY-EXO-A1 腰部助力外骨骼典型遥测（姿态游走/负荷波动/电量衰减/换电），通过真实 HTTP 链路注入，验证 Ingestion 全链路。 |

两条路径产出的数据均标记 `source_type='simulated'`，与真机数据物理隔离、可一键切换。

### 1.4 能否像玩游戏一样直观高效管理工厂？——能，已实现游戏化指挥地图

核心交互页 [CommandMap.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/CommandMap.tsx) 已建成「P社式」指挥地图，支持：
- **7 个 Tab 面板**：时间轴 / 事件中心 / 调度方案 / 班组长工作台 / 资源池 / 任务编排 / 大脑建议。
- **9 种视角模式**（数字键 1-9 切换）：生产/人员/外骨骼/身体负荷/安全风险/设备/环境/调度/数据质量。
- **键盘快捷键**：[useKeyboardShortcuts.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/hooks/useKeyboardShortcuts.ts) 支持 L 切层级、T 回放、F 全屏、/ 搜索、? 帮助。
- **缩放平移搜索**：[FactoryMap.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx) 集成 react-zoom-pan-pinch，[TopBar.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/TopBar.tsx) 实现实体搜索定位。
- **实时告警弹窗**：[AlertToast.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/components/AlertToast.tsx) 推送近 30s L3 事件，支持查看详情/快速处置。
- **飞书闭环**：告警卡片带 `?event_id=xxx` 跳转指挥地图事件中心，处置回写 `POST /api/dashboard/events/:eventId/handle`。

### 1.5 还需要做到哪些事？（按优先级）

| 优先级 | 待办 | 现状 | 说明 |
|--------|------|------|------|
| P0 | **真机现场标定** | 代码就绪，缺现场 | 摄像头内外参标定（[docs/spatial/camera_calibration.md](file:///Volumes/Extra/CodeProj/EWOH/docs/spatial/camera_calibration.md)）、UWB 基站坐标测绘、坐标系对齐。 |
| P0 | **CAD/扫描产物导入** | 网关就绪，缺数据 | 通过 `/api/ingest/spatial-scan` 导入 3DGS/LiDAR 产物，替代当前 seed 静态实体。 |
| P1 | **3DGS 训练管线** | 采集指引就绪，缺 GPU 执行 | [splat_collector.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/modeling/splat_collector.py) 提供采集规划+产物注册框架，实际训练需外部 GPU 节点。 |
| P1 | **L2 3D 孪生渲染** | 骨架占位就绪 | [FactoryMap3D.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap3D.tsx) 已有 GLB 骨架占位，待接入 3DGS splat 渲染。 |
| P2 | **外骨骼下行通道** | API 就绪，缺设备侧 | `POST /api/gamification/exo/:deviceId/feedback` 已实现触觉/语音/AR/状态四类指令下发，待外骨骼固件对接。 |
| P2 | **本地化大模型** | 推理框架就绪 | [assistant/local_llm.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/assistant/local_llm.py) 已就绪，待部署本地推理节点承接大脑决策。 |
| P3 | **技能标签体系** | 默认 0.8 | 资源分配 AI 评估中 `skillMatch` 暂用默认值，待建立工人技能矩阵数据。 |

---

## 二、Q2：直接建模 — 高斯泼溅 / 雷达探知 / Wi-Fi 定位

### 2.1 结论：不是"不能"，而是"已经实现"

用户判断正确——既然已有摄像头、AI、传感器基础设计，**完全应当**用 3DGS / LiDAR / Wi-Fi 定位直接建模，替代传统 CAD 导入。系统已沿此方向落地完整接入网关与边缘采集框架。

### 2.2 多源融合直接建模架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                        场景直接建模（多源融合）                        │
├──────────────┬──────────────────┬──────────────────┬───────────────┤
│  3DGS 高斯泼溅│  LiDAR 点云扫描   │  UWB/Wi-Fi 定位   │  视觉 SLAM    │
│  (视觉高写实) │  (几何骨架)       │  (实时坐标)       │  (移动建图)    │
└──────┬───────┴────────┬─────────┴────────┬─────────┴───────┬───────┘
       │ splat_url       │ pointcloud_url   │ x,y,z           │ pose
       ▼                 ▼                  ▼                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  POST /api/ingest/spatial-scan     │   POST /api/ingest/location      │
│  (upsert ewoh_spatial_entity)      │   (insert ewoh_world_state)      │
└──────────────────────────────────────────────────────────────────────┘
       │                                  │
       ▼                                  ▼
┌────────────────────────┐   ┌────────────────────────┐
│ 静态场景层（L2 3D 骨架） │   │ 动态位置层（实时人员/设备）│
│ source_type=gaussian_  │   │ locator=uwb/wifi/visual│
│   splat / lidar_scan   │   │ confidence 0-1         │
└────────────────────────┘   └────────────────────────┘
```

### 2.3 各技术对应实现

| 技术 | 边缘采集 | 接入网关 | 数据落点 | 作用 |
|------|---------|---------|---------|------|
| **3DGS 高斯泼溅** | [splat_collector.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/modeling/splat_collector.py)：规划拍摄路径(50-200张)→COLMAP SfM→训练 3DGS→上传 `splat_url` | `POST /api/ingest/spatial-scan`（`source_type=gaussian_splat`） | `ewoh_spatial_entity.extra.splat_url` | L2/L3 高写实视觉场景 |
| **LiDAR 点云** | [lidar_collector.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/modeling/lidar_collector.py)：扫描→配准→上传 `pointcloud_url` | `POST /api/ingest/spatial-scan`（`source_type=lidar_scan`） | `ewoh_spatial_entity.extra.pointcloud_url` + `alignment_error_mm` | 精确几何骨架（毫米级） |
| **UWB/Wi-Fi/视觉融合定位** | [locator_fusion.py](file:///Volumes/Extra/CodeProj/EWOH/src/edge_platform/edge/modeling/locator_fusion.py)：多源定位坐标流 | `POST /api/ingest/location`（`locator=uwb/wifi/visual/fusion`） | `ewoh_world_state.stateJson`（x/y/z/confidence） | 实时人员/设备坐标，驱动动态层 |
| **视觉 SLAM** | 移动相机建图 | `POST /api/ingest/spatial-scan`（`source_type=visual_slam`） | `ewoh_spatial_entity` | 移动场景建图与定位 |

### 2.4 为什么过去"看起来像没用"？——静态/动态分离的设计选择

当前看板 L0/L1 用的是 **seed 静态实体**（[ewoh-seed.sql](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/scripts/ewoh-seed.sql)），原因是：
1. **无现场扫描数据**：3DGS 训练需 GPU 节点 + 现场拍摄，LiDAR 需实地扫描，当前处于代码就绪、待现场阶段。
2. **2.5D 优先原则**：spec 明确"L1 2.5D 先行，L2 3D 孪生后续"，保证无扫描数据时也能用俯视 2D 指挥。
3. **静态/动态分离**：静态场景（3DGS/LiDAR 产物，低频更新）与动态位置（UWB/Wi-Fi 实时流，高频更新）分表存储，避免相互干扰。

**接入真实扫描产物后**，只需调用 `/api/ingest/spatial-scan` 即可替换 seed 实体，`source_type` 自动标记来源，L2 3D 渲染层读取 `splat_url` 加载高写实场景。

---

## 三、Q3：游戏化设计 + 工厂即具身机器人范式

### 3.1 核心范式：工厂即具身机器人

```
┌─────────────────────────────────────────────────────────────────────┐
│                        工厂 = 具身机器人                             │
├───────────────┬───────────────┬───────────────┬───────────────────┤
│   皮肤（感知） │  内脏（机能）  │  肢体（交互）  │  大脑（决策）      │
├───────────────┼───────────────┼───────────────┼───────────────────┤
│ 传感器/检测设备│ 生产设备/执行  │ 外骨骼         │ 人员调度平台       │
│ 温度/压力/振动 │ 机构          │ 人-工厂共生    │ 本地化大模型       │
│ 位移/视觉     │ 制造核心机能   │ 下一代终端形态 │ 推理/决策/自迭代   │
└───────┬───────┴───────┬───────┴───────┬───────┴─────────┬─────────┘
        │               │               │                 │
        ▼               ▼               ▼                 ▼
   ewoh_telemetry  ewoh_device    exo_feedback      brain_suggestions
   ewoh_environment ewoh_spatial  (下行通道)         rule_engine
        │               │               │                 │
        └───────────────┴───────┬───────┴─────────────────┘
                                ▼
                    ┌───────────────────────┐
                    │  数据涌现 → 智能涌现    │
                    │  (海量高维数据资产)    │
                    └───────────────────────┘
```

**四层映射关系（已落地）：**

| 层 | 范畴 | 实体 | 实现 |
|----|------|------|------|
| **皮肤** | 感知物理世界 | 传感器/检测设备 | `ewoh_telemetry` + `ewoh_environment` + `ewoh_world_state`（摄像头检测） |
| **内脏** | 制造机能 | 生产设备/执行机构 | `ewoh_spatial_entity`（workstation/device）+ `ewoh_device` |
| **肢体** | 人-工厂交互纽带 | 外骨骼 | `ExoskeletonFrameDto` 上行 + `ExoFeedbackRequest` 下行（触觉/语音/AR/状态四通道） |
| **大脑** | 推理决策 | 人员调度平台 | `getBrainSuggestions()` + `rule-engine` + 本地化 LLM 框架 |

**外骨骼 = 下一代终端形态（身体共生）：**
- 当前手机终端是"手持屏幕"，外骨骼进化为"身体共生"——人与工厂连接从视觉交互升维为体感共生。
- 五通道：数据上行（姿态/负荷/位置/动作）+ 触觉反馈（振动/阻止/脉冲）+ 语音交互 + AR 投影（工位指引/工序提示）+ 状态共生。
- 实现：`POST /api/gamification/exo/:deviceId/feedback`（[gamification.service.ts](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/server/modules/gamification/gamification.service.ts) `sendExoFeedback`）。

### 3.2 游戏层级体系

| 层级 | 名称 | 视角 | 用途 | 实现 |
|------|------|------|------|------|
| **L0** | 2D 俯视战略图 | 厂长 | 全厂产线布局、KPI 总览 | [FactoryMap.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap.tsx) L0 模式 |
| **L1** | 2.5D 战术图 | 车间主任 | 工位/人员/设备/摄像头视锥/UWB 覆盖 | FactoryMap L1 模式（+ 视锥/覆盖圈） |
| **L2** | 3D 孪生操作图 | 班组长 | 3D 场景交互、实体选中、资源拖拽 | [FactoryMap3D.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/FactoryMap3D.tsx)（GLB 骨架，待接 3DGS） |
| **L3** | 高写实复盘图 | 所有人 | 3DGS 高写实回放、事件复盘 | 待 3DGS 产物接入 |
| **L-玩法** | 游戏机制层 | 所有玩家 | 资源分配/任务编排/实时决策/事件响应/学习进化 | gamification 模块 |

### 3.3 玩家角色与权限

实现：`GET /api/gamification/role`（环境变量 `EWOH_PLAYER_ROLE` 切换）

| 角色 | 定位 | 可见层级 | 核心权限 |
|------|------|---------|---------|
| **班组长**（shift_leader） | 战术玩家 | L0/L1/L2 | 查看/资源分配/任务编排/方案确认/事件处置 |
| **车间主任**（workshop_director） | 战役玩家 | L0/L1/L2 | 班组长权限 + 调度下发 + 外骨骼反馈 |
| **厂长**（factory_manager） | 战略玩家 | L0/L1/L2 | 车间主任权限 + 权重调整 + 模型管理 |

### 3.4 五项核心玩法（已落地）

| 玩法 | API | 玩家交互 | 实现 |
|------|-----|---------|------|
| **G3.2 资源分配** | `POST /api/gamification/resources/allocate` | 拖拽人员/设备到工位 → AI 评估负荷均衡/技能匹配/电量续航 → 红黄绿评分 | [ResourcePoolPanel.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/panels/ResourcePoolPanel.tsx) |
| **G3.3 任务编排** | `POST /api/gamification/tasks/orchestrate` | 工单分解→工序节点编排→分配工位/人员→节拍模拟（瓶颈识别/产量预测） | [TaskOrchestrationPanel.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/panels/TaskOrchestrationPanel.tsx) |
| **G3.5 调度下发** | `POST /api/gamification/schedule/:planId/dispatch` | 玩家确认方案→冲突检测（设备离线）→下发执行层→执行确认回传 | gamification.service.ts `dispatchPlan` |
| **G3.6 事件响应** | `POST /api/dashboard/events/:eventId/handle` | 告警弹窗→查看详情/快速处置→处置动作回写→证据链留存 | [AlertToast.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/components/AlertToast.tsx) + dashboard.service.ts `handleEvent` |
| **G3.7 学习进化** | `GET /api/gamification/brain/suggestions` | 大脑基于实时数据生成 5 类建议（节拍优化/负荷均衡/换电/安全介入/瓶颈解决）→置信度排序 | [BrainPanel.tsx](file:///Volumes/Extra/CodeProj/EWOH/ewoh-spark-app/client/src/pages/CommandMap/panels/BrainPanel.tsx) |

### 3.5 大脑推理决策五层架构

```
┌─────────────────────────────────────────────────────┐
│  学习层  ← 决策结果反馈训练模型（learning_loop.py）   │
├─────────────────────────────────────────────────────┤
│  决策层  ← 方案确认与下发（dispatchPlan）             │
├─────────────────────────────────────────────────────┤
│  推理层  ← 调度建议/风险预测/瓶颈分析（getBrainSuggestions）│
├─────────────────────────────────────────────────────┤
│  记忆层  ← 历史数据沉淀（ewoh_telemetry/event_chain） │
├─────────────────────────────────────────────────────┤
│  感知层  ← 汇聚全量实时数据（ingest 网关 + rule_engine）│
└─────────────────────────────────────────────────────┘
```

### 3.6 虚拟-现实双向同步

| 方向 | 机制 | 延迟 | 实现 |
|------|------|------|------|
| **现实 → 虚拟** | 传感器数据实时涌现：ingest 网关接收 → 落库 → 看板 30s 轮询刷新 | <5s（数据侧）+ 30s（UI 侧） | ingest + simulator + CommandMap 轮询 |
| **虚拟 → 现实** | 玩家决策下发执行层：方案确认 → dispatchPlan → 外骨骼反馈下行 → 执行确认回传 | 秒级 | gamification.service.ts + exo_feedback |
| **冲突检测** | 下发前检查关联设备在线状态，离线则返回 `status=conflict` 并阻止下发 | 实时 | `dispatchPlan` 冲突检测逻辑 |

### 3.7 数据涌现 → 智能涌现的路径

```
成千上万传感器持续运转
        │
        ▼
海量高维数据资产（ewoh_telemetry / environment / world_state / event_chain）
        │
        ▼
规则引擎实时评估（5 条核心规则 → 自动事件）
        │
        ▼
大脑推理（getBrainSuggestions → 5 类建议 + 置信度）
        │
        ▼
玩家决策（资源分配 / 任务编排 / 调度下发）
        │
        ▼
执行反馈 → 学习层训练模型（learning_loop.py）
        │
        ▼
模型迭代 → 推理质量提升 → 智能涌现
```

---

## 四、验收：当前实现状态

| 模块 | 完成度 | 验证方式 |
|------|--------|---------|
| Ingestion 网关（6 类端点） | 100% | `npm run type:check:server` 通过 |
| 游戏化玩法（5 项核心） | 100% | `npm run type:check:server` 通过 |
| 指挥地图（7 Tab + 9 模式 + 快捷键） | 100% | `npm run type:check:client` 通过 |
| 边缘桥接脚本（真机+模拟） | 100% | `edge_to_spark.py --source-type simulated` 可运行 |
| 直接建模网关（3DGS/LiDAR/UWB） | 100% | `/api/ingest/spatial-scan` + `/api/ingest/location` |
| 生产构建 | 100% | `npm run build:server` + `build:client` 均成功 |
| 飞书闭环（告警跳转+处置回写） | 100% | URL event_id 参数 + handleEvent API |

**待现场交付项**（代码就绪，需实地执行）：摄像头标定、UWB 基站测绘、3DGS 现场拍摄+训练、真机外骨骼对接、本地 LLM 部署。
