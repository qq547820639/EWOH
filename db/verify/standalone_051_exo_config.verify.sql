-- standalone_051_exo_config 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-051/ADR-052 / §7）：
--   1) 表存在且 relrowsecurity = true（TENANT_SCOPED）
--   2) RLS 策略 exo_config_org_isolation 存在且读 app.current_org_id
--   3) CHECK（kind/status_by_kind/support_mode/profile_facts/superseded/
--      fit_facts/calibration_facts/time_order/next_due_order）与
--      UNIQUE (org_id, config_id) 存在
--   4) 形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - 非法 kind / 非法 status / 非法 support_mode / vendor_specific 无
--        vendor_mode_name / 无 effective_from 的 profile / superseded 无
--        superseded_by / fit 缺 person_id / calibration 缺 result /
--        effective_to < effective_from 均必须被 CHECK 拒绝
--      - 重复 (org_id, config_id) 必须被 UNIQUE 拒绝
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
  at_mode_chk integer := 0;
  at_profile_chk integer := 0;
  at_superseded_chk integer := 0;
  at_fit_chk integer := 0;
  at_cal_chk integer := 0;
  at_time_chk integer := 0;
  at_unique integer := 0;
  bad_kind_rejected boolean := false;
  bad_status_rejected boolean := false;
  bad_mode_rejected boolean := false;
  bad_vendor_rejected boolean := false;
  bad_profile_rejected boolean := false;
  bad_superseded_rejected boolean := false;
  bad_fit_rejected boolean := false;
  bad_cal_rejected boolean := false;
  bad_time_rejected boolean := false;
  dup_rejected boolean := false;
  control_ok boolean := false;
BEGIN
  SELECT count(*) INTO at_tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config';
  IF at_tbl <> 1 THEN
    missing := missing || format('table at=%s ', at_tbl);
  END IF;

  SELECT count(*) INTO at_rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config' AND c.relrowsecurity;
  IF at_rls <> 1 THEN
    missing := missing || format('rls at=%s ', at_rls);
  END IF;

  SELECT count(*) INTO at_policy FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_exo_config'
      AND policyname = 'exo_config_org_isolation'
      AND qual LIKE '%app.current_org_id%';
  IF at_policy <> 1 THEN
    missing := missing || format('policy at=%s ', at_policy);
  END IF;

  SELECT count(*) INTO at_kind_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_kind';
  SELECT count(*) INTO at_status_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_status_by_kind';
  SELECT count(*) INTO at_mode_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_support_mode';
  SELECT count(*) INTO at_profile_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_profile_facts';
  SELECT count(*) INTO at_superseded_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_profile_superseded';
  SELECT count(*) INTO at_fit_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_fit_facts';
  SELECT count(*) INTO at_cal_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_calibration_facts';
  SELECT count(*) INTO at_time_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'chk_ewoh_exo_config_time_order';
  SELECT count(*) INTO at_unique FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_exo_config'
      AND con.conname = 'uq_ewoh_exo_config';

  IF missing = '' AND at_kind_chk <> 1 OR at_status_chk <> 1 OR at_mode_chk <> 1
     OR at_profile_chk <> 1 OR at_superseded_chk <> 1 OR at_fit_chk <> 1
     OR at_cal_chk <> 1 OR at_time_chk <> 1 OR at_unique <> 1 THEN
    missing := missing || format(
      'constraints kind=%s status=%s mode=%s profile=%s superseded=%s fit=%s cal=%s time=%s unique=%s ',
      at_kind_chk, at_status_chk, at_mode_chk, at_profile_chk, at_superseded_chk,
      at_fit_chk, at_cal_chk, at_time_chk, at_unique);
  END IF;

  -- 非法 kind 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, record_json)
      VALUES ('verify-051', 'verify-051-a', 'future_kind', 'device:exo-v', 'active', '{}');
    RAISE EXCEPTION 'bad kind 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_kind_rejected := true;
  END;

  -- 非法 status（assist_profile + fitted）必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-b', 'assist_profile', 'device:exo-v', 'fitted', 'lift_assist', now(), '{}');
    RAISE EXCEPTION 'bad status 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_status_rejected := true;
  END;

  -- 非法 support_mode 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-c', 'assist_profile', 'device:exo-v', 'active', 'turbo', now(), '{}');
    RAISE EXCEPTION 'bad support_mode 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_mode_rejected := true;
  END;

  -- vendor_specific 无 vendor_mode_name 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-d', 'assist_profile', 'device:exo-v', 'active', 'vendor_specific', now(), '{}');
    RAISE EXCEPTION 'vendor_specific 无名未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_vendor_rejected := true;
  END;

  -- assist_profile 无 effective_from 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, record_json)
      VALUES ('verify-051', 'verify-051-e', 'assist_profile', 'device:exo-v', 'active', 'passive', '{}');
    RAISE EXCEPTION 'profile 无 effective_from 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_profile_rejected := true;
  END;

  -- superseded 无 superseded_by 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-f', 'assist_profile', 'device:exo-v', 'superseded', 'passive', now(), '{}');
    RAISE EXCEPTION 'superseded 无 superseded_by 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_superseded_rejected := true;
  END;

  -- fit 缺 person_id 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, fitted_at, fitter, record_json)
      VALUES ('verify-051', 'verify-051-g', 'fit', 'device:exo-v', 'fitted', now(), 'person:op', '{}');
    RAISE EXCEPTION 'fit 缺 person_id 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_fit_rejected := true;
  END;

  -- calibration 缺 result 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, calibration_kind, calibrated_at, calibrated_by, record_json)
      VALUES ('verify-051', 'verify-051-h', 'calibration', 'device:exo-v', 'passed', 'imu', now(), 'person:op', '{}');
    RAISE EXCEPTION 'calibration 缺 result 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_cal_rejected := true;
  END;

  -- effective_to < effective_from 必须被拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, effective_to, record_json)
      VALUES ('verify-051', 'verify-051-i', 'assist_profile', 'device:exo-v', 'active', 'passive', now(), now() - interval '1 hour', '{}');
    RAISE EXCEPTION 'time order 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_time_rejected := true;
  END;

  -- 重复 (org_id, config_id) 必须被 UNIQUE 拒绝
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-j', 'assist_profile', 'device:exo-v', 'active', 'passive', now(), '{}');
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-j', 'assist_profile', 'device:exo-v', 'active', 'passive', now(), '{}');
    RAISE EXCEPTION '重复 config_id 未被拒绝';
  EXCEPTION WHEN unique_violation THEN
    dup_rejected := true;
    DELETE FROM ewoh_exo_config WHERE org_id = 'verify-051' AND config_id = 'verify-051-j';
  END;

  -- 控制组：合法行可写入（随后删除，不留脏数据）
  BEGIN
    INSERT INTO ewoh_exo_config (org_id, config_id, kind, exo_id, status, support_mode, effective_from, record_json)
      VALUES ('verify-051', 'verify-051-k', 'assist_profile', 'device:exo-v', 'active', 'lift_assist', now(), '{"configId":"exo-config:verify-051-k"}');
    control_ok := true;
    DELETE FROM ewoh_exo_config WHERE org_id = 'verify-051' AND config_id = 'verify-051-k';
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
  END;

  IF missing <> '' OR NOT bad_kind_rejected OR NOT bad_status_rejected
     OR NOT bad_mode_rejected OR NOT bad_vendor_rejected OR NOT bad_profile_rejected
     OR NOT bad_superseded_rejected OR NOT bad_fit_rejected OR NOT bad_cal_rejected
     OR NOT bad_time_rejected OR NOT dup_rejected OR NOT control_ok THEN
    RAISE EXCEPTION 'standalone_051 verify incomplete: % rejected=[%,%,%,%,%,%,%,%,%] dup=% control=%',
      missing, bad_kind_rejected, bad_status_rejected, bad_mode_rejected,
      bad_vendor_rejected, bad_profile_rejected, bad_superseded_rejected,
      bad_fit_rejected, bad_cal_rejected, bad_time_rejected, dup_rejected, control_ok;
  END IF;
END $$;

SELECT 1 AS standalone_051_verified;
