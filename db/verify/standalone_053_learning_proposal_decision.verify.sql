-- standalone_053_learning_proposal_decision 验证（postgres.js 兼容）。
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 验证目标（ADR-063 / NO-13n）：
--   1) 列 decision_json 存在且类型 jsonb
--   2) 形状自证（DO 块，验证不落脏数据）：
--      - 写入 learning_proposal_activation DecisionRecord 形状 JSON → 读回一致
--      - 显式 NULL 写回合法（存量未投影行语义）

DO $$ BEGIN PERFORM set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false); END $$;

DO $$
DECLARE
  at_col integer := 0;
  roundtrip_ok boolean := false;
  null_ok boolean := false;
  probe_proposal text := 'lp:verify-053';
  -- 探针失败原因必须留痕（此前 EXCEPTION WHEN OTHERS 静默吞掉 → 只看到 roundtrip=f，无法定位）
  probe_err text := '';
BEGIN
  SELECT count(*) INTO at_col FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'ewoh_learning_proposal'
      AND column_name = 'decision_json' AND data_type = 'jsonb';

  -- 1) 写入 DecisionRecord 形状 JSON → 读回一致（随后删除，不留脏数据）
  BEGIN
    -- status='approved' 必须同时满足后续迁移收紧的两个 CHECK：
    --   chk_ewoh_learning_proposal_shadow_gate（有影子证据）与
    --   chk_ewoh_learning_proposal_approval（有批准人与时间）。
    -- 探针行必须按**终态约束**构造（2026-09-12 烧账：此前探针缺这两组字段 → 写入被拒 → roundtrip=false）。
    INSERT INTO ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value,
       candidate_value, record_json, shadow_eval_json, approved_by, approved_at, decision_json)
      VALUES
      ('verify-053', probe_proposal, 'rule_threshold', 'approved',
       'rule:worker-overload', 'workloadThreshold', 0.8, 0.75,
       '{"proposalId":"lp:verify-053","kind":"rule_threshold","status":"approved"}'::jsonb,
       '{"accepted":true,"reason":"verify-053 probe"}'::jsonb,
       'user:verify', '2026-08-16T08:00:00Z'::timestamptz,
       '{"decisionId":"decision:lp:verify-053:activation","kind":"learning_proposal_activation","status":"approved","decisionAuthority":"human","subject":"proposal:lp:verify-053","tenantId":"verify-053","riskLevel":"medium","requiresApproval":false,"decidedAt":"2026-08-16T08:00:00Z","selected":{"optionId":"opt:activate","reason":["approved"]},"approver":{"actor":"user:verify","at":"2026-08-16T08:00:00Z"},"auditTrail":[{"actor":"user:verify","action":"approved","at":"2026-08-16T08:00:00Z"}]}'::jsonb);
    IF EXISTS (
      SELECT 1 FROM ewoh_learning_proposal
        WHERE proposal_id = probe_proposal
          AND decision_json @> '{"decisionId":"decision:lp:verify-053:activation"}'::jsonb
    ) THEN
      roundtrip_ok := true;
    END IF;
    DELETE FROM ewoh_learning_proposal WHERE proposal_id = probe_proposal;
  EXCEPTION WHEN OTHERS THEN
    roundtrip_ok := false;
    probe_err := 'roundtrip: ' || SQLERRM;
    DELETE FROM ewoh_learning_proposal WHERE proposal_id = probe_proposal;
  END;

  -- 2) 显式 NULL 写回合法（存量未投影行语义）
  BEGIN
    INSERT INTO ewoh_learning_proposal
      (org_id, proposal_id, kind, status, rule_id, parameter, baseline_value,
       candidate_value, record_json, shadow_eval_json, approved_by, approved_at, decision_json)
      VALUES
      ('verify-053', probe_proposal, 'rule_threshold', 'approved',
       'rule:worker-overload', 'workloadThreshold', 0.8, 0.75,
       '{"proposalId":"lp:verify-053","kind":"rule_threshold","status":"approved"}'::jsonb,
       '{"accepted":true,"reason":"verify-053 probe"}'::jsonb,
       'user:verify', '2026-08-16T08:00:00Z'::timestamptz,
       NULL);
    null_ok := true;
    DELETE FROM ewoh_learning_proposal WHERE proposal_id = probe_proposal;
  EXCEPTION WHEN OTHERS THEN
    null_ok := false;
    probe_err := probe_err || ' | null: ' || SQLERRM;
    DELETE FROM ewoh_learning_proposal WHERE proposal_id = probe_proposal;
  END;

  IF at_col <> 1 OR NOT roundtrip_ok OR NOT null_ok THEN
    RAISE EXCEPTION 'standalone_053 verify incomplete: column=% roundtrip=% null=% err=%',
      at_col, roundtrip_ok, null_ok, probe_err;
  END IF;
END $$;

SELECT 1 AS standalone_053_verified;
