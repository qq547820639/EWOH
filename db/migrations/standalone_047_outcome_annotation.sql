-- EWOH 结果标注台账 (standalone_047, ADR-034 / §10 Level 7 + §12)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-034，contracts/learning/outcome-annotation.schema.json）：
--   1) Decision→Outcome 结构化事实（学习回路模型腿的真值来源前置）：
--      targetType/targetKind 封闭注册表 + judgedBy/judgedAt 判定事实完整
--      （CHECK 兜底，§33）+ measured 度量快照（jsonb 可空 = 显式不携带）；
--   2) 同标注幂等：UNIQUE (org_id, annotation_id)；
--   3) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--      outcome_annotation_org_isolation）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_outcome_annotation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  annotation_id varchar(255) NOT NULL,
  target_type varchar(32) NOT NULL,
  target_id varchar(255) NOT NULL,
  outcome_kind varchar(32) NOT NULL,
  judged_by varchar(255) NOT NULL,
  judged_at timestamptz NOT NULL,
  measured_json jsonb,
  comment text,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_outcome_annotation_target
    CHECK (target_type IN ('plan', 'decision', 'proposal', 'agent_command')),
  CONSTRAINT chk_ewoh_outcome_annotation_kind
    CHECK (outcome_kind IN ('success', 'partial_success', 'failure', 'invalid')),
  CONSTRAINT chk_ewoh_outcome_annotation_judger
    CHECK (length(btrim(judged_by)) > 0),
  CONSTRAINT uq_ewoh_outcome_annotation UNIQUE (org_id, annotation_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_outcome_annotation IS
  'Decision→Outcome 结果标注台账（ADR-034/§10 Level 7）。学习回路模型腿的真值来源前置：targetType/outcomeKind 封闭注册表 + judgedBy/judgedAt 判定事实完整 + measured 度量快照（缺省=显式不携带不猜测）；modelAccuracy 在真实可训练模型落地前保持显式 unknown（§33 不造假）。TENANT_SCOPED（RLS outcome_annotation_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outcome_annotation.measured_json IS '可测度量快照（delayMs/deviation/acceptance 等数值键；缺省=显式不携带）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_outcome_annotation.judged_by IS '人工判定者（非空 CHECK 兜底，§33 判定事实完整）';

CREATE INDEX IF NOT EXISTS idx_ewoh_outcome_annotation_target
  ON __EWOH_SCHEMA__.ewoh_outcome_annotation (org_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_outcome_annotation_kind
  ON __EWOH_SCHEMA__.ewoh_outcome_annotation (org_id, outcome_kind);

ALTER TABLE __EWOH_SCHEMA__.ewoh_outcome_annotation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outcome_annotation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_outcome_annotation;
CREATE POLICY outcome_annotation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_outcome_annotation
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_outcome_annotation TO service_role;
