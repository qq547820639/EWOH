-- EWOH Role Workbench production persistence rollback (2.A database artifacts)
-- DESTRUCTIVE: drops the tables created by standalone_005_workbench_prod.sql and
-- removes the org_id columns added to the workbench source tables.
-- Reverse dependency order; every DROP/ALTER guarded with IF EXISTS for re-entrancy.

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.workbench_export_tasks CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.saved_views CASCADE;

-- Remove org_id columns added to the workbench source tables (indexes drop with the column).
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DROP COLUMN IF EXISTS org_id;
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_binding DROP COLUMN IF EXISTS org_id;