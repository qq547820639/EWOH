-- standalone_038_agent_task 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-017 / NO-06f）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 agent_task_org_isolation 存在且读 app.current_org_id
--   3) CHECK 约束（kind/priority/status）存在
--   4) 业务键唯一约束 (org_id, task_id) 存在
--   5) 契约形状自证（SAVEPOINT 包裹，验证不落脏数据）：
--      - 非法 kind 必须被 CHECK 拒绝
--      - 非法 status 必须被 CHECK 拒绝

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_kind_chk integer := 0;
  at_priority_chk integer := 0;
  at_status_chk integer := 0;
  at_unique integer := 0;
  bad_kind_rejected boolean := false;
  bad_status_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_agent_task'
      AND policyname = 'agent_task_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task'
      AND con.conname = 'chk_ewoh_agent_task_kind';
  SELECT count(*) INTO at_priority_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task'
      AND con.conname = 'chk_ewoh_agent_task_priority';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task'
      AND con.conname = 'chk_ewoh_agent_task_status';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_task'
      AND con.conname = 'uq_ewoh_agent_task' AND con.contype = 'u';
  IF at_kind_chk <> 1 OR at_priority_chk <> 1 OR at_status_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints kind=%s priority=%s status=%s uq=%s ', at_kind_chk, at_priority_chk, at_status_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_038 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 kind 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_agent_task
      (org_id, task_id, name, version, kind, assigned_role, priority, status, task_json)
    VALUES
      ('verify-org-038', 'task:verify-038', 'verify', 1, 'gizmo', 'FactorySupervisor', 'low', 'created', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_kind__';
  EXCEPTION
    WHEN check_violation THEN
      bad_kind_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_kind__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_kind_rejected THEN
    RAISE EXCEPTION 'standalone_038 selfcheck failed: illegal kind accepted';
  END IF;

  BEGIN
    -- 非法 status 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_agent_task
      (org_id, task_id, name, version, kind, assigned_role, priority, status, task_json)
    VALUES
      ('verify-org-038', 'task:verify-038', 'verify', 1, 'analysis', 'FactorySupervisor', 'low', 'teleported', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_status__';
  EXCEPTION
    WHEN check_violation THEN
      bad_status_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_status__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_status_rejected THEN
    RAISE EXCEPTION 'standalone_038 selfcheck failed: illegal status accepted';
  END IF;
END $$;

SELECT 1 AS standalone_038_verified;
