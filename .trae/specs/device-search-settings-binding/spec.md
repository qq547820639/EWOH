# 设备搜索 · 设备设置 · 层级绑定 Spec

## Why

当前演示平台的「设备态势」页（`Devices.tsx`）仅为只读列表，无法满足现实生产系统对设备资产管理的基本诉求：运维人员无法按名称/类型/状态检索设备、无法在系统内配置设备参数与运行状态、也无法将设备显式绑定到建筑结构（工厂/车间/产线/工位）与人员。设备上线后虽能通过 `ewoh_spatial_entity` 映射进系统，但缺少管理闭环，导致设备与空间、人员的关系只能靠 seed 脚本静态写入，无法在运行时维护。

## What Changes

- **设备搜索**：在 `Devices.tsx` 增加搜索栏，支持按设备 ID / 名称 / 型号 / 在线状态 / 电量区间 / 来源类型（real/simulated）多条件检索与排序。
- **设备设置面板**：新增设备配置抽屉（Drawer），支持编辑 `workerName` / `deviceModel` / `firmwareVersion` / `hardwareVersion` / `protocolVersion` / `online` / `faultCode` / `batteryPct` 等字段，并支持手动创建新设备（用于未自动上线的设备预登记）。
- **层级绑定管理**：
  - 设备 → 建筑结构：通过 `ewoh_spatial_entity.parentId` 将设备实体挂载到工位/产线/车间/工厂层级树下，UI 提供层级树选择器。
  - 设备 → 人员：通过 `ewoh_spatial_entity.extra.device_id` 与人员实体建立双向绑定，UI 提供人员下拉选择。
  - 新增「绑定关系」视图，可视化展示设备当前所属的建筑层级与绑定人员。
- **后端 API**：
  - `GET /api/dashboard/devices` 扩展查询参数（keyword/online/batteryMin/batteryMax/sourceType/model/orderby）。
  - `POST /api/dashboard/devices` 创建设备。
  - `PATCH /api/dashboard/devices/:deviceId` 更新设备字段。
  - `POST /api/dashboard/devices/:deviceId/bindings` 绑定设备到空间实体（parentId）与人员（entityId）。
  - `DELETE /api/dashboard/devices/:deviceId/bindings` 解绑。
  - `GET /api/dashboard/devices/:deviceId/bindings` 查询设备当前绑定关系。

## Impact

- **Affected specs**：
  - `realtime-ingest-and-gamification`（Ingestion 网关写入 `ewoh_device`，需与新的 PATCH 接口字段对齐）
  - `embodied-game-and-direct-modeling`（设备搜索/绑定是游戏化资源池的前置能力）
- **Affected code**：
  - 后端：`server/modules/dashboard/dashboard.controller.ts`、`dashboard.service.ts`、`shared/api.interface.ts`
  - 前端：`client/src/pages/Devices/Devices.tsx`、`client/src/api/dashboard.ts`
  - 新增前端组件：设备搜索栏、设备配置抽屉、层级绑定面板
  - 数据库：无 schema 变更（复用 `ewoh_spatial_entity.parentId` + `extra` JSON 字段）

## ADDED Requirements

### Requirement: 设备多条件搜索

系统 SHALL 提供设备搜索界面，支持按以下条件检索设备：关键字（设备 ID / 工人姓名 / 型号模糊匹配）、在线状态、电量区间（min/max）、来源类型（real/simulated/controlled_test）、设备型号，并支持按电量/最后通信时间/设备 ID 排序。

#### Scenario: 按关键字与状态检索
- **WHEN** 用户在搜索栏输入关键字 "EXO-001" 并选择在线状态为「在线」
- **THEN** 系统返回 deviceId 或 workerName 或 deviceModel 模糊匹配 "EXO-001" 且 online=true 的设备列表

#### Scenario: 按电量区间筛选
- **WHEN** 用户设置电量区间为 20-80
- **THEN** 系统返回 batteryPct 在 [20, 80] 区间的设备

#### Scenario: 无匹配结果
- **WHEN** 搜索条件无匹配设备
- **THEN** 系统显示空状态提示「未找到匹配的设备」

### Requirement: 设备配置面板

系统 SHALL 提供设备配置抽屉，支持查看与编辑设备元信息（workerName / deviceModel / firmwareVersion / hardwareVersion / protocolVersion）、运行状态（online / batteryPct / faultCode），并支持手动创建新设备。

#### Scenario: 编辑现有设备
- **WHEN** 用户在设备列表点击某行「编辑」按钮
- **THEN** 系统打开抽屉展示当前设备字段，用户修改后点击「保存」调用 PATCH 接口更新

#### Scenario: 手动创建新设备
- **WHEN** 用户点击「新增设备」按钮并填写 deviceId（必填）与其他字段
- **THEN** 系统调用 POST 接口创建设备，列表自动刷新

#### Scenario: deviceId 重复校验
- **WHEN** 用户创建设备时 deviceId 已存在
- **THEN** 系统返回 400 错误并提示「设备 ID 已存在」

### Requirement: 设备层级绑定

系统 SHALL 提供绑定管理面板，支持将设备绑定到建筑结构层级（工厂/车间/产线/工位）与人员，并支持解绑。

#### Scenario: 绑定设备到工位
- **WHEN** 用户在设备配置面板选择「绑定空间实体」并在层级树中选择工位 WS-001
- **THEN** 系统更新 `ewoh_spatial_entity.parentId` 为 WS-001（设备实体 entityType='device'），返回绑定成功

#### Scenario: 绑定设备到人员
- **WHEN** 用户在设备配置面板选择「绑定人员」并从下拉选择人员 P-001
- **THEN** 系统在人员实体的 `extra.device_id` 写入当前 deviceId，并在设备实体的 `extra.worker_id` 写入 P-001，建立双向绑定

#### Scenario: 解绑设备
- **WHEN** 用户点击「解绑」按钮
- **THEN** 系统清除 parentId 与 extra 中的绑定字段，返回解绑成功

#### Scenario: 查询绑定关系
- **WHEN** 用户打开设备配置面板
- **THEN** 系统展示设备当前所属建筑层级路径（如「工厂A > 车间B > 产线C > 工位D」）与绑定人员姓名

## MODIFIED Requirements

### Requirement: 设备列表查询接口

`GET /api/dashboard/devices` 扩展支持以下查询参数：
- `keyword`：模糊匹配 deviceId / workerName / deviceModel
- `online`：true/false
- `batteryMin` / `batteryMax`：电量区间
- `sourceType`：real/simulated/controlled_test
- `model`：设备型号精确匹配
- `orderby`：battery / lastTelemetryAt / deviceId，支持 `desc` 后缀（如 `batteryDesc`）

返回字段新增 `entityId` / `parentId` / `boundPersonId` / `boundPersonName` / `sourceType` / `firmwareVersion` / `hardwareVersion` / `protocolVersion` / `temperatureC` / `faultCode`。
