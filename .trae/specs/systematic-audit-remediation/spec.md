# [systematic-audit-remediation] 全仓系统走读与整改 Spec

## Why

对 EWOH 仓库（Python 边缘平台 / NestJS 云侧 / 契约·DB·部署·工具·飞书侧车）做分域系统性走读后，确认整体架构分层清晰、事实源治理意识强、调度域工程质量高，但存在约 40 处代码质量问题，集中表现为三类：**安全 fail-open**（生产路径未认证/未限流/未校验、ingest 批量吞异常）、**事实源与引用断裂**（受管表 51/57 口径冲突、SQLite 旧 schema 挂进 PostgreSQL、指向不存在文件）、**死代码/重复实现/双写/god-file**。本规格收敛其中可安全、可验证的高优先级项，并记录其余项作为后续建议。

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
- **不引入 BREAKING 变更**：不改 OpenAPI/状态机语义、DB 迁移 SQL、共享契约；仅修配置/接线/失败语义。

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
