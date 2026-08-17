-- EWOH Dispatch atomic preemption — station/person/device double-booking DB guard (Task 2)
-- Schema placeholder: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE EXTENSION IF NOT EXISTS + DO-block guarded ADD CONSTRAINT.
--
-- Adds a database-level EXCLUDE constraint on ewoh_resource_reservation so that two
-- concurrent dispatches can never reserve the same resource (station / person / device /
-- tool / material / vehicle) over an overlapping time window while either reservation is
-- active (status reserved|active).
--
-- The application-level check-then-insert in ResourceReservationService remains the fast
-- path; this constraint is the hard backstop that serializes truly concurrent inserts and
-- fails the losing transaction, guaranteeing "no overlapping reservation" at the DB layer.
--
-- 迁移顺序兼容（审计 SQL-004 修复，2026-08-17）：ewoh_resource_reservation 由
-- standalone_017_scheduling_tables_fix.sql 补建（017 编号晚于 009）。空库按文件名
-- 顺序执行时本迁移先于 017 运行——DO 块以 to_regclass 守卫：表不存在时静默跳过
-- （本约束随后由 022 的 person/device 版 EXCLUDE 演进承接，最终形态以 022 为准）；
-- 已应用库重跑时表已存在，行为与原迁移一致（幂等无变更）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- btree_gist provides the `=` operators for varchar columns inside a gist EXCLUDE index.
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF to_regclass('__EWOH_SCHEMA__.ewoh_resource_reservation') IS NOT NULL THEN
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

    EXECUTE 'COMMENT ON CONSTRAINT ewoh_resource_reservation_no_overlap'
         || ' ON __EWOH_SCHEMA__.ewoh_resource_reservation'
         || ' IS ''Blocks overlapping active reservations for the same resource (station/person/device/tool/material/vehicle)''';

    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_reservation TO service_role';
  END IF;
END $$;
