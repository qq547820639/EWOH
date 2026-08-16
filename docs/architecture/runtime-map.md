# EWOH Runtime Map（运行时地图）

> 维护规范：本文件记录运行时入口、装配方式、部署形态与 CI 门禁；
> 入口/装配变更时更新。最后更新：2026-08-14。

## 1. 运行时清单

| 运行时 | 入口 | 装配方式 | 监听 | 部署形态 |
|---|---|---|---|---|
| 边缘平台 | 根 `run.py` → `src/edge_platform/run.py::main` | RuntimeFactory 三模式（production/development/simulation）；production 禁 stub 且 fail-fast | 127.0.0.1:8765（HTTP/SSE） | 裸 Python ≥3.9（零第三方运行时依赖）；现场/离线 |
| 云侧主产品 | `ewoh-spark-app/server/standalone-main.ts`（生产）；`main.ts` legacy 需 `EWOH_LEGACY_ENABLED=1` | NestJS DI（42 模块）；abortOnError fail-fast；CORS 禁 `*`；TRUST_PROXY=true 抛错 | :3000（API+SPA fallback） | Node ≥20 + PG17；docker-compose.standalone.yml / K8s / Helm（deploy/） |
| CP-SAT worker（可选） | `src/edge_platform/scheduler/cpsat/worker.py` | HTTP 服务（:8000，/health/live） | 127.0.0.1:8000 | Dockerfile.cpsat + compose optional profile；未部署（ortools 无环境） |
| 飞书侧车 | `ewoh-feishu-app/server/index.js` | Express + better-sqlite3；lark-cli 子进程（异步+并发4+熔断） | :3000（默认 PORT） | Node ≥20；与云侧解耦 |

## 2. 边缘装配细节（P0 级不变量）

- `Settings.load()`（全默认零配置）→ `resolve_runtime_mode()` → `RuntimeFactory.assemble(mode)`：
  production 只允许真实组件（RealAssemblyError → 非零退出，绝不回退 stub）；
  development 需显式 `EWOH_ALLOW_STUB=1`；simulation 显式 stub。
- `ensure_scheduling_write_permitted()`：connected production 下边缘调度只读
  （advisory），调度写权限唯一归 NestJS（防 split-brain）。
- 已知缺口：生产装配无适配器注册入口（E-03，config 驱动工厂注册待做）。

## 3. 云侧请求链（实测）

```
AccessTokenGuard(JWT) → RolesGuard(RBAC) → OrgContextInterceptor(buildGucSettings:
  app.user_id/current_org_id/current_org_ids/is_global_admin, set_config 事务级)
→ RequestDatabaseContext(AsyncLocalStorage 请求级事务) → RLS → Service → DB
```
SSE（`/api/scheduler/v2/stream` 等）经 SSE_METADATA 直通，不进事务（P0-3 已修复）。

## 4. 部署与配置权威源

- 部署参数唯一事实源：`deploy/.env.example`（audit-env-inventory --strict，102 项 0 违规）。
- 迁移：`node db/runner/run_migrations.js --apply-standalone`（唯一权威 schema 源）。
- 部署工件：`deploy/cloud/`（compose/cpsat）、`deploy/k8s`、`deploy/helm`（verify-helm-* 门禁）。
- 发布：`release/`（rc1..rc4 快照，不参与运行时）、`scripts/package-release.sh`、SBOM。

## 5. CI 门禁地图（.github/workflows/）

test.yml（edge unittest/契约/装配门禁 + server/client jest + type:check）、
standalone.yml（真实 PG：迁移/RLS/multi-tenant E2E）、runtime-gates.yml（truth-gate-record）、
openapi 零漂移、feature-status 行级校验、env-inventory、repo-facts、release-gate、
RC 升级门禁（verify-rc-upgrade）等 7 个 workflow。

## 6. 运行模式与激活阶梯

- 边缘：`EWOH_RUNTIME_MODE`（development/production/simulation）。
- 求解器激活阶梯（唯一事实源）：`OFF → SHADOW → CANARY → PRODUCTION`
  （`EWOH_SOLVER_ACTIVATION`；PRODUCTION 还需 `EWOH_SOLVER_PRODUCTION_ENABLED=1`，
  否则 fail-closed 回退 heuristic，fallbackReason=production_not_gated）。
- 飞书 Simulator：双开关 fail-closed（`FEISHU_SIMULATOR_ENABLED` +
  `ALLOW_SIMULATOR_IN_PRODUCTION`）。
