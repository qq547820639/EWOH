# RoleWorkbench 生产化深化与真实数据闭环 Spec

## Why
基线 `main` @ `300a2b0ec639ccb112912a25419b887d1af4dc65`（2026-08-06 10:26）上，工作台仍存在结构性的“内存实现与占位数据”：
- `RoleWorkbenchService.getWorkbench` 一次性从 6 张领域表各读最多 5000 行到 Node 内存，再在内存里做 filter/sort/slice/pagination；`getWorkbenchList` 复用该全量结果在内存分页，未做数据库级 WHERE/ORDER/LIMIT，也未做 cursor 分页。
- 多条工作台指标是硬编码占位（`overdueInspections: 0`、`dispositions: []`、`maintenanceTasks: []`、`capacityDegradation: []`、`riskTrend: []`），用户无法区分“真实为零”与“无数据”。
- 保存视图与导出任务默认仍用内存 Map（`InMemoryWorkbenchViewStore` / `InMemoryWorkbenchExportStore`），DB 持久化被标注为 `BLOCKED_BY_ENVIRONMENT`，跨重启/多实例无法恢复。
- 工作台核心表（`ewoh_schedule_task`、`ewoh_event`、`ewoh_world_state`、`ewoh_spatial_entity`、`ewoh_resource_binding`）缺少 `org_id`，组织隔离未落到数据库层。
- 发布状态、镜像扫描等仍存在“SHA 不绑定 / 未构建镜像却可能被当作通过”的缺口。

本轮目标不是加表面功能，而是把这些“内存实现、占位数据、非持久化状态、伪服务端分页、运行时门禁缺口”改造成可运行、可验证、可维护的生产实现。

## What Changes
- **P0 当前版本真值**：基于最新 main 记录完整 SHA/版本/CI 结果/未提交修改；发布状态改为机器可验证真值（STALE 检测、四态状态、Production Ready 由当前 SHA 强制门禁自动计算）。
- **P0 RoleWorkbench 数据库级查询**：工作台列表改为真实 PostgreSQL 查询（WHERE/ORDER BY/LIMIT + 参数化 + org_id 强制 + 稳定排序键 cursor 分页），删除 5000 固定上限，聚合指标用数据库聚合/物化，为高频查询加复合索引并用 EXPLAIN ANALYZE 验证。
- **P0 消除占位业务数据**：`overdueInspections`、`dispositions`、`maintenanceTasks`、`capacityDegradation`、`riskTrend` 等改为真实查询或明确的 `status/source/calculatedAt/dataRange` 表达，杜绝固定 0/空数组/吞错返回空。
- **P0 保存视图 PostgreSQL 持久化**：新增 `saved_views` 表 + migration，完成增删改查/默认唯一/乐观并发/schema 校验/组织隔离/旧 localStorage 迁移。
- **P0 导出任务真实任务系统**：导出任务持久化到 PostgreSQL，outbox/claim 队列模型、多实例安全领取、幂等键、状态机含 cancelling/cancelled、取消/超时/重试/退避、流式导出、对象存储适配器、审计。
- **P1 用户体验深化**：URL 与状态同步、数据页多态区分、缓存/新鲜度表达、危险操作确认；不改变安全边界。
- **P1 大数据量性能验收**：10k/100k（必要时 1M）确定性数据集，记录 p50/p95/p99、DB 执行时间/扫描行数，防 N+1，性能预算进 CI 并超预算即失败。
- **P1 生产运行时门禁**：migration/backup-restore/K8s+Helm/canary/soak-load/容器安全（Trivy 真实镜像）完整实现；环境不可用项如实标 `BLOCKED_BY_ENVIRONMENT` 并给出可复制命令。
- **P1 依赖/构建体积/前端性能**：依赖安全审计逐项处理；CommandMap 大分块路由/组件级懒加载；设首屏/异步 chunk 预算并记录真实 LCP/INP/CLS。
- **测试**：补齐单元/集成/HTTP+PG E2E/跨组织越权/多实例并发/重启持久化/Playwright/弱网/键盘 a11y/10k-100k 性能/migration-backup-rollback 测试，尤其第 5001 条、游标无重复无遗漏、双 worker 不重复处理等回归。

## Impact
- Affected specs: `close-production-truth-ux`、`code-deepening-ux-closed-loop`、`engineering-truthfulness-production`、`latest-head-audit-and-deepening`
- Affected code:
  - `ewoh-spark-app/server/modules/operations/{role-workbench.service.ts, workbench-list-query.ts, workbench-access.ts, workbench-view.service.ts, workbench-export.service.ts, operations.module.ts}`
  - `ewoh-spark-app/client/src/pages/RoleWorkbench/**`、`ewoh-spark-app/client/src/**`（URL 同步、状态多态、虚拟化、导出 UI）
  - `ewoh-spark-app/server/database/schema.ts` + `db/migrations/standalone_00X_*.sql`（新增 `saved_views`、导出任务表、工作台 `org_id` 列与索引）
  - `scripts/truth-source.js`、`truth-manifest.js`、`output/*`（发布真值）
  - `.github/workflows/{standalone,test,security,package}.yml`（性能预算、镜像扫描、运行时门禁）
  - `docs/runtime-gates.md`、`README.md`、`CHANGELOG.md`、发布报告

## ADDED Requirements
### Requirement: Database-Level Workbench List Queries
The system SHALL serve workbench lists (tasks, steps, events, abnormal devices, materials, personnel, defects, risks) via real PostgreSQL queries with mandatory `organization_id` filtering, parameterized SQL, database WHERE/ORDER/LIMIT, stable-sort-key cursor pagination, and accurate COUNT only when page mode is required. The system SHALL NOT pull full domain tables into Node memory for filter/sort/slice, SHALL NOT use fixed `.limit(5000)` truncation, and SHALL NOT fake server-side pagination by slicing an in-memory full set.

#### Scenario: Querying beyond the 5000th row
- **WHEN** a workbench list has more than 5000 rows and the user requests a later page/cursor
- **THEN** the server returns the correct rows via a database query; no record is silently dropped due to a hard limit

#### Scenario: Cursor pagination with duplicate sort values
- **WHEN** rows share identical sort keys (same timestamp / same priority)
- **THEN** the cursor keys on a stable unique key so pages do not duplicate or omit records

### Requirement: Non-Misleading Metric Availability
Every workbench metric SHALL return `value`, `status`, `calculatedAt`, `dataRange`, and `source`/`sourceVersion`. When a metric has no reliable data source, the system SHALL NOT fabricate `0` or an empty trend; it SHALL return an explicit availability status distinguishing `no_data`, `not_configured`, `permission_denied`, `source_unavailable`, and `stale`, and the UI SHALL render a human-understandable state so users can tell "true zero" from "no data yet".

#### Scenario: True zero vs unavailable
- **WHEN** a metric has no rows vs when its data source is unavailable
- **THEN** the API returns different `status` values and the UI renders distinct states

### Requirement: Persistent Saved Views
The system SHALL persist saved views in PostgreSQL in a `saved_views` table (id, organization_id, owner_user_id, name, workbench/role/list identifier, schema_version, filter/sort JSON, visible columns, column order, density, is_default, created_at, updated_at, soft-delete). It SHALL support create/rename/copy/update/delete, default-view uniqueness, optimistic concurrency, schema validation, restore across devices and re-login, multi-instance consistency, org isolation + owner permissions, old localStorage migration, and recoverable conflict/migration-failure prompts. The in-memory Map SHALL NOT be the production default store.

#### Scenario: View survives restart
- **WHEN** the server restarts between saving and reading a view
- **THEN** the view is still present and correctly scoped to its owner + org

### Requirement: Durable Export Task System
The system SHALL persist export tasks in PostgreSQL, consume them via a worker-safe outbox/claim model, prevent duplicate processing across instances, and support idempotency keys, a state machine (queued/running/succeeded/failed/cancelling/cancelled/expired), cancel/timeout/retry/exponential-backoff, streaming or chunked cursor export, a replaceable object-storage adapter, short-lived signed or permission-protected downloads, and audit records (who, scope, row count, file size, finish time). Task status SHALL survive page refresh, server restart, and instance switch.

#### Scenario: Two workers claim one task
- **WHEN** two workers attempt to claim the same export task
- **THEN** only one worker processes it; the second is rejected atomically

### Requirement: SHA-Bound Release Truth
The release status SHALL be machine-verifiable: reports SHALL record the full SHA at generation time, display `STALE` on SHA mismatch, and distinguish not-run / failed / environment-blocked / succeeded as four distinct states. `BLOCKED_BY_ENVIRONMENT` items SHALL NOT be counted as PASS. `Production Ready` SHALL be auto-computed from the current SHA's gating results, not hand-filled. Image scanning SHALL NOT show as passed when CI has not built an image.

#### Scenario: Stale evidence on SHA mismatch
- **WHEN** a report's evidence SHA differs from the current build SHA
- **THEN** the report and UI explicitly show `STALE` and do not claim Production Ready

## MODIFIED Requirements
### Requirement: RoleWorkbench Server-Side Data Path (from close-production-truth-ux)
Elevated from "server-side pagination over an in-memory full set" to "true database-level WHERE/ORDER/LIMIT + cursor pagination + org-scoped", with fixed-limit and in-memory-slice implementations removed.

## REMOVED Requirements
### Requirement: In-Memory Workbench Pagination / Full-Table Load
**Reason**: `.limit(5000)` per table plus Node-side filter/sort/slice silently truncates data and does not scale or enforce DB-level org isolation.
**Migration**: Replace with per-list database queries using cursor pagination and org-scoped predicates.

### Requirement: Fixed Placeholder Metrics
**Reason**: Returning `0` / `[]` / empty trend for metrics without a data source misleads operators.
**Migration**: Return explicit availability status (`no_data`/`not_configured`/`permission_denied`/`source_unavailable`/`stale`) with `value`, `calculatedAt`, `dataRange`, `source`.