-- standalone_075 verify：复盘台账「存在且约束真的生效」。
-- 探测：scope 词表外值必须被拒绝；同 target 部分唯一索引（status<>superseded）
-- 必须拒绝第二条有效复盘，而 superseded 后允许重建。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
DECLARE
  scope_rejected boolean := false;
  dup_active_rejected boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_retrospective'
  ) THEN
    RAISE EXCEPTION 'standalone_075: ewoh_retrospective 表缺失（迁移未应用）';
  END IF;

  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_retrospective (
      org_id, retrospective_id, scope, target_id, title, assembled_json
    ) VALUES (
      '__probe_075__', '__probe_075_bad_scope__', 'not_a_scope',
      'PLAN-X', '探测', '{}'::jsonb
    );
  EXCEPTION WHEN check_violation THEN
    scope_rejected := true;
  END;
  DELETE FROM __EWOH_SCHEMA__.ewoh_retrospective WHERE org_id = '__probe_075__';
  IF NOT scope_rejected THEN
    RAISE EXCEPTION 'standalone_075: chk_ewoh_retrospective_scope 未拒绝词表外 scope（约束未生效）';
  END IF;

  INSERT INTO __EWOH_SCHEMA__.ewoh_retrospective (
    org_id, retrospective_id, scope, target_id, title, assembled_json
  ) VALUES (
    '__probe_075__', '__probe_075_first__', 'plan', 'PLAN-DUP', '第一条', '{}'::jsonb
  );
  BEGIN
    INSERT INTO __EWOH_SCHEMA__.ewoh_retrospective (
      org_id, retrospective_id, scope, target_id, title, assembled_json
    ) VALUES (
      '__probe_075__', '__probe_075_second__', 'plan', 'PLAN-DUP', '第二条', '{}'::jsonb
    );
  EXCEPTION WHEN unique_violation THEN
    dup_active_rejected := true;
  END;
  -- superseded 后允许重建（部分唯一索引只约束 status <> 'superseded'）。
  UPDATE __EWOH_SCHEMA__.ewoh_retrospective
    SET status = 'superseded'
    WHERE org_id = '__probe_075__' AND retrospective_id = '__probe_075_first__';
  INSERT INTO __EWOH_SCHEMA__.ewoh_retrospective (
    org_id, retrospective_id, scope, target_id, title, assembled_json
  ) VALUES (
    '__probe_075__', '__probe_075_third__', 'plan', 'PLAN-DUP', '重建', '{}'::jsonb
  );
  DELETE FROM __EWOH_SCHEMA__.ewoh_retrospective WHERE org_id = '__probe_075__';
  IF NOT dup_active_rejected THEN
    RAISE EXCEPTION 'standalone_075: uq_ewoh_retrospective_active_target 未拒绝同 target 第二条有效复盘（索引未生效）';
  END IF;
END $$;

SELECT CASE WHEN
  EXISTS (SELECT 1 FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = 'ewoh_retrospective')
  AND (SELECT relrowsecurity FROM pg_class
    WHERE oid = '__EWOH_SCHEMA__.ewoh_retrospective'::regclass)
  AND EXISTS (SELECT 1 FROM pg_policies
    WHERE schemaname = current_schema() AND tablename = 'ewoh_retrospective'
      AND policyname = 'retrospective_org_isolation')
  AND EXISTS (SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'ewoh_retrospective'
      AND indexname = 'uq_ewoh_retrospective_active_target')
  AND (SELECT count(*) FROM __EWOH_SCHEMA__.ewoh_retrospective
        WHERE org_id = '__probe_075__') = 0
  THEN 1 ELSE 0 END AS standalone_075_verified;
