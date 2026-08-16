-- standalone_044_simulation_run 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-025 / NO-12a）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 simulation_run_org_isolation 存在且读 app.current_org_id
--   3) CHECK（kind/status/isolation/completed/failed）与 UNIQUE (org_id, run_id) 存在
--   4) 契约形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 kind 必须被 CHECK 拒绝
--      - is_simulation = false 必须被 CHECK 拒绝（§13 三层强制之表级兜底）
--      - completed 无 results 必须被 CHECK 拒绝
--      - failed 无理由必须被 CHECK 拒绝
--      - 合法行可写入（随后删除，不留脏数据）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_tbl integer := 0;
  at_rls integer := 0;
  at_policy integer := 0;
  at_kind_chk integer := 0;
  at_status_chk integer := 0;
  at_isolation_chk integer := 0;
  at_completed_chk integer := 0;
  at_failed_chk integer := 0;
  at_unique integer := 0;
  bad_kind_rejected boolean := false;
  bad_isolation_rejected boolean := false;
  bad_completed_rejected boolean := false;
  bad_failed_rejected boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_simulation_run'
      AND policyname = 'simulation_run_org_isolation'
      AND pg_get_expr(polqual, polrelid) LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'chk_ewoh_simulation_run_kind';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'chk_ewoh_simulation_run_status';
  SELECT count(*) INTO at_isolation_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'chk_ewoh_simulation_run_isolation';
  SELECT count(*) INTO at_completed_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'chk_ewoh_simulation_run_completed';
  SELECT count(*) INTO at_failed_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'chk_ewoh_simulation_run_failed';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_simulation_run'
      AND con.conname = 'uq_ewoh_simulation_run' AND con.contype = 'u';
  IF at_kind_chk <> 1 OR at_status_chk <> 1 OR at_isolation_chk <> 1 OR at_completed_chk <> 1 OR at_failed_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format('constraints kind=%s status=%s isolation=%s completed=%s failed=%s uq=%s ',
      at_kind_chk, at_status_chk, at_isolation_chk, at_completed_chk, at_failed_chk, at_unique);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION 'standalone_044 verify failed: %', missing;
  END IF;

  BEGIN
    -- 非法 kind 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_simulation_run
      (org_id, run_id, kind, status, base_ref_json, parameters_json, engine_version, record_json)
    VALUES
      ('verify-org-044', 'sim:verify-044', 'teleport', 'created',
       '{"snapshotVersion":0}'::jsonb, '{}'::jsonb, '1.0.0', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_kind__';
  EXCEPTION
    WHEN check_violation THEN
      bad_kind_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_kind__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_kind_rejected THEN
    RAISE EXCEPTION 'standalone_044 selfcheck failed: illegal kind accepted';
  END IF;

  BEGIN
    -- is_simulation = false 必须被 CHECK 拒绝（§13 模拟数据显式标记之表级兜底）
    INSERT INTO __EWOH_SCHEMA__.ewoh_simulation_run
      (org_id, run_id, kind, status, is_simulation, base_ref_json, parameters_json, engine_version, record_json)
    VALUES
      ('verify-org-044', 'sim:verify-044', 'what_if', 'created', false,
       '{"snapshotVersion":0}'::jsonb, '{}'::jsonb, '1.0.0', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_isolation__';
  EXCEPTION
    WHEN check_violation THEN
      bad_isolation_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_isolation__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_isolation_rejected THEN
    RAISE EXCEPTION 'standalone_044 selfcheck failed: production row accepted into simulation ledger';
  END IF;

  BEGIN
    -- completed 无 results 必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_simulation_run
      (org_id, run_id, kind, status, base_ref_json, parameters_json, engine_version, record_json)
    VALUES
      ('verify-org-044', 'sim:verify-044', 'capacity', 'completed',
       '{"snapshotVersion":0}'::jsonb, '{}'::jsonb, '1.0.0', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_completed__';
  EXCEPTION
    WHEN check_violation THEN
      bad_completed_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_completed__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_completed_rejected THEN
    RAISE EXCEPTION 'standalone_044 selfcheck failed: completed without results accepted';
  END IF;

  BEGIN
    -- failed 无理由必须被 CHECK 拒绝
    INSERT INTO __EWOH_SCHEMA__.ewoh_simulation_run
      (org_id, run_id, kind, status, base_ref_json, parameters_json, engine_version, record_json)
    VALUES
      ('verify-org-044', 'sim:verify-044', 'layout', 'failed',
       '{"snapshotVersion":0}'::jsonb, '{}'::jsonb, '1.0.0', '{}'::jsonb);
    RAISE EXCEPTION '__unexpected_accept_failed__';
  EXCEPTION
    WHEN check_violation THEN
      bad_failed_rejected := true;
    WHEN raise_exception THEN
      IF SQLERRM = '__unexpected_accept_failed__' THEN NULL; ELSE RAISE; END IF;
  END;
  IF NOT bad_failed_rejected THEN
    RAISE EXCEPTION 'standalone_044 selfcheck failed: failed without reason accepted';
  END IF;

  BEGIN
    -- 合法行可写入（随后删除，不留脏数据）
    INSERT INTO __EWOH_SCHEMA__.ewoh_simulation_run
      (org_id, run_id, kind, status, base_ref_json, parameters_json, results_json, engine_version, record_json)
    VALUES
      ('verify-org-044', 'sim:verify-044', 'capacity', 'completed',
       '{"snapshotVersion":3}'::jsonb, '{"stations":[]}'::jsonb,
       '{"overloaded":false}'::jsonb, '1.0.0', '{}'::jsonb);
    DELETE FROM __EWOH_SCHEMA__.ewoh_simulation_run WHERE run_id = 'sim:verify-044';
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'standalone_044 selfcheck failed: valid row rejected (%)', SQLERRM;
  END;
END $$;

SELECT 1 AS standalone_044_verified;
