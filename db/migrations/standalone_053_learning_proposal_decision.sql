-- ewoh_learning_proposal decision_json 列（standalone_053, ADR-063 / NO-13n / §10/§12/§18）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（ADR-063，Decision Catalog kind #7 learning_proposal_activation 接线）：
--   学习提案激活/拒绝/回滚（ADR-026 台账 = 唯一权威源）是真实人审决策事实，
--   必须以 ADR-047 契约形态 DecisionRecord 留痕（decision_json 列；
--   approve/reject/rollback 与状态终态同一 UPDATE 语句原子写入）。
--   §12 Decision History 自此覆盖学习提案激活决策；旧行 NULL = 未投影
--   （读回兼容，additive）。既有受管表原地加固：managed_count/
--   physical_create_count 不变（74/77）。投影缺口/契约门失败 → 服务层
--   log 显式 + 留 NULL（§33 绝不静默丢弃、绝不伪造；绝不阻断提案主流程 §2）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal
  ADD COLUMN IF NOT EXISTS decision_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_proposal.decision_json IS
  'Canonical DecisionRecord（ADR-047 契约形态 kind=learning_proposal_activation；ADR-063 approve/reject/rollback 与状态终态同 UPDATE 原子写入；决策历史单一事实源，§12/§18；NULL=存量未投影行）';
