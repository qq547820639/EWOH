-- EWOH managed tables rollback (AG-10)
-- Drops new objects, reverses RLS/grants, and preserves data in retained additive columns.
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $ewoh_rollback_policies$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname, tablename FROM pg_policies
    WHERE schemaname = '__EWOH_SCHEMA__' AND tablename = ANY (ARRAY['ewoh_ai_suggestion', 'ewoh_device', 'ewoh_device_binding', 'ewoh_device_config', 'ewoh_environment', 'ewoh_event', 'ewoh_event_chain', 'ewoh_model_registry', 'ewoh_organization', 'ewoh_personnel', 'ewoh_production_task', 'ewoh_schedule_audit', 'ewoh_schedule_plan', 'ewoh_scheduler_config', 'ewoh_spatial_entity', 'ewoh_telemetry', 'ewoh_topology', 'ewoh_world_state', 'ewoh_person_skill', 'ewoh_skill', 'ewoh_role', 'ewoh_person_role', 'ewoh_device_capability', 'ewoh_spatial_relation', 'ewoh_spatial_hierarchy', 'ewoh_model_asset', 'ewoh_model_binding', 'ewoh_workstation', 'ewoh_workstation_device', 'ewoh_workstation_person', 'ewoh_workstation_skill', 'ewoh_workstation_relation', 'ewoh_task_template', 'ewoh_task_step', 'ewoh_task_skill_req', 'ewoh_schedule_task', 'ewoh_schedule_task_step', 'ewoh_schedule_assignment', 'ewoh_resource_preorder', 'ewoh_resource_binding', 'ewoh_control_request', 'ewoh_control_command', 'ewoh_control_result', 'ewoh_event_rule', 'ewoh_event_action', 'ewoh_event_subscription', 'ewoh_world_snapshot', 'ewoh_world_delta_log', 'ewoh_system_config', 'ewoh_knowledge_base', 'ewoh_knowledge_entry', 'ewoh_notification', 'ewoh_audit_log'])
    AND policyname IN ('ewoh_org_select', 'ewoh_service_all', 'ewoh_audit_select')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, '__EWOH_SCHEMA__', p.tablename);
  END LOOP;
END
$ewoh_rollback_policies$;

DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_append_audit_log(uuid, text, text, text, text, jsonb, jsonb, text, text, text, boolean, text);
DROP FUNCTION IF EXISTS __EWOH_SCHEMA__.ewoh_org_visible(uuid);
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_person_skill;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_skill;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_role;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_person_role;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_device_capability;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_spatial_relation;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_spatial_hierarchy;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_model_asset;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_model_binding;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_workstation;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_workstation_device;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_workstation_person;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_workstation_skill;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_workstation_relation;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_task_template;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_task_step;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_task_skill_req;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_schedule_task;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_schedule_task_step;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_schedule_assignment;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_resource_preorder;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_resource_binding;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_control_request;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_control_command;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_control_result;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_event_rule;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_event_action;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_event_subscription;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_world_snapshot;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_world_delta_log;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_system_config;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_knowledge_base;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_knowledge_entry;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_notification;
DROP TABLE IF EXISTS __EWOH_SCHEMA__.ewoh_audit_log;

-- Reverse NOT NULL org_id on existing tables while keeping additive columns for data preservation.
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_ai_suggestion_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_device_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_device_binding_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_device_config_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_environment_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_event_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_event_chain_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_model_registry_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_organization_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_personnel_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_production_task_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_schedule_audit_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_schedule_plan_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_scheduler_config_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_spatial_entity_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_telemetry_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_topology_org;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ALTER COLUMN org_id DROP DEFAULT;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state ALTER COLUMN org_id DROP NOT NULL;
DROP INDEX IF EXISTS idx_ewoh_world_state_org;
DO $ewoh_personnel_restore$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_personnel' AND column_name = 'org_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ALTER COLUMN org_id TYPE varchar(255) USING org_id::text;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = '__EWOH_SCHEMA__' AND table_name = 'ewoh_personnel' AND column_name = 'org_id_legacy'
    ) THEN
      UPDATE __EWOH_SCHEMA__.ewoh_personnel SET org_id = COALESCE(org_id_legacy, org_id) WHERE org_id_legacy IS NOT NULL;
      ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel DROP COLUMN IF EXISTS org_id_legacy;
    END IF;
  END IF;
END
$ewoh_personnel_restore$;

-- Restore equivalent permissive policies under ASCII names.
ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_ai_suggestion FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_ai_suggestion FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_ai_suggestion FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_ai_suggestion FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_binding ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_device_binding FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_device_binding FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_device_binding FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_device_binding FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_device_config FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_device_config FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_device_config FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_device_config FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_organization ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_organization FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_organization FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_organization FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_organization FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_personnel FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_personnel FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_personnel FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_personnel FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass ON __EWOH_SCHEMA__.ewoh_production_task FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all ON __EWOH_SCHEMA__.ewoh_production_task FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all ON __EWOH_SCHEMA__.ewoh_production_task FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_self ON __EWOH_SCHEMA__.ewoh_production_task FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (current_setting('app.user_id') = ANY (ARRAY[]::text[]) AND current_setting('app.user_id') = ((_created_by).user_id)::text);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduler_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY legacy_service_bypass_cfg ON __EWOH_SCHEMA__.ewoh_scheduler_config FOR ALL TO service_role_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_select_all_cfg ON __EWOH_SCHEMA__.ewoh_scheduler_config FOR SELECT TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds USING (true);
CREATE POLICY legacy_modify_all_cfg ON __EWOH_SCHEMA__.ewoh_scheduler_config FOR ALL TO authenticated_workspace_aadknm4yzbyds USING (true);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_environment DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_event_chain DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_model_registry DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_audit DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_telemetry DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_topology DISABLE ROW LEVEL SECURITY;
ALTER TABLE __EWOH_SCHEMA__.ewoh_world_state DISABLE ROW LEVEL SECURITY;

-- Restore the pre-migration direct grants on existing tables.
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device_binding TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_device_config TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_environment TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_event_chain TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_model_registry TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_organization TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_personnel TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_production_task TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_audit TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_scheduler_config TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_spatial_entity TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_telemetry TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_topology TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
GRANT ALL PRIVILEGES ON TABLE __EWOH_SCHEMA__.ewoh_world_state TO anon_workspace_aadknm4yzbyds, authenticated_workspace_aadknm4yzbyds, service_role_workspace_aadknm4yzbyds;
