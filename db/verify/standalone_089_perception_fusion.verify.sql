-- 089 verify：感知融合快照表就位 —— 列/RLS/唯一键逐项可验，并且**契约兜底真的会拦**
-- （无可用源却给级别/分数、低置信/冲突却允许强建议、分数越界、窗口倒置）。
-- 空库可跑、跑完不留脏数据。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  cols integer;
  rls_ok integer;
  policy_ok integer;
  unique_ok integer;
  no_source_rejected boolean := false;
  strong_advice_rejected boolean := false;
  score_rejected boolean := false;
  window_rejected boolean := false;
  conflict_advice_rejected boolean := false;
  control_ok boolean := false;
  missing text := '';
  probe_org constant varchar := 'verify-089';
  probe_id constant varchar := 'FUSE-person:P-1-1789200000000';
BEGIN
  SELECT count(*) INTO cols FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_perception_fusion'
      AND column_name IN (
        'fusion_id', 'subject_id', 'window_start', 'window_end', 'fused_at', 'agreement',
        'confidence_level', 'confidence_score', 'degraded', 'strong_advice_allowed',
        'station_id', 'conflict_count', 'usable_source_count', 'sources_json',
        'conflicts_json', 'rule_trace_json', 'record_json', 'org_id'
      );
  IF cols <> 18 THEN missing := missing || format('columns=%s ', cols); END IF;

  SELECT count(*) INTO rls_ok FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_perception_fusion' AND c.relrowsecurity;
  IF rls_ok <> 1 THEN missing := missing || format('rls_disabled=%s ', rls_ok); END IF;

  SELECT count(*) INTO policy_ok FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_perception_fusion'
      AND policyname = 'perception_fusion_org_isolation'
      AND qual LIKE '%app.current_org_id%' AND with_check LIKE '%app.current_org_id%';
  IF policy_ok <> 1 THEN missing := missing || format('policy_missing=%s ', policy_ok); END IF;

  SELECT count(*) INTO unique_ok FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_perception_fusion'
      AND con.conname = 'uq_ewoh_perception_fusion' AND con.contype = 'u';
  IF unique_ok <> 1 THEN missing := missing || format('unique_missing=%s ', unique_ok); END IF;

  -- 兜底 1：无可用源却给 high + 分数
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count, sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id || '-1', 'person:P-1', now() - interval '1 minute', now(), now(), 'insufficient',
       'high', 0.9, 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'no_source_with_level 未被拒绝';
  EXCEPTION WHEN check_violation THEN no_source_rejected := true;
  END;

  -- 兜底 2：insufficient 却允许强建议
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count, strong_advice_allowed,
       sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id || '-2', 'person:P-1', now() - interval '1 minute', now(), now(), 'insufficient',
       'unknown', NULL, 0, true, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'strong_advice_on_insufficient 未被拒绝';
  EXCEPTION WHEN check_violation THEN strong_advice_rejected := true;
  END;

  -- 兜底 3：conflict 且有冲突数却允许强建议
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count, strong_advice_allowed, conflict_count,
       sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id || '-3', 'person:P-1', now() - interval '1 minute', now(), now(), 'conflict',
       'medium', 0.6, 2, true, 1, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'strong_advice_on_conflict 未被拒绝';
  EXCEPTION WHEN check_violation THEN conflict_advice_rejected := true;
  END;

  -- 兜底 4：分数越界
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count,
       sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id || '-4', 'person:P-1', now() - interval '1 minute', now(), now(), 'partial',
       'medium', 1.7, 2, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'score_out_of_range 未被拒绝';
  EXCEPTION WHEN check_violation THEN score_rejected := true;
  END;

  -- 兜底 5：窗口倒置
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count,
       sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id || '-5', 'person:P-1', now(), now() - interval '1 minute', now(), 'partial',
       'medium', 0.5, 2, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb);
    RAISE EXCEPTION 'window_inverted 未被拒绝';
  EXCEPTION WHEN check_violation THEN window_rejected := true;
  END;

  -- 控制组：合法快照可写可读可删
  BEGIN
    INSERT INTO ewoh_perception_fusion
      (org_id, fusion_id, subject_id, window_start, window_end, fused_at, agreement,
       confidence_level, confidence_score, usable_source_count, strong_advice_allowed, station_id,
       sources_json, conflicts_json, rule_trace_json, record_json)
    VALUES
      (probe_org, probe_id, 'person:P-1', now() - interval '1 minute', now(), now(), 'consistent',
       'high', 0.88, 5, true, 'ST-1',
       '[{"source":"uwb","status":"usable"}]'::jsonb, '[]'::jsonb, '[{"rule":"rule1","fired":true}]'::jsonb, '{"subjectId":"person:P-1"}'::jsonb);
    control_ok := EXISTS (SELECT 1 FROM ewoh_perception_fusion WHERE org_id = probe_org AND fusion_id = probe_id);
    DELETE FROM ewoh_perception_fusion WHERE org_id = probe_org AND fusion_id = probe_id;
  EXCEPTION WHEN OTHERS THEN
    control_ok := false;
    DELETE FROM ewoh_perception_fusion WHERE org_id = probe_org;
  END;

  IF missing <> '' OR NOT no_source_rejected OR NOT strong_advice_rejected OR NOT conflict_advice_rejected
     OR NOT score_rejected OR NOT window_rejected OR NOT control_ok THEN
    RAISE EXCEPTION 'standalone_089 verify incomplete: % no_source=% advice=% conflict_advice=% score=% window=% control=%',
      missing, no_source_rejected, strong_advice_rejected, conflict_advice_rejected,
      score_rejected, window_rejected, control_ok;
  END IF;
  RAISE NOTICE '089 verify OK: 18 cols + RLS + unique + 5 类契约兜底拒绝 + 控制组写入删除';
END $$;

SELECT 1 AS standalone_089_verified;
