-- EWOH 域表家族 RLS 护栏回滚 (standalone_098 配套)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 语义：撤销 standalone_098 的全部 DB 侧改动，回到「三表无 RLS、无 policy、
-- org_id 无 DEFAULT」的 standalone_004/019/057 终态。
--
-- 两个必须做对的点（审计 SQL-002 / SQL-008 的教训，别重犯）：
--   1) 只 DROP POLICY 不 DISABLE ROW LEVEL SECURITY 会把表留在
--      「RLS 已启用 + 无 policy」状态 —— PG 语义下等于对 service_role 全拒，
--      表现为运行时静默读空（不报错、数据悄悄变空），比不加护栏更难排查。
--      所以本回滚**必须**显式 DISABLE ROW LEVEL SECURITY。
--   2) ewoh_factory_replication_sessions.org_id 的 DEFAULT 与本迁移新增的
--      列注释也要一并撤销 —— 否则「列有 GUC DEFAULT」这一 098 才引入的语义
--      会跨回滚残留，让回滚后的行为与 standalone_004 终态不一致。
--      注意：098 对存量 NULL org_id 做了回填，回滚**不**把已回填的行改回 NULL
--      （那会丢失 org 血缘且无信息价值）；回滚只撤销结构，不撤销数据归位。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP POLICY IF EXISTS resource_locks_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_locks;
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_locks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS policy_replay_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_replay;
ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_replay DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS factory_replication_sessions_org_isolation ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions;
ALTER TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions DISABLE ROW LEVEL SECURITY;

ALTER TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions
  ALTER COLUMN org_id DROP DEFAULT;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_factory_replication_sessions.org_id IS NULL;
