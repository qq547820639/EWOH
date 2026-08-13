# [systematic-audit-remediation] 全仓系统走读与整改 Spec

## Why

对 EWOH 仓库（Python 边缘平台 / NestJS 云侧 / 契约·DB·部署·工具·飞书侧车）做分域系统性走读后，确认整体架构分层清晰、事实源治理意识强、调度域工程质量高，但存在约 40 处代码质量问题，集中表现为三类：**安全 fail-open**（生产路径未认证/未限流/未校验、ingest 批量吞异常）、**事实源与引用断裂**（受管表 51/57 口径冲突、SQLite 旧 schema 挂进 PostgreSQL、指向不存在文件）、**死代码/重复实现/双写/god-file**。本规格对每一项均做**终态化处理**：修复或明确裁决落地，不保留「后续建议」悬挂项。

## What Changes

- **事实源与引用断裂修复（安全、无运行时语义变更）**
  - 移除 `deploy/docker-compose.yml` 将 SQLite 旧 schema 挂载为 PostgreSQL 初始化脚本的功能性错误。
  - 修复 `contracts/work/artifact-paths.json` 与 `tools/work-indexer/index.js` 引用不存在的 `authoritative-plan-final6.txt`。
  - 修复 `db/contracts/schema-manifest.yaml` 指向不存在的 `.codex/artifacts/contracts/*.md` 源文件。
- **边缘平台安全 fail-closed（高价值、行为收敛）**
  - `routes/auth.py` 的 `enforce_export_role` 由「无 token 即放行」改为 fail-closed（拒绝）。
  - 将已实现但未接线的 `security.rate_limiter` 与 `security.validate_input` 接入 `server.build_server`。
- **ingest 批量路径 fail-closed（数据完整性）**
  - `ingest.service.ts` 批量预检（entity/raw_ref）由 fail-open（吞异常继续）改为 fail-closed（与单帧路径一致）。
- **字段与时区一致性（正确性）**
  - 电池字段统一为 `battery_pct`（`routes/health.py`、`inference/rules.py` 现误读 `battery_level`/`battery_percent`）。
  - 证据窗口时间戳口径统一（`services.parse_ts`/`iso` 本地 vs `inference.ts_to_ms/ms_to_ts` UTC）。
- **OEE 指标真实化（正确性）**
  - `computeOee` 由 `outputQty`/`idealRatePerSec` 计算 performance，修正 OEE = A×P×Q。
- **事实源收敛（治理）**
  - 受管表口径以 `schema-manifest.yaml` 为唯一事实源，消除 `run_migrations.js`/`001_verify.sql` 硬编码 51 与 manifest 57 的漂移。
  - Mobile/MES 端点去重、Nest 世界状态双源收敛、ERP 绕过 MES 双写收敛。
- **死代码清理**
  - 移除 `StateMachineGuard`/`@StateMachine` 无引用死代码与手写状态表重复。
- **边缘能力孤岛终态化**
  - 核实 `world_model/scenario/aas/twin/policy/connectors/collection` 接线状态，未接线的给出终态裁决。
- **不引入 BREAKING 变更**：不改 OpenAPI/状态机语义、DB 迁移 SQL、共享契约；仅修配置/接线/失败语义/字段读取/死代码。

## Impact

- 影响规格：安全边界（边缘导出鉴权、限流、输入校验）、ingest 幂等语义、事实源引用。
- 影响代码：`deploy/docker-compose.yml`、`contracts/work/artifact-paths.json`、`tools/work-indexer/index.js`、`db/contracts/schema-manifest.yaml`、`src/edge_platform/routes/auth.py`、`src/edge_platform/security.py`、`src/edge_platform/server.py`、`ewoh-spark-app/server/modules/ingest/ingest.service.ts`。
- 影响契约：无（不改任何冻结契约语义）。

## 边界（不可违反）

1. 只修「明确、安全、可验证」的项；不改生产数据、不改 DB 迁移语义、不改 OpenAPI/状态机契约。
2. ingest 改为 fail-closed 后，批量路径在 DB 不可用时**拒绝写入并记日志**，不静默放行（与单帧一致）。
3. 边缘鉴权 fail-closed 后，无有效 token 的导出请求返回 401/403，不泄露原始遥测。
4. 所有改动需通过：Python pytest、`tsc -b --force`、`openapi:no-drift`、相关 truth/audit 门禁。

## ADDED Requirements

### Requirement: 事实源引用一致性
系统 SHALL 消除指向不存在文件的契约/工具引用，并移除将 SQLite 旧 schema 挂载进 PostgreSQL 的功能性错误。

#### Scenario: 引用可解析
- **WHEN** 审计发现 `artifact-paths.json` / `work-indexer` 引用 `authoritative-plan-final6.txt`、`schema-manifest.yaml` 引用 `.codex/artifacts/contracts/*.md` 均不存在
- **THEN** 引用改为实际存在的文件或移除，work-indexer 不再报 missing required artifact。

#### Scenario: 部署不挂旧 schema
- **WHEN** `docker-compose.yml` 将 SQLite 子集 schema 挂载到 PostgreSQL 初始化目录
- **THEN** 移除该挂载（改用 `db/runner` 迁移链）。

### Requirement: 边缘导出鉴权 fail-closed
系统 SHALL 使生产模式下无有效 token 的原始遥测导出请求被拒绝。

#### Scenario: 防泄露
- **WHEN** 无 token 或会话无效时请求 `GET /api/telemetry/export`
- **THEN** `enforce_export_role` 返回 False（拒绝），而非放行。

### Requirement: 限流与输入校验接入运行时
系统 SHALL 将已实现的 `rate_limiter` 与 `validate_input` 接入 HTTP 服务运行时。

#### Scenario: 生效
- **WHEN** 生产模式启动 HTTP 服务
- **THEN** 请求经过限流与输入校验（而非仅 `SecurityHeaders`）。

### Requirement: ingest 批量路径 fail-closed
系统 SHALL 使 ingest 批量预检（entity/raw_ref）在 DB 失败时显式拒绝并记日志，与单帧路径一致。

#### Scenario: 数据完整性
- **WHEN** 批量 entity/raw_ref 预检因 DB 失败而无法判定
- **THEN** 拒绝写入并记录日志（fail-closed），不吞异常继续写重复/脏数据。

## MODIFIED Requirements

### Requirement: 单帧 ingest fail-closed（保持）
单帧 `processOneFrame` 的 entity/raw_ref fail-closed 语义保持；本规格仅把批量路径对齐到同一语义。

## REMOVED Requirements

### Requirement: 无
**Reason**: 无移除项。
**Migration**: 无。

## 已裁决项（终态，不保留「后续建议」）

- **Mobile/MES 端点**：Mobile 是 worker/device_ops 视角的薄 facade，业务逻辑全部委托 `MesService`（唯一事实源），无逻辑重复；已在 `mobile.controller.ts` 标注非权威地位，保留 worker 视角入口，不删除（客户端 `client/src/api/mobile.ts` 依赖）。
- **Nest 世界状态**：领域事实源为 `ewohWorldState` + 业务表；`WorldService`（UI）与 `WorldStateSnapshotService`（调度）作为同源只读投影。游离表 `ewoh_world_snapshot`/`ewoh_world_delta_log`/`ewoh_snapshot_version_counter` 已纳入 Drizzle schema（声明与迁移 SQL 一致）；`world-cursor.service.ts` 保持原生 SQL 游标协议（其单测深度 mock `db.execute`，改用 schema 对象会破坏测试，故保留原生 SQL，声明与读写分离）。
- **`StateMachineGuard`/`@StateMachine`**：确认为零生产引用的死代码，已删除定义文件与单测；`nextXxxStatus` 手写状态表是真实生效机制，保留。
- **ERP 双写**：已抽取 `MesService.writeScheduleOrder` 作为 `ewohScheduleTask*` 唯一写路径，ERP 复用（保留 `source='erp'` 与 ERP 专属 description），消除直写。
- **边缘能力孤岛（`world_model/scenario/aas/twin/policy/connectors/collection`）**：均无生产接线，但属「SDK/库 + WIP」且被 `tests/` 与 `scripts/*-tck.py` 引用，非垃圾；裁决为**保留**，不删除（删除将破坏现有测试/脚本）。其中 `scenario` 与 `services.evaluate_scenario` 存在两套评估器，`connectors` 与 `edge/adapters` 存在双轨连接器层，均记为既有边界、不强行重构。

