-- standalone_052_agent_approval_decision 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-059 / NO-13j）：
--   1) 列 decision_json 存在且类型 jsonb
--   2) 形状自证（DO 块，验证不落脏数据）：
--      - 写入 agent_approval DecisionRecord 形状 JSON → 读回一致（roundtrip）
--      - 显式 NULL 写回合法（存量未投影行语义）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  roundtrip_ok boolean := false;
  null_ok boolean := false;
  probe_approval text := 'verify-052-agent-approval';
BEGIN
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_agent_approval'
      AND column_name = 'decision_json' AND data_type = 'jsonb';

  -- 1) 写入 agent_approval DecisionRecord 形状 JSON → 读回一致（随后删除，不留脏数据）
  BEGIN
    INSERT INTO ewoh_agent_approval
      (org_id, approval_id, agent_id, command, decision_json)
      VALUES
      ('verify-052', probe_approval, 'agent:verify-052', 'propose_plan',
       '{"decisionId":"decision:verify-052:agent-approval","kind":"agent_approval","status":"rejected","decisionAuthority":"human","subject":"agent:agent:verify-052","tenantId":"verify-052","riskLevel":"medium","requiresApproval":false,"decidedAt":"2026-08-16T08:00:00Z","selected":{"optionId":"opt:reject","reason":["verify"]},"approver":{"actor":"user:verify","at":"2026-08-16T08:00:00Z"},"auditTrail":[{"actor":"user:verify","action":"rejected","at":"2026-08-16T08:00:00Z"}]}'::jsonb);
    IF EXISTS (
      SELECT 1 FROM ewoh_agent_approval
        WHERE approval_id = probe_approval
          AND decision_json @> '{"decisionId":"decision:verify-052:agent-approval"}'::jsonb
    ) THEN
      roundtrip_ok := true;
    END IF;
    DELETE FROM ewoh_agent_approval WHERE approval_id = probe_approval;
  EXCEPTION WHEN OTHERS THEN
    roundtrip_ok := false;
    DELETE FROM ewoh_agent_approval WHERE approval_id = probe_approval;
  END;

  -- 2) 显式 NULL 写回合法（存量未投影行语义）
  BEGIN
    INSERT INTO ewoh_agent_approval
      (org_id, approval_id, agent_id, command, decision_json)
      VALUES ('verify-052', probe_approval, 'agent:verify-052', 'propose_plan', NULL);
    null_ok := true;
    DELETE FROM ewoh_agent_approval WHERE approval_id = probe_approval;
  EXCEPTION WHEN OTHERS THEN
    null_ok := false;
    DELETE FROM ewoh_agent_approval WHERE approval_id = probe_approval;
  END;

  IF at_col <> 1 OR NOT roundtrip_ok OR NOT null_ok THEN
    RAISE EXCEPTION 'standalone_052 verify incomplete: column=% roundtrip=% null=%',
      at_col, roundtrip_ok, null_ok;
  END IF;
END $$;

SELECT 1 AS standalone_052_verified;
