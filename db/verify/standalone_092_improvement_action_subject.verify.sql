-- 092 verify：两列存在 + 成对约束真的会拦（半成品归属、未知类型）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  cols integer;
  pair_rejected boolean := false;
  type_rejected boolean := false;
  id_only_rejected boolean := false;
  control_ok boolean := false;
  probe_org constant varchar := 'verify-092';
  probe_action constant varchar := 'ACT-lesson-verify-092-subject';
  evidence constant jsonb := '[{"type":"retrospective","id":"RTR-1","at":null}]'::jsonb;
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_improvement_action'
      AND column_name IN ('subject_type', 'subject_id');
  IF cols <> 2 THEN RAISE EXCEPTION '092 verify FAILED: columns=%', cols; END IF;

  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, subject_type, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-1', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, 'device', now(), '{}'::jsonb);
    RAISE EXCEPTION 'subject_pair 未被拒绝';
  EXCEPTION WHEN check_violation THEN pair_rejected := true;
  END;

  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, subject_type, subject_id, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-2', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, 'magic', 'X-1', now(), '{}'::jsonb);
    RAISE EXCEPTION 'subject_type 未被拒绝';
  EXCEPTION WHEN check_violation THEN type_rejected := true;
  END;

  -- 只给 id 不给类型（三值逻辑漏洞的反向探测：`subject_type = NULL` 时 IN 求值为 NULL）
  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, subject_id, detected_at, record_json)
    VALUES
      (probe_org, probe_action || '-3', 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, 'DEV-1', now(), '{}'::jsonb);
    RAISE EXCEPTION 'subject_id 单独存在未被拒绝';
  EXCEPTION WHEN check_violation THEN id_only_rejected := true;
  END;

  BEGIN
    INSERT INTO ewoh_improvement_action
      (org_id, action_id, source_type, source_ref, title, detail, kind, priority, status,
       evidence_json, subject_type, subject_id, detected_at, record_json)
    VALUES
      (probe_org, probe_action, 'retrospective_lesson', 'RTR-1', 't', 'd', 'process_change', 'high', 'proposed',
       evidence, 'device', 'DEV-1', now(), '{}'::jsonb);
    control_ok := EXISTS (SELECT 1 FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action);
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org AND action_id = probe_action;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_improvement_action WHERE org_id = probe_org;
  END;

  IF NOT pair_rejected OR NOT type_rejected OR NOT id_only_rejected OR NOT control_ok THEN
    RAISE EXCEPTION '092 verify incomplete: pair=% type=% id_only=% control=%',
      pair_rejected, type_rejected, id_only_rejected, control_ok;
  END IF;
  RAISE NOTICE '092 verify OK: subject_type/subject_id 就位 + 半成品（含只有 id 无类型）/未知类型被拒 + 控制组通过';
END $$;

SELECT 1 AS standalone_092_verified;
