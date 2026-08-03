# 真机数据直连 + 游戏化体验 + 飞书闭环 — 任务清单

> 对应 spec：`./spec.md`
> 阶段依赖：A → B → C → D（真机线）；E → F → G（游戏化线）；H（飞书线，可并行）；I（构建发布，最后）
> 原则：不偷懒，每个子任务都要完整实现，不留 stub

---

## 阶段 A：Schema 扩展与同步（基础，阻塞所有后续）

### Task A1：编写 schema 扩展 SQL 脚本
- [ ] A1.1 创建 `scripts/extend-schema-for-real-data.sql`，包含 ewoh_telemetry 扩展 13 列
- [ ] A1.2 包含 ewoh_device 扩展 7 列
- [ ] A1.3 包含 ewoh_event 扩展 3 列（source_type / trigger_record_id / evidence_json）
- [ ] A1.4 包含 ewoh_environment 扩展 3 列
- [ ] A1.5 包含 3 个索引（idx_telemetry_source / idx_telemetry_record / idx_event_source）
- [ ] A1.6 所有 ALTER 用 `ADD COLUMN IF NOT EXISTS` + `DEFAULT`，保证幂等

### Task A2：在妙搭 PostgreSQL 执行 schema 扩展
- [ ] A2.1 通过 lark-cli 在 dev 环境执行 extend-schema-for-real-data.sql
- [ ] A2.2 验证 4 表新列存在（`\d ewoh_telemetry` 等）
- [ ] A2.3 验证索引创建成功
- [ ] A2.4 验证现有模拟数据未被破坏（select count 仍为原值）

### Task A3：同步 Drizzle schema.ts
- [ ] A3.1 在 `server/database/schema.ts` 的 ewohTelemetry 表补充 13 个新列定义
- [ ] A3.2 补充 ewohDevice 7 列、ewohEvent 3 列、ewohEnvironment 3 列
- [ ] A3.3 运行 `npm run type:check:server` 确认类型无误
- [ ] A3.4 更新 `shared/api.interface.ts` 补充 TelemetryRow / DeviceRow 等类型的新字段

### Task A4：将 schema 变更迁移到 online 环境
- [ ] A4.1 执行 `lark-cli apps +db-env-migrate` 或手动在 online 执行 SQL
- [ ] A4.2 验证 online 环境 4 表新列存在
- [ ] A4.3 验证 online 环境索引存在

---

## 阶段 B：规则引擎抽取与模拟器适配

### Task B1：创建 RuleEngineService
- [ ] B1.1 新建 `server/modules/rule-engine/` 模块（rule-engine.module.ts / service.ts）
- [ ] B1.2 实现 `evaluate(telemetryRow)` 方法，含 5 条规则（LOW_BATTERY / HIGH_LOAD / POSTURE_RISK / DEVICE_OFFLINE / DATA_DEGRADED）
- [ ] B1.3 事件去重逻辑（30s 窗口，dedupKey）迁移到此 service
- [ ] B1.4 事件写入时带 source_type（继承自遥测）、trigger_record_id、evidence_json
- [ ] B1.5 POSTURE_RISK 规则：pitch_deg > 45 触发
- [ ] B1.6 DATA_DEGRADED 规则：data_quality='degraded' 连续 3 条触发（需查询最近 3 条）

### Task B2：SimulatorService 适配
- [ ] B2.1 写入 ewoh_telemetry 时补充 source_type='simulated'
- [ ] B2.2 为每条遥测生成 record_id（用 crypto.randomUUID 或 nanoid）
- [ ] B2.3 补充 data_quality='good'、ingested_at=now
- [ ] B2.4 移除 SimulatorService 内的事件触发逻辑，改为调用 RuleEngineService.evaluate()
- [ ] B2.5 环境数据写入时补充 source_type='simulated'
- [ ] B2.6 验证模拟器启动后数据正常写入扩展后的表

---

## 阶段 C：Ingestion 服务（真机接入网关）

### Task C1：创建 Ingest 模块骨架
- [ ] C1.1 新建 `server/modules/ingest/` 模块（ingest.module.ts / controller.ts / service.ts）
- [ ] C1.2 在 app.module.ts 注册 IngestModule
- [ ] C1.3 定义 DTO：ExoskeletonFrameDto（对齐 UnifiedExoFrame 的 to_storage_dict 格式）

### Task C2：实现外骨骼数据接入
- [ ] C2.1 `POST /api/ingest/exoskeleton` 单帧接入
- [ ] C2.2 `POST /api/ingest/exoskeleton/batch` 批量接入（≤100 条）
- [ ] C2.3 字段映射：UnifiedExoFrame → ewoh_telemetry（按 spec §3.3.1 映射表）
- [ ] C2.4 写入 ewoh_device upsert（更新 battery/online/last_telemetry_at/source_type）
- [ ] C2.5 写入后调用 RuleEngineService.evaluate() 触发规则

### Task C3：数据质量校验
- [ ] C3.1 entity_id 非空且在 ewoh_spatial_entity 存在校验（不存在则 400 + 告警事件）
- [ ] C3.2 event_time 时钟漂移保护（超前当前 +5min 标记 invalid）
- [ ] C3.3 battery_pct 范围 0-100 校验（超界标记 data_quality='invalid'）
- [ ] C3.4 packet_loss_pct > 5 自动标记 degraded
- [ ] C3.5 raw_ref 幂等去重（同 SHA256 跳过，返回 200 + skipped 标记）
- [ ] C3.6 返回结构：{ accepted, skipped, record_id, data_quality, events_triggered }

### Task C4：实现环境/摄像头/MES 接入
- [ ] C4.1 `POST /api/ingest/environment` 环境传感器数据接入
- [ ] C4.2 `POST /api/ingest/camera` 摄像头结构化检测结果接入（写 ewoh_world_state）
- [ ] C4.3 `POST /api/ingest/mes` MES 工单事件接入（写 ewoh_event 或 ewoh_schedule_plan）

### Task C5：Ingestion 鉴权与限流
- [ ] C5.1 API Key 鉴权（header `X-Ingest-Key`，环境变量配置）
- [ ] C5.2 限流：单 IP 100 req/min（用 @nestjs/throttler 或自实现）
- [ ] C5.3 请求体大小限制（1MB）

---

## 阶段 D：边缘侧桥接脚本

### Task D1：edge_to_spark.py 桥接脚本
- [ ] D1.1 新建 `src/edge_platform/edge/bridge/edge_to_spark.py`
- [ ] D1.2 从 NyExoA1Adapter 读取 UnifiedExoFrame
- [ ] D1.3 调用 to_storage_dict() 序列化后 POST 到 /api/ingest/exoskeleton
- [ ] D1.4 断线重连（spark-app 不可达时指数退避重试）
- [ ] D1.5 批量缓冲（断网时本地队列，恢复后批量补传，≤100 条/批）
- [ ] D1.6 source_type 透传（real/controlled_test）
- [ ] D1.7 命令行参数：--spark-url / --ingest-key / --device-config / --source-type

### Task D2：桥接脚本测试
- [ ] D2.1 用 SimulatedExoAdapter 产出模拟帧，推送到本地 spark-app
- [ ] D2.2 验证 spark-app 数据库收到数据且 source_type='simulated'（或 controlled_test）
- [ ] D2.3 验证规则引擎触发事件
- [ ] D2.4 模拟断网验证批量补传

---

## 阶段 E：游戏化体验 — 地图操控增强

### Task E1：安装依赖
- [ ] E1.1 `npm install react-zoom-pan-pinch`（client）
- [ ] E1.2 验证依赖安装成功

### Task E2：地图平移与缩放
- [ ] E2.1 在 FactoryMap.tsx 外层包 TransformWrapper / TransformComponent
- [ ] E2.2 配置缩放范围 0.5x - 5x
- [ ] E2.3 滚轮缩放、拖拽平移生效
- [ ] E2.4 双击实体居中放大到 2x
- [ ] E2.5 缩放级别 < 1.5x 时隐藏文字标签
- [ ] E2.6 右上角缩放控件按钮（+ / - / 重置）

### Task E3：实体拖拽（布局编辑）
- [ ] E3.1 引入 @dnd-kit/core（已装）
- [ ] E3.2 工位/设备实体可拖拽（需 admin 模式开关）
- [ ] E3.3 拖拽时显示 10px 对齐网格
- [ ] E3.4 拖拽结束 PATCH /api/spatial/entities/:id 更新 x/y
- [ ] E3.5 toast 确认 + 撤销按钮（5 秒内可撤销）
- [ ] E3.6 后端新增 `PATCH /api/spatial/entities/:id` 接口

### Task E4：实体搜索
- [ ] E4.1 TopBar 新增搜索框（按 entity_id / 名称模糊匹配）
- [ ] E4.2 输入后下拉建议列表（最多 10 条）
- [ ] E4.3 选中后地图居中 + 高亮该实体 + 缩放到 2x
- [ ] E4.4 搜索支持快捷键 `/` 聚焦

### Task E5：快捷键
- [ ] E5.1 新建 useKeyboardShortcuts hook
- [ ] E5.2 1-9 切换 9 种地图模式
- [ ] E5.3 L 切换 L0/L1、T 切换回放、空格暂停/继续、Esc 取消选中、F 全屏
- [ ] E5.4 输入框聚焦时禁用快捷键
- [ ] E5.5 快捷键提示浮层（按 ? 显示）

---

## 阶段 F：场景直接建模 — L2 三维 + 多源融合接入

### Task F1：安装依赖
- [ ] F1.1 `npm install three @react-three/fiber @react-three/drei`（client）
- [ ] F1.2 验证依赖安装成功

### Task F2：L2 三维渲染骨架（Three.js）
- [ ] F2.1 ModePanel 新增 L2 切换按钮
- [ ] F2.2 新建 FactoryMap3D.tsx，用 Canvas 渲染 Three.js 场景
- [ ] F2.3 静态场景层：先建占位盒子工厂验证渲染管线，后接 splat/点云加载
- [ ] F2.4 实现 GaussianSplat 加载器（支持 `.splat`/`.ply`，可先用占位文件验证）
- [ ] F2.5 几何骨架层：点云用 Points + PointsMaterial 渲染（可选叠加，半透明）
- [ ] F2.6 摄像头视锥用 ConeGeometry 半透明渲染
- [ ] F2.7 UWB 覆盖用 SphereGeometry 半透明球
- [ ] F2.8 人员位置用 CapsuleGeometry + 实时移动（复用 worldState 数据）
- [ ] F2.9 OrbitControls 鼠标轨道控制
- [ ] F2.10 射线检测点击实体 → 选中高亮（发光边框）
- [ ] F2.11 L2/L1 切换平滑过渡

### Task F3：L2 数据接入
- [ ] F3.1 复用 useQuery 获取 entities + worldState
- [ ] F3.2 人员位置每 2s 刷新移动
- [ ] F3.3 设备在线状态用颜色区分（绿在线/灰离线/红故障）

### Task F4：建模数据接入接口（后端）
- [ ] F4.1 新增 `POST /api/ingest/spatial-scan` 接口
- [ ] F4.2 接收扫描产物元信息（source_type/splat_url/pointcloud_url/capture_at/scan_device/alignment_error_mm）
- [ ] F4.3 upsert 到 ewoh_spatial_entity（extra 承载建模元信息）
- [ ] F4.4 新增 `POST /api/ingest/location` 接口
- [ ] F4.5 接收定位坐标流（entity_id/locator/confidence/x/y/z/ts）
- [ ] F4.6 写入 ewoh_world_state（state_json 含 locator/confidence/x/y/z）
- [ ] F4.7 复用 X-Ingest-Key 鉴权 + 限流

### Task F5：source_type 扩展与注释
- [ ] F5.1 schema.ts 中 ewoh_spatial_entity.source_type 注释扩展取值
- [ ] F5.2 注释含 lidar_scan/gaussian_splat/uwb_located/visual_slam/seed/simulated
- [ ] F5.3 shared/api.interface.ts 补充 SpatialScanDto / LocationFrameDto 类型

### Task F6：边缘侧建模采集管线骨架
- [ ] F6.1 新建 `src/edge_platform/edge/modeling/` 目录
- [ ] F6.2 splat_collector.py：3DGS 采集指引（照片序列 + Colmap 预处理 + splat 训练任务下发）
- [ ] F6.3 lidar_collector.py：LiDAR 扫描数据接收 + 点云配准（ICP）+ 坐标系对齐
- [ ] F6.4 locator_fusion.py：UWB + Wi-Fi + 视觉定位融合（EKF 或因子图）
- [ ] F6.5 产出推送到 spark-app 的 /api/ingest/spatial-scan 与 /api/ingest/location

---

## 阶段 G：游戏化体验 — 告警弹窗与数据流

### Task G1：实时告警弹窗
- [ ] G1.1 新建 AlertToast 组件（右上角弹窗）
- [ ] G1.2 useQuery 轮询最近 10s 的 L3 事件（每 3s 刷新）
- [ ] G1.3 新事件触发时弹红色卡片（标题/实体ID/时间/查看详情/快速处置）
- [ ] G1.4 5 秒未操作自动收起到告警铃铛
- [ ] G1.5 右上角告警铃铛带未读数 badge
- [ ] G1.6 点击铃铛展开告警列表
- [ ] G1.7 地图上对应实体闪烁箭头指示（SVG animate）

### Task G2：数据流可视化（production 模式）
- [ ] G2.1 在 FactoryMap.tsx production 模式下渲染工位间流动虚线
- [ ] G2.2 虚线 animate 流动效果（stroke-dashoffset 动画）
- [ ] G2.3 产线节拍颜色脉冲（绿快/黄中/红慢，从 worldState 取节拍数据）
- [ ] G2.4 工位上方在制品数量数字气泡

---

## 阶段 G3：游戏玩法机制与具身智能（工厂即具身机器人）

### Task G3.1：玩家角色与权限体系
- [ ] G3.1.1 定义班组长/车间主任/厂长三角色权限矩阵（可见层级 L0-L3 + 可执行操作）
- [ ] G3.1.2 后端新增 `GET /api/auth/role` 返回当前用户角色（从飞书通讯录映射）
- [ ] G3.1.3 前端根据角色控制 ModePanel 层级按钮可见性
- [ ] G3.1.4 前端根据角色控制调度/资源分配操作权限
- [ ] G3.1.5 角色配置写入环境变量或配置表

### Task G3.2：资源分配玩法
- [ ] G3.2.1 新建 ResourcePool 组件（人员/设备/工位三维资源卡片，显示负荷/电量/状态）
- [ ] G3.2.2 支持 L0/L1 地图上拖拽人员/设备到工位（复用 @dnd-kit）
- [ ] G3.2.3 AI 评估：负荷均衡度/技能匹配度/电量续航，输出红/黄/绿评分
- [ ] G3.2.4 分配结果写入 ewoh_schedule_plan（strategy='resource_alloc'）
- [ ] G3.2.5 关联更新 ewoh_spatial_entity（人员 parent_id 指向工位）

### Task G3.3：任务编排玩法
- [ ] G3.3.1 MES 工单接入（/api/ingest/mes）→ 自动分解为工序
- [ ] G3.3.2 新建 TaskOrchestration 画布组件（工序节点 + 依赖连线，拖拽编排）
- [ ] G3.3.3 工序节点可分配到工位/人员
- [ ] G3.3.4 节拍模拟：编排后 AI 模拟产线节拍，预测瓶颈工位与完成时间
- [ ] G3.3.5 编排结果写入 ewoh_schedule_plan（strategy='task_orchest'）
- [ ] G3.3.6 metrics_json 含节拍/瓶颈/完成时间

### Task G3.4：实时决策玩法增强
- [ ] G3.4.1 SchedulerService.generatePlans 从固定模板升级为数据驱动（基于实时 world_state + telemetry）
- [ ] G3.4.2 建议方案含节拍提升/负荷/产量/瓶颈指标
- [ ] G3.4.3 玩家确认后 status='confirmed' + 下发执行层
- [ ] G3.4.4 执行结果回流更新方案 metrics + status
- [ ] G3.4.5 决策记录写入 ewoh_schedule_audit

### Task G3.5：虚拟-现实双向同步
- [ ] G3.5.1 现实→虚拟：确认 2s refetchInterval + 事件即时推送，孪生延迟 <5s
- [ ] G3.5.2 虚拟→现实：confirmed 方案下发执行层（调度下发接口）
- [ ] G3.5.3 新增 `POST /api/schedule/:id/dispatch` 调度下发接口
- [ ] G3.5.4 执行层回传执行确认 + 闭环审计
- [ ] G3.5.5 冲突检测：人员离线但方案仍分配时，大脑标记冲突并提示玩家

### Task G3.6：外骨骼身体共生（肢体下行通道）
- [ ] G3.6.1 外骨骼适配器扩展下行通道（触觉/语音/AR 提示，非控制命令）
- [ ] G3.6.2 新增 `POST /api/exo/:deviceId/feedback` 接口（触觉指令下发）
- [ ] G3.6.3 触觉反馈规则：负荷过高震动/禁区进入阻止/节拍提醒
- [ ] G3.6.4 语音交互：飞书语音 + 外骨骼扬声器播报
- [ ] G3.6.5 状态共生：外骨骼在线=玩家在线，负荷=玩家负荷实时映射到 ewoh_world_state

### Task G3.7：大脑推理决策增强
- [ ] G3.7.1 感知层：Ingestion + RuleEngine 汇聚 skin+limb 全量数据（已规划，确认联通）
- [ ] G3.7.2 记忆层：telemetry/event/schedule 数据持续积累（已具备，确认无丢失）
- [ ] G3.7.3 推理层：generatePlans 增强，从固定模板→数据驱动建议（基于历史记忆）
- [ ] G3.7.4 决策层：proposed→confirmed→执行→结果回流闭环（复用 G3.4）
- [ ] G3.7.5 学习层：决策结果记录到 ewoh_schedule_audit 供后续训练（本期记录，远期训练）

---

## 阶段 H：飞书闭环增强

### Task H1：告警卡片跳转指挥地图
- [ ] H1.1 定位当前飞书告警卡片发送逻辑（ewoh-feishu-app/server/ 或 spark-app 内）
- [ ] H1.2 卡片新增「查看指挥地图」按钮
- [ ] H1.3 按钮 URL: `https://xqjyctsd.aiforce.cloud/app/app_17b7bgq1e4a?event_id=xxx`
- [ ] H1.4 event_id 从事件记录取
- [ ] H1.5 测试卡片在飞书 IM 内点击跳转

### Task H2：指挥地图读 event_id 参数
- [ ] H2.1 CommandMap.tsx 读取 URL query param `event_id`
- [ ] H2.2 有 event_id 时自动调用 `GET /api/events/:id` 获取事件详情
- [ ] H2.3 自动选中事件关联的实体（deviceId 对应的 entity）
- [ ] H2.4 自动切换到回放模式 + 滚动到事件发生时刻
- [ ] H2.5 右侧 EntityDetail 展示事件信息

### Task H3：处置闭环回写
- [ ] H3.1 后端新增 `POST /api/events/:id/handle` 接口
- [ ] H3.2 接收 handler_action / handler_note，更新 ewoh_event.status='handled'
- [ ] H3.3 前端事件中心新增「处置」按钮 + 处置弹窗（action 输入 + note 输入）
- [ ] H3.4 飞书卡片「快速处置」按钮回调此接口
- [ ] H3.5 处置后 toast 确认 + 刷新事件列表

### Task H4：飞书工作台入口验证
- [ ] H4.1 确认妙搭应用已发布且工作台可见
- [ ] H4.2 搜索"EWOH"可找到应用
- [ ] H4.3 飞书内打开自动登录

---

## 阶段 I：构建与发布

### Task I1：类型检查与构建
- [ ] I1.1 `npm run type:check:server` 通过
- [ ] I1.2 `npm run type:check:client` 通过
- [ ] I1.3 `npm run build:server` 通过
- [ ] I1.4 `npm run build:client` 通过

### Task I2：完整构建
- [ ] I2.1 `npm run build` 通过（含 prune-smart）
- [ ] I2.2 dist/server + dist/client 产物完整
- [ ] I2.3 本地 `node dist/server/main.js` 启动验证

### Task I3：发布到妙搭云端
- [ ] I3.1 推送代码到 sprint/default 分支
- [ ] I3.2 通知用户手动发布到 online
- [ ] I3.3 验证 online 环境模拟器运行
- [ ] I3.4 验证 online 环境指挥地图可访问
- [ ] I3.5 验证 online 环境 schema 扩展生效

---

## 任务依赖关系

```
A (schema) ──→ B (规则引擎+模拟器适配) ──→ C (ingestion) ──→ D (桥接脚本)
                                            │
E (地图操控) ──→ F (场景直接建模/L2)         │
G (告警弹窗+数据流)                          │
                                            ↓
G3 (游戏玩法+具身智能: 角色权限/资源分配/任务编排/双向同步/外骨骼/大脑)
                                            │
                                            ↓
H (飞书闭环) ←───────────────────────────────┘
                                            │
                                            ↓
                                       I (构建发布)
```

E/F/G/G3/H 可与 C/D 并行，但都依赖 A 完成。G3 依赖 C（ingestion 提供真机数据）和 B（规则引擎提供事件）。
