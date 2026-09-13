-- standalone_042_trace_span 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-022 / NO-10a）：
--   1) 表存在且 relrowsecurity = true（策略式可见性）
--   2) 策略 trace_span_org_or_global 存在且引用 is_global_admin（非 loose）
--   3) CHECK（status/duration/time）与 UNIQUE (trace_id, span_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 status_code 必须被 CHECK 拒绝
--      - 负 duration 必须被 CHECK 拒绝
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_status_chk integer := 0;
  at_duration_chk integer := 0;
  at_time_chk integer := 0;
  at_unique integer := 0;
  bad_status_rejected boolean := false;
  bad_duration_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_trace_span'
      AND policyname = 'trace_span_org_or_global'
      AND qual LIKE '%is_global_admin%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span'
      AND con.conname = 'chk_ewoh_trace_span_status';
  SELECT count(*) INTO at_duration_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span'
      AND con.conname = 'chk_ewoh_trace_span_duration';
  SELECT count(*) INTO at_time_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span'
      AND con.conname = 'chk_ewoh_trace_span_time';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_trace_span'
      AND con.conname = 'uq_ewoh_trace_span' AND con.contype = 'u';
  IF at_status_chk <> 1 OR at_duration_chk <> 1 OR at_time_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints status=%s duration=%s time=%s uq=%s ',
      at_status_chk, at_duration_chk, at_time_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_042 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 status_code 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_trace_span
      (trace_id, span_id, path, method, status_code, duration_ms, started_at, finished_at)
    VALUES
      ('trace-verify-042', 'span-verify-042', '/api/x', 'GET', 999, 1, now(), now());
    RAISE EXCEPTION '__unexpected_accept_status__';
  EXCEPTION
    WHEN check_violation THEN
      bad_status_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_status__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_status_rejected THEN
    RAISE EXCEPTION 'standalone_042 selfcheck failed: illegal status_code accepted';
  END IF;

  BEGIN
    -- 负 duration 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_trace_span
      (trace_id, span_id, path, method, status_code, duration_ms, started_at, finished_at)
    VALUES
      ('trace-verify-042', 'span-verify-042', '/api/x', 'GET', 200, -1, now(), now());
    RAISE EXCEPTION '__unexpected_accept_duration__';
  EXCEPTION
    WHEN check_violation THEN
      bad_duration_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_duration__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_duration_rejected THEN
    RAISE EXCEPTION 'standalone_042 selfcheck failed: negative duration accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_trace_span
      (trace_id, span_id, path, method, status_code, duration_ms, started_at, finished_at, org_id)
    VALUES
      ('trace-verify-042', 'span-verify-042', '/api/x', 'GET', 200, 3, now(), now(),
       '00000000-0000-4000-8000-000000000042'::uuid);
    DELETE FROM __EWOH_SCHEMA__.ewoh_trace_span WHERE trace_id = 'trace-verify-042';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_042 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_042_verified;
