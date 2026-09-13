-- 091 verify：两列存在且契约兜底真的会拦（半成品引用、未完成却带回流）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  cols integer;
  pair_rejected boolean := false;
  incomplete_rejected boolean := false;
  control_ok boolean := false;
  probe_org constant varchar := 'verify-091';
  probe_action constant varchar := 'ACT-lesson-verify-091-outcome';
  evidence constant jsonb := '[{"type":"retrospective","id":"RTR-1","at":null}]'::jsonb;
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_improvement_action'
      AND column_name IN ('outcome_ref', 'outcome_kind');
  IF cols <> 2 THEN RAISE EXCEPTION '091 verify FAILED: columns=%', cols; END IF;

  -- 兜底 1：只给 outcome_ref 不给 kind（半成品）
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, owner, due_at, acceptance_criteria, accepted_by, accepted_at,
       completed_by, completed_at, outcome_note, outcome_ref, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-1', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'completed',
       evidence, 'P-1', now(), 'c', 'lead.chen', now(), 'P-1', now(), 'done', 'KN-1', now(), '{}'::jsonb);
    RAISE EXCEPTION 'outcome_pair 未被拒绝';
  EXCEPTION WHEN check_violation THEN pair_rejected := true;
  END;

  -- 兜底 2：未完成却带回流引用
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, outcome_ref, outcome_kind, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-2', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, 'KN-2', 'knowledge_entry', now(), '{}'::jsonb);
    RAISE EXCEPTION 'incomplete_outcome 未被拒绝';
  EXCEPTION WHEN check_violation THEN incomplete_rejected := true;
  END;

  -- 控制组：完成 + 回流引用可写可读可删
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, owner, due_at, acceptance_criteria, accepted_by, accepted_at,
       completed_by, completed_at, outcome_note, outcome_ref, outcome_kind, detected_at, record_json)
    VALUES
      (probe_org, probe_action, 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'completed',
       evidence, 'P-1', now(), 'c', 'lead.chen', now(), 'P-1', now(), 'done', 'KN-OK', 'knowledge_entry', now(), '{}'::jsonb);
    control_ok := EXISTS (SELECT 1 FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action);
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org;
  END;

  IF NOT pair_rejected OR NOT incomplete_rejected OR NOT control_ok THEN
    RAISE EXCEPTION '091 verify incomplete: pair=% incomplete=% control=%', pair_rejected, incomplete_rejected, control_ok;
  END IF;
  RAISE NOTICE '091 verify OK: outcome_ref/outcome_kind 就位 + 半成品/未完成引用被拒 + 控制组通过';
END $$;

SELECT 1 AS standalone_091_verified;
