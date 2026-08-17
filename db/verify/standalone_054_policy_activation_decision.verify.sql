-- standalone_054_policy_activation_decision 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-064 / NO-13o）：
--   1) 列 decision_json 存在且类型 jsonb
--   2) 形状自证（DO 块，验证不落脏数据）：
--      - 写入 policy_activation DecisionRecord 形状 JSON → 读回一致
--      - 显式 NULL 写回合法（存量未投影行语义）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  roundtrip_ok boolean := false;
  null_ok boolean := false;
  probe_version integer := 990001;
BEGIN
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_scheduling_policy'
      AND column_name = 'decision_json' AND data_type = 'jsonb';

  -- 1) 写入 DecisionRecord 形状 JSON → 读回一致（随后删除，不留脏数据）
  BEGIN
    INSERT INTO ewoh_scheduling_policy
      (org_id, config_version, config_json, active, decision_json)
      VALUES
      ('verify-054', probe_version, '{"configVersion":990001,"horizonMinutes":480}'::jsonb, false,
       '{"decisionId":"decision:policy:v990001:activation","kind":"policy_activation","status":"executed","decisionAuthority":"human","subject":"policy:v990001","tenantId":"verify-054","riskLevel":"high","requiresApproval":false,"decidedAt":"2026-08-16T08:00:00Z","selected":{"optionId":"opt:activate","reason":["verify"]},"approver":{"actor":"user:verify","at":"2026-08-16T08:00:00Z"},"auditTrail":[{"actor":"user:verify","action":"activated","at":"2026-08-16T08:00:00Z"}]}'::jsonb);
    IF EXISTS (
      SELECT 1 FROM ewoh_scheduling_policy
        WHERE config_version = probe_version
          AND decision_json @> '{"decisionId":"decision:policy:v990001:activation"}'::jsonb
    ) THEN
      roundtrip_ok := true;
    END IF;
    DELETE FROM ewoh_scheduling_policy WHERE config_version = probe_version;
  EXCEPTION WHEN OTHERS THEN
    roundtrip_ok := false;
    DELETE FROM ewoh_scheduling_policy WHERE config_version = probe_version;
  END;

  -- 2) 显式 NULL 写回合法（存量未投影行语义）
  BEGIN
    INSERT INTO ewoh_scheduling_policy
      (org_id, config_version, config_json, active, decision_json)
      VALUES ('verify-054', probe_version, '{"configVersion":990001,"horizonMinutes":480}'::jsonb, false, NULL);
    null_ok := true;
    DELETE FROM ewoh_scheduling_policy WHERE config_version = probe_version;
  EXCEPTION WHEN OTHERS THEN
    null_ok := false;
    DELETE FROM ewoh_scheduling_policy WHERE config_version = probe_version;
  END;

  IF at_col <> 1 OR NOT roundtrip_ok OR NOT null_ok THEN
    RAISE EXCEPTION 'standalone_054 verify incomplete: column=% roundtrip=% null=%',
      at_col, roundtrip_ok, null_ok;
  END IF;
END $$;

SELECT 1 AS standalone_054_verified;
