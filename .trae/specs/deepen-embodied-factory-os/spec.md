# 深化工厂具身智能操作系统 Spec

## Why

现有 `build-embodied-factory-os` 已建立九层架构骨架与 Python 后端模块，但妙搭应用（`ewoh-spark-app/`）存在严重"偷懒"问题：数据库仅 3 张表（device/event/telemetry），后端仅 1 个 Dashboard 模块，指挥地图仅是 iframe 嵌入静态文件并使用 sample data 而非妙搭 PostgreSQL 数据。系统没有活数据流，没有空间实体，没有调度 API，没有世界模型 API，前端与后端完全脱节。本变更将妙搭应用从"展示壳"深化为"完完全全可运行的具身工厂操作系统"，让用户在飞书妙搭内体验到有活数据、有地图、有调度、有回放的完整系统。

## What Changes

- **新增数据模拟器服务**：NestJS 中实现 `SimulatorModule`，定时生成设备遥测、人员位置移动、事件触发、负荷变化、电量消耗等活数据，写入妙搭 PostgreSQL，让系统持续运行有真实数据流
- **数据库扩展为完整世界模型**：在妙搭 PostgreSQL 中新增空间实体表（ewoh_spatial_entity）、空间拓扑表（ewoh_topology）、世界状态快照表（ewoh_world_state）、事件因果链表（ewoh_event_chain）、调度方案表（ewoh_schedule_plan）、调度审计表（ewoh_schedule_audit）、模型注册表（ewoh_model_registry）、环境传感器表（ewoh_environment），并植入空间实体种子数据（工厂/车间/产线/工位/设备/摄像头/UWB 基站）
- **新增空间 API 模块**：空间实体 CRUD、层级查询、拓扑查询、坐标变换，前端可获取完整空间底图
- **新增世界模型 API 模块**：当前状态查询（人员位置/设备状态/工位占用/任务进度）、事件因果链查询、时间轴回放数据
- **新增调度 API 模块**：多方案生成（保持现状/产能优先/负荷均衡）、方案评分、方案确认（人在回路）、审计记录、权重配置查询
- **新增场景仿真 API 模块**：方案指标计算（产量/延误/负荷/距离/电量/拥堵）、方案对比
- **指挥地图升级为 React 原生组件**：废弃 iframe 方案，用 React + SVG 实现真正的指挥地图，接入 NestJS API，支持 9 种地图模式、L0/L1 切换、实体选中详情、时间轴回放、事件中心、调度方案比较、班组长工作台
- **前端实时数据刷新**：所有页面接入 NestJS API，30 秒轮询刷新，指挥地图 2 秒轮询动态实体

## Impact

- 受影响代码：`ewoh-spark-app/server/`（新增 6 个模块 + 数据模拟器 + 数据库 schema 扩展）、`ewoh-spark-app/client/src/`（新增指挥地图 React 组件 + 页面重构）、`ewoh-spark-app/shared/api.interface.ts`（扩展类型定义）
- 受影响 spec：深化 `build-embodied-factory-os` 的代码实现质量，不改变其产品定义与验收标准
- 部署：重新构建并发布到妙搭云端 `app_17b7bgq1e4a`

## ADDED Requirements

### Requirement: 数据模拟器服务
系统 SHALL 在 NestJS 后端实现数据模拟器服务（SimulatorService），以定时任务（每 3-5 秒）生成活数据并写入妙搭 PostgreSQL，包括：设备遥测（姿态角/负荷/疲劳趋势/电量/质量状态）、人员位置移动（在工位间移动）、事件触发（高负荷/低电量/失联/禁区进入）、环境数据（温度/振动/噪声）。模拟器 SHALL 维护 5-8 台设备、5-8 名人员、3-5 个工位的持续运行状态，数据流 SHALL 标记 source_type 为 'simulated'。

#### Scenario: 活数据持续生成
- **WHEN** 妙搭应用启动
- **THEN** 模拟器自动开始生成数据，设备/人员/事件数据持续写入 PostgreSQL，前端可查询到实时变化的数据

#### Scenario: 数据来源标识
- **WHEN** 模拟器生成数据
- **THEN** 所有数据标记 source_type='simulated'，与 real 数据隔离，不作为真机验收依据

### Requirement: 完整世界模型数据库
系统 SHALL 在妙搭 PostgreSQL 中新增空间实体表（ewoh_spatial_entity：entity_id/entity_type/parent_id/name/x/y/yaw/bbox_w/bbox_h/status/source_type/confidence/version）、空间拓扑表（ewoh_topology：from_entity/to_entity/relation/distance）、世界状态快照表（ewoh_world_state：entity_id/state_json/ts）、事件因果链表（ewoh_event_chain：event_id/parent_event_id/causal_type/description）、调度方案表（ewoh_schedule_plan：plan_id/plan_name/strategy/status/takt_improvement/high_load_persons/low_battery_risk/affected_persons/metrics_json/reason/created_at）、调度审计表（ewoh_schedule_audit：audit_id/plan_id/action/operator/reason/created_at）、模型注册表（ewoh_model_registry：model_id/model_name/version/type/status/card_json）、环境传感器表（ewoh_environment：sensor_id/entity_id/temperature/vibration/noise/air_quality/ts）。并植入空间实体种子数据：1 工厂 + 1 车间 + 1 产线 + 2 区域 + 4 工位 + 8 设备 + 8 人员 + 4 摄像头 + 3 UWB 基站。

#### Scenario: 空间实体可查询
- **WHEN** 前端请求空间实体列表
- **THEN** 返回完整空间层级（工厂→车间→产线→区域→工位→设备/人员/摄像头/UWB），每个实体含坐标/朝向/边界框/状态/来源/置信度/版本

#### Scenario: 调度方案可持久化
- **WHEN** 调度器生成方案
- **THEN** 方案写入 ewoh_schedule_plan 表，含策略/状态/指标/理由，可在前端查询和确认

### Requirement: 空间 API 模块
系统 SHALL 提供 REST API `/api/spatial/entities`（GET 查询空间实体，支持按 type/parent_id 过滤）、`/api/spatial/entities/:entityId`（GET 单实体详情）、`/api/spatial/topology`（GET 拓扑关系）、`/api/spatial/hierarchy`（GET 层级树）。

#### Scenario: 空间实体查询
- **WHEN** 前端请求 `/api/spatial/entities?type=workstation`
- **THEN** 返回所有工位类型实体，含坐标/边界框/状态

### Requirement: 世界模型 API 模块
系统 SHALL 提供 REST API `/api/world/state`（GET 当前世界状态快照：所有人员位置/设备状态/工位占用/任务进度）、`/api/world/events/chain/:eventId`（GET 事件因果链）、`/api/world/replay`（GET 时间轴回放数据，支持时间范围参数）。

#### Scenario: 当前状态可查
- **WHEN** 前端请求 `/api/world/state`
- **THEN** 返回当前时刻所有动态实体的状态快照（人员位置/设备状态/工位占用/当前任务/负荷）

### Requirement: 调度 API 模块
系统 SHALL 提供 REST API `/api/scheduler/plans`（GET 查询方案列表，POST 触发方案生成）、`/api/scheduler/plans/:planId/confirm`（POST 确认方案，需提供 reason）、`/api/scheduler/audit`（GET 审计记录）、`/api/scheduler/weights`（GET/PUT 权重配置）。方案生成 SHALL 返回至少 3 个方案（保持现状/产能优先/负荷均衡），每个方案含分项指标和理由。确认方案 SHALL 写入审计记录。

#### Scenario: 方案生成
- **WHEN** 前端请求生成调度方案
- **THEN** 返回 3+ 个方案，每个含 strategy/takt_improvement/high_load_persons/low_battery_risk/affected_persons/metrics/reason

#### Scenario: 人在回路确认
- **WHEN** 班组长确认方案
- **THEN** 必须提供 reason，系统记录审计（plan_id/action/operator/reason/time），未经确认不得自动执行

### Requirement: React 原生指挥地图
系统 SHALL 用 React + SVG 实现原生指挥地图组件（替代 iframe 方案），接入 NestJS API，支持：中央 SVG 工厂地图（渲染区域/工位/设备/人员/摄像头/UWB/路线）、左侧组织树 + 9 种地图模式切换（生产/人员/外骨骼/人体负荷/安全风险/设备/环境/调度/数据质量）、右侧实体详情面板、底部标签栏（时间轴/事件中心/调度方案/班组长工作台/模型规则）、L0/L1 切换（L1 含摄像头视锥/UWB 覆盖）。地图 SHALL 2 秒轮询刷新动态实体。

#### Scenario: 地图渲染
- **WHEN** 用户进入指挥地图页面
- **THEN** SVG 地图渲染空间实体（区域/工位/设备/人员），数据来自 NestJS API，2 秒自动刷新

#### Scenario: 模式切换
- **WHEN** 用户切换到人体负荷模式
- **THEN** 地图只突出负荷信息（人员按负荷着色），其他维度弱化

#### Scenario: 实体选中
- **WHEN** 用户点击地图上某个人员
- **THEN** 右侧面板显示该人员详情（ID/位置/设备/任务/负荷/状态/来源/置信度/更新时间/版本）

### Requirement: 时间轴回放
系统 SHALL 在指挥地图底部提供时间轴组件，支持实时/暂停/倍速回放（1x/2x/5x）/跳转事件。回放时地图显示历史时刻的实体状态，数据来自 `/api/world/replay`。

#### Scenario: 历史回放
- **WHEN** 用户选择历史时间点回放
- **THEN** 地图显示该时刻的实体状态，时间轴可暂停/倍速/跳转事件

### Requirement: 调度方案比较界面
系统 SHALL 在指挥地图底部提供调度方案比较标签页，展示所有方案的 分项指标对比（不只总分）：方案名/策略/节拍提升/高负荷人员数/低电量风险数/受影响人员数/理由。每个方案可确认（需填写理由）或否决。

#### Scenario: 方案对比
- **WHEN** 班组长打开调度方案标签页
- **THEN** 看到所有方案的 分项指标对比表格，可确认或否决

## MODIFIED Requirements

### Requirement: 妙搭应用前端架构（从 iframe 升级为原生 React）
现有妙搭应用前端从 iframe 嵌入静态文件升级为 React 原生组件实现。指挥地图作为独立全屏路由 `/command-map`，使用 React + SVG 渲染，接入 NestJS API。原有 4 个页面（总览/设备/事件/人员）保留并继续接入 Dashboard API。侧边栏导航保留指挥地图入口。

### Requirement: 妙搭应用后端架构（从单模块扩展为多模块）
现有妙搭应用后端从单 Dashboard 模块扩展为 7 个模块：Dashboard（保留）、Spatial（新增）、World（新增）、Scheduler（新增）、Scenario（新增）、Simulator（新增）、Governance（新增）。所有模块共享 Drizzle ORM 与妙搭 PostgreSQL。
