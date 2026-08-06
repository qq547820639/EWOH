# RoleWorkbench 生产化深化与真实数据闭环 — 交付报告

> 生成时间：2026-08-06 · 依据当前 `origin/main` HEAD 的真实执行证据生成（非历史报告）。
> 基线 SHA：`300a2b0ec639ccb112912a25419b887d1af4dc65`（main）
> 本报告所有状态均来自本机实际运行结果；环境不可用项如实标 `BLOCKED_BY_ENVIRONMENT`。

---

## 1. 当前基线 SHA 与最终 SHA

- **基线（开始本次深化时）**：`300a2b0ec639ccb112912a25419b887d1af4dc65`
- **最终（提交后）**：`731991d`（`feat(roleworkbench): 生产化深化与真实数据闭环`，76 文件 +7187/-521；已推送 `origin/main`，工作树干净）。
- 分支：`main`；远端：`origin`（`git@github.com:qq547820639/EWOH.git`）。

## 1.1 执行环境指纹（本机）

| 项 | 值 |
|----|----|
| 时间 | 2026-08-06 12:45 CST |
| OS | macOS（darwin） |
| Node | v26.5.1 |
| npm | 11.17.0 |
| Python | 3.9.6 |
| PostgreSQL | **未安装（BLOCKED）** |
| Docker | **未安装（BLOCKED）** |
| Helm | **未安装（BLOCKED）** |
| brew | 未安装 |

版本来源（单一事实源）：`version.json` = `0.6.0-rc4`；`ewoh-spark-app/package.json` = `0.6.0-rc4`；发布目录 `release/ewoh-0.6.0-rc4/`。

## 2. 实际修改的文件列表

### 修改（modified）
`.github/workflows/security.yml`、`.github/workflows/test.yml`、`CHANGELOG.md`、`db/runner/run_migrations.js`、
`deploy/cloud/helm/ewoh/templates/deployment.yaml`、`deploy/cloud/helm/ewoh/templates/migration-job.yaml`、
`deploy/cloud/helm/ewoh/values.yaml`、`docs/runtime-gates.md`、
`ewoh-spark-app/client/src/api/operations.ts`、`client/src/pages/CommandMap/CommandMap.tsx`、
`client/src/pages/RoleWorkbench/{RoleWorkbench,SavedViewsPanel,WorkbenchChrome,WorkbenchList}.tsx`、
`client/src/pages/RoleWorkbench/roleWorkbenchState.ts`(+test)、
`ewoh-spark-app/package.json`(+lock)、`server/database/schema.ts`、
`server/modules/operations/{operations.module,role-workbench.service,workbench-export.service,workbench-list-query,workbench-view.service}.ts`、
`test/unit/operations/{role-workbench.service,workbench-export.service,workbench-list-query}.spec.ts`、
`output/bundle-report.json`、`scripts/truth-manifest.js`。

### 新增（untracked → 提交）
- **迁移**：`db/migrations/standalone_005_workbench_prod.sql`、`.rollback.sql`、`db/verify/standalone_005_verify.sql`
- **服务端存储/状态机**：`server/modules/operations/workbench-export-state.ts`、`workbench-export.store.ts`、`workbench-view.store.ts`
- **前端数据页状态**：`client/src/pages/RoleWorkbench/workbenchDataStates.ts`(+test)
- **性能/浏览器指标**：`ewoh-spark-app/scripts/perf/*`、`scripts/browser-metrics.mjs`
- **CI/运行时门禁脚本**：`.github/workflows/{perf,runtime-gates}.yml`、
  `deploy/cloud/helm/ewoh/templates/{networkpolicy,worker}.yaml`、
  `scripts/{truth-gate,truth-gate-record,truth-status}.js`、
  `scripts/{verify-migration-prod.mjs,verify-backup-restore.mjs,verify-helm-runtime.sh,canary-deploy.sh,soak-load.js,container-image-gate.sh}`
- **文档/报告**：`docs/security/`、`docs/reviews/deepen-roleworkbench-production-report.md`（本文件）、`.trae/specs/deepen-roleworkbench-production/`

## 3. 数据库 migration 说明

`standalone_005_workbench_prod.sql`（幂等、可重复执行）：
1. 为 5 张工作台源表加 `org_id` 组织租户列并回填（`ewoh_schedule_task`/`_step`/`ewoh_event`/`ewoh_world_state`/`ewoh_spatial_entity`/`ewoh_resource_binding`），`org_id` 租户范围。
2. 高频复合索引：`org_id+status/priority/updated_at/key`、`org_id+assignee`、`org_id+event_type/created_at/event_id`、`org_id+entity_type/status/key`、`org_id+binding start/key` 等（见 §4）。
3. `saved_views` 表：`id/org_id/owner_user_id/name/workbench/list_key/schema_version/filter_json/sort_json/visible_columns/column_order/density/is_default/created_at/updated_at/deleted_at`；默认视图唯一索引 `uq_saved_views_default`（`WHERE is_default AND deleted_at IS NULL`）。
4. `workbench_export_tasks` 表：`task_id/org/owner/role/list_key/filter/sort/columns/status/progress/processed/total/error/idempotency_key/attempts/next_retry_at/claimed_by/claimed_at/started/finished/expires_at/download_url/file_size/row_count`；状态/重试、org+owner、幂等索引。
5. `GRANT SELECT,INSERT,UPDATE,DELETE ... TO service_role`（生产权限模型，镜像 standalone_001）。

回滚：`standalone_005_workbench_prod.rollback.sql`；校验：`db/verify/standalone_005_verify.sql`。`db/runner/run_migrations.js` 已接入 `--apply-standalone`/`--verify`/`--rollback`（含 `saved_views`/`workbench_export_tasks` 对象计数）。

## 4. 已消除的内存实现与占位实现

- **`.limit(5000)` 全表内存读取**：原 `RoleWorkbenchService.getWorkbench` 从 6 张领域表各读最多 5000 行到 Node 内存再 filter/sort/slice → 已移除；`getWorkbenchList` 现走真实 PostgreSQL 查询。`LIST_SOURCES` 中的 `mySteps/delayedOrders/abnormalDevices/pendingInspections` 全部为 DB 表来源。
- **伪服务端分页**：内存 `queryWorkbenchList` 仅保留给对象型指标（defectPareto/设备状态分布）归一为 `[key,value]` 行，不再对领域表做全表切片分页。
- **固定占位指标**：`overdueInspections`（无 SLA 窗口 → `no_data`）、`dispositions`（无处置工作流 → `no_data`）、`maintenanceTasks`（无维护任务表 → `no_data`）、`capacityDegradation`（`no_data`）、`riskTrend`（`no_data`）——均改为明确的 availability 对象，不再返回误导性 `0`/`[]`。
- **catch 吞错返回空**：`guarded()` 聚合失败时返回 `source_unavailable` 标记并 `logger.error`，绝不静默吞错返回“正常空”。
- **保存视图/导出内存 Map 为生产默认存储**：生产 `operations.module.ts` 注入 `PostgresWorkbenchViewStore`/`PostgresWorkbenchExportStore`（DB 持久化）；`InMemory*Store` 仅作单元测试 adapter（`@Optional()` 默认兜底仅测试/单实例 dev 使用，生产模块显式注入 PG 实现）。

## 5. 新的数据查询与索引设计

**查询**：参数化 WHERE（强制 `org_id`）+ 角色/资源授权 + 数据权限 → ORDER BY → LIMIT。稳定排序键 cursor 分页：`(sortColumn, uniqueColumn)` 排序，`cursorPredicate` 生成 `(sort > cv) OR (sort = cv AND uniqueId > id)`，处理相同时间戳/优先级重复值不重复不遗漏。页码模式单独 `count(*)`（不先读全量）。全文搜索 `ilike` 转义 `%_`。聚合指标用 SQL `count(*)`/`count(*) filter`/`groupBy`，不加载明细。

**索引**（`standalone_005`）：
- `ewoh_schedule_task`: `(org_id,status)` / `(org_id,priority)` / `(org_id,_updated_at)` / `(org_id,schedule_task_id)`
- `ewoh_schedule_task_step`: `(org_id,status)` / `(org_id,assigned_person_id)`
- `ewoh_event`: `(org_id,status)` / `(org_id,event_type)` / `(org_id,created_at)` / `(org_id,event_id)`
- `ewoh_world_state`: `(org_id,ts)`
- `ewoh_spatial_entity`: `(org_id,entity_type)` / `(org_id,status)` / `(org_id,entity_id)`
- `ewoh_resource_binding`: `(org_id,status)` / `(org_id,start_time)` / `(org_id,binding_id)`

EXPLAIN ANALYZE 验证：需真实 PG，本环境标 `BLOCKED_BY_ENVIRONMENT`（CI `runtime-gates.yml` 的 PG 服务容器内可执行，命令见 §10）。

## 6. 保存视图持久化设计

`saved_views` 表（字段见 §3）。`PostgresWorkbenchViewStore`：
- 创建/更新（upsert）、读取、列表（owner + org 共享）、软删除（`deleted_at`）；
- 组织隔离：每次读写显式 `organization_id` 过滤 + 请求事务 `app.current_org_id` GUC 双层防御；
- owner 权限：`deleteView` 仅 owner 或 global_admin；`listViews` 返回 owner + 共享视图；
- 默认视图唯一：`uq_saved_views_default` 部分唯一索引；
- 跨设备/重新登录/多实例一致性：数据在 PG，重启后仍存在；
- 乐观并发/schema 校验/schemaVersion 升级/旧 localStorage 迁移：由上层 `WorkbenchViewService` 与前端 SavedViewsPanel 处理（schemaVersion 列已建）。

## 7. 导出任务状态机与恢复机制

`workbench-export-state.ts` 纯状态机：`queued→running→succeeded`、`queued→failed`、`queued→cancelling→cancelled|failed`、`running→cancelling→...`、`→expired`、`failed→running`(重试)。
`PostgresWorkbenchExportStore`：`workbench_export_tasks` 表持久化；`claim()` 原子 UPDATE+RETURNING（`where status IN (queued, expired) OR (failed AND next_retry_at<=now)`）→ 双 worker 不重复处理；幂等键唯一；attempts/next_retry_at 退避。`WorkbenchExportService`：进度、取消（queued 立即取消 / running→cancelling）、confirmCancellation、retry、到期 expired、审计（谁/范围/记录数/文件大小/完成时间）。刷新/重启/实例切换后 `getExportTask` 从 DB 读取。流式/分块导出与对象存储适配器：查询复用 `getWorkbenchList` 游标/过滤/排序/列配置/组织权限（导出内容与当前视图一致）。

## 8. 用户体验改进说明

- **URL 与状态同步**：`WorkbenchChrome`/`RoleWorkbench` 将 角色/标签页/搜索/过滤/排序/游标/保存视图/详情项 同步到 URL，前进后退与分享 URL 可恢复。
- **数据页多态**：`workbenchDataStates.ts` 归约 `loading/refreshing/ok/empty/no_data/not_configured/permission_denied/source_unavailable/stale/partial/error`；`resolvePageHealth` 页面级健康度（ok/partial/degraded）；均由后端 status/availability 派生，不硬编码。
- **关键页面**：最近更新时间、是否缓存、过滤摘要、清除过滤入口、失败可重试（`listDataFreshness`）。
- **避免无限 skeleton**：`isBlockingListState` 阻断错误态，防止 skeleton 掩盖错误。
- **大数据量**：`WorkbenchList` 虚拟化 + 键盘/读屏语义（有单测覆盖 virtualList）。
- **危险操作**：`DangerousActionService` 影响预览/幂等确认/撤销/审计。

## 9. 安全与组织隔离验证

- 客户端传入的 `role`/`personId` 不信任：服务端 `assertWorkbenchAccess` 用 `actor.roles` 做 RBAC，`personId` 仅允许本人或 admin 模拟。
- 客户端 `organization_id` 不作为授权依据：所有查询强制服务端解析的 `actor.primaryOrgId` + DB 层 `org_id` WHERE + 事务 GUC，双层防御。
- 导出/视图：owner 权限 + org 隔离；越权返回 403。
- 未弱化既有安全门禁；`BLOCKED_BY_ENVIRONMENT` 未改名 PASS；未吞异常返回空结果。

## 10. 各测试命令及真实结果

在本机（无 PG/Docker/Helm）可运行项全部通过：

| 命令 | 结果 |
|------|------|
| `npx jest --runInBand`（服务端单元） | **98 suites / 581 tests PASS** |
| `npm run test:client` | **82 suites / 645 tests PASS** |
| `npm run type:check:server` | **PASS** |
| `npm run type:check:client` | **PASS** |
| `npm run build:prod` | **PASS**；bundle 预算：首屏 175.09kB gzip < 460kB PASS；单异步 chunk 243.57kB < 520kB PASS |
| `npm run openapi:no-drift` | **PASS**（OpenAPI 契约同步） |

需真实基础设施、本机不可复现（脚本/CI 已完整实现，如实标 **BLOCKED_BY_ENVIRONMENT**，CI 内含等价命令）：
- HTTP+PG E2E、跨组织越权数据库测试、第 5001 条回归、双 worker 不重复、重启持久化 → 需 PostgreSQL（CI `standalone.yml`/`runtime-gates.yml`）：
  ```bash
  export EWOH_E2E_OWNER_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:5432/ewoh'
  export EWOH_E2E_RUNTIME_DATABASE_URL='postgresql://ewoh_api:<pw>@127.0.0.1:5432/ewoh'
  cd ewoh-spark-app && npm run test:e2e && npm run test:browser
  ```
- 生产迁移门禁：`EWOH_MIGRATION_TEST_DB_URL=... node scripts/verify-migration-prod.mjs`
- 备份/恢复：`EWOH_BACKUP_SOURCE_URL=... EWOH_BACKUP_RESTORE_URL=... node scripts/verify-backup-restore.mjs`
- Helm 运行时/canary/soak/容器镜像：`bash scripts/verify-helm-runtime.sh` / `bash scripts/canary-deploy.sh` / `node scripts/soak-load.js` / `bash scripts/container-image-gate.sh`

已在本机运行并如实生成 `output/gate-results/*.json` 与各 report（全部 `BLOCKED_BY_ENVIRONMENT`，附原因，无伪造 PASS）：
- `postgres-migration-prod` → `BLOCKED_BY_ENVIRONMENT`（缺 `EWOH_MIGRATION_TEST_DB_URL`）
- `backup-restore-prod` → `BLOCKED_BY_ENVIRONMENT`
- `helm-runtime` → `BLOCKED_BY_ENVIRONMENT`
- `canary-upgrade` → `BLOCKED_BY_ENVIRONMENT`
- `soak-load` → `BLOCKED_BY_ENVIRONMENT`
- `container-image` → `BLOCKED_BY_ENVIRONMENT`（`docker binary 缺失`）

## 11. 10k/100k 性能结果

性能脚本已实现并接入 CI（`scripts/perf/seed-workbench-data.js` + `workbench-benchmark.js` + `perf-gate.js`，`perf.yml` 在 PG 服务容器内运行），记录 p50/p95/p99、DB 执行/扫描/返回行数，超预算即失败。
**本机无 PostgreSQL，10k/100k 大规模性能结果在本环境如实标 `BLOCKED_BY_ENVIRONMENT`，未凭本地小数据集宣布大规模性能通过。** CI 中命令：
```bash
# 在 runtime-gates/standalone CI 的 PG 服务容器内：
cd ewoh-spark-app && npm run perf:seed && npm run perf:bench && npm run perf:gate
```

## 12. CI 工作流和产物

- 新增/更新工作流：`.github/workflows/perf.yml`（性能预算）、`.github/workflows/runtime-gates.yml`（生产迁移/备份恢复/Helm 静态审计/容器镜像/运行时门禁）、`.github/workflows/{test,security,standalone}.yml`（既有门禁深化）。
- 产物命名：`runtime-gates-report-<sha>`（含 `output/gate-results/*.json`、`migration-prod-report.json`、`backup-restore-report.json`、`container-image-report.json`、`trivy-image-report.json`、`ewoh-api-sbom.cyclonedx.json`）。
- 发布真值：`output/evidence-manifest.json`（运行时/CI 派生，`evaluatedCommitSha` 绑定；`truth-manifest.js`/`truth-gate.js`/`truth-status.js` 实现 STALE 检测与四态；`make truth-check` 漂移校验）。

## 13. 环境阻塞事项及可执行命令

见 §10 各 BLOCKED 项的一次性命令。核心：装 PostgreSQL 17 后运行 `scripts/standalone-postgres-check.sh`（含 standalone_005 迁移/回滚/重放）；装 Docker 后 CI 可构建真实镜像并跑 Trivy；Helm 运行时/Canary/Soak 需真实集群。

## 14. 未完成事项和原因

- 真实 PostgreSQL 上的 E2E/跨组织/5001 条/双 worker/重启持久化/EXPLAIN ANALYZE/10k-100k 性能：本机无 PG，代码与测试与 CI 已就绪，待 PG 环境执行。
- 容器镜像真实构建 + Trivy/SBOM/digest：本机无 Docker，CI `container-image-gate.sh` 已就绪。
- Helm 运行时 install/upgrade/rollback/canary/soak：需真实集群，脚本已就绪。
以上均为环境阻塞，非代码缺项。

## 15. 五级状态结论

| 状态 | 结论 | 证据 |
|------|------|------|
| Code Implemented | **YES** | 数据库级查询/cursor 分页/保存视图 PG 持久化/导出任务状态机/真值门禁/性能与运行时脚本全部以真实代码落地 |
| Code Verified | **YES** | 服务端 581 测试、客户端 645 测试、双 typecheck、生产构建+bundle 预算、OpenAPI no-drift 全部通过 |
| Pilot Ready | **NO** | 需真实 PostgreSQL 环境跑通 E2E/5001 条/双 worker/重启持久化后确认 |
| Production Ready | **NO** | 当前 SHA 的强制门禁含多项 `BLOCKED_BY_ENVIRONMENT`（镜像扫描/迁移/备份恢复/Helm 运行时），按 `truth-status.js` 自动计算不为 ready；BLOCKED 不计 PASS |

> Production Ready 由当前 SHA 强制门禁自动计算（`scripts/truth-status.js`），非人工填写；存在 BLOCKED 项时如实为 NO。
