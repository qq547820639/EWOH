# Tasks

- [x] Task 1: 扩展后端设备查询接口，支持多条件搜索与排序
  - [x] SubTask 1.1: 在 `shared/api.interface.ts` 扩展 `DeviceInfo` 字段（entityId/parentId/boundPersonId/boundPersonName/sourceType 等），新增 `DeviceSearchQuery` 类型
  - [x] SubTask 1.2: 在 `dashboard.service.ts` 的 `getDevices` 实现 keyword/online/batteryMin/batteryMax/sourceType/model/orderby 过滤，LEFT JOIN `ewoh_spatial_entity` 获取 entityId/parentId，LEFT JOIN 人员实体获取 boundPersonId/boundPersonName
  - [x] SubTask 1.3: 在 `dashboard.controller.ts` 的 `getDevices` 接收新增 Query 参数并透传

- [x] Task 2: 实现设备 CRUD 与绑定 API
  - [x] SubTask 2.1: 在 `shared/api.interface.ts` 新增 `CreateDeviceDto` / `UpdateDeviceDto` / `DeviceBinding` / `BindDeviceRequest` 类型
  - [x] SubTask 2.2: 在 `dashboard.service.ts` 实现 `createDevice`（含 deviceId 重复校验）、`updateDevice`（PATCH 部分字段）、`getDeviceBindings`（查询 parentId 链路与人员绑定）、`bindDevice`（更新 spatial_entity.parentId + 人员 extra.device_id + 设备 extra.worker_id 双向绑定）、`unbindDevice`
  - [x] SubTask 2.3: 在 `dashboard.controller.ts` 新增 `POST /devices`、`PATCH /devices/:deviceId`、`GET /devices/:deviceId/bindings`、`POST /devices/:deviceId/bindings`、`DELETE /devices/:deviceId/bindings` 端点

- [x] Task 3: 前端 API 封装
  - [x] SubTask 3.1: 在 `client/src/api/dashboard.ts` 新增 `searchDevices(query)`、`createDevice(body)`、`updateDevice(deviceId, body)`、`getDeviceBindings(deviceId)`、`bindDevice(deviceId, body)`、`unbindDevice(deviceId)` 函数

- [x] Task 4: 重构 Devices 页面，增加搜索栏与设备列表
  - [x] SubTask 4.1: 在 `Devices.tsx` 顶部新增搜索栏组件（关键字输入、在线状态下拉、电量区间、来源类型、型号、排序），使用 `searchDevices` 查询
  - [x] SubTask 4.2: 设备列表表格新增「来源」「绑定工位」「绑定人员」列，每行增加「编辑」「绑定」操作按钮
  - [x] SubTask 4.3: 空状态与加载状态处理

- [x] Task 5: 实现设备配置抽屉组件
  - [x] SubTask 5.1: 新增 `DeviceConfigDrawer.tsx`，支持查看/编辑设备元信息（workerName/deviceModel/firmwareVersion 等）与运行状态（online/batteryPct/faultCode）
  - [x] SubTask 5.2: 抽屉支持「新增设备」模式（deviceId 可编辑）与「编辑设备」模式（deviceId 只读）
  - [x] SubTask 5.3: 保存调用 `createDevice` 或 `updateDevice`，成功后刷新列表

- [x] Task 6: 实现层级绑定面板
  - [x] SubTask 6.1: 在 `DeviceConfigDrawer.tsx` 内新增「绑定关系」区块，调用 `getDeviceBindings` 展示当前建筑层级路径与绑定人员
  - [x] SubTask 6.2: 新增空间实体层级树选择器（调用 `getHierarchy` 渲染树，仅允许选择 workstation/production_line/zone/workshop/factory 类型节点作为 parentId）
  - [x] SubTask 6.3: 新增人员下拉选择器（调用 `getEntities({type:'person'})`），选择后调用 `bindDevice`
  - [x] SubTask 6.4: 提供「解绑」按钮调用 `unbindDevice`

- [x] Task 7: 构建验证
  - [x] SubTask 7.1: 运行 `npm run type:check:server` 与 `npm run type:check:client` 确认无类型错误
  - [x] SubTask 7.2: 运行 `npm run build:server` 与 `npm run build:client` 确认构建通过

# Task Dependencies

- Task 2 依赖 Task 1（类型定义先行）
- Task 3 依赖 Task 2（API 端点就绪后封装前端函数）
- Task 4 依赖 Task 3（前端 API 就绪后重构页面）
- Task 5 依赖 Task 3（抽屉调用前端 API）
- Task 6 依赖 Task 5（绑定面板嵌入配置抽屉）
- Task 7 依赖 Task 1-6 全部完成
