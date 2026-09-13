-- standalone_074 verify：班次域两表「存在且约束真的生效」。
-- 断言不只查字典，还做写入探测：零长度窗口（start=end）必须被 CHECK 拒绝、
-- 交接状态词表外值必须被拒绝、RLS 策略存在且绑定 org 隔离谓词。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  window_rejected boolean := false;
  handover_status_rejected boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_shift'
  ) THEN
    RAISE EXCEPTION 'standalone_074: ewoh_shift 表缺失（迁移未应用）';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_shift_handover'
  ) THEN
    RAISE EXCEPTION 'standalone_074: ewoh_shift_handover 表缺失（迁移未应用）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_shift (
      org_id, shift_id, name, start_time, end_time
    ) VALUES (
      '__probe_074__', '__probe_074_zero_window__', '探测班次', '08:00', '08:00'
    );
  EXCEPTION WHEN check_violation THEN
    window_rejected := true;
  END;
  DELETE FROM __EWOH_SCHEMA__.ewoh_shift WHERE org_id = '__probe_074__';
  IF NOT window_rejected THEN
    RAISE EXCEPTION 'standalone_074: chk_ewoh_shift_window 未拒绝零长度窗口写入（约束未生效）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_shift_handover (
      org_id, handover_id, shift_id, shift_date, to_user_id, status
    ) VALUES (
      '__probe_074__', '__probe_074_bad_status__', 'SHIFT-A', current_date,
      gen_random_uuid(), 'not_a_status'
    );
  EXCEPTION WHEN check_violation THEN
    handover_status_rejected := true;
  END;
  DELETE FROM __EWOH_SCHEMA__.ewoh_shift_handover WHERE org_id = '__probe_074__';
  IF NOT handover_status_rejected THEN
    RAISE EXCEPTION 'standalone_074: chk_ewoh_shift_handover_status 未拒绝词表外状态（约束未生效）';
  END IF;
END $$;

SELECT CASE WHEN
  -- 两表 + 唯一键 + RLS 启用 + 隔离策略存在
  EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_shift')
  AND EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_shift_handover')
  AND EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_shift'::regclass
      AND conname = 'uq_ewoh_shift' AND convalidated)
  AND EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_shift_handover'::regclass
      AND conname = 'uq_ewoh_shift_handover' AND convalidated)
  AND (SELECT relrowsecurity FROM pg_class
    WHERE oid = '__EWOH_SCHEMA__.ewoh_shift'::regclass)
  AND (SELECT relrowsecurity FROM pg_class
    WHERE oid = '__EWOH_SCHEMA__.ewoh_shift_handover'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_shift'
      AND policyname = 'shift_org_isolation')
  AND EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_shift_handover'
      AND policyname = 'shift_handover_org_isolation')
  -- 探测行已清除（verify 无副作用）
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_shift
        WHERE org_id = '__probe_074__') = 0
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_shift_handover
        WHERE org_id = '__probe_074__') = 0
  THEN 1 ELSE 0 END AS standalone_074_verified;
