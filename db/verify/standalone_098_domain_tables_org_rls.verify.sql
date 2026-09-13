-- standalone_098_domain_tables_org_rls 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（审计 SQL-012 / WP-E）：
--   1) 三表 relrowsecurity = true，且各存在唯一一条 098 命名 policy
--      （resource_locks_org_isolation / policy_replay_org_isolation /
--        factory_replication_sessions_org_isolation），role 收敛到
--      service_role、不是 TO PUBLIC 的裸放行；
--   2) policy 定义文本必须真的含租户谓词（app.current_org_id + is_global_admin），
--      且**不含** `USING (true)` 这类恒真放行 —— 防止「表启用了 RLS 但策略形同虚设」
--      这种「结构上通过、语义上没护栏」的假修复；
--   3) 可见性自证（SET LOCAL GUC + SET LOCAL ROLE ewoh_api，验证后删探针不留脏数据）：
--      - org-a GUC：可见 org-a 行，不可见 org-b 行（三表逐一）
--      - org-b GUC：可见 org-b 行，不可见 org-a 行
--      - 无 GUC 且非管理员：三表探针行**一行都不可见**（fail-closed，057 语义）
--      - 全局管理员 GUC：两行都可见（管理员例外路径显式存在）
--
-- 为什么必须切 ewoh_api：本 verify 以 owner/超级用户连接，属主与 BYPASSRLS 角色
-- 绕过 RLS，在 owner 身份下任何可见性探针都会「两行都可见」而恒真
-- （standalone_056 已在 2026-09-12 踩过这个坑）。ewoh_api 是 NOBYPASSRLS 的
-- service_role 成员，只有切到它，探针才真正在验 RLS。
--
-- 本脚本在「策略缺失」时必然失败：
--   · 迁移未跑 → relrowsecurity=false / policy 计数=0 → 断言 1 失败；
--   · 只 ENABLE 未建 policy（或建了恒真 policy）→ 断言 1/2 失败；
--   · 建了 policy 但 SQL 语义写错（例如漏 NULL 分支的 fail-closed、或 org 谓词
--     写反）→ 断言 3 的 vis_* 三项失败。
--
-- 边界（不在本迁移范围，勿据此反推为「漏验」）：ewoh_git_sync_state /
-- ewoh_evidence_metadata 无 org_id 列（information_schema 实测 + schema.ts 一致），
-- 不存在可键控的租户维度，故本 verify 不对其断言 RLS。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  v_tables constant text[] := ARRAY[
    'ewoh_resource_locks',
    'ewoh_policy_replay',
    'ewoh_factory_replication_sessions'
  ];
  v_policies constant text[] := ARRAY[
    'resource_locks_org_isolation',
    'policy_replay_org_isolation',
    'factory_replication_sessions_org_isolation'
  ];
  v_rls boolean;
  v_pol integer;
  v_scope_ok boolean;
  v_semantics_ok boolean;
  vis_a_ok boolean := true;
  vis_b_ok boolean := true;
  vis_none_ok boolean := true;
  vis_admin_ok boolean := true;
  probe_a varchar := '00000000-0000-4000-8000-0000000000a1';
  probe_b varchar := '00000000-0000-4000-8000-0000000000b2';
BEGIN
  -- 1) RLS 已启用 + policy 存在且唯一 + 只授 service_role
  FOR i IN 1 .. array_length(v_tables, 1) LOOP
    SELECT c.relrowsecurity INTO v_rls
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = v_tables[i];
    IF v_rls IS NULL OR NOT v_rls THEN
      RAISE EXCEPTION '098 verify FAILED: % 未启用 RLS（standalone_098 未应用或回滚残留）', v_tables[i];
    END IF;

    SELECT count(*) INTO v_pol FROM pg_policies
     WHERE schemaname = current_schema()
       AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_pol <> 1 THEN
      RAISE EXCEPTION '098 verify FAILED: % 的 policy % 计数=%（期望 1）',
        v_tables[i], v_policies[i], v_pol;
    END IF;

    -- role 必须是 service_role（TO PUBLIC / TO authenticated 都是越权放行面）
    SELECT ('service_role' = ANY (roles)) AND NOT ('public' = ANY (roles))
      INTO v_scope_ok
      FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_scope_ok IS NULL OR NOT v_scope_ok THEN
      RAISE EXCEPTION '098 verify FAILED: % 的 policy 作用角色不是且仅 service_role', v_tables[i];
    END IF;

    -- 2) policy 语义：必须含 org 谓词与管理员例外，且不得是恒真放行。
    --    「恒真」判定用 btrim 精确比对布尔常量，不能写成 `NOT LIKE '%true%'`——
    --    策略体内本就有 is_global_admin = 'true' 的字面量，模糊匹配会把正常
    --    policy 误判为放行（2026-09-13 实测踩到）。
    SELECT (qual IS NOT NULL AND with_check IS NOT NULL
            AND qual::text LIKE '%app.current_org_id%'
            AND with_check::text LIKE '%app.current_org_id%'
            AND qual::text LIKE '%is_global_admin%'
            AND with_check::text LIKE '%is_global_admin%'
            AND btrim(qual::text) NOT IN ('true', '(true)')
            AND btrim(with_check::text) NOT IN ('true', '(true)'))
      INTO v_semantics_ok
      FROM pg_policies
     WHERE schemaname = current_schema() AND tablename = v_tables[i]
       AND policyname = v_policies[i];
    IF v_semantics_ok IS NULL OR NOT v_semantics_ok THEN
      RAISE EXCEPTION '098 verify FAILED: % 的 policy 无租户谓词或形同恒真放行'
        '（必须同时含 app.current_org_id 与 is_global_admin，且不得是裸 true）', v_tables[i];
    END IF;
  END LOOP;

  -- 3) 可见性自证。探针行先以 owner 身份写入（owner 绕过 RLS，能覆盖三个 org），
  --    随后切 ewoh_api 逐 org 判定，最后 RESET ROLE 清理。
  BEGIN
    DELETE FROM ewoh_resource_locks WHERE resource_key LIKE 'verify-098-%';
    DELETE FROM ewoh_policy_replay WHERE replay_id LIKE 'verify-098-%';
    DELETE FROM ewoh_factory_replication_sessions WHERE session_id LIKE 'verify-098-%';

    INSERT INTO ewoh_resource_locks (org_id, resource_key, resource_id, holder) VALUES
      (probe_a, 'verify-098-lock-a', 'verify-098-res-a', 'verify-098-holder'),
      (probe_b, 'verify-098-lock-b', 'verify-098-res-b', 'verify-098-holder');
    -- replay_id 自 standalone_057 起为 (org_id, replay_id) 复合唯一，故两租户可同号；
    -- 此处仍用不同 id，兼容未跑 057 的库（replay_id 单列唯一）。
    INSERT INTO ewoh_policy_replay
      (replay_id, org_id, candidate_policy_version, baseline_policy_version) VALUES
      ('verify-098-replay-a', probe_a, 9001, 9000),
      ('verify-098-replay-b', probe_b, 9001, 9000);
    INSERT INTO ewoh_factory_replication_sessions (session_id, org_id, factory_id) VALUES
      ('verify-098-session-a', probe_a, 'verify-098-factory'),
      ('verify-098-session-b', probe_b, 'verify-098-factory');

    SET LOCAL ROLE ewoh_api;

    -- org-a：只见 a 行
    PERFORM set_config('app.current_org_id', probe_a, true);
    PERFORM set_config('app.primary_org_id', '', true);
    PERFORM set_config('app.is_global_admin', 'false', true);
    vis_a_ok :=
      EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-b')
      AND EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-b')
      AND EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-a')
      AND NOT EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-b');

    -- org-b：只见 b 行
    PERFORM set_config('app.current_org_id', probe_b, true);
    vis_b_ok :=
      EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-a')
      AND EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-a')
      AND EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-b')
      AND NOT EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-a');

    -- 无 GUC 且非管理员：一行都不可见（fail-closed）
    PERFORM set_config('app.current_org_id', '', true);
    PERFORM set_config('app.primary_org_id', '', true);
    PERFORM set_config('app.is_global_admin', 'false', true);
    vis_none_ok :=
      NOT EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key LIKE 'verify-098-%')
      AND NOT EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id LIKE 'verify-098-%')
      AND NOT EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id LIKE 'verify-098-%');

    -- 全局管理员例外路径：两行都可见
    PERFORM set_config('app.is_global_admin', 'true', true);
    vis_admin_ok :=
      EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-a')
      AND EXISTS (SELECT 1 FROM ewoh_resource_locks WHERE resource_key = 'verify-098-lock-b')
      AND EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-a')
      AND EXISTS (SELECT 1 FROM ewoh_policy_replay WHERE replay_id = 'verify-098-replay-b')
      AND EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-a')
      AND EXISTS (SELECT 1 FROM ewoh_factory_replication_sessions WHERE session_id = 'verify-098-session-b');

    RESET ROLE;

    DELETE FROM ewoh_resource_locks WHERE resource_key LIKE 'verify-098-%';
    DELETE FROM ewoh_policy_replay WHERE replay_id LIKE 'verify-098-%';
    DELETE FROM ewoh_factory_replication_sessions WHERE session_id LIKE 'verify-098-%';
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    DELETE FROM ewoh_resource_locks WHERE resource_key LIKE 'verify-098-%';
    DELETE FROM ewoh_policy_replay WHERE replay_id LIKE 'verify-098-%';
    DELETE FROM ewoh_factory_replication_sessions WHERE session_id LIKE 'verify-098-%';
    RAISE;
  END;

  IF NOT vis_a_ok OR NOT vis_b_ok OR NOT vis_none_ok OR NOT vis_admin_ok THEN
    RAISE EXCEPTION '098 verify FAILED: 可见性自证 vis_a=% vis_b=% vis_none=% vis_admin=%',
      vis_a_ok, vis_b_ok, vis_none_ok, vis_admin_ok;
  END IF;

  RAISE NOTICE '098 verify OK: 三表 RLS 启用 + policy 只授 service_role 且含租户谓词 + org-a/org-b/无GUC/管理员 四态可见性自证通过';
END $$;

SELECT 1 AS standalone_098_verified;
