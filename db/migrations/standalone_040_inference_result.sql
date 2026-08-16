-- EWOH 云侧推理结果台账 (standalone_040, ADR-019 / NO-08a, Phase 8)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-019，contracts/intelligence/inference-result.schema.json）：
--   1) 云侧模型结果历史单一事实源：Canonical InferenceResult（ADR-013）
--      的审计台账——level 七级注册表 / confidence / OOD indicator /
--      dataQuality / evidence 三要素落列，完整契约快照落 result_json
--      （审计同源）；Phase 12 Learning Loop 的时间窗口查询面；
--   2) 写入唯一入口：InferenceResultService.recordInferenceResult
--      （validateInferenceResult 契约校验 fail-closed 后落库，§33 禁止旁路）；
--   3) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--      inference_result_org_isolation 读 app.current_org_id，与 standalone_025
--      同 idiom）；业务键唯一约束在 (org_id, inference_id)；
--   4) OOD 一致性 / confidence 区间 / dataQuality 三态由 DB CHECK 兜底
--      （契约规则的数据库执行面）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后推理结果写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_inference_result：云侧推理结果台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_inference_result (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  inference_id varchar(180) NOT NULL,
  subject_id varchar(180) NOT NULL,
  level varchar(32) NOT NULL,
  model_id varchar(180) NOT NULL,
  model_version varchar(64) NOT NULL,
  input_version varchar(64) NOT NULL,
  label varchar(255) NOT NULL,
  confidence double precision NOT NULL,
  ood_flag boolean NOT NULL DEFAULT false,
  ood_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_quality varchar(16) NOT NULL,
  evidence_ts_start timestamptz NOT NULL,
  evidence_ts_end timestamptz NOT NULL,
  evidence_is_rule boolean NOT NULL,
  result_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_inference_result_level
    CHECK (level IN ('L1_deterministic_rules', 'L2_statistical_ml', 'L3_optimization',
                     'L4_industrial_reasoning', 'L5_agentic_workflow',
                     'L6_simulation_digital_twin', 'L7_learning_loop')),
  CONSTRAINT chk_ewoh_inference_result_confidence
    CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT chk_ewoh_inference_result_data_quality
    CHECK (data_quality IN ('good', 'degraded', 'invalid')),
  CONSTRAINT chk_ewoh_inference_result_ood
    CHECK (
      (ood_flag = false AND jsonb_array_length(ood_reasons) = 0)
      OR (ood_flag = true AND jsonb_array_length(ood_reasons) > 0)
    ),
  CONSTRAINT uq_ewoh_inference_result UNIQUE (org_id, inference_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_inference_result IS
  '云侧模型结果历史单一事实源（ADR-019/NO-08a，Canonical InferenceResult ADR-013）。写入唯一入口=InferenceResultService.recordInferenceResult（契约校验 fail-closed）；唯一 (org_id, inference_id) 幂等重放不重复发事件；TENANT_SCOPED（RLS inference_result_org_isolation）。边缘本地 store 为边缘运行时认知，本台账为跨运行时审计 + Phase 12 Learning Loop 输入。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_inference_result.level IS 'L1_deterministic_rules..L7_learning_loop（七级注册表，CHECK 守护）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_inference_result.ood_reasons IS 'OOD 原因数组（flag=true 时非空；CHECK 强制 flag/reasons 一致性）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_inference_result.result_json IS '完整契约快照（审计同源，含 evidence/OOD/dataQuality）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_inference_result.evidence_ts_start IS '证据窗口起点（ADR-013 evidence.tsStart，Learning Loop 时间窗口查询面）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_inference_result.evidence_ts_end IS '证据窗口终点（ADR-013 evidence.tsEnd）';

CREATE INDEX IF NOT EXISTS idx_ewoh_inference_result_level
  ON __EWOH_SCHEMA__.ewoh_inference_result (org_id, level);
CREATE INDEX IF NOT EXISTS idx_ewoh_inference_result_subject
  ON __EWOH_SCHEMA__.ewoh_inference_result (org_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_inference_result_window
  ON __EWOH_SCHEMA__.ewoh_inference_result (org_id, evidence_ts_start, evidence_ts_end);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_inference_result ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inference_result_org_isolation
  ON __EWOH_SCHEMA__.ewoh_inference_result;
CREATE POLICY inference_result_org_isolation
  ON __EWOH_SCHEMA__.ewoh_inference_result
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_inference_result TO service_role;
