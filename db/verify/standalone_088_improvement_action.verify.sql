-- 088 verify：改进行动项台账就位 —— 列/RLS/唯一键逐项可验，并且**契约兜底真的会拦**
-- （接受无判据、完成无结果、拒绝无理由、proposed 带完成时间、无证据）。
-- 空库可跑、跑完不留脏数据。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  cols integer;
  rls_ok integer;
  policy_ok integer;
  unique_ok integer;
  accepted_no_criteria boolean := false;
  completed_no_outcome boolean := false;
  rejected_no_reason boolean := false;
  proposed_with_completion boolean := false;
  empty_evidence boolean := false;
  control_ok boolean := false;
  missing text := '';
  probe_org constant varchar := 'verify-088';
  probe_action constant varchar := 'ACT-lesson-verify-088-check-backup';
  evidence constant jsonb := '[{"type":"retrospective","id":"RTR-1","at":null}]'::jsonb;
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_improvement_action'
      AND column_name IN (
        'action_id', 'source_type', 'source_ref', 'title', 'detail', 'kind', 'kind_source',
        'priority', 'status', 'evidence_json', 'owner', 'due_at', 'acceptance_criteria',
        'accepted_by', 'accepted_at', 'completed_by', 'completed_at', 'outcome_note',
        'decided_by', 'decided_at', 'decided_reason', 'detected_at', 'record_json', 'org_id'
      );
  IF cols <> 24 THEN missing := missing || format('columns=%s ', cols); END IF;

  SELECT count(*) INTO rls_ok FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_improvement_action' AND c.relrowsecurity;
  IF rls_ok <> 1 THEN missing := missing || format('rls_disabled=%s ', rls_ok); END IF;

  SELECT count(*) INTO policy_ok FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_improvement_action'
      AND policyname = 'improvement_action_org_isolation'
      AND qual LIKE '%app.current_org_id%' AND with_check LIKE '%app.current_org_id%';
  IF policy_ok <> 1 THEN missing := missing || format('policy_missing=%s ', policy_ok); END IF;

  SELECT count(*) INTO unique_ok FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_improvement_action'
      AND con.conname = 'uq_ewoh_improvement_action' AND con.contype = 'u';
  IF unique_ok <> 1 THEN missing := missing || format('unique_missing=%s ', unique_ok); END IF;

  -- 兜底 1：accepted 但缺验收判据
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, owner, due_at, accepted_by, accepted_at, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-1', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'accepted',
       evidence, 'P-1', now(), 'lead.chen', now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'accepted_without_criteria 未被拒绝';
  EXCEPTION WHEN check_violation THEN accepted_no_criteria := true;
  END;

  -- 兜底 2：completed 但缺结果说明
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, owner, due_at, acceptance_criteria, accepted_by, accepted_at,
       completed_by, completed_at, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-2', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'completed',
       evidence, 'P-1', now(), 'c', 'lead.chen', now(), 'P-1', now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'completed_without_outcome 未被拒绝';
  EXCEPTION WHEN check_violation THEN completed_no_outcome := true;
  END;

  -- 兜底 3：rejected 但无理由
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, decided_by, decided_at, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-3', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'rejected',
       evidence, 'lead.chen', now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'rejected_without_reason 未被拒绝';
  EXCEPTION WHEN check_violation THEN rejected_no_reason := true;
  END;

  -- 兜底 4：proposed 却带完成时间（状态与事实矛盾）
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, completed_at, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-4', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, now(), now(), '{}'::jsonb);
    RAISE EXCEPTION 'proposed_with_completion 未被拒绝';
  EXCEPTION WHEN check_violation THEN proposed_with_completion := true;
  END;

  -- 兜底 5：没有证据
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-5', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       '[]'::jsonb, now(), '{}'::jsonb);
    RAISE EXCEPTION 'empty_evidence 未被拒绝';
  EXCEPTION WHEN check_violation THEN empty_evidence := true;
  END;

  -- 控制组：合法行动项可写可读可删（不留脏数据）
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, kind_source, priority, status,
       evidence_json, detected_at, record_json)
    VALUES
      (probe_org, probe_action, 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'suggested', 'high', 'proposed',
       evidence, now(), '{"actionId":"x"}'::jsonb);
    control_ok := EXISTS (SELECT 1 FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action);
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org;
  END;

  IF missing <> '' OR NOT accepted_no_criteria OR NOT completed_no_outcome OR NOT rejected_no_reason
     OR NOT proposed_with_completion OR NOT empty_evidence OR NOT control_ok THEN
    RAISE EXCEPTION 'standalone_088 verify incomplete: % accepted=% completed=% rejected=% proposed=% evidence=% control=%',
      missing, accepted_no_criteria, completed_no_outcome, rejected_no_reason,
      proposed_with_completion, empty_evidence, control_ok;
  END IF;
  RAISE NOTICE '088 verify OK: 24 cols + RLS + unique + 5 类契约兜底拒绝 + 控制组写入删除';
END $$;

SELECT 1 AS standalone_088_verified;
