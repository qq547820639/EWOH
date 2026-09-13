-- EWOH 复盘/运行记忆台账 (standalone_075, DR-3 运行记忆)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（目标二闭环第⑩步"可追溯的经验和反馈"）：
--   1) 学习件（evaluation/proposal/annotation/duration-model）各自落账，但
--      "预测→决策→授权→执行→实际→偏差→经验"从未被组装成一条可读的运行记忆；
--   2) 本表是**组装产物**（assembled_json 为闭环六段结构化快照 + 各段证据引用），
--      不是新的第二事实源——每个字段都可回溯到既有台账行；
--   3) narrative 为 AI 总结（llm | rule_fallback 双路留痕，不伪造置信度）；
--   4) 同一 target 保持单一有效复盘：部分唯一索引（status <> superseded）；
--   5) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS）。
--
-- 回滚语义：全新（additive）；回滚 = DROP TABLE。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_retrospective (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  retrospective_id varchar(255) NOT NULL,
  scope varchar(32) NOT NULL,
  target_id varchar(255) NOT NULL,
  title varchar(255) NOT NULL,
  period_start timestamptz,
  period_end timestamptz,
  trigger_event_id varchar(255),
  status varchar(32) NOT NULL DEFAULT 'draft',
  assembled_json jsonb NOT NULL,
  narrative text,
  narrative_source varchar(32),
  narrative_model varchar(255),
  lessons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  data_quality_json jsonb,
  published_at timestamptz,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_retrospective_scope
    CHECK (scope IN ('plan', 'incident', 'shift')),
  CONSTRAINT chk_ewoh_retrospective_status
    CHECK (status IN ('draft', 'published', 'superseded')),
  CONSTRAINT chk_ewoh_retrospective_narrative_source
    CHECK (narrative_source IS NULL OR narrative_source IN ('llm', 'rule_fallback')),
  CONSTRAINT chk_ewoh_retrospective_lessons
    CHECK (jsonb_typeof(lessons_json) = 'array'),
  CONSTRAINT uq_ewoh_retrospective UNIQUE (org_id, retrospective_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_retrospective IS
  '复盘/运行记忆台账（DR-3）。scope=plan|incident|shift 的闭环组装产物：assembled_json 固定六段（perception/dataQuality/decision/authorization/execution/feedback，各段带证据引用 evidenceIds），narrative 为 AI 总结（llm|rule_fallback 显式留痕）。同一 target 至多一条非 superseded 复盘（部分唯一索引 uq_ewoh_retrospective_active_target）。TENANT_SCOPED（RLS retrospective_org_isolation）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_retrospective.assembled_json IS '闭环六段结构化组装（感知/数据质量/决策/授权/执行/反馈），只引用既有台账证据，不复制事实';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_retrospective.lessons_json IS '结构化经验条目 [{title, detail, severity, evidenceIds}]；AI 总结建议 + 人工修订后落账';

-- 部分唯一索引：同 target 至多一条有效复盘（superseded 之外）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_retrospective_active_target
  ON __EWOH_SCHEMA__.ewoh_retrospective (org_id, scope, target_id)
  WHERE status <> 'superseded';

CREATE INDEX IF NOT EXISTS idx_ewoh_retrospective_target
  ON __EWOH_SCHEMA__.ewoh_retrospective (org_id, scope, target_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_retrospective_status
  ON __EWOH_SCHEMA__.ewoh_retrospective (org_id, status);

ALTER TABLE __EWOH_SCHEMA__.ewoh_retrospective ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS retrospective_org_isolation ON __EWOH_SCHEMA__.ewoh_retrospective;
CREATE POLICY retrospective_org_isolation
  ON __EWOH_SCHEMA__.ewoh_retrospective
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_retrospective TO service_role;
