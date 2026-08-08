# Week 3 — World State / Ingest / CommandMap / ResourceProjection

## Finding: P1-WORLD-001 优化 Current World State 查询

- **Old Evidence**：`world.service.ts getCurrentState` 将 `ewoh_world_state` 全表
  拉入 Node，用 Map 去重取最新（O(全表)）。
- **Fix**：改用 PostgreSQL `DISTINCT ON(entity_id)` + `ORDER BY entity_id, ts DESC`，
  最新状态在数据库内完成（O(实体数)，非 O(全表)）。
- **Tests**：client/server typecheck；依赖既有 world 测试 + 全量 scheduler 测试。

## Finding: P1-INGEST-001 优化 Batch Ingest

- **Old Evidence**：`ingestExoskeletonBatch` `for frame: await processOneFrame()`，
  每帧 ≥3 次 DB 往返（entity 查询 + raw_ref 查询 + insert + upsert device）。
- **Fix**：批量路径改为
  1. 批量 entity 存在性查询（一次 IN）；
  2. 批量 raw_ref 幂等查询（一次 IN）；
  3. 纯计算映射（mapExoskeletonRow / mapDeviceRow）；
  4. 批量 insert telemetry（一次 INSERT ... VALUES）；
  5. 批量 upsert devices（一次）；
  6. 逐帧规则评估（RuleEngine 写事件，保留逐条语义）。
  每帧 DB 往返从 ~3 降到 ~1。
- **Tests**：`test/unit/ingest/ingest.service.spec.ts` 新增 4 个 batch 回归
  （批量 insert / 重复 raw_ref 跳过 / 时钟漂移 invalid / 部分无效 batch）。

## Finding: P1-CMAP-002 ResourceProjection SSOT

- **Old Evidence**：ResourceProjectionService 已实现且注册在 scheduler.module，
  但**未暴露 API**；前端 ResourcePoolPanel 用 `buildResourceItems(entities,
  worldState, deviceInfos)` 本地拼装资源状态。
- **Fix**：
  1. `SchedulerController` 新增 `GET /api/scheduler/resources/state` →
     `ResourceProjectionService.getUnifiedResourceState()`；
  2. 前端 `api/scheduler.ts` 新增 `getUnifiedResourceState`；queryKeys 新增
     `schedulerResourceState`；
  3. ResourcePoolPanel 读取权威投影，`buildResourceItems` 以 `ResourceState`
     覆盖 status/battery/load（本地仅保留 ViewModel 展示字段）。
- **OpenAPI**：ewoh.yaml 新增路径 + ResourceState schema；route audit 301/301 对齐。

## Finding: P1-CMAP-001 CommandMap 写链收敛

- **Verification**：正式调度写入链已是 V2（`replan` + SchedulingConstraint）；
  gamification `allocateResources` 已标注 @deprecated（仅 AI 评估展示，非授权写入）。
- **Conclusion**：写链已收敛到 Scheduler V2，无需进一步改动；记录确认。

## Finding: P1-CMAP-003 实时状态统一

- **Verification**：Scheduler SSE（sequence / gap detection / resync / poll fallback）
  保持不变；World State polling 保留；资源状态新端点 15s 刷新。
- **Conclusion**：不删除 polling fallback；三通道各自有明确职责与刷新策略。

## Phase Status

| Command | Exit Code | Result |
| ------- | --------: | ------ |
| `npx tsc --noEmit --project tsconfig.node.json` | 0 | passed |
| `npx tsc --noEmit --project tsconfig.app.json` | 0 | passed |
| `npx jest --config client/jest.config.cjs` | 0 | 81 suites / 640 tests |
| `npx jest --testPathPattern test/unit/ingest` | 0 | 13 passed |
| `npx jest --testPathPattern scheduler/__tests__/resource-state` | 0 | 6 passed |
| `node scripts/gen-openapi.js --check` | 0 | in sync |
| `node scripts/audit-openapi-routes.js` | 0 | 301/301, undocumented=0 |

## Remaining Risks
- `getCurrentState` 的 `DISTINCT ON` 依赖 PostgreSQL（本项目后端即 Postgres，满足）；
  SQLite（仅 Python edge 侧）不受影响。
- Ingest 批量规则评估仍逐条（RuleEngine 接口约束），如需进一步并发需评估
  RuleEngine 线程安全性（本期保持保守）。
