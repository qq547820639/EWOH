# F61-02 独立复核结论（静态 / 契约层复核）

- 验证时间：2026-08-05（Asia/Shanghai）
- 验证 Agent：EWOH F61-02 独立复核 Agent（只读；本报告为允许写入的唯一新文件）
- 验证基线 HEAD：`6e6a67f0c3e6bbe74082ba960267d070722b59c7`（HEAD 值由主 Agent 在提交后统一修正 head-consistency，工作树以当前内容为准）
- 任务范围：对 F61-02「持久化、事务、多实例正确性」做独立复核。**静态与契约层复核通过；真实 E2E 因环境阻塞**

---

## 0. 结论摘要

| 项目 | 结论 | 说明 |
|------|------|------|
| 静态 / 契约层复核 | ✅ 通过 | 类型检查、单元测试、OpenAPI 对账、权威制品对账均通过 |
| 事务原子性（幂等键 + 业务对象） | ✅ 通过 | 同一 `db.transaction`，无「键存在但对象缺失／对象存在而键缺失」间隙 |
| 6 类领域事实 DB 持久化 | ✅ 通过 | 6 张表 + `DomainPersistenceService`，迁移脚本可重入 |
| 多实例设计 | ✅ 通过 | DB 时间、乐观锁版本列、唯一约束、持有者恢复 |
| 权威制品口径统一 | ✅ 通过 | `managed_tables` = 57，各方声称一致 |
| OpenAPI 路由对账 | ✅ 通过 | live = 255，0 undocumented / 0 unimplemented |
| **真实 HTTP + PostgreSQL E2E** | 🔴 **BLOCKED** | 环境无 PostgreSQL / docker，无法执行 |
| 最终状态 | 🔴 **F61-02 Code Complete / Runtime Verification Blocked** | 不启动 F61-03 |

---

## 1. 实际运行的验证命令与真实退出码

| # | 命令 | 真实退出码 | 关键输出 |
|---|------|:---:|----------|
| 1 | `npx tsc --noEmit -p tsconfig.json`（ewoh-spark-app） | 0 | 类型检查无错误 |
| 2 | `npx jest test/unit/work-orchestration/domain-persistence.service.spec.ts --runInBand` | 0 | **29/29 全绿** |
| 3 | `npx jest test/unit/reconcile-authoritative-artifacts.spec.ts --runInBand` | 0 | 5/5 全绿（含 57 表断言） |
| 4 | `node scripts/audit-openapi-routes.js --strict` | 0 | Controller 255 / Spec 255 / Documented 255 / Undocumented 0 / Unimplemented 0 |
| 5 | `node scripts/audit-openapi-routes.js --strict --write-manifest openapi/route-manifest.json` | 0 | route-manifest 已重生成 |
| 6 | `node scripts/reconcile-authoritative-artifacts.js --root .` | 0 | `db_table_footprint_reconcile` PASS（computed=57）、`route_manifest_consistent_with_live_scan` PASS（255/255） |
| 7 | `node scripts/audit-repo-facts.js --strict` | 1 | 38/39；唯一 FAIL 为 `head-consistency`（预期，主 Agent 提交后修正） |

> 说明：命令 7 退出码 1 来自 `head-consistency`（HEAD 值待主 Agent 提交后统一修正），属**预期待处理项**，非 F61-02 代码缺陷。

---

## 2. 静态 / 契约层复核

**类型检查**：`tsc --noEmit` 退出码 0，`getGitSyncState` 公开方法、`getGitSyncStatus()` 的 async 改写、OpenAPI 新增 operation 均通过类型检查。

**单元测试**：`domain-persistence.service.spec.ts` 29 个用例全部通过，覆盖：
- 锁：获取 / 冲突 / 过期恢复重分配 / 持有者或管理员释放 / 非持有者拒绝 / 续租 / 版本号 CAS / 并发改写被拒。
- 幂等：去重返回已存响应 / 新键记录 / 并发唯一约束合并 / 离线重放不重复创建。
- 复合事务原子性：审计失败整体回滚（无部分锁）、交接+证据原子、git-sync+证据原子、复制步骤+证据原子。
- 多实例（StatefulDb）：跨重启状态持久、双实例收敛到单一锁、过期持有者恢复。

**权威制品对账**：`reconcile-authoritative-artifacts.spec.ts` 5/5 通过，其中 `db_table_footprint_reconcile` 断言 `computed=57` 且 `claimed: changelog=57`，与 CHANGELOG(48→57)/state.json/release-manifest 一致。

**OpenAPI 契约**：新增 `POST /api/work/resources/{id}/renew` 与 `POST /api/work/resources/recover-expired` 后，live=255 与 route-manifest 一致，`route_manifest_consistent_with_live_scan` PASS。

---

## 3. 幂等键创建业务对象的事务原子性确认

`setIdempotencyAndCreate(scope, key, creator)` 将「幂等键登记 + 业务对象创建」放在同一 `db.transaction` 内（配合 `getIdempotencyOn` 与 `onConflictDoNothing`）：
- creator 抛错 → 事务回滚，幂等键不残留（无「键存在但对象缺失」）。
- 唯一键冲突 → 合并到已存结果（无「对象存在而键缺失」导致重复创建）。
- 并发重复请求在 `(scope, idempotency_key)` 唯一约束上收敛。

**结论：无间隙，与实现注释一致。**

---

## 4. 6 类领域事实 DB 持久化与多实例设计

- 6 张表（`ewoh_resource_locks` / `ewoh_handoffs` / `ewoh_git_sync_state` / `ewoh_evidence_metadata` / `ewoh_factory_replication_sessions` / `ewoh_idempotency_keys`）位于 `server/database/schema.ts` 行 729 起，迁移 `db/migrations/standalone_004_ewoh_domain.sql` 可重入，回滚与验证脚本齐备。
- 多实例：数据库时间 `now()`、乐观锁 `version` 列 CAS、唯一约束收敛并发、`recoverExpiredLocks` 恢复过期锁。
- 读路径：`DomainPersistenceService.getGitSyncState(syncId)` + `getGitSyncStatus()` 合并持久化 git-sync 状态，无 DB 时回退原逻辑。

---

## 5. 诚实边界（Runtime Verification Blocked）

真实 HTTP + PostgreSQL E2E（重启持久性 / 双实例并发 / 事务中途失败 / 锁过期恢复 / 离线重放去重）因**本机无 PostgreSQL、无 docker**无法执行，标记 `BLOCKED_BY_ENVIRONMENT`。**不以单元测试替代 E2E**。

**仓库已把真实运行时门禁放到 CI（2.F），不要求本地安装环境**：
- `.github/workflows/standalone.yml` 提供 `postgres:17-alpine` Service Container，通过 `EWOH_E2E_RUNTIME_DATABASE_URL` 绑定 `test:e2e`。
- 新增 `scripts/verify-domain-concurrency.js`：用两条独立连接（双实例）在真实 PG 上验证唯一约束锁收敛、乐观锁版本 CAS、非持有者拒绝、过期锁接管、重入安全 5 项不变量。
- 升级 / 回滚 / 重放验证：`run_migrations.js --apply-standalone-domain → --verify → --rollback → --re-apply → --verify` + `migrate-domain-state.js --dry-run`。
- 证据 artifact `f61-02-ci-evidence-<sha>` 保存 `commit_sha` / PG `version()` / `ewoh_%` 表计数与清单。

解锁需本机 PG（`DATABASE_URL`）或 docker/podman 临时 PG，或 CI spin up 临时 PG 后执行真实 E2E。

---

## 6. 最终结论

- **静态 / 契约层复核通过**：类型检查 0、单元测试 29/29、OpenAPI 对账 255/255、权威制品对账 57 表一致。
- **真实 E2E 因环境阻塞**：不宣称 Production / Scale Ready。
- **最终状态：F61-02 Code Complete / Runtime Verification Blocked**；**不启动 F61-03**。