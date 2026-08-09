-- EWOH P0-7 — capacity-aware station reservation: rollback
-- Restores the original unfiltered EXCLUDE constraint from standalone_009.
-- Re-entrant: guarded DROP/ADD via pg_constraint checks.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation
  DROP CONSTRAINT IF EXISTS ewoh_resource_reservation_no_overlap_person_device;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ewoh_resource_reservation_no_overlap'
      AND conrelid = '__EWOH_SCHEMA__.ewoh_resource_reservation'::regclass
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation
      ADD CONSTRAINT ewoh_resource_reservation_no_overlap
      EXCLUDE USING gist (
        resource_type WITH =,
        resource_id WITH =,
        tstzrange(to_timestamp(start_ms / 1000.0), to_timestamp(end_ms / 1000.0)) WITH &&
      )
      WHERE (status IN ('reserved', 'active'));
  END IF;
END $$;
