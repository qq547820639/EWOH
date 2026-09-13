-- 085 verify：交接班快照列就位（jsonb、可空），既有列未受影响。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_shift_handover'
      AND column_name = 'responsibility_snapshot_json'
      AND data_type = 'jsonb'
      AND is_nullable = 'YES') = 1
  -- 既有语义未破坏：open_items_json / status / to_user_id 仍在
  AND (SELECT count(*) FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'ewoh_shift_handover'
          AND column_name IN ('open_items_json', 'status', 'to_user_id')) = 3
  AND (SELECT relrowsecurity FROM pg_class
        WHERE oid = '__EWOH_SCHEMA__.ewoh_shift_handover'::regclass) = true
  THEN 1 ELSE 0 END AS standalone_085_verified;
