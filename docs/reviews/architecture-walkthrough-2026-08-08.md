# EWOH 仓库系统性走读报告

> 走读日期：2026-08-08
> 版本基线：`0.6.0-rc4`（version.json / CHANGELOG）
> 走读范围：全仓库 15 个顶层目录（src / ewoh-spark-app / ewoh-feishu-app / contracts / openapi / db / catalog / deploy / docs / tests / scripts / tools / security / ui / delivery / release）

---

## 1. 仓库总览：多运行时单仓库

EWOH（Exoskeleton Worker Operation & Harmony）是面向制造现场的外骨骼人员作业协同与风险分析平台。仓库为**多运行时单仓库**，由三大运行时 + 一层共享契约 + 一套工程治理体系构成：

```text
EWOH (0.6.0-rc4)
├── 运行时 1: src/edge_platform/        Python 边缘平台（纯标准库，零第三方运行时依赖）
├── 运行时 2: ewoh-spark-app/           NestJS 云侧后端 + React 前端（主产品）
├── 运行时 3: ewoh-feishu-app/          Express + SQLite 飞书侧车（消息/审批）
├── 契约层:   contracts/ openapi/ db/ catalog/  跨运行时共享契约（状态机/事件/OpenAPI/SQL/资产）
├── 工程治理: scripts/ tools/ tests/ security/  deploy/ docs/  门禁矩阵与部署编排
└── 冻结产物: delivery/ release/        交付包与 RC 发布快照（非活跃源码）
```

关键决策：**Python 边缘平台零第三方运行时依赖**（`pyproject.toml` dependencies=[]），云侧使用 Drizzle ORM + PostgreSQL RLS 实现多租户隔离，CP-SAT 求解器为可选实验特性（生产 canonical 求解器为启发式）。

---

## 2. 目录层级走读

### 2.1 `src/edge_platform/` — Python 边缘运行时（177 个 .py，核心 28,646 行）

| 子目录 | 职责 | 关键文件 |
|--------|------|----------|
| `runtime/` | 运行模式解析 + 依赖装配（DI） | `bootstrap.py`（RuntimeFactory）、`dependencies.py`（build_real_components）、`protocols.py` |
| `edge/` | 实时数据链核心 | `manager.py`（AdapterManager）、`bus.py`（MessageBus）、`storage.py`（SQLite, 1186 行）、`backfill.py`、`exo_semantic.py`（统一语义帧） |
| `edge/adapters/` | 设备适配器（模板方法模式） | `ny_exo_a1/`（真机 NXP1 协议，668 行）、`camera/`、`environment/`、`mes/`、`uwb/`，均继承 `base.py:BaseAdapter` |
| `connectors/` | 协议连接器 | `modbus.py`、`opcua.py`、`sparkplug.py`（452 行）、`webhook.py`、`csvfile.py`、`runtime.py` |
| `inference/` | 推理管线：特征→分类→规则→事件 | `pipeline.py`（465 行）、`features.py`、`rules.py`、`events.py`、`fatigue.py`（440 行）、`spatial_rules.py`（892 行）、`model.py`、`rule_registry.py` |
| `scheduler/` | 智能调度闭环（Scheduler V2） | `scheduler_service.py`（635 行）、`optimizer.py`、`scoring.py`、`constraints.py`、`reservation.py`、`planner.py`、`priority.py`、`learning_loop.py`、`events.py`、`cpsat/`（可选 OR-Tools） |
| `world_model/` | 世界状态历史与回放 | `world_state.py` 等 |
| `spatial/` | 坐标/实体/拓扑/多工厂 | `multi_factory.py`（495 行） |
| `perception/` | 多源感知融合 | `pose_fusion.py`、`uwb_fusion.py`、`ark_vision.py`、`vision_adapter.py`、`quality.py` |
| `governance/` | 数据治理 | `consent.py`、`model_registry.py`、`purge_executor.py`、`retention.py` |
| `policy/` | Rego 策略子集 | `rego.py` |
| `rbac/` + `auth/` | 权限矩阵 + 身份 | `permissions.py`、`roles.py`、`identity.py`、`session.py` |
| `monitoring/` + `audit/` | 指标 + 审计 | `collector.py`、`exporter.py`、`logger.py` |
| `edge/bridge/` | 边缘上行 | `edge_to_spark.py`（356 行，POST /api/ingest，断线退避+批量补传） |
| `aas/` | 资产管理壳（IEC 63278） | `codec.py` |
| 顶层 | HTTP API 层 | `server.py`（1649 行，ThreadingHTTPServer + SimpleHTTPRequestHandler）、`services.py`（631 行）、`config.py`、`security.py`、`selfcheck.py` |

**启动链路**：`run.py:main()` → `RuntimeFactory.assemble(mode)` → production 下真实装配失败即非零退出（P0-EDGE-001/002，禁静默 stub）→ 装配顺序：`Storage → MessageBus → ModelRegistry → RuleEngine → InferencePipeline → AdapterManager`；随后单独装配调度闭环 `WorldStateService → RoutePlanner → ReservationService → Scorer → GreedyOptimizer → Planner → SchedulerService`，并从 SQLite 恢复调度状态（`hydrate_from_repository`）。

### 2.2 `ewoh-spark-app/` — 云侧主产品（NestJS 10 + React 19）

**server/**（NestJS，42 个模块）：
- 双启动模式：`main.ts` 按 `EWOH_DEPLOY_TARGET=standalone` 分流 `bootstrapStandalone()`（`standalone-main.ts`）或 legacy
- 全局装配：`APP_PIPE`（校验）、`APP_FILTER`（GlobalExceptionFilter）、`APP_GUARD`（AccessTokenGuard + RolesGuard + RateLimitGuard）、`APP_INTERCEPTOR`（OrgContextInterceptor + MetricsInterceptor + TracingInterceptor）
- 核心模块：`auth`（JWT+refresh 轮换）、`scheduler`（调度 V2 核心）、`world`（世界状态+回放）、`ingest`（真机遥测接入）、`organization`、`task`、`work-orchestration`、`spatial`、`dashboard`、`rule-engine`、`audit`、`resource`、`policy`、`approval` 等
- **数据访问**：Drizzle ORM + postgres-js，`schema.ts` 由数据库反向生成；RLS 通过请求级事务 GUC（`app.user_id/current_org_id/current_org_ids/is_global_admin`）双保险实现

**client/**（React 19 + Vite 7 + Tailwind 4 + React Query 5 + Zustand）：
- 分层清晰：`api/`（按域封装）→ `hooks/`（useSchedulerStream SSE）→ `components/` → `pages/`（20+ 页面）
- `lib/http.ts` 唯一 HTTP 出口（axios + 401 单飞 refresh）
- 实时：Scheduling 页 fetch+ReadableStream 手解析 SSE（sequence 去重/缺口 resync/3 次失败降级轮询）；CommandMap 页纯轮询（2s/5s/30s 多档）

### 2.3 `ewoh-feishu-app/` — 飞书侧车（Express + SQLite）

- 链路：模拟器/事件 → `rules.js` 状态机 → `events.createEvent` → `feishu.sendAlertCard`（lark-cli）→ `sync.syncEventCreate`（多维表格）
- 卡片按钮 → `/webhook/card` → `security.verifyWebhookRequest`（token 校验 + 时间戳窗口 ±5min + HMAC + 30min 防重放）→ `events.handleEvent` → 更新卡片 + 回写 Base
- 写操作 fail-closed：`FEISHU_VERIFICATION_TOKEN` 缺失即拒绝

### 2.4 契约层与工程治理

| 目录 | 内容 | 说明 |
|------|------|------|
| `contracts/` | state-machines（task/plan/alert/approval/fleet/control）、events（AsyncAPI 事件目录 13 个 CloudEvents）、factory（golden-factory）、work（Work Graph schema）、policy（Rego）、mapping、artifact-schemas、repository-facts | 机器可读契约，单一事实源 |
| `openapi/` | `ewoh.yaml`（OpenAPI 3.0.3，236 路径键）+ route-manifest.json（304 controller keys） | 与 NestJS 路由零漂移（audit-openapi-routes.js 门禁） |
| `db/` | migrations（standalone_001~010 + legacy 001/002）、runner、seed、verify、contracts | Schema 唯一事实源为 `db/migrations/standalone_*` |
| `deploy/` | cloud/docker-compose.standalone.yml（postgres:17 + redis:7 + migrate job + api）、Dockerfile.api/migrate | 无反向代理与消息总线 |
| `catalog/` | connectors / factory-sites / mappings / scenarios 资产目录 | 工厂复制资产 |
| `scripts/` | 门禁/审计/DDL/发布脚本（audit-openapi-routes、truth-manifest、audit-repo-facts、connector-tck、bandit-gate、generate-sbom 等 20+） | 工程治理门禁矩阵 |
| `tools/` | gate-engine、resource-registry、factory-replication、work-console、work-indexer、handoff-service、run_demo | 治理工具 |
| `tests/` | 仓库级契约测试（10 个 test_*.py + edge/） | P0-EDGE 系列门禁 |
| `security/` | access-matrix.yaml（四层访问矩阵）、gitleaks 配置、bandit 豁免 | 安全基线 |
| `docs/` | 15 个子目录（architecture/api/operations/acceptance/audit/remediation/reviews 等 63 篇 md） | 活跃开发文档 |

---

## 3. 核心数据流

### 3.1 实时设备数据链（边缘）
```
Device → Edge Adapter（模板方法解析原始帧）→ 统一语义帧（UnifiedExoFrame）
       → AdapterManager._read_loop → storage.insert_telemetry + bus.publish(STREAM_TELEMETRY)
       → InferencePipeline（2s 滑窗/1s 步长）→ extract_features(12维) → ActionModel.predict
       → 六路 unknown 复核 → rules.on_inference → EventEngine（±30s 证据窗口）→ risk_event
       → SparkBridge POST /api/ingest/exoskeleton/batch（断线指数退避 + 批量补传）
```

### 3.2 Web 请求链（云侧）
```
React → Axios → AccessTokenGuard（JWT+组织展开）→ RolesGuard（无声明默认拒绝）
      → RateLimitGuard → OrgContextInterceptor（构建 4 个 GUC）
      → RequestDatabaseContext.runInTransaction（每请求单连接单事务 + set_config 事务级 GUC）
      → Drizzle Service（Proxy 化 database）→ PostgreSQL RLS 强制隔离
```

### 3.3 调度闭环（Scheduler V2）
```
Task/Person/Device/Spatial → WorldStateSnapshot（版本化 WS-YYYYMMDD-NNNN）
  → PriorityEngine（生产影响）→ Eligibility（硬约束）→ RouteCost
  → Solver（heuristic canonical / CP-SAT 可选回退）→ Top-K 影子方案
  → 人工审批（version+snapshotVersion 防 PLAN_STALE）→ 资源预约（renew/release/过期）
  → 派工（CAS 防重复下发）→ Outbox → SSE 推送（sequence 去重/缺口 resync/轮询兜底）
```

---

## 4. 依赖关系与代码组织

- **依赖方向**：`edge/adapters` + `connectors` → `edge/` → `inference/` → `server.py`；`scheduler/*` 独立成环；`edge/bridge` → 云侧 `/api/ingest`；云侧 `ingest` → `world`/`events`；飞书 app → 云侧 API + lark-cli。
- **跨运行时契约**：`contracts/state-machines/*.yaml` 被 Python 状态机测试（`test_state_machine_contract.py`）和 NestJS 状态机共同消费；`openapi/ewoh.yaml` 被路由审计门禁约束。
- **组织模式**：策略+工厂（RuntimeFactory/求解器）、模板方法（BaseAdapter）、观察者（MessageBus）、状态机（Plan/Task）、统一语义转换（map_vendor_to_unified 防字段泄漏）、构造器注入 + Protocol 契约。

---

## 5. 代码质量问题与改进点（按严重度）

### 5.1 高严重度
| # | 问题 | 位置 |
|---|------|------|
| H1 | 双总线契约冲突：`edge/bus.py:MessageBus`（handler 回调语义）与 `scheduler/events.py:EventBus`（queue 语义）并存，run.py 同时注入 event_bus 与 kafka | `src/edge_platform/run.py:140-165` |
| H2 | 两代遥测帧格式断裂：UnifiedExoFrame（entity_id/event_time/pose/load）与 `storage.insert_telemetry`（device_id/timestamp/telemetry/quality）字段不对齐，存在 KeyError 隐患 | `edge/exo_semantic.py` vs `edge/storage.py` vs `inference/features.py` |
| H3 | feishu-app `api.js` 事件处置接口无鉴权：验签仅保护 `/webhook/card`，`POST /events/:event_id/handle` 任何人可调用 | `ewoh-feishu-app/server/api.js:152` |
| H4 | feishu-app `db.js:117` 使用内存库 `:memory:`：进程退出数据全丢，与 30s 全量同步设计矛盾 | `ewoh-feishu-app/server/db.js:117` |
| H5 | scheduler.service.ts 2019 行超大文件 + V1 legacy 权重体系与 V2 版本化策略双轨并存 | `ewoh-spark-app/server/modules/scheduler/scheduler.service.ts` |
| H6 | work-orchestration 用 `node:fs` 文件系统当存储，多实例有状态一致性与并发风险 | `ewoh-spark-app/server/modules/work-orchestration/` |

### 5.2 中严重度
| # | 问题 | 位置 |
|---|------|------|
| M1 | 反向依赖 stub：`audit/logger.py:10` 导入 `edge_platform.stubs.Storage`，生产路径依赖测试替身 | `src/edge_platform/audit/logger.py` |
| M2 | SSE 单机假设：`scheduler-stream.service.ts` 进程内轮询 + seenEventIds Set 无上限增长 | `ewoh-spark-app/server/modules/scheduler/` |
| M3 | 异常覆盖不全：`exception.filter.ts` 仅特判 Postgres 22P02，其余 DB 错误落入 500 | `ewoh-spark-app/server/common/` |
| M4 | RLS 覆盖不一致：ewohNotification/ewohOutbox/ewohWorldStateSnapshot 等表无 org_id 列 | `db/migrations/standalone_*` |
| M5 | 重复实现：`spatial/__init__.py` 与 `inference/__init__.py` 各有一套 new_id；_now_iso/_now/now_iso 多处复制 | `src/edge_platform/` |
| M6 | 命名不一致：`scheduler/orchestrator.py:Scheduler`（旧）与 `scheduler_service.py:SchedulerService`（新）并存；connectors 与 edge/adapters 双轨 | `src/edge_platform/scheduler/` |
| M7 | 契约/资产目录重复：`contracts/catalog/` 与顶层 `catalog/`、`contracts/mapping/` 与 `catalog/mappings/` 职责重叠 | 仓库根 |
| M8 | 迁移双基线：`001_ewoh_managed_tables.sql`（121KB）与 `standalone_001_schema.sql`（88KB）并行重叠 | `db/migrations/` |

### 5.3 低严重度
| # | 问题 | 位置 |
|---|------|------|
| L1 | 魔法数字：pipeline.py 规则阈值(35/40/15/0.5/0.6)、events.py 证据配额、storage.py busy_timeout 未集中定义 | `src/edge_platform/inference/` |
| L2 | 被吞异常：`scheduler_service.py:150` hydrate 中 `except Exception: continue` | `src/edge_platform/scheduler/scheduler_service.py` |
| L3 | feishu rules.js 与 db.js 双份硬编码规则配置（注释自称唯一真源实为重复） | `ewoh-feishu-app/server/` |
| L4 | 前端 CommandMap 多路独立轮询与 Scheduling SSE 链路割裂 | `ewoh-spark-app/client/src/pages/CommandMap` |
| L5 | verify 期望值硬编码：run_migrations.js 内嵌表计数（=6/=16/=4） | `db/runner/run_migrations.js` |
| L6 | 工具链碎片化：work-indexer/gate-engine/work-console/resource-registry/handoff-service 各自独立 CLI | `tools/` |
| L7 | 测试副本扩散：release/ 各 RC 整目录复制 tests/ | `release/` |

---

## 6. 总体评价与改进路线

**优点**：
- 工程纪律强：契约驱动（状态机/OpenAPI/事件目录）、单一事实源审计、fail-closed 安全模式、production 禁 stub、RLS 双保险多租户，是 CI 门禁最完善的中型平台仓库之一
- 模块边界清晰：三运行时职责分离明确，适配器模板方法 + 策略工厂抽象到位
- 文档体系完整：63 篇 md 覆盖架构/运维/验收/审计，CHANGELOG 规范

**建议路线**：
1. **P0 修复**：统一边缘双总线、对齐统一语义帧与存储字段契约（H1/H2）；feishu-app 补 API 鉴权 + SQLite 落盘（H3/H4）
2. **P1 重构**：拆分 scheduler.service.ts 超大文件、收敛 V1/V2 双权重体系（H5）；work-orchestration 迁移 DB 存储（H6）
3. **P2 治理**：收敛迁移双基线、消除 contracts/catalog 与顶层 catalog 重复、verify 期望值由 schema-manifest 派生、release 测试副本改符号链接
4. **演进**：SSE 多实例化（Redis pub/sub 或 outbox 表轮询）、RLS 覆盖审计、feishu 同步改批量 API
