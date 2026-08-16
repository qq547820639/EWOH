# EWOH 仓库系统性代码走读报告（2026-08-14 · 完整版）

> 版本基线：`0.6.0-rc4`（version.json），HEAD `794a3c2`（main）
> 走读方式：主线程亲自核实核心入口链与门禁 + 7 个并行深挖子代理（每子系统逐文件走读，产出
> `tmp/walkthrough/01~07-*.md`）+ 本次走读同步修复确认级缺陷（P0×3 + P1×5 + 测试红灯 + 文档漂移）。
> 走读边界：排除 node_modules/dist/output/release/delivery/demo.db/.git 等产物与冻结快照。

## 0. 执行摘要

- EWOH 是**外骨骼工厂具身智能操作系统**（多运行时单仓库）：Python 边缘运行时（`src/edge_platform/`，
  纯标准库 46.1K 行）+ NestJS/React 云侧主产品（`ewoh-spark-app/`，server 76K 行 + client 104K 行）
  + 飞书侧车（`ewoh-feishu-app/`，5K 行），以 `contracts/ openapi/ db/ catalog/` 为跨运行时契约层。
- **工程治理是最大资产**：feature-status.yaml 单一事实源、OpenAPI 路由零漂移门禁（323/323）、
  31 步 standalone 迁移链（31/31 成对 rollback）、truth-* 门禁族、semantic-rules 13 夹具、
  7 个 CI workflow、4 套 TCK——本次全部实测通过。
- **代码层面的工作"绝大部分已实现且真实"**：调度闭环（NestJS）是真实端到端产品级实现而非脚手架；
  42 个模块中约 33 个真实接线；边缘调度 simulation 模式端到端真实落库；前端实时链路（SSE 单调守卫/
  缺口 resync/轮询兜底）设计严谨。
- **但"全部实现"不成立**：本次走读实测发现 3 个 P0（已全部修复）+ 一批 P1/P2（P1 高价值项已修复），
  且存在被测试盲区掩盖的"链路性失效"（云侧 SSE 被拦截器掐死、边缘真机动作分类恒 unknown、
  生产装配无适配器注册）。详见 §6。
- **UX 可深化空间明确且成体系**：最大短板是"派工后执行反馈断链"（决策驾驶舱是单程工具），
  另有深色模式半成品、视口 culling 已建未接、页面级渲染测试覆盖极低等，清单见 §7。

## 1. 仓库拓扑（目录层级走读）

```
EWOH/
├── run.py / pyproject.toml / Makefile / requirements-dev.txt   # Python 入口与工程门禁
├── README.md（产品手册 458 行）/ CHANGELOG.md / SECURITY.md      # 真相层文档
├── feature-status.yaml / version.json                          # 功能事实单一来源
├── src/edge_platform/          ★ Python 边缘运行时（202 py ≈46.1K 行）
│   ├── run.py / config.py / server.py / services.py / security.py / stubs.py / selfcheck.py
│   ├── runtime/（bootstrap/dependencies/protocols——三模式装配，production fail-fast 禁 stub）
│   ├── routes/（registry + health/inference/world/telemetry/scheduler/auth/admin/replay）
│   ├── auth/ rbac/ audit/ monitoring/ governance/ backup/ migrations/
│   ├── edge/（storage/bus/manager/backfill/exo_semantic + adapters/* + modeling/ + bridge/）
│   ├── connectors/（modbus/opcua/sparkplug/webhook/csvfile + 8 manifests）
│   ├── inference/（pipeline/rules/events/features/fatigue/model/…）
│   ├── perception/ spatial/ twin/ world_model/ collection/ assistant/ aas/ scenario/ policy/
│   └── scheduler/（28 文件：scheduler_service/repository/planner/optimizer/… + cpsat/worker/solver）
├── ewoh-spark-app/             ★ NestJS + React 云侧主产品
│   ├── server/（main.ts + standalone-main.ts + 42 业务模块 + database/schema.ts）
│   ├── client/（React 19 SPA：CommandMap/DecisionCockpit/RoleWorkbench/MobileWorkbench/…）
│   └── shared/（前后端契约类型 api.interface.ts + scheduler.ts）
├── ewoh-feishu-app/            ★ 飞书侧车（Express + better-sqlite3 + lark-cli 子进程）
├── contracts/（状态机/事件/工厂/策略/artifact-schemas）  openapi/（ewoh.yaml 15K 行）
├── db/（migrations 31 步 standalone 链 + runner + seed + verify 28 份）  catalog/（工厂/场景/连接器资产）
├── deploy/（compose/k8s/helm/Dockerfile.cpsat）  scripts/（56 门禁审计 TCK）  tools/（9 治理工具）
├── tests/（仓库级契约 pytest 163 项）  docs/（99 篇活跃文档）  security/（访问矩阵）
└── ui/command_map/（历史静态原型，UX 参考）  delivery/ release/（冻结交付/快照）
```

## 2. 多运行时架构与关键链路（已主线程核实）

```text
现场/边缘：Device → Adapter(codec/protocol) → MessageBus → InferencePipeline(2s 滑窗+规则+模型)
           → EventEngine(风险事件 L1-L3 ±30s 证据) → SQLite Storage → 本地 HTTP/SSE API
                                                          │ Edge Bridge(edge_to_spark.py)
云端/主产品：React SPA → NestJS → PostgreSQL（RLS 多租户）▼ /api/ingest（X-Ingest-Key fail-closed）
            Scheduler V2：run 触发(冷却+幂等) → WorldStateSnapshot(版本原子分配)
            → 全局约束 → A/B/C 求解(heuristic canonical / CP-SAT 激活阶梯 fail-closed)
            → plan → approve(version+snapshot 双校验) → dispatch(CAS+容量预占+安全熔断)
            → Outbox(DB 序列) → SSE(sequence/Last-Event-ID/resync/2s 轮询兜底)
飞书侧车：webhook 验签(4 道) → 卡片处置 → lark-cli(异步+并发4+熔断) → Base/审批/文档
```

- **Web 请求链**：`AccessTokenGuard → RolesGuard → OrgContextInterceptor(buildGucSettings) →
  RequestDatabaseContext(AsyncLocalStorage 请求级事务+GUC) → RLS → Service → DB`。
- **调度闭环（NestJS）**：approve/dispatch/replan 全部有 shadow 守卫、安全关键锁定、
  `pg_try_advisory_xact_lock` 风暴守卫、最低改进门、canary 失败自动归 0——真实产品级实现。
- **激活阶梯唯一事实源**：`OFF → SHADOW → CANARY → PRODUCTION`，PRODUCTION 需
  `EWOH_SOLVER_PRODUCTION_ENABLED=1`，否则 fail-closed 回退 heuristic（fallbackReason 如实落库）。

## 3. 入口与配置（已亲验）

- **边缘入口**：根 `run.py` → `edge_platform.run.main()` → Settings（全默认零配置）→
  RuntimeFactory 三模式装配（production 禁 stub 回退；development 需显式 `EWOH_ALLOW_STUB=1`；
  simulation=--stub）→ 调度所有权门禁（production 下 Edge 仅 advisory，写权限唯一归 NestJS）→
  真实模式显式启动 manager/pipeline → SchedulingRepository（production 只读）+ hydrate →
  ThreadingHTTPServer（请求 ID/CORS allowlist/1MB body/审计/统一错误信封/限流）。
- **云侧入口**：`standalone-main.ts`（abortOnError fail-fast、CORS 禁 `*`、TRUST_PROXY=true 抛错、
  安全头、SPA fallback）；legacy `main.ts` 需 `EWOH_LEGACY_ENABLED=1` 且启动即打印缺 12 模块警告。
- **配置矩阵**：`deploy/.env.example` 为部署参数唯一事实源（audit-env-inventory --strict 门禁守护，
  实测 102 documented / 0 违规）。

## 4. 数据流与持久化

- **边缘**：9 张调度表 + 遥测/推理/事件/治理全表 SQLite WAL（单全局锁 + 每操作一事务，原子性 OK；
  已知瓶颈：`query_telemetry/query_inference` 全表加载 + Python 过滤，长查询持锁阻塞 ingest）。
- **云侧**：schema.ts 56 张表（由 PG 反向生成，`db/migrations/standalone_*` 为唯一权威源）；
  scheduler 11 张运行时表 RLS 三分类（8 张 TENANT_SCOPED RLS + outbox/world_state_snapshot/
  assignment_event 3 张全局语义表）——025 迁移修复了 023 的 GUC 名不一致。
- **审计**：云侧哈希链（chain_seq/prev_hash/hash + ewoh_append_audit_log 函数）；边缘 POST/PATCH
  自动审计（本次修复后 PATCH 与 POST 对称）。

## 5. 门禁与测试实测（本次会话全部真实运行）

| 门禁 | 结果 |
|---|---|
| Python unittest（src/edge_platform/tests） | 852 passed |
| 仓库级 pytest（tests/） | 163 passed, 10 skipped（10 skip = ortools 未装，CP-SAT 真实求解从未执行） |
| 云侧 server jest | 199 suites / 1362 passed（含本次新增 SSE 直通单测） |
| 云侧 client jest | 107 suites / 879 passed（修复 stateCoverage 红灯后） |
| `npm run type:check`（server+client） | PASS |
| 飞书侧车 node:test | 63/63 passed（含本次新增 3 例） |
| audit-openapi-routes --strict | controller 323 / spec 481 / 0 undocumented / 0 unimplemented |
| openapi:no-drift / truth-feature-status / audit-env-inventory / audit-repo-facts / reconcile | 全部 PASS |

## 6. 关键问题清单（P0/P1/P2，含本次处置状态）

### P0（本次实测确认并已全部修复）

| # | 问题 | 证据 | 状态 |
|---|---|---|---|
| P0-1 | 边缘静态目录穿越：`translate_path` 覆盖丢失 `..` 清洗，`GET /../../../demo.db` 匿名可读 110MB 全量数据库（含人员/遥测/审计）与仓库任意源码 | server.py（运行时实测 200 + 110MB） | ✅ 已修复（镜像标准库语义丢弃 `.`/`..` 段）+ 回归测试 6 例 |
| P0-2 | 边缘 do_PATCH 无 production 认证门禁与审计（与 do_POST 不对称） | server.py:421-441（旧） | ✅ 已修复（认证 fail-closed + PATCH 审计 + 限流覆盖）+ 回归测试 |
| P0-3 | 云侧 SSE 被全局 OrgContextInterceptor 的 `lastValueFrom` 掐死：无限流永不 resolve → 调度事件无法送达客户端，且每连接占用一个事务/PG 连接（池 max=20） | org-context.interceptor.ts:88-92 × scheduler.controller.ts @Sse | ✅ 已修复（SSE_METADATA 直通，不进事务；org 隔离由应用层过滤保证）+ 直通单测 |

### P0 级"链路性失效"（E-01/CP-01 已修复；E-03 待后续迭代）

| # | 问题 | 证据 | 建议 |
|---|---|---|---|
| E-01 | 真机遥测经全链路后动作分类**恒 unknown**：`VENDOR_TO_UNIFIED` 未映射 roll/accel，frame_adapter 只拍平 8 标量，`features._sample_values` 强制三维角速度/加速度 → `extract_features` 恒 None → `ACTION_ANOMALY_LOW_QUALITY` 持续误报；测试（只断言键存在/旧形状喂管线）掩盖此问题 | adapter.py:36-58、frame_adapter.py:23-35、features.py:56-75（子代理实测 45 帧） | ✅ 已修复：核心/可选通道分离 + 标量角速度折算 + 规则路径 None-safe + 模型维度契约不符时诚实降级规则 + `_KEY_CHANNELS` 收敛核心通道；回归测试 10 例（含端到端 walk/bend）；同步补齐 6 个存储索引（E-08）。遗留：模型训练/评测数据管道与真机通道子集的对齐策略待产品决策（当前子集帧自动走规则路径） |
| E-03 | 生产装配**无任何适配器注册**：run.py 只 start manager/pipeline，从不 register()；docstring 引用的 `edge.device_driver` 不存在 → 真实模式遥测永不产生 | run.py:195-200 | config 驱动的适配器工厂注册入口 + 启动即输出每适配器 health + `/api/status` 暴露 ingest_chain_ok |
| CP-01 | CP-SAT（Python worker）从未真实执行（CI/本机均无 ortools，真实求解测试 skip），且含时间基准混用（冻结/预约用绝对纪元分钟 vs 普通任务相对分钟 → NoOverlap 对预约/冻结失效）、`late` 变量域溢出可致整模型 INFEASIBLE、objectiveBreakdown 把权重值当分项目标输出 | solver.py | ✅ 已修复三处确定性缺陷（`to_relative_minutes` 统一基准 / `late_domain_upper` / 真实分量 breakdown）+ 纯函数回归测试；**真实求解验证仍需部署环境安装 ortools 后执行**（UNAVAILABLE fail-closed 保持） |

### P1（本次已修复的）

- ✅ Simulator 模块 init 自动启动 → 显式 `EWOH_SIMULATOR_ENABLED=1` fail-closed（写真实表破坏快照新鲜度）。
- ✅ 审计身份可伪造（7 处客户端自报优先）→ `resolve_actor` 服务端 token 优先。
- ✅ 视觉理解 SSRF：`validate_outbound_url` 拒绝内网/环回/链路本地/元数据地址（保留云侧 Ark 配置代理功能）；
  `/api/command-map/stream` production 要求 Bearer（匿名 401）。
- ✅ 边缘 PACKET_LOSS_BURST 死规则 / TIME_SYNC 补传误报 / SEQ 丢失 / firmware 不透传 / SEQ 统计污染
  （UnifiedExoFrame 新增 sequence/backfill 字段并全链路透传，契约测试同步扩展）。
- ✅ 飞书健康探针撒谎（syncAllToFeishu 恒报 true）→ 聚合子项结果。
- ✅ 飞书 `GET /api/feishu/report` 带副作用 → POST 归入写鉴权。
- ✅ 飞书内置 web UI 处置表单与写鉴权脱节（永久 401/503）→ 顶栏「写权限」按钮
  （Bearer 头注入 + 401/503 可行动错误提示 + localStorage 持久），处置闭环恢复可用
  （实测：无 token 401 / 错误 token 401 / 正确 token 200）。
- ✅ 测试红灯：stateCoverage.test.ts 引用已删除孤儿页（client 879/879 恢复全绿）。

### P1（剩余，需后续迭代）

| # | 问题 | 位置 |
|---|---|---|
| R-1 | 边缘 RBAC 矩阵声明未执行：`is_allowed`（9 动作×5 角色）零路由调用；/api/audit、事件处置、调度写端点无角色门禁；`EWOH_AUTH_BACKEND` 未接入登录流（恒 offline 后端 + 硬编码默认口令）；OIDC 为 stub | rbac/permissions.py、auth/session.py:111-112 | ✅ RBAC 已落地（production 下 `action_for_request` 映射 + 认证后矩阵校验 403，回归测试 9 例）；遗留：登录流接 `get_identity_backend`、production 拒绝默认口令（auth 后端治理） |
| R-2 | `/metrics` 端点匿名暴露（SSE 已随本轮修复加 production Bearer 门禁）；默认口令未随 production 拒绝 | routes/health.py:139 |
| R-3 | 边缘 hydrate 半套（assignments/reservations/feedback 不还原 → 重启后派工不可查、confirm 跳过冲突校验）；execute 不推进 Task 状态；readonly 写接口错误码已随本轮修复统一为 403 SCHEDULING_READ_ONLY | scheduler_service.py:213-244 | ✅ hydrate 已补齐（派工/反馈/active 预约恢复 + ReservationService.restore + 模型字段过滤，回归测试 2 例）；✅ execute 推进 Task 状态已收口（ADR-029：execute→_sync_task_status_on_dispatch + set_assignment_status↔update_task 双向同步；云侧 dispatch→transitionTaskState('dispatch') 同步亦已存在）——R-70 经 ADR-049 §9 语义审计复核确认无遗留；剩余执行模型缺口 = 云侧执行反馈完成腿（NO-13a 立项） |
| R-4 | 贪心"资源忙即拒单"顺延分支死代码（链式排程失效）；downstream_blocking 恒 0（读不存在的字段）；滚动时域分区从未被调用 | optimizer.py:204-215、priority.py:90-91 |
| R-5 | 云侧 N+1（listActivePlans/listRuns 逐方案查 assignments）；getReplay events 无 LIMIT；runId 毫秒+4 位随机碰撞非零；审计查询无 org 过滤 | plan.service.ts:179-193 等 | ✅ listActivePlans/listRuns 已批量加载（loadAssignmentsBatched/listPlansBatched，2 查询替代 2N）；遗留：getReplay LIMIT、runId 碰撞、审计 org 过滤 |
| R-6 | 前端执行反馈断链：execution.* SSE 事件保留但无 UI 消费，DecisionCockpit 恒显「暂无调度反馈数据」——审批→派工闭环但"执行反馈→偏差→再决策"缺失（**最重要的 UX 缺口**） | DecisionCockpit.tsx:332-344、schedulerRealtimeCore.ts:149 | ✅ 已修复：DecisionCockpit SCHEDULING_FEEDBACK 真实消费 executions + SchedulePanel 执行偏差列表 + 「对比上一已批准方案」回看动作 + PlanStatusStepper 状态流转指示 + L3 告警聚合去抖 + 中文化残留清理；遗留：地图端 execution.* 偏差图层（需坐标投影层） |

### P2（代表性，完整清单见子报告）

- 巨型组件：CommandMapShell 1354 / SchedulePanel 1314 / FactoryMap 1264 / Operations 1060 行；
  视口 culling `setViewportBounds` 生产零调用（性能基建闲置）；深色模式半成品（tokens 定义但
  `applyDarkClass` 无调用点，≈1200 处硬编码 hsl 是 token 值的文本复制）；设计 token 门禁存量
  违规 3647 处（82 处未放行）；页面级渲染测试覆盖极低（107 测试仅 11 个 .tsx）。
- 仓库卫生：`package.yml` 源码 tarball 未排除 node_modules/dist（实测发布包 GB 级）；
  根 `deploy/docker-compose.yml` 陈旧占位无门禁守护；两个 e2e-db-verify 脚本硬编码机器路径；
  `hello` 模块整文件注释死代码；README 路由口径已随本次修复对齐（323/481）；
  SPA 死静态副本 `client/public/command_map`（232KB）已移除、`app.tsx` 过期 iframe 注释已修正。
- 边缘：非 exo 适配器帧与 insert_telemetry 契约不兼容被静默丢弃（camera/uwb/modbus…）；
  consent「不入库不发布」语义与实现不符（入库发生在 manager 层）；edge_to_spark 批量失效
  （len≥1 即刷）+ 断连缓冲无界；perception/world_model/fatigue/spatial_rules 均为库级未接线。

## 7. 用户体验深化机会（按投入排序）

**投入小见效快（1-2 天）**
1. ✅ 决策驾驶舱接入 execution 事件/查询（已落地：SCHEDULING_FEEDBACK 真实消费 + 汇总/最近事件）。
2. ✅ SchedulePanel 方案状态流转指示（已落地：PlanStatusStepper 四步流转 + 中文状态徽标）。
3. ✅ 中文化残留（已落地：churn→换人成本、STALE CONTEXT→上下文已过期、seq→序号、asOf→截至）。
4. SchedulePanel/ResourcePoolPanel 补错误态 + 重试（SchedulePanel 已补执行记录错误重试；ResourcePoolPanel 待补）。
5. ✅ 告警弹窗按设备聚合去抖（已落地：aggregateL3 + 聚合卡 + 展开列表分组）。
6. 回迁原型好点子：安全红线横幅（"安全控制不进入平台/调度需人工确认"）、SENSOR_CONFLICT
   人工标记现场事实、人员匿名化+授权状态展示、实体风险趋势 sparkline。

**中期（1-2 周）**
7. 启用视口 culling（setViewportBounds 接线 FactoryMap onTransformed）。
8. CommandMap 三步首次引导（选方案→对比→审批下发），可跳过。
9. ✅ 执行偏差可视化已落地于 SchedulePanel（ExecutionDeviationList + 「对比上一已批准方案」回看动作）；
   地图端 execution.* 偏差图层（坐标投影 + SVG 叠加）待后续迭代。
10. 边缘 `/api/devices/{id}/quality` 透出 bad_crc/malformed/packet_loss/backfill 统计 +
    `/api/status` 增加 ingest_chain_ok（防"真实模式空转"无感）。

**长期**
11. 暗色模式完整落地或声明下线（≈1200 处硬编码 hsl 迁移 token）。
12. 页面级渲染测试补强（优先 Login/CommandCenter/Alerts/RoleWorkbench 交互回归）。
13. ✅ "回滚到上一已批准方案"已落地为「对比上一已批准方案」回看动作（复用 PlanCompare，
    无后端回滚端点故不伪造回滚语义）；多终端视图一致性（URL 镜像推广到 workbench 筛选）待后续。
14. ✅ CP-SAT 时间基准/域/目标分解已修复（纯函数回归测试）；带 ortools 的 CI 真实求解门禁 +
    影子评估 + Pilot soak（docs/operations/pilot-soak-runbook.md + scripts/pilot-soak.sh）待部署环境执行。

## 8. 达成预期判定（结论）

1. **"代码层面的工作已全部实现"——不成立**：调度（云侧）、CommandMap、治理体系等核心板块
   确实达到了少见的产品级完成度，但本次实测存在 3 个 P0 安全/可用性缺陷（已修复）、
   3 个"链路性失效"（真机分类恒 unknown、生产装配无适配器、CP-SAT 从未真跑且模型有 3 处确定性
   缺陷）、1 个测试红灯（已修复）与一批 P1/P2——"全部实现"的诚实表述应为
   **"代码就绪度约九成，且全部能力 productionEnabled=false，尚无真实环境验收（缺 PG/Docker/真机）"**。
2. **"没有可再深化迭代的地方"——不成立**：§7 给出了 14 项分档 UX 深化机会；其中"执行反馈断链"
   已随本次迭代修复（驾驶舱真实消费 execution 数据），剩余代码侧 RBAC 落地、hydrate 补齐、
   贪心顺延、N+1 消除等 R-1~R-5 均有明确位置。
3. 版本质量判断：**工程治理与安全纪律（fail-closed 文化、单一事实源、门禁矩阵）在同类试点项目中
   属于顶尖水准**；剩余差距集中在"真机链路验证"与"闭环的最后一公里"（CP-SAT 实证、
   真机适配器注册、真实环境验收）——这恰好是 feature-status.yaml 中
   `runtimeVerified/productionEnabled=false` 所诚实标注的边界。

## 9. 附录

- 子报告：`tmp/walkthrough/01-core-runtime.md`（核心运行时/安全）、`02-edge-ingest-inference.md`
  （采集/推理/感知）、`03-edge-scheduler.md`（边缘调度+CP-SAT）、`04-nestjs-server.md`（云侧后端）、
  `05-react-client.md`（前端）、`06-feishu-ui-prototype.md`（飞书+原型+构建）、
  `07-contracts-governance.md`（契约/治理/部署/CI）。
- 基线对照：`docs/audit/2026-08-08-full-repo-audit.md`（20 项发现，P0-1/P0-2 装配问题已在此前修复）、
  `docs/remediation/01-findings-status.md`（P0 全部 VERIFIED）、`docs/product/UX_DEEPENING_BACKLOG.md`
  （13 项 UX 深化：9 全实现 / 3 部分 / 1 待真实环境）。
- 本次修复明细：见 CHANGELOG.md [Unreleased]「全仓系统性走读整改」条目。
