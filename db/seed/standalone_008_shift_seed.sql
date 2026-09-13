-- EWOH 班次域种子 (standalone_008_shift_seed, DR-2)
-- Schema: public (standalone). Re-entrant: ON CONFLICT DO NOTHING.
--
-- 默认租户的三班制班次定义（早/中/夜）——班次工作台的首个事实源：
--   - 早班 08:00–16:00 / 中班 16:00–24:00 / 夜班 22:00–06:00（跨零点）；
--   - 夜班与中班窗口重叠 22:00–24:00 是真实工厂常态（夜班提前到岗），
--     resolveShiftAt 取首个命中（早班→中班→夜班登记顺序即优先级）；
--   - 附一条示范交接记录（结构化遗留事项），演示"口头交接、系统无痕"的替代。
--
-- 全部行归属默认租户 org_id '00000000-0000-4000-8000-000000000001'。

SELECT set_config('search_path', 'public, pg_temp', false);

INSERT INTO ewoh_shift (
  org_id, shift_id, name, code, start_time, end_time, crosses_midnight, active, description
) VALUES
  ('00000000-0000-4000-8000-000000000001', 'SHIFT-EARLY', '早班', 'A', '08:00', '16:00', false, true,
   '白班主力生产班次'),
  ('00000000-0000-4000-8000-000000000001', 'SHIFT-MIDDLE', '中班', 'B', '16:00', '24:00', false, true,
   '下午至午夜班次，与夜班 22:00 交接重叠'),
  ('00000000-0000-4000-8000-000000000001', 'SHIFT-NIGHT', '夜班', 'C', '22:00', '06:00', true, true,
   '跨零点班次（22:00–次日 06:00）')
ON CONFLICT (org_id, shift_id) DO NOTHING;

-- 示范交接：结构化遗留事项（severity 分级 + 关联对象引用）。
INSERT INTO ewoh_shift_handover (
  org_id, handover_id, shift_id, shift_date, to_user_id, open_items_json, notes, status, confirmed_at
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'HO-DEMO-20260911',
  'SHIFT-EARLY',
  current_date,
  '00000000-0000-4000-8000-000000000901',
  '[
    {"title": "DEV-04 离线待复核", "severity": "warning", "relatedObjectType": "device", "relatedObjectId": "DEV-04", "note": "昨晚离线，设备侧尚未恢复"},
    {"title": "TASK-128 锁定约束延续", "severity": "info", "relatedObjectType": "task", "relatedObjectId": "TASK-128", "note": "P008 锁定，重排时保留"}
  ]'::jsonb,
  '示范交接记录：夜班向早班交接（种子数据）',
  'confirmed',
  now()
) ON CONFLICT (org_id, handover_id) DO NOTHING;
