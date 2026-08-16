-- EWOH 学习评估台账 (standalone_041, ADR-021 / NO-09a, Phase 12 Continuous Learning)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-021，contracts/learning/learning-evaluation.schema.json）：
--   1) 每 (org, 周期) 七项学习指标（§28）统一快照——Decision→Outcome 映射的
--      事实层（recommendationAcceptance/planSuccess/taskDelay/riskOutcome/
--      humanOverride/modelAccuracy/schedulerQuality）；
--   2) 写入唯一入口：LearningService.evaluate（真实事实聚合 + 契约校验
--      fail-closed）；evalId 由 (evaluationType, periodStart) 确定性推导
--      （le:{type}:{periodStart}）→ UNIQUE (org_id, eval_id) 幂等重评估
--      不重复发事件；
--   3) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--      learning_evaluation_org_isolation 读 app.current_org_id，与
--      standalone_025 同 idiom）；
--   4) 观测层定位（与 standalone_010 同原则）：学习评估绝不自动回写生产
--      调度规则/策略（§2 安全边界；变更走人审激活链）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后学习评估写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_learning_evaluation：学习评估台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_learning_evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  eval_id varchar(180) NOT NULL,
  evaluation_type varchar(16) NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  engine_version varchar(32) NOT NULL,
  metrics_json jsonb NOT NULL,
  basis_json jsonb NOT NULL,
  result_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_learning_evaluation_type
    CHECK (evaluation_type IN ('periodic', 'on_demand')),
  CONSTRAINT chk_ewoh_learning_evaluation_period
    CHECK (period_end >= period_start),
  CONSTRAINT uq_ewoh_learning_evaluation UNIQUE (org_id, eval_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_learning_evaluation IS
  '学习评估台账（ADR-021/NO-09a，Phase 12）。每 (org, 周期) 七项学习指标快照（§28）：写入唯一入口=LearningService.evaluate（真实事实聚合 + 契约校验 fail-closed）；evalId=(type, periodStart) 确定性推导幂等重评估不重复发事件；TENANT_SCOPED（RLS learning_evaluation_org_isolation）。观测层：绝不自动回写生产规则（§2）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_evaluation.metrics_json IS '七项指标快照（metricRegistry 封闭注册表；null=无数据或显式 unknown，绝不伪造）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_evaluation.basis_json IS '指标事实来源声明（§3 可追溯）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_learning_evaluation.result_json IS '完整契约快照（审计同源）';

CREATE INDEX IF NOT EXISTS idx_ewoh_learning_evaluation_period
  ON __EWOH_SCHEMA__.ewoh_learning_evaluation (org_id, period_start, period_end);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_learning_evaluation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learning_evaluation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_evaluation;
CREATE POLICY learning_evaluation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_learning_evaluation
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_learning_evaluation TO service_role;
