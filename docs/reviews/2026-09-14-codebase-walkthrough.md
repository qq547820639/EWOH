# EWOH 全仓代码结构走读

> 基于全仓系统性扫描 + 三轮对抗式审查（SR 109 文件 / UR 2 包 / FR 6 包）+ 全仓逐行走读（WR 8 包）的第一手知识。
> 代码量：边缘 281 .py / 服务端 570 .ts / 前端 703 .tsx / 共享契约 91 文件 / 迁移 100 项。
> 生成日期：2026-09-14。

---

## 1. 仓库整体架构

EWOH 是**多运行时单仓**（monorepo）：

```
EWOH/
├── src/edge_platform/          ← 边缘运行时（Python，零第三方依赖）
├── ewoh-spark-app/
│   ├── server/                 ← 平台后端（NestJS 10 + Drizzle + postgres.js）
│   │   └── modules/            ← 62 个业务模块
│   ├── client/src/             ← 平台前端（React 19 + Vite 7 + Tailwind 4）
│   │   ├── pages/              ← 31 个页面目录
│   │   ├── components/         ← 共享组件（Layout / ui/ / 状态组件）
│   │   ├── api/                ← HTTP 客户端层（每域一个文件）
│   │   ├── lib/                ← 纯逻辑层（auth / http / errorContract / roleMatrix）
│   │   └── hooks/              ← 共享 hooks（queryKeys / queryConfig）
│   ├── shared/                 ← 前后端同源契约（TS 类型 + 纯函数 + 状态机）
│   └── test/                   ← e2e + unit + browser
├── contracts/                  ← 文档即契约（31 子域 schema + test-vectors）
├── db/migrations/              ← standalone 迁移链（98 项，全部成对 rollback）
├── openapi/ewoh.yaml           ← API 唯一事实源（466 控制器操作）
├── scripts/                    ← 门禁 + 审计 + 部署脚本
└── docs/                       ← 架构文档 + ADR + 审计报告
```

**核心设计原则**：
- 前后端同源契约：`ewoh-spark-app/shared/*.ts` 同时被 server 和 client import
- 事件目录唯一事实源：`contracts/events/event-catalog.yaml` → TS/Python 镜像由 `audit-event-catalog` 门禁强制一致
- OpenAPI 零漂移：控制器操作数必须与 spec 操作数逐条匹配
- 迁移链唯一建库事实源：schema.ts 是 Drizzle 映射，不是建库工具

---

## 2. 边缘运行时（`src/edge_platform/`）

### 2.1 入口与装配

| 文件 | 职责 |
|---|---|
| `run.py` | 主入口。按 `EWOH_RUNTIME_MODE` 装配（production/development/simulation），production fail-fast 禁 stub |
| `runtime/bootstrap.py` | RuntimeFactory：按模式装配 Storage / Bus / AdapterManager / InferencePipeline |
| `runtime/dependencies.py` | 组件依赖注入容器 |

### 2.2 数据采集层（`edge/adapters/`）

| 适配器 | 协议 | 状态 |
|---|---|---|
| `ny_exo_a1/` | NXP1 线协议（CRC/重同步/SEQ 去重） | 成熟，`device_driver.py` TCP 接收端已补 |
| `actuator/` | Modbus/TCP 真帧 + OPC-UA 骨架 + 回环模拟 | Modbus 成熟；OPC-UA 骨架 fail-closed |
| `actuator/protocol.py` | 命令词表 + 授权指纹（v1/v2）+ 优先级 | 成熟，跨语言对齐已锁 |

### 2.3 推理引擎（`inference/`）

| 文件 | 职责 |
|---|---|
| `pipeline.py` | 每设备 2s 滑窗特征提取 → 规则/模型混合推理 → unknown 六路触发 |
| `rules.py` | 确定性规则引擎（POSTURE_BEND_LONG / LOAD_CONTINUOUS / SENSOR_DEGRADED 等） |
| `events.py` | 事件引擎：规则 draft → 开/关事件 + ±30s 证据窗口（均匀抽样/质量分级） |
| `features.py` | 12 维滑窗特征提取 |
| `model.py` / `train.py` | 模型注册表 / 训练 / 评测（默认无活动模型 → 规则降级） |

### 2.4 世界模型（`world_model/`）

| 文件 | 职责 |
|---|---|
| `state_store.py` | 双时态世界状态（当前/历史/at_time/snapshot） |
| `contract_store.py` | 契约校验 fail-closed（source_type 三态/时间单调/EntityDeclared） |
| `projection.py` | STREAM_TELEMETRY → 世界模型自动投影 |
| `prediction.py` | 规则式短期预测（疲劳/电量/延误/拥堵/离线） |

### 2.5 上行桥（`edge/bridge/`）

| 文件 | 职责 | 关键设计 |
|---|---|---|
| `sensor_uplink.py` | 传感器帧 → `/api/ingest/*` | 离线 JSONL 缓冲 + 崩溃安全（同锁串行）+ 4xx 死信 |
| `event_uplink.py` | 信封事件批量上行 | 契约校验 fail-closed + 有界缓冲 |
| `control_downlink.py` | 平台命令下行轮询 + 授权指纹回传 | 授权号只能由平台签发 + 重投队列 |
| `metrics_uplink.py` | 周期指标快照 | latest-wins，无磁盘队列 |
| `edge_to_spark.py` | 外骨骼统一帧上行 | 拉模式 + 批量 + 磁盘持久化队列 |

### 2.6 感知融合（`perception/`）

| 文件 | 职责 |
|---|---|
| `quality.py` | QualityStatus 四级质量 + 置信度乘数 |
| `pose_fusion.py` | PoseFusion 融合与摄像头丢失降级 |
| `uwb_fusion.py` | UWB 定位融合 |

### 2.7 调度（`scheduler/`）

| 文件 | 职责 |
|---|---|
| `scheduler_service.py` | 本地调度闭环：Top-K 影子方案 + 有效优先级 + 评分权重审计 |
| `cpsat/` | OR-Tools CP-SAT 精确求解器（独立 HTTP worker；本机零依赖，需另装 ortools） |
| `optimizer.py` | 贪心优化器（CP-SAT UNAVAILABLE 时回退） |
| `learning_loop.py` | 执行反馈学习建议（apply=False） |
| `planner.py` / `scoring.py` / `reservation.py` / `replanner.py` | 方案规划 / 评分 / 预约 / 局部重排 |

---

## 3. 平台后端（`ewoh-spark-app/server/`）

### 3.1 入口与装配

| 文件 | 职责 |
|---|---|
| `main.ts` | 传统入口（legacy）；安装 `installPgConnectionFaultGuard()` 进程级兜底 |
| `standalone-main.ts` | **生产入口**（`EWOH_DEPLOY_TARGET=standalone`）；bootstrapStandalone |
| `app.module.ts` | legacy AppModule（缺 RateLimitGuard/Tracing 等 12 个模块） |
| `standalone-app.module.ts` | **生产 AppModule**（全量模块 + 全局 Guard/Interceptor） |

### 3.2 全局切面（通过 `SharedModule` @Global 注册）

| 组件 | 职责 |
|---|---|
| `RolesGuard` | default-deny RBAC；`@Roles` / `@FallbackRoles` / `FALLBACK_CONTROLLER_ROLES` 三层 |
| `OrgContextInterceptor` | 每请求包 GUC 事务（`app.current_org_id` 等，transaction-local）；@Sse + @StreamingResponse 豁免 |
| `RateLimitGuard` | IP 限流（Redis 优先，内存回退） |
| `TracingInterceptor` | 请求链路追踪（SSE + Streaming 豁免） |
| `IdempotencyService` | 幂等存储（DbIdempotencyStore + DbPayloadStore） |
| `AuditService` | 结构化审计日志（DatabaseAuditSink → `ewoh_append_audit_log` SECURITY DEFINER） |
| `installPgConnectionFaultGuard()` | 进程级连接类故障兜底（仅连接类，不掩盖业务异常） |

### 3.3 业务模块职责一览（62 个，按域分组）

#### 调度域（最大，84 文件 / 34K 行）
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `scheduler/` | 调度 V2 全链：世界快照 → 优先级 → 资格 → 路径 → 求解 → 方案 → 审批 → 预约 → 派工 → SSE | SolverService / HeuristicSchedulingSolver / CandidateEngineService / EligibilityService / RoutingService |
| `scheduler/prediction/` | 经验时长模型 + shadow 评估 + canary 阶梯 | EmpiricalDurationPredictionProvider / ShadowEvaluatorService / DurationModelTrainingService |
| `task/` | 生产任务 CRUD + 状态机（draft→…→completed） | TaskService |
| `resource/` | 资源预占（人/设备/工位 CAS + advisory lock） | ResourceReservationService |

#### 感知域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `ingest/` | 真机接入网关（外骨骼/环境/摄像头/MES/空间/定位/安灯/事件/执行事实） | IngestService / SensorIngestService / DeviceExecutionReceiptService |
| `perception/` | 多模态感知融合（五条规则） | PerceptionFusionService |
| `rule-engine/` | 确定性规则引擎（DEVICE_OFFLINE / material-shortage 等） | RuleEngineService |
| `world/` | 世界模型查询（快照/回放/订单链） | WorldService / OrderChainService |

#### 控制域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `control/` | 高危物理指令生命周期：创建→审批→下发→投递确认→执行回执→撤回 | ControlService / ControlDeliveryBacklogWorkerService |
| `approval/` | 审批实例/步骤/决策投影/旁路/到期/自批回避 | ApprovalPersistenceService |
| `agent/` | Agent Runtime：L0-L3 分级 + 审批桥接 + 决策投影 | AgentService / AgentOrchestratorService |

#### 现场域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `exo/` | 外骨骼会话域：开始/结束/更正/佩戴绑定/一致性校验 | ExoSessionService |
| `alert/` | 安灯开灯→确认→处置→关闭→SLA 升级 | AlertService |
| `notification/` | 确定性通知号 + 渠道分发（app/lark/email） | NotificationService / ChannelDispatcherService |
| `data-quality/` | 数据质量确认/质疑 + 待核实提醒 | DataQualityService |
| `maintenance/` | 维护条件 + 调度封锁投影 | MaintenanceService |

#### 数据域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `materials/` | 物料库存/需求/缺口（一等实体 + 事件投影按物料合并） | MaterialsService |
| `mes/` | MES 工单/工序/质检（离线重放 + 幂等） | MesService |
| `erp/` | ERP 出站/订单（物料流动 → evidence.materialMovement） | ErpService |
| `master-data/` | 主数据能力导入 | MasterDataService |
| `workorder/` | 工单委托（canonical WorkOrder） | WorkOrderService |

#### 学习域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `learning/` | 学习信号→提案→影子→审批→激活→回滚 | LearningProposalService / LearningSignalService |
| `retrospective/` | 复盘/运行记忆（六段组装 + AI 总结双路留痕） | RetrospectiveService |
| `knowledge/` | 知识库（经验回流） | KnowledgeService |
| `improvement/` | 改进行动项（复盘经验→行动→逾期 sweep） | ImprovementActionService |

#### 智能域
| 模块 | 核心职责 | 关键服务 |
|---|---|---|
| `ai/` | LLM 解释/问答/方案摘要（narrationSource 双路留痕） | AiService |
| `reasoning/` | 实时风险推理（观测推导，不引入新事实） | ReasoningService |
| `agent/` | Agent Runtime（L0-L3 + 审批桥接） | AgentService |
| `simulation/` | 场景仿真（what_if/capacity/material_flow） | SimulationService |

#### 支撑域
| 模块 | 核心职责 |
|---|---|
| `auth/` | JWT 认证 + httpOnly refresh cookie 轮转 |
| `organization/` | 组织树 + 成员管理 |
| `audit/` | 审计查询 |
| `dashboard/` | 仪表盘 + 工作台聚合（now 端点） |
| `files/` | 文件上传/下载 |
| `work-orchestration/` | Work Graph 控制面（门禁/锁/工件/交接） |

---

## 4. 平台前端（`ewoh-spark-app/client/src/`）

### 4.1 架构

```
app.tsx (Routes)
  └── Layout (侧栏导航 + 顶栏收件箱 + 面包屑 + 全局搜索)
       └── pages/ (31 个页面目录)
            └── *.tsx (组件) + *.test.tsx (渲染测试)
```

### 4.2 页面职责

| 页面 | 角色 | 核心功能 |
|---|---|---|
| `FactoryOperations` | 全角色默认落地 | 设备概览 + 开异常列表 + 活跃方案 + WorkbenchNowPanel 决策队列 |
| `ShiftWorkbench` | 班组长 | 当班横幅 + 异常处置 + 待审批方案 + 执行偏差 + 物料缺口 + 交接登记 |
| `ApprovalConsole` | 班组长/安全员 | 待批审批 + 执行边界授权 + 通知中心 + 运行记录 |
| `CommandMap` | 调度员 | 全屏指挥地图：世界模型 + 方案对比 + 人工覆盖 + SSE 实时 |
| `Scheduling` | 调度员 | 排产列表 + 方案卡片 + 分波派工 |
| `FieldOperations` | 现场人员 | 现场提醒 + 回执 + 偏差 |
| `MobileWorkbench` | 现场人员 | 离线扫码 + 工序报工 + 待同步队列 |
| `LearningConsole` | 班组长/安全员 | 学习信号 → 提案 → 影子 → 审批 → 激活 → 回滚 |
| `Exo` | 现场人员 | 外骨骼会话 + 佩戴绑定 + 一致性校验 |
| `Materials` | 班组长/调度员 | 物料库存 + 缺口 + 受影响订单 |

### 4.3 状态管理

- **react-query** 做所有服务端状态（`useQuery` + `queryKeys` 统一管理）
- **zustand** 无（未使用）
- **useState** 做本地 UI 状态
- 错误态统一通过 `QueryState` 组件（错误优先于空态）+ `ErrorState` 组件渲染

### 4.4 API 层

每域一个文件（`client/src/api/*.ts`），导出类型安全的函数。HTTP 客户端通过 `lib/http.ts` 的 `axiosForBackend` 统一管理（baseURL、拦截器、401 跳转）。

---

## 5. 共享契约层（`ewoh-spark-app/shared/`）

前后端同源：server 和 client 都直接 import 此目录。每个文件配有 `.spec.ts` 测试。

| 契约 | 职责 |
|---|---|
| `api.interface.ts` | **全量 API 类型定义**（所有请求/响应/实体类型，~2000 行） |
| `actuator.ts` | 执行机构命令词表 + 授权指纹（TS 侧） + 优先级 |
| `alert-state-machine.ts` | 告警状态机（转移表 + 角色条件 + 拓扑判断） |
| `event-catalog.ts` | 事件目录（69 类 CloudEvents 类型白名单） |
| `event-envelope.ts` | 事件信封（occurred/observed/received + dedup key） |
| `decision.ts` | Canonical DecisionRecord（8 种决策类型） |
| `execution-receipt.ts` | 执行回执契约（receipt-provenance-v1 策略） |
| `order-chain.ts` | 订单链（open order status 词表 + BOM 口径） |
| `material-inventory.ts` | 物料库存投影（余额/需求/缺口/影响面） |
| `exo-session.ts` | 外骨骼会话（偏差判定 + 预计结束来源） |
| `scheduler.ts` | 调度 V2 类型（WorldStateSnapshot / SchedulingPlanV2 / SchedulingPolicyConfig 等） |

---

## 6. 数据层

### 6.1 迁移链

98 项 standalone 迁移（001–100，缺 033/055），每项成对 rollback。由 `db/runner/run_migrations.js` 驱动，`standalone-chain.js` 控制顺序。

关键迁移节点：
- 001: 基础 schema（56 表）
- 004: 域持久化（6 表：resource_locks/handoffs/git_sync/evidence_metadata/factory_replication/idempotency_keys）
- 017: 调度 V2 表
- 025/028: 调度 RLS（三分类：TENANT_SCOPED / GLOBAL_SHARED / DERIVED）
- 029: prediction_shadow_observation
- 032: identity_mapping
- 049: agent_approval
- 057: RLS NULL reject（org_id NOT NULL 收紧 + 无 NULL 放行策略）
- 067: scheduling org RLS（route_node/edge org_id + RLS）
- 074-078: 班次/数据质量确认/方案回滚/复盘/改进项
- 095: 控制命令 delivered_at
- 097: 幂等 payload 指纹表
- 098: 域表 RLS 补齐（resource_locks/policy_replay/factory_replication_sessions）
- 099: 物料一等实体（material/stock/requirement 三表）
- 100: 通知号唯一性收敛 org 作用域

### 6.2 RLS 策略

106/114 张物理表启用 RLS。策略模式：
- TENANT_SCOPED：`org_id = current_setting('app.current_org_id')`（大多数表）
- GLOBAL_SHARED：仅记录血缘不隔离（outbox/world_state_snapshot/assignment_event/prediction_shadow_observation）
- 表达式唯一索引：`COALESCE(org_id::text, '')` 归一处理 NULL org

未开 RLS 的 8 张表在 `scripts/audit-unrls-tenant-tables.js` 门禁中显式裁决。

### 6.3 数据流向

```
边缘采集（传感器/外骨骼） 
  → IngestService（校验/规范化/幂等） 
    → ewoh_telemetry / ewoh_event（主事实）
      → RuleEngine（规则评估）
        → 异常事件 / 通知（派生事实）
      → WorldStateSnapshotService（世界快照）
        → SchedulerRunOrchestrator（调度触发）
          → solveVariants（启发式/MILP/CP-SAT）
            → SchedulingPlanV2（方案）
              → ApprovalService（人工审批）
                → DispatchCoordinator（派工 → 通知 → 预占）
                  → ewoh_scheduling_execution（执行事实）
                    → SchedulingFeedbackService（反馈基线 + actual）
                      → ShadowEvaluatorService（学习信号）
                        → DurationModelTrainingService（模型重训）
```

---

## 7. 关键入口与配置文件

| 文件 | 职责 |
|---|---|
| `ewoh-spark-app/server/main.ts` | 传统入口 + PgFaultGuard 安装 |
| `ewoh-spark-app/server/standalone-main.ts` | 生产入口（bootstrapStandalone） |
| `ewoh-spark-app/server/standalone-app.module.ts` | 全量模块装配（所有 Guard/Interceptor/Module） |
| `ewoh-spark-app/.env.local-standalone` | 本地 standalone 运行配置 |
| `ewoh-spark-app/tsconfig.node.json` | 服务端 TS 编译配置 |
| `ewoh-spark-app/tsconfig.app.json` | 前端 TS 编译配置 |
| `ewoh-spark-app/vite.config.ts` | Vite 构建配置 |
| `openapi/ewoh.yaml` | API 唯一事实源 |
| `db/contracts/schema-manifest.yaml` | schema 规划期清单（068+ 表由迁移链接管） |
| `deploy/.env.example` | 部署参数模板 |
| `deploy/cloud/Dockerfile.api.ecs` | ECS Docker 镜像构建文件 |
| `scripts/local-up.sh` | 本地一键启动（PG + 迁移 + 种子 + 账号 + 服务） |
| `src/edge_platform/run.py` | 边缘运行时入口 |

---

## 8. 代码质量观察与改进点

### 8.1 已知巨石（Strangler 候选）

| 文件 | 行数 | 问题 |
|---|---|---|
| `heuristic-scheduling-solver.ts` | ~2000 | 纯函数 + 内联候选分支 + engine 路径 + reuse fast-path 混合 |
| `world-state.service.ts` | ~1900 | 快照构建 + 版本分配 + 契约自检 + 安全事件解析混合 |
| `work-orchestration.service.ts` | ~2800 | 门禁/锁/工件/交接/导出混合；HTTP 读路径有同步 IO |
| `control.service.ts` | ~2500 | 命令生命周期全链（创建/下发/投递/回执/撤回/巡检）单文件 |
| `plan.service.ts` | ~1900 | 方案 CRUD + 约束加载 + 仿真 + 决策投影混合 |

**建议**：按 Strangler 模式逐步拆分，每个拆分需有表征测试锁定既有行为。

### 8.2 模式不一致

| 模式 | 位置 A | 位置 B | 差异 |
|---|---|---|---|
| 租户谓词 | standalone_001（GUC + org 可见函数） | standalone_025+（直接 GUC 精确匹配） | 组织树 scope vs 单 org 精确匹配 |
| 幂等实现 | IdempotencyService（通用） | 各模块散落的确定性 ID | 两种幂等模式并存 |
| 审计写入 | AuditService（统一入口） | 部分模块直接调用 ewoh_append_audit_log | 入口不统一 |
| 缓存策略 | OverviewCache（5s TTL） | MaterialsSnapshotFactsCache（15s TTL） | 无统一缓存管理器 |

### 8.3 改进建议（按优先级）

1. **统一租户谓词语义**：所有 RLS 策略收敛为一种模式（建议 GUC 精确匹配 + 组织树 scope 可选扩展）
2. **拆分 heuristic-scheduling-solver**：候选分支内联逻辑与 engine 路径分离；duration 模型解析独立成模块
3. **Work-orchestration 同步 IO 消除**：替换 readFileSync 为异步，或将 Work Graph 持久化迁移到 PG
4. **通知号前缀加 org 段**：消除跨租户通知压制的结构性风险
5. **schema-manifest 现代化**：068+ 表补登记（或正式声明 drift boundary 并由迁移链接管）
6. **统一缓存管理器**：TTL/失效/租户隔离逻辑收口到单一组件

### 8.4 已确立且不可回退的设计决策

以下决策经过充分论证并有测试锁定，**不应回退**：

| 决策 | 依据 |
|---|---|
| 训练样本资格：只有 device_receipt 来源可训练 | 防伪造不变量（`training-sample-eligibility.ts`） |
| 通知号确定性：NTF-<域>-<业务>-<桶>-<收件人>-<渠道> | 幂等 + 可分类 + 可多收件人 |
| 授权指纹：v2 (HMAC-SHA256) 仅在配置密钥时启用 | v1 一致性校验不安全但不拒绝 |
| 安全动作（stop）永不受审批/配额约束 | 安全不变量（NO-62b） |
| 匿名 /health/ready 只暴露 {status} | NEST-437 安全收敛 |
| 边缘 production 模式拒绝明文 http | X-Ingest-Key 会暴露 |
| instance-level guard 只接管连接类故障 | 不掩盖业务异常 |
EOF
wc -l docs/reviews/2026-09-14-codebase-walkthrough.md