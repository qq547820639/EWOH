-- standalone_028_assignment_event_tenancy 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（Task 3，ADR-004 DERIVED_TENANT_OWNERSHIP）：
--   1) ewoh_assignment_event.org_id 列存在（028 补齐）
--   2) idx_ewoh_assignment_event_org 索引存在
--   3) trg_assignment_event_derive_org 触发器存在且启用（AFTER INSERT OR UPDATE）
--   4) derive_assignment_event_org() 函数存在
--   5) 派生不变量（有数据时）：所有非空 org_id 恒等于其归属 plan_assignment / plan
--      的 org_id（经 assignment_id → plan_assignment → plan 联表）；空库时恒为 0，
--      保证本 verify 在全新库上可直接通过。
--
-- 注意：postgres.js 多语句返回结果数组；DO 块内 RAISE EXCEPTION 会整体抛错，
-- 末尾 SELECT 输出计数供 runner 分支断言（runner 使用精确 === 判定）。

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  org_id_col integer := 0;
  org_idx integer := 0;
  trg_exists integer := 0;
  fn_exists integer := 0;
  derived_mismatches integer := 0;
BEGIN
  -- 1) org_id 列存在
  SELECT count(*) INTO org_id_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_assignment_event'
      AND column_name = 'org_id';
  IF org_id_col <> 1 THEN
    missing := missing || format('org_id_col=%s ', org_id_col);
  END IF;

  -- 2) org_id 索引存在
  SELECT count(*) INTO org_idx FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'ewoh_assignment_event'
      AND indexname = 'idx_ewoh_assignment_event_org';
  IF org_idx <> 1 THEN
    missing := missing || format('org_idx=%s ', org_idx);
  END IF;

  -- 3) 派生触发器存在且启用（非内部触发器）
  SELECT count(*) INTO trg_exists FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'ewoh_assignment_event'
      AND t.tgname = 'trg_assignment_event_derive_org'
      AND NOT t.tgisinternal
      AND t.tgenabled <> 'D';
  IF trg_exists <> 1 THEN
    missing := missing || format('trg_exists=%s ', trg_exists);
  END IF;

  -- 4) 派生函数存在
  SELECT count(*) INTO fn_exists FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema()
      AND p.proname = 'derive_assignment_event_org';
  IF fn_exists <> 1 THEN
    missing := missing || format('fn_exists=%s ', fn_exists);
  END IF;

  -- 5) 派生不变量（空库恒 0）：非空 org_id 与归属 plan_assignment/plan 的 org_id 一致。
  --    联表在 assignment_id 上解析归属；无法解析归属的行（如纯 task/person 级事件）
  --    不在此不变量范围内（其 org_id 应保持 NULL，由 028 触发器防御语义保证）。
  SELECT count(*) INTO derived_mismatches
    FROM __EWOH_SCHEMA__.ewoh_assignment_event evt
    JOIN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment pa ON pa.assignment_id = evt.assignment_id
    LEFT JOIN __EWOH_SCHEMA__.ewoh_schedule_plan p ON p.plan_id = pa.plan_id
    WHERE evt.org_id IS NOT NULL
      AND evt.org_id <> COALESCE(pa.org_id, p.org_id);
  IF derived_mismatches <> 0 THEN
    missing := missing || format('derived_mismatches=%s ', derived_mismatches);
  END IF;

  IF missing <> '' THEN
    RAISE EXCEPTION '028 verify FAILED: missing: %', missing;
  END IF;
  RAISE NOTICE '028 verify OK: org_id_col=1 org_idx=1 trg_exists=1 fn_exists=1 derived_mismatches=0';
END $$;

SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'ewoh_assignment_event'
       AND column_name = 'org_id'
  ) AS org_id_col,
  (SELECT count(*) FROM pg_indexes
     WHERE schemaname = current_schema()
       AND tablename = 'ewoh_assignment_event'
       AND indexname = 'idx_ewoh_assignment_event_org'
  ) AS org_idx,
  (SELECT count(*) FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'ewoh_assignment_event'
       AND t.tgname = 'trg_assignment_event_derive_org'
       AND NOT t.tgisinternal
       AND t.tgenabled <> 'D'
  ) AS trg_exists,
  (SELECT count(*) FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = current_schema()
       AND p.proname = 'derive_assignment_event_org'
  ) AS fn_exists,
  (SELECT count(*)::int FROM __EWOH_SCHEMA__.ewoh_assignment_event evt
     JOIN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment pa ON pa.assignment_id = evt.assignment_id
     LEFT JOIN __EWOH_SCHEMA__.ewoh_schedule_plan p ON p.plan_id = pa.plan_id
     WHERE evt.org_id IS NOT NULL
       AND evt.org_id <> COALESCE(pa.org_id, p.org_id)
  ) AS derived_org_mismatches;
