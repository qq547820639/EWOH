# Tasks

- [x] Task 1: 创建飞书多维表格仪表盘（3个）
  - [x] 1.1 创建"设备态势总览"仪表盘 + 组件（KPI/电量分布柱状图/设备型号饼图/设备列表表格）
  - [x] 1.2 创建"事件与风险看板"仪表盘 + 组件（未结事件KPI/严重度饼图/趋势折线图/事件列表表格）
  - [x] 1.3 创建"人员负荷监测"仪表盘 + 组件（在岗人员KPI/负荷柱状图/动作饼图/人员列表表格）
  - [x] 1.4 记录仪表盘 ID 和 URL 到 feishu-config.json

- [x] Task 2: 实现全量数据定时同步
  - [x] 2.1 在 sync.js 新增 syncAllToFeishu() 函数，从 backend SQLite 读取设备/事件/人员数据
  - [x] 2.2 upsert 到飞书多维表格设备表/事件表/人员表（复用 baseRecordCreate）
  - [x] 2.3 在 index.js 启动 30s 定时器调用 syncAllToFeishu
  - [x] 2.4 失败不阻断，记录错误日志

- [x] Task 3: 告警卡片增加仪表盘跳转按钮
  - [x] 3.1 修改 feishu.js buildAlertCard，增加"查看仪表盘"按钮（openLink 跳转到事件与风险看板 URL）
  - [x] 3.2 修改 workflow 通知消息，增加仪表盘链接

- [x] Task 4: 端到端验证
  - [x] 4.1 启动 backend + ewoh-feishu-app，确认数据同步到多维表格
  - [x] 4.2 在飞书打开 3 个仪表盘，确认组件渲染真实数据
  - [x] 4.3 触发事件，确认告警卡片含仪表盘跳转按钮
  - [x] 4.4 在多维表格改事件状态，确认 workflow 通知含仪表盘链接

# Task Dependencies
- Task 2 depends on Task 1（需要仪表盘 ID）
- Task 3 depends on Task 1（需要仪表盘 URL）
- Task 4 depends on Task 1, 2, 3
