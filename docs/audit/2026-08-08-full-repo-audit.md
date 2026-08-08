# EWOH 全仓系统性架构审计与技术尽调报告

> 审计人：CodeBuddy 架构审计 Agent
> 基线 Commit：`ba7db6b81ede44238905ed2796b9dd7c4b6ba2db`（2026-08-08 09:30:20 +0800, panhao）
> 审计时间：2026-08-08
> 方法：源码精读 + 实际执行（unittest / pytest / tsc / jest）+ 静态扫描；所有结论标注验证状态。

---

# 1. Executive Summary（执行摘要）

1. **P0-1｜Python 边缘平台"真实模块装配"路径永久失效，生产静默运行 Stub**（`src/edge_platform/run.py:29-34`）。`from edge.bus import Bus` / `from inference.pipeline import InferencePipeline` 等 6 条顶层 import 路径错误（正确应为 `edge_platform.edge.bus` / `edge_platform.inference.pipeline`），且 `src/edge_platform/edge/manager.py`、`edge/storage.py` 根本不存在。`python run.py` 实测永远打印 `[EWOH] 真实模块未就绪（No module named 'edge'），回退到 stub 模式`。**VERIFIED_BY_RUNTIME**

2. **P0-2｜Python 测试通过 ≠ 生产可用，测试环境 sys.path 掩盖了装配失败**。731 个 unittest 全绿，是因为每个测试文件头部 `sys.path.insert(0, .../edge_platform)` 使顶层 `edge.*`/`inference.*` 恰好解析到 `edge_platform/edge`、`edge_platform/inference`；生产 `run.py` 只插入 `src/`，解析失败。**VERIFIED_BY_CODE / VERIFIED_BY_RUNTIME**

3. **P0-3｜Stub Bus 与真实 MessageBus 接口契约不兼容**。`stubs.Bus.subscribe(topic)` 返回 `queue.Queue`（publish 无回调），`edge_platform/edge/bus.py MessageBus.subscribe(stream, handler)` 返回 sub_id 字符串。真实 `InferencePipeline.start()`（`pipeline.py:425-430`）用的是 queue 语义。即使修正 import，直接替换也会运行时报错。**VERIFIED_BY_CODE**

4. **P1-1｜`collection/dataset.py:17`、`collection/session.py:14`、`tests/test_inference.py` 等 24 处坏 import**（`from inference import ...`），`collection` 子包在生产 import 链上不可用。**VERIFIED_BY_CODE / VERIFIED_BY_RUNTIME**

5. **P0-4｜NestJS 侧 CP-SAT DecisionTrace 存在占位值**：`cp-sat-scheduling-solver.ts:420` `priority: { level: 'computed', score: 0, factors: [] }`、`candidates: []`。CP-SAT 回退/不可达时启发式才是真实执行路径，但 CP-SAT 分支的决策追踪是空壳。**VERIFIED_BY_CODE**

6. **P1-2｜CP-SAT 求解器在默认部署下不会真正运行**。NestJS `CpSatSchedulingSolver` 通过 HTTP 调 `http://127.0.0.1:8000/api/scheduler/v2/solve`；Python 侧该端点需 `ortools`（pyproject 明确零第三方依赖），未安装时返回 `UNAVAILABLE` → 恒回退启发式。单元测试日志证实 `CP-SAT worker 不可达...回退启发式`。**VERIFIED_BY_RUNTIME（测试日志）/ VERIFIED_BY_CODE**

7. **P1-3｜WorldState 当前状态查询为"全表加载 + Node 内存去重"**：`world.service.ts:64-77` 将 `ewohWorldState` 全量拉入内存用 Map 去重（未用 DISTINCT ON / ROW_NUMBER / LATERAL）。数据规模扩大后必然成为瓶颈。**VERIFIED_BY_CODE**

8. **P1-4｜Ingest 批量处理为逐条串行 DB 往返**：`ingest.service.ts:66-75` `for frame: await processOneFrame()`，每帧至少 3 次 DB round-trip（entityExists + isDuplicateRawRef + insert + upsertDevice），batch≤100 即 300+ 次往返，未批处理、无事务包裹（部分路径）。**VERIFIED_BY_CODE**

9. **P1-5｜Feishu webhook `/webhook/card` 无任何验签**：`ewoh-feishu-app/server/index.js:87-155` 直接信任 body 的 `open_id`/`action`，`acknowledge/resolve/escalate` 可被未经验证请求调用；无 timestamp/nonce/签名校验。同时 `app.use(cors())` 全开、simulator 默认启动、`express.json()` 无 body limit。**VERIFIED_BY_CODE**

10. **P2-1｜Scheduler 存在多套实现与命名漂移**：Python 有 `scheduler_service.py`（SchedulerService，生产接入）+ `orchestrator.py`（Scheduler，旧实现，仅被 learning_loop/`__init__` 间接引用）；NestJS 有 legacy `scheduler.service.generatePlans/getDataDrivenPlans`（模板化方案）+ V2 `createRun→solveVariants→heuristic/CP-SAT`。`/api/scheduler/plans` 等 legacy 端点仍注册且标注 deprecated。**VERIFIED_BY_CODE**

11. **P2-2｜`shared/api.interface.ts` 2045 行 / 129 个 type-interface / 92 个 importers**，是前后端契约集中点与合并热点。**VERIFIED_BY_CODE**

12. **P2-3｜WorkOrchestrationService 1549 行、DomainPersistenceService 864 行**，同时承担 work-graph 索引、gate 计算、git-sync、handoff、filesystem 访问、DB 持久化等职责，且与 `tools/work-indexer`/`tools/gate-engine` 等 CLI 存在功能重复。**VERIFIED_BY_CODE**

13. **P2-4｜数据库 Schema 多事实源风险**：Drizzle `schema.ts`（auto-generated, 88 个表）+ `db/migrations/standalone_*.sql`（56+ 表）+ `delivery/02_技术规范/database.sql`（冻结 SQLite 基线）+ `release/ewoh-0.6.0-rc{1,2}/db/*` 快照。schema.ts 由 `@lark-apaas/db-schema-sync` 从 DB 生成，方向正确，但 delivery/release 快照存在漂移风险。**VERIFIED_BY_CONFIG**

14. **P2-5｜Route fallback ETA=0**：`routing.service.ts:238` euclidean_fallback `etaSeconds: 0`，`route-cost.provider.ts` euclidean 分支用 `distance/speed` 计算，两条 fallback 路径语义不一致；同时 `dispatch-coordinator.service.ts:129` 缺 `plannedEnd` 时用 `startMs + 3600_000`（1h 硬编码）而 solver 默认时长 30min（`DEFAULT_DURATION_MS=1_800_000`）。**VERIFIED_BY_CODE**

15. **P2-6｜Scheduler 存在两种实时通道**：世界状态 2s polling（CommandMap `refetchInterval: 2000`），调度走 SSE（`/api/scheduler/v2/stream`，带 sequence 去重 + 缺口重同步 + 轮询兜底，设计良好）。这是"双状态源"但实现侧已做收敛（SSE 事件写 React Query 缓存）。**VERIFIED_BY_CODE**

16. **P2-7｜Root `ui/command_map` 是静态 UX/Prototype 参考**（V0.2 独立 HTML），无任何生产 import；`client/public/command_map` 是静态资源副本。生产 React CommandMap 是独立实现。**VERIFIED_BY_CODE**

17. **P2-8｜`demo.db`（110MB）+ demo.db-wal/shm 在仓库根目录**（未入库，但占工作区空间；pyproject 已 exclude）。

18. **P1-6｜测试缺口导致 P0-1/P0-2 未被发现**：无"生产装配路径"测试（无测试对 `run.py build_components` 非 stub 分支做 import 校验）；`Makefile test` 不覆盖 `run.py` 装配；契约测试 `tests/` 只测适配层/TCK，不测平台装配。

19. **P2-9｜OpenAPI 与 NestJS routes 无漂移**（`openapi/route-manifest.json`：undocumented=0, unimplemented=0），有 `gen:openapi --check` CI 门禁；`ewoh.yaml` 13623 行单文件，建议按域拆分但保留 bundle 生成流程。**VERIFIED_BY_CONFIG**

20. **P3-1｜工程治理体系完善**：truth-check（证据清单）、audit-repo-facts、gate-engine、cross-tenant-tck、perf gate、deploy tck 等一应俱全；`db/contracts/schema-manifest.yaml` 定义了 managed tables。整体工程纪律明显优于一般试点项目。

---

# 2. Repository Baseline

```text
Repository: git@github.com:qq547820639/EWOH.git
Branch: main
Commit SHA: ba7db6b81ede44238905ed2796b9dd7c4b6ba2db
Commit timestamp: 2026-08-08 09:30:20 +0800
Working tree status: CLEAN
Remote: origin git@github.com:qq547820639/EWOH.git
Analysis timestamp: 2026-08-08 10:3x (+0800)
```

---

# 3. Repository Coverage Report

总文件（git tracked）6046；工作区 6152（含 demo.db 等未跟踪文件）。

| Directory | Total Files | Deep Read | Structural Scan | Skipped | Classification | Skip Reason |
| --------- | ----------: | --------: | --------------: | ------: | -------------- | ----------- |
| `src/edge_platform/` | 192 | 55 | 60 | 77 | Production Edge Source | 适配器/测试细节 |
| `ewoh-spark-app/server/` | 234 | 40 | 80 | 114 | Cloud Backend | 通用模块细节 |
| `ewoh-spark-app/client/src/` | 482 | 25 | 60 | 397 | Frontend | 大量 UI 组件 |
| `ewoh-spark-app/shared/` | 1 | 1 | 0 | 0 | Shared Contract | — |
| `ewoh-spark-app/test/` | 137 | 8 | 30 | 99 | Test | — |
| `db/` | 39 | 8 | 12 | 19 | DB Schema/Migration | — |
| `contracts/` | 37 | 10 | 20 | 7 | Shared Contract | — |
| `catalog/` | 14 | 3 | 8 | 3 | Config | — |
| `openapi/` | 3 | 3 | 0 | 0 | API Contract | — |
| `deploy/` | 32 | 10 | 12 | 10 | Deploy | — |
| `docs/` | 50 | 3 | 20 | 27 | Docs | 非运行事实 |
| `tools/` | 96 | 6 | 20 | 70 | Governance Tooling | — |
| `scripts/` | 48 | 8 | 15 | 25 | Tooling | — |
| `tests/` | 10 | 10 | 0 | 0 | Contract Test | — |
| `delivery/` | 64 | 2 | 12 | 50 | Frozen Delivery | 冻结交付物 |
| `release/` | 4164 | 0 | 10 | 4154 | Release Snapshot | 冻结快照 |
| `security/` | 4 | 2 | 2 | 0 | Policy | — |
| `ui/` | 21 | 2 | 10 | 9 | UX Prototype | 无生产引用 |
| `ewoh-feishu-app/` | 15 | 10 | 3 | 2 | Edge/Feishu App | — |

```text
Deep-read files: ≈ 246
Structurally scanned files: ≈ 374
Skipped files: ≈ 5486（release 快照 4154、client UI 组件、测试细节、node_modules/dist/缓存）
Skipped percentage: ≈ 88%（主要因 release/ 冻结快照与 node_modules/dist）
```

注：`release/` 为多版本冻结快照（rc1/rc2…），不计入活跃源码精读；`node_modules`、`dist`、`output`、`.codex`、`.trae`、`.playwright-cli` 等排除。

---

# 4. Repository Map

```text
EWOH/
├── run.py                       # Python 入口（真实模块 → fallback stub）
├── pyproject.toml               # ewoh 0.6.0 纯标准库
├── Makefile                     # run/test/lint/truth-check 等
├── version.json                 # 0.6.0-rc4
├── src/edge_platform/           # ★ Python Edge Runtime (40k LOC)
│   ├── run.py / config.py / server.py / services.py / stubs.py / selfcheck.py
│   ├── edge/ (bus.py, adapters/, bridge/, backfill, exo_semantic, modeling)
│   ├── inference/ (pipeline, rules, model, features, fatigue, events, spatial_rules)
│   ├── scheduler/ (scheduler_service, orchestrator, planner, cpsat/, optimizer, …)
│   ├── spatial/ world_model/ perception/ governance/ monitoring/ policy/ rbac/ audit/
│   ├── auth/ assistant/ backup/ collection/ connectors/ aas/ twin/ scenario/
│   └── tests/ (≈34 个测试文件)
├── ewoh-spark-app/              # ★ NestJS Backend + React Frontend
│   ├── server/ (main.ts, standalone-main.ts, app.module, modules/, database/, common/)
│   ├── client/src/ (React 18 + Vite + React Query)
│   └── shared/api.interface.ts  # ★ 前后端契约（2045 行）
├── ewoh-feishu-app/             # Feishu 集成 App（Express + SQLite + lark-cli）
├── db/                          # migrations + runner + seed + verify + contracts
├── contracts/                   # events/state-machines/policy/factory/mapping/workflow/work
├── openapi/                     # ewoh.yaml + route-manifest.json（无漂移）
├── catalog/                     # connectors/factory-sites/mappings/scenarios
├── deploy/                      # Dockerfile.* / compose / helm / k8s
├── tools/                       # work-indexer/gate-engine/work-console/semantic-rules/run_demo
├── scripts/                     # 审计/门禁/TCK 脚本
├── tests/                       # 仓库级契约测试（pytest）
├── docs/  delivery/  release/   # 文档 + 冻结交付物 + 发布快照
├── security/  ui/               # Rego 策略 + 静态 UX 原型
├── demo.db                      # 未跟踪演示数据库（110MB）
```

| Directory | Responsibility | Runtime | Active? | Authoritative? | Depends On | Used By |
| --------- | -------------- | ------- | ------- | -------------- | ---------- | ------- |
| `src/edge_platform` | 边缘采集/推理/调度/API | Python stdlib | 是 | 边缘侧唯一 | 无第三方 | run.py/Makefile |
| `ewoh-spark-app/server` | 云端业务后端 | NestJS | 是 | 云端业务 | shared, db | client |
| `ewoh-spark-app/client` | 指挥地图/各页面 | React | 是 | UI | shared, server | 浏览器 |
| `shared/api.interface.ts` | 前后端契约 | TS 类型 | 是 | API 契约 | — | server+client |
| `db` | Schema/migration/seed | SQL | 是 | Schema 事实源 | Postgres | server |
| `contracts` | 跨运行时契约 | YAML/JSON/Rego | 部分 | 参考/门禁 | — | CI/工具 |
| `openapi` | OpenAPI 契约 | YAML | 是 | API 文档 | server | CI/生成 |
| `catalog` | 工厂/连接器/映射配置 | YAML | 是 | 配置事实源 | — | 工具/部署 |
| `deploy` | 容器/K8s | Docker/K8s | 是 | 部署事实源 | db/server | 运维 |
| `tools` | 治理 CLI | Node | 是 | 治理 | contracts | CI/审计 |
| `tests` | 契约测试 | pytest | 是 | 契约 | contracts | CI |
| `delivery` | 交付文档/冻结 | md/sql | 否 | 冻结资产 | — | 不参与运行时 |
| `release` | 发布快照 | 全量复制 | 否 | 冻结快照 | — | 不参与运行时 |
| `ui/command_map` | UX 原型 | 静态 HTML | 否 | 参考 | — | 无生产引用 |
| `ewoh-feishu-app` | 飞书集成 | Express+SQLite | 是 | 飞书侧 | lark-cli | 群/多维表格 |

---

# 5. Runtime Architecture（运行时矩阵）

| Runtime | Language | Entry | Command | Port | Persistence | Primary Responsibility |
| ------- | -------- | ----- | ------- | ---- | ----------- | ---------------------- |
| Python Edge Runtime | Python 3.9+ | `run.py` → `edge_platform.run:main` | `python run.py` / `make run` | 8765 | SQLite (demo.db) | 采集/推理/边缘调度/API |
| Python Stub 模式 | Python | 同上 `--stub` | `make run-stub` | 8765 | SQLite | 演示/自测（当前默认真实运行路径） |
| NestJS Backend (standalone) | TS/NestJS | `server/standalone-main.ts` | `start:standalone` | 3000 | PostgreSQL | 业务后端/RLS/调度V2 |
| NestJS Backend (legacy) | TS/NestJS | `server/main.ts` bootstrapLegacy | `EWOH_LEGACY_ENABLED=1` | 3000 | PostgreSQL | 兼容（默认禁用） |
| React Frontend | React 18 | `client/src/index.tsx` | vite build | — | IndexedDB/离线 | 指挥地图/管理页 |
| CP-SAT Worker (Python) | Python+ortools | `scheduler/cpsat/solver.py` | `/api/scheduler/v2/solve` | 8000 | 无 | 调度求解（默认不可用） |
| Feishu App | Node/Express | `ewoh-feishu-app/server/index.js` | `npm start` | 3000 | SQLite | 飞书消息/多维表格/审批 |
| DB Migration Runner | Node | `db/runner/run_migrations.js` | compose migrate job | — | PostgreSQL | schema 迁移+verify |
| Governance CLI | Node | `tools/work-indexer` 等 | 脚本 | — | filesystem | 工程治理/门禁 |
| CI/Gate Runtime | GH Actions | `.github/workflows/*` | CI | — | — | 测试/安全/perf/打包 |

---

# 6. Configuration & Environment Variable Matrix

| Variable | Runtime | Used In | Required | Default | Sensitive | Production Impact |
| -------- | ------- | ------- | -------- | ------- | --------- | ----------------- |
| `EWOH_DB_PATH` | Python | config.py | 否 | demo.db | 否 | 数据库位置 |
| `EWOH_HOST/PORT` | Python | config.py | 否 | 127.0.0.1:8765 | 否 | 监听地址 |
| `EWOH_ADAPTER_PORTS` | Python | config.py | 否 | 9001:real,9002:controlled_test,9003:simulated | 否 | 适配层来源 |
| `EWOH_AUTH_BACKEND` | Python | config.py | 否 | offline | 否 | 身份后端（offline=无认证） |
| `EWOH_JWT_SECRET` | Python | config.py | 否 | 空 | 是 | 空=离线演示 |
| `EWOH_ARK_API_KEY` | Python | config.py | 否 | 空 | 是 | 视觉理解（未配置则报错） |
| `EWOH_DEPLOY_TARGET` | NestJS | main.ts | 否 | — | 否 | standalone/legacy 切换 |
| `EWOH_LEGACY_ENABLED` | NestJS | main.ts | 否 | — | 否 | legacy 入口开关 |
| `JWT_SECRET` | NestJS | auth | **是** | — | 是 | compose 强制必填 |
| `DATABASE_URL` | NestJS | standalone.provider | **是** | — | 是 | compose 强制必填 |
| `EWOH_API_DATABASE_PASSWORD` | NestJS | compose | **是** | — | 是 | compose 强制必填 |
| `INGEST_API_KEY` | NestJS | ingest.guard | 否 | 空 | 是 | **空=放行所有 ingest 请求（fail-open）** |
| `CORS_ORIGINS` | NestJS | standalone-main | 否 | 空→false | 否 | 空=禁用 CORS |
| `TRUST_PROXY` | NestJS | standalone-main | 否 | 1 | 否 | `true` 被禁止 |
| `RATE_LIMIT_WINDOW_SEC/MAX` | NestJS | rate-limit.guard | 否 | 60s/300 | 否 | 依赖 Redis |
| `REDIS_URL` | NestJS | redis.service | 否 | — | 是 | 无 Redis 时 rate limit 可能失效 |
| `EWOH_INGEST_ORG_ID` | NestJS | ingest.guard | 否 | — | 否 | ingest 默认租户 |
| `CPSAT_WORKER_URL` | NestJS | cp-sat-solver | 否 | 127.0.0.1:8000 | 否 | CP-SAT worker 地址 |
| `EWOH_WORK_ARTIFACTS_DIR` | NestJS | work-orchestration | 否 | .codex/artifacts | 否 | work-graph 数据源 |
| `PORT`/`HOST` | Feishu | index.js | 否 | 3000 | 否 | 飞书 app 端口 |

**Env 专项检查结论：**
- 未发现提交到 git 的 secret（`feishu-config.json` 被 `.gitignore:40-41` 忽略，仅 example 入库）；但工作区存在 `ewoh-feishu-app/feishu-config.json`（含真实 `base_token`，27 位，非 example 值）——未入库，风险受控但需注意备份/泄露。
- `INGEST_API_KEY` 未配置时 **fail-open**（允许所有请求）——P1。
- `EWOH_AUTH_BACKEND=offline` 时 Python 侧认证降级为 anonymous（无强制认证）——P2（离线场景可接受，需在部署文档标注）。
- `EWOH_DB_STATEMENT_TIMEOUT_MS` 默认 0（不设超时）。

---

# 7. Python Edge Runtime（详细走读）

## 7.1 启动链（实际验证）

```
run.py main()
→ Settings.load()
→ build_components(db, stub, ports, metrics)
    ├─ (非 stub) try:
    │    from edge.bus import Bus            ← ✗ ImportError（无 src/edge 包）
    │    from edge.manager import AdapterManager  ← ✗ 不存在
    │    from edge.storage import Storage    ← ✗ 不存在
    │    from inference.model/pipeline/rules ← ✗ ImportError
    │  except ImportError → fallback stub   ← ★ 永远走这里
    └─ stub: stubs.Storage/Bus/ModelRegistry/RuleEngine/InferencePipeline/AdapterManager/DemoSimulator
→ metrics.bind_storage()
→ SchedulingRepository(storage)（可导入）
→ EventBus()（scheduler/events.py）
→ build_scheduler(storage, repo, event_bus)  ← 真实调度闭环（非 stub）
→ services.register_scheduler_hook(scheduler)
→ server.Context(...)
→ server.build_server((host, port), ctx) → serve_forever()
```

**关键结论：**
1. 智能调度闭环（`scheduler_service.py` / `Planner` / `GreedyOptimizer` / `ReservationService` 等）是**真实实现且确实装配**，与 inference/edge 层是否 stub 无关。
2. 但 **edge 采集/推理/存储层 100% 运行 Stub**（simulated 数据），平台当前实际是"调度真实 + 数据模拟"的混合态。
3. `make run` 与 `python run.py` 行为一致（均回退 stub），README 对此有声明（"真实模块缺失时回退 stub"），但**声明中隐含"真实模块存在"的预期与源码事实不符**——`edge/manager.py`、`edge/storage.py` 从未存在过。

## 7.2 装配漂移明细（P0 核心证据）

`run.py:29-34` 期望的模块 vs 实际：

| 期望 import | 实际包路径 | 是否存在 | 后果 |
| ----------- | ---------- | -------- | ---- |
| `edge.bus.Bus` | `edge_platform.edge.bus.MessageBus` | 存在但类名不同 | ImportError→stub |
| `edge.manager.AdapterManager` | — | **不存在** | ImportError→stub |
| `edge.storage.Storage` | — | **不存在** | ImportError→stub |
| `inference.model.ModelRegistry` | `edge_platform.inference.model.ModelRegistry` | 存在 | ImportError→stub |
| `inference.pipeline.InferencePipeline` | `edge_platform.inference.pipeline.InferencePipeline` | 存在 | ImportError→stub |
| `inference.rules.RuleEngine` | `edge_platform.inference.rules.RuleEngine` | 存在 | ImportError→stub |

注意：即使修正为 `edge_platform.edge.bus`，类名仍是 `MessageBus` 而非 `Bus`，且 `manager`/`storage` 模块缺失。**真实装配分支从代码提交至今从未成功执行过。**

## 7.3 测试为何全绿（P0 机制分析）

`tests/test_inference.py:16` `sys.path.insert(0, os.path.abspath(.../..))` = `src/edge_platform`，使：
- `from inference import ...` → `src/edge_platform/inference` ✓
- `from edge_platform.edge.bus import MessageBus` → 需 `src` 在 path；`unittest discover -s src/edge_platform/tests` 会把 start dir 及其父目录插入 sys.path，最终 `src` 也在 path ✓

因此测试环境两个 namespace 都可见；生产 `run.py` 仅 `src` 可见 → `inference`/`edge` 顶层包不可见。**这是"测试通过但生产装配失败"的直接机制。**

---

# 8. Edge Message / Inference / World Model

## 8.1 Bus Compatibility Matrix

| Caller | Method Expected | Actual Bus Method | Compatible? | Runtime Consequence |
| ------ | --------------- | ----------------- | ----------- | ------------------- |
| `stubs.InferencePipeline.start()`（实际运行） | `bus.subscribe(topic)→queue` | `stubs.Bus.subscribe` ✓ | 是 | 正常（queue 语义） |
| 真实 `InferencePipeline.start()`（pipeline.py:425） | `bus.subscribe(topic)→queue` | `MessageBus.subscribe(stream,handler)→sub_id` | **否** | 若接入真实 bus 会崩溃 |
| `run.py` 装配 | `from edge.bus import Bus` | 不存在 | 否 | fallback stub |
| Scheduler `EventBus`（scheduler/events.py） | `publish(event_type, entity_id, version, payload)` | 独立实现 | 独立 | SSE 通道（自洽） |
| server.py `ctx.kafka` | 命名兼容 | 复用 event_bus | 兼容 | 命名漂移（kafka≠EventBus） |

**Topic/Stream 检查：**
- 真实 `MessageBus.STREAMS = (telemetry, state, events, assets)`（bus.py:25）。
- 生产代码 publish 的 topic 为 `"inference"`（pipeline.py:387）——**不在 STREAMS 白名单中**，若切换到真实 MessageBus 将抛 `ValueError: 未知流`。
- Scheduler 发布 `schedule.proposed/confirmed/conflict`、`assignment.updated`、`task.created/updated` 到 `EventBus`（独立实现），与 `MessageBus` 完全无关。
- **结论：三套消息机制并存（stubs.Bus / edge_platform.edge.bus.MessageBus / scheduler.events.EventBus），topic 命名各自为政，无统一契约。**

## 8.2 Inference

- `InferencePipeline.handle_telemetry`（pipeline.py:286）：窗口 2s（WINDOW_SIZE=40 帧@20Hz），步长 1s；规则引擎始终运行 → draft 交 EventEngine；模型缺失/异常 → rule fallback（`_rule_label`），label `stand/walk/bend/lift/carry/unknown`。
- Unknown 六路触发：data_quality / low_confidence(<0.6) / ambiguous / firmware_unverified / out_of_distribution / sensor_channel_missing。
- 规则异常 `except Exception: drafts=[]`（静默）；推理异常重抛但 `_metrics` 记录 error。
- **Consent 检查为 fail-open**（`_check_consent`）：无 consent_manager 放行；无 person_id 放行；`is_allowed` 异常放行。这是**有意设计**（避免授权故障停摆），但需与隐私要求对齐评估——P2。
- `_TRAINING_BOUNDS` / `_LOW_CONF_THRESHOLD` 等阈值硬编码于源码，未进 versioned policy——P2（应迁入 policy contract）。

## 8.3 Spatial / World Model（Python 侧）

- `spatial/`：AssetRegistry（资产注册）、Coordinate、Topology、MultiFactory（495 行）、Entities。
- `world_model/`：StateStore、EventGraph、Replay、Prediction。
- 状态存储：SQLite 表（stubs.SCHEMA）含 `world_state_snapshot`；world state 由 `WorldStateService.build_snapshot(storage)` 从 person/device/task/station/assignment/reservation/events 聚合。
- **Edge/Cloud authoritative 判定**：Python 侧 world snapshot 存 SQLite；NestJS 侧独立 `ewoh_world_state_snapshot` 表。两边 world state 不共享存储——**双事实源**（P1）。当前无桥接（`edge/bridge/edge_to_spark.py` 存在但为真机接入脚本，见 16 章）。

---

# 9. Python Scheduler

## 9.1 结构

- **真实生产接入**：`scheduler_service.py` `SchedulerService`（request→shadow plan→confirm（re-validate world state+reserve）→execute→feedback→replan），状态机 `models.py`（PLAN_TRANSITIONS/TASK_TRANSITIONS 与 contracts/state-machines/plan.yaml, task.yaml 一致）。
- **旧实现（legacy）**：`orchestrator.py` `Scheduler`（单任务 orchestrator，`SHADOW/PROPOSED/CONFIRMED/REJECTED/EXECUTED`），被 `scheduler/__init__.py` 与 `learning_loop.py` 引用，`tests/test_scheduler.py` 使用。
- **辅助**：planner（Top-K GreedyOptimizer 影子方案）、candidate、constraints（HardConstraints：SKILL/STATION_AUTH/HEALTH_TABOO/FORBIDDEN_ZONE/SHIFT_REST/EXO_MODEL_COMPAT/DEVICE_FAULT/SAFETY）、scoring（30/20/20/15/15 权重可审计）、priority、explanation、replanner、reservation、repository（SQLite 持久化）、cpsat（ortools 可选）、appeal（申诉）、learning_loop（仅校准建议）。

## 9.2 定位判定

**Python Scheduler = Production（真实且接入，但输入数据来自 stub simulator）**。代码证据：`run.py build_scheduler()` 装配真实 `SchedulerService`；`services.confirm_assignment` 通过 hook 走 Scheduler。其"数据源"为 stub（simulated），属 **Edge Offline 调度能力**，与 NestJS Scheduler V2 为两套独立实现（功能重叠，P1）。

---

# 10. NestJS Backend

## 10.1 入口

- `main.ts`：`resolveBootstrapMode()` —— `EWOH_DEPLOY_TARGET=standalone` 或 `STANDALONE=1` → standalone；`EWOH_LEGACY_ENABLED=1` → legacy；否则 **抛错**（legacy 默认禁用）。
- `standalone-main.ts`：CORS 白名单（`*` 禁止）、安全头、trust proxy、BODY_LIMIT(1mb)、SPA fallback。
- `standalone-app.module.ts`：完整业务模块 + 全局 Guard/Interceptor/Pipe/Filter。

## 10.2 Request Pipeline（真实实现）

```
HTTP → AccessTokenGuard(JWT校验→userContext+org scope)
     → RolesGuard(默认deny：未声明@Roles即403)
     → RateLimitGuard(Redis，/health/ 豁免)
     → OrgContextInterceptor(set_config GUC, transaction-local)
     → RequestDatabaseContext.runInTransaction(set GUC + 请求事务)
     → ValidationPipe → Controller → Service → Drizzle/Postgres（RLS 兜底）
     → AuditService → MetricsInterceptor → TracingInterceptor → Response
```

各组件均已核实存在且注册顺序正确：
- `AccessTokenGuard`（shared/access-token.guard.ts）：Bearer 解析、org scope 解析（失败降级 primary org——**fail-open 到单 org**，需评审）。
- `RolesGuard`（roles.guard.ts）：**默认 deny**（未声明角色则拒绝），`FALLBACK_CONTROLLER_ROLES` 按 controller 名映射。
- `RateLimitGuard`：Redis 计数，默认 300/min/user-ip。
- `OrgContextInterceptor`：仅当 `request.userContext` 存在时 set GUC；**无 userContext 则直接放行**（`if (!request.userContext) return next.handle()`）——配合公共端点合理，但需确认非 Public 端点必被 AccessTokenGuard 注入 userContext。
- `RequestDatabaseContext`：`set_config(name, value, true)`（transaction-local）→ 与业务查询**同事务**；Proxy 保证 store 内连接一致；内层嵌套事务复用同一事务（无 savepoint）。

## 10.3 组织隔离与 RLS 安全评级

- GUC：`app.user_id` / `app.current_org_id` / `app.current_org_ids` / `app.is_global_admin`，事务内 set（interceptor 包装）。
- RLS：`ewoh_org_visible(org_id)` 函数（`standalone_001_schema.sql`）：global_admin=true 或 org_id ∈ current_org_ids → 可见；表级 `ewoh_org_select`（authenticated）+ `ewoh_service_all`（service_role）策略；部分表（world_snapshot/world_delta_log/system_config）带 `org_id IS NULL + is_global_admin` 例外。
- **关键机制确认**：GUC 与业务查询同事务（interceptor → runInTransaction → 同 store），无 pooled 连接污染（Proxy 限定）。缺 org context 时：非 public 端点会被 AccessTokenGuard 拦截（无 token→401），不会静默跳过 GUC。
- **风险点**：`AccessTokenGuard` 中 org scope 解析失败 → `accessibleOrgIds=[payload.orgId]`（fail-open 到自身 org，非全放开）；`RolesGuard` 默认 deny 是安全侧的正确选择。
- **安全评级：良好（B+）**。较 legacy `001_ewoh_managed_tables.rollback.sql` 中的 `legacy_modify_all ... USING(true)`（旧版全开策略，在 rollback 文件中，非正向）有明显改进；正向 standalone 迁移使用 org 可见性策略。需确认 service_role 的应用侧是否都被 GUC 约束。

---

# 11. Security / RLS / Organization Context（见 10.3，评级 B+）

# 12. Backend Domain Modules（Module Matrix）

| Domain | Controller | Service | DB Tables | Upstream | Downstream |
| ------ | ---------- | ------- | --------- | -------- | ---------- |
| auth | auth.controller | auth.service | ewoh_users | — | 全部 |
| organization | organization.* | organization.service | ewoh_organization | — | org-scope |
| spatial | spatial.* | spatial.service | ewoh_spatial_entity | ingest | world/map |
| world | world.controller | world.service | ewoh_world_state/event/event_chain | ingest | timeline/replay |
| timeline | timeline.* | timeline.service | (world 表) | world | UI |
| world-cursor | world-cursor.controller | WorldCursorService | ewoh_world_snapshot/delta_log | world | 增量同步 |
| ingest | ingest.controller | IngestService | ewoh_device/telemetry/environment/event | edge bridge | rule-engine/world |
| rule-engine | rule-engine.* | RuleEngineService | ewoh_event | ingest | event |
| events | event-catalog.* | — | ewoh_event_catalog | contracts | — |
| task | task.controller | TaskService | ewoh_production_task | approval | scheduler |
| resource | resource.* | resource.service | ewoh_resource_* | — | scheduler |
| approval | approval.* | approval.service | ewoh_approval* | scheduler | control |
| control | control.* | control.service | ewoh_control_* | approval | 设备指令 |
| scheduler | scheduler.controller | SchedulerService(V1+V2) | ewoh_schedule_plan/run/assignment/constraint/reservation/audit | world-state | dispatch |
| alert | alert.* | alert.service | ewoh_alert* | event | 通知 |
| audit | audit.controller | AuditService | ewoh_audit_log | 全部 | — |
| mes | mes.* | — | — | — | — |
| erp | erp.* | — | — | — | — |
| oee | oee.* | — | — | — | — |
| ai | ai.* | ai.service | ewoh_ai_suggestion | event | brain panel |
| metrics | metrics.* | metrics.service | — | 请求 | prometheus |
| observability | observability.* | SlowQueryService | — | db | 日志 |
| work-orchestration | work-orchestration.controller | WorkOrchestrationService | ewoh_handoffs/git_sync/evidence_metadata | tools | UI |
| gamification | gamification.controller | gamification.service | — | — | legacy（deprecated 标注） |
| simulator | simulator.* | — | — | — | demo |
| policy | policy.* | policy.service | — | — | 门禁 |

---

# 13. Ingest Data Flow（现场数据采集链）

## 13.1 链路

```
Device(EXO) → edge_to_spark.py(bridge, 真机) → POST /api/ingest/exoskeleton[/batch]
→ IngestGuard(X-Ingest-Key + rate limit + org) → IngestService.processOneFrame
→ entityExists → isDuplicateRawRef(raw_ref) → assessQuality(clock drift/battery/packet loss)
→ upsert ewoh_device → insert ewoh_telemetry → RuleEngineService.evaluate → ewoh_event
```

## 13.2 逐条核查

| 关注点 | 结论 | 位置 |
| ------ | ---- | ---- |
| idempotency | raw_ref=SHA256(device_id\|event_time\|record_id\|battery\|load)，查重跳过 | ingest.service.ts:113-122, 575-582 |
| device existence | entity_id 不存在→写 ENTITY_NOT_FOUND 事件+400 | :88-109 |
| clock drift | event_time 超前 +5min → invalid | :47,454 |
| packet loss | >5% → degraded | :49,464 |
| battery | 越界 0-100 → invalid | :459 |
| batch | `for frame: await processOneFrame()` 逐条串行 | :66-75 |
| 事务 | 单帧多步非原子（insert 失败返回 error，但 device 已 upsert） | :182-209 |
| N+1 | 每帧 ≥3 次 DB 往返（entityExists+dup+insert/upsert） | :88-187 |
| entityExists 失败 | catch→false（**fail-open**：DB 异常时视为不存在） | :479 |
| isDuplicateRawRef 失败 | catch→false（**fail-open**：DB 异常时重复放行） | :493 |
| rule-engine 异常 | catch→error 响应，不阻断 ingest | :199-209 |

**结论：P1。批量=逐条串行 + 多次 round-trip + 无整体事务 + 两处 fail-open 幂等/存在性检查。** 建议 batch 用单事务 + 批量 upsert + 单条 INSERT ... ON CONFLICT 幂等键 + UNIQUE(raw_ref) 约束兜底。

---

# 14. World State Architecture

## 14.1 回答设计问题

1. **Current World State 是否 materialized current table？** 否。`getCurrentState` 从 `ewoh_spatial_entity`（静态）+ `ewoh_world_state`（历史追加）读取，全表加载后在 Node 用 `Map` 去重取最新（world.service.ts:64-77）。
2. **是否历史批量加载到 Node？** 是，`ewohWorldState` 全部行 `orderBy ts desc` 拉入内存。
3. **是否可用 DISTINCT ON？** 可以且应该：`SELECT DISTINCT ON (entity_id) * FROM ewoh_world_state WHERE entity_id = ANY(...) ORDER BY entity_id, ts DESC`。
4. **World State 是否有 version？** 无 materialized current 版本；调度侧用 `WorldStateSnapshotService` 生成 `WS-YYYYMMDD-NNNN` 快照 + 内容哈希 `entityVersions`（world-state.service.ts:397-457）——调度世界状态**有版本**，但 world 模块的 Current World State 无版本。
5. **Replay 实现**：`getReplay` 按时间窗查 world_state/event/task/step/binding，按分钟聚合生成快照（world.service.ts:185-359）。
6. **Replay 数据是否进入生产事实源？** `createReplayItem` 会**插入 `ewoh_event`（sourceType='replayed'）+ `ewoh_event_chain`**——回放派生的 Issue/Task/Evidence 会写入生产事件表（world.service.ts:435-459）。这是**设计特性**（审计派生链），但需确保 `sourceType='replayed'` 不被误当真实遥测事件。
7. **Event→Issue/Task/Evidence**：`createReplayItem` 以 `REPLAY_ISSUE/REPLAY_TASK/REPLAY_EVIDENCE` eventCode 落库 + causal chain 记录。

**性能判断：** `getCurrentState` O(全表) 随 ewoh_world_state 增长线性劣化，**P1 瓶颈**；`getReplay` 查 5 张表 × 分钟聚合，限流 safeLimit≤1000，O(窗口内全量)。

---

# 15. Scheduler V2

## 15.1 完整调度链（NestJS）

```
POST /api/scheduler/runs
→ TriggerService.evaluate(trigger, entityId)  (去抖/冷却)
→ WorldStateSnapshotService.buildSnapshot(ctx)
   → collectState() 9 表并行查询 → entityVersions 内容哈希 → snapshotVersion=WS-YYYYMMDD-NNNN
→ SolverService.solveVariants(snapshot, constraints, opts)
   → 策略画像 A/B/C（policy × 缩放系数）
   → CpSatSchedulingSolver.solve
        → buildRequest → POST http://127.0.0.1:8000/api/scheduler/v2/solve
        → OPTIMAL/FEASIBLE? → buildCpsatPlan（复用 heuristic 外壳）
        → 否则 → HeuristicSchedulingSolver.solve（fallback，solverStatus=UNAVAILABLE/FALLBACK）
→ PlanService.persistPlan（plan + assignments）
→ SchedulerService.createRun 更新 run 状态 succeeded
→ SSE: SchedulerStreamService 广播 scheduling.event（sequence 递增）
→ 前端 useSchedulerStream: SSE→React Query 缓存；缺口→resync；失败→polling
→ 审批: POST /plans/:planId/approve → PlanService.approvePlan（version+snapshot freshness 校验）
→ 下发: POST /plans/:planId/dispatch → DispatchCoordinatorService.dispatch（事务: 预检→CAS→reserve→task更新→assignment更新→audit→outbox）
```

## 15.2 关键发现

- `WorldStateSnapshotService.isSnapshotFresh` 用 entityVersions 内容哈希 + reservations 精确比较——**新鲜度校验设计良好**（P0 级防 stale plan dispatch）。
- `approvePlan` 校验 `plan.version` + `assertFreshForApprove(snapshotVersion)` → **PLAN_STALE 会被拒绝**（P1 项"是否阻止 stale plan dispatch"= **PRESENT, 已实现**）。
- `dispatchPlan` 的 CAS 更新（status approved→dispatched，where status=approved）防 double-dispatch。
- **占位值（P0）**：`cp-sat-scheduling-solver.ts:413-435` `decisionTrace` 的 `priority:{score:0,factors:[]}`、`candidates:[]`；`SolverService` 无 priority 计算调用 CP-SAT 真实 score。
- **scheduler.service.ts V1**（`generatePlans`/`getDataDrivenPlans`）是模板化方案生成（3 个固定策略 KEEP/CAP/BAL，指标公式化），仍暴露于 `/api/scheduler/plans` 与 `/api/scheduler/plans/data-driven`，被标注 deprecated 但**无响应告警**（legacyCompatibility 只用于 POST/GET plans 与 confirm）。

---

# 16. Scheduler Constraint & Solver Matrix

## 16.1 Constraint Matrix

| Constraint | Hard/Soft | Producer | Evaluator | CP-SAT | Heuristic | UI | Tested |
| ---------- | --------- | -------- | --------- | ------ | --------- | -- | ------ |
| REQUIRED_SKILL | Hard | eligibility | eligibility.check | ✓(skills) | ✓ | ✓ | ✓ |
| REQUIRED_CERTIFICATION | Hard | eligibility | eligibility.check | ✓(cert) | ✓ | ✓ | ✓ |
| PERSON_AVAILABLE | Hard | snapshot | eligibility(booked) | ✓(status) | ✓ | ✓ | ✓ |
| DEVICE_AVAILABLE | Hard | snapshot | devicesForTask | ✓(online) | ✓ | ✓ | ✓ |
| RESOURCE_TIME_WINDOW | Hard | snapshot | eligibility | ✓(reservation) | ✓ | ✓ | ✓ |
| NO_DOUBLE_BOOKING | Hard | snapshot | booked slots | ✓(no-overlap) | ✓ | ✓ | ✓ |
| PREDECESSOR | Hard | snapshot | cycle detect | ✓(Add start>=end) | ✓ | ✓ | ✓ |
| FORBIDDEN_ZONE | Hard | snapshot | forbiddenZones | ✓(候选层) | ✓ | ✓ | ✓ |
| MIN_BATTERY | Hard | override/policy | devicesForTask | 透传(未建模) | ✓ | ✓ | ✓ |
| MAX_WORKLOAD | Hard | override/policy | eligibility(load) | 透传(未建模) | ✓ | ✓ | ✓ |
| SAFETY_BLOCK | Hard | snapshot(safety events) | eligibility | 部分(未显式建模) | ✓(safetyBlockedPersonIds) | ✓ | ✓ |
| LOCKED_PERSON | Hard | override | frozenAssignments | ✓ | ✓ | ✓ | ✓ |
| LOCKED_DEVICE | Hard | override | frozen | ✓ | ✓ | ✓ | ✓ |
| LOCKED_STATION | Hard | override | frozen | ✓ | ✓ | ✓ | ✓ |
| LOCKED_TIME | Hard | override | lockedWindow | ✓ | ✓ | ✓ | ✓ |
| LOCKED_ASSIGNMENT | Hard | override | frozen | ✓ | ✓ | ✓ | ✓ |
| EXCLUDED_RESOURCE | Soft | override | excluded sets | 透传(未建模) | ✓ | ✓ | ✓ |
| PREFERRED_RESOURCE | Soft | override | preferred bonus | 透传(未建模) | ✓ | ✓ | ✓ |
| MANUAL_BOOST | Soft | override | priorityEngine | 透传 | ✓(manualBoostTasks) | ✓ | ✓ |

**差距（P1/P2）：**
- **CP-SAT 不支持的约束**：MIN_BATTERY、MAX_WORKLOAD、SAFETY_BLOCK、EXCLUDED/PREFERRED_RESOURCE、MANUAL_BOOST 均仅透传（`constraints` 字段带 `supported` 标记），CP-SAT 模型内未建模——CP-SAT 若真正运行会忽略这些约束。heuristic 全部支持。
- `constraints.ts` 声明 SUPPORTED_HARD_CONSTRAINTS 全 16 个 + SOFT 9 个，但 CP-SAT 实际实现子集。API 层 `checkConstraintSupported` 报 unsupported 的是**超出这 25 个之外的**约束，而非 CP-SAT 未实现的。
- **测试**：heuristic 路径有 hard-constraints/overrides/priority 等 spec；CP-SAT 路径主要测 fallback 语义（cp-sat-fallback.spec）。

## 16.2 Solver Capability Matrix

| 能力 | CP-SAT (Python worker) | Heuristic (TS) |
| ---- | ---------------------- | -------------- |
| 最优性 | OPTIMAL（默认不可用） | 贪心近似 |
| 无重叠约束 | AddNoOverlap ✓ | booked-slots 检查 ✓ |
| 前置任务 | Add(start≥end) ✓ | done-set + cycle-detect ✓ |
| 时间窗 | Add(end≤due) ✓ | deadline/wait 计算 ✓ |
| 锁定/冻结 | frozen interval ✓ | locked maps + 排除 ✓ |
| 软目标权重 | lateness/travel/wait/churn ✓ | 7 项 ScoreBreakdown ✓ |
| 风险系数 | 未建模 | riskFactor ✓ |
| 电量/负荷 | 未建模 | battery/load ✓ |
| 决策追踪 | **占位（score=0,factors=[],candidates=[]）** | 完整（priority.factors + candidates + rejectedAlternatives）✓ |
| 确定性 | random_seed=0, workers=1 ✓ | 排序确定性 ✓ |
| 依赖 | ortools（未安装） | 无 |
| 默认可用性 | **UNAVAILABLE（生产不可用）** | **实际运行路径** |

---

# 17. Reservation / Dispatch / Replan

## 17.1 执行闭环

```
Plan Approved → DispatchCoordinator.dispatch
→ plan.status==approved 校验 → assertFreshForApprove(snapshot)
→ 事务内: assignments(status=approved) 预检任务可下发
→ CAS: UPDATE plan SET status=dispatched WHERE status=approved (double-dispatch 守卫)
→ ResourceReservationService.reserve: 事务内 check-then-insert（重叠→RESOURCE_CONFLICT 回滚）
→ 更新 task(assignee/device/version) + taskService.transitionTaskState(dispatch)
→ assignment→dispatched → ewoh_assignment_event → audit → outbox(assignment.dispatched/plan.dispatched)
```

## 17.2 核查

- **stale plan dispatch**：已阻止（CAS + snapshot freshness）。**VERIFIED_BY_CODE**
- **duplicate dispatch**：CAS `where status='approved'`，并发第二人抛 PLAN_CONCURRENT_DISPATCH。✓
- **overlapping reservation**：事务内 `lt(start,end) and gt(end,start)` 查重 + insert。✓（RLS + org 作用域）
- **reservation duration 一致性**：reserve 用 assignment 的 plannedStart/End；**缺 plannedEnd 时 `startMs+3600_000`（1h）硬编码**（dispatch-coordinator.ts:129），而 solver 默认 30min——**不一致（P1）**。`MIN_BATTERY` 等未在 reserve 校验。
- **fallback duration 硬编码**：存在两处（1h dispatch、30min solver/cp-sat）。P1。

## 17.3 Replan / Trigger / Impact

| Trigger | Affected Tasks | Frozen Tasks | Automatic? | Cooldown | UI Event |
| ------- | -------------- | ------------ | ---------- | -------- | -------- |
| MANUAL (createRun) | 全部可调度 | executing/locked (frozenAssignments) | 否（用户触发） | triggerService 冷却 | ✓ |
| 人工 override (applyOverrides) | replan 全部可调度 | executing/started/locked | 否 | — | ✓ PlanOverrideResponse |

- `TriggerService.evaluate`：MANUAL / 事件触发；带冷却与去抖（debounced=true 返回空方案）。
- `ImpactAnalyzer`：分析受影响任务。
- `ReplanCoordinatorService`：编排 replan（`planService.replan`：新 snapshot + 继承/目标 policy + 落库 constraints + superseded 标记）。
- **executing 任务冻结**：`buildFrozenAssignments` 将 `status==='executing'||'started'` 或 LOCKED_* 约束的任务冻结为不可移动 interval——✓。
- **dispatch 任务**：dispatch 后 status='dispatched'，不在 executing/started 冻结集——**已 dispatch 未执行的任务可能被 replan 重排**（若其 status 不是 executing）。需确认是否业务预期——P2。

---

# 18. React Frontend

## 18.1 启动链

```
index.tsx → MainApp → BrowserRouter → AppContainer → ErrorBoundary
→ RoutesComponent(app.tsx) → RequireAuth/RequireRole → Page
→ useQuery/useMutation(React Query) → api/* (fetch) → Backend
+ SW注册(安全更新) + WebVitals + sessionSecurity(跨tab登出) + offlineDb + 高对比
```

## 18.2 分析

- `index.tsx` **职责偏宽但可接受**：集中了 SW、observability、session security、对比度、metrics flush 等引导逻辑（约 170 行），未拆分模块但每项职责独立到 `lib/*`。**P2**（可拆分 bootstrap 插件式）。
- Lazy loading：CommandMap 各面板 React.lazy ✓；无路由级 code split（除 CommandMap 面板）——P2。
- 数据流：CommandMap 世界状态 2s polling、overview 5s、replay 30s、route-graph 30s、SSE 调度流。
- **双状态源**：世界状态 polling + 调度 SSE，由 useSchedulerStream 统一写入 React Query（设计收敛）。✓
- `useSchedulerStream`：sequence 去重、缺口检测→resync、SSE 失败→polling 兜底、恢复重连——**实现质量高**。
- auth：`clearTokens` + 跨 tab 登出广播；sessionSecurity 空闲计时。

---

# 19. CommandMap

## 19.1 API Dependency Matrix（生产 CommandMap）

| Component | Endpoint | V2/Legacy/Gamification | Read/Write | Should Remain? |
| --------- | -------- | ---------------------- | ---------- | -------------- |
| CommandMap 实体 | GET /api/spatial/entities | V2 | R | 是 |
| CommandMap 世界状态 | GET /api/world/state | V2 | R | 是 |
| CommandMap KPI | GET /api/dashboard/overview | V2 | R | 是 |
| CommandMap 回放 | GET /api/world/replay | V2 | R | 是 |
| CommandMap 环境 | GET /api/dashboard/environment | V2 | R | 是 |
| CommandMap 设备搜索 | GET /api/devices | V2 | R | 是 |
| SchedulePanel 方案 | GET /api/scheduler/plans (active) | V2(listRuns) | R | 是（经 schedulerActivePlans） |
| SchedulePanel 生成 | POST /api/scheduler/runs | V2 | W | 是 |
| SchedulePanel 审批/驳回 | POST /api/scheduler/plans/:id/approve | V2 | W | 是 |
| SchedulePanel 下发 | POST /api/scheduler/plans/:id/dispatch | V2 | W | 是 |
| SchedulePanel 重排 | POST /api/scheduler/plans/:id/replan | V2 | W | 是 |
| SchedulePanel SSE | GET /api/scheduler/v2/stream | V2 | R | 是 |
| useSchedulerConflicts | GET /api/scheduler/conflicts | V2 | R | 是 |
| usePlanOverrides | POST /api/scheduler/plans/:id/overrides | V2 | W | 是 |
| ResourcePoolPanel AI评估 | POST /api/gamification/resources/allocate | **Gamification(deprecated)** | W | **否→迁移** |
| ResourcePoolPanel 重排 | POST /api/scheduler/plans/:id/replan | V2 | W | 是 |
| WorkbenchPanel | GET /api/work-orchestration/* | V2 | R | 是 |
| TaskOrchestrationPanel | GET /api/scheduler/plans | V2 | R | 是 |
| EntityDetail | GET /api/events, /api/organizations, /api/personnel | V2 | R | 是 |
| BrainPanel | GET /api/ai/suggestions | V2 | R | 是 |

**结论：CommandMap 主链路已全 V2**；仅 ResourcePoolPanel 保留 `gamification/resources/allocate`（源码标注 @deprecated "仅用于 AI 评估展示，不再是调度写入路径"）。**VERIFIED_BY_CODE**（P2：应移除或替换为 V2 评估端点）。

---

# 20. Feishu App

## 20.1 功能

- Express + better-sqlite3（db.js）+ lark-cli 子进程（feishu.js，spawnSync）。
- 启动链：initDatabase → loadConfig → 首次同步设备到多维表格 → 事件状态轮询(60s) → 全量同步定时器(30s) → `app.use(cors())` → `express.json()` → static → /api 路由 → `/webhook/card` → startSimulator（每帧→evaluateRules→syncTelemetry 缓冲）。

## 20.2 安全检查（P0/P1）

| 项 | 状态 | 位置 |
| -- | ---- | ---- |
| webhook 验签 | **无**（无 timestamp/nonce/encrypt/signature 校验） | index.js:87-155 |
| acknowledge/resolve/escalate 未验证可调用 | **是**（直接读 body.open_id/action） | index.js:112-128 |
| CORS | **全开** `app.use(cors())` | index.js:55 |
| body limit | **无**（express.json() 默认 100kb 实际为默认上限，但未显式配置；webhook 无 limit） | index.js:56 |
| auth | /api 无认证（REST 端点开放） | api.js |
| rate limit | 无 | — |
| simulator | **默认启动**（无环境开关） | index.js:70 |
| 审计 | 事件处置写 audit 表 | events.js:120 |
| 敏感配置 | feishu-config.json 未入库（.gitignore），含真实 base_token | — |

**结论：Feishu App 存在 P0 级安全缺口（webhook 无验签 + 处置动作可被伪造）。** 飞书卡片回调标准做法：校验 URL 参数 `timestamp`+`nonce`+`signature`（Encrypt Key / VerifToken）或使用 `lark-cli` 卡片回调验签；当前实现完全信任任意 POST。

---

# 21. Database Architecture

## 21.1 Source-of-Truth Matrix（DB）

| 事实源 | 文件 | 是否权威 | 参与运行时 |
| ------ | ---- | -------- | ---------- |
| Migration（standalone） | `db/migrations/standalone_*.sql` | **是（正向）** | compose migrate job |
| Migration（legacy/Supabase） | `db/migrations/001/002_*.sql` | legacy 侧 | 旧部署 |
| Drizzle schema | `server/database/schema.ts`（auto-generated） | **从 DB 生成**（gen:db-schema） | 是（drizzle-orm） |
| schema-manifest | `db/contracts/schema-manifest.yaml` | 治理基线 | 门禁 |
| delivery database.sql | `delivery/02_技术规范/database.sql` | **冻结资产** | **否** |
| release db 快照 | `release/ewoh-0.6.0-rc*/db/*` | **冻结快照** | **否** |

- **Schema 事实源 = `db/migrations/standalone_*.sql`（正向迁移）+ 由它生成的 `schema.ts`**，方向正确（Drizzle 从 DB 反向生成，避免手写漂移）。**VERIFIED_BY_CONFIG**
- migration runner：`db/runner/run_migrations.js`（--apply-standalone / --verify-standalone / --seed 等），compose migrate job 顺序执行。✓
- seed：`db/seed/standalone_001_seed.sql`（基础）+ `standalone_006_scheduling_seed.sql` + `standalone_002_admin.sql`。
- verify：`db/verify/standalone_*.sql` 每迁移配套。
- **漂移风险**：delivery database.sql（SQLite 基线）与 release 快照与当前 schema 必然不同步；README 已明确 delivery 为交付基线。若部署错误引用 delivery SQL 会建错库——**P2 风险，建议部署文档显式禁止**。

## 21.2 RLS 结论

见 10.3：正向 standalone 迁移为 org 可见性 RLS；legacy 迁移（rollback 文件）含 `legacy_modify_all USING(true)` 旧策略（非正向）。`ewoh_world_snapshot`/`ewoh_world_delta_log`/`ewoh_system_config` 带 global_admin 例外。**评级 B+。**

---

# 22. Contracts / OpenAPI / Catalog

## 22.1 Contracts

| Contract | Consumer | Runtime Validation | CI Validation | Authoritative |
| -------- | -------- | ------------------ | ------------- | ------------- |
| events/event-catalog.yaml | scripts/audit-event-catalog.js | 否 | `contract:events` | 参考门禁 |
| state-machines/{plan,task,alert,...}.yaml | Python models（对照） | 否（注释对照） | — | 参考 |
| policy/deploy-gate.rego | scripts/rego-tck.py | 否 | `rego-tck` | 部署门禁 |
| factory/golden-factory.yaml | scripts/audit-golden-factory.js | 否 | `contract:golden` | 参考 |
| mapping/mapping-schema.json | scripts/audit-mapping-contracts.js | 否 | `contract:mapping` | 参考 |
| workflow/workflow-schema.json | scripts/audit-workflow-contracts.js | 否 | `contract:workflow` | 参考 |
| artifact-schemas/*.json | tools/*（indexer/gate） | 是（JSON Schema） | ✓ | 工作流事实源 |
| work/work-graph.schema.json | tools/work-indexer | 是 | ✓ | work-graph 事实源 |

**只存在于文件、无实际消费的 contract**：`catalog/scenario-pack.schema.json`（场景包）、`repository-facts`（被 audit-repo-facts 使用 ✓）。Python 与 TS 均未在运行时验证 contracts 事件/状态机（Python 仅注释对照，无 JSON Schema 校验）——**P2：建议 contract 消费侧增加 schema 校验**。

## 22.2 OpenAPI

- `openapi/ewoh.yaml` 13623 行，`route-manifest.json`（613 行）显示 controllerOperations=specOperations=300，undocumented=0, unimplemented=0——**无漂移**，由 `scripts/gen-openapi.js` 生成 + `gen:openapi:check` CI 门禁。**VERIFIED_BY_CONFIG**
- **建议**：ewoh.yaml 单文件过大，宜拆分 `openapi/domains/*.yaml` 后 bundle 为单一发布文件（保持现有 CI 校验）。P3。

## 22.3 Catalog

- `catalog/`（connectors/factory-sites/mappings/scenarios）为 YAML 配置，被 `tools/*`（factory replication / golden audit）与部署消费；`contracts/catalog/` 为 schema。**factory-specific 代码未进入业务源码**（数据驱动）。✓
- semantic mapping 版本化：`mapping-schema.json` 定义，`contract:mapping` 审计——✓。

---

# 23. Work Orchestration

- `server/modules/work-orchestration/work-orchestration.service.ts`（1549 行）+ `domain-persistence.service.ts`（864 行）。
- 职责：work-graph 索引（调用 tools/work-indexer 模块函数 findArtifactsDir/indexWorkGraph）、gate 计算（GateEngineModule.calculate）、git-sync plan + liveApply、handoff CRUD、risk/decision、filesystem 访问（readFileSync/readdirSync/rmSync/writeFileSync）、DB 持久化（domain-persistence）。
- 与 CLI 重复：`tools/work-indexer`、`tools/gate-engine`、`tools/work-console` 各自独立实现，server 通过 `createRequire` 加载工具模块（work-orchestration.service.ts:12）——**运行时依赖 tools 目录（源码耦合）**。
- **结论：P2**。1549+864 行职责过多（索引+门禁+git+handoff+持久化+fs）。建议抽取 `@ewoh/work-core` 共享库，server 与 CLI 共用；filesystem 耦合与 parser/schema 重复需治理。

---

# 24. Deploy Architecture

| Component | Build File | Image | Command | Production Ready? | Placeholder? |
| --------- | ---------- | ----- | ------- | ----------------- | ------------ |
| api | deploy/cloud/Dockerfile.api | node:22-alpine | `node dist/server/main.js` | 是（EWOH_DEPLOY_TARGET=standalone） | 否 |
| migrate | deploy/cloud/Dockerfile.migrate | node:22-alpine | `node db/runner/run_migrations.js ...` | 是 | 否 |
| postgres | compose | postgres:17-alpine | — | 是 | 否 |
| redis | compose | redis:7-alpine | — | 是 | 否 |
| helm | helm/ewoh/* | — | 含 migration-job/worker/hpa/pdb/networkpolicy/pvc | 是 | 否 |

- Dockerfile.api 真实构建（build:prod:standalone）+ runtime 复制 dist + contracts/catalog/tools/.codex。✓
- compose migrate 使用 `db/runner/run_migrations.js --apply-standalone...`，**未使用 delivery SQL**（✓，符合要求）。
- **deploy 不依赖 delivery/release**（✓）。但 api 运行时依赖 `.codex/artifacts`（EWOH_WORK_ARTIFACTS_DIR）与 tools——`tools` 是活跃源码，构建期 copy 进镜像，可接受但属"runtime→tool 源码"耦合（P2）。
- helm values/secret.example/k8s 均存在；healthcheck/restart/pvc/networkpolicy 完整。**部署体系质量高。**
- Python 边缘运行时**无容器化**（仅本地 run.py）——P2（试点边缘部署需明确进程管理）。

---

# 25. Test Architecture

| Domain | Unit | Integration | E2E | Contract | Runtime |
| ------ | ---- | ----------- | --- | -------- | ------- |
| Edge Bus | ✓ (test_adapters_bus) | — | — | ✓ (contract-tck) | — |
| Inference | ✓ (test_inference 1145 行) | — | — | ✓ | — |
| Edge Scheduler | ✓ (test_scheduler/scheduling) | — | — | — | — |
| RLS | ✓ (server tests) | ✓ (cross-tenant-tck) | — | — | — |
| Ingest | ✓ (server spec) | — | — | — | — |
| World State | ✓ | — | — | — | — |
| Scheduler V2 | ✓ (24 spec 文件) | ✓ (dispatch-integration) | ✓ (test/e2e) | — | — |
| Reservation | ✓ (reservation/conflicts spec) | ✓ | — | — | — |
| Dispatch | ✓ (dispatch-integration) | ✓ | — | — | — |
| Replan | ✓ (overrides/replan spec) | ✓ | — | — | — |
| CommandMap | ✓ (client 640 tests) | — | ✓ (playwright) | — | — |
| Feishu webhook | 无 | 无 | 无 | 无 | 无 |
| DB migration | ✓ (verify SQL) | ✓ | — | ✓ | — |

**实际运行结果（本审计执行）：**
- Python unittest：`Ran 731 tests OK`（15.9s）——但**未覆盖生产装配分支**。
- pytest contract（tests/）：`124 passed, 1 skipped`。
- Server tsc：`--project tsconfig.node.json` 通过。
- Client tsc：`--project tsconfig.app.json` 通过。
- Client jest：`81 suites / 640 passed`。
- Scheduler jest（hard-constraints/solver-invariants/routing/dispatch-integration/priority-engine/conflicts）：`6 suites / 51 passed`；日志显示 CP-SAT worker UNAVAILABLE→fallback。

**为什么测试没发现 P0（import 漂移）？** 因为：
1. 测试 sys.path 含 `src/edge_platform`，恰好命中 `edge`/`inference` 顶层别名，掩盖漂移；
2. 无针对 `run.py build_components` 真实分支的 import 集成测试；
3. `selfcheck.py` 只测 stub 路径（注释自明"以 stub 依赖启动"）；
4. CI（test.yml）未运行"非 stub 装配"冒烟。

---

# 26. Major Data Flows

```
① Device → edge_to_spark.py → POST /api/ingest/* → IngestService → ewoh_telemetry → RuleEngine → ewoh_event
② Event → createReplayItem → ewoh_event(REPLAY_*) + ewoh_event_chain（回放派生）
③ Task → ewoh_production_task → Scheduler V2 createRun
④ Task → Scheduler → solveVariants → Plan(shadow) → approve → dispatch → assignment + reservation + outbox
⑤ Backend WorldState → SSE /api/scheduler/v2/stream → useSchedulerStream → React Query → CommandMap
⑥ Contracts → scripts/audit-* → CI gate → release
⑦ Python edge: telemetry → bus → pipeline → rule/event → SQLite → server /api/*
```

---

# 27. Dependency Matrix

```
React Frontend → @shared/api.interface → NestJS API → Domain Services → Drizzle → PostgreSQL(RLS)
Edge(Python) → (无共享契约消费) → SQLite
NestJS Scheduler → HTTP → CP-SAT Worker(Python, 默认不可达→fallback)
Feishu App → lark-cli(子进程) → Feishu OpenAPI
WorkOrchestration(server) → require(tools/work-indexer, tools/gate-engine)  ← runtime→tool 源码
Deploy(api image) → contracts/catalog/tools/.codex(构建期 copy)
```

**依赖方向违规项：**
- `server → tools`（work-orchestration 运行时加载 tools 源码）——P2。
- `NestJS → Python CP-SAT`（HTTP 跨运行时求解，默认不可用但 fallback 正常）——P1（默认路径是 fallback，行为正确但能力未兑现）。
- `Python edge → SQLite`，`NestJS → Postgres`：**edge/cloud 数据不互通**（无统一 world state 事实源）——P1。
- 无 `runtime → delivery/release` 依赖（✓）。

---

# 28. Module Ownership Matrix

| Capability | Production Canonical | Edge | Legacy | Prototype | Demo |
| ---------- | -------------------- | ---- | ------ | --------- | ---- |
| Telemetry | NestJS ingest + ewoh_telemetry | Python adapters/bridge | — | — | stubs.DemoSimulator |
| Inference | （NestJS rule-engine；Python inference 未接入生产） | Python inference（stub 数据） | — | — | stub |
| World State | NestJS world + scheduler snapshot | Python world_model | — | — | — |
| Event | NestJS events/alert | Python risk_event | — | — | — |
| Task | NestJS task + production_task | Python task | — | — | — |
| Resource | NestJS resource + reservation | Python resources | — | — | gamification |
| Scheduler | **NestJS Scheduler V2（heuristic 实际运行）** | Python SchedulerService（真实但数据 stub） | NestJS /api/scheduler/plans(V1模板) | Python orchestrator.Scheduler | — |
| Routing | NestJS RoutingService/RouteCostProvider | Python route_planner | — | — | — |
| Policy | NestJS SchedulingPolicy (versioned) | Python weights | — | — | — |
| Approval | NestJS approval + plan approve | Python confirm | — | — | — |
| Dispatch | NestJS DispatchCoordinator | Python execute | — | — | gamification dispatch |
| CommandMap | React CommandMap (V2) | — | — | ui/command_map | — |
| Work Graph | tools/work-indexer + WorkOrchestration | — | — | — | — |
| Database Schema | db/migrations(standalone) → schema.ts | stubs.SCHEMA (SQLite) | 001/002 legacy | — | — |
| API Contract | shared/api.interface.ts + openapi | — | — | — | — |

**Scheduler 定位（明确）：**
```
Production Canonical = NestJS Scheduler V2（heuristic solver 实际执行，CP-SAT 预留）
Edge Scheduler = Python SchedulerService（真实，数据源 stub，offline 能力）
Legacy = NestJS /api/scheduler/plans V1 模板方案 + gamification 调度端点
Prototype = Python orchestrator.Scheduler（旧单任务）
```

---

# 29. Source-of-Truth Matrix

| Domain | Current Sources | Recommended Authoritative Source | Drift Risk |
| ------ | --------------- | -------------------------------- | ---------- |
| Production Business State | PostgreSQL (ewoh_*) | PostgreSQL | 低 |
| World State | ewoh_world_state(全表去重) + scheduler snapshot | **scheduler snapshot 语义为主 + DB 索引化 current** | 中（性能+口径） |
| Edge Observation | SQLite (Python) + ewoh_telemetry (NestJS) | 以 NestJS ewoh_telemetry 为主，edge→cloud 桥接 | **高（双库）** |
| Scheduler | NestJS V2（heuristic）+ Python SchedulerService + V1 模板 + gamification | **NestJS V2 唯一** | **高** |
| Policy | NestJS SchedulingPolicy(versioned) / Python weights | NestJS policy 版本化 | 中 |
| Database Schema | db/migrations(standalone) + schema.ts（生成） | **db/migrations → 生成 schema.ts** | 中（delivery/release 冻结） |
| API Contract | shared/api.interface.ts + openapi/ewoh.yaml | **openapi 生成 + shared types** | 低（CI 防漂移） |
| Event Contract | contracts/events + server event catalog | contracts（需加 runtime 校验） | 中 |
| Factory Config | catalog/ + contracts/catalog | catalog | 低 |
| Resource State | ewoh_device/personnel + reservation + scheduler snapshot | snapshot 派生（统一） | 中 |
| Route Cost | RoutingService(A*) + euclidean fallback | RoutingService 唯一 | 低（fallback 语义需统一） |
| Work Graph | .codex/artifacts(work/) | work-graph.schema.json | 中 |
| Delivery | delivery/（冻结） | 不参与运行时 | — |
| Release | release/（冻结快照） | 不参与运行时 | — |
| Prototype UI | ui/command_map（静态） | 仅参考 | — |

---

# 30. Key Classes & Functions

| File | Class/Function | Role | Called By | Calls |
| ---- | -------------- | ---- | --------- | ----- |
| run.py | build_components | 装配（坏 import→stub） | main | stubs.* |
| run.py | build_scheduler | 真实调度装配 | main | SchedulerService |
| server.py | Handler.do_GET/do_POST | 路由+审计 | httpd | services/scheduler |
| edge/bus.py | MessageBus | 真实总线（未接入生产） | tests | — |
| stubs.py | Bus/Storage/InferencePipeline | stub 契约 | run.py | — |
| inference/pipeline.py | InferencePipeline._infer | 推理 | handle_telemetry | rules/events |
| scheduler/scheduler_service.py | SchedulerService.confirm/execute | 调度闭环 | server/api | reservation |
| scheduler/cpsat/solver.py | solve | CP-SAT（依赖 ortools） | /api/scheduler/v2/solve | cp_model |
| world/service | WorldService.getCurrentState | 当前世界状态 | controller | DB(全表) |
| scheduler/world-state.service.ts | WorldStateSnapshotService.buildSnapshot | 快照+版本 | SchedulerService | 9 表 |
| scheduler/heuristic-scheduling-solver.ts | HeuristicSchedulingSolver.solve | **实际求解器** | SolverService | eligibility/routing |
| scheduler/cp-sat-scheduling-solver.ts | CpSatSchedulingSolver.solve | CP-SAT 门面 | SolverService | HTTP worker + heuristic |
| scheduler/dispatch-coordinator.service.ts | dispatch | 事务下发 | PlanService | reservation/outbox |
| scheduler/plan.service.ts | approvePlan/replan | 审批/重排 | SchedulerService | snapshot/solver |
| ingest.service.ts | processOneFrame | 逐条 ingest | controller | rule-engine |
| shared/org-context.interceptor.ts | intercept | GUC 注入 | app.module | RequestDatabaseContext |
| shared/access-token.guard.ts | canActivate | JWT+org scope | app.module | AuthService |
| work-orchestration.service.ts | (多方法) | work 治理 | controller | tools modules |

---

# 31. Dead / Orphan / Legacy / Orphan Findings

| Item | Type | Evidence | Recommendation |
| ---- | ---- | -------- | -------------- |
| Python `orchestrator.py Scheduler` | Legacy（被 __init__/learning_loop 引用，无直接生产调用方） | learning_loop.py:28 | 保留作 reference，标记 deprecated |
| NestJS `/api/scheduler/plans`(POST/GET), `plans/:id/confirm` | Legacy 端点（模板方案） | scheduler.controller.ts:41-89 | 已标 deprecated；建议彻底移除或隐藏 |
| `gamification/resources/allocate`、`tasks/orchestrate`、`schedule/:id/dispatch` | Legacy 调度写入 | ResourcePoolPanel 仍 import（deprecated 注释） | 迁移后移除 |
| `services.recommend/confirm_assignment`（Python） | Deprecated（Adapter 兼容） | services.py:142-245 warnings.warn | 迁移后移除 |
| `ui/command_map` | UX Prototype | 无生产 import | 归档或标注参考 |
| `client/public/command_map` | 静态资源副本 | 无生产引用 | 清理或归档 |
| `ctx.kafka`（server.py） | 命名兼容别名 | server.py:131 | 重命名/清理 |
| `demo.db`/`-wal`/`-shm`（根目录） | 未跟踪演示数据（110MB） | git status | 清理/移出工作区 |
| `output/` 26+ 文件 | 生成报告（部分提交） | — | 由 CI 生成，应 ignore |
| `standalone_001_schema.sql` 与 `001_ewoh_managed_tables.sql` | 双迁移体系（legacy vs standalone） | db/migrations | 明确 standalone 唯一正向 |

---

# 32. Security Findings

| ID | Sev | Finding | Status | Location |
| -- | --- | ------- | ------ | -------- |
| SEC-1 | **P0** | Feishu `/webhook/card` 无验签，acknowledge/resolve/escalate 可伪造调用 | VERIFIED_BY_CODE | feishu-app/server/index.js:87-155 |
| SEC-2 | P0 | Python 生产静默运行 Stub/Simulator（demo 数据），可能被误认为真实 | VERIFIED_BY_RUNTIME | run.py:47-59 |
| SEC-3 | P1 | IngestGuard：`INGEST_API_KEY` 未配置时 **fail-open** | VERIFIED_BY_CODE | ingest.guard.ts:33-37 |
| SEC-4 | P1 | Ingest 幂等/存在性检查 DB 异常时 fail-open（重复/未知实体放行） | VERIFIED_BY_CODE | ingest.service.ts:479,493 |
| SEC-5 | P1 | Feishu CORS 全开 + 无 rate limit + /api 无认证 | VERIFIED_BY_CODE | index.js:55-62, api.js |
| SEC-6 | P2 | AccessTokenGuard org scope 解析失败 fallback primary org（单 org 可见） | VERIFIED_BY_CODE | access-token.guard.ts:60-66 |
| SEC-7 | P2 | `EWOH_AUTH_BACKEND=offline` Python 无强制认证（anonymous 可操作） | VERIFIED_BY_CODE | server.py:51-72 |
| SEC-8 | P2 | Feishu `feishu-config.json` 含真实 base_token（未入库但工作区存在） | VERIFIED_BY_RUNTIME | feishu-config.json |
| SEC-9 | P2 | 无 CSRF 防护配置（CORS 白名单下 token 仍走 header，风险低） | INFERENCE | — |
| SEC-10 | P3 | `RATE_LIMIT` 依赖 Redis；无 Redis 时 rate-limit 可能失败（需验证降级行为） | NEEDS_RUNTIME_VERIFICATION | rate-limit.guard.ts |

---

# 33. Performance Findings

| ID | Sev | Finding | Evidence | Complexity |
| -- | --- | ------- | -------- | ---------- |
| PERF-1 | **P1** | WorldService.getCurrentState 全表加载 + Node 内存去重 | world.service.ts:64-77 | Expected O(entities) w/ DISTINCT ON; Current O(full table) |
| PERF-2 | **P1** | Ingest batch 逐条串行，每帧 ≥3 DB 往返 | ingest.service.ts:66-75,88-187 | Expected O(n) batch; Current O(n×3) serial |
| PERF-3 | P2 | getReplay 5 表全量窗口查询 + 内存分钟聚合 | world.service.ts:200-327 | Expected DB-side 聚合 |
| PERF-4 | P2 | CommandMap 世界状态 2s polling（全量 CurrentWorldState） | CommandMap.tsx:170-175 | 轮询放大 |
| PERF-5 | P2 | WorkOrchestration fs 同步 IO（readFileSync 等） | work-orchestration.service.ts | 阻塞事件循环 |
| PERF-6 | P2 | 调度每任务候选全枚举（persons×devices×stations） | heuristic solver | O(T×P×D×S) |
| PERF-7 | P3 | `_recent_records` 每设备 2000 条 × 全设备 | services.py:341-350 | 问答放大 |

---

# 34. Code Quality Findings

| ID | Sev | Finding | Evidence |
| -- | --- | ------- | -------- |
| Q-1 | P1 | `shared/api.interface.ts` 2045 行 / 129 types / 92 importers 过度集中 | 统计 |
| Q-2 | P1 | 坏 import 24 处（顶层 `edge.*/inference.*`）未通过 CI 拦截 | 扫描 |
| Q-3 | P2 | `scheduler.service.ts` 1975 行职责过多（V1 模板 + V2 + policy + conflicts） | LOC |
| Q-4 | P2 | `work-orchestration.service.ts` 1549 + `domain-persistence` 864 职责过多 | LOC |
| Q-5 | P2 | 调度默认时长三处不一致（30min/1h/策略 default） | cp-sat:20, dispatch:129, policy |
| Q-6 | P2 | Python 阈值硬编码（confidence 0.6 / bounds / 规则阈值）未版本化 | pipeline.py:43-61 |
| Q-7 | P3 | `ctx.kafka` 命名漂移 | server.py:131 |
| Q-8 | P3 | 模板方案 metrics 公式化（output_rate=1.12 等 hardcode） | scheduler.service.ts:229-260 |

---

# 35. Top 10 Risks

1. **P0** Python 边缘平台真实装配永久失效，静默运行 stub（demo 数据被误当真实）——`run.py:29-34`。
2. **P0** Feishu webhook 无验签，处置动作可被伪造——`index.js:87-155`。
3. **P0** CP-SAT 默认不可用（依赖 ortools 未装），且其 DecisionTrace 为占位值——`cp-sat-scheduling-solver.ts:420`。
4. **P1** Edge( SQLite ) 与 Cloud( Postgres ) 双库、双世界状态事实源，无统一权威。
5. **P1** Ingest 逐条串行 + fail-open（API key/幂等/存在性），批量吞吐与数据完整性风险。
6. **P1** WorldState 全表加载内存去重，规模化必然劣化。
7. **P1** Scheduler 多套实现（V2/heuristic、V1 模板、Python、gamification）继续并存，future 扩展会再加第五套。
8. **P1** 调度时长默认值不一致（solver 30min vs dispatch 1h vs policy），可能导致执行窗口与预约不符。
9. **P1** 测试体系无法发现生产装配失败（sys.path 掩盖 + 无装配测试）。
10. **P2** `shared/api.interface.ts` 契约集中 + server→tools 源码耦合，治理成本高。

---

# 36. Target Architecture（目标边界）

```text
UI (React) → API Contract (@shared + openapi) → Application(NestJS modules)
→ Domain(Scheduler V2 / World / Task / Resource) → Infrastructure(PostgreSQL + RLS)

Edge(Python) → 明确边界：采集/本地推理/离线调度 → 通过 bridge(edge_to_spark.py) 同步到 Cloud
   - Edge 只读共享契约（contracts/*），不直接写 Postgres

Scheduler 唯一 Canonical：NestJS Scheduler V2
   - CP-SAT worker 作为可选增强（依赖 ortools），DecisionTrace 补全

Schema 唯一：db/migrations(standalone) → 生成 schema.ts
API 唯一：openapi 生成 + shared types
Policy：NestJS SchedulingPolicy 版本化（edge 权重收敛其中）

禁止：runtime→delivery/release、runtime→prototype、runtime→simulator 隐式
```

---

# 37. Refactoring Roadmap

## Phase 0：修复真实可运行性与安全问题（Week 1）
- 修正 `run.py` import 为 `edge_platform.*`；实现/声明 `edge/manager.py`、`edge/storage.py` 或**移除"真实模块"分支并显式报错**（不允许静默 stub 伪装生产）。
- 统一 Bus 契约：明确 `MessageBus` 为唯一实现，修正 `InferencePipeline.start()` 的 subscribe 语义与 topic 白名单（新增 `inference` stream 或改 publish 到 `events`）。
- Feishu webhook 验签（timestamp+nonce+signature / lark-cli 验签）+ CORS 白名单 + body limit + rate limit。
- `INGEST_API_KEY` 改为必填（启动失败而非 fail-open）。
- 补"生产装配冒烟测试"（import 校验 + 非 stub 装配自检），并加入 CI。

## Phase 1：事实源收敛（Week 2）
- Edge→Cloud：明确 bridge 为唯一入口；删除 Python 侧 SQLite 事实源的生产依赖（或降级为纯离线参考）。
- World State：`getCurrentState` 改 `DISTINCT ON (entity_id)` 或 materialized current 表；统一 world state 版本语义。
- Scheduler：V1 模板端点下线；gamification 调度端点下线；`services.recommend/confirm` 移除。
- 调度时长默认值统一到 policy（`defaultTaskDurationMs` 单一来源）。

## Phase 2：模块/接口治理（Week 3）
- 拆 `shared/api.interface.ts` 为域模块（auth/organization/spatial/world/scheduler/task/resource/event/common）+ index.ts，迁移 92 个 importer。
- 抽 `@ewoh/work-core`（indexer/gate/git-sync 共用），server 不再 require tools 源码。
- 拆 `scheduler.service.ts`（V1 模板移出）、`work-orchestration.service.ts`。
- OpenAPI 拆 domains + bundle（保持单一发布文件）。

## Phase 3：实时性、性能与规模化（Week 4）
- Ingest batch 事务化 + 批量 upsert + UNIQUE(raw_ref)。
- WorldState 查询 SQL 化；CommandMap polling 间隔策略化。
- CP-SAT worker 生产化（安装 ortools、DecisionTrace 补全）或明确 heuristic-only。
- Feishu simulator 加环境开关，生产禁用。

## Phase 4：长期工程治理
- Contracts 运行时校验（JSON Schema on TS/Python 消费侧）。
- Dead code 清理（ui/command_map、orchestrator legacy 标记、output 产物 ignore）。
- 多迁移体系收敛（standalone 唯一正向），交付/发布快照自动化生成。

---

# 38. Files to Modify（最优先）

| Priority | File | Action |
| -------- | ---- | ------ |
| P0 | `src/edge_platform/run.py` | 修正 import / 移除静默 stub |
| P0 | `ewoh-feishu-app/server/index.js` | webhook 验签 + CORS + body limit |
| P0 | `ewoh-feishu-app/server/feishu.js` | 验签工具（Encrypt/VerifToken） |
| P0 | `ewoh-spark-app/server/modules/scheduler/cp-sat-scheduling-solver.ts` | DecisionTrace 补全 |
| P1 | `ewoh-spark-app/server/modules/ingest/ingest.guard.ts` | INGEST_API_KEY 必填 |
| P1 | `ewoh-spark-app/server/modules/ingest/ingest.service.ts` | batch 事务化/幂等约束 |
| P1 | `ewoh-spark-app/server/modules/world/world.service.ts` | DISTINCT ON / 索引 |
| P1 | `src/edge_platform/edge/bus.py` + `inference/pipeline.py` | Bus 契约统一 |
| P1 | `src/edge_platform/collection/dataset.py` / `session.py` | 修正坏 import |
| P1 | 测试 | 新增生产装配冒烟测试 |
| P2 | `ewoh-spark-app/shared/api.interface.ts` | 域拆分 |
| P2 | `scheduler.service.ts` / `work-orchestration.service.ts` | 职责拆分 |

---

# 39. Validation Plan

| Phase | How to Validate |
| ----- | --------------- |
| P0 | `python run.py` 必须打印"真实模块装配完成"；`make test` 全绿；新增装配测试在 CI 必跑；Feishu webhook 验签测试（无签名→403） |
| P1 | `npm run type:check`、`jest scheduler` 全绿；world state 查询 EXPLAIN 走索引；ingest batch 100 帧 < 2s 且单事务 |
| P2 | `gen:openapi --check` 通过；shared types 拆后 tsc 全绿；work-core 抽取后 server+CLI 复用 |
| P3 | perf gate 通过；dead code 清理后 grep 无引用；demo.db 移出 |
| 长期 | contract runtime 校验测试、Scheduler V2 唯一性门禁（禁止新增第 N 套） |

---

# 40. One-Month Refactoring Plan

**Week 1（Phase 0 前半）：可运行性与安全**
- D1-2：run.py 装配修复 + edge/manager、edge/storage 决策（实现或显式降级）+ 装配冒烟测试。
- D3-4：Bus 契约统一 + collection 坏 import 修复。
- D5：Feishu webhook 验签 + CORS/body/rate limit；INGEST_API_KEY 必填。

**Week 2（Phase 0 后半 + 事实源）**
- D1-2：WorldState DISTINCT ON + scheduler 默认时长统一。
- D3-4：Ingest batch 事务化 + UNIQUE(raw_ref) 迁移。
- D5：Scheduler V1 端点下线 + gamification 写入下线 + 回归测试。

**Week 3（Phase 1-2 治理）**
- D1-3：shared/api.interface.ts 域拆分（含 92 importer 迁移）。
- D4-5：work-core 抽取（indexer/gate/git-sync）或先做接口收敛。

**Week 4（Phase 2-3 性能 + 收尾）**
- D1-2：openapi 拆分 + bundle；scheduler.service/work-orchestration 职责拆分（至少拆分 V1 模板）。
- D3-4：CP-SAT DecisionTrace 补全或 heuristic-only 决策；Feishu simulator 开关。
- D5：全量回归（unittest 731 + pytest 124 + jest 640+51 + tsc + playwright 冒烟）+ truth-check + 更新 docs。

**一个月后可验证状态：**
1. `python run.py` 真实装配成功（或明确 fail-fast 提示非 stub）。
2. Feishu webhook 需验签才能处置。
3. WorldState 查询走 SQL 索引（EXPLAIN 验证）。
4. Scheduler 只剩 V2 一套写入路径。
5. shared types 已拆分且 tsc/jest 全绿。
6. 无静默 stub / 无 delivery-release 运行时依赖 / 无 gamification 写入。

---

# Completed / Partially Reviewed / Not Yet Deep-Read

```text
Completed:
- Repository baseline & coverage scan
- Python Edge Runtime 启动链 / Bus / Inference / World Model / Scheduler 走读
- NestJS Backend 入口 / RLS / Org Context / Ingest / World / Scheduler V2 / Dispatch/Replan
- React Frontend / CommandMap / useSchedulerStream / shared types
- DB migrations / RLS / OpenAPI 漂移验证 / Contracts / Catalog / Deploy / Feishu
- 实际运行：unittest(731 OK) / pytest(124 OK) / tsc(server+client OK) / jest(client 640 + scheduler 51 OK)

Partially Reviewed:
- client 大量 UI 组件（400+ 文件，仅结构扫描）
- tools/work-* 深度细节、contracts 各 schema 全量
- delivery/release 内容（冻结资产，不参与运行时）

Not Yet Deep-Read:
- ewoh-spark-app 全部 137 个测试文件（抽样 30 个）
- deploy/cloud/k8s 与 helm values 全部细节（已结构扫描）
- 各适配器协议实现（camera/uwb/mes/environment 等，已确认存在但未逐行精读）
Reason: 仓库 6046 tracked 文件 / 16.9 万行活跃源码，单次审计上下文有限；核心运行路径、P0/P1 风险与事实源已优先完整分析。
```
