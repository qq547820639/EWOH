-- ewoh_agent_approval decision_json 列（standalone_052, ADR-059 / NO-13j / §11/§12/§18）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS（幂等可重复执行）。
--
-- 背景（ADR-059，Decision Catalog kind #3 agent_approval 接线）：
--   Agent 命令审批解析（approved/rejected/expired）是真实的人审/策略决策事实
--   （ADR-039 台账 = 唯一权威源），必须以 ADR-047 契约形态 DecisionRecord 留痕
--   （decision_json 列；resolveRow 唯一权威写路径与解析终态同事务原子写入）。
--   §12 Decision History 自此覆盖 Agent 审批决策；旧行 NULL = 未投影（读回兼容，
--   additive）。既有受管表原地加固：managed_count/physical_create_count 不变
--   （74/77）。投影缺口/契约门失败 → 服务层 log 显式 + 留 NULL（§33 绝不静默
--   丢弃、绝不伪造；绝不阻断审批主流程 §2）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_agent_approval
  ADD COLUMN IF NOT EXISTS decision_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_approval.decision_json IS
  'Canonical DecisionRecord（ADR-047 契约形态 kind=agent_approval；ADR-059 resolveRow 唯一权威写路径，与解析终态同事务；决策历史单一事实源，§12/§18；NULL=存量未投影行）';
