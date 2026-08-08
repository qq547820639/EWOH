-- EWOH Dispatch atomic preemption — DB guard rollback (Task 2)
-- DESTRUCTIVE-optional: removes the exclusion constraint added by
-- standalone_009_reservation_conflict.sql. Guarded with IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation
  DROP CONSTRAINT IF EXISTS ewoh_resource_reservation_no_overlap;