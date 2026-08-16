-- EWOH 学习提案台账 (standalone_045, ADR-026 / NO-12b, §10 Level 7 + §12 反馈腿)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-026，contracts/learning/learning-proposal.schema.json）：
--   1) 策略(规则阈值)更新提案一等资产：kind=rule_threshold（v1 唯一有确定性
--      影子评估器的类型）；status 状态机 proposed→shadow_evaluated→
--      approved→rolled_back / rejected；
--   2) 激活阶梯 = 人审（§2 绝不隐式自动执行）：approved 必须 approved_by +
--      approved_at（CHECK 兜底）；无影子证据的激活被 shadow_eval_json 前置
--      CHECK 拒绝（§33）；rejected/rolled_back 必须带非空理由（CHECK 兜底）；
--   3) 阈值契约：baseline_value/candidate_value ∈ [0,1] 且互不相等（CHECK）；
--   4) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--      learning_proposal_org_isolation）+ UNIQUE (org_id, proposal_id)。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_learning_proposal：学习提案台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_learning_proposal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  proposal_id varchar(180) NOT NULL,
  kind varchar(32) NOT NULL,
  status varchar(24) NOT NULL,
  rule_id varchar(64) NOT NULL,
  parameter varchar(32) NOT NULL,
  baseline_value double precision NOT NULL,
  candidate_value double precision NOT NULL,
  shadow_eval_json jsonb,
  approved_by varchar(128),
  approved_at timestamptz,
  rejected_by varchar(128),
  rejected_reason text,
  rolled_back_by varchar(128),
  rolled_back_reason text,
  evaluation_ref_json jsonb,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_learning_proposal_kind
    CHECK (kind IN ('rule_threshold')),
  CONSTRAINT chk_ewoh_learning_proposal_status
    CHECK (status IN ('proposed', 'shadow_evaluated', 'approved', 'rolled_back', 'rejected')),
  CONSTRAINT chk_ewoh_learning_proposal_rule
    CHECK (rule_id IN ('rule:worker-overload')),
  CONSTRAINT chk_ewoh_learning_proposal_parameter
    CHECK (parameter IN ('workloadThreshold')),
  CONSTRAINT chk_ewoh_learning_proposal_values
    CHECK (baseline_value >= 0 AND baseline_value <= 1
      AND candidate_value >= 0 AND candidate_value <= 1
      AND baseline_value <> candidate_value),
  CONSTRAINT chk_ewoh_learning_proposal_shadow_gate
    CHECK (status NOT IN ('shadow_evaluated', 'approved', 'rolled_back')
      OR shadow_eval_json IS NOT NULL),
  CONSTRAINT chk_ewoh_learning_proposal_approval
    CHECK (status <> 'approved'
      OR (approved_by IS NOT NULL AND length(btrim(approved_by)) > 0 AND approved_at IS NOT NULL)),
  CONSTRAINT chk_ewoh_learning_proposal_rejection
    CHECK (status <> 'rejected'
      OR (rejected_by IS NOT NULL AND length(btrim(rejected_by)) > 0
        AND rejected_reason IS NOT NULL AND length(btrim(rejected_reason)) > 0)),
  CONSTRAINT chk_ewoh_learning_proposal_rollback
    CHECK (status <> 'rolled_back'
      OR (rolled_back_by IS NOT NULL AND length(btrim(rolled_back_by)) > 0
        AND rolled_back_reason IS NOT NULL AND length(btrim(rolled_back_reason)) > 0)),
  CONSTRAINT uq_ewoh_learning_proposal UNIQUE (org_id, proposal_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_learning_proposal IS
  '学习回路 v2 反馈腿台账（ADR-026/NO-12b，§10 Level 7）。策略(规则阈值)更新提案：影子评估前置（无影子证据的激活被 CHECK 拒绝）+ 人审激活阶梯（approved 必须 approver+时间，§2 绝不隐式自动执行）+ 回滚/拒绝理由强制（§33）。TENANT_SCOPED（RLS learning_proposal_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_proposal.shadow_eval_json IS '确定性影子评估结论（历史重放 fired 差集 + riskLevel；shadow_evaluated/approved/rolled_back 必填）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_proposal.approved_by IS '人审批准者（approved 必填非空——激活阶梯 = 人审，§2）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_proposal.rolled_back_reason IS 'rolled_back 必填非空（CHECK 兜底，§33 不静默回滚）';

CREATE INDEX IF NOT EXISTS idx_ewoh_learning_proposal_status
  ON __EWOH_SCHEMA__.ewoh_learning_proposal (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_learning_proposal_rule
  ON __EWOH_SCHEMA__.ewoh_learning_proposal (org_id, rule_id);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_proposal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learning_proposal_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_proposal;
CREATE POLICY learning_proposal_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_proposal
  FOR ALL
  TO service_role
  USING (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  )
  WITH CHECK (
    org_id = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_learning_proposal TO service_role;
