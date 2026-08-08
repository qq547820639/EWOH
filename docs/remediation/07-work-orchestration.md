# WorkOrchestration 职责分类与拆分评估（Phase G）

## 现状

`WorkOrchestrationService`（`server/modules/work-orchestration/work-orchestration.service.ts`，约 1549 行）
承载 64 个方法；`DomainPersistenceService`（864 行）承载 DB 持久化。两者已分离。
`tools/work-indexer`、`tools/gate-engine`、`tools/git-sync`、`tools/site-readiness` 为独立 CLI 模块，
server 通过 `createRequire` 加载复用（**无重复实现**，见下）。

## 方法 → 职责分类矩阵

| Method | Category | Dependencies | Side Effects |
| ------ | -------- | ------------ | ------------ |
| findArtifactsDir | Index | tools/work-indexer | 读目录 |
| indexWorkGraph | Index | tools/work-indexer | 读目录/fs |
| calculate | Gate | tools/gate-engine | 纯计算 |
| buildGitSyncPlan / gitInfo / liveApply | Sync | tools/git-sync | 读/写 fs |
| evaluateSiteReadiness | Index | tools/site-readiness | 纯计算 |
| getGraph | Query | indexer + fs | 读 |
| getOverview | Query | getGraph/getGates/currentPhase | 读 |
| getItems / getEvidence | Query | getGraph | 读 |
| getEvidenceContent | Query/Artifact | fs | 读文件 |
| getAgents / getGates / getRisks / getResources / getHandoffs | Query | getGraph | 读 |
| getResourcesDurable | Query | DomainPersistence | DB 读 |
| getGitSyncStatus / getCatalog | Query | fs | 读 |
| applyGitSync / applyGitSyncDurable | Sync/Mutation | git-sync + fs | **写 fs/DB** |
| acquireResource / releaseResource / renewResourceLock / recoverExpiredLocks | Mutation | locks Map + fs | **写锁** |
| acquireResourceDurable / releaseResourceDurable | Mutation | DomainPersistence | **DB 写** |
| createHandoff / updateHandoffStatus | Mutation | fs + DomainPersistence | **写** |
| createHandoffDurable / updateHandoffStatusDurable | Mutation | DomainPersistence | **DB 写** |
| registerEvidenceDurable | Evidence | DomainPersistence | **DB 写** |
| createReplicationSessionDurable / advanceReplicationDurable | Mutation | DomainPersistence | **DB 写** |
| recordGateDecision / recordGateDecisions / revokeGateDecision | Gate/Mutation | fs + loadGateDecisions | **写 fs** |
| getGateHistory / getBlockedReason / currentPhase | Gate/Query | gateEngine + fs | 读 |
| loadGateDecisions / loadGateHistory | Gate/Private | fs | 读 |
| appendGateDecisionHistory / appendGateHistory | Gate/Private | fs | **写 fs** |
| isEvidenceStale | Query | fs | 读 |
| loadGitSyncRegistry / loadGitSyncApply / recordGitSyncApply | Sync/Private | fs | 读/写 |
| loadLockFile / writeLockFile / deleteLockFile / assertWritable | Mutation/Private | fs | **写 fs** |
| isLockExpired / releaseExpiredLock | Mutation/Private | locks Map | **写** |
| isWritable / artifactsDir / repoRoot | Query/Private | env/fs | 读 |

## work-core 必要性评估

**结论：不需要创建 `@ewoh/work-core`。**

- server 通过 `createRequire(join(toolsDir, 'work-indexer', 'index.js'))` 等**直接复用**
  `tools/work-indexer|gate-engine|git-sync|site-readiness`，不存在 parser/schema/invariant/
  gate logic 的三处重复。
- 用户要求"先用具体重复代码证明必要性"——无重复证据，故不创建新 package。

## 拆分策略评估

### 可安全拆分：Query 纯读方法
`getGraph/getOverview/getItems/getEvidence/getAgents/getGates/getRisks/getResources/
getHandoffs/getCatalog` 等读方法可抽到 `WorkQueryService`。

### 评估结论（本迭代）

**状态：DEFERRED（结构性）**

原因：
1. 64 个方法高度内聚，共享私有 helpers（`artifactsDir/repoRoot/assertWritable/
   loadGateDecisions` 等）、fs 访问、懒加载工具模块。
2. `work-orchestration.service.spec.ts`（81 个测试）直接针对 `WorkOrchestrationService`
   全部方法；拆分需迁移共享 helper 并重写测试引用，回归风险高于收益。
3. 上一轮已完成的 DomainPersistence 分离已消除"DB 持久化 vs 查询"的最大耦合。

依赖：
- 需要一次独立 refactor 迭代：先抽 `WorkQueryService`（纯读），逐步迁移 helper，
  每步 tsc + jest 全绿才继续。
- 需要为 Gate/Handoff/Lock 子域补充独立单元测试集（当前仅有 service 级测试）。

临时风险控制：
- 现有 81 个测试持续保护行为（已验证通过）。
- 职责矩阵本文档跟踪；后续迭代按 Query → Gate → Handoff → Lock 顺序渐进拆分，
  保持 Controller API 不变。

## 验证

| Command | Exit | Result |
| ------- | ----: | ------ |
| `npx jest --testPathPattern 'work-orchestration'` | 0 | 8 suites / 81 tests passed |
