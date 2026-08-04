# EWOH 当前 HEAD 独立完成度审计报告

> 独立完成度审计（只读）。本报告不把任务板 Done 视为完成，以当前 HEAD 实际代码、可执行测试、
> OpenAPI、数据库生成器、部署工件与运行证据为唯一判断基础。
> 审计期间未修改任何受审计代码；仅新增本报告与审计日志。

## 1. 执行环境指纹

| 项 | 值 |
|---|---|
| 仓库地址 | `git@github.com:qq547820639/EWOH.git` |
| 当前分支 | `codex/ewoh-iteration-2026-08-04` |
| HEAD commit SHA | `e432f361e6788c10cc510419feeef7472302f869` |
| 检查时间 | `2026-08-04 11:26 CST`（本地）+ `2026-08-04T03:37Z`（pilot 检查） |
| 操作系统 | macOS 27.0（Darwin 27.0.0，arm64） |
| Node / npm | v26.5.1 / 11.17.0 |
| Python | 3.9.6 |
| Git | 2.54.0 |
| PostgreSQL | **不可用**（无 `psql`、无服务端） |
| Docker / Compose | **不可用** |
| kubectl / Helm | **不可用** |
| 可用环境 | 本地 Node 全量静态门禁、Python unittest/TCK、Standalone 构建 |
| 不可用环境 | 真实 PostgreSQL、容器/K8s/Helm 部署、真实设备、飞书/移动端运行时、Playwright 浏览器 |

> 环境限制结论：**本机无法运行真实 PostgreSQL E2E、认证浏览器流程、容器/编排部署与真机验证。**
> 这些项在报告中的判定为 `Blocked by External Validation`（环境缺失），未伪造任何结果。

## 2. 实际运行过的命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm ci`（ewoh-spark-app） | PASS（2049 包） |
| 2 | `npm run type:check` | PASS（server+client tsc 0 错误） |
| 3 | `npm run lint`（eslint + stylelint） | PASS |
| 4 | `npm test -- --runInBand` | PASS（81 套件 / 394 测试） |
| 5 | `npm run test:client` | PASS（34 套件 / 176 测试） |
| 6 | `npm run build:prod:standalone` | PASS（构建成功） |
| 7 | `bash scripts/standalone-check.sh` | PASS（**E2E/浏览器因无 PG 跳过**） |
| 8 | `node scripts/audit-repo-facts.js --strict` | PASS（33/33） |
| 9 | `node tools/work-indexer/index.js --root . --invariants` | PASS（252 项/39 边/48 actor/109 证据/14 gate/0 冲突） |
| 10 | `node tools/work-console/index.js --root . --strict` | PASS（0 阻塞 / **210 缺证据** / 4 门禁待批） |
| 11 | `make test`（Python unittest） | PASS（667 测试） |
| 12 | `make connector-tck` | PASS（32 项） |
| 13 | `make aas-tck` | PASS（7 项） |
| 14 | `make rego-tck` | PASS（4 项） |
| 15 | `bash scripts/pilot-readiness-check.sh` | **NOT READY**（5 通过 / 3 失败 / 7 待批准） |
| 16 | `db/runner/run_migrations.js --plan *`（DDL 计划） | PASS（生成各迁移计划） |

### 跳过项（环境不可用，未伪造）
- `npm run test:e2e`（需 `EWOH_E2E_RUNTIME_DATABASE_URL`，即真实 PostgreSQL）
- `npm run test:browser`（Playwright，依赖真实 PG fixture）
- Docker Compose / K8s / Helm 部署与验证
- 真实数据库升级/回滚/备份/恢复执行（仅生成 DDL 计划，未连库执行）
- 飞书 / 移动工作台真实运行时流程

## 3. 代码证据路径

| 能力 | 代码路径 |
|---|---|
| 因果执行控制台（只读） | `tools/work-console/`、`tools/work-indexer/`、`tools/gate-engine/`、`ewoh-spark-app/server/modules/work-orchestration/`、`ewoh-spark-app/client/src/pages/WorkOrchestration/` |
| 资源/权限/Handoff | `tools/resource-registry/`、`tools/handoff-service/`、`scripts/audit-*.js` |
| GitHub 同步 | `tools/git-sync/` |
| 工厂复制/场地就绪 | `tools/factory-replication/`、`contracts/factory/`、`catalog/factory-sites/` |
| 边缘平台 | `src/edge_platform/`（connectors/edge/world_model/spatial/scenario/backup） |
| 连接器 | `src/edge_platform/connectors/`（modbus/opcua/sparkplug/webhook/csvfile）、`catalog/connectors/` |
| 场景包/映射 | `catalog/`、`contracts/mapping/`、`contracts/workflow/` |
| 数据库 | `db/migrations/`、`db/contracts/schema-manifest.yaml`、`db/runner/run_migrations.js`、`ewoh-spark-app/server/database/schema.ts` |
| OpenAPI | `openapi/ewoh.yaml`、`openapi/work-orchestration.yaml`、`openapi/route-manifest.json` |

## 4. 测试证据路径

| 层 | 路径 | 结果 |
|---|---|---|
| 后端单元/契约 | `ewoh-spark-app/test/` | 81 套件 / 394 通过 |
| 前端单元 | `ewoh-spark-app/client/src/**/*.test.ts` | 34 套件 / 176 通过 |
| 边缘单元 | `src/edge_platform/tests/`、`tests/` | 667 通过 |
| 连接器/AAS/Rego TCK | `scripts/connector-tck.py`、`aas-tck.py`、`rego-tck.py` | 32/7/4 通过 |
| 仓库事实/Work Graph/控制台 | `scripts/audit-repo-facts.js`、`tools/work-indexer`、`work-console` | 33/33、0 冲突、0 阻塞 |
| 部署工件 | `scripts/verify-deploy-artifacts.js`、`verify-helm-chart.js` | 包含在 standalone-check 中通过 |
| E2E/浏览器 | `ewoh-spark-app/test/e2e/`、`test/browser/` | **未运行（需 PG）** |

## 5. 当前 Gate 状态

- `.codex/artifacts/gates.md`：G0-G10 已通过；G11-G13 待人工批准。
- `tools/work-console`：**4 个门禁需人工批准**；0 个阻塞节点。
- `pilot-readiness-check.sh`：**PILOT READINESS = NOT READY**
  - 通过 5：release 校验和 / acceptance evidence / training plan / deployment runbook / release manifest
  - 失败 3：docker / kubectl / helm（本机缺失）
  - 待批准 7：database verify / runtime database / pilot factory / production approval / training completed / acceptance signoff / real device config
- 结论：**当前 Gate 状态不允许进入生产试点**；G10+ 需人类批准，本审计未代批。

## 6. 权威制品冲突（关键）

| # | 冲突 | 证据 |
|---|---|---|
| C1 | **51 表口径不一致** | CHANGELOG 声称"受管表 48→51"；`schema-manifest.yaml` 声明 `managed_count:48`、`new_group_count:36`、`physical_create_count:38`、`mapped_existing_count_in_group:1`；`001_ewoh_managed_tables.sql` 含 **56 条 CREATE TABLE**；`schema.ts` 引用约 70 个 `ewoh_*` 表名（含索引）。**51 这个数字在权威源中无单一出处**。 |
| C2 | **CHANGELOG 测试数字漂移** | CHANGELOG rc4 尾行声称 `server 81/391、client 15/50`；实际 HEAD 为 `server 81/394、client 34/176`。差异属自报过期，未随 HEAD 更新。 |
| C3 | **E2E 通过数不一致** | CHANGELOG 多处声称 `29/29` 与 `33/33` 并存；本环境未运行 E2E，无法独立复核，标记为未验证。 |
| C4 | **逻辑 vs 物理表口径** | manifest 用 `logical_name`（如 `ewoh_person`→物理 `ewoh_personnel`、`ewoh_device_person_binding`→`ewoh_device_binding`）映射，权威"表数"需明确是逻辑口径还是物理口径。 |

## 7. 未完成任务 / 缺口（不依赖环境的实测缺口）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **4 个门禁缺人工批准**（G11-G13 等） | `work-console` 输出 |
| G2 | **210 条任务缺证据**（仅 T-198..T-217 有 1 条，其余 0 条） | `work-console` 输出 |
| G3 | **Gate 无撤销/回滚 API** | `GatesPanel.tsx` L236/238/247/249/284/301 均为 TODO（"需后端提供 gate 撤销/回滚 API"） |
| G4 | **离线冲突无强制解析端点**（**已闭合**，见 14.2） | `offlineConflict.ts` L38、`useOfflineWorkbench.ts` L429 TODO 原为（409 无 `serverValue`、需 idempotent force-resolution 端点）；Phase 3 已实现 `serverValue` + 幂等 force-resolve 端点并接线前端 |
| G5 | **OIDC 后端为 stub** | `src/edge_platform/auth/identity.py` L9/L103/L111（"未实现完整 OIDC 授权码/PKCE"） |
| G6 | **跨工厂调度为 STUB** | `src/edge_platform/spatial/multi_factory.py` L38/L419/L447（`CROSS_FACTORY_STUB`，V2.0 未实现） |
| G7 | **Site Readiness 真实环境探测为前端 TODO** | `siteReadinessProbe.ts`/`SiteReadinessWizard.tsx` L419（Docker/K8s/Helm/真实设备探测需后端接口） |
| G8 | **GitHub 真实同步未启用** | `tools/git-sync/` 生成计划，真实创建需人工批准并显式启用（CHANGELOG 自述） |
| G9 | **调试残留文件未排除** | `ewoh-spark-app/test/browser/_dbgws.spec.js`（untracked，命名 `_dbgws` 疑似调试残留） |

> 未发现：生产路径硬编码租户/设备 UUID（72 处命中多为 `factory-lan`/`--org-id`/示例 AAS/`OrgContextInterceptor` 导入/`catalog/factory-sites` 路径，属误报）；前端 mock/假数据（0 命中）；空 catch（0 命中）。

## 8. T101-T114 逐项判定

| 任务 | 判定 | 依据 |
|---|---|---|
| T101 权威制品与 51 表口径对账 | **Partial** | `audit-repo-facts` 33/33 通过，但 51 表口径存在 C1 冲突 |
| T102 Work Graph Schema 与索引器 | **Verified Complete** | `work-graph.schema.json` + `work-indexer` 252 项/0 冲突，`--invariants` 通过 |
| T103 只读因果执行控制台 | **Verified Complete** | `work-console` 运行 0 阻塞；`/api/work/*` 只读路由存在 |
| T104 Evidence 与 Gate Engine | **Implemented but Unverified** | `gate-engine` 运行；但 210 条缺证据、4 门禁待批，覆盖率不足 |
| T105 资源、权限和 Handoff 服务 | **Verified Complete** | `resource-registry`/`handoff-service` 落盘并接入门禁 |
| T106 GitHub Issue、PR、CI 同步 | **Implemented but Unverified** | `git-sync` 生成计划；真实创建需人工批准+外部 OAuth，未验证 |
| T107 Order-to-Delivery 场景包 | **Partial** | 目录 Manifest 存在；无真实集成 E2E 证据 |
| T108 移动 E-SOP 场景包 | **Partial** | 移动 API/页面存在；缺真实设备 E2E 与离线冲突强制解析（G4） |
| T109 质量追溯场景包 | **Partial** | 质检方案/追溯图存在；无独立 E2E 证据 |
| T110 ERP/MRP/库存连接器包 | **Partial** | `catalog/connectors/erp` Manifest 存在；无真实 ERP 联调证据 |
| T111 第二真实工厂无分叉复制 | **Implemented but Unverified** | `factory-replication` 工具存在；真实第二工厂需现场数据（阻塞） |
| T112 第三真实工厂配置化复制 | **Blocked by External Validation** | 依赖真实 PG E2E + 真实工厂配置，本环境不可用 |
| T113 伙伴交付与认证工具 | **Implemented but Unverified** | `partner/shadow-run` 存在；需真实伙伴环境验证 |
| T114 生产 SLO 与最终验收工具链 | **Blocked by External Validation** | `pilot-readiness-check` = NOT READY（docker/kubectl/helm 缺失 + 7 项待批准） |

## 9. 风险

### 高
- **R1 生产试点被 3 项环境缺失 + 7 项待批准阻塞**：`pilot-readiness` NOT READY，无真实 DB/容器/设备/签署，无法进入生产。
- **R2 51 表口径权威冲突**：文档、manifest、迁移、schema 四处数字不一致，直接威胁"受管表对账"验收可信度。

### 中
- **R3 Evidence 缺口**：210 任务缺证据、4 门禁待批，完成定义（Done 需绑定 HEAD SHA + 环境指纹 + 独立验证）多数未满足。
- **R4 关键交互缺口**：Gate 撤销/回滚、离线冲突强制解析、Site Readiness 真实探测均为 TODO；移动 E-SOP 冲突处理未闭环。
- **R5 自报数字漂移**：CHANGELOG 测试/E2E 数字与 HEAD 不一致，权威事实源需机器可验证。

### 低
- **R6 部分能力为 stub**：OIDC、跨工厂调度（V2.0 明确 STUB）。
- **R7 调试残留文件**：`_dbgws.spec.js` 未排除。

## 10. 建议实施顺序

按依赖与风险优先级：

1. **P0 - 权威口径收敛**：修复 51 表口径（C1），统一 manifest / migration / schema / CHANGELOG 数字，纳入 `audit-repo-facts` 机器校验（对应 Phase 1 权威制品一致性）。
2. **P0 - Evidence 补齐**：为 210 个缺证据任务登记 Evidence（workItemId/commitSha/environment/…/verifier），补 4 个门禁的人工批准流程（Phase 1）。
3. **P1 - 关键交互闭环**：实现 Gate 撤销/回滚 API、离线冲突 idempotent force-resolution、Site Readiness 真实探测后端接口（Phase 2/3 UX 深化）。
4. **P1 - 连接器与场景包 TCK**：为 ERP/MRP/WMS/Order-to-Delivery/质量追溯补齐 Connector TCK 与场景 E2E 证据（Phase 4）。
5. **P2 - 生产工程证据**：在具备 PG/容器的环境重跑真实 E2E、浏览器、DB 迁移/回滚/备份恢复，绑定 HEAD SHA 与环境指纹（Phase 5）。
6. **P2 - 外部验证解阻**：提供 docker/kubectl/helm、真实 PostgreSQL、真实试点工厂、生产批准、培训签署、验收签署与真机配置，滚动 `pilot-readiness-check` 至 READY（Phase 6）。

## 11. 当前完成度结论（暂定，最终结论见 Phase 6）

本阶段为只读审计，**不输出最终 A-E 结论**。基于当前证据，完成度倾向为：

> **核心实现完成度高，但验证环境缺失（无 PostgreSQL/容器/真机），且 Pilot 门禁 NOT READY —— 尚不具备生产与规模复制条件。**

该方向对应 **A（核心实现完成，但仍不具备生产和规模复制条件）**，将在 Phase 6 由独立验证 Agent 复核后给出最终结论（A-E 五档选一，附证据）。

## 12. Phase 1 对账 CLI 验证（权威制品一致性 + Work Graph）

> 依据 Phase 1（Task 1.4/1.5/1.6/1.7/1.8）新增 `scripts/reconcile-authoritative-artifacts.js` 只读对账 CLI，
> 并在 pre-commit 与 CI 接入。以下为实际运行结果（只读，未改写任何权威源）。

### 12.1 实际运行命令

| # | 命令 | 退出码 |
|---|---|---|
| 1 | `node scripts/reconcile-authoritative-artifacts.js --strict --root .` | **1**（存在冲突，符合设计） |
| 2 | `node scripts/reconcile-authoritative-artifacts.js --strict --json --root .` | **1**（机器可读 JSON 输出） |
| 3 | `npx jest test/unit/reconcile-authoritative-artifacts.spec.ts --runInBand`（ewoh-spark-app） | **0**（5/5 通过） |

HEAD：`3eaf1260f3d77840917ae1a327c5da195b431b57`（main）。运行时间：2026-08-04。

### 12.2 检查项结果（6 项：3 PASS / 3 FAIL）

| 检查项 | 结果 | 说明 |
|---|---|---|
| `version_changelog_vs_release_manifest` | **PASS** | CHANGELOG 最新版本号 == release-manifest.release |
| `trace_id_in_phase_state` | **PASS** | state.json.trace_id 在 phase-state.md 中被引用 |
| `route_manifest_consistent_with_live_scan` | **PASS** | route-manifest.json 与实时扫描一致（controller/spec operations 匹配） |
| `db_table_footprint_reconcile` | **FAIL** | **C1 冲突**：schema-manifest 计算表数与 CHANGELOG(48→51)/state.json/release-manifest 声称的 51 不一致 |
| `evidence_structure_complete` | **FAIL** | 110 条证据中 87 条缺 `workItemId` 字段（结构完整性未达标；本报告新增的 round105 证据已含全部字段） |
| `open_tasks_have_evidence_or_blocked` | **FAIL** | 58 个打开/进行中任务缺 Evidence 且未标记 Blocked by External Validation |

### 12.3 汇总

- `summary: passed=3, failed=3, total=6, conflictCount=146, evidenceCount=110, openTaskCount=58`
- 冲突（146）集中在三类：C1 表口径（1）、Evidence 结构缺字段（87）、打开任务缺证据（约 37）。
- **C1 51 表口径冲突已被如实报告**，未自动修复任何权威源（符合只读约束）。
- 输出模式：人类可读（默认）、`--json`（机器可读）、`--output`（写文件）、`--diff`（仅报告建议，不写回）。
- 冲突时退出码非零（`--strict` 亦强制 1），无冲突时退出 0。

### 12.4 接线位置

- **pre-commit**：`ewoh-spark-app/scripts/hooks/run-precommit.js` → `runReconcile()`（lint 之后、非零失败即阻断提交，可 `--no-verify` 绕过）。
- **CI**：`.github/workflows/test.yml` → step「权威制品一致性对账（Phase 1）」`node scripts/reconcile-authoritative-artifacts.js --strict --json --output ...`。

### 12.5 结论

Phase 1 对账 CLI 交付完成：实现 + 单元测试（5/5）通过 + pre-commit/CI 接线 + 只读不回写。该 CLI 将原有 `audit-repo-facts` 覆盖的 C1/R2 权威口径冲突、Evidence 结构缺口（G2）与打开任务缺证据固化为机器可验证的门禁，作为后续 Phase 2/3 收敛权威口径与补齐 Evidence 的客观基线。

---
*审计人：EWOH 总控工程 Agent（独立审计，非实现自签）*
*审计时间：2026-08-04*

## 13. Phase 2 因果控制台验证（Gate 撤销/历史/阻塞原因）

> 依据 Phase 2（G3 契约闭合）实现门禁撤销/回滚、历史查询与「为什么被阻塞」解释，并接线前端。
> 以下为实际运行命令与结果（本机，无 PG/浏览器）。

### 13.1 实际运行命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx jest test/unit/work-orchestration/work-orchestration.service.spec.ts --runInBand` | **PASS**（25/25，含 7 个新增 revoke/history/blockedReason 用例） |
| 2 | `npm run type:check` | **PASS**（server+client tsc 0 错误） |
| 3 | `npm run lint` | **PASS**（eslint + stylelint + type:check） |
| 4 | `npm test -- --runInBand` | **PASS**（82 套件 / 405 测试） |
| 5 | `node scripts/audit-openapi-routes.js --strict` | **PASS**（controller 251 / spec 251 / 0 未登记 / 0 未实现） |
| 6 | `node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json` | **PASS**（route-manifest 已更新至 251 ops） |

### 13.2 新增/修改契约

- `POST /api/work/gates/{id}/revoke`：撤销门禁当前决定；若历史存在前一条决定则回滚恢复，否则回到无决定状态；撤销以 `action='revoked'` 审计记录追加到 `gate-decision-history.json`。
- `GET /api/work/gates/{id}/history`：返回该门禁完整历史（决定/撤销，含时间、actor、reason）。
- `GET /api/work/items/{id}/blocked-reason`：解析前置依赖（blocking/depends 边）与门禁状态，返回自然语言中文解释。
- 前端：`GatesPanel.tsx` 撤销/历史按钮接线；`WorkGraphPanel.tsx` 节点详情展示「为什么被阻塞」。
- OpenAPI 契约登记：`openapi/work-orchestration.yaml`（新增 3 条 path + GateRevokeRequest/GateRevokeResult/GateHistoryRecord/BlockedReason schema）。

### 13.3 结论

Phase 2 因果控制台契约闭合完成：实现 + 单元测试通过 + 前端接线 + OpenAPI 契约登记 + route-manifest 更新。
撤销/历史沿用 `gate-decisions.json` / `gate-decision-history.json` 落盘，未引入新依赖，未改冻结状态机/安全边界/共享契约。
真实 PG/浏览器 E2E 依赖外部环境（本机不可用），未伪造结果。证据文件 `.codex/artifacts/work/evidence/round106-causal-console-gate-revoke.md`。

## 14. Phase 3 用户体验统一验证（G4 离线冲突闭环 + 九态抽查 + UX Backlog）

> 依据 Phase 3（G4 契约闭合、UX_DEEPENING_BACKLOG、九态错误体验抽查）实现与验证。以下为实际运行命令与结果（本机，无 PG/浏览器）。

### 14.1 实际运行命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npx jest test/unit/mes/mes.service.spec.ts --runInBand` | **PASS**（22/22，含 4 个新增 force-resolve 用例） |
| 2 | `npm run type:check:server` | **PASS**（tsc 0 错误） |
| 3 | `npm run type:check:client` | **PASS**（tsc 0 错误） |
| 4 | `npm run lint` | **PASS**（eslint + stylelint + type:check） |
| 5 | `node scripts/audit-openapi-routes.js --strict` | **PASS**（controller 253 / spec 253 / 0 未登记 / 0 未实现） |

### 14.2 G4 离线冲突闭环（闭合 G4）

- 后端步骤迁移 409 冲突响应新增 `serverValue`（当前服务端步骤状态）。
- `POST /api/mes/work-orders/{id}/steps/{stepId}/force-resolve`：幂等强制解析。`resolution:'server'` 保留服务端状态；`resolution:'local'` 经合法状态机重新应用本地动作，绝不绕过状态机；仍冲突则 `applied=false`+`LOCAL_CONFLICT_PERSISTS`。
- `POST /api/mobile/workbench/orders/{orderId}/steps/{stepId}/force-resolve`：移动端委托。
- 复用 `IdempotencyService`，同 `idempotencyKey` 重复调用返回记录结果。
- 前端 `offlineConflict.ts` 消费 `serverValue`（`parseConflictPayload`）渲染本地 vs 服务端差异；`useOfflineWorkbench.ts` `resolveConflict` 实际调用 `forceResolveMobileStep`，离线时提示"无法提交冲突解析，请恢复网络后重试"，本地仍无法应用时明确提示"已保留服务端状态"。
- **禁止静默覆盖**：所有冲突解决显式选择（本地/服务端/手动），全程审计。
- OpenAPI 契约登记 2 条 force-resolve 路由 + `MesForceResolveRequest/MesForceResolveResult` schema；route-manifest 更新至 253 ops。

### 14.3 九态错误体验抽查（最小 UI 处理）

- 抽查 `Devices`、`WorkOrchestration`（含 10 个子面板）、`RoleWorkbench` 三页：Loading/Empty/Error(Failure/Denied/Offline/Validation)/Success 均通过 `QueryState`/`ErrorState` 覆盖；Conflict 由 `WorkOrchestration` 冲突横幅与 `MobileWorkbench` 冲突解析覆盖；Partial 由分面板独立 `QueryState` 覆盖。
- 本轮为 `Devices` 页补充 **Expired/Stale** 态：超过 2 个刷新周期（60s）未成功更新时显示"数据已过期，暂未获取到最新设备状态"，并区分"正在刷新"。

### 14.4 产物

- 新增 `docs/product/UX_DEEPENING_BACKLOG.md`：覆盖第四阶段 3.1–3.13 共 13 项，每项含角色/问题/当前行为/目标行为/页面/API 或状态机依赖/优先级/验收/Playwright 场景/截图状态。
- 证据文件 `.codex/artifacts/work/evidence/round107-g4-offline-conflict-force-resolve.md`。

### 14.5 结论

Phase 3 用户体验统一深化完成：G4 离线冲突闭环闭合（实现 + 单测 + 前端接线 + OpenAPI + route-manifest）、九态抽查补齐 Devices 过期态、UX_DEEPENING_BACKLOG 产出 13 项。
未改冻结状态机/安全边界/共享契约；未引入新第三方依赖。真实 PG/浏览器 E2E 依赖外部环境（本机不可用），未伪造结果。

## 15. Phase 4 连接器与场景包验证（统一连接器质量属性契约）

> 依据 Phase 4（T110 连接器深化）为 ERP/MRP/WMS 连接器建立统一质量属性契约并扩展连接器 TCK。以下为实际运行命令与结果（本机，无 PG/浏览器/真实 ERP/MRP/WMS 环境）。

### 15.1 实际运行命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `make connector-tck` | **PASS**（**119 项**，原 32 项 + 新增 87 项质量属性校验） |
| 2 | `node scripts/scenario-tck.js` | **PASS**（8 门禁；asset-catalog 4 场景/4 连接器/2 映射/38 项） |
| 3 | `make test` | **PASS**（667 测试 OK） |

### 15.2 统一连接器质量属性契约（Canonical Connector Contract）

- 新增共享 schema `catalog/connectors/connector-contract.schema.json`（JSON Schema draft-07，`$id: ewoh:///connector-contract/v1`），定义 10 项统一质量属性：**canonicalModel、mappingTemplate、cursor、idempotency、replay、compensation、deadLetter、rateLimit、dataQuality、observability**。
- 升级 `catalog/connectors/erp/erp-inventory.yaml`、`erp-order-delivery.yaml`：新增 `spec.connectorContract`（含 cursor 字段、idempotencyKey、DLQ 主题、限流阈值、数据质量规则、可观测性指标）。
- 新增 `catalog/connectors/mrp/mrp-material-planning.yaml`、`catalog/connectors/wms/wms-inventory.yaml`，结构对齐统一契约。
- `contracts/catalog/connector-package.schema.json`：`spec` 允许可选 `connectorContract`（object），结构由共享 schema 校验。
- 已确认仓库无既有 MRP/WMS catalog，未重复；`catalog/connectors/` 现共 4 个清单。

### 15.3 连接器 TCK 新增校验（32→119 项）

- schema 本体：`$id`、draft-07、任务要求的 8 项必填属性（canonicalModel/cursor/idempotency/replay/deadLetter/rateLimit/dataQuality/observability）齐备。
- 每个 ERP/MRP/WMS 清单：`connectorContract.schemaRef` 指向共享 schema；8 项质量属性存在；结构抽查（canonicalModel.schemaRef、cursor.field、idempotency.keyField、replay.supported、deadLetter.topic、rateLimit.requestsPerSecond、dataQuality.schemaValidation、observability.metrics、mappingTemplate.templateRef、compensation.supported）。
- PyYAML 缺失时显式标记 blocked（`contract yaml parser available = False`），不静默跳过。

### 15.4 核心中立性抽查

- 连接器运行时（`src/edge_platform/connectors/`）与新增 catalog 未引入客户名称/客户专属字段判断/长期客户分支（grep 捷顺/jieshun/customer_specific/customerName 等 0 命中）。
- 核心服务代码未改动（仅新增 catalog 契约文件、扩展 TCK 脚本、connector-package schema 增加可选 `spec.connectorContract`）。

### 15.5 结论

Phase 4 连接器契约深化完成：统一契约 schema + ERP/MRP/WMS 清单对齐 + connector-tck 扩展（119 项）+ scenario-tck 8 门禁通过 + make test 667 通过。未改冻结状态机/安全边界/共享事件契约；未引入新第三方依赖（PyYAML 已在环境，dev-only）。真实 ERP/MRP/WMS 联调属外部验证，本环境不可用，未伪造结果。证据文件 `.codex/artifacts/work/evidence/round108-connector-scenario-deepening.md`。

## 16. Phase 5 生产工程验证（生产工程深化）

> 依据 Phase 5（部署工件一致性、SBOM 与供应链安全、生产 SLO/错误预算、Runbook 补齐、
> 密钥/审计/脱敏核对、外部验证项登记）。本机无 PostgreSQL/Docker/kubectl/Helm/真机，
> 依赖真实环境的项标记为 `Blocked by External Validation`，未伪造结果。

### 16.1 实际运行命令与结果

| # | 命令 | 结果 |
|---|---|---|
| 1 | `node scripts/verify-deploy-artifacts.js` | **PASS**（66/66） |
| 2 | `node scripts/verify-helm-chart.js` | **PASS**（128 checks，Helm ewoh 0.1.0 / app 0.6.0-rc4） |
| 3 | `node scripts/deployment-tck.js` | **PASS**（34/34 + REGO TCK 4 + DEPLOYMENT TCK 4 gates） |
| 4 | `make test`（Python） | **PASS**（667 tests OK） |
| 5 | `node scripts/generate-sbom.js` | **PASS**（mode=npm-sbom，top=ewoh-spark-app@2.2.5，components=235） |

### 16.2 新增/修改交付物

- `scripts/generate-sbom.js`（新增）：Node 内置调用 `npm sbom` 生成 CycloneDX 1.5 SBOM，
  不可用时降级为 lockfile 派生摘要并标记；无第三方依赖。
- `release/ewoh-spark-sbom.cyclonedx.json`（新增）：生成的 SBOM 产物（235 运行时组件）。
- `docs/delivery/supply-chain-security.md`（新增）：依赖扫描、镜像签名、SBOM 校验流程。
- `docs/delivery/slo-error-budget.md`（新增）：核心 API 可用性 99.9%、P95≤800ms/P99≤2000ms、
  错误率≤0.5%、容量基线、告警降噪规则。
- `docs/delivery/deployment-runbook.md`（v1.1→v1.2）：补充 DB 备份/恢复、边缘断网/重连/重放/远程升级、
  批量升级/灰度/暂停/回滚、可验证回滚点。
- `docs/reviews/LATEST_HEAD_AUDIT.md`（本小节）、`.codex/artifacts/work/evidence/round109-production-engineering.md`（证据）。

### 16.3 密钥/审计/脱敏核对结论

- `.env.example`（`deploy/.env.example`、`deploy/cloud/.env.compose.example`、
  `ewoh-spark-app/.env.standalone.example`）与 `deploy/cloud/k8s/secret.example.yaml`：
  敏感值均为占位符（`CHANGE_ME`/`REPLACE_WITH`/空），**无真实密钥**。
- 审计与脱敏实现复用：`server/modules/shared/audit.service.ts`（`redact()` 深度脱敏）、
  `server/modules/system/system.service.ts`（`maskSensitiveConfig()`）、
  `src/edge_platform/server.py`（`/api/security/policy` 对 `tls_cert/tls_key/jwt_secret/oidc_client_id` 脱敏）。
- 结论：密钥未泄漏、审计脱敏已存在并复用，无新增缺口。

### 16.4 外部验证项（Blocked by External Validation）

| 验证项 | 所需输入 | 状态 |
|---|---|---|
| 真实 DB 迁移/回滚/备份恢复 | 真实 PostgreSQL 17（owner + ewoh_api 角色） | Blocked |
| Docker/K8s/Helm 部署 | Docker、kubectl、Helm、registry | Blocked |
| 边缘断网重连重放 | 真机/边缘设备 + 平台 | Blocked |
| 长稳大数据测试 | 真实 PG + 高负载 | Blocked |
| 批量升级灰度回滚 | 生产试点工厂 + 真机 | Blocked |
| `npm audit` 联网完整扫描 | 联网 registry | Blocked |
| 镜像签名/校验 | cosign/notation + registry + 密钥 | Blocked |
| 容量压测校准 | 压测环境（k6/ab） | Blocked |

### 16.5 结论

Phase 5 生产工程深化完成：部署工件验证脚本全部通过（无需修复）；SBOM 生成与供应链安全文档落地；
SLO/错误预算文档、Runbook 关键章节补齐；密钥/审计/脱敏核对通过；依赖真实环境的验证项如实登记为
Blocked by External Validation。未扩围业务、未改冻结契约、未引入新第三方依赖。证据文件
`.codex/artifacts/work/evidence/round109-production-engineering.md`。