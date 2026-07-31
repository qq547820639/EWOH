# 飞书仪表盘原生闭环 Spec

## Why
当前系统是"两张皮"：飞书侧有多维表格+IM告警，本地侧有 Python backend+HTML 指挥地图，二者不通。用户在飞书里看到告警却跳不到指挥地图，在本地看到风险却无法在飞书处置。这不是真正的"飞书全家桶"。

真正需求：用户**完全在飞书内完成"看数据→收告警→处置→复盘"全闭环**，不需要打开本地浏览器。本地 Python backend 只做"数据采集引擎"，把数据推到飞书，不要求用户访问本地服务。

## What Changes
- **新增**：飞书多维表格仪表盘（Dashboard）3 个，替代本地 HTML 指挥地图
  - 设备态势总览：在线/离线/电量分布/设备型号分布/设备列表
  - 事件与风险看板：事件严重度分布/事件趋势/未结事件列表/风险热力图
  - 人员负荷监测：人员累计负荷/当前动作/风险趋势
- **新增**：backend 定时同步任务，每 30s 把设备/事件/人员状态推到飞书多维表格
- **修改**：告警卡片增加"查看仪表盘"按钮，跳转到飞书仪表盘 URL
- **修改**：事件表 workflow 状态变更通知增加仪表盘链接
- **保留**：本地指挥地图仅作调试用，不再作为主入口
- **BREAKING**：主入口从 http://localhost:8765 改为飞书多维表格仪表盘 URL

## Impact
- Affected specs: build-embodied-factory-os（指挥地图 UI 部分）、integrate-feishu-native（飞书集成）
- Affected code:
  - ewoh-feishu-app/server/sync.js（增加全量同步逻辑）
  - ewoh-feishu-app/server/feishu.js（增加仪表盘创建/组件配置）
  - ewoh-feishu-app/server/index.js（启动定时同步）
  - ewoh-feishu-app/feishu-config.json（记录仪表盘 ID）

## ADDED Requirements

### Requirement: 飞书多维表格仪表盘
系统 SHALL 在飞书多维表格中创建 3 个仪表盘，使用户在飞书内即可查看设备态势、事件风险和人员负荷，无需访问本地服务。

#### Scenario: 设备态势总览
- **GIVEN** backend 已启动并同步数据到多维表格
- **WHEN** 用户在飞书打开"设备态势总览"仪表盘
- **THEN** 看到：在线设备数/离线设备数 KPI、电量分布柱状图、设备型号饼图、设备列表表格（含设备ID/工人/电量/在线状态/最后通信时间）

#### Scenario: 事件与风险看板
- **GIVEN** backend 已触发风险事件并同步到多维表格
- **WHEN** 用户在飞书打开"事件与风险看板"仪表盘
- **THEN** 看到：未结事件数 KPI、事件严重度分布饼图、事件趋势折线图（按小时）、未结事件列表表格（含事件ID/设备/类型/严重度/状态/创建时间）

#### Scenario: 人员负荷监测
- **GIVEN** backend 已采集人员负荷数据并同步到多维表格
- **WHEN** 用户在飞书打开"人员负荷监测"仪表盘
- **THEN** 看到：在岗人员数 KPI、人员累计负荷柱状图、当前动作分布饼图、人员状态列表表格（含人员ID/当前动作/累计负荷/风险等级/外骨骼电量）

### Requirement: 全量数据定时同步
系统 SHALL 每 30 秒把 backend 的设备/事件/人员状态全量同步到飞书多维表格，确保仪表盘数据实时。

#### Scenario: 定时同步
- **GIVEN** backend 运行中，飞书多维表格已配置
- **WHEN** 同步定时器触发（每 30 秒）
- **THEN** 从 backend SQLite 读取最新设备/事件/人员数据，upsert 到飞书多维表格对应表，失败不阻断

### Requirement: 告警卡片跳转仪表盘
系统 SHALL 在 IM 告警卡片中增加"查看仪表盘"按钮，点击跳转到飞书事件与风险看板仪表盘。

#### Scenario: 卡片跳转
- **GIVEN** 风险事件触发，告警卡片已发送到飞书群
- **WHEN** 用户点击卡片上的"查看仪表盘"按钮
- **THEN** 在飞书内打开事件与风险看板仪表盘，无需访问本地服务

### Requirement: backend 纯数据引擎定位
系统 SHALL 把本地 Python backend 定位为纯数据引擎，只负责采集+推理+同步到飞书，不要求用户访问本地服务。

#### Scenario: 用户纯飞书使用
- **GIVEN** backend 已启动并配置飞书同步
- **WHEN** 用户在飞书内查看仪表盘、处置事件、查看报告
- **THEN** 全部操作在飞书内完成，不需要打开本地浏览器
