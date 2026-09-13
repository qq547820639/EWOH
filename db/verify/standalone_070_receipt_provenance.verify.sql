SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);
SELECT CASE WHEN
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema()
    AND table_name = 'ewoh_scheduling_feedback'
    AND ((column_name = 'receipt_source' AND data_type = 'character varying' AND is_nullable = 'NO' AND column_default LIKE '%unknown%')
      OR (column_name = 'production_training_eligible' AND data_type = 'boolean' AND is_nullable = 'NO' AND column_default = 'false')
      OR (column_name = 'provenance_json' AND data_type = 'jsonb'))) = 3
  AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = '__EWOH_SCHEMA__.ewoh_scheduling_feedback'::regclass AND conname = 'ck_feedback_receipt_provenance' AND convalidated)
  AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_feedback_real_training' AND indexdef LIKE '%WHERE%production_training_eligible%')
  THEN 1 ELSE 0 END AS standalone_070_verified;
