-- EWOH demo seed
-- Schema placeholder: public
-- Re-entrant: ON CONFLICT DO NOTHING / guarded inserts.

SELECT set_config('search_path', 'public, pg_temp', false);

-- All demo rows belong to the deterministic default tenant created by migration 001.
-- Deterministic primary keys make this seed genuinely re-entrant.
INSERT INTO public.ewoh_organization
  (id, org_id, name, org_type, parent_id, status, description)
VALUES
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '集团A', 'group', NULL, 'active', 'demo group'),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '工厂A', 'factory', '10000000-0000-4000-8000-000000000001', 'active', 'demo factory'),
  ('10000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '车间A', 'workshop', '10000000-0000-4000-8000-000000000002', 'active', 'demo workshop')
ON CONFLICT (id) DO NOTHING;

-- Spatial entities
INSERT INTO public.ewoh_spatial_entity
  (id, org_id, entity_id, entity_type, parent_id, name, x, y, yaw, bbox_w, bbox_h, status, source_type, confidence, version)
VALUES
  ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'factory-a', 'factory', NULL, '工厂A', 0, 0, 0, 200, 120, 'active', 'seed', 1.0, 1),
  ('20000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'workshop-a', 'workshop', 'factory-a', '车间A', 10, 10, 0, 80, 60, 'active', 'seed', 1.0, 1),
  ('20000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'zone-a', 'zone', 'workshop-a', '装配区', 12, 12, 0, 40, 30, 'active', 'seed', 1.0, 1),
  ('20000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'station-a', 'workstation', 'zone-a', '工位A', 15, 15, 0, 4, 3, 'active', 'seed', 1.0, 1),
  ('20000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'station-b', 'workstation', 'zone-a', '工位B', 25, 15, 0, 4, 3, 'active', 'seed', 1.0, 1)
ON CONFLICT (id) DO NOTHING;

-- Personnel
INSERT INTO public.ewoh_personnel
  (id, org_id, name, employee_no, team_name, position, skills, status)
VALUES
  ('30000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '张三', 'EMP-001', 'A班', '装配工', '["lifting"]'::jsonb, 'available'),
  ('30000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '李四', 'EMP-002', 'A班', '巡检员', '["inspection"]'::jsonb, 'available')
ON CONFLICT (id) DO NOTHING;

-- Devices
INSERT INTO public.ewoh_device
  (id, org_id, device_id, device_model, battery_pct, online, source_type, firmware_version, protocol_version)
VALUES
  ('40000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'EXO-001', 'NY-EXO-A1', 88, true, 'simulated', '1.2.0', 'v1'),
  ('40000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'EXO-002', 'NY-EXO-A1', 64, true, 'simulated', '1.2.0', 'v1'),
  ('40000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'UWB-001', 'UWB-ANCHOR', NULL, true, 'simulated', '0.9.0', 'v1'),
  ('40000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'CAM-001', 'CAM-4K', NULL, true, 'simulated', '0.5.0', 'v1')
ON CONFLICT (id) DO NOTHING;

-- Device-person bindings
INSERT INTO public.ewoh_device_binding
  (id, org_id, device_id, binding_type, target_id, target_type, status, reason)
VALUES
  ('50000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'EXO-001', 'person', '30000000-0000-4000-8000-000000000001', 'person', 'active', 'demo binding')
ON CONFLICT (id) DO NOTHING;

-- Telemetry
INSERT INTO public.ewoh_telemetry
  (id, org_id, device_id, ts, pitch_deg, load_score, fatigue_trend, battery_pct, quality_status, source_type, data_quality)
VALUES
  ('60000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'EXO-001', now() - interval '2 minutes', 8.2, 0.42, 0.10, 88, 'good', 'simulated', 'good'),
  ('60000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'EXO-001', now() - interval '1 minute', 12.5, 0.55, 0.15, 87, 'good', 'simulated', 'good'),
  ('60000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'EXO-002', now() - interval '1 minute', 6.0, 0.30, 0.05, 64, 'good', 'simulated', 'good')
ON CONFLICT (id) DO NOTHING;

-- Events
INSERT INTO public.ewoh_event
  (id, org_id, event_id, device_id, event_code, event_type, severity, title, status, created_at, source_type)
VALUES
  ('70000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'EVT-DEMO-001', 'EXO-001', 'HIGH_LOAD', 'risk', 'L2', '负荷持续上升', 'open', now() - interval '3 minutes', 'simulated')
ON CONFLICT (id) DO NOTHING;

-- Production tasks
INSERT INTO public.ewoh_production_task
  (id, org_id, title, task_type, priority, status, assignee_id, device_id, spatial_entity_id, plan_start, plan_end, progress, source)
VALUES
  ('80000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '装配任务A', 'assembly', 'high', 'draft', '30000000-0000-4000-8000-000000000001', 'EXO-001', 'station-a', now(), now() + interval '2 hours', 0, 'seed')
ON CONFLICT (id) DO NOTHING;

-- Schedule plans
INSERT INTO public.ewoh_schedule_plan
  (id, org_id, plan_id, plan_name, strategy, status, takt_improvement, affected_persons, metrics_json)
VALUES
  ('90000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'PLAN-DEMO-001', '保持现状', 'keep_current', 'shadow', 0, 0, '{"delayRisk":0.2}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Model registry
INSERT INTO public.ewoh_model_registry
  (id, org_id, model_id, model_name, version, type, status, card_json)
VALUES
  ('a0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'action-classifier', '动作分类器', '0.1.0', 'action', 'active', '{"f1":1.0}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Scheduler config
INSERT INTO public.ewoh_scheduler_config (id, org_id, config_key, config_value)
VALUES ('b0000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'weights', '{"w1_output":0.25,"w2_on_time":0.25,"w3_safety_risk":0.2,"w4_body_load":0.15,"w5_move_distance":0.1,"w6_changeover_cost":0.05}'::jsonb)
ON CONFLICT (id) DO NOTHING;
