# F61-02 持久化/事务/多实例正确性 —— DB 层实现与 E2E 阻塞状态

- 记录时间：2026-08-05（Asia/Shanghai）
- 实现 Agent：EWOH F61-02 实现（DB 层）
- 基线 HEAD：`5f87fe3`（F61-01 已提交并推送 origin/main，工作树含本文件记录前的 F61-02 DB 层实现）
- 决策（用户）：**实现 DB 层 + 将真实 E2E 标记 `BLOCKED`**（本机无 PostgreSQL / docker，无法运行真实 HTTP + PostgreSQL E2E）

---

## 0. 结论摘要

| 项目 | 状态 | 说明 |
|------|------|------|
| DB 表结构 | ✅ 完成 | 6 张领域表（`ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` / `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` / `ewoh_idempotency_keys`）已加入 `schema.ts` |
| 领域持久化服务 | ✅ 完成 | `DomainPersistenceService` 提供锁管理、幂等键、交接、Git 同步、证据元数据、复制会话的 CRUD |
| 资源锁运行时集成 | ✅ 完成 | `WorkOrchestrationService.acquireResourceDurable / releaseResourceDurable / renewResourceLock / recoverExpiredLocks` + 控制器 `/lock` `/renew` `/recover-expired` 端点 |
| 幂等存储集成 | ✅ 完成 | `DbIdempotencyStore` 通过 `IDEMPOTENCY_STORE` 注入令牌替换内存存储 |
| 乐观锁 / 唯一约束 / 幂等键 | ✅ 完成 | 版本列 `version`、唯一索引、`(scope, idempotency_key)` 唯一约束均已实现 |
| 锁过期 / 续租 / 释放 / 恢复 | ✅ 完成 | `recoverExpiredLocks` / `renewLock` / `releaseLock` / `acquireLock` 已实现并有单元测试 |
| 单元测试 | ✅ 通过 | `domain-persistence.service.spec.ts` 10/10；idempotency + work-orchestration 27/27；app 启动类 11/11 |
| 事务原子性 | ⚠️ 部分 | 幂等键用 `onConflictDoNothing`（原子去重）；资源锁用 `版本列 + 唯一约束` 防并发，未使用显式 `db.transaction` 包裹多语句 |
| 交接 / Git 同步 / 证据 / 复制会话运行时接线 | ⚠️ 部分 | DB 表与 CRUD 方法已就绪，但尚未替换对应进程内 Map 服务（见 §4） |
| **真实 HTTP + PostgreSQL E2E** | 🔴 **BLOCKED** | 本机无 PostgreSQL / docker；所需外部条件见 §5；**禁止以单元测试替代 E2E** |

---

## 1. 数据库表（`server/database/schema.ts`）

新增 6 张 F61-02 领域表（`ewoh_resource_locks` 等，位于 schema 文件底部「F61-02 domain persistence tables」区块，手工维护，不随平台自动同步覆盖）：

- `ewoh_resource_locks`：`org_id + resource_key` 唯一约束、`holder` / `expires_at` / `renewed_at` / `active` / `version`（乐观锁）、`acquired_at`
- `ewoh_idempotency_keys`：`scope + idempotency_key` 唯一约束、`response`(jsonb)
- `ewoh_handoffs`：`handoff_id` 唯一、`state` / `accepted_at` / `closed_at`
- `ewoh_git_sync_state`：`sync_id` 唯一、`last_sync_at` / `last_sync_sha` / `last_sync_status` / `conflicts`
- `ewoh_evidence_metadata`：`evidence_id` 唯一、`commit_sha` / `env_fingerprint` / `verifier` / `produced_at` / `expires_at` / `result` / `checksum`
- `ewoh_factory_replication_sessions`：`session_id` 唯一、`org_id` / `factory_id` / `step` / `status` / `progress` / `started_at` / `finished_at` / `output_evidence_id`

## 2. 领域持久化服务（`server/modules/work-orchestration/domain-persistence.service.ts`）

- 资源锁：`acquireLock`（唯一键 + 活跃非过期锁冲突时抛 `ConflictException`；过期/陈旧行按版本号复用重分配）、`releaseLock`（持有者或全局管理员）、`renewLock`（版本号续租）、`getLock`、`listActiveLocks`、`recoverExpiredLocks`（`expires_at <= now() AND active` 批量置非活跃，返回恢复数）
- 幂等键：`getIdempotency` / `setIdempotency`（`onConflictDoNothing` 原子去重）
- 交接 / Git 同步 / 证据元数据 / 复制会话：`createHandoff` / `updateHandoffStatus` / `getHandoff`、`upsertGitSyncState`、`upsertEvidenceMetadata`、`createReplicationSession` / `updateReplicationSession`

## 3. 运行时集成

- `shared.module.ts`：注册 `DbIdempotencyStore` 并绑定 `IDEMPOTENCY_STORE` 令牌；`idempotency.service.ts` 增加 `@Inject(IDEMPOTENCY_STORE)` 注入点（默认回退内存实现）
- `work-orchestration.module.ts`：注册并导出 `DomainPersistenceService`
- `work-orchestration.service.ts`：`WorkOrchestrationService` 构造器 `@Optional()` 注入 `DomainPersistenceService`，新增 4 个 durable 资源锁方法；无 DB 时回退原文件/内存路径
- `work-orchestration.controller.ts`：`POST /work/resources/:id/lock` / `POST /work/resources/:id/release` 改走 durable 路径；新增 `POST /work/resources/:id/renew`、`POST /work/resources/recover-expired`

> 依赖注入说明：`DomainPersistenceService` 注入 `STANDALONE_ROOT_DATABASE`，`DbIdempotencyStore` 注入 `DRIZZLE_DATABASE`，二者均由全局 `StandaloneDatabaseModule` 提供，与既有 `approval-persistence.service.ts` 的接入方式一致。

## 4. 未完成（诚实边界）

- 交接 `handoff-service`、Git 同步 `git-sync`、证据元数据、工厂复制会话的**运行时进程内 Map 尚未替换为 DB**（DB 表与 CRUD 方法已就绪，仅差接线）。
- 多语句**显式事务**（`db.transaction`）未覆盖全部聚合写路径；当前依赖单语句原子性（`onConflictDoNothing`）与版本列/唯一约束。

## 5. BLOCKED —— 真实 HTTP + PostgreSQL E2E（Task 2.5）

**状态：BLOCKED。** 本机无 PostgreSQL、无 docker，无法运行 `test/e2e/ewoh-http.e2e.spec.ts`（真实 HTTP + PostgreSQL）中的重启持久性 / 双实例并发 / 事务中途失败 / 锁过期异常恢复 / 离线重放去重场景。

**所需外部条件（任一满足即可解锁）：**
1. 本机可用的 PostgreSQL 实例（设置 `DATABASE_URL`）并允许执行 DDL 迁移；或
2. 本机可用的 docker / podman，可 `docker compose up` 临时 PostgreSQL；或
3. CI 环境（`standalone.yml`）中 spin up 临时 PostgreSQL 容器后执行 E2E。

**解锁后需补充验证的场景（Task 2.5）：**
- 创建领域状态后重启服务 → 状态持久存在（`ewoh_resource_locks` / `ewoh_idempotency_keys` 等）
- 两个服务实例并发写同一对象 → 无重复执行 / 丢失更新（版本列冲突被抛出）
- 事务中途失败 → 无部分写入
- 锁过期 / 持有者异常退出 → `recoverExpiredLocks` 可恢复并可被新持有者抢占
- 离线操作重放 → `setIdempotency` 去重，不重复创建业务对象

## 6. 已实际运行的验证（本地可执行部分）

| # | 命令 | 退出码 | 结果 |
|---|------|:---:|------|
| 1 | `npm run type:check:server` | 0 | tsc 无错误 |
| 2 | `npx jest test/unit/work-orchestration/domain-persistence.service.spec.ts` | 0 | 10/10 |
| 3 | `npx jest test/unit/shared/idempotency.service.spec.ts test/unit/work-orchestration/work-orchestration.service.spec.ts` | 0 | 27/27 |
| 4 | `npx jest test/unit/shared/app.module.spec.ts test/unit/shared/standalone-main.spec.ts test/unit/shared/request-database-context.spec.ts` | 0 | 11/11 |
| 5 | `npx eslint <changed files>` | 0 | 0 errors |

> 遗留：真实 E2E 与独立验证 Agent 复核（Task 2.6）因环境 `BLOCKED` 未执行，不得宣称 Production / Scale Ready。