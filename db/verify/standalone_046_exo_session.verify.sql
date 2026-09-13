-- standalone_046_exo_session 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-032 / §7）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 exo_session_org_isolation 存在且读 app.current_org_id
--   3) CHECK（status/exo_id/person_id/end_complete/time_order）与
--      UNIQUE (org_id, session_id) + 部分唯一索引（active 外骨骼唯一）存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 status 必须被 CHECK 拒绝
--      - 非规范 exo_id 前缀必须被 CHECK 拒绝
--      - ended 无 actual_end_at 必须被 CHECK 拒绝
--      - actual_end_at < started_at 必须被 CHECK 拒绝
--      - 同外骨骼第二个 active 会话必须被部分唯一索引拒绝（§7 机器强制）
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_status_chk integer := 0;
  at_exo_chk integer := 0;
  at_end_chk integer := 0;
  at_time_chk integer := 0;
  at_unique integer := 0;
  at_partial_unique integer := 0;
  bad_status_rejected boolean := false;
  bad_exo_rejected boolean := false;
  bad_end_rejected boolean := false;
  bad_time_rejected boolean := false;
  double_active_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_exo_session'
      AND policyname = 'exo_session_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session'
      AND con.conname = 'chk_ewoh_exo_session_status';
  SELECT count(*) INTO at_exo_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session'
      AND con.conname = 'chk_ewoh_exo_session_exo_id';
  SELECT count(*) INTO at_end_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session'
      AND con.conname = 'chk_ewoh_exo_session_end_complete';
  SELECT count(*) INTO at_time_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session'
      AND con.conname = 'chk_ewoh_exo_session_time_order';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_session'
      AND con.conname = 'uq_ewoh_exo_session' AND con.contype = 'u';
  SELECT count(*) INTO at_partial_unique FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'ewoh_exo_session'
      AND indexname = 'uq_ewoh_exo_session_active_exo';
  IF at_status_chk <> 1 OR at_exo_chk <> 1 OR at_end_chk <> 1 OR at_time_chk <> 1 OR at_unique <> 1 OR at_partial_unique <> 1 THEN
    missing := missing || format('constraints status=%s exo=%s end=%s time=%s uq=%s partial=%s ',
      at_status_chk, at_exo_chk, at_end_chk, at_time_chk, at_unique, at_partial_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_046 verify failed: %', missing;
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046', 'device:exo-1', 'person:p-1', 'paused',
       now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_status__';
  EXCEPTION
    WHEN check_violation THEN
      bad_status_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_status__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_status_rejected THEN
    RAISE EXCEPTION 'standalone_046 selfcheck failed: illegal status accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046', 'EXO-001', 'person:p-1', 'active',
       now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_exo__';
  EXCEPTION
    WHEN check_violation THEN
      bad_exo_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_exo__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_exo_rejected THEN
    RAISE EXCEPTION 'standalone_046 selfcheck failed: non-canonical exo identity accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046', 'device:exo-1', 'person:p-1', 'ended',
       now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_end__';
  EXCEPTION
    WHEN check_violation THEN
      bad_end_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_end__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_end_rejected THEN
    RAISE EXCEPTION 'standalone_046 selfcheck failed: ended without actual_end_at accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, actual_end_at, ended_by, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046', 'device:exo-1', 'person:p-1', 'ended',
       now(), now() - interval '1 hour', 'person:p-1', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_time__';
  EXCEPTION
    WHEN check_violation THEN
      bad_time_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_time__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_time_rejected THEN
    RAISE EXCEPTION 'standalone_046 selfcheck failed: end-before-start accepted';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046-a', 'device:exo-1', 'person:p-1', 'active',
       now(), '{}'::jsonb);
    INSERT INTO __EWOH_SCHEMA__.ewoh_exo_session
      (org_id, session_id, exo_id, person_id, status, started_at, record_json)
    VALUES
      ('verify-org-046', 'exo-session:verify-046-b', 'device:exo-1', 'person:p-2', 'active',
       now(), '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_double_active__';
  EXCEPTION
    WHEN unique_violation THEN
      double_active_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_double_active__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT double_active_rejected THEN
    RAISE EXCEPTION 'standalone_046 selfcheck failed: double active session accepted (§7 机器强制失效)';
  END IF;

  BEGIN
    DELETE FROM __EWOH_SCHEMA__.ewoh_exo_session WHERE org_id = 'verify-org-046';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_046 selfcheck failed: cleanup error (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_046_verified;
