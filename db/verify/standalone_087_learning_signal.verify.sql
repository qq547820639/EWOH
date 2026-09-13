-- 087 verify：运行记忆信号台账就位 —— 列/约束/RLS/唯一键逐项可验，
-- 并且**契约兜底真的会拦**（样本不足不许给可信度、不可执行必须给理由、
-- promoted/dismissed 必须带决定人与理由）。空库可跑、跑完不留脏数据。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  tbl_ok integer;
  rls_ok integer;
  policy_ok integer;
  unique_ok integer;
  bad_confidence_rejected boolean := false;
  missing_reason_rejected boolean := false;
  promoted_without_proposal_rejected boolean := false;
  dismissed_without_reason_rejected boolean := false;
  partial_actionable_rejected boolean := false;
  control_ok boolean := false;
  missing text := '';
  probe_org constant varchar := 'verify-087';
  probe_signal constant varchar := 'SIG-DEVIATION_REPEAT-verify-087-30d-low';
BEGIN
  SELECT count(*) INTO tbl_ok FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_learning_signal'
      AND column_name IN (
        'signal_id', 'kind', 'severity', 'status', 'subject_key', 'window_days', 'sample_size',
        'confidence', 'direction', 'rule_id', 'parameter', 'baseline_value',
        'metrics_json', 'evidence_json', 'narrative_json', 'not_actionable_reason',
        'promoted_proposal_id', 'decided_by', 'decided_at', 'decided_reason',
        'first_seen_at', 'last_seen_at', 'record_json', 'org_id'
      );
  IF tbl_ok <> 24 THEN missing := missing || format('columns=%s ', tbl_ok); END IF;

  SELECT count(*) INTO rls_ok FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_signal' AND c.relrowsecurity;
  IF rls_ok <> 1 THEN missing := missing || format('rls_disabled=%s ', rls_ok); END IF;

  SELECT count(*) INTO policy_ok FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_learning_signal'
      AND policyname = 'learning_signal_org_isolation'
      AND qual LIKE '%app.current_org_id%' AND with_check LIKE '%app.current_org_id%';
  IF policy_ok <> 1 THEN missing := missing || format('policy_missing=%s ', policy_ok); END IF;

  SELECT count(*) INTO unique_ok FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_learning_signal'
      AND con.conname = 'uq_ewoh_learning_signal' AND con.contype = 'u';
  IF unique_ok <> 1 THEN missing := missing || format('unique_missing=%s ', unique_ok); END IF;

  -- 契约兜底 1：样本不足不许给可信度（sample_size=2 + confidence=high）
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size, confidence,
       metrics_json, evidence_json, narrative_json, not_actionable_reason, first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal || '-conf', 'deviation_repeat', 'low', 'open', 'device:X', 30, 2, 'high',
       '{"count":2}'::jsonb, '[{"type":"execution_deviation","id":"x","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, '证据不足', now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'confidence_without_sample 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_confidence_rejected := true;
  END;

  -- 契约兜底 2：既不可执行、又不给理由 → 拒绝
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size,
       metrics_json, evidence_json, narrative_json, first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal || '-reason', 'deviation_repeat', 'low', 'open', 'device:X', 30, 9,
       '{"count":9}'::jsonb, '[{"type":"execution_deviation","id":"x","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'missing_reason 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    missing_reason_rejected := true;
  END;

  -- 契约兜底 3：promoted 必须带提案号与决定人
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size, confidence,
       rule_id, parameter, baseline_value, direction,
       metrics_json, evidence_json, narrative_json, first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal || '-promoted', 'notification_fatigue', 'high', 'promoted', 'andon', 30, 9, 'medium',
       'rule:worker-overload', 'workloadThreshold', 0.7, 'raise',
       '{"pending":9}'::jsonb, '[{"type":"notification_kind","id":"andon","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'promoted_without_proposal 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    promoted_without_proposal_rejected := true;
  END;

  -- 契约兜底 4：dismissed 必须带非空理由
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size,
       metrics_json, evidence_json, narrative_json, not_actionable_reason,
       decided_by, decided_at, first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal || '-dismissed', 'deviation_repeat', 'low', 'dismissed', 'device:X', 30, 9,
       '{"count":9}'::jsonb, '[{"type":"execution_deviation","id":"x","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, '不可提案',
       'lead.chen', now(), now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'dismissed_without_reason 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    dismissed_without_reason_rejected := true;
  END;

  -- 契约兜底 5：可执行三件套必须齐全（只给 rule_id 不给 baseline → 拒绝）
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size, confidence,
       rule_id, metrics_json, evidence_json, narrative_json, first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal || '-partial', 'notification_fatigue', 'medium', 'open', 'andon', 30, 9, 'medium',
       'rule:worker-overload',
       '{"pending":9}'::jsonb, '[{"type":"notification_kind","id":"andon","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'partial_actionable 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    partial_actionable_rejected := true;
  END;

  -- 控制组：合法信号可写可读可删（不留脏数据）
  BEGIN
    INSERT INTO ewoh_learning_signal
      (org_id, signal_id, kind, severity, status, subject_key, window_days, sample_size,
       metrics_json, evidence_json, narrative_json, not_actionable_reason,
       first_seen_at, last_seen_at, record_json)
    VALUES
      (probe_org, probe_signal, 'deviation_repeat', 'low', 'open', 'device:X', 30, 4,
       '{"count":4}'::jsonb, '[{"type":"execution_deviation","id":"x","at":null}]'::jsonb,
       '{"hypothesis":"h","expectedEffect":"e","risk":"r","missing":[]}'::jsonb, '需人定根因',
       now(), now(), '{"signalId":"x"}'::jsonb);
    control_ok := EXISTS (SELECT 1 FROM ewoh_learning_signal WHERE org_id = probe_org AND signal_id = probe_signal);
    DELETE FROM ewoh_learning_signal WHERE org_id = probe_org AND signal_id = probe_signal;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_learning_signal WHERE org_id = probe_org;
  END;

  IF missing <> '' OR NOT bad_confidence_rejected OR NOT missing_reason_rejected
     OR NOT promoted_without_proposal_rejected OR NOT dismissed_without_reason_rejected
     OR NOT partial_actionable_rejected OR NOT control_ok THEN
    RAISE EXCEPTION 'standalone_087 verify incomplete: % confidence=% reason=% promoted=% dismissed=% actionable=% control=%',
      missing, bad_confidence_rejected, missing_reason_rejected,
      promoted_without_proposal_rejected, dismissed_without_reason_rejected,
      partial_actionable_rejected, control_ok;
  END IF;
  RAISE NOTICE '087 verify OK: 24 cols + RLS + unique + 5 类契约兜底拒绝 + 控制组写入删除';
END $$;

SELECT 1 AS standalone_087_verified;
