-- EWOH 运行记忆信号台账 (standalone_087, NO-54a, §10 Level 7 + §12 反馈腿)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（学习回路接线，`docs/architecture/capability-alignment.md` §3 原 #2）：
--   1) 学习提案此前只有"人手工填规则+目标值"一条入口，**运行记忆没有接线**：
--      提醒治理指标（处置率/账龄/反复来源）、数据质量积压、执行偏差复发这些已落库
--      的事实，从来不会变成"该不该调策略"的候选；
--   2) 本表存**信号**（signal）：实测快照 + 证据引用 + 样本量 + 可信度 + 方向 + 不可执行理由。
--      信号**不是提案**：只有人在页面上点"生成提案"，才会走
--      `ewoh_learning_proposal` 的影子评估→人审激活阶梯；
--   3) 契约兜底（与 `shared/learning-signal.ts` 的 validateLearningSignal 对齐）：
--      · 可信度必须有样本支撑（confidence IS NULL OR sample_size >= 5）——样本不足不许下结论；
--      · 不可执行必须写理由（open 状态下 rule_id 与 not_actionable_reason 至少有一个）；
--      · 可执行三件套要么全空要么全有（rule_id/parameter/baseline_value/direction）；
--      · promoted 必须带提案号与决定人；dismissed 必须带非空理由（§33 不静默忽略）；
--   4) 租户边界：TENANT_SCOPED（org_id varchar(255) NOT NULL + RLS
--      learning_signal_org_isolation）+ UNIQUE (org_id, signal_id)（信号号确定性 → 重复扫描幂等）。
--
-- 为什么 org_id 是 varchar 而不是 uuid：与 ewoh_learning_proposal 保持一致（业务域字符串 id，
-- 身份域 uuid 混用已经在 standalone_028/085 上踩过类型不匹配的坑）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_learning_signal：运行记忆信号台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_learning_signal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  signal_id varchar(180) NOT NULL,
  kind varchar(32) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'open',
  subject_key varchar(180) NOT NULL,
  window_days integer NOT NULL,
  sample_size integer NOT NULL,
  confidence varchar(16),
  direction varchar(16),
  rule_id varchar(64),
  parameter varchar(32),
  baseline_value double precision,
  metrics_json jsonb NOT NULL,
  evidence_json jsonb NOT NULL,
  narrative_json jsonb NOT NULL,
  not_actionable_reason text,
  promoted_proposal_id varchar(180),
  decided_by varchar(255),
  decided_at timestamptz,
  decided_reason text,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by varchar(255),
  _updated_by varchar(255),
  CONSTRAINT uq_ewoh_learning_signal UNIQUE (org_id, signal_id),
  CONSTRAINT chk_ewoh_learning_signal_kind
    CHECK (kind IN ('notification_fatigue', 'data_quality_backlog', 'deviation_repeat')),
  CONSTRAINT chk_ewoh_learning_signal_status
    CHECK (status IN ('open', 'promoted', 'dismissed')),
  CONSTRAINT chk_ewoh_learning_signal_severity
    CHECK (severity IN ('low', 'medium', 'high')),
  CONSTRAINT chk_ewoh_learning_signal_confidence
    CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  -- 原则 7：没有样本就没有可信度。
  CONSTRAINT chk_ewoh_learning_signal_confidence_sample
    CHECK (confidence IS NULL OR sample_size >= 5),
  CONSTRAINT chk_ewoh_learning_signal_window
    CHECK (window_days >= 1 AND window_days <= 365),
  CONSTRAINT chk_ewoh_learning_signal_sample
    CHECK (sample_size >= 0),
  CONSTRAINT chk_ewoh_learning_signal_direction
    CHECK (direction IS NULL OR direction IN ('raise', 'lower')),
  -- 可执行三件套：要么全空（只提示），要么全有（可生成提案）。
  CONSTRAINT chk_ewoh_learning_signal_actionable_shape
    CHECK (
      (rule_id IS NULL AND parameter IS NULL AND baseline_value IS NULL AND direction IS NULL)
      OR (rule_id IS NOT NULL AND parameter IS NOT NULL AND baseline_value IS NOT NULL AND direction IS NOT NULL)
    ),
  -- 不可执行必须给理由（页面上要能读出"为什么只能提示"）。
  CONSTRAINT chk_ewoh_learning_signal_reason
    CHECK (rule_id IS NOT NULL OR (not_actionable_reason IS NOT NULL AND length(btrim(not_actionable_reason)) > 0)),
  CONSTRAINT chk_ewoh_learning_signal_baseline
    CHECK (baseline_value IS NULL OR (baseline_value >= 0 AND baseline_value <= 1)),
  CONSTRAINT chk_ewoh_learning_signal_promoted
    CHECK (status <> 'promoted'
      OR (promoted_proposal_id IS NOT NULL AND length(btrim(promoted_proposal_id)) > 0
        AND decided_by IS NOT NULL AND length(btrim(decided_by)) > 0 AND decided_at IS NOT NULL)),
  CONSTRAINT chk_ewoh_learning_signal_dismissed
    CHECK (status <> 'dismissed'
      OR (decided_by IS NOT NULL AND length(btrim(decided_by)) > 0 AND decided_at IS NOT NULL
        AND decided_reason IS NOT NULL AND length(btrim(decided_reason)) > 0))
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_learning_signal IS
  '运行记忆信号台账（NO-54a 学习回路接线）：提醒治理/数据质量积压/偏差复发 → 带证据、样本量、可信度与方向的信号。信号≠提案：只有人点"生成提案"才进 ewoh_learning_proposal 的影子评估→人审激活阶梯（§2 绝不隐式自动执行）。TENANT_SCOPED（RLS learning_signal_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_signal.confidence IS
  '可信度（low|medium|high）；NULL = 样本不足，不给结论（CHECK 要求 sample_size >= 5 才能非空）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_signal.not_actionable_reason IS
  '不可执行（无法映射到可提案参数）时的必填理由——页面要能读出"为什么只能提示"';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_signal.promoted_proposal_id IS
  '人点"生成提案"后创建的 ewoh_learning_proposal.proposal_id；信号本身不激活任何策略';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_signal.decided_reason IS
  '忽略（dismissed）必填非空理由（§33 不静默忽略）；重复扫描不会覆盖人的决定';

CREATE INDEX IF NOT EXISTS idx_ewoh_learning_signal_status
  ON __EWOH_SCHEMA__.ewoh_learning_signal (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_learning_signal_kind
  ON __EWOH_SCHEMA__.ewoh_learning_signal (org_id, kind, severity);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025/045 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_signal ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learning_signal_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_signal;
CREATE POLICY learning_signal_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_signal
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_learning_signal TO service_role;
