# 全平台加载故障修复报告（2026-08-19）

## 一、故障现象
- 指挥地图经常加载不出来；排产调度方案生成报错；整个平台数据加载困难。

## 二、根因（四层叠加，全部实测定位）

| # | 根因 | 实测影响 |
|---|---|---|
| 1 | 模拟器持续生成告警、无人处理永不关闭：36h 累积 **63,308 条 open 事件** | 世界快照 collectState 全量拉取+嵌套传播，把 Node 事件循环阻塞数十秒 |
| 2 | RetentionService **静默失效**：compose 中 EWOH_DATABASE_URL 只配在 migrate 服务，api 服务缺失 → owner 连接回落 ewoh_api 用户（RLS 过滤读空）→ 清理删 0 行且无报错 | 数据无限增长（world_state 75 万行 / telemetry 60 万行 / 快照表 21MB×行） |
| 3 | stale_plan 检查循环：31 个 shadow 方案 × 每个全量读取历史 **21MB 巨型快照 JSON** | conflicts 接口单独因此耗时 90s+，且每次生成新方案持续恶化 |
| 4 | 前端 axios 超时 15s | 后端 conflicts 104s / 调度生成 24.7s 全部表现为"报错/加载失败" |

## 三、修复内容（提交 07f74ae + 17511b1，镜像 ewoh-api:0.6.0-rc6）

### 后端
1. **collectState 事件有界化**（world-state.service.ts）：open 事件查询 + 24h 时间窗 + ORDER BY created_at DESC + LIMIT 500
2. **模拟事件自动过期**（retention.service.ts）：open & simulated & >2h → status='expired'（分批；真实上报事件不受影响）
3. **快照表 retention 48h**：防巨型快照再累积
4. **stale_plan 检查加固**（conflict.service.ts）：版本去重缓存 + 最近 10 个方案上限（MAX_STALE_PLAN_CHECKS）
5. **事件生成降频**（simulator.service.ts）：去重窗口 30s→120s
6. **API 时间窗参数**：dashboard/events、timeline/events 增加 `hours` 参数（默认 24，1~168）；alerts 默认 24h 滚动窗口
7. **compose 修复**：api 服务注入 EWOH_DATABASE_URL（owner 连接，retention 恢复生效）
8. **Dockerfile.api.ecs 入库**（曾被 rsync --delete 两次误删）

### 前端
9. 事件中心（指挥地图）新增**时间范围选择器**：1小时 / 6小时 / 24小时 / 7天，默认 24 小时滚动窗口
10. getEvents API 透传 hours 参数

### 数据热修复（立即生效）
- 归档 31 个历史 shadow 方案；删除 35 个巨型历史快照（含 21MB×5）并 VACUUM FULL

## 四、修复前后对比（ECS 实测）

| 接口 | 修复前 | 修复后 |
|---|---|---|
| GET /scheduler/conflicts | 104s（超时） | **0.2-0.9s** |
| POST /scheduler/runs（调度生成） | 24.7s（前端15s超时报错） | **8.8s** |
| GET /dashboard/overview | 7-18s | **0.5-0.7s** |
| GET /scheduler/context | 间歇超时 | **0.26s** |
| GET /dashboard/events | 失败 | **0.3s** |
| 指挥地图数据源 | 加载不出 | **毫秒级** |

## 五、时间窗口方案（按用户需求落地）
- **默认 24 小时滚动窗口**：所有事件列表默认只查最近 24h，超出自动滚出视野
- **用户可选**：指挥地图事件中心提供 1h/6h/24h/7d 切换
- **稳态数据规模**：open 事件 ~2100 条（生成 ~1000/h × 2h 过期平衡），world_state/telemetry 24h 封顶，快照 48h 封顶

## 六、验证与回归
- tsc -b 零错误；scheduler/simulator/alert/dashboard 单测 12 套 136 用例全绿
- rc6 部署后全接口复测达标（见上表）；retention 每小时自动清理日志正常

## 七、后续增强（同日 rc7）
- **人员侧绑定双入口**（用户确认需求）：「人员与外骨骼」页新增"绑定外骨骼"列与绑定/换绑弹窗——
  录入人员后可直接分配外骨骼（换绑自动释放原设备；目标设备被他人占用时先解绑再绑定），
  与设备中心（设备侧选人）互为双入口。提交 4cd2393，镜像 rc7 已部署验证。

## 八、通道与监控三项修复（rc8/rc10）
用户报告：①通道生成未生效 ②通道显示不完整 ③监控视角统一朝右。逐层定位出**三层叠加根因**：

| 层 | 根因 | 修复 |
|---|---|---|
| 契约层（元凶） | SPATIAL_KINDS 封闭注册表（v1 21 类）不含 corridor——mapEntity fail-closed 抛错，**实体接口整体 500**，任何通道实体都被契约层拒绝（多轮迭代"不生效"的真相） | TS/JSON/Python 三方契约源同步注册 corridor（v1.1 22 类），门禁 584/584 PASS |
| 数据层 | 车间布局重排时只注入 route 拓扑边（细线），从未生成可见通道实体；摄像头 yaw 全 0 且 extra 空 | 种子 058：6 条 corridor 通道实体（对齐车间边界与拓扑走向）；摄像头朝向工厂中心四向展开（348/230/334/113）+ fov=90/range=220 |
| 渲染层 | STATIC_ORDER 白名单不含 corridor（有数据也不画）；摄像头 range 键名不匹配（range_m vs range） | 白名单加 corridor + 青绿色带状样式；range_m 兼容 |

**可验证输出（线上实测）**：实体接口返回 80 实体含 6 条通道（COR-QC-PR(150,345) 70×70、COR-HUB(250,382) 36×145、COR-PR-WL(265,455) 50×60、COR-WL-AS(485,423) 50×110、COR-QC-LO(370,289) 260×42、COR-LO-AS(610,335) 70×50）；4 摄像头 yaw=348/230/334/113 四向扇形覆盖。
提交 b75d4eb + 6cf21b3，镜像 rc10；rc8 为默认图层修复（task/resource/conflict 默认开启）。

## 九、六项问题排查修复（rc12-rc14，2026-08-20 凌晨）

| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | 图层切换按钮无效 | SchedulerLayersOverlay 仅调度模式渲染，图层开关常显——非调度模式切开关无变化 | overlay 移除 mode 门控，activeLayers 开关为唯一显隐权威 |
| 2 | 时间轴回放失效 | ①回放按 state_json.entity_type 分类，实际数据无该键（persons/devices 全空）；②负载键名 load_score vs 实际 loadScore；③模拟器从不写设备位置帧（retention 清光历史后设备恒空） | 实体类型改 spatial 表映射 + 键名兼容（rc13）；模拟器设备段补写位置帧（rc14）。终验：60 快照含人员帧 333/设备帧 267/事件 1016 |
| 3 | 人员负载显示 0 | 资源投影只读 personnel.currentLoad（模拟器不写该表），实际负载在 world_state.loadScore | 投影增加 world_state 最新帧 LATERAL 水合。终验：24/24 人有负载值 |
| 4 | 任务编排仅 3 工位 | 预期行为——3 是默认工序节点模板数（可增删），工位下拉为 4 个真实工位 | 无需修复 |
| 5 | 数据联动异常 | 轮询+SSE+invalidate 机制正常；感知异常主因是问题 1 图层不渲染 | 随问题 1 修复解决 |
| 6 | 大脑建议状态 | 实测可用（接口 200，返回真实建议，AI 密钥已配） | 无需修复 |

附带修复（rc12）：决策驾驶舱"方案对比"非调度模式点击无反应（先切调度模式再开对比）；
"清除上下文"不清任务选中导致无感知（同时清任务选中回到空态）。

## 十、遗留观察项
- overview 偶发 9-10s：仅在 retention 整点清理窗口（大量 DELETE）内的瞬时竞争，非稳态；下个观察周期确认
- legacy POST /plans 端点缺 userContext（已废弃路径，前端走 V2，暂不处理）
