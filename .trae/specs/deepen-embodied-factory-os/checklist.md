# Checklist

## 阶段 A：数据库与后端基础
- [ ] 8 张新表在妙搭 PostgreSQL 中创建成功（ewoh_spatial_entity / ewoh_topology / ewoh_world_state / ewoh_event_chain / ewoh_schedule_plan / ewoh_schedule_audit / ewoh_model_registry / ewoh_environment）
- [ ] 空间实体种子数据植入成功（1 工厂 + 1 车间 + 1 产线 + 2 区域 + 4 工位 + 8 设备 + 8 人员 + 4 摄像头 + 3 UWB 基站 = 31 个实体）
- [ ] schema.ts 已同步新表定义
- [ ] shared/api.interface.ts 包含所有新类型定义

## 阶段 B：数据模拟器
- [ ] SimulatorModule 创建并注册到 app.module.ts
- [ ] 模拟器每 4 秒生成遥测数据写入 ewoh_telemetry
- [ ] 模拟器更新 ewoh_device 的电量和在线状态
- [ ] 模拟器更新 ewoh_world_state 的人员位置
- [ ] 模拟器在负荷超阈值/低电量/失联时写入 ewoh_event + ewoh_event_chain
- [ ] 模拟器每 10 秒生成环境数据写入 ewoh_environment
- [ ] 模拟器在应用启动时自动开始
- [ ] 所有模拟数据标记 source_type='simulated'

## 阶段 C：后端 API 模块
- [ ] SpatialModule：GET /api/spatial/entities 返回空间实体列表（支持过滤）
- [ ] SpatialModule：GET /api/spatial/entities/:entityId 返回单实体详情
- [ ] SpatialModule：GET /api/spatial/topology 返回拓扑关系
- [ ] SpatialModule：GET /api/spatial/hierarchy 返回层级树
- [ ] WorldModule：GET /api/world/state 返回当前世界状态快照
- [ ] WorldModule：GET /api/world/events/chain/:eventId 返回事件因果链
- [ ] WorldModule：GET /api/world/replay 返回时间轴回放数据
- [ ] SchedulerModule：POST /api/scheduler/plans 生成 3+ 方案并写入数据库
- [ ] SchedulerModule：GET /api/scheduler/plans 查询方案列表
- [ ] SchedulerModule：POST /api/scheduler/plans/:planId/confirm 确认方案（需 reason）+ 写入审计
- [ ] SchedulerModule：GET /api/scheduler/audit 查询审计记录
- [ ] SchedulerModule：GET/PUT /api/scheduler/weights 权重配置

## 阶段 D：React 指挥地图核心
- [ ] 前端 API 客户端：spatial.ts / world.ts / scheduler.ts 创建完成
- [ ] CommandMap.tsx 全屏布局实现（顶部+左侧+中央+右侧+底部）
- [ ] FactoryMap.tsx SVG 地图渲染区域/工位/设备/人员/摄像头/UWB
- [ ] FactoryMap.tsx 支持 L0/L1 切换（L1 含摄像头视锥/UWB 覆盖）
- [ ] FactoryMap.tsx 实体可点击选中
- [ ] ModePanel.tsx 9 种地图模式切换
- [ ] EntityDetail.tsx 实体详情面板
- [ ] TopBar.tsx KPI 栏
- [ ] 地图 2 秒轮询刷新动态实体
- [ ] 地图模式切换时实体着色变化
- [ ] TimelinePanel.tsx 时间轴回放（实时/暂停/倍速/跳转）
- [ ] EventCenterPanel.tsx 事件中心
- [ ] SchedulePanel.tsx 调度方案比较（分项指标对比 + 确认 + 理由输入）
- [ ] WorkbenchPanel.tsx 班组长工作台
- [ ] 底部标签栏切换逻辑正常

## 阶段 E：构建与发布
- [ ] TypeScript 类型检查通过
- [ ] 后端构建成功
- [ ] 前端构建成功
- [ ] prune-smart 裁剪成功
- [ ] 代码推送到 sprint/default
- [ ] 妙搭发布创建成功（status: finished）
- [ ] 在线 URL 指挥地图页面加载正常（非 iframe）
- [ ] 在线 URL 指挥地图显示实时数据（非 sample data）
- [ ] 在线 URL 调度方案生成和确认功能正常
