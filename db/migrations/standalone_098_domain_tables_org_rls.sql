-- EWOH 2026-09-13 审计整改 — 域表家族 RLS 护栏补齐（WP-E / 审计 SQL-012）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ENABLE ROW LEVEL SECURITY / DROP POLICY IF EXISTS / CREATE POLICY /
--   UPDATE ... WHERE org_id IS NULL / ALTER COLUMN SET DEFAULT —— 全部幂等可重复执行。
--
-- 背景（docs/audit/2026-08-17-line-by-line-audit.md SQL-012）：
--   standalone_004 的 F61-02 域表家族（locks/handoffs/git_sync/evidence/
--   replication/idempotency）建表时只发 GRANT、不发 policy。其中
--   ewoh_resource_locks / ewoh_factory_replication_sessions 带 org_id 列却无
--   行级隔离；ewoh_policy_replay 在 standalone_057 被 SET NOT NULL、schema.ts
--   注释已写「RLS org 隔离」，但 policy 从未落地。
--   运行时角色 ewoh_api 是 NOBYPASSRLS 的 service_role 成员（standalone_003），
--   所以「表没有 RLS」= DB 层对全租户行可见可写，租户边界只剩应用层一条通道。
--   而这一族的调用方（domain-persistence.service.ts）恰好统一走
--   RequestDatabaseContext.systemTransaction —— 该 API 的既定语义正是
--   「无 GUC、专供无 RLS 表」（见其方法注释），因此它不构成第二层护栏，
--   而是本缺陷的直接来源：一旦某个调用方漏掉 org 谓词，DB 层没有任何兜底。
--
-- 逐表处置（按证据，不一刀切）：
--   · ewoh_resource_locks（org_id varchar(255) NOT NULL）：HTTP 调用方
--     work-orchestration acquireLock/releaseLock/renewLock/getLock/listActiveLocks/
--     recoverExpiredLocks，orgId 一律来自 requireActorOrgId(actor)（缺失即 400，
--     绝不回退 'default'）。租户域事实 → 补 RLS。
--   · ewoh_policy_replay（org_id NOT NULL，standalone_057 收紧）：调用方
--     scheduler/policy-replay.service.ts 走 DRIZZLE_DATABASE 租户代理并透传
--     ctx.primaryOrgId；manifest business_key 已是 (org_id, replay_id)。
--     租户域事实 → 补 RLS。
--   · ewoh_factory_replication_sessions（org_id 可空）：行本身带 org 血缘，
--     但读路径只按全局唯一的 session_id（audit-org-predicates.js:251 已把
--     updateReplicationSessionOn 登记为「跨工厂系统流程」）。仍然补 RLS，
--     并按 standalone_060 对 ewoh_idempotency_keys 的同款做法先回填 NULL 行、
--     再给列加「取请求 GUC，无 GUC 回退默认 org」的 DEFAULT —— 否则新插入的
--     NULL org 行在 fail-closed policy 下会变成谁都看不见的幽灵行。
--     ⚠ 该表的系统流程若脱离请求上下文（无 GUC）运行，必须改走
--     RequestDatabaseContext.systemGlobalAdminTransaction（本文件不在工作包
--     文件所有权内，调用方改造留给该表 owner；见交付说明 residualRisk）。
--
-- 不在本迁移范围（已独立复核，登记录入交付说明的 residualRisk）：
--   · ewoh_git_sync_state / ewoh_evidence_metadata —— **两表都没有 org_id 列**
--     （information_schema 实测 + drizzle schema.ts 双源一致：仅 sync_id /
--     evidence_id 等全局业务键）。没有可键控的租户维度，硬造 org_id 列会改变
--     表语义并牵动 TS schema 与全部插入路径，属超出「最小化修复」的重构，
--     故不在此处处理；正确出口是正式列入 GLOBAL_SHARED 豁免名单
--     （db/contracts/schema-manifest.yaml 不在本工作包文件所有权内）。
--
-- 回滚语义：仅关闭三表 RLS 并移除本迁移新增的 policy / 列 DEFAULT
-- （见同名 .rollback.sql）。注意 PG 语义：RLS 启用 + 无 policy = 全拒，
-- 因此回滚**必须** DISABLE ROW LEVEL SECURITY（审计 SQL-002/008 的教训），
-- 只 DROP POLICY 会把三表变成对 service_role 静默读空。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_factory_replication_sessions：NULL 回填 + 列 DEFAULT
--    回填口径与 standalone_057 §2 / standalone_060 §1 一致（取最小 org，再退
--    默认 org 哨兵），保证「存量 NULL 行」在新 policy 下不会成为不可见幽灵行。
-- ============================================================================
UPDATE __EWOH_SCHEMA__.ewoh_factory_replication_sessions
   SET org_id = COALESCE(
         (SELECT min(org_id::text) FROM __EWOH_SCHEMA__.ewoh_organization WHERE org_id IS NOT NULL),
         '00000000-0000-4000-8000-000000000001')
 WHERE org_id IS NULL;

ALTER TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions
  ALTER COLUMN org_id SET DEFAULT COALESCE(
    NULLIF(current_setting('app.current_org_id', true), ''),
    '00000000-0000-4000-8000-000000000001');

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_factory_replication_sessions.org_id IS
  '租户归属（standalone_098 起带 DEFAULT：取 app.current_org_id，无 GUC 回退默认 org；RLS factory_replication_sessions_org_isolation）';

-- ============================================================================
-- 2) RLS 启用 + org 隔离 policy（三表同款）
--    表达式与 standalone_060 idempotency_org_isolation / standalone_057
--    scheduler 族 policy 完全同形：
--      org 匹配「app.current_org_id（回退 app.primary_org_id）」或全局管理员。
--    GUC 全部缺失且非全局管理员时两侧均为 NULL → 表达式为 NULL → fail-closed
--    全拒（不保留 `OR org_id IS NULL` 放行分支，standalone_057 口径）。
--    幂等：DROP POLICY IF EXISTS 后重建，policy 名固定，verify 断言不漂移。
-- ============================================================================

ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resource_locks_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_locks;
CREATE POLICY resource_locks_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_locks
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

COMMENT ON POLICY resource_locks_org_isolation ON __EWOH_SCHEMA__.ewoh_resource_locks IS
  '分布式资源锁租户隔离（standalone_098，审计 SQL-012）：org_id 匹配当前 org 或全局管理员；无 NULL 放行（列 NOT NULL）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_policy_replay ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS policy_replay_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_replay;
CREATE POLICY policy_replay_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_replay
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

COMMENT ON POLICY policy_replay_org_isolation ON __EWOH_SCHEMA__.ewoh_policy_replay IS
  'Policy Replay 租户隔离（standalone_098，审计 SQL-012；schema.ts 注释所称「RLS org 隔离」的落地）：org_id 匹配当前 org 或全局管理员；无 NULL 放行（列自 standalone_057 起 NOT NULL）';

ALTER TABLE __EWOH_SCHEMA__.ewoh_factory_replication_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS factory_replication_sessions_org_isolation ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions;
CREATE POLICY factory_replication_sessions_org_isolation ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
    OR COALESCE(NULLIF(current_setting('app.is_global_admin', true), ''), 'false') = 'true'
  );

COMMENT ON POLICY factory_replication_sessions_org_isolation ON __EWOH_SCHEMA__.ewoh_factory_replication_sessions IS
  '工厂复制会话租户隔离（standalone_098，审计 SQL-012）：org_id 匹配当前 org 或全局管理员；NULL 行已回填 + 列有 GUC DEFAULT，故不设 NULL 放行分支（fail-closed）';
