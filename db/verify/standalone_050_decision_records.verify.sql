-- standalone_050_decision_records 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-048 / NO-12y）：
--   1) 列 decision_records_json 存在且类型 jsonb
--   2) 形状自证（DO 块，验证不落脏数据）：
--      - 写入 DecisionRecord 形状 JSON → 读回一致（roundtrip）
--      - 显式 NULL 写回合法（存量未投影行语义）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  roundtrip_ok boolean := false;
  null_ok boolean := false;
  probe_plan text := 'verify-050-decision-records';
BEGIN
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'decision_records_json' AND data_type = 'jsonb';

  -- 1) 写入 DecisionRecord 形状 JSON → 读回一致（随后删除，不留脏数据）
  BEGIN
    INSERT INTO ewoh_schedule_plan
      (plan_id, plan_name, strategy, status, decision_records_json)
      VALUES
      (probe_plan, 'verify-050', 'verify', 'shadow',
       '[{"decisionId":"decision:verify:1","kind":"task_assignment","status":"proposed","decisionAuthority":"optimization","subject":"task:t-1","tenantId":"verify-050","riskLevel":"low","requiresApproval":true,"decidedAt":"2026-08-16T08:00:00Z","selected":{"optionId":"opt:a","reason":["verify"]},"auditTrail":[{"actor":"solver:verify","action":"decided","at":"2026-08-16T08:00:00Z"}]}]'::jsonb);
    IF EXISTS (
      SELECT 1 FROM ewoh_schedule_plan
        WHERE plan_id = probe_plan
          AND decision_records_json @> '[{"decisionId":"decision:verify:1"}]'::jsonb
    ) THEN
      roundtrip_ok := true;
    END IF;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = probe_plan;
  EXCEPTION WHEN OTHERS THEN
    roundtrip_ok := false;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = probe_plan;
  END;

  -- 2) 显式 NULL 写回合法（存量未投影行语义）
  BEGIN
    INSERT INTO ewoh_schedule_plan
      (plan_id, plan_name, strategy, status, decision_records_json)
      VALUES (probe_plan, 'verify-050', 'verify', 'shadow', NULL);
    null_ok := true;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = probe_plan;
  EXCEPTION WHEN OTHERS THEN
    null_ok := false;
    DELETE FROM ewoh_schedule_plan WHERE plan_id = probe_plan;
  END;

  IF at_col <> 1 OR NOT roundtrip_ok OR NOT null_ok THEN
    RAISE EXCEPTION 'standalone_050 verify incomplete: column=% roundtrip=% null=%',
      at_col, roundtrip_ok, null_ok;
  END IF;
END $$;

SELECT 1 AS standalone_050_verified;
