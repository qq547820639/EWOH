-- EWOH Intelligent Scheduling Workbench demo seed (Task 2)
-- Schema: public (standalone). Re-entrant: ON CONFLICT DO NOTHING.
--
-- Seeds deterministic demo data so the scheduling workbench can be validated:
--   1) Route graph (ewoh_route_node / ewoh_route_edge) across LINE-A, LINE-B,
--      WAREHOUSE, CHARGE, PACKING — with 'blocked' + 'congested' edges to
--      exercise the blocked/congested route-replan logic.
--   2) Personnel (8-12) with skills / load / health.
--   3) Exoskeleton devices (>=5) with low-battery + one offline.
--   4) Production tasks (15-20) including a LINE-B backlog scenario.
--   5) Scheduling orchestration seed: schedule_task, schedule_plan,
--      scheduling_plan_assignment, scheduling_constraint, world_state_snapshot.
--
-- Business IDs are stable & human-readable (P001.., TASK-12x, DEV-0x,
-- NODE-*, EDGE-*). All rows belong to the default tenant org_id
-- '00000000-0000-4000-8000-000000000001'.
--
-- Scenario highlight: TASK-128 is locked to person P008 (LOCKED_PERSON
-- constraint). LINE-B has 6 high-priority tasks with tight deadlines; under the
-- keep_current baseline (busy/high-load persons P004/P005/P006 plus offline
-- DEV-04 and low-battery DEV-05) the solver would show ~25 min delay —
-- demonstrating the need for replanning.

SELECT set_config('search_path', 'public, pg_temp', false);

-- ===========================================================================
-- 1) Route graph nodes (12 nodes across 5 zones)
-- ===========================================================================
INSERT INTO public.ewoh_route_node
  (id, node_id, node_type, x, y, floor, station_id, zone_id)
VALUES
  ('61000000-0000-4000-8000-000000000001', 'NODE-HUB-01', 'intersection',     500, 360, '1', NULL,          NULL),
  ('61000000-0000-4000-8000-000000000002', 'NODE-LA-01',  'intersection',     420, 300, '1', NULL,          'LINE-A'),
  ('61000000-0000-4000-8000-000000000003', 'NODE-LA-02',  'workstation',      380, 260, '1', 'ST-LA-02',   'LINE-A'),
  ('61000000-0000-4000-8000-000000000004', 'NODE-LA-03',  'workstation',      340, 220, '1', 'ST-LA-03',   'LINE-A'),
  ('61000000-0000-4000-8000-000000000005', 'NODE-LB-01',  'intersection',     580, 300, '1', NULL,          'LINE-B'),
  ('61000000-0000-4000-8000-000000000006', 'NODE-LB-02',  'workstation',      620, 260, '1', 'ST-LB-02',   'LINE-B'),
  ('61000000-0000-4000-8000-000000000007', 'NODE-LB-03',  'workstation',      660, 220, '1', 'ST-LB-03',   'LINE-B'),
  ('61000000-0000-4000-8000-000000000008', 'NODE-WH-01',  'entrance',         300, 460, '1', NULL,          'WAREHOUSE'),
  ('61000000-0000-4000-8000-000000000009', 'NODE-WH-02',  'warehouse',        260, 500, '1', 'ST-WH-02',   'WAREHOUSE'),
  ('61000000-0000-4000-8000-00000000000a', 'NODE-CH-01',  'charging_station', 700, 420, '1', 'ST-CH-01',   'CHARGE'),
  ('61000000-0000-4000-8000-00000000000b', 'NODE-PK-01',  'workstation',      600, 420, '1', 'ST-PK-01',   'PACKING'),
  ('61000000-0000-4000-8000-00000000000c', 'NODE-PK-02',  'workstation',      650, 460, '1', 'ST-PK-02',   'PACKING')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 2) Route graph edges (12 connections x bidirectional = 24 edges)
--    EDGE-*: open (default). EDGE-LB-00  -> blocked (main LINE-B access).
--             EDGE-LA-03  -> congested (LA-02 -> LA-03).
-- ===========================================================================
INSERT INTO public.ewoh_route_edge
  (id, edge_id, from_node_id, to_node_id, distance_meters, expected_time_seconds, direction, capacity, risk_level, status, accessible_for)
VALUES
  -- HUB-01 <-> LA-01
  ('62000000-0000-4000-8000-000000000001', 'EDGE-LA-01',  'NODE-HUB-01', 'NODE-LA-01', 12,  8,  'outbound', 4, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000002', 'EDGE-LA-01R', 'NODE-LA-01',  'NODE-HUB-01', 12,  8,  'inbound',  4, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  -- HUB-01 <-> WH-01 (entrance)
  ('62000000-0000-4000-8000-000000000003', 'EDGE-WH-01',  'NODE-HUB-01', 'NODE-WH-01',  30, 20,  'outbound', 6, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000004', 'EDGE-WH-01R', 'NODE-WH-01',  'NODE-HUB-01', 30, 20,  'inbound',  6, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  -- HUB-01 <-> CH-01
  ('62000000-0000-4000-8000-000000000005', 'EDGE-CH-01',  'NODE-HUB-01', 'NODE-CH-01',  50, 35,  'outbound', 2, 'low', 'open', '["exoskeleton"]'::jsonb),
  ('62000000-0000-4000-8000-000000000006', 'EDGE-CH-01R', 'NODE-CH-01',  'NODE-HUB-01', 50, 35,  'inbound',  2, 'low', 'open', '["exoskeleton"]'::jsonb),
  -- HUB-01 <-> PK-01
  ('62000000-0000-4000-8000-000000000007', 'EDGE-PK-01',  'NODE-HUB-01', 'NODE-PK-01',  25, 18,  'outbound', 4, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000008', 'EDGE-PK-01R', 'NODE-PK-01',  'NODE-HUB-01', 25, 18,  'inbound',  4, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  -- HUB-01 <-> LB-01 (main LINE-B access — BLOCKED, forces detour via WH-02)
  ('62000000-0000-4000-8000-000000000009', 'EDGE-LB-00',  'NODE-HUB-01', 'NODE-LB-01',  15, 10,  'outbound', 4, 'high', 'blocked', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-00000000000a', 'EDGE-LB-00R', 'NODE-LB-01',  'NODE-HUB-01', 15, 10,  'inbound',  4, 'high', 'blocked', '["exoskeleton","agv","person"]'::jsonb),
  -- LA-01 <-> LA-02
  ('62000000-0000-4000-8000-00000000000b', 'EDGE-LA-02',  'NODE-LA-01',  'NODE-LA-02',   8,  6,  'outbound', 4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  ('62000000-0000-4000-8000-00000000000c', 'EDGE-LA-02R', 'NODE-LA-02',  'NODE-LA-01',   8,  6,  'inbound',  4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  -- LA-02 <-> LA-03 (CONGESTED in LA-02 -> LA-03 direction)
  ('62000000-0000-4000-8000-00000000000d', 'EDGE-LA-03',  'NODE-LA-02',  'NODE-LA-03',   8,  6,  'outbound', 2, 'medium', 'congested', '["exoskeleton","person"]'::jsonb),
  ('62000000-0000-4000-8000-00000000000e', 'EDGE-LA-03R', 'NODE-LA-03',  'NODE-LA-02',   8,  6,  'inbound',  2, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  -- WH-01 <-> WH-02
  ('62000000-0000-4000-8000-00000000000f', 'EDGE-WH-02',  'NODE-WH-01',  'NODE-WH-02',  10,  7,  'outbound', 6, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000010', 'EDGE-WH-02R', 'NODE-WH-02',  'NODE-WH-01',  10,  7,  'inbound',  6, 'low', 'open', '["exoskeleton","agv","person"]'::jsonb),
  -- WH-02 <-> LB-01 (alternative route to LINE-B, bypasses the blocked EDGE-LB-00)
  ('62000000-0000-4000-8000-000000000011', 'EDGE-WH-LB',  'NODE-WH-02',  'NODE-LB-01',  45, 30,  'outbound', 4, 'medium', 'open', '["exoskeleton","agv","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000012', 'EDGE-WH-LBR', 'NODE-LB-01',  'NODE-WH-02',  45, 30,  'inbound',  4, 'medium', 'open', '["exoskeleton","agv","person"]'::jsonb),
  -- LB-01 <-> LB-02
  ('62000000-0000-4000-8000-000000000013', 'EDGE-LB-01',  'NODE-LB-01',  'NODE-LB-02',  10,  7,  'outbound', 4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000014', 'EDGE-LB-01R', 'NODE-LB-02',  'NODE-LB-01',  10,  7,  'inbound',  4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  -- LB-02 <-> LB-03
  ('62000000-0000-4000-8000-000000000015', 'EDGE-LB-02',  'NODE-LB-02',  'NODE-LB-03',  10,  7,  'outbound', 4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000016', 'EDGE-LB-02R', 'NODE-LB-03',  'NODE-LB-02',  10,  7,  'inbound',  4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  -- PK-01 <-> PK-02
  ('62000000-0000-4000-8000-000000000017', 'EDGE-PK-02',  'NODE-PK-01',  'NODE-PK-02',  12,  8,  'outbound', 4, 'low', 'open', '["exoskeleton","person"]'::jsonb),
  ('62000000-0000-4000-8000-000000000018', 'EDGE-PK-02R', 'NODE-PK-02',  'NODE-PK-01',  12,  8,  'inbound',  4, 'low', 'open', '["exoskeleton","person"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3) Personnel (10 workers, business ids P001..P010)
--    P005/P006 are high-load & busy; P010 off_duty — used by the solver.
-- ===========================================================================
INSERT INTO public.ewoh_personnel
  (id, org_id, name, employee_no, team_name, position, skills, status, health_status, current_load, spatial_entity_id)
VALUES
  ('63000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', '张伟', 'P001', 'A班', '装配工', '["assembly","welding"]'::jsonb, 'available', 'normal', '{"loadLevel":0.62,"fatigueLevel":0.30}'::jsonb, 'NODE-LA-02'),
  ('63000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '李娜', 'P002', 'A班', '装配工', '["assembly"]'::jsonb, 'busy', 'normal', '{"loadLevel":0.55,"fatigueLevel":0.25}'::jsonb, 'NODE-LA-02'),
  ('63000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '王强', 'P003', 'A班', '装配工', '["assembly","packing"]'::jsonb, 'busy', 'normal', '{"loadLevel":0.48,"fatigueLevel":0.20}'::jsonb, 'NODE-LA-03'),
  ('63000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', '刘洋', 'P004', 'B班', '装配工', '["assembly","inspection"]'::jsonb, 'available', 'normal', '{"loadLevel":0.50,"fatigueLevel":0.25}'::jsonb, 'NODE-LB-02'),
  ('63000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', '赵敏', 'P005', 'B班', '装配工', '["assembly"]'::jsonb, 'busy', 'warning', '{"loadLevel":0.70,"fatigueLevel":0.45}'::jsonb, 'NODE-LB-02'),
  ('63000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', '孙磊', 'P006', 'B班', '焊工', '["welding","inspection"]'::jsonb, 'busy', 'warning', '{"loadLevel":0.75,"fatigueLevel":0.50}'::jsonb, 'NODE-LB-03'),
  ('63000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', '周静', 'P007', 'C班', '物流员', '["warehouse","packing"]'::jsonb, 'available', 'normal', '{"loadLevel":0.40,"fatigueLevel":0.20}'::jsonb, 'NODE-WH-02'),
  ('63000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', '吴刚', 'P008', 'B班', '包装工', '["packing","assembly"]'::jsonb, 'available', 'normal', '{"loadLevel":0.45,"fatigueLevel":0.20}'::jsonb, 'NODE-PK-02'),
  ('63000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', '郑丽', 'P009', 'C班', '质检员', '["inspection","packing"]'::jsonb, 'available', 'normal', '{"loadLevel":0.30,"fatigueLevel":0.15}'::jsonb, 'NODE-PK-01'),
  ('63000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', '冯涛', 'P010', 'C班', '焊工', '["welding","maintenance"]'::jsonb, 'off_duty', 'tired', '{"loadLevel":0.10,"fatigueLevel":0.10}'::jsonb, 'NODE-CH-01')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 4) Exoskeleton devices (6). DEV-02/DEV-05 low battery, DEV-04 offline —
--    exercising low-battery and device-offline replan logic.
-- ===========================================================================
INSERT INTO public.ewoh_device
  (id, org_id, device_id, worker_name, device_model, battery_pct, online, source_type, firmware_version, protocol_version)
VALUES
  ('64000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'DEV-01', '张伟', 'NY-EXO-A1', 92, true,  'simulated', '1.3.0', 'v1'),
  ('64000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'DEV-02', '李娜', 'NY-EXO-A1', 18, true,  'simulated', '1.3.0', 'v1'),
  ('64000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'DEV-03', '王强', 'NY-EXO-A1', 64, true,  'simulated', '1.3.0', 'v1'),
  ('64000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'DEV-04', '刘洋', 'NY-EXO-P1', 75, false, 'simulated', '1.2.0', 'v1'),
  ('64000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'DEV-05', '赵敏', 'NY-EXO-P1', 25, true,  'simulated', '1.2.0', 'v1'),
  ('64000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'DEV-06', '吴刚', 'NY-EXO-A1', 88, true,  'simulated', '1.3.0', 'v1')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 5) Production tasks (18). LINE-B backlog (TASK-126..131) are high-priority
--    with tight deadlines. TASK-128 is locked to person P008.
-- ===========================================================================
INSERT INTO public.ewoh_production_task
  (id, org_id, title, task_type, priority, status, assignee_id, device_id, spatial_entity_id, plan_start, plan_end, progress, source)
VALUES
  -- LINE-A (TASK-121..125)
  ('65000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'LINE-A底座装配',   'assembly',    'high',   'executing', 'P001', 'DEV-01', 'NODE-LA-02', now() - interval '30 minutes', now() + interval '40 minutes', 60, 'seed'),
  ('65000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'LINE-A主板装配',   'assembly',    'high',   'executing', 'P002', 'DEV-02', 'NODE-LA-02', now() - interval '20 minutes', now() + interval '50 minutes', 40, 'seed'),
  ('65000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'LINE-A装配辅助',   'assembly',    'medium', 'executing', 'P003', 'DEV-03', 'NODE-LA-03', now() - interval '10 minutes', now() + interval '1 hour',    30, 'seed'),
  ('65000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'LINE-A质检',       'inspection',  'medium', 'pending',   'P001', 'DEV-01', 'NODE-LA-03', now() + interval '1 hour',      now() + interval '2 hours',   0,  'seed'),
  ('65000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'LINE-A物料搬运',   'logistics',   'low',    'queued',    'P003', NULL,     'NODE-LA-01', now() + interval '2 hours',      now() + interval '3 hours',   0,  'seed'),
  -- LINE-B backlog (TASK-126..131) — high priority, tight deadlines
  ('65000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'LINE-B模组装配-1', 'assembly',   'high',  'pending',  'P004', 'DEV-04', 'NODE-LB-02', now() + interval '5 minutes',  now() + interval '40 minutes', 0, 'seed'),
  ('65000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000001', 'LINE-B模组装配-2', 'assembly',   'high',  'pending',  'P005', 'DEV-05', 'NODE-LB-02', now() + interval '10 minutes', now() + interval '45 minutes', 0, 'seed'),
  ('65000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000001', 'LINE-B外观装配',   'assembly',   'high',  'pending',  'P008', 'DEV-06', 'NODE-LB-02', now() + interval '15 minutes', now() + interval '50 minutes', 0, 'seed'),
  ('65000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000001', 'LINE-B焊接-1',     'welding',    'high',  'pending',  'P006', NULL,     'NODE-LB-03', now() + interval '20 minutes', now() + interval '55 minutes', 0, 'seed'),
  ('65000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'LINE-B焊接-2',     'welding',    'high',  'pending',  'P004', NULL,     'NODE-LB-03', now() + interval '30 minutes', now() + interval '1 hour 5 minutes', 0, 'seed'),
  ('65000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', 'LINE-B总检',       'inspection', 'high',  'pending',  'P005', NULL,     'NODE-PK-01', now() + interval '40 minutes', now() + interval '1 hour 20 minutes', 0, 'seed'),
  -- WAREHOUSE (TASK-132..134)
  ('65000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', '原料入库-1',       'warehouse',  'medium', 'queued',   'P007', NULL,     'NODE-WH-02', now() + interval '30 minutes', now() + interval '2 hours', 0, 'seed'),
  ('65000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', '原料出库-2',       'warehouse',  'medium', 'queued',   'P007', NULL,     'NODE-WH-01', now() + interval '2 hours',      now() + interval '4 hours', 0, 'seed'),
  ('65000000-0000-4000-8000-00000000000e', '00000000-0000-4000-8000-000000000001', '仓库盘点',         'inventory',  'low',    'pending',  'P010', NULL,     'NODE-WH-02', now() + interval '3 hours',      now() + interval '5 hours', 0, 'seed'),
  -- PACKING (TASK-135..137)
  ('65000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-000000000001', '成品打包-1',       'packing',    'medium', 'pending',  'P008', NULL,     'NODE-PK-02', now() + interval '50 minutes', now() + interval '2 hours', 0, 'seed'),
  ('65000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000001', '成品检验-1',       'inspection', 'medium', 'pending',  'P009', NULL,     'NODE-PK-01', now() + interval '1 hour',       now() + interval '3 hours', 0, 'seed'),
  ('65000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', '成品打包-2',       'packing',    'low',    'queued',   'P009', NULL,     'NODE-PK-02', now() + interval '3 hours',      now() + interval '5 hours', 0, 'seed'),
  -- CHARGE (TASK-138)
  ('65000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', '充电桩点检-1',     'maintenance','low',    'pending',  'P010', NULL,     'NODE-CH-01', now() + interval '2 hours',      now() + interval '4 hours', 0, 'seed')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 6) Schedule tasks (mirror of the LINE-B backlog for the scheduling view)
-- ===========================================================================
INSERT INTO public.ewoh_schedule_task
  (id, org_id, schedule_task_id, template_id, title, description, status, priority, source, plan_start, plan_end, is_simulation, progress)
VALUES
  ('66000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'TASK-126', NULL, 'LINE-B模组装配-1', 'B班高优先级装配，交期紧张', 'queued',   'high',   'scheduler', now() + interval '5 minutes',  now() + interval '40 minutes', false, 0),
  ('66000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'TASK-127', NULL, 'LINE-B模组装配-2', 'B班高优先级装配，交期紧张', 'queued',   'high',   'scheduler', now() + interval '10 minutes', now() + interval '45 minutes', false, 0),
  ('66000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', 'TASK-128', NULL, 'LINE-B外观装配',   '锁定P008执行的外观装配任务', 'queued', 'high',   'scheduler', now() + interval '15 minutes', now() + interval '50 minutes', false, 0),
  ('66000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001', 'TASK-129', NULL, 'LINE-B焊接-1',     'B班高优先级焊接，交期紧张',   'queued', 'high',   'scheduler', now() + interval '20 minutes', now() + interval '55 minutes', false, 0),
  ('66000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001', 'TASK-130', NULL, 'LINE-B焊接-2',     'B班高优先级焊接，交期紧张',   'queued', 'high',   'scheduler', now() + interval '30 minutes', now() + interval '1 hour 5 minutes', false, 0),
  ('66000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000001', 'TASK-131', NULL, 'LINE-B总检',       'B班高优先级总检',             'queued', 'high',   'scheduler', now() + interval '40 minutes', now() + interval '1 hour 20 minutes', false, 0)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 7) World state snapshot (immutable basis for the plans)
-- ===========================================================================
INSERT INTO public.ewoh_world_state_snapshot
  (id, snapshot_version, snapshot_json, created_at)
VALUES
  ('6a000000-0000-4000-8000-000000000001', 'SNAP-001',
   '{"generatedAt":"2026-08-07T08:00:00Z","zones":["LINE-A","LINE-B","WAREHOUSE","CHARGE","PACKING"],"personnel":{"P004":"available","P005":"busy","P006":"busy","P008":"available"},"devices":{"DEV-02":{"battery":18},"DEV-04":{"online":false},"DEV-05":{"battery":25}},"routeStatus":{"EDGE-LB-00":"blocked","EDGE-LA-03":"congested"},"lineBBacklog":{"highPriorityTasks":6,"estimatedDelayMinutes":25,"cause":["busy high-load persons","offline DEV-04","low battery DEV-05","blocked EDGE-LB-00"]}}'::jsonb,
   now() - interval '30 minutes')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 8) Schedule plans — baseline (keep_current) + optimized shadow replan
-- ===========================================================================
INSERT INTO public.ewoh_schedule_plan
  (id, org_id, plan_id, plan_name, strategy, status, takt_improvement, high_load_persons, low_battery_risk, affected_persons, metrics_json, reason, created_at, confirmed_by, confirmed_at, confirm_reason, version, snapshot_version, trigger_type, trigger_entity_id, baseline_delta_json, violations_json, superseded_by)
VALUES
  ('67000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'PLAN-BASE-001', 'LINE-B当前排程', 'keep_current', 'confirmed', 0,    2, 2, 6,
   '{"delayMinutes":25,"delayRisk":0.82,"highLoadRisk":0.70,"lowBatteryRisk":0.60,"utilization":0.78}'::jsonb,
   '保持当前分配：P005/P006高负荷、DEV-04离线、DEV-02/DEV-05低电量、主通道EDGE-LB-00阻塞，导致LINE-B约25分钟延误',
   now() - interval '30 minutes', 'operator-li', now() - interval '25 minutes', '基线方案，未做调整',
   1, 'SNAP-001', 'manual', NULL,
   '{"delayReductionMinutes":0,"affectedTaskCount":6}'::jsonb,
   '[{"taskId":"TASK-128","type":"delayed","delayMinutes":25}]'::jsonb,
   NULL),
  ('67000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'PLAN-OPT-001', 'LINE-B优化重排', 'rotation', 'shadow', 0.18, 0, 0, 3,
   '{"delayMinutes":5,"delayRisk":0.15,"highLoadRisk":0.05,"lowBatteryRisk":0.05,"utilization":0.85}'::jsonb,
   '重排：P008锁定TASK-128；高负荷P005/P006轮换；DEV-05接入充电、DEV-04改用DEV-03；绕行EDGE-WH-LB避开阻塞，将延误从25分钟降至约5分钟',
   now() - interval '20 minutes', NULL, NULL, NULL,
   1, 'SNAP-001', 'line_backlog', 'LINE-B',
   '{"delayReductionMinutes":20,"affectedTaskCount":4,"reassignedPersons":["P005","P006"],"rerouted":true}'::jsonb,
   '[]'::jsonb,
   NULL)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 9) Scheduling plan assignments (optimized shadow plan)
-- ===========================================================================
INSERT INTO public.ewoh_scheduling_plan_assignment
  (id, assignment_id, plan_id, task_id, person_id, device_id, station_id, zone_id, planned_start, planned_end, route_id, status, explanation_json, version, reason, org_id, created_by)
VALUES
  -- TASK-128 locked to P008 (see LOCKED_PERSON constraint)
  ('68000000-0000-4000-8000-000000000001', 'ASG-OPT-128', 'PLAN-OPT-001', 'TASK-128', 'P008', 'DEV-06', 'ST-LB-02', 'LINE-B', now() + interval '15 minutes', now() + interval '50 minutes', 'ROUTE-LB-128', 'proposed',
   '{"reasons":["TASK-128 locked to P008","P008 available with DEV-06", "route via EDGE-WH-LB bypasses blocked EDGE-LB-00"]}'::jsonb,
   1, '锁定人员P008执行TASK-128', '00000000-0000-4000-8000-000000000001', 'operator-li'),
  -- DEV-05 low battery -> charge, reassign TASK-127 to DEV-03 instead
  ('68000000-0000-4000-8000-000000000002', 'ASG-OPT-127', 'PLAN-OPT-001', 'TASK-127', 'P005', 'DEV-03', 'ST-LB-02', 'LINE-B', now() + interval '10 minutes', now() + interval '45 minutes', 'ROUTE-LB-127', 'proposed',
   '{"reasons":["DEV-05 battery 25% below MIN_BATTERY 30","DEV-05 scheduled to charge","reassigned to DEV-03"]}'::jsonb,
   1, '低电量DEV-05改派充电，改用DEV-03', '00000000-0000-4000-8000-000000000001', 'operator-li'),
  -- DEV-04 offline -> use DEV-05 (after charge) for TASK-126
  ('68000000-0000-4000-8000-000000000003', 'ASG-OPT-126', 'PLAN-OPT-001', 'TASK-126', 'P004', 'DEV-05', 'ST-LB-02', 'LINE-B', now() + interval '5 minutes',  now() + interval '40 minutes', 'ROUTE-LB-126', 'proposed',
   '{"reasons":["DEV-04 offline","reassigned to DEV-05 after charging window"]}'::jsonb,
   1, 'DEV-04离线，改用DEV-05', '00000000-0000-4000-8000-000000000001', 'operator-li'),
  -- P006 high load -> rotate, TASK-129 reassign to P001 (cross-line support)
  ('68000000-0000-4000-8000-000000000004', 'ASG-OPT-129', 'PLAN-OPT-001', 'TASK-129', 'P001', 'DEV-01', 'ST-LB-03', 'LINE-B', now() + interval '20 minutes', now() + interval '55 minutes', 'ROUTE-LB-129', 'proposed',
   '{"reasons":["P006 high load 0.75 / fatigue 0.50","rotated for fatigue management"]}'::jsonb,
   1, '高负荷P006轮换，TASK-129改派P001', '00000000-0000-4000-8000-000000000001', 'operator-li')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 10) Scheduling constraints (LOCKED_PERSON / MIN_BATTERY / LOCKED_TIME)
-- ===========================================================================
INSERT INTO public.ewoh_scheduling_constraint
  (id, constraint_id, plan_id, task_id, type, value_json, active, created_by)
VALUES
  -- TASK-128 must be executed by P008
  ('69000000-0000-4000-8000-000000000001', 'CONST-TASK128-LOCK', 'PLAN-OPT-001', 'TASK-128', 'LOCKED_PERSON', '{"person_id":"P008"}'::jsonb, true, 'operator-li'),
  -- DEV-02 must not run below 30% battery
  ('69000000-0000-4000-8000-000000000002', 'CONST-LB-002', 'PLAN-OPT-001', NULL, 'MIN_BATTERY', '{"device_id":"DEV-02","min_battery":30}'::jsonb, true, 'operator-li'),
  -- DEV-05 must not run below 30% battery
  ('69000000-0000-4000-8000-000000000003', 'CONST-LB-005', 'PLAN-OPT-001', NULL, 'MIN_BATTERY', '{"device_id":"DEV-05","min_battery":30}'::jsonb, true, 'operator-li'),
  -- TASK-126 locked to its time window
  ('69000000-0000-4000-8000-000000000004', 'CONST-TASK126-TIME', 'PLAN-OPT-001', 'TASK-126', 'LOCKED_TIME', '{"start":"now()+5min","end":"now()+40min"}'::jsonb, true, 'operator-li')
ON CONFLICT (id) DO NOTHING;