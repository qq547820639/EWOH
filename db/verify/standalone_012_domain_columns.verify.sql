-- EWOH Command Map 智能调度驾驶舱 — 领域模型新列 verification (Phase 1 / P1-T1)
-- Returns a single row with:
--   task_domain_columns      — count of the 11 expected ewoh_production_task columns present
--   personnel_domain_columns — count of the 4 expected ewoh_personnel columns present
--   device_domain_columns    — count of the 7 expected ewoh_device columns present
--   spatial_domain_columns   — count of the 3 expected ewoh_spatial_entity columns present
--   run_failure_reason       — 1 if ewoh_scheduling_run.failure_reason exists
--   safety_critical_default  — 1 if safety_critical DEFAULT false
--   preemptible_default      — 1 if preemptible DEFAULT false
--   skill_match_mode_default — 1 if skill_match_mode DEFAULT 'ALL'
--   production_impact_default— 1 if production_impact DEFAULT 0
-- A result of (11,4,7,3,1,1,1,1,1) means the migration applied cleanly.
SELECT
  (SELECT count(*)::bigint
     FROM (
       SELECT 'base_priority' AS column_name
       UNION ALL SELECT 'earliest_start_ms'
       UNION ALL SELECT 'latest_finish_ms'
       UNION ALL SELECT 'safety_critical'
       UNION ALL SELECT 'preemptible'
       UNION ALL SELECT 'skill_match_mode'
       UNION ALL SELECT 'production_impact'
       UNION ALL SELECT 'downstream_impact'
       UNION ALL SELECT 'required_station_capabilities'
       UNION ALL SELECT 'preferred_resources'
       UNION ALL SELECT 'excluded_resources'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_production_task'
      AND c.column_name = expected.column_name
  ) AS task_domain_columns,
  (SELECT count(*)::bigint
     FROM (
       SELECT 'shift' AS column_name
       UNION ALL SELECT 'workload'
       UNION ALL SELECT 'current_task_id'
       UNION ALL SELECT 'certification_expiry'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_personnel'
      AND c.column_name = expected.column_name
  ) AS personnel_domain_columns,
  (SELECT count(*)::bigint
     FROM (
       SELECT 'capabilities' AS column_name
       UNION ALL SELECT 'location_lat'
       UNION ALL SELECT 'location_lng'
       UNION ALL SELECT 'location_updated_at'
       UNION ALL SELECT 'location_confidence'
       UNION ALL SELECT 'telemetry_updated_at'
       UNION ALL SELECT 'available_windows'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_device'
      AND c.column_name = expected.column_name
  ) AS device_domain_columns,
  (SELECT count(*)::bigint
     FROM (
       SELECT 'capacity' AS column_name
       UNION ALL SELECT 'queue'
       UNION ALL SELECT 'available_windows'
     ) AS expected(column_name)
     JOIN information_schema.columns c
       ON c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_spatial_entity'
      AND c.column_name = expected.column_name
  ) AS spatial_domain_columns,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_scheduling_run'
      AND c.column_name = 'failure_reason'
  ) AS run_failure_reason,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_production_task'
      AND c.column_name = 'safety_critical'
      AND c.column_default IS NOT NULL
      AND c.column_default ILIKE '%false%'
  ) AS safety_critical_default,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_production_task'
      AND c.column_name = 'preemptible'
      AND c.column_default IS NOT NULL
      AND c.column_default ILIKE '%false%'
  ) AS preemptible_default,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_production_task'
      AND c.column_name = 'skill_match_mode'
      AND c.column_default IS NOT NULL
      AND c.column_default ILIKE '%ALL%'
  ) AS skill_match_mode_default,
  (SELECT count(*)::bigint
     FROM information_schema.columns c
    WHERE c.table_schema = '__EWOH_SCHEMA__'
      AND c.table_name = 'ewoh_production_task'
      AND c.column_name = 'production_impact'
      AND c.column_default IS NOT NULL
      AND c.column_default ILIKE '%0%'
  ) AS production_impact_default;
