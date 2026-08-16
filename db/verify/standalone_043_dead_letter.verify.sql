-- standalone_043_dead_letter 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-024 / NO-11a）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 dead_letter_org_isolation 存在且读 app.current_org_id
--   3) CHECK（reason/status/attempts/discard）与 UNIQUE (org_id, letter_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 reason 必须被 CHECK 拒绝
--      - attempts=0 必须被 CHECK 拒绝
--      - discarded 无理由必须被 CHECK 拒绝
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_reason_chk integer := 0;
  at_status_chk integer := 0;
  at_attempts_chk integer := 0;
  at_discard_chk integer := 0;
  at_unique integer := 0;
  bad_reason_rejected boolean := false;
  bad_attempts_rejected boolean := false;
  bad_discard_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_dead_letter'
      AND policyname = 'dead_letter_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_reason_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter'
      AND con.conname = 'chk_ewoh_dead_letter_reason';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter'
      AND con.conname = 'chk_ewoh_dead_letter_status';
  SELECT count(*) INTO at_attempts_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter'
      AND con.conname = 'chk_ewoh_dead_letter_attempts';
  SELECT count(*) INTO at_discard_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter'
      AND con.conname = 'chk_ewoh_dead_letter_discard';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_dead_letter'
      AND con.conname = 'uq_ewoh_dead_letter' AND con.contype = 'u';
  IF at_reason_chk <> 1 OR at_status_chk <> 1 OR at_attempts_chk <> 1 OR at_discard_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints reason=%s status=%s attempts=%s discard=%s uq=%s ',
      at_reason_chk, at_status_chk, at_attempts_chk, at_discard_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_043 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 reason 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, record_json)
    VALUES
      ('verify-org-043', 'dl:verify-043', 'cloud:ingest', 'teleport', 1, 'pending',
       '{"eventId":"E1"}'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_reason__';
  EXCEPTION
    WHEN check_violation THEN
      bad_reason_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_reason__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_reason_rejected THEN
    RAISE EXCEPTION 'standalone_043 selfcheck failed: illegal reason accepted';
  END IF;

  BEGIN
    -- attempts=0 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, record_json)
    VALUES
      ('verify-org-043', 'dl:verify-043', 'cloud:ingest', 'permanent_failure', 0, 'pending',
       '{"eventId":"E1"}'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_attempts__';
  EXCEPTION
    WHEN check_violation THEN
      bad_attempts_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_attempts__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_attempts_rejected THEN
    RAISE EXCEPTION 'standalone_043 selfcheck failed: zero attempts accepted';
  END IF;

  BEGIN
    -- discarded 无理由必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, record_json)
    VALUES
      ('verify-org-043', 'dl:verify-043', 'cloud:ingest', 'permanent_failure', 1, 'discarded',
       '{"eventId":"E1"}'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_discard__';
  EXCEPTION
    WHEN check_violation THEN
      bad_discard_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_discard__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_discard_rejected THEN
    RAISE EXCEPTION 'standalone_043 selfcheck failed: discard without reason accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, record_json)
    VALUES
      ('verify-org-043', 'dl:verify-043', 'cloud:ingest', 'unknown_event_type', 1, 'pending',
       '{"eventId":"E1","eventType":"TeleportEvent"}'::jsonb, '{}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_dead_letter WHERE letter_id = 'dl:verify-043';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_043 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_043_verified;
