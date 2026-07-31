# Checklist

## 飞书多维表格
- [x] 多维表格 Base 已创建，含设备表/遥测表/事件表
- [x] 设备表字段完整（device_id/worker_name/device_model/battery_pct/online/last_telemetry_at）
- [x] 事件表字段完整（event_id/device_id/event_code/event_type/severity/title/status/created_at/handler_action）
- [x] feishu-config.json 已生成，含 app_token 和各 table_id

## 飞书集成模块
- [x] server/feishu.js 已实现 larkCli() 子进程封装
- [x] sendAlertCard() 能发送交互式卡片到群聊
- [x] baseRecordCreate() / baseRecordUpdate() 能读写多维表格
- [x] createApproval() 能创建飞书审批实例（降级为群聊消息）
- [x] createReportDoc() 能创建飞书文档
- [x] 所有飞书调用有 try/catch 容错，失败不阻断主流程

## 数据同步
- [x] server/sync.js 已实现设备/遥测/事件同步
- [x] 遥测同步有降频防抖（5 秒批量）
- [x] 事件创建时同步到多维表格
- [x] 事件状态变更时回写多维表格

## 告警与处置闭环
- [x] 事件触发时发送告警卡片到群聊
- [x] 卡片含设备ID/工人名/事件类型/触发数据/处置按钮
- [x] POST /webhook/card 端点能接收飞书回调
- [x] acknowledge 动作 → 事件 handled + 卡片更新
- [x] resolve 动作 → 事件 closed + 卡片更新
- [x] escalate 动作 → 创建审批 + 卡片更新
- [x] 处置后发送跟进消息到群聊

## 班次报告
- [x] GET /api/feishu/report 端点已实现
- [x] 报告含设备统计/事件统计/处置率/详细事件列表
- [x] 返回飞书文档链接

## 全链路验证
- [x] 服务启动无报错
- [x] 运行 30 秒后多维表格有设备/遥测/事件数据
- [x] 运行 30 秒后群聊收到至少 1 条告警卡片
- [x] curl POST /webhook/card 能正确处置事件
- [x] GET /api/feishu/report 返回文档链接
