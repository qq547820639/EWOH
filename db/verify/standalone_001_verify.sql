-- EWOH managed schema verification (AG-10)
-- Every result column must be 0 to pass, except audit_function_count which must be 1.
WITH expected(name) AS (VALUES ('ewoh_audit_log'), ('ewoh_control_command'), ('ewoh_control_request'), ('ewoh_control_result'), ('ewoh_device_binding'), ('ewoh_device_capability'), ('ewoh_event_action'), ('ewoh_event_rule'), ('ewoh_event_subscription'), ('ewoh_knowledge_base'), ('ewoh_knowledge_entry'), ('ewoh_model_asset'), ('ewoh_model_binding'), ('ewoh_notification'), ('ewoh_person_role'), ('ewoh_person_skill'), ('ewoh_resource_binding'), ('ewoh_resource_preorder'), ('ewoh_role'), ('ewoh_schedule_assignment'), ('ewoh_schedule_task'), ('ewoh_schedule_task_step'), ('ewoh_skill'), ('ewoh_spatial_hierarchy'), ('ewoh_spatial_relation'), ('ewoh_system_config'), ('ewoh_task_skill_req'), ('ewoh_task_step'), ('ewoh_task_template'), ('ewoh_workstation'), ('ewoh_workstation_device'), ('ewoh_workstation_person'), ('ewoh_workstation_relation'), ('ewoh_workstation_skill'), ('ewoh_world_delta_log'), ('ewoh_world_snapshot'), ('ewoh_scheduler_config'), ('ewoh_environment'), ('ewoh_model_registry'), ('ewoh_schedule_audit'), ('ewoh_schedule_plan'), ('ewoh_event_chain'), ('ewoh_world_state'), ('ewoh_topology'), ('ewoh_spatial_entity'), ('ewoh_telemetry'), ('ewoh_event'), ('ewoh_device')),
request_scoped(name) AS (VALUES ('ewoh_ai_suggestion'), ('ewoh_device'), ('ewoh_device_binding'), ('ewoh_device_config'), ('ewoh_environment'), ('ewoh_event'), ('ewoh_event_chain'), ('ewoh_model_registry'), ('ewoh_organization'), ('ewoh_personnel'), ('ewoh_production_task'), ('ewoh_schedule_audit'), ('ewoh_schedule_plan'), ('ewoh_scheduler_config'), ('ewoh_spatial_entity'), ('ewoh_telemetry'), ('ewoh_topology'), ('ewoh_world_state'), ('ewoh_person_skill'), ('ewoh_skill'), ('ewoh_role'), ('ewoh_person_role'), ('ewoh_device_capability'), ('ewoh_spatial_relation'), ('ewoh_spatial_hierarchy'), ('ewoh_model_asset'), ('ewoh_model_binding'), ('ewoh_workstation'), ('ewoh_workstation_device'), ('ewoh_workstation_person'), ('ewoh_workstation_skill'), ('ewoh_workstation_relation'), ('ewoh_task_template'), ('ewoh_task_step'), ('ewoh_task_skill_req'), ('ewoh_schedule_task'), ('ewoh_schedule_task_step'), ('ewoh_schedule_assignment'), ('ewoh_resource_preorder'), ('ewoh_resource_binding'), ('ewoh_control_request'), ('ewoh_control_command'), ('ewoh_control_result'), ('ewoh_event_rule'), ('ewoh_event_action'), ('ewoh_event_subscription'), ('ewoh_world_snapshot'), ('ewoh_world_delta_log'), ('ewoh_system_config'), ('ewoh_knowledge_base'), ('ewoh_knowledge_entry'), ('ewoh_notification'), ('ewoh_audit_log')),
managed AS (
  SELECT count(*) AS managed_table_count
  FROM expected e
  JOIN information_schema.tables t ON t.table_schema = 'public' AND t.table_name = e.name
),
missing_org AS (
  SELECT count(*) AS missing_org_id
  FROM expected e
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = e.name AND c.column_name = 'org_id'
  WHERE c.column_name IS NULL
),
nullable_org AS (
  SELECT count(*) AS org_not_null_violations
  FROM information_schema.columns c
  WHERE c.table_schema = 'public' AND c.table_name = ANY (ARRAY['ewoh_control_command', 'ewoh_control_request', 'ewoh_control_result', 'ewoh_device_binding', 'ewoh_device_capability', 'ewoh_event_action', 'ewoh_event_rule', 'ewoh_event_subscription', 'ewoh_knowledge_base', 'ewoh_knowledge_entry', 'ewoh_model_asset', 'ewoh_model_binding', 'ewoh_notification', 'ewoh_person_role', 'ewoh_person_skill', 'ewoh_resource_binding', 'ewoh_resource_preorder', 'ewoh_role', 'ewoh_schedule_assignment', 'ewoh_schedule_task', 'ewoh_schedule_task_step', 'ewoh_skill', 'ewoh_spatial_hierarchy', 'ewoh_spatial_relation', 'ewoh_task_skill_req', 'ewoh_task_step', 'ewoh_task_template', 'ewoh_workstation', 'ewoh_workstation_device', 'ewoh_workstation_person', 'ewoh_workstation_relation', 'ewoh_workstation_skill', 'ewoh_scheduler_config', 'ewoh_environment', 'ewoh_model_registry', 'ewoh_schedule_audit', 'ewoh_schedule_plan', 'ewoh_event_chain', 'ewoh_world_state', 'ewoh_topology', 'ewoh_spatial_entity', 'ewoh_telemetry', 'ewoh_event', 'ewoh_device']) AND c.column_name = 'org_id' AND c.is_nullable = 'YES'
),
missing_org_defaults AS (
  SELECT count(*) AS missing_org_request_defaults
  FROM request_scoped e
  LEFT JOIN information_schema.columns c ON c.table_schema = 'public' AND c.table_name = e.name AND c.column_name = 'org_id'
  WHERE coalesce(c.column_default, '') NOT LIKE '%app.current_org_id%'
),
rls AS (
  SELECT count(*) AS rls_enabled
  FROM expected e
  JOIN pg_class c ON c.relname = e.name
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  WHERE c.relrowsecurity
),
policy_missing AS (
  SELECT coalesce(count(*), 0)::bigint AS tables_without_policy
  FROM (
    SELECT e.name
    FROM expected e
    LEFT JOIN pg_policies p ON p.schemaname = 'public' AND p.tablename = e.name
    GROUP BY e.name
    HAVING count(p.policyname) = 0
  ) missing
),
loose AS (
  SELECT count(*) AS loose_policies
  FROM pg_policies p
  JOIN expected e ON e.name = p.tablename
  WHERE p.schemaname = 'public' AND (p.qual = 'true' OR p.with_check = 'true')
),
auth_dml AS (
  SELECT count(DISTINCT g.table_name) AS authenticated_dml_grants
  FROM information_schema.role_table_grants g
  JOIN expected e ON e.name = g.table_name
  WHERE g.table_schema = 'public'
    AND g.grantee IN ('authenticated', 'authenticated')
    AND g.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
),
anon_grants AS (
  SELECT count(DISTINCT g.table_name) AS anon_grants
  FROM information_schema.role_table_grants g
  JOIN expected e ON e.name = g.table_name
  WHERE g.table_schema = 'public' AND g.grantee = 'anon'
),
identities AS (
  SELECT
    count(*) FILTER (WHERE a.attrelid = to_regclass('public.ewoh_audit_log') AND a.attname = 'audit_seq' AND a.attidentity = 'a') AS audit_seq_identity,
    count(*) FILTER (WHERE a.attrelid = to_regclass('public.ewoh_world_delta_log') AND a.attname = 'seq' AND a.attidentity = 'a') AS world_delta_seq_identity
  FROM pg_attribute a
),
audit_fn AS (
  SELECT count(*) AS audit_function_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
  WHERE p.proname = 'ewoh_append_audit_log'
),
quantities AS (
  SELECT count(*) AS quantity_numeric_mismatch
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND ((c.table_name = 'ewoh_resource_preorder' AND c.column_name IN ('quantity', 'reserved_qty', 'issued_qty', 'consumed_qty', 'returned_qty'))
      OR (c.table_name = 'ewoh_resource_binding' AND c.column_name = 'quantity'))
    AND c.data_type <> 'numeric'
),
config_unique AS (
  SELECT count(*) AS scheduler_config_org_key
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'ewoh_scheduler_config' AND indexname = 'uq_ewoh_scheduler_config_org_key'
) SELECT
  (SELECT managed_table_count FROM managed) AS managed_table_count,
  (SELECT missing_org_id FROM missing_org) AS missing_org_id,
  (SELECT org_not_null_violations FROM nullable_org) AS org_not_null_violations,
  (SELECT missing_org_request_defaults FROM missing_org_defaults) AS missing_org_request_defaults,
  (SELECT rls_enabled FROM rls) AS rls_enabled,
  (SELECT tables_without_policy FROM policy_missing) AS tables_without_policy,
  (SELECT loose_policies FROM loose) AS loose_policies,
  (SELECT authenticated_dml_grants FROM auth_dml) AS authenticated_dml_grants,
  (SELECT anon_grants FROM anon_grants) AS anon_grants,
  (SELECT audit_seq_identity FROM identities) AS audit_seq_identity,
  (SELECT world_delta_seq_identity FROM identities) AS world_delta_seq_identity,
  (SELECT audit_function_count FROM audit_fn) AS audit_function_count,
  (SELECT quantity_numeric_mismatch FROM quantities) AS quantity_numeric_mismatch,
  (SELECT scheduler_config_org_key FROM config_unique) AS scheduler_config_org_key;
