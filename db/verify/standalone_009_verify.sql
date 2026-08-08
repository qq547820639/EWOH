-- EWOH Dispatch atomic preemption — DB guard verification (Task 2)
-- Returns a single row with:
--   reservation_no_overlap_guard — 1 if the no-overlap exclusion constraint exists
-- A result of 1 means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM pg_constraint c
    WHERE c.conname = 'ewoh_resource_reservation_no_overlap'
      AND c.conrelid = '__EWOH_SCHEMA__.ewoh_resource_reservation'::regclass
  ) AS reservation_no_overlap_guard;