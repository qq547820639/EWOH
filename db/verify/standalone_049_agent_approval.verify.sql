-- standalone_049_agent_approval 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-039 / NO-12p / §11）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 agent_approval_org_isolation 存在且读 app.current_org_id
--   3) 约束存在：uq (org_id, approval_id)、status 注册表 CHECK、
--      pending ⇔ resolved_at IS NULL CHECK、roles_json 数组 CHECK
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 status 必须被 CHECK 拒绝
--      - 非 pending 且无 resolved_at 必须被 CHECK 拒绝
--      - roles_json 非数组必须被 CHECK 拒绝
--      - 同 (org_id, approval_id) 重复必须被唯一约束拒绝
--      - 合法 pending 行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_unique integer := 0;
  at_status_chk integer := 0;
  at_resolved_chk integer := 0;
  at_roles_chk integer := 0;
  bad_status_rejected boolean := false;
  bad_resolved_rejected boolean := false;
  bad_roles_rejected boolean := false;
  dup_rejected boolean := false;
  pending_ok boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_agent_approval'
      AND policyname = 'agent_approval_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval'
      AND con.conname = 'uq_ewoh_agent_approval';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval'
      AND con.conname = 'chk_ewoh_agent_approval_status';
  SELECT count(*) INTO at_resolved_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval'
      AND con.conname = 'chk_ewoh_agent_approval_resolved';
  SELECT count(*) INTO at_roles_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_agent_approval'
      AND con.conname = 'chk_ewoh_agent_approval_roles';

  -- 1) 非法 status 必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status, resolved_at)
      VALUES ('verify-049', 'verify-049-a', 'agent:x', 'cmd', '["dispatcher"]', 'weird', NULL);
    RAISE EXCEPTION '非法 status 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_status_rejected := true;
  END;

  -- 2) 非 pending 且无 resolved_at 必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status, resolved_at)
      VALUES ('verify-049', 'verify-049-b', 'agent:x', 'cmd', '["dispatcher"]', 'approved', NULL);
    RAISE EXCEPTION 'approved 无 resolved_at 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_resolved_rejected := true;
  END;

  -- 3) roles_json 非数组必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status)
      VALUES ('verify-049', 'verify-049-c', 'agent:x', 'cmd', '{"role":"dispatcher"}', 'pending');
    RAISE EXCEPTION 'roles_json 非数组未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_roles_rejected := true;
  END;

  -- 4) 同 (org_id, approval_id) 重复必须被唯一约束拒绝
  BEGIN
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status)
      VALUES ('verify-049', 'verify-049-d', 'agent:x', 'cmd', '["dispatcher"]', 'pending');
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status)
      VALUES ('verify-049', 'verify-049-d', 'agent:x', 'cmd', '["dispatcher"]', 'pending');
    RAISE EXCEPTION '重复 approval_id 未被拒绝';
  EXCEPTION WHEN unique_violation THEN
    dup_rejected := true;
    DELETE FROM ewoh_agent_approval WHERE approval_id = 'verify-049-d';
  END;

  -- 5) 控制组：合法 pending 行可写入（随后删除，不留脏数据）
  BEGIN
    INSERT INTO ewoh_agent_approval (org_id, approval_id, agent_id, command, roles_json, status)
      VALUES ('verify-049', 'verify-049-e', 'agent:x', 'cmd', '["dispatcher"]', 'pending');
    pending_ok := true;
    DELETE FROM ewoh_agent_approval WHERE approval_id = 'verify-049-e';
  EXCEPTION WHEN OTHERS THEN
    pending_ok := false;
  END;

  IF missing <> '' OR at_unique <> 1 OR at_status_chk <> 1 OR at_resolved_chk <> 1
     OR at_roles_chk <> 1 OR NOT bad_status_rejected OR NOT bad_resolved_rejected
     OR NOT bad_roles_rejected OR NOT dup_rejected OR NOT pending_ok THEN
    RAISE EXCEPTION 'standalone_049 verify incomplete: % constraints=[%,%,%,%] rejected=[%,%,%,%] pending=%',
      missing, at_unique, at_status_chk, at_resolved_chk, at_roles_chk,
      bad_status_rejected, bad_resolved_rejected, bad_roles_rejected, dup_rejected, pending_ok;
  END IF;
END $$;

SELECT 1 AS standalone_049_verified;
