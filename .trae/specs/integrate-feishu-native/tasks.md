# Tasks

- [x] Task 1: 创建飞书多维表格 Base（设备表/遥测表/事件表 + 字段定义）
  - [ ] 1.1 用 lark-cli base +create 创建多维表格应用
  - [ ] 1.2 创建设备表（device_id/worker_name/device_model/battery_pct/online/last_telemetry_at）
  - [ ] 1.3 创建遥测表（device_id/ts/pitch_deg/torque_nm/battery_pct/quality_status）
  - [ ] 1.4 创建事件表（event_id/device_id/event_code/event_type/severity/title/status/created_at/handler_action）
  - [ ] 1.5 记录 app_token 和各 table_id 到本地配置文件 feishu-config.json

- [x] Task 2: 实现 server/feishu.js 飞书集成模块
  - [x] 2.1 封装 larkCli(args) 子进程调用函数（execSync + JSON 解析 + 错误处理）
  - [x] 2.2 实现 sendAlertCard(chatId, event) — 构建交互式卡片 JSON（标题/详情/按钮）并发送
  - [x] 2.3 实现 sendFollowupMessage(chatId, text) — 发送跟进文本消息
  - [x] 2.4 实现 updateCardMessage(messageId, card) — 更新已发送卡片内容
  - [x] 2.5 实现 createApproval(event) — 创建飞书审批实例
  - [x] 2.6 实现 createReportDoc(stats) — 创建飞书文档（班次报告）
  - [x] 2.7 实现 baseRecordCreate(tableId, fields) / baseRecordUpdate(tableId, recordId, fields) — 多维表格读写

- [x] Task 3: 实现 server/sync.js 数据同步模块
  - [x] 3.1 loadFeishuConfig() — 读取 feishu-config.json（app_token/table_ids/chat_id）
  - [x] 3.2 syncDevice(device) — 设备状态同步到多维表格（upsert by device_id）
  - [x] 3.3 syncTelemetry(telemetry) — 遥测记录追加到多维表格
  - [x] 3.4 syncEventCreate(event) — 事件创建同步到多维表格
  - [x] 3.5 syncEventUpdate(eventId, status, handlerAction) — 事件状态更新同步
  - [x] 3.6 防抖：遥测同步降频为每 5 秒批量写一次（避免每秒调 lark-cli）

- [x] Task 4: 修改 server/rules.js 集成飞书告警
  - [x] 4.1 事件触发时调用 feishu.sendAlertCard() 发送告警卡片
  - [x] 4.2 事件触发时调用 sync.syncEventCreate() 同步多维表格
  - [x] 4.3 事件自动关闭时调用 sync.syncEventUpdate() 更新多维表格
  - [x] 4.4 容错：lark-cli 调用失败不阻断主流程（catch + console.error）

- [x] Task 5: 修改 server/events.js + server/index.js 集成卡片回调
  - [x] 5.1 新增 POST /webhook/card 端点接收飞书卡片回调
  - [x] 5.2 解析回调 payload（action_type + event_id + operator）
  - [x] 5.3 acknowledge → handleEvent(status=handled) + 更新卡片为"已确认"
  - [x] 5.4 resolve → handleEvent(status=closed) + 更新卡片为"已解决"
  - [x] 5.5 escalate → createApproval() + 更新卡片为"审批中"
  - [x] 5.6 处置后发送跟进消息到群聊

- [x] Task 6: 新增 GET /api/feishu/report 班次报告端点
  - [x] 6.1 汇总当前班次数据（设备统计/事件统计/处置率）
  - [x] 6.2 调用 feishu.createReportDoc() 生成飞书文档
  - [x] 6.3 返回文档链接

- [x] Task 7: 本地全链路验证
  - [x] 7.1 npm install + 启动服务
  - [x] 7.2 验证多维表格数据写入（lark-cli base +record-list 查询）
  - [x] 7.3 验证告警卡片发送到群聊（lark-cli im 查询消息）
  - [x] 7.4 验证卡片回调端点（curl POST /webhook/card）
  - [x] 7.5 验证报告文档生成（GET /api/feishu/report）

# Task Dependencies
- [Task 2] depends on [Task 1]（需要 app_token/table_ids）
- [Task 3] depends on [Task 1] + [Task 2]（需要配置 + feishu 模块）
- [Task 4] depends on [Task 2] + [Task 3]
- [Task 5] depends on [Task 2] + [Task 4]
- [Task 6] depends on [Task 2]
- [Task 7] depends on [Task 4] + [Task 5] + [Task 6]
