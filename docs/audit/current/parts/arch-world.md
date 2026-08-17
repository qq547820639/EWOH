# Factory World State 架构审计（arch-world）

审计日期：2026-08-17。范围：云端 ewoh-spark-app（NestJS + Postgres）、边缘 src/edge_platform（Python 标准库 + SQLite）、前端 Command Map 数据源。只读取证，全部结论附 file:line。

核心问题：**EWOH 中到底有几个 Factory World State，谁是 authoritative，哪些是 projection/derived。**

---

## 一、World State 清单表

### A. 云端（ewoh-spark-app，Postgres）

| # | 名称 | 位置 | 存储 | 写入者 | 读取者 | 新鲜度机制 | tenant-scoped |
|---|------|------|------|--------|--------|-----------|---------------|
| A1 | 逐实体状态流 | `ewoh_world_state`（schema.ts:737） | append-only 行（entity_id + state_json + ts） | 模拟器 simulator.service.ts:553；摄像头检测 sensor-ingest.service.ts:99-119；UWB/Wi-Fi 定位流 sensor-ingest.service.ts:230-259（ingest.service.ts:994 委托） | world.service.ts:126-134（DISTINCT ON 取每实体最新）；world.service.ts:273-282（回放） | `ts` 列，无版本号 | 是（org_id，schema.ts:742；NEST-204 写入强制） |
| A2 | 空间实体主数据 | `ewoh_spatial_entity`（schema.ts:768） | 行（entity_id 唯一 + x/y/status/version/queue/available_windows） | simulator.service.ts:519-522（tick 更新 x/y）；sensor-ingest.service.ts:200-209（空间扫描 upsert）；spatial/onboarding 维护 | world.service.ts:81-112；scheduler/world-state.service.ts:213/233；resource-projection.service.ts:109/121 | `version` 列 + `_updated_at` | 是（org_id，schema.ts:797） |
| A3 | 调度世界快照 | `ewoh_world_state_snapshot`（schema.ts:1369） | 整快照 JSON 行（snapshot_version 唯一） | WorldStateSnapshotService.allocateAndPersistSnapshot（world-state.service.ts:102-108，事务内原子分配） | getSnapshot/isSnapshotFresh（world-state.service.ts:149-193，审批 PLAN_STALE 校验） | `WS-YYYYMMDD-NNNN` 版本（ewoh_snapshot_version_counter 按天计数，world-state.service.ts:736-750）+ entityVersions 内容哈希（:587-686，SHA-256 48-bit 折叠） | 是（org_id 血缘列，:106） |
| A4 | 游标协议快照 | `ewoh_world_snapshot`（schema.ts:1386）+ `ewoh_world_delta_log`（schema.ts:1408） | 全量快照行 + delta seq 流 | 仅 world-cursor.service.ts:112/128/208——**applyUpsert/applyRemoval 生产代码零调用（Grep 全仓仅测试命中）**；getSnapshot 读取时惰性物化新快照行 | world-cursor.controller.ts:16-44（GET /api/world/snapshot、/api/world/delta，Roles: global_admin/dispatcher/workshop_lead）；前端 client **不消费**（api/world.ts 无此二端点） | 数值 snapshotVersion + seq 游标（base64 `version:lastSeq`，world-cursor.service.ts:72-83）；CursorExpired → HTTP 410 | 是（org_id，NEST-609） |
| A5 | 统一资源投影（ResourceState 形态） | ResourceProjectionService.project()（resource-projection.service.ts:105-381） | 无表，查询时计算 | 无（纯投影） | GET /api/scheduler/resources/state（scheduler.controller.ts:119-123）；scheduling-context.service.ts:51；resource-adapters.ts:26-54；candidate-engine.service.ts:79 | 差异化新鲜度策略 DEFAULT_FRESHNESS_POLICY（resource-projection.service.ts:47-59，person:location=60s…master=5min；STALE/UNKNOWN fail-closed 不可用） | 是（NEST-102 org 条件） |
| A6 | 快照形态资源投影 | ResourceProjectionService.projectForSnapshot()（resource-projection.service.ts:683-893） | 无表 | 无（纯投影） | WorldStateSnapshotService.collectState（world-state.service.ts:280）——scheduler 快照的 persons/devices/stations 唯一来源（T02/P0-1 已消除双轨直读） | 同 A5 策略；附 source: AUTHORITATIVE/DERIVED 标记 | 是 |
| A7 | 调度资源预占 | `ewoh_resource_reservation`（resource-reservation.service.ts:7） | 行（status: reserved/active） | ResourceReservationService.reserve（事务 + advisory lock + EXCLUDE 约束，resource-reservation.service.ts:76-100） | world-state.service.ts:250-261（进快照）；resource-projection 水合 availableWindows；listActive（resource-projection.service.ts:125） | startMs/endMs 时间窗 | 是（org 条件） |
| A8 | 物料库存/预占 | `ewoh_resource_binding` + `ewoh_resource_preorder`（resource.service.ts:12） | 行 | ResourceService（ADR-081；pg_advisory_xact_lock 防超卖，resource.service.ts:94-120） | resource.controller；world.service.ts:328-343（回放物料 lane） | 数量守卫条件更新 | 部分（写入带 org，读面 org 守卫属 NO-13ag 待办，resource.service.ts:70） |

### B. 边缘（src/edge_platform）

| # | 名称 | 位置 | 存储 | 写入者 | 读取者 | 新鲜度机制 | tenant-scoped |
|---|------|------|------|--------|--------|-----------|---------------|
| B1 | 契约世界模型 | ContractWorldStore（world_model/contract_store.py:47）包装 StateStore（state_store.py:63） | 进程内存，(entity_id, state_type) 双时态（valid_from/valid_to + version 递增）+ to_dict/from_dict 持久化 | TelemetryWorldProjector（world_model/projection.py:51，订阅 STREAM_TELEMETRY → declare_entity/set_state/record_event，fail-closed） | GET /api/world/snapshot、/api/world/entities、/api/world/states、/api/world/replay、/api/world/events、/api/world/predictions（routes/replay.py:6-13；未装配 503） | snapshotVersion 单调计数（contract_store.py:55-57，EDGE-203）+ entityVersions + sourceProfile 模拟隔离 | 是（tenant_id/factory_id 声明不可变，contract_store.py:61-89） |
| B2 | 边缘调度世界快照 | WorldStateService.build_snapshot（scheduler/world_state.py:72-114） | 进程内对象（不持久化） | 按需构建 | scheduler_service.py:401（影子方案）、:526-530（确认前 staleness/key_changed）、:653（重排） | `WS-YYYYMMDD-NNNN` **进程内 _seq**（world_state.py:66-70）+ is_stale 300s（:116） | 否（单租户进程） |
| B3 | 边缘统一资源状态 | ResourceStateService（scheduler/resources.py:54-80） | 进程内 + _cache | 按需聚合 storage（people/devices/stations/tasks/assignments/telemetry） | GET /api/resources/state（routes/scheduler.py:55/579）+ SSE /api/command-map/stream 版本过滤 | per-resource 递增 version（resources.py:60-68） | 否 |
| B4 | 边缘设备/人员/事件读面 | routes/world.py:30-148 | SQLite storage 直读 | edge/bridge（遥测/事件） | /api/devices、/api/people、/api/events 等（含离线判定、证据窗口） | last_seen + offline_after_sec | 否 |

### C. 前端数据源

| 消费方 | 数据源 | 证据 |
|--------|--------|------|
| React client CommandMap | getWorldState → GET /api/world/state（A1+A2 即时拼装，10s 轮询）+ getEntities（spatial 30s）+ scheduler routes/candidates | client/src/api/world.ts:4-11；pages/CommandMap/hooks/useCommandMapQueries.ts:53-66 |
| 静态 ui/command_map | GET /api/resources/state（**边缘 8765 端口**，B3）+ worldStateVersion | ui/command_map/assets/app.js:271-274, 280-293；edge config.py:110 |
| ewoh-feishu-app | 独立 SQLite demo 栈（devices 表），不属世界主链 | ewoh-feishu-app/server/db.js:20 |

**上行路径**：边缘世界事实**无快照级上行**。仅两条间接通道：①遥测帧 edge_to_spark.py → 云端 /api/ingest/exoskeleton → sensor-ingest → `ewoh_world_state`（A1）；②投影事实以 EntityDeclared/EntityStateObserved 信封事件经 EventUplink → 云端 /api/ingest/events（event_uplink.py:1-17）。云端再由 scheduler 重新拼装快照——边缘 B1 与云端 A3 之间没有共享版本空间。

---

## 二、authoritative vs projection vs derived 判定

| 判定 | 对象 | 证据 |
|------|------|------|
| **authoritative（事实层）** | `ewoh_spatial_entity`（空间/实体）、`ewoh_world_state`（实体状态流）、`ewoh_personnel`、`ewoh_device`、`ewoh_production_task`、`ewoh_event`、`ewoh_resource_reservation` | 皆为直接写入的业务事实表；模拟器（source_type='simulated'）与真实 ingest（orgId 强制）双源同表，靠 source_type 语义区分（simulator.service.ts:533、sensor-ingest.service.ts:111） |
| **projection（投影，可重建）** | A3 调度快照（7 表 + 资源投影重拼，world-state.service.ts:206-726）；A5/A6 资源投影；边缘 B2/B3；world.service.getCurrentState（A1 最新行 + A2 join） | 全部无独立事实，删除后可从事实层重建 |
| **derived（含派生兜底字段）** | 快照内 safetyCritical/preemptible/skillMatchMode/productionImpact/requiredDeviceCapabilities/candidateStations（列空时白名单/拓扑派生，world-state.service.ts:305-342、763-869）；device capabilities 型号白名单派生（resource-projection.service.ts:229-234）；安全事件→禁区/封锁人员推导（world-state.service.ts:451-519）；eventImpacts 传播（:521-576） | 派生字段带 `derived[]` 标记；source: AUTHORITATIVE/DERIVED 双维度标记（P1-B） |
| **空转协议面** | A4 world-cursor（ewoh_world_snapshot/ewoh_world_delta_log） | 生产无写入者；无前端/服务消费者；NEST-648 注释（world-cursor.service.ts:13-23）自称"有意并存，收敛会破坏游标协议版本语义"——但协议两侧均未接线 |

**权威源一句话**：不存在单一 Factory World Kernel；权威事实分散在 7 张业务表，"当前世界"由三条独立链路（world.service / scheduler world-state / 边缘 scheduler）各自即时拼装，scheduler 快照（A3）是唯一持久化、带版本与新鲜度校验的物化投影——事实上的调度权威快照，但仅 scheduler 域内有效。

---

## 三、重复拼装世界事实的具体位点

1. **"当前世界状态"三处独立计算**（同一问题三种答案）：
   - world.service.getCurrentState（world.service.ts:76-212）：spatial_entity + world_state DISTINCT ON + 最近 20 事件；
   - world-state.service.collectState（world-state.service.ts:206-726）：7 表 + 资源投影 + 派生 + 安全映射；
   - 边缘 scheduler build_snapshot（world_state.py:72-114）：storage 7 源聚合。
   三者的 persons/devices 状态语义、新鲜度处理互不一致（前者无新鲜度分类，后两者有）。

2. **ResourceProjectionService 双形状双代码路径**：project()（resource-projection.service.ts:105-381）与 projectForSnapshot()（:683-893）读同一组表、重复实现维护/质量附着（loadActiveMaintenance/loadActiveQualityFindings 各调用两遍）、坐标判别、状态归一——约 400 行平行代码，仅形状不同。T02 收敛了"来源"但未收敛"装配"。

3. **快照版本号 `WS-YYYYMMDD-NNNN` 两套独立分配器**：云端 DB 计数器（world-state.service.ts:736-750）vs 边缘进程内 _seq（world_state.py:66-70）。ID 空间冲突：同一版本串在两个系统指向不同快照，跨端无法辨别。

4. **端点重名异义**：`GET /api/world/snapshot` 边缘=ContractWorldStore 契约快照（replay.py:30）vs 云端=world-cursor 协议快照（world-cursor.controller.ts:16）；`GET /api/resources/state` 边缘=ResourceStateService（routes/scheduler.py:55）vs 云端=ResourceProjectionService（scheduler.controller.ts:119）。ui/command_map 与 React client 连的是不同后端。

5. **表名三连混淆**：`ewoh_world_state`（状态流）vs `ewoh_world_state_snapshot`（调度快照）vs `ewoh_world_snapshot`（游标协议，schema.ts:737/1369/1386）。

6. **"资源"双义**：scheduler 的 ewoh_resource_reservation（调度资源预占）与 resource 模块的 ewoh_resource_binding/preorder（物料库存，resource.service.ts:61-71）同词不同域，且 world.service.getReplay 把后者当"物料 lane"混入世界时间轴（world.service.ts:328-343）。

7. **派生白名单多处散落**：SAFETY_CRITICAL_TASK_TYPES / PRIORITY_PRODUCTION_IMPACT / deriveRequiredDeviceCapabilities 集中在 world-state.service.ts:763-833，与 device-capabilities.ts 型号白名单属同源语义两处维护。

---

## 四、收敛建议：目标 Factory World Kernel 边界与迁移路径

**目标边界**（单一 Kernel，双层）：
- 事实层（authoritative）：`ewoh_spatial_entity` + `ewoh_world_state` + personnel/device/task/event/reservation 事实表，保持现写入路径（ingest 强制 orgId、source_type 三态）。
- Kernel 层：ResourceProjectionService 升格为唯一资源投影内核（先合并 project/projectForSnapshot 为单装配多形状输出）；WorldStateSnapshotService 作为其上的快照物化器（版本分配、entityVersions、新鲜度），对外暴露 read-model：`currentWorld()`、`snapshot(version)`、`resources()`。

**迁移路径（按风险从低到高）**：
1. world-cursor 二选一：要么把 ingest/simulator 的写入接线到 applyUpsert（delta log 有生产数据，协议激活）；要么在 OpenAPI/文档显式标注"预留未接线"，从 route-role 表移除以免误信。现状是最差组合——有权限控制、无数据。
2. world.service.getCurrentState 改为消费 Kernel 投影（persons/devices/stations 换 projectForSnapshot 输出），保留其回放（getReplay）为只读历史视图；前端 CommandMap 无感切换。
3. 合并 project/projectForSnapshot 双装配（内部一次 collect，两种形状序列化），消除 400 行平行代码与双份 maintenance/quality 加载。
4. 快照版本命名空间统一：云端保留 WS- 前缀，边缘改 ES- 前缀（或带 factory_id），消除跨系统版本串冲突。
5. 边缘：B2 build_snapshot 改为消费 ContractWorldStore（B1）而非重新聚合 storage，使边缘调度与边缘世界模型同源；EventUplink 已有的 EntityDeclared/EntityStateObserved 上行可进一步作为云端 A1 的规范输入（替代裸 state_json）。
6. 远期：表名治理（ewoh_world_snapshot → ewoh_world_cursor_snapshot）与 resource 域拆词（material vs scheduling-resource）。

**哪些模块改为只读投影**：world 模块（读 Kernel）、simulation（现状已不读世界事实表，仅 simulation.service.ts 读写 ewoh_simulation_run/ewoh_event，维持）、agent（现经 getCurrentWorldState 读调度快照，agent.service.ts:667——注意该调用未传 ctx，属系统后台流语义，应显式传 org）、前端两类 Command Map（统一连云端 Kernel 或明确标注边缘模式）。
