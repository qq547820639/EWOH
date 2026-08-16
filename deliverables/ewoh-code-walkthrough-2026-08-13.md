# EWOH 仓库系统性代码走读报告

> 走读时间：2026-08-13 · 版本基线：`0.6.0-rc4`（version.json）
> 走读范围：仓库根目录起，按目录层级系统性梳理（源码为主，产物/快照仅做治理评估）

## 0. 执行摘要

- EWOH（Exoskeleton Worker Operation & Harmony）是面向制造现场的**外骨骼人员作业协同与风险分析平台**，定位为"只读监督、风险分析与受控工作流系统"（安全闭环永久保留在设备控制器本地，见 SECURITY.md）。
- 仓库是**多运行时单仓库（monorepo）**：Python 边缘运行时（`src/edge_platform`，纯标准库零运行时依赖）+ NestJS/React 云侧主产品（`ewoh-spark-app`）+ 飞书侧车（`ewoh-feishu-app`），以 `contracts/ openapi/ db/ catalog/` 为跨运行时契约层，`deploy/ docs/ scripts/ tools/ security/` 为部署与工程治理层。
- 全仓库 19.2 万文件 / 2.4GB，其中 **2.1GB 在 `ewoh-spark-app/`**（node_modules 与 `dist/` 构建产物含嵌套 node_modules），真实源码仅约 1300 个文件：`src/` 6.4MB（202 个 py、4.6 万行）、飞书侧车 3.3k 行 JS、云侧 NestJS/React 若干万行 TS。
- 所有功能 `productionEnabled=false`（feature-status.yaml 单一事实源，`scripts/truth-feature-status.js` 行级强制）；Production Canonical Solver 为 Heuristic，CP-SAT 为 OPTIONAL/EXPERIMENTAL（fail-closed 回退）。

## 1. 仓库总体架构与目录层级

```
EWOH/
├── run.py                     # Python 零配置启动入口（根级快捷方式 → edge_platform.run:main）
├── pyproject.toml             # 项目元数据（纯标准库运行时；dev 依赖 ruff/bandit/pytest）
├── Makefile                   # 常用命令入口（run/test/lint/security/truth-check/各 TCK）
├── README.md                  # 产品手册（458 行，架构/部署/配置/API/场景/FAQ）
├── CHANGELOG.md               # Keep a Changelog 变更日志（58KB）
├── SECURITY.md                # 安全边界声明（只读监督定位、RLS 双策略、保留策略）
├── feature-status.yaml        # 功能事实清单（单一事实源，10 个 feature 布尔矩阵）
├── version.json               # 当前版本 0.6.0-rc4
├── requirements-dev.txt       # 仅开发依赖
├── .gitignore                 # 排除 node_modules/dist/db/output 等
├── src/edge_platform/         # ★ Python 边缘运行时（采集/推理/边缘调度/本地 API）
├── ewoh-spark-app/            # ★ NestJS 后端 + React 前端（主产品云侧）
├── ewoh-feishu-app/           # ★ 飞书侧车（Express + SQLite + 验签 webhook）
├── contracts/                 # 状态机/事件目录/工厂模板/Schema 共享契约
├── catalog/                   # 工厂模板/场景包/连接器/字段映射资产目录
├── openapi/                   # OpenAPI 契约（ewoh.yaml 403KB + work-orchestration.yaml）
├── db/                        # 迁移/回滚/Seed/验证与 Schema 清单（66 个迁移文件）
├── deploy/                    # Compose/Kubernetes/Helm/云部署编排
├── docs/                      # 活跃开发文档（23 个子目录：架构/ADR/运维/验收/审计）
├── tests/                     # 仓库级契约与验收测试（16 个测试文件）
├── scripts/                   # 门禁/审计/TCK/DDL/部署/发布脚本（约 60 个条目）
├── tools/                     # Work Graph/门禁引擎/资源注册/工厂复制等 8 个治理工具
├── security/                  # 访问矩阵与安全基线（6 个子目录）
├── ui/command_map/            # 历史指挥地图静态原型（UX 参考，非生产事实源）
├── delivery/                  # 冻结交付包（不可当活跃源码）
├── release/                   # rc1..rc4 发布快照（58MB，不参与运行时）
├── output/                    # 基准/证据清单等运行时产物（gitignore）
└── demo.db (+-wal/-shm)       # SQLite 演示库（110MB+，gitignore）
```

### 1.1 双控制面与三条关键链路（README §2 核对）

```
┌ 现场/边缘 ────────────────────────────────────────────────┐
│ Device → Edge Adapter → EventBus → 推理/规则 → WorldState │
│   → 本地 HTTP/SSE API（离线可用，python run.py :8765）     │
└──────────────┬────────────────────────────────────────────┘
               │ Edge Bridge（edge/bridge/edge_to_spark.py 真机数据上行）
┌ 云端/主产品 ─▼────────────────────────────────────────────┐
│ React SPA → NestJS API → PostgreSQL（RLS 多租户）          │
│  CommandMap 指挥地图 / 调度 V2 / 世界回放 / 治理            │
└──────────────┬────────────────────────────────────────────┘
               │
        ┌──────▼──────┐
        │ 飞书侧车     │（消息卡片/审批 webhook）
        └─────────────┘
```

- **Web 请求链**：`React → Axios → AccessTokenGuard → OrgContextInterceptor → RequestDatabaseContext（请求级事务+GUC）→ RLS → Service → DB`
- **实时设备数据链**：`Device → Edge Adapter → EventBus → 推理/规则 → World State → Cloud /api/ingest → Telemetry/Event → 指挥地图`
- **调度闭环**：`Task/Person/Device/Spatial → WorldStateSnapshot → Priority/Eligibility → RouteCost → Solver → Plan → Approve/Override → Reservation → Dispatch → Outbox/SSE`

## 2. 核心入口与配置

### 2.1 Python 边缘平台入口链（已亲验）

```
仓库根 run.py（sys.path 注入 src） 
  → edge_platform/run.py::main()
    → Settings.load()                       # config.py：环境变量单例（全部有默认值）
    → resolve_runtime_mode()                # runtime/bootstrap.py：production/development/simulation
    → RuntimeFactory(...).assemble(mode)    # production: 只允许真实组件，失败非零退出
    → ensure_scheduling_write_permitted()   # production+EWOH_EDGE_SCHEDULING_WRITE=1 → 启动即抛错
    → manager.start() / pipeline.start()    # 真实模式下显式启动采集线程与推理订阅
    → SchedulingRepository(storage, readonly=...)   # production 下调度仓储只读（advisory）
    → EventBus() → build_scheduler(...)     # WorldStateService/RoutePlanner/GreedyOptimizer/Planner/SchedulerService/ResourceStateService
    → scheduler.hydrate_from_repository()   # 重启恢复持久化调度态
    → services.register_scheduler_hook()    # 旧接口兼容适配
    → server.build_server(addr, ctx) → httpd.serve_forever()
```

- 运行模式门控（runtime/bootstrap.py）：
  - `production`：真实组件唯一；装配失败 → log ERROR + 非零退出，**绝不回退 stub**；
  - `development`（默认）：默认真实组件；stub 需显式 `EWOH_ALLOW_STUB=1`；
  - `simulation`：显式 stub + DemoSimulator（`--stub` 等价，仅工程自测）。
- 组件契约（runtime/protocols.py）：`EventBusProtocol / StorageProtocol / AdapterManagerProtocol / RuleEngineProtocol / InferencePipelineProtocol / ModelRegistryProtocol` + 7 个流名常量（唯一 StreamName 定义），真实组件与测试替身共用契约，防止生产装配漂移。
- 调度写所有权（P0-SCHED-OWNERSHIP）：connected production 下 Edge 仅 advisory（confirm/execute/replan 被拒），正式调度写权限唯一归 NestJS 控制面，避免 split-brain/double-dispatch。

### 2.2 配置项（config.py 已亲验，全部经环境变量，零配置可跑）

`EWOH_DB_PATH/DB_BACKEND/DB_URL`、`EWOH_HOST/PORT`（127.0.0.1:8765）、`EWOH_ADAPTER_PORTS`（9001:real,9002:controlled_test,9003:simulated）、`EWOH_OFFLINE_AFTER_SEC=10`、`EWOH_EVIDENCE_WINDOW_SEC=30`、`EWOH_DATA_RETENTION_DAYS=30`、`EWOH_RUNTIME_MODE`、`EWOH_CORS_ORIGINS`（production 必须显式 allowlist）、`EWOH_AUTH_BACKEND/JWT_SECRET/SESSION_TIMEOUT_SEC/LOGIN_FAIL_LOCK`、`EWOH_EXPORT_ALLOWED_ROLES`、`EWOH_TLS_CERT/KEY`、`EWOH_ARK_API_KEY/BASE_URL/MODEL`（视觉理解，未配置明确报错不伪造）。

云侧 Standalone：`DATABASE_URL`（必填）、`JWT_SECRET`（≥32 字符，否则启动失败）、`INGEST_API_KEY`（production 必填，缺失 fail-closed 503）、`EWOH_DEPLOY_TARGET=standalone`、`EWOH_SOLVER_ACTIVATION`（OFF/SHADOW/CANARY/PRODUCTION 阶梯）+ `EWOH_SOLVER_PRODUCTION_ENABLED`（生产门控）。

### 2.3 工程入口（Makefile / package.json scripts）

- `make run/run-stub/demo/test/test-contract/production-smoke/connector-tck/aas-tck/rego-tck/pilot-readiness/cross-tenant-tck/lint/security/truth-check/format/clean`
- spark-app scripts：`build:prod:standalone`、`gen:openapi`（契约优先）、`gen:db-schema`（schema.ts 反向生成）、`openapi:no-drift`、`bundle:budget`、`perf:gate`、`benchmark:scheduler`、`type:check`、`test/test:client/test:browser`、`contract:*`、`cross-tenant:tck` 等；依赖 NestJS 10 + `@lark-apaas/fullstack-nestjs-core`（低代码平台底座）+ drizzle-orm/postgres/jsonwebtoken/ioredis/ajv 等。

## 3. Python 边缘平台 src/edge_platform（包级结构）

【本部分与子代理 A 深读结果合并，见下文 §3.x】

已亲验要点：
- `routes/`（9 域 + registry.py 有序路由表）：health/inference/world/telemetry/scheduler/auth/admin/replay + `_util.py`；`registry.py` 按方法维度的域调度顺序（GET 8 域、POST 6 域、PATCH 2 域），返回 NOT_HANDLED 则回退静态文件。
- `server.py`（480 行）横切中间件：请求 ID（X-Request-ID 透传/生成）、CORS fail-closed（production 未命中 allowlist 不回送头）、1MB body 上限（超限分块排空防 RST）、统一错误信封 `{error:{code,message,request_id}}`（内部异常脱敏只进日志）、POST 自动审计（响应前落库防竞态）、production 写操作认证白名单（`/api/auth/login|refresh`）、production 速率限制（60 req/min/IP）。
- `storage.py`（1216 行）SQLite WAL 实现：person/device/telemetry/inference/risk_event/device_protocol_version/event_handling/assignment/model_registry/rule_registry/consent_record/audit_log 等表 + 治理迁移（migrations/v001_add_governance_tables.py）。
- `inference/pipeline.py`：订阅 telemetry，每设备 2s 滑窗（步长 1s），规则+模型混合；模型不可用退回规则模式（is_rule=True）；unknown 六路触发（data_quality/low_confidence/ambiguous/firmware_unverified/out_of_distribution/sensor_channel_missing）；consent 未授权帧不入库不发布。

## 4. 契约层 contracts/catalog/openapi/db

【本部分与子代理 B 深读结果合并】

已亲验要点：
- `db/migrations/` 66 个文件 = `001/002`（旧链，001 已标注 DEPRECATED）+ `standalone_001..0xx` 各含 .sql/.rollback.sql 成对；standalone 链是唯一权威 schema 事实源（README：生产部署不引用 delivery/release 的 SQL）；`db/contracts/schema-manifest.yaml` 记录受管表口径（57 张）。
- `openapi/ewoh.yaml` 403KB（256 个顶层 paths）+ `work-orchestration.yaml`（24 paths）+ `route-manifest.json`；`scripts/audit-openapi-routes.js` 守护与 NestJS 路由零漂移。
- 契约优先工作流：改 API 必须 `npm run gen:openapi`，改状态机必须同步 `contracts/state-machines/*.yaml` 并保持 Python 模型一致（Makefile `contract-state-machine` 门禁）。

## 5. 云侧 ewoh-spark-app 与飞书侧车

【本部分与子代理 C 深读结果合并】

已亲验要点：
- server/modules 共 40 个模块：aas/ai/alert/approval/audit/auth/control/dashboard/erp/events/files/gamification/health/hello/ingest/mes/metrics/mobile/model/observability/oee/onboarding/operations/organization/parameters/policy/resource/rule-engine/scale/scheduler/shared/simulator/spatial/system/task/timeline/tracing/view/work-orchestration/workflow/world/world-cursor。
- 入口：`server/main.ts` + `standalone-main.ts`（EWOH_DEPLOY_TARGET=standalone）；`database/schema.ts` 由 `gen:db-schema` 从 PG 反向生成。
- client/src：api/app/components/hooks/lib/pages/scheduler/types/utils + CommandMap 页面族。
- 飞书侧车（ewoh-feishu-app/server，3.3k 行）：index.js（320 行入口）、feishu.js（812 行，lark-cli 子进程）、sync.js（475 行）、db.js（471 行 better-sqlite3）、security.js、auth.js、api.js、rules.js、events.js、simulator.js、health.js；express + better-sqlite3 + cors；webhook 验签缺失 fail-closed；lark-cli spawnSync 20s 硬超时；flushTelemetry 失败保留 buffer。

## 6. 交付/部署/安全/文档/CI

【本部分与子代理 D 深读结果合并】

## 7. 工具/脚本/测试体系

【本部分与子代理 E 深读结果合并】

已亲验要点：scripts/ 约 60 个条目——audit-*（openapi-routes/event-catalog/golden-factory/mapping/policy/workflow/repo-facts/asset-catalog-contracts/factory-profile-contracts/work-graph-contracts/env-inventory）、truth-*（feature-status/gate/gate-record/manifest/source/status）、*-tck（connector/aas/rego/scenario/deployment/cross-tenant）、verify-*（helm/backup-restore/deploy-artifacts/domain-concurrency/migration-prod/rc-upgrade/scheduler-multitenant/standalone-security）、soak-*、release 脚本等；tests/ 16 个契约测试文件（golden-fixtures、edge 子目录）。

## 8. 关键问题清单（走读发现）

### 8.1 本人亲自验证的发现（均有代码证据）

- **【安全·中】PATCH 写路径缺少 production 认证门禁与审计**：`server.py` 中 production 写保护只挂在 `do_POST`（line 390，白名单 `/api/auth/login|refresh`），`do_PATCH`（`/api/tasks/{id}` 乐观锁更新，line 421-441）既无认证门禁也无 `_post_audit_pending` 审计。production 下无 token 的 PATCH 不会收到 401，而是进入领域逻辑（当前被 readonly 仓储兜底拒绝，属防御性重合而非设计）；development 下 PATCH 与 POST 行为也不对称。
- **【安全·中】审计身份信任客户端输入**：`routes/scheduler.py` 的 `_plan_action`（line 248）、`api_create_scheduling_request`（line 194）、`api_assignment_status`（line 324）及 `routes/world.py`（line 202/224）均用 `payload.get("actor_id"/"handler_id") or h._actor()`——客户端可自报操作人，绕过 Bearer token 身份，审计溯源可被伪造。
- **【仓库治理·高】构建产物与依赖入库膨胀**：`ewoh-spark-app/` 占 2.1GB/2.4GB——工作区含 `node_modules` 与 `dist/server/node_modules`（构建产物内嵌嵌套依赖，含 @opentelemetry 全套）；`ewoh-feishu-app/node_modules` 亦在工作区。虽 .gitignore 声明忽略，工作区体量使走读/备份/CI 成本畸高。
- **【仓库治理·中】AI 助手状态目录未全量忽略**：`.gitignore` 忽略 `.codebuddy/`、`.workbuddy/`，但 `.codex/`（artifacts 多版 authoritative-plan/state.json）与 `.trae/specs`（13 个 spec）未忽略，且 `release/`（58MB 快照）、`demo.db`（110MB+，虽声明忽略）均在树中。
- **【一致性·低】OpenAPI 计数口径**：README 声称 307 条去重路由/461 spec 条目，而 `ewoh.yaml` 顶层 paths 仅 256 + work-orchestration 24（嵌套与 $ref 展开后口径不同），依赖 `audit-openapi-routes.js` 才能对齐，文档数字为"生成后事实"而非"文件可见事实"。
- **【代码·低】遗留兼容层**：`services.py` 的 recommend/confirm_assignment 标注 deprecated 但保留双路径（旧行为 + scheduler hook 适配），`Context.kafka` 字段是 event_bus 的兼容命名别名（CHANGELOG 8.3 已澄清双总线职责，命名仍易误导）。

### 8.2 待合并各子代理发现

【merge-A: src 平台】【merge-B: 契约层】【merge-C: 云侧/前端】【merge-D: 交付部署】【merge-E: 工具脚本】

## 8.3 Python 边缘平台关键类/函数清单（亲验）

| 组件 | 位置 | 职责 |
|---|---|---|
| `Settings`（单例） | `config.py` | 环境变量配置加载，全默认值零配置启动 |
| `resolve_runtime_mode` / `RuntimeFactory.assemble` | `runtime/bootstrap.py` | 三模式装配：production fail-fast、development 显式 stub、simulation stub+simulator |
| `build_real_components` | `runtime/dependencies.py` | 真实生产路径装配（Storage/MessageBus/AdapterManager/RuleEngine/InferencePipeline/ModelRegistry），失败抛 RealAssemblyError |
| 协议族（`*Protocol`） | `runtime/protocols.py` | EventBus/Storage/AdapterManager/RuleEngine/InferencePipeline/ModelRegistry 契约 + 7 流名常量 |
| `Handler`（`make_handler`） | `server.py` | 纯标准库 ThreadingHTTPServer 处理器：请求 ID、CORS fail-closed、1MB body 上限、POST 审计、统一错误信封、production 认证/限流 |
| `dispatch` / `ROUTE_TABLE` | `routes/registry.py` | 按方法域路由表分发（GET 8 域 / POST 6 域 / PATCH 2 域） |
| `SchedulingWriteProhibitedError` / `ensure_scheduling_write_permitted` | `run.py` | production 下调度写权限 fail-closed 门禁 |
| `build_scheduler` | `run.py` | 装配 WorldStateService/RoutePlanner/ReservationService/Planner/SchedulerService/ResourceStateService，advisory_only 解析 |
| `SchedulerService` | `scheduler/scheduler_service.py` | 调度闭环：create_request→generate_plans→confirm→execute→replan→反馈；advisory_only 拒绝写路径 |
| `SchedulingRepository` | `scheduler/repository.py` | 调度数据 SQLite 持久化（readonly 开关，重启 hydrate） |
| `InferencePipeline` | `inference/pipeline.py` | 2s 滑窗步长 1s 规则+模型混合推理；unknown 六路触发；consent 门控 |
| `RuleEngine` | `inference/rules.py` | 风险规则引擎（on_telemetry/on_inference→风险事件） |
| `EventEngine` | `inference/events.py` | 事件生成与处置闭环（证据窗口/严重度 L1-L3） |
| `Storage` | `edge/storage.py` | SQLite WAL 持久层（遥测/推理/事件/人员/设备/调度/治理表 CRUD） |
| `AdapterManager` | `edge/manager.py` | 适配器生命周期管理（后台读取线程→storage+bus） |
| 适配器族 | `edge/adapters/*/adapter.py` | camera/environment/mes/ny_exo_a1/uwb 设备协议接入 |
| `MessageBus` | `edge/bus.py` | 流式数据通道（publish/subscribe/tail，与 SSE EventBus 职责分离） |
| `EventBus` | `scheduler/events.py` | 实时事件总线（SSE 抽干） |
| `services.recommend/confirm_assignment` | `services.py` | 旧任务推荐接口（deprecated，hook 转发 SchedulerService） |
| `services.answer` | `services.py` | 本地助手白名单问答（8 可答 7 拒绝，医学/控制类拒答） |
| `evaluate_scenario` | `services.py` | 场景评估器（加权评分+一票否决） |
| `StateMachineLoader` | `contracts/state_machine_loader.py` | 从 contracts/state-machines/*.yaml 加载状态机 |

## 8.4 Edge 数据流（亲验）

```
Adapter(read thread) ──telemetry──▶ MessageBus ──subscribe──▶ InferencePipeline
                                        │                        │(2s滑窗,特征,规则+模型)
                                        │                        ▼
                                        │                    EventEngine
                                        │                        │(风险事件 L1-L3, 证据窗口)
                                        ▼                        ▼
                              Storage(SQLite WAL: telemetry/inference/risk_event/…)
                                        ▲                        │
                                        │                        │
                           routes/*（GET/POST/PATCH 域路由）◀─────┘
                                        │
                              EventBus(SSE) ──▶ GET /api/command-map/stream
                                        │
                              edge/bridge/edge_to_spark.py ──▶ Cloud /api/ingest（X-Ingest-Key）
```

## 9. 改进建议（汇总）

【待合并后统一输出，含 OPEN-DECISIONS 未决项：CP-SAT 生产启用（唯一 OPEN）】
