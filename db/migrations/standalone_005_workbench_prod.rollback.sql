-- EWOH Role Workbench production persistence rollback (2.A database artifacts)
-- DESTRUCTIVE: drops the tables created by standalone_005_workbench_prod.sql and
-- removes the org_id columns added to the workbench source tables.
-- Reverse dependency order; every DROP/ALTER guarded with IF EXISTS for re-entrancy.
--
-- 审计 SQL-040 修复（2026-08-17）：001 在 6 张源表上创建的 RLS policy
-- （ewoh_org_select / ewoh_service_all）引用 org_id 列——原实现直接
-- DROP COLUMN 会使残留 policy 失效（后续查询报 undefined column）。
-- 现改为先 DROP POLICY 再 DROP COLUMN，次序安全且幂等。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DROP TABLE IF EXISTS __EWOH_SCHEMA__.workbench_export_tasks CASCADE;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.saved_views CASCADE;

-- Remove org_id columns added to the workbench source tables (indexes drop with
-- the column). Drop the RLS policies referencing org_id FIRST (see header).
DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_schedule_task;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_schedule_task;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task DROP COLUMN IF EXISTS org_id;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_schedule_task_step;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_schedule_task_step;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_task_step DROP COLUMN IF EXISTS org_id;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_event;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_event;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DROP COLUMN IF EXISTS org_id;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_world_state;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_world_state;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state DROP COLUMN IF EXISTS org_id;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_spatial_entity;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_spatial_entity;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DROP COLUMN IF EXISTS org_id;

DROP POLICY IF EXISTS ewoh_org_select ON __EWOH_SCHEMA__.ewoh_resource_binding;
DROP POLICY IF EXISTS ewoh_service_all ON __EWOH_SCHEMA__.ewoh_resource_binding;
ALTER TABLE __EWOH_SCHEMA__.ewoh_resource_binding DROP COLUMN IF EXISTS org_id;
