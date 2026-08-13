# Tasks — Scheduler Phase 1 实体感知的触发冷却去抖

> 原则：先核验现状 → 修冷却去抖实体维度 → 补回归测试 → 回归。改动最小、行为语义精确。

- [x] Task 1: 冷却去抖查询实体感知化（`trigger.service.ts`）
  - [x] 1.1 在 `evaluate` 的冷却去抖 `WHERE` 中追加 `eq(ewohReplanTrigger.entityId, entityId ?? 'ALL')`，使去抖粒度与 `triggerKey` 的 entityId 维度一致。
  - [x] 1.2 保持幂等去重（`triggerKey`）与无实体退化语义不变（`entityId=null` → `'ALL'`）。
  - [x] 验证：`tsc -b --force` 通过。

- [x] Task 2: 新增回归测试（验证三种语义）
  - [x] 2.1 同实体同类型窗口内 → 去抖（`evaluate` 返回 null）。
  - [x] 2.2 不同实体同类型窗口内 → 不去抖（各自返回非 null run）。
  - [x] 2.3 无实体（`entityId=null`）→ 仍按 orgId+triggerType 去抖（退化为现状）。
  - [x] 验证：新增测试套件 `trigger-entity-cooldown.spec.ts` 3/3 全绿。

- [x] Task 3: 回归 + 契约 + 提交
  - [x] 3.1 scheduler jest 全量 93 套件/731 tests；`tsc -b --force` 0 错误；`npm run openapi:no-drift` 通过。
  - [x] 3.2 eslint 对改动文件 0 输出。
  - [x] 3.3 提交并推送 `main`。

# Task Dependencies

- [Task 2] 依赖 [Task 1]。
- [Task 3] 依赖全部。
