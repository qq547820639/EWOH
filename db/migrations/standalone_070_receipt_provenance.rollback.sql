DROP INDEX IF EXISTS idx_feedback_real_training;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_feedback
  DROP CONSTRAINT IF EXISTS ck_feedback_receipt_provenance,
  DROP COLUMN IF EXISTS provenance_json,
  DROP COLUMN IF EXISTS production_training_eligible,
  DROP COLUMN IF EXISTS receipt_source;
