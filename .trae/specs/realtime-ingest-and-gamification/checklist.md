# 真机数据直连 + 游戏化体验 + 飞书闭环 — 验收检查清单

> 对应 spec：`./spec.md` / tasks：`./tasks.md`
> 每项检查需实际验证通过方可勾选，不可凭推测。

---

## 阶段 A：Schema 扩展与同步

- [ ] A-01 `scripts/extend-schema-for-real-data.sql` 文件存在且包含 4 表 ALTER 语句
- [ ] A-02 ewoh_telemetry 新增 13 列：source_type / record_id / ingested_at / raw_ref / joint_angles / angular_velocity_dps / assist_level / torque_nm / cumulative_load_score / temperature_c / fault_code / packet_loss_pct / data_confidence / data_quality
- [ ] A-03 ewoh_device 新增 7 列：source_type / firmware_version / hardware_version / protocol_version / temperature_c / fault_code / last_raw_ref
- [ ] A-04 ewoh_event 新增 3 列：source_type / trigger_record_id / evidence_json
- [ ] A-05 ewoh_environment 新增 3 列：source_type / record_id / data_confidence
- [ ] A-06 3 个索引创建成功：idx_telemetry_source / idx_telemetry_record / idx_event_source
- [ ] A-07 dev 环境执行 SQL 成功，4 表新列存在
- [ ] A-08 现有模拟数据未丢失（select count 与扩展前一致）
- [ ] A-09 `server/database/schema.ts` 已同步新列定义
- [ ] A-10 `shared/api.interface.ts` 已补充 TelemetryRow / DeviceRow / EventRow 新字段类型
- [ ] A-11 `npm run type:check:server` 通过
- [ ] A-12 online 环境新列存在（db-env-migrate 或手动执行成功）

---

## 阶段 B：规则引擎抽取与模拟器适配

- [ ] B-01 `server/modules/rule-engine/` 模块存在（module / service 文件齐备）
- [ ] B-02 RuleEngineService.evaluate(telemetryRow) 方法存在
- [ ] B-03 5 条规则实现：LOW_BATTERY / HIGH_LOAD / POSTURE_RISK / DEVICE_OFFLINE / DATA_DEGRADED
- [ ] B-04 事件去重逻辑（30s 窗口 + dedupKey）在 RuleEngineService 中
- [ ] B-05 事件写入带 source_type / trigger_record_id / evidence_json
- [ ] B-06 POSTURE_RISK 规则：pitch_deg > 45 触发
- [ ] B-07 DATA_DEGRADED 规则：连续 3 条 degraded 触发
- [ ] B-08 SimulatorService 写入遥测带 source_type='simulated'
- [ ] B-09 SimulatorService 写入遥测带 record_id（非空 UUID）
- [ ] B-10 SimulatorService 写入遥测带 data_quality='good'
- [ ] B-11 SimulatorService 事件触发已迁移到 RuleEngineService.evaluate()
- [ ] B-12 模拟器启动后数据正常写入扩展后的表（无报错）
- [ ] B-13 模拟器环境数据带 source_type='simulated'

---

## 阶段 C：Ingestion 服务

- [ ] C-01 `server/modules/ingest/` 模块存在并已注册到 app.module.ts
- [ ] C-02 ExoskeletonFrameDto 定义对齐 UnifiedExoFrame.to_storage_dict() 格式
- [ ] C-03 `POST /api/ingest/exoskeleton` 单帧接入可用
- [ ] C-04 `POST /api/ingest/exoskeleton/batch` 批量接入可用（≤100 条）
- [ ] C-05 字段映射正确：entity_id→device_id、pose.trunk_pitch_deg→pitch_deg 等 17 项映射
- [ ] C-06 写入 ewoh_device upsert 正确（更新 battery/online/last_telemetry_at）
- [ ] C-07 写入后调用 RuleEngineService.evaluate() 触发规则
- [ ] C-08 entity_id 不存在时返回 400 + 告警事件
- [ ] C-09 event_time 超前 +5min 标记 data_quality='invalid'
- [ ] C-10 battery_pct 超界标记 data_quality='invalid'
- [ ] C-11 packet_loss_pct > 5 标记 data_quality='degraded'
- [ ] C-12 raw_ref 重复时跳过（幂等去重）返回 200 + skipped
- [ ] C-13 返回结构含 accepted / skipped / record_id / data_quality / events_triggered
- [ ] C-14 `POST /api/ingest/environment` 可用
- [ ] C-15 `POST /api/ingest/camera` 可用
- [ ] C-16 `POST /api/ingest/mes` 可用
- [ ] C-17 X-Ingest-Key 鉴权生效（无 key 或错误 key 返回 401）
- [ ] C-18 限流 100 req/min 生效（超限返回 429）
- [ ] C-19 请求体大小限制 1MB 生效

---

## 阶段 D：边缘侧桥接脚本

- [ ] D-01 `src/edge_platform/edge/bridge/edge_to_spark.py` 文件存在
- [ ] D-02 可从 NyExoA1Adapter 读取 UnifiedExoFrame
- [ ] D-03 调用 to_storage_dict() 序列化后 POST 到 /api/ingest/exoskeleton
- [ ] D-04 断线重连（指数退避）生效
- [ ] D-05 批量缓冲（断网本地队列，恢复后补传）生效
- [ ] D-06 source_type 透传正确
- [ ] D-07 命令行参数 --spark-url / --ingest-key / --device-config / --source-type 可用
- [ ] D-08 用 SimulatedExoAdapter 端到端测试：数据进入 spark-app 数据库
- [ ] D-09 规则引擎在桥接场景下触发事件
- [ ] D-10 模拟断网后批量补传验证通过

---

## 阶段 E：地图操控增强

- [ ] E-01 `react-zoom-pan-pinch` 已安装
- [ ] E-02 FactoryMap 外层包 TransformWrapper / TransformComponent
- [ ] E-03 滚轮缩放 0.5x-5x 生效
- [ ] E-04 拖拽平移生效
- [ ] E-05 双击实体居中放大到 2x
- [ ] E-06 缩放 < 1.5x 隐藏文字标签
- [ ] E-07 右上角缩放控件按钮（+ / - / 重置）可用
- [ ] E-08 admin 模式开关存在
- [ ] E-09 工位/设备实体可拖拽（admin 模式下）
- [ ] E-10 拖拽时显示 10px 对齐网格
- [ ] E-11 拖拽结束 PATCH /api/spatial/entities/:id 更新成功
- [ ] E-12 拖拽结束 toast 确认 + 5 秒撤销按钮
- [ ] E-13 `PATCH /api/spatial/entities/:id` 后端接口存在且可用
- [ ] E-14 TopBar 搜索框存在
- [ ] E-15 输入 entity_id / 名称模糊匹配 + 下拉建议（最多 10 条）
- [ ] E-16 选中建议后地图居中 + 高亮 + 缩放到 2x
- [ ] E-17 `/` 聚焦搜索框
- [ ] E-18 useKeyboardShortcuts hook 存在
- [ ] E-19 1-9 切换 9 种地图模式生效
- [ ] E-20 L 切换 L0/L1、T 切换回放生效
- [ ] E-21 空格暂停/继续、Esc 取消选中、F 全屏生效
- [ ] E-22 输入框聚焦时快捷键禁用
- [ ] E-23 `?` 显示快捷键提示浮层

---

## 阶段 F：场景直接建模 — L2 三维 + 多源融合接入

- [ ] F-01 `three` / `@react-three/fiber` / `@react-three/drei` 已安装
- [ ] F-02 ModePanel 新增 L2 切换按钮
- [ ] F-03 FactoryMap3D.tsx 存在，用 Canvas 渲染
- [ ] F-04 占位盒子工厂验证渲染管线成功
- [ ] F-05 GaussianSplat 加载器实现，支持 `.splat`/`.ply`
- [ ] F-06 点云 Points + PointsMaterial 渲染（可选叠加，半透明）
- [ ] F-07 摄像头视锥 ConeGeometry 半透明渲染
- [ ] F-08 UWB 覆盖 SphereGeometry 半透明球
- [ ] F-09 人员位置 CapsuleGeometry + 实时移动
- [ ] F-10 OrbitControls 鼠标轨道控制生效
- [ ] F-11 射线检测点击实体 → 选中高亮（发光边框）
- [ ] F-12 L2/L1 切换平滑过渡
- [ ] F-13 useQuery 获取 entities + worldState 数据接入
- [ ] F-14 人员位置每 2s 刷新移动
- [ ] F-15 设备在线状态颜色区分（绿在线/灰离线/红故障）
- [ ] F-16 `POST /api/ingest/spatial-scan` 接口存在且可用
- [ ] F-17 接收扫描产物元信息并 upsert 到 ewoh_spatial_entity
- [ ] F-18 extra 承载 splat_url/pointcloud_url/capture_at/scan_device/alignment_error_mm
- [ ] F-19 `POST /api/ingest/location` 接口存在且可用
- [ ] F-20 接收定位坐标流并写入 ewoh_world_state
- [ ] F-21 state_json 含 locator/confidence/x/y/z
- [ ] F-22 X-Ingest-Key 鉴权 + 限流生效
- [ ] F-23 schema.ts 中 source_type 注释扩展（lidar_scan/gaussian_splat/uwb_located/visual_slam）
- [ ] F-24 shared/api.interface.ts 含 SpatialScanDto / LocationFrameDto 类型
- [ ] F-25 `src/edge_platform/edge/modeling/` 目录存在
- [ ] F-26 splat_collector.py 存在（3DGS 采集指引）
- [ ] F-27 lidar_collector.py 存在（LiDAR 配准）
- [ ] F-28 locator_fusion.py 存在（UWB+Wi-Fi+视觉融合）
- [ ] F-29 边缘侧产出可推送到 /api/ingest/spatial-scan 与 /api/ingest/location

---

## 阶段 G：告警弹窗与数据流

- [ ] G-01 AlertToast 组件存在
- [ ] G-02 useQuery 轮询最近 10s 的 L3 事件（每 3s 刷新）
- [ ] G-03 新 L3 事件触发右上角红色弹窗卡片
- [ ] G-04 弹窗含：事件标题 / 实体ID / 时间 / 查看详情 / 快速处置
- [ ] G-05 5 秒未操作自动收起到告警铃铛
- [ ] G-06 右上角告警铃铛带未读数 badge
- [ ] G-07 点击铃铛展开告警列表
- [ ] G-08 地图上对应实体闪烁箭头指示（SVG animate）
- [ ] G-09 production 模式下工位间流动虚线渲染
- [ ] G-10 虚线 stroke-dashoffset 流动动画
- [ ] G-11 产线节拍颜色脉冲（绿快/黄中/红慢）
- [ ] G-12 工位上方在制品数量数字气泡

---

## 阶段 G3：游戏玩法机制与具身智能

**玩家角色与权限**
- [ ] G3-01 班组长/车间主任/厂长三角色权限矩阵定义
- [ ] G3-02 `GET /api/auth/role` 返回当前用户角色
- [ ] G3-03 前端根据角色控制层级按钮可见性
- [ ] G3-04 前端根据角色控制调度/资源分配操作权限

**资源分配玩法**
- [ ] G3-05 ResourcePool 组件存在（人员/设备/工位资源卡片）
- [ ] G3-06 L0/L1 地图可拖拽人员/设备到工位
- [ ] G3-07 AI 评估输出红/黄/绿评分（负荷均衡/技能匹配/电量续航）
- [ ] G3-08 分配结果写入 ewoh_schedule_plan(strategy='resource_alloc')
- [ ] G3-09 ewoh_spatial_entity 人员 parent_id 关联更新

**任务编排玩法**
- [ ] G3-10 MES 工单接入并自动分解为工序
- [ ] G3-11 TaskOrchestration 画布组件存在（工序节点 + 依赖连线）
- [ ] G3-12 工序节点可分配到工位/人员
- [ ] G3-13 节拍模拟预测瓶颈工位与完成时间
- [ ] G3-14 编排结果写入 ewoh_schedule_plan(strategy='task_orchest')
- [ ] G3-15 metrics_json 含节拍/瓶颈/完成时间

**实时决策玩法**
- [ ] G3-16 generatePlans 从固定模板升级为数据驱动建议
- [ ] G3-17 建议方案含节拍提升/负荷/产量/瓶颈指标
- [ ] G3-18 玩家确认后 status='confirmed' + 下发执行
- [ ] G3-19 执行结果回流更新方案 metrics + status
- [ ] G3-20 决策记录写入 ewoh_schedule_audit

**虚拟-现实双向同步**
- [ ] G3-21 现实→虚拟：传感器数据到孪生场景延迟 < 5s
- [ ] G3-22 虚拟→现实：confirmed 方案下发执行层
- [ ] G3-23 `POST /api/schedule/:id/dispatch` 调度下发接口存在
- [ ] G3-24 执行层回传执行确认 + 闭环审计
- [ ] G3-25 冲突检测：人员离线但方案仍分配时标记冲突并提示

**外骨骼身体共生（肢体）**
- [ ] G3-26 外骨骼适配器下行通道扩展（触觉/语音/AR，非控制命令）
- [ ] G3-27 `POST /api/exo/:deviceId/feedback` 接口存在
- [ ] G3-28 触觉反馈规则生效（负荷过高震动/禁区阻止/节拍提醒）
- [ ] G3-29 语音交互通道（飞书语音 + 外骨骼扬声器）
- [ ] G3-30 状态共生：外骨骼在线=玩家在线，负荷=玩家负荷实时映射

**大脑推理决策**
- [ ] G3-31 感知层：Ingestion + RuleEngine 汇聚 skin+limb 全量数据
- [ ] G3-32 记忆层：telemetry/event/schedule 数据持续积累无丢失
- [ ] G3-33 推理层：generatePlans 基于历史记忆生成数据驱动建议
- [ ] G3-34 决策层：proposed→confirmed→执行→结果回流闭环
- [ ] G3-35 学习层：决策结果记录到 ewoh_schedule_audit 供后续训练

---

## 阶段 H：飞书闭环

- [ ] H-01 飞书告警卡片含「查看指挥地图」按钮
- [ ] H-02 按钮 URL 含 event_id 参数
- [ ] H-03 卡片在飞书 IM 内点击可跳转到妙搭应用
- [ ] H-04 CommandMap.tsx 读取 URL query param event_id
- [ ] H-05 有 event_id 时调用 GET /api/events/:id 获取详情
- [ ] H-06 自动选中事件关联实体（deviceId → entity）
- [ ] H-07 自动切换回放模式 + 滚动到事件时刻
- [ ] H-08 右侧 EntityDetail 展示事件信息
- [ ] H-09 `POST /api/events/:id/handle` 后端接口存在
- [ ] H-10 接口接收 handler_action / handler_note
- [ ] H-11 更新 ewoh_event.status='handled' + handler_action + handled_at
- [ ] H-12 事件中心新增「处置」按钮 + 处置弹窗
- [ ] H-13 飞书卡片「快速处置」按钮回调此接口
- [ ] H-14 处置后 toast 确认 + 刷新事件列表
- [ ] H-15 飞书工作台搜索"EWOH"可找到应用
- [ ] H-16 飞书内打开应用自动登录

---

## 阶段 I：构建与发布

- [ ] I-01 `npm run type:check:server` 通过
- [ ] I-02 `npm run type:check:client` 通过
- [ ] I-03 `npm run build:server` 通过
- [ ] I-04 `npm run build:client` 通过
- [ ] I-05 `npm run build` 完整通过（含 prune-smart）
- [ ] I-06 dist/server 产物完整（main.js + 所有 module .js）
- [ ] I-07 dist/client 产物完整（index.html + assets）
- [ ] I-08 本地 `node dist/server/main.js` 启动成功
- [ ] I-09 本地启动后模拟器自动运行（日志输出"Simulator 已启动"）
- [ ] I-10 本地访问 http://localhost:3000 指挥地图可加载
- [ ] I-11 代码已推送到 sprint/default 分支
- [ ] I-12 已通知用户手动发布到 online
- [ ] I-13 online 环境模拟器运行（数据表有新数据写入）
- [ ] I-14 online 环境指挥地图可访问（https://xqjyctsd.aiforce.cloud/app/app_17b7bgq1e4a）
- [ ] I-15 online 环境 schema 扩展生效（新列存在）

---

## 总结性检查

**真机数据直连（皮肤+内脏）**
- [ ] S-01 真机数据与模拟数据可在同一表共存，通过 source_type 区分
- [ ] S-02 前端可按 source_type 过滤数据（至少 data_quality 模式可见真机/模拟标识）
- [ ] S-03 端到端流程验证：Python adapter → edge_to_spark.py → ingestion API → 落库 → 规则引擎 → 事件 → 前端可见

**飞书闭环**
- [ ] S-04 飞书闭环验证：告警卡片 → 点击「查看指挥地图」→ 自动选中实体 + 回放 → 处置 → 状态回写

**工厂即具身机器人范式验证**
- [ ] S-05 皮肤：传感器数据通过 Ingestion 实时涌现到孪生场景（延迟 <5s）
- [ ] S-06 内脏：调度决策可下发执行层，执行确认回传形成闭环
- [ ] S-07 肢体：外骨骼数据上行 + 触觉/语音下行双向通道联通，身体共生生效
- [ ] S-08 大脑：感知→记忆→推理→决策→学习五层联通，generatePlans 数据驱动

**游戏玩法验证**
- [ ] S-09 玩家角色：班组长/车间主任/厂长三角色权限区分生效
- [ ] S-10 资源分配玩法：拖拽分配 + AI 评分 + 写入 schedule_plan
- [ ] S-11 任务编排玩法：MES 工单 → 工序编排 → 节拍模拟预测
- [ ] S-12 实时决策玩法：proposed→confirmed→执行→结果回流闭环
- [ ] S-13 事件响应玩法：L3 告警弹窗 + 处置 + 大脑学习

**双向同步验证**
- [ ] S-14 现实→虚拟：传感器数据涌现孪生场景延迟 <5s
- [ ] S-15 虚拟→现实：玩家决策下发 + 执行确认 + 冲突检测

**场景直接建模验证**
- [ ] S-16 L2 三维加载 splat/点云 + 实时人员移动 + OrbitControls
- [ ] S-17 spatial-scan/location 接口接收建模数据
- [ ] S-18 source_type 支持 lidar_scan/gaussian_splat/uwb_located/visual_slam

**桌面端操控验证**
- [ ] S-19 缩放/平移/拖拽/搜索/快捷键/L2 三维/告警弹窗 均可操作
