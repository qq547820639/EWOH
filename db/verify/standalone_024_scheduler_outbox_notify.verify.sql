-- standalone_024_scheduler_outbox_notify 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（Task 6）：
--   trigger = 1（trg_scheduler_outbox_notify，ewoh_outbox，非内部 trigger）
--   function = 1（notify_scheduler_outbox，返回类型 trigger）
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用 >= 计数判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  outbox_notify_trigger integer := 0;
  outbox_notify_function integer := 0;
BEGIN
  SELECT count(*) INTO outbox_notify_trigger
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'ewoh_outbox'
      AND t.tgname = 'trg_scheduler_outbox_notify'
      AND NOT t.tgisinternal;
  IF outbox_notify_trigger <> 1 THEN
    missing := missing || format('trigger=%s ', outbox_notify_trigger);
  END IF;

  SELECT count(*) INTO outbox_notify_function
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = 'notify_scheduler_outbox'
      AND p.prorettype = (SELECT oid FROM pg_type WHERE typname = 'trigger');
  IF outbox_notify_function <> 1 THEN
    missing := missing || format('function=%s ', outbox_notify_function);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '024 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '024 verify OK: trigger=1 function=1';
END $$;

SELECT
  (SELECT count(*) FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'ewoh_outbox'
       AND t.tgname = 'trg_scheduler_outbox_notify'
       AND NOT t.tgisinternal
  ) AS outbox_notify_trigger,
  (SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = current_schema()
       AND p.proname = 'notify_scheduler_outbox'
       AND p.prorettype = (SELECT oid FROM pg_type WHERE typname = 'trigger')
  ) AS outbox_notify_function;
