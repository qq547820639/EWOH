-- standalone_076 verify：数据质量确认台账「存在且约束真的生效」。
-- 探测：verdict 词表外值必须被拒绝；同事件第二条确认必须被唯一键拒绝（幂等）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  verdict_rejected boolean := false;
  dup_rejected boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_data_quality_confirmation'
  ) THEN
    RAISE EXCEPTION 'standalone_076: ewoh_data_quality_confirmation 表缺失（迁移未应用）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_data_quality_confirmation (
      org_id, event_id, verdict, confirmed_by, confirmed_at
    ) VALUES (
      '__probe_076__', '__probe_076_bad_verdict__', 'maybe', 'probe-user', now()
    );
  EXCEPTION WHEN check_violation THEN
    verdict_rejected := true;
  END;
  DELETE FROM __EWOH_SCHEMA__.ewoh_data_quality_confirmation WHERE org_id = '__probe_076__';
  IF NOT verdict_rejected THEN
    RAISE EXCEPTION 'standalone_076: chk_ewoh_dq_confirmation_verdict 未拒绝词表外 verdict（约束未生效）';
  END IF;

  INSERT INTO __EWOH_SCHEMA__.ewoh_data_quality_confirmation (
    org_id, event_id, verdict, confirmed_by, confirmed_at
  ) VALUES (
    '__probe_076__', '__probe_076_event__', 'confirmed', 'probe-user', now()
  );
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_data_quality_confirmation (
      org_id, event_id, verdict, confirmed_by, confirmed_at
    ) VALUES (
      '__probe_076__', '__probe_076_event__', 'contested', 'probe-user-2', now()
    );
  EXCEPTION WHEN unique_violation THEN
    dup_rejected := true;
  END;
  DELETE FROM __EWOH_SCHEMA__.ewoh_data_quality_confirmation WHERE org_id = '__probe_076__';
  IF NOT dup_rejected THEN
    RAISE EXCEPTION 'standalone_076: uq_ewoh_dq_confirmation 未拒绝同事件第二条确认（幂等约束未生效）';
  END IF;
END $$;

SELECT CASE WHEN
  EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_data_quality_confirmation')
  AND (SELECT relrowsecurity FROM pg_class
    WHERE oid = '__EWOH_SCHEMA__.ewoh_data_quality_confirmation'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_data_quality_confirmation'
      AND policyname = 'dq_confirmation_org_isolation')
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_data_quality_confirmation
        WHERE org_id = '__probe_076__') = 0
  THEN 1 ELSE 0 END AS standalone_076_verified;
