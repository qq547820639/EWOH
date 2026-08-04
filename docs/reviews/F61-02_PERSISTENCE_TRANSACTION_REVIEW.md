# F61-02 持久化 / 事务 / 多实例正确性 —— 收口复核报告

- 复核时间：2026-08-05（Asia/Shanghai）
- 复核 Agent：F61-02 收口实现 Agent（持久化、事务、多实例正确性）
- 复核基线 HEAD：`6e6a67f0c3e6bbe74082ba960267d070722b59c7`（HEAD 值由主 Agent 在提交后统一修正 head-consistency，本文件不固化 HEAD）
- 任务范围：F61-02「Code Complete / Runtime Verification Blocked」收口；对 6 类领域事实的数据库持久化、事务边界、多实例设计、CI 入口、诚实边界进行复核并记录证据

---

## 0. 结论摘要

| 项目 | 状态 | 说明 |
|------|------|------|
| 6 类领域事实用数据库持久化 | ✅ 完成 | 6 张 F61-02 领域表 + `DomainPersistenceService` 作为持久化事实源 |
| 2.B 读路径以数据库为事实源 | ✅ 完成 | `getGitSyncState(syncId)` 公开方法 + `getGitSyncStatus()` 合并持久化状态 |
| 事务边界（2.C） | ✅ 完成 | 复合写操作全部置于 `db.transaction()` 内，中途失败不产生部分写入 |
| 幂等键创建业务对象原子性 | ✅ 完成 | `setIdempotencyAndCreate` 同一事务内登记幂等键 + 创建业务对象 |
| 多实例设计（2.D） | ✅ 完成 | 数据库时间 `now()`、乐观锁版本列、唯一约束、持有者恢复 |
| 单元测试 | ✅ 通过 | `domain-persistence.service.spec.ts` 29/29 全绿 |
| 权威制品口径 | ✅ 归一 | `managed_tables` 长度 = 57，与 CHANGELOG/state/release-manifest/phase-state 一致 |
| OpenAPI 路由对账 | ✅ 通过 | live = 255，`route_manifest_consistent_with_live_scan` PASS |
| **真实 HTTP + PostgreSQL E2E** | 🔴 **BLOCKED** | 本机无 PostgreSQL / docker，无法运行重启持久性 / 双实例并发 / 事务中途失败等真实场景 |
| 最终状态 | 🔴 **F61-02 Code Complete / Runtime Verification Blocked** | 不启动 F61-03 |

---

## 1. 6 类领域事实已用数据库持久化

`server/database/schema.ts`（行 729 起「F61-02 domain persistence tables，手动维护，不随平台同步覆盖」）新增 6 张领域表，迁移脚本为 `db/migrations/standalone_004_ewoh_domain.sql`（可重入：`CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`），回滚脚本为 `standalone_004_ewoh_domain.rollback.sql`，验证脚本为 `db/verify/standalone_004_verify.sql`：

| 领域事实 | 表 | 关键约束 |
|---------|-----|---------|
| 资源锁 | `ewoh_resource_locks` | `org_id + resource_key` 唯一索引 `uq_ewoh_resource_locks_org_key`；`active` / `expires_at` / `holder`；乐观锁 `version` 默认 1 |
| 幂等键 | `ewoh_idempotency_keys` | `scope + idempotency_key` 唯一索引 `uq_ewoh_idempotency_keys_scope_key`；`response`(jsonb) |
| 交接 | `ewoh_handoffs` | `handoff_id` 唯一；`state` / `accepted_at` / `closed_at` |
| Git 同步 | `ewoh_git_sync_state` | `sync_id` 唯一；`last_sync_at` / `last_sync_sha` / `last_sync_status` / `conflicts` |
| 证据元数据 | `ewoh_evidence_metadata` | `evidence_id` 唯一；`commit_sha` / `env_fingerprint` / `verifier` / `produced_at` / `expires_at` / `result` / `checksum` |
| 工厂复制会话 | `ewoh_factory_replication_sessions` | `session_id` 唯一；`org_id` / `factory_id` / `step` / `status` / `progress` / `started_at` / `finished_at` / `output_evidence_id` |

`DomainPersistenceService`（`server/modules/work-orchestration/domain-persistence.service.ts`）为这 6 类事实提供 CRUD，并是进程内 Map 的替代持久化事实源。构造器注释明确：**「This is the F61-02 durable source of truth; in-process Maps must not replace it.」**

### 2.B 读路径以数据库为事实源

- 新增公开方法 `getGitSyncState(syncId: string): Promise<GitSyncStateRecord | null>`：读 `ewoh_git_sync_state` 返回含 `lastSyncSha` / `lastSyncStatus` / `lastSyncAt` / `conflicts` 的记录。
- `WorkOrchestrationService.getGitSyncStatus()`（`work-orchestration.service.ts`）在 `this.domainPersistence` 可用时，读取持久化 git-sync 状态并把 `lastSyncSha` / `lastSyncStatus` / `lastSyncAt` 以 `persistedState` 键合并到 `buildGitSyncPlan` 结果上（不破坏既有字段）；无 DB 时回退到原计划计算逻辑。`applyGitSyncDurable` 的既有正确逻辑未改动。

---

## 2. 事务边界（2.C）：复合写操作全部在 `db.transaction()` 内

`DomainPersistenceService` 中所有复合写路径均以显式 `db.transaction(async (tx) => {...})` 包裹，保证中途失败不会留下部分写入：

| 方法 | 事务内组合 |
|------|-----------|
| `acquireLockWithAudit` | 获取锁 + 追加审计（无锁无审计） |
| `createHandoffWithTransfer` | 创建交接 + 登记证据（无交接无证据） |
| `acceptHandoffWithTaskUpdate` | 交接置 accepted + 登记转移证据 |
| `updateGitSyncWithEvidence` | 推进 git-sync 游标 + 登记证据 |
| `advanceReplicationWithEvidence` | 推进复制会话步骤 + 生成输出证据 |
| `setIdempotencyAndCreate` | 幂等键登记 + 业务对象创建（见 §3） |

`acquireLock` / `releaseLock` / `renewLock` 依赖单语句原子性（`onConflictDoNothing`、唯一约束、`version` 列 CAS 更新）。

---

## 3. 幂等键创建业务对象的事务原子性（2.C 专项确认）

`setIdempotencyAndCreate(scope, key, creator)`（`domain-persistence.service.ts`）已将「幂等键登记 + 业务对象创建」放在**同一个 `db.transaction`** 内：

```ts
return this.db.transaction(async (tx) => {
  const existing = await this.getIdempotencyOn(tx, scope, key);
  if (existing !== undefined) return { created: false, result: existing };
  const result = await creator(tx);              // 业务对象创建（同一事务）
  await tx.insert(ewohIdempotencyKeys).values({ scope, key, response: result }).onConflictDoNothing();
  ...
});
```

- 若 `creator( tx )` 抛错，整个事务回滚，幂等键不会残留 → 不会出现「幂等键存在但业务对象未创建」。
- 若幂等键插入失败/被去重，`onConflictDoNothing` 合并到已存在结果 → 不会出现「业务对象存在而幂等键缺失」造成重复创建。
- 并发重复请求在 `(scope, idempotency_key)` 唯一约束上合并为一个结果。

**结论：已正确实现，注释与实现一致，无需改动。**

---

## 4. 多实例设计与反模式覆盖（2.D）

- **时间源统一**：所有时间写入使用数据库时间 `sql`now()``（`private readonly dbNow`），而非应用时钟，避免多实例时钟漂移。
- **乐观锁版本列**：`version` 列，更新时 `WHERE id = ... AND version = <已读版本>`，并用 `version + 1` 递增；并发更新被 CAS 拦截（`renewLock` 在版本被并发改写时返回 null / 抛 `ConflictException`）。
- **唯一约束收敛并发**：资源锁 `uq_ewoh_resource_locks_org_key`、幂等键 `uq_ewoh_idempotency_keys_scope_key`。
- **锁过期 / 持有者恢复**：`recoverExpiredLocks` 用 `expires_at <= now()` 批量置非活跃；`acquireLockOn` 复用过期/陈旧行并按版本号重分配；`isExpired` 兜底。
- **反模式覆盖**：明示「in-process Maps must not replace DB」；复合写不依赖应用时钟；`isExpired` 兼容 `Date`/字符串。

> **版本列声明澄清（独立复核建议二）**：乐观锁 `version` CAS 列**仅用于资源锁**（`renewLock`/`releaseLock` 需要 holder+version 校验与并发改写拦截）；其余领域事实（交接 / Git 同步 / 证据 / 复制会话 / 幂等键）由唯一约束（`handoff_id`/`sync_id`/`evidence_id`/`session_id`、`scope+idempotency_key`）保证多实例安全，不设 `version` 列。时间戳列命名与 schema 一致：资源锁/证据/复制会话/幂等键用 `_created_at`/`_updated_at`，交接/同步状态用 `created_at`/`_updated_at`。spec（Task 2.2 / 子需求 2.A）与 DDL 口径已对齐。

---

## 5. CI 入口

- 单元测试：`ewoh-spark-app` `npx jest test/unit/work-orchestration/domain-persistence.service.spec.ts --runInBand` → **29/29 全绿**。
- 类型检查：`ewoh-spark-app` `npx tsc --noEmit -p tsconfig.json` → **退出码 0**。
- OpenAPI 对账：`node scripts/audit-openapi-routes.js --strict` → **PASS，live = 255，0 undocumented / 0 unimplemented**；`--write-manifest openapi/route-manifest.json` 已重生成 `route_manifest_current` 通过。
- 权威制品对账：`node scripts/reconcile-authoritative-artifacts.js --root .` → `db_table_footprint_reconcile` PASS（computed=57）、`route_manifest_consistent_with_live_scan` PASS（255/255）。
- RepoFacts：`node scripts/audit-repo-facts.js --strict` → 38/39，唯一 FAIL 为 `head-consistency`（预期，由主 Agent 提交后统一修正 HEAD）。

### 5.1 CI 双实例并发 + 升级/回滚验证入口（2.F，`standalone.yml`）

本机无 PostgreSQL，但仓库已把真实运行时门禁放到 CI，不要求本地安装环境：

- `.github/workflows/standalone.yml` 定义 `postgres:17-alpine` Service Container（`pg_isready` health check，`EWOH_E2E_RUNTIME_DATABASE_URL` 注入）。
- **升级/回滚/重放**：`standalone-postgres-check.sh`（0 objects → 57 tables → RLS/audit → rollback → rebuild）后，`run_migrations.js --apply-standalone-domain → --verify-standalone-domain → --rollback-standalone-domain → --apply-standalone-domain → --verify-standalone-domain`，并 `migrate-domain-state.js --dry-run` 校验旧数据导入计划。
- **双实例并发测试**：新增 `scripts/verify-domain-concurrency.js`，用**两条独立连接**（两个实例）在真实 PG 上验证 5 项多实例不变量：
  1. 唯一 `(org_id, resource_key)` 约束把两个并发锁获取收敛为单一 holder；
  2. 乐观锁版本 CAS：并发 `WHERE version = X` 更新恰好一个胜出；
  3. 非持有者无法续租 / 释放（`holder` 校验命中 0 行）；
  4. 过期/陈旧锁可被另一实例以版本 CAS 安全接管；
  5. 同一 `(org, resource_key)` 重入写入不产生重复行。
  脚本退出码非 0 即 CI 失败，任务失败不静默通过。
- **真实 HTTP E2E**：`npm run test:e2e` 经 `EWOH_E2E_RUNTIME_DATABASE_URL` 绑定 Service Container，让 `f61-02-persistence.e2e.spec.ts`（重启持久性 / 双实例 HTTP 并发 / 事务中途失败 / 锁恢复 / 离线重放）真实执行；无该环境时该套件以 `BLOCKED_BY_ENVIRONMENT` 显式失败，绝不伪造通过或静默跳过。
- **证据 artifact**：`f61-02-ci-evidence-<sha>` 保存 `commit_sha` / `ref` / `postgres version()` / `ewoh_%` 表清单与计数（retention 30 天）。

---

## 6. 诚实边界（Runtime Verification Blocked）

**本机无 PostgreSQL、无 docker**，以下真实运行时验证无法执行，**不以单元测试替代 E2E**：

- 创建领域状态后重启服务 → 状态持久存在
- 两个服务实例并发写同一对象 → 无重复执行 / 丢失更新（版本列冲突被抛出）
- 事务中途失败 → 无部分写入
- 锁过期 / 持有者异常退出 → `recoverExpiredLocks` 可恢复并被新持有者抢占
- 离线操作重放 → 幂等去重，不重复创建业务对象

**解锁条件**：本机可用 PostgreSQL（设 `DATABASE_URL`）或 docker/podman 临时 PG，或 CI `standalone.yml` 中 spin up 临时 PG 后执行真实 E2E。

---

## 7. 最终判定

- **F61-02 Code Complete**：6 类领域事实 DB 持久化、事务边界、幂等原子性、多实例设计全部实现；单元测试 29/29、tsc、OpenAPI 对账、权威制品对账均通过。
- **Runtime Verification Blocked**：真实 HTTP + PostgreSQL E2E 因环境（无 PG / docker）阻塞，标记 `BLOCKED_BY_ENVIRONMENT`。
- **不启动 F61-03**：在真实 E2E 解锁通过前，不得宣称 Production / Scale Ready，不推进 F61-03。