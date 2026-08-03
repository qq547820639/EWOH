# Tasks

> 深化 `build-embodied-factory-os` 的妙搭应用实现质量。从 iframe 静态文件 + sample data 升级为 React 原生组件 + NestJS API + 妙搭 PostgreSQL 活数据。
> 所有工作在 `ewoh-spark-app/` 内完成，最终构建发布到妙搭云端 `app_17b7bgq1e4a`。

## 阶段 A：数据库与后端基础
- [ ] Task 1: 扩展妙搭 PostgreSQL 数据库 schema
  - [ ] 1.1 创建 SQL 脚本：新增 ewoh_spatial_entity / ewoh_topology / ewoh_world_state / ewoh_event_chain / ewoh_schedule_plan / ewoh_schedule_audit / ewoh_model_registry / ewoh_environment 8 张表
  - [ ] 1.2 用 `lark-cli apps +db-execute` 在妙搭 PostgreSQL 执行建表
  - [ ] 1.3 用 `lark-cli apps +db-execute` 植入空间实体种子数据（1 工厂 + 1 车间 + 1 产线 + 2 区域 + 4 工位 + 8 设备 + 8 人员 + 4 摄像头 + 3 UWB 基站）
  - [ ] 1.4 运行 `npm run gen:db-schema` 同步 schema.ts
- [ ] Task 2: 扩展 shared/api.interface.ts 类型定义
  - [ ] 2.1 新增 SpatialEntity / Topology / WorldState / EventChain / SchedulePlan / ScheduleAudit / ModelRegistry / Environment 类型
  - [ ] 2.2 扩展现有 DeviceInfo / EventInfo 增加空间字段（entity_id / x / y）

## 阶段 B：数据模拟器
- [ ] Task 3: 实现 SimulatorModule 数据模拟器
  - [ ] 3.1 创建 `server/modules/simulator/simulator.module.ts` + `simulator.service.ts` + `simulator.controller.ts`
  - [ ] 3.2 实现 SimulatorService：维护 8 台设备 + 8 名人员的运行状态（位置/电量/负荷/疲劳/任务），每 4 秒生成遥测数据写入 ewoh_telemetry + 更新 ewoh_device
  - [ ] 3.3 实现人员位置移动模拟：人员在工位间移动，更新 ewoh_world_state
  - [ ] 3.4 实现事件触发模拟：负荷超阈值/电量低于 20%/失联/禁区进入时写入 ewoh_event + ewoh_event_chain
  - [ ] 3.5 实现环境数据模拟：每 10 秒生成温度/振动/噪声/空气质量写入 ewoh_environment
  - [ ] 3.6 实现启动/停止控制 API（`/api/simulator/start` `/api/simulator/stop` `/api/simulator/status`），应用启动时自动开始
  - [ ] 3.7 注册 SimulatorModule 到 app.module.ts，在 onModuleInit 中自动启动模拟器

## 阶段 C：后端 API 模块
- [ ] Task 4: 实现 SpatialModule 空间 API
  - [ ] 4.1 创建 `server/modules/spatial/spatial.module.ts` + `spatial.service.ts` + `spatial.controller.ts`
  - [ ] 4.2 实现 GET `/api/spatial/entities`（支持 type / parent_id 过滤）
  - [ ] 4.3 实现 GET `/api/spatial/entities/:entityId`（单实体详情）
  - [ ] 4.4 实现 GET `/api/spatial/topology`（拓扑关系列表）
  - [ ] 4.5 实现 GET `/api/spatial/hierarchy`（层级树）
  - [ ] 4.6 注册 SpatialModule 到 app.module.ts
- [ ] Task 5: 实现 WorldModule 世界模型 API
  - [ ] 5.1 创建 `server/modules/world/world.module.ts` + `world.service.ts` + `world.controller.ts`
  - [ ] 5.2 实现 GET `/api/world/state`（当前世界状态快照：关联 ewoh_device + ewoh_world_state + ewoh_telemetry 最新值）
  - [ ] 5.3 实现 GET `/api/world/events/chain/:eventId`（事件因果链）
  - [ ] 5.4 实现 GET `/api/world/replay`（时间轴回放数据，支持 from/to 参数，返回时间范围内的世界状态快照序列）
  - [ ] 5.5 注册 WorldModule 到 app.module.ts
- [ ] Task 6: 实现 SchedulerModule 调度 API
  - [ ] 6.1 创建 `server/modules/scheduler/scheduler.module.ts` + `scheduler.service.ts` + `scheduler.controller.ts`
  - [ ] 6.2 实现 POST `/api/scheduler/plans`（生成 3 个方案：保持现状/产能优先/负荷均衡，每个含 strategy/takt_improvement/high_load_persons/low_battery_risk/affected_persons/metrics/reason，写入 ewoh_schedule_plan）
  - [ ] 6.3 实现 GET `/api/scheduler/plans`（查询方案列表，支持 status 过滤）
  - [ ] 6.4 实现 POST `/api/scheduler/plans/:planId/confirm`（确认方案，需 body.reason，写入 ewoh_schedule_audit，更新方案 status）
  - [ ] 6.5 实现 GET `/api/scheduler/audit`（审计记录列表）
  - [ ] 6.6 实现 GET/PUT `/api/scheduler/weights`（权重配置，存内存默认值，PUT 记录调整前后值）
  - [ ] 6.7 注册 SchedulerModule 到 app.module.ts

## 阶段 D：React 指挥地图核心
- [ ] Task 7: 创建前端 API 客户端
  - [ ] 7.1 创建 `client/src/api/spatial.ts`（getEntities / getEntity / getTopology / getHierarchy）
  - [ ] 7.2 创建 `client/src/api/world.ts`（getWorldState / getEventChain / getReplay）
  - [ ] 7.3 创建 `client/src/api/scheduler.ts`（getPlans / generatePlans / confirmPlan / getAudit / getWeights / updateWeights）
- [ ] Task 8: 实现 React 指挥地图核心组件
  - [ ] 8.1 创建 `client/src/pages/CommandMap/CommandMap.tsx`（全屏布局：顶部 KPI 栏 + 左侧面板 + 中央地图 + 右侧面板 + 底部标签栏）
  - [ ] 8.2 实现 `client/src/pages/CommandMap/FactoryMap.tsx`（SVG 工厂地图：渲染区域/工位/设备/人员/摄像头/UWB/路线，支持 L0/L1 切换，实体可点击选中）
  - [ ] 8.3 实现 `client/src/pages/CommandMap/ModePanel.tsx`（左侧 9 种地图模式切换：生产/人员/外骨骼/人体负荷/安全风险/设备/环境/调度/数据质量）
  - [ ] 8.4 实现 `client/src/pages/CommandMap/EntityDetail.tsx`（右侧实体详情面板：显示选中实体的 ID/位置/状态/来源/置信度/版本等）
  - [ ] 8.5 实现 `client/src/pages/CommandMap/TopBar.tsx`（顶部 KPI 栏：班次/在线设备/在岗人员/未结事件/当前产量）
  - [ ] 8.6 实现 2 秒轮询刷新动态实体（useQuery refetchInterval: 2000）
  - [ ] 8.7 根据地图模式改变实体着色（人体负荷模式按 loadScore 着色，安全风险模式按 severity 着色等）
- [ ] Task 9: 实现指挥地图底部标签页
  - [ ] 9.1 实现 `client/src/pages/CommandMap/TimelinePanel.tsx`（时间轴：实时/暂停/倍速 1x/2x/5x/跳转事件，回放时调用 /api/world/replay）
  - [ ] 9.2 实现 `client/src/pages/CommandMap/EventCenterPanel.tsx`（事件中心：事件列表 + 过滤 + 详情，调用 /api/dashboard/events）
  - [ ] 9.3 实现 `client/src/pages/CommandMap/SchedulePanel.tsx`（调度方案比较：方案列表 + 分项指标对比表格 + 确认按钮 + 理由输入，调用 /api/scheduler/*）
  - [ ] 9.4 实现 `client/src/pages/CommandMap/WorkbenchPanel.tsx`（班组长工作台：班次概览 KPI + 待审批方案 + 需关注事件 + 快速操作）
  - [ ] 9.5 底部标签栏切换逻辑（同时只显示一个面板）

## 阶段 E：构建与发布
- [ ] Task 10: 构建并发布到妙搭云端
  - [ ] 10.1 TypeScript 类型检查通过（`npm run type:check`）
  - [ ] 10.2 构建后端（`npm run build:server`）
  - [ ] 10.3 构建前端（`npm run build:client`）
  - [ ] 10.4 执行 prune-smart 裁剪 node_modules
  - [ ] 10.5 提交并推送到 sprint/default
  - [ ] 10.6 创建妙搭发布（`lark-cli apps +release-create`）
  - [ ] 10.7 验证在线 URL 指挥地图功能正常

# Task Dependencies
- Task 2 依赖 Task 1（schema 同步后才能定义类型）
- Task 3 依赖 Task 1（模拟器写入新表）
- Task 4/5/6 依赖 Task 1/2（API 操作新表 + 类型定义）
- Task 7 依赖 Task 4/5/6（前端 API 客户端对应后端端点）
- Task 8 依赖 Task 7（地图组件调用 API 客户端）
- Task 9 依赖 Task 8（标签页是地图的子组件）
- Task 10 依赖 Task 3/4/5/6/8/9（全部完成后构建发布）
- Task 4/5/6 可并行（独立 API 模块）
- Task 8 的子任务 8.1-8.5 可并行（独立组件）
- Task 9 的子任务 9.1-9.4 可并行（独立面板）
