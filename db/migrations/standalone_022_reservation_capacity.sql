-- EWOH P0-7 — capacity-aware station reservation (DB guard split)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: guarded DROP/ADD via pg_constraint checks.
--
-- Problem: standalone_009_reservation_conflict.sql added a **binary** EXCLUDE
-- constraint on ewoh_resource_reservation for ALL resource types (station/person/
-- device/tool/material/vehicle). For stations with capacity > 1 the solver schedules
-- multiple overlapping tasks on the same station (AddCumulative capacity), but the
-- binary EXCLUDE rejects the second overlapping preemption → RESOURCE_CONFLICT even
-- though capacity allows it.
--
-- Fix (additive, backward compatible): keep the DB EXCLUDE hard backstop for
-- person/device only (capacity is always 1). Station capacity is enforced by the
-- application layer (ResourceReservationService counts active overlapping
-- reservations < capacity) + pg_advisory_xact_lock serialization inside the same
-- transaction.
--
-- Rollback: standalone_022_reservation_capacity.rollback.sql restores the old
-- unfiltered EXCLUDE constraint.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ewoh_resource_reservation_no_overlap'
      AND conrelid = '__EWOH_SCHEMA__.ewoh_resource_reservation'::regclass
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation
      DROP CONSTRAINT ewoh_resource_reservation_no_overlap;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ewoh_resource_reservation_no_overlap_person_device'
      AND conrelid = '__EWOH_SCHEMA__.ewoh_resource_reservation'::regclass
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_reservation
      ADD CONSTRAINT ewoh_resource_reservation_no_overlap_person_device
      EXCLUDE USING gist (
        resource_type WITH =,
        resource_id WITH =,
        tstzrange(to_timestamp(start_ms / 1000.0), to_timestamp(end_ms / 1000.0)) WITH &&
      )
      WHERE (status IN ('reserved', 'active') AND resource_type IN ('person', 'device'));
  END IF;
END $$;

COMMENT ON CONSTRAINT ewoh_resource_reservation_no_overlap_person_device
  ON __EWOH_SCHEMA__.ewoh_resource_reservation
  IS 'Blocks overlapping active person/device reservations (capacity=1). Station capacity (>1) is enforced by the application layer (capacity-aware counting + advisory lock).';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_reservation TO service_role;
