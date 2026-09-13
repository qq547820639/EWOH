ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback
  ADD COLUMN IF NOT EXISTS receipt_source varchar(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS production_training_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS provenance_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '__EWOH_SCHEMA__.ewoh_scheduling_feedback'::regclass
      AND conname = 'ck_feedback_receipt_provenance'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback
      ADD CONSTRAINT ck_feedback_receipt_provenance CHECK (
        receipt_source IN ('real', 'simulated', 'unknown')
        AND (NOT production_training_eligible OR (
          receipt_source = 'real'
          AND actual_start IS NOT NULL
          AND actual_end IS NOT NULL
          AND actual_end >= actual_start
          AND provenance_json IS NOT NULL
          AND provenance_json->>'policy' IS NOT DISTINCT FROM 'receipt-provenance-v1'
        ))
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_feedback_real_training
  ON __EWOH_SCHEMA__.ewoh_scheduling_feedback (org_id, _updated_at DESC)
  WHERE production_training_eligible = true AND receipt_source = 'real';
