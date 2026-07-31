# 飞书全家桶集成 Spec

## Why
EWOH 本地应用（`ewoh-feishu-app/`）已跑通设备模拟→规则引擎→事件触发→API→前端看板全链路，但事件告警只在前端展示，无主动推送与飞书原生处置闭环。需要用飞书全家桶（多维表格+IM机器人+审批+文档）替代前端，让事件在飞书内完成"告警→处置→闭环"全流程，无需额外打开 Web 界面。

## What Changes
- 新增 `server/feishu.js` 飞书集成模块：通过 `lark-cli` 子进程调用飞书 OpenAPI，封装消息卡片发送、多维表格写入、审批创建、文档生成四类能力
- 新增 `server/sync.js` 数据同步模块：本地 SQLite 数据双向同步到飞书多维表格（设备/遥测/事件三表）
- 修改 `server/rules.js`：事件触发时调用飞书模块发送告警卡片到指定群聊
- 修改 `server/events.js`：事件处置时更新多维表格记录 + 发送处置结果消息
- 修改 `server/index.js`：启动时初始化飞书资源（建表/建索引）+ 注册卡片回调端点
- 新增 `POST /webhook/card` 端点：接收飞书卡片按钮回调，执行事件处置
- 新增 `GET /api/feishu/report` 端点：生成班次报告飞书文档

## Impact
- Affected code: `ewoh-feishu-app/server/` 全部后端文件
- 依赖: `lark-cli` 已安装且已授权（im/base/approval/doc 域权限）
- 运行时: Node.js 子进程调用 lark-cli，需要 lark-cli 在 PATH 中

## ADDED Requirements

### Requirement: 飞书多维表格数据看板
系统 SHALL 在飞书多维表格中创建设备表、遥测表、事件表，并将本地数据实时同步，使运维人员在飞书内直接查看设备状态与事件列表。

#### Scenario: 设备状态同步
- **WHEN** 模拟器生成新遥测帧
- **THEN** 设备表的电量/最后通信时间字段更新，遥测表追加一条记录

#### Scenario: 事件同步
- **WHEN** 规则引擎触发新事件
- **THEN** 事件表追加一条记录，状态为 open

#### Scenario: 事件状态回写
- **WHEN** 事件被处置或自动关闭
- **THEN** 多维表格中对应记录的 status 字段更新

### Requirement: IM 告警卡片推送
系统 SHALL 在事件触发时向指定飞书群聊发送交互式消息卡片，包含事件详情与处置按钮。

#### Scenario: 高风险事件告警
- **WHEN** L2 事件（如持续高负荷）触发
- **THEN** 群聊收到红色标题卡片，含设备ID/工人名/事件类型/触发数据/处置按钮（确认/解决/上报）

#### Scenario: 卡片按钮回调
- **WHEN** 用户点击卡片上的"确认"按钮
- **THEN** 事件 status 变为 handled，卡片更新为"已确认"，群聊收到跟进消息

### Requirement: 飞书审批闭环
系统 SHALL 对"上报"动作创建飞书审批实例，安全主管审批后结果回写事件。

#### Scenario: 事件上报审批
- **WHEN** 用户在卡片点击"上报"
- **THEN** 创建飞书审批实例，审批人收到待办
- **WHEN** 审批通过
- **THEN** 事件 status 变为 escalated，原卡片更新审批结果

### Requirement: 班次报告飞书文档
系统 SHALL 按需生成班次报告飞书文档，汇总设备状态、事件统计、处置记录。

#### Scenario: 生成报告
- **WHEN** 调用 GET /api/feishu/report
- **THEN** 创建飞书文档，内容包括：班次时间范围、设备在线统计、事件分类统计、处置率、详细事件列表
