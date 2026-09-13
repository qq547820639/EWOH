-- standalone_100 verify：确定性通知号唯一性收敛为 org 作用域（FR2 上游项修复）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（每条都能独立失败）：
--   1) 全局 UNIQUE 约束 ewoh_notification_notification_id_key 已移除；
--   2) 复合唯一索引 uq_ewoh_notification_org_notification_id 存在且确实是 UNIQUE；
--   3) 行为探针（探针行即插即清，不留脏数据）：
--      · 同 org 同通知号二次插入被压（幂等保持："重放不重发"）；
--      · 跨 org 同通知号各自插入成功（跨租户压制消除）。
--
-- 本脚本在「迁移未跑 / 只删约束没建索引 / 建了普通索引」时必然失败。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  idx_count int;
  old_constraint int;
  dup_count int;
BEGIN
  -- 1) 全局 UNIQUE 约束已移除
  SELECT count(*) INTO old_constraint
    FROM pg_constraint
   WHERE conrelid = 'ewoh_notification'::regclass
     AND conname = 'ewoh_notification_notification_id_key';
  IF old_constraint <> 0 THEN
    RAISE EXCEPTION '100 verify FAILED: 全局唯一约束 ewoh_notification_notification_id_key 仍存在';
  END IF;

  -- 2) 复合唯一索引存在且确实是 UNIQUE
  SELECT count(*) INTO idx_count
    FROM pg_indexes
   WHERE schemaname = current_schema()
     AND indexname = 'uq_ewoh_notification_org_notification_id'
     AND indexdef ILIKE '%CREATE UNIQUE%'
     AND indexdef ILIKE '%org_id, notification_id%';
  IF idx_count <> 1 THEN
    RAISE EXCEPTION '100 verify FAILED: uq_ewoh_notification_org_notification_id 复合唯一索引缺失/非 UNIQUE';
  END IF;

  -- 3) 行为探针
  DELETE FROM ewoh_notification WHERE notification_id LIKE 'NTF-VERIFY-100-%';
  INSERT INTO ewoh_notification (org_id, notification_id, recipient_type, recipient_id, channel, title)
    VALUES ('00000000-0000-4000-8000-0000000000aa', 'NTF-VERIFY-100-x', 'role', 'dispatcher', 'app', 'verify-100');
  INSERT INTO ewoh_notification (org_id, notification_id, recipient_type, recipient_id, channel, title)
    VALUES ('00000000-0000-4000-8000-0000000000aa', 'NTF-VERIFY-100-x', 'role', 'dispatcher', 'app', 'verify-100')
    ON CONFLICT DO NOTHING;
  INSERT INTO ewoh_notification (org_id, notification_id, recipient_type, recipient_id, channel, title)
    VALUES ('00000000-0000-4000-8000-0000000000bb', 'NTF-VERIFY-100-x', 'role', 'dispatcher', 'app', 'verify-100')
    ON CONFLICT DO NOTHING;
  SELECT count(*) INTO dup_count FROM ewoh_notification WHERE notification_id LIKE 'NTF-VERIFY-100-%';
  DELETE FROM ewoh_notification WHERE notification_id LIKE 'NTF-VERIFY-100-%';
  IF dup_count <> 2 THEN
    RAISE EXCEPTION '100 verify FAILED: 期望「同 org 压制 + 跨 org 并存」= 2 行，实得 %', dup_count;
  END IF;

  RAISE NOTICE '100 verify OK: notification_id 唯一性已收敛为 org 作用域（同 org 幂等保持 / 跨 org 并存 / 全局约束已移除）';
END $$;

SELECT 1 AS standalone_100_verified;
