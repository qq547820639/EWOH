-- 101 verify：约束白名单含新 reason；新 reason 行可插入且可见；旧 5 reason 之外的值仍拒绝。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  constraint_ok boolean := false;
  insert_new_ok boolean := false;
  reject_old_bad boolean := false;
  probe_org uuid := '00000000-0000-4000-8000-000000000001';
  probe_letter_new constant varchar := 'att-verify-101-clock-drift';
  probe_letter_bad constant varchar := 'att-verify-101-teleport';
BEGIN
  -- 1) 约束定义含 clock_drift_future
  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = '__EWOH_SCHEMA__.ewoh_dead_letter'::regclass
       AND conname = 'chk_ewoh_dead_letter_reason'
       AND pg_get_constraintdef(oid) LIKE '%clock_drift_future%'
       AND pg_get_constraintdef(oid) LIKE '%event_write_failed%'
  ) INTO constraint_ok;
  IF NOT constraint_ok THEN
    RAISE EXCEPTION '101 verify FAILED: chk_ewoh_dead_letter_reason 未包含新 reason';
  END IF;

  -- 2) 新 reason 行可插入（探针行，验证后清理）
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, correlation_id, record_json)
    VALUES (
      probe_org, probe_letter_new, 'cloud:ingest', 'clock_drift_future', 1, 'pending',
      '{"eventId":"EVT-VERIFY-101","eventType":"DeviceThermalRisk","source":"edge:rule-engine","occurredAt":"2026-01-01T00:00:00Z"}'::jsonb,
      NULL,
      '{"letterId":"att-verify-101-clock-drift","auditTrail":true}'::jsonb
    );
    insert_new_ok := true;
    DELETE FROM __EWOH_SCHEMA__.ewoh_dead_letter WHERE letter_id = probe_letter_new;
  EXCEPTION WHEN check_violation THEN
    insert_new_ok := false;
  WHEN OTHERS THEN
    insert_new_ok := false;
  END;
  IF NOT insert_new_ok THEN
    RAISE EXCEPTION '101 verify FAILED: clock_drift_future 死信行插入被拒（约束未生效）';
  END IF;

  -- 3) 未注册 reason 仍被拒（封闭注册表语义不变）
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_dead_letter
      (org_id, letter_id, source_id, reason, attempts, status, envelope_json, correlation_id, record_json)
    VALUES (
      probe_org, probe_letter_bad, 'cloud:ingest', 'teleport_failure', 1, 'pending',
      '{"eventId":"EVT-VERIFY-101-BAD"}'::jsonb,
      NULL,
      '{"letterId":"att-verify-101-teleport","auditTrail":true}'::jsonb
    );
    -- 插入成功 = 封闭性被破坏
    reject_old_bad := false;
    DELETE FROM __EWOH_SCHEMA__.ewoh_dead_letter WHERE letter_id = probe_letter_bad;
  EXCEPTION WHEN check_violation THEN
    reject_old_bad := true;
  WHEN OTHERS THEN
    reject_old_bad := true;
  END;
  IF NOT reject_old_bad THEN
    RAISE EXCEPTION '101 verify FAILED: 未注册 reason 竟然插入成功（封闭注册表被破坏）';
  END IF;

  RAISE NOTICE '101 verify PASSED: reason 注册表已扩容且封闭性保持';
END $$;

SELECT 1 AS standalone_101_verified;
