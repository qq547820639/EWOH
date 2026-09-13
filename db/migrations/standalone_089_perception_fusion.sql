-- EWOH 多模态感知融合快照 (standalone_089, NO-56a, §5 感知融合层)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（`docs/architecture/embodied_factory.md` §5）：融合公式与五条可解释规则此前只有
-- 文档与分散的单源判定，**没有一份"当时系统看到的是什么、可信吗"的快照**，
-- 上游（推理/调度/页面）也无法据"低置信度不生成强建议"做门控。
--   1) 本表存**融合快照**：多源观测（UWB/外骨骼 IMU/视觉/工位语义/任务上下文）的
--      一致性结论、置信度（可解释加权，不是概率）、冲突明细、被排除证据、规则留痕；
--   2) 契约兜底（与 `shared/perception-fusion.ts` 的 validateFusedPerception 对齐）：
--      · 无可用源 → 必须 unknown + score IS NULL（不许显示成 0%）；
--      · 证据不足/冲突/低置信 → 不许允许强建议（原则 5/7）；
--   3) 租户边界：TENANT_SCOPED（org_id varchar(255) NOT NULL + RLS
--      perception_fusion_org_isolation）+ UNIQUE (org_id, fusion_id)（快照号确定性 → 重复扫描幂等）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_perception_fusion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  fusion_id varchar(180) NOT NULL,
  subject_id varchar(180) NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  fused_at timestamptz NOT NULL,
  agreement varchar(16) NOT NULL,
  confidence_level varchar(16) NOT NULL,
  confidence_score double precision,
  degraded boolean NOT NULL DEFAULT false,
  strong_advice_allowed boolean NOT NULL DEFAULT false,
  station_id varchar(255),
  conflict_count integer NOT NULL DEFAULT 0,
  usable_source_count integer NOT NULL DEFAULT 0,
  sources_json jsonb NOT NULL,
  conflicts_json jsonb NOT NULL,
  rule_trace_json jsonb NOT NULL,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by varchar(255),
  _updated_by varchar(255),
  CONSTRAINT uq_ewoh_perception_fusion UNIQUE (org_id, fusion_id),
  CONSTRAINT chk_ewoh_perception_fusion_agreement
    CHECK (agreement IN ('consistent', 'partial', 'conflict', 'insufficient')),
  CONSTRAINT chk_ewoh_perception_fusion_level
    CHECK (confidence_level IN ('high', 'medium', 'low', 'unknown')),
  CONSTRAINT chk_ewoh_perception_fusion_score
    CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),
  -- 无可用源 → 不许给级别/分数（诚实优于好看的 0%）。
  CONSTRAINT chk_ewoh_perception_fusion_no_source
    CHECK (usable_source_count > 0
      OR (confidence_level = 'unknown' AND confidence_score IS NULL)),
  -- 证据不足/冲突/低置信 → 不许允许强建议。
  CONSTRAINT chk_ewoh_perception_fusion_strong_advice
    CHECK (strong_advice_allowed = false
      OR (agreement NOT IN ('insufficient', 'conflict')
        AND confidence_level IN ('high', 'medium')
        AND conflict_count = 0)),
  CONSTRAINT chk_ewoh_perception_fusion_window
    CHECK (window_start <= window_end)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_perception_fusion IS
  '多模态感知融合快照（NO-56a，§5）：多源观测的一致性/冲突/置信度/排除证据/规则留痕。置信度是可解释加权（可用源权重和/应有源权重和），不是标定概率。TENANT_SCOPED（RLS perception_fusion_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_perception_fusion.confidence_score IS
  '可解释加权分（0..1）；NULL = 无可用源（页面必须显示"证据不足"，不许显示 0%）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_perception_fusion.strong_advice_allowed IS
  '是否允许上游据此生成强建议（§5 规则 5：低置信度/有冲突一律 false）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_perception_fusion.sources_json IS
  '各源观测明细 + 可用/排除状态（stale/untrusted/dimension_mismatch），缺失与排除都必须可见';

CREATE INDEX IF NOT EXISTS idx_ewoh_perception_fusion_subject
  ON __EWOH_SCHEMA__.ewoh_perception_fusion (org_id, subject_id, fused_at DESC);
CREATE INDEX IF NOT EXISTS idx_ewoh_perception_fusion_agreement
  ON __EWOH_SCHEMA__.ewoh_perception_fusion (org_id, agreement, fused_at DESC);

ALTER TABLE __EWOH_SCHEMA__.ewoh_perception_fusion ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS perception_fusion_org_isolation
  ON __EWOH_SCHEMA__.ewoh_perception_fusion;
CREATE POLICY perception_fusion_org_isolation
  ON __EWOH_SCHEMA__.ewoh_perception_fusion
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_perception_fusion TO service_role;
