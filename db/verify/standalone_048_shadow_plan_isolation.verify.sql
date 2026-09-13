-- standalone_048_shadow_plan_isolation 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-038 / §13）：
--   1) 约束 chk_ewoh_schedule_plan_shadow_not_production 存在
--   2) 约束形状自证（DO 块 EXCEPTION 捕获，验证不落脏数据）：
--      - shadow + approved / dispatched / confirmed（遗留词表）必须被拒
--      - shadow + confirmed_by / confirmed_at 必须被拒（确认事实禁止）
--      - shadow + status='shadow' 无确认事实 → 合法（控制组）
--      - 非 shadow + approved + 确认事实 → 合法（控制组，随后删除）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  missing text := '';
  at_chk integer := 0;
  bad_approved_rejected boolean := false;
  bad_dispatched_rejected boolean := false;
  bad_confirmed_rejected boolean := false;
  bad_confirmed_by_rejected boolean := false;
  bad_confirmed_at_rejected boolean := false;
  shadow_ok boolean := false;
  production_ok boolean := false;
BEGIN
  SELECT count(*) INTO at_chk FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = 'ewoh_schedule_plan'
      AND con.conname = 'chk_ewoh_schedule_plan_shadow_not_production';
  IF at_chk <> 1 THEN
    missing := missing || format('constraint at=%s ', at_chk);
  END IF;

  -- 注意：ewoh_schedule_plan.org_id 是 **uuid**（身份域），字面量必须是合法 uuid；
  -- 用 'verify-048' 这类可读串会直接 "invalid input syntax for type uuid"（全新库实测）。
  -- 1) shadow + approved 必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-a', 'verify', 'verify', 'approved', true);
    RAISE EXCEPTION 'shadow+approved 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_approved_rejected := true;
  END;

  -- 2) shadow + dispatched 必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-b', 'verify', 'verify', 'dispatched', true);
    RAISE EXCEPTION 'shadow+dispatched 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_dispatched_rejected := true;
  END;

  -- 3) shadow + confirmed（遗留词表）必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-c', 'verify', 'verify', 'confirmed', true);
    RAISE EXCEPTION 'shadow+confirmed 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_confirmed_rejected := true;
  END;

  -- 4) shadow + confirmed_by（确认事实）必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow, confirmed_by)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-d', 'verify', 'verify', 'shadow', true, 'verify-user');
    RAISE EXCEPTION 'shadow+confirmed_by 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_confirmed_by_rejected := true;
  END;

  -- 5) shadow + confirmed_at（确认事实）必须被 CHECK 拒绝
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow, confirmed_at)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-e', 'verify', 'verify', 'shadow', true, now());
    RAISE EXCEPTION 'shadow+confirmed_at 未被拒绝';
  EXCEPTION WHEN check_violation THEN
    bad_confirmed_at_rejected := true;
  END;

  -- 6) 控制组：shadow + status='shadow' 无确认事实 → 合法（随后删除）
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-f', 'verify', 'verify', 'shadow', true);
    shadow_ok := true;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = 'verify-048-f';
  EXCEPTION WHEN OTHERS THEN
    shadow_ok := false;
  END;

  -- 7) 控制组：非 shadow + approved + 确认事实 → 合法（随后删除）
  BEGIN
    INSERT INTO ewoh_schedule_plan (org_id, plan_id, plan_name, strategy, status, is_shadow, confirmed_by, confirmed_at)
      VALUES ('00000000-0000-4000-8000-0000000000ff', 'verify-048-g', 'verify', 'verify', 'approved', false, 'verify-user', now());
    production_ok := true;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = 'verify-048-g';
  EXCEPTION WHEN OTHERS THEN
    production_ok := false;
  END;

  IF missing <> '' OR NOT bad_approved_rejected OR NOT bad_dispatched_rejected
     OR NOT bad_confirmed_rejected OR NOT bad_confirmed_by_rejected
     OR NOT bad_confirmed_at_rejected OR NOT shadow_ok OR NOT production_ok THEN
    RAISE EXCEPTION 'standalone_048 verify incomplete: % rejected=[%,%,%,%,%] controls=[%,%]',
      missing, bad_approved_rejected, bad_dispatched_rejected, bad_confirmed_rejected,
      bad_confirmed_by_rejected, bad_confirmed_at_rejected, shadow_ok, production_ok;
  END IF;
END $$;

SELECT 1 AS standalone_048_verified;
