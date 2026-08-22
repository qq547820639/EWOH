-- ===========================================================================
-- standalone_007_workbench_data.sql
-- 角色工作台（RoleWorkbench）数据补齐种子。
--
-- 背景：角色工作台直接查询 ewoh_schedule_task_step / ewoh_event(quality) /
-- ewoh_resource_binding 三张表，但原种子（standalone_006）只写了
-- ewoh_schedule_task（TASK-126..131，全部 queued），未写入这三张表的业务数据，
-- 导致工作台 operator / team_lead / quality / manager 视角大量指标为空。
--
-- 本文件补齐上述三张表，贴合 standalone_006 的 LINE-B backlog 场景
-- （人员 P001..P010、设备 DEV-01..06、工单 TASK-126..131）。
--
-- 设计要点：
--   * 全部使用固定 UUID + ON CONFLICT DO NOTHING，可重复运行（幂等），
--     既可由部署流程统一跑，也可直接 psql 灌入线上库，互不冲突。
--   * org_id 统一为默认租户 00000000-0000-4000-8000-000000000001，与种子一致。
--   * step 状态混合 in_progress / pending / paused，并预埋 exception / sop 标记，
--     让"在制工序/升级异常/SOP待签"等真实指标非空。
-- ===========================================================================

-- ===========================================================================
-- 1) 工序（ewoh_schedule_task_step）—— 工作台 operator / team_lead / manager 核心
-- ===========================================================================
INSERT INTO public.ewoh_schedule_task_step
  (id, org_id, step_id, schedule_task_id, step_no, name, instruction,
   status, planned_start, planned_end, actual_start,
   assigned_person_id, assigned_device_id, spatial_entity_id, progress,
   result_json, parent_step_id)
VALUES
  -- TASK-126 LINE-B模组装配-1：进行中（在制工序/产能瓶颈非空）+ 异常标记
  ('67000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001',
   'STEP-126-1', 'TASK-126', 1, '模组定位与夹具安装', '按 SOP-B-101 完成模组粗定位并锁紧夹具',
   'in_progress', now() - interval '10 minutes', now() + interval '30 minutes', now() - interval '8 minutes',
   'P004', 'DEV-04', 'NODE-LB-02', 55,
   '{"exception":"DEV-04 离线导致辅助动作中断，已申请改用 DEV-03","sop":{"id":"SOP-B-101","version":"2.1"}}', NULL),
  -- TASK-127 LINE-B模组装配-2：进行中 + SOP 待签
  ('67000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001',
   'STEP-127-1', 'TASK-127', 1, '模组主装配', '完成模组主体装配与螺丝扭矩校验',
   'in_progress', now() - interval '5 minutes', now() + interval '35 minutes', now() - interval '3 minutes',
   'P005', 'DEV-05', 'NODE-LB-02', 30,
   '{"sop":{"id":"SOP-B-102","version":"1.4"}}', NULL),
  -- TASK-128 LINE-B外观装配（锁定 P008）：暂停（paused 计入在制）+ SOP 待签
  ('67000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000001',
   'STEP-128-1', 'TASK-128', 1, '外观件装配', '安装外观覆盖件并自检缝隙均匀度',
   'paused', now() + interval '5 minutes', now() + interval '45 minutes', NULL,
   'P008', 'DEV-06', 'NODE-LB-02', 0,
   '{"sop":{"id":"SOP-B-103","version":"1.0"}}', NULL),
  -- TASK-129 LINE-B焊接-1：待开始（pending，计入 active step）
  ('67000000-0000-4000-8000-000000000104', '00000000-0000-4000-8000-000000000001',
   'STEP-129-1', 'TASK-129', 1, '主焊缝焊接', '按 WPS-B-201 完成主焊缝多层多道焊',
   'pending', now() + interval '15 minutes', now() + interval '50 minutes', NULL,
   'P001', 'DEV-01', 'NODE-LB-03', 0,
   NULL, NULL),
  -- TASK-130 LINE-B焊接-2：待开始
  ('67000000-0000-4000-8000-000000000105', '00000000-0000-4000-8000-000000000001',
   'STEP-130-1', 'TASK-130', 1, '补强焊接', '完成结构补强焊与焊后清理',
   'pending', now() + interval '25 minutes', now() + interval '60 minutes', NULL,
   'P004', NULL, 'NODE-LB-03', 0,
   NULL, NULL),
  -- TASK-131 LINE-B总检：进行中 + 异常（质检阶段发现尺寸偏差，升级）
  ('67000000-0000-4000-8000-000000000106', '00000000-0000-4000-8000-000000000001',
   'STEP-131-1', 'TASK-131', 1, '总检与尺寸复测', '全尺寸复测并出具总检报告',
   'in_progress', now() - interval '2 minutes', now() + interval '70 minutes', now() - interval '1 minute',
   'P005', NULL, 'NODE-PK-01', 10,
   '{"exception":"关键尺寸超差 0.12mm，已触发质量升级待评审","sop":{"id":"SOP-Q-301","version":"3.0"}}', NULL),
  -- TASK-126 第二道工序：待开始（验证多 step 同 task 聚合）
  ('67000000-0000-4000-8000-000000000107', '00000000-0000-4000-8000-000000000001',
   'STEP-126-2', 'TASK-126', 2, '模组功能自检', '上电自检并录入手持终端',
   'pending', now() + interval '30 minutes', now() + interval '50 minutes', NULL,
   'P004', 'DEV-03', 'NODE-LB-02', 0,
   NULL, NULL)
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 2) 质量事件（ewoh_event, event_type='quality'）—— quality 工作台核心
-- ===========================================================================
INSERT INTO public.ewoh_event
  (id, event_id, device_id, event_code, event_type, severity, title,
   status, created_at, source_type, evidence_json, org_id)
VALUES
  -- 待检 / 直通率 fail / 缺陷 Pareto
  ('67000000-0000-4000-8000-000000000201', 'EVT-Q-001', 'DEV-06', 'QC-REJECT', 'quality', 'medium',
   '外观件装配间隙超差', 'open', now() - interval '20 minutes', 'simulated',
   '{"result":"fail","defectCode":"GAP-OVER","measure":"0.12mm","station":"NODE-LB-02"}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  ('67000000-0000-4000-8000-000000000202', 'EVT-Q-002', 'DEV-01', 'QC-REJECT', 'quality', 'medium',
   '焊接气孔缺陷', 'open', now() - interval '35 minutes', 'simulated',
   '{"result":"fail","defectCode":"POROSITY","measure":"2处","station":"NODE-LB-03"}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  ('67000000-0000-4000-8000-000000000203', 'EVT-Q-003', NULL, 'QC-PASS', 'quality', 'info',
   '模组装配首件检验合格', 'open', now() - interval '50 minutes', 'simulated',
   '{"result":"pass","defectCode":"NONE","station":"NODE-LB-02"}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  ('67000000-0000-4000-8000-000000000204', 'EVT-Q-004', 'DEV-05', 'QC-REJECT', 'quality', 'low',
   '低电量导致扭矩不足复检', 'open', now() - interval '15 minutes', 'simulated',
   '{"result":"fail","defectCode":"TORQUE-LOW","measure":"3处","station":"NODE-LB-02"}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  -- 重复缺陷（defectCode 与 EVT-Q-002 相同 → duplicateDefects 过滤 count>1 命中）
  ('67000000-0000-4000-8000-000000000205', 'EVT-Q-005', 'DEV-03', 'QC-REJECT', 'quality', 'medium',
   '焊接气孔二次缺陷', 'open', now() - interval '10 minutes', 'simulated',
   '{"result":"fail","defectCode":"POROSITY","measure":"1处","station":"NODE-LB-03"}'::jsonb,
   '00000000-0000-4000-8000-000000000001'),
  ('67000000-0000-4000-8000-000000000206', 'EVT-Q-006', NULL, 'QC-PASS', 'quality', 'info',
   '总检首件合格', 'open', now() - interval '5 minutes', 'simulated',
   '{"result":"pass","defectCode":"NONE","station":"NODE-PK-01"}'::jsonb,
   '00000000-0000-4000-8000-000000000001')
ON CONFLICT (id) DO NOTHING;

-- ===========================================================================
-- 3) 物料绑定（ewoh_resource_binding）—— team_lead / manager 物料缺口核心
-- ===========================================================================
INSERT INTO public.ewoh_resource_binding
  (id, org_id, binding_id, binding_type, resource_type, resource_id,
   target_type, target_id, start_time, reason, status, operator_id, quantity)
VALUES
  ('67000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000001',
   'RB-001', 'material', 'bom_item', 'MAT-MODULE-A',
   'schedule_task', 'TASK-126', now() - interval '1 hour', 'LINE-B模组装配物料已领用', 'active', 'P007', 12),
  ('67000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000001',
   'RB-002', 'material', 'bom_item', 'MAT-WELD-WIRE',
   'schedule_task', 'TASK-129', now() - interval '50 minutes', '焊接耗材绑定', 'active', 'P007', 5),
  ('67000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000001',
   'RB-003', 'material', 'bom_item', 'MAT-COVER-EXT',
   'schedule_task', 'TASK-128', now() - interval '40 minutes', '外观件物料绑定（P008锁定）', 'active', 'P008', 8),
  ('67000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000001',
   'RB-004', 'tooling', 'fixture', 'FIX-LB-02',
   'station', 'ST-LB-02', now() - interval '2 hours', '工装夹具占用', 'active', 'P004', 1),
  ('67000000-0000-4000-8000-000000000305', '00000000-0000-4000-8000-000000000001',
   'RB-005', 'material', 'bom_item', 'MAT-PACK-BOX',
   'schedule_task', 'TASK-135', now() - interval '30 minutes', '打包耗材绑定', 'active', 'P009', 20)
ON CONFLICT (id) DO NOTHING;
