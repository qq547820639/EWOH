-- 108 rollback: 把三行写回旧形状，并把 …-003（第二台设备的 per-device MIN_BATTERY）按旧写法补回。
-- 只还原数据形状；不试图还原任何求解结果。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = '{"person_id":"P008"}'::jsonb,
       task_id = 'TASK-128',
       _updated_at = CURRENT_TIMESTAMP
 WHERE id = '69000000-0000-4000-8000-000000000001';

UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = '{"device_id":"DEV-02","min_battery":30}'::jsonb,
       _updated_at = CURRENT_TIMESTAMP
 WHERE id = '69000000-0000-4000-8000-000000000002';

UPDATE __EWOH_SCHEMA__.ewoh_scheduling_constraint
   SET value_json = '{"start":"now()+5min","end":"now()+40min"}'::jsonb,
       task_id = 'TASK-126',
       _updated_at = CURRENT_TIMESTAMP
 WHERE id = '69000000-0000-4000-8000-000000000004';

INSERT INTO __EWOH_SCHEMA__.ewoh_scheduling_constraint
  (id, org_id, constraint_id, plan_id, task_id, type, value_json, active, created_by)
SELECT '69000000-0000-4000-8000-000000000003'::uuid, d.org_id, 'CONST-LB-005', 'PLAN-OPT-001', NULL, 'MIN_BATTERY',
       '{"device_id":"DEV-05","min_battery":30}'::jsonb, true, 'operator-li'
  FROM (SELECT DISTINCT org_id FROM __EWOH_SCHEMA__.ewoh_device WHERE device_id = 'DEV-05') d
ON CONFLICT (id) DO NOTHING;
