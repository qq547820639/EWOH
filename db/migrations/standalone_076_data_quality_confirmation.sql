-- EWOH 数据质量人工确认台账 (standalone_076, DR-4 闭环第②步)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（闭环第②步"系统确认数据质量"）：
--   1) 摄入侧自动分级（good/invalid + DataQualityAlert）已存在，但"人工确认/
--      质疑该数据可用于决策"这一步此前没有落点——数据质量是决策解释（原则 5）
--      与复盘（DR-3 dataQuality 段）的输入；
--   2) 本表登记**人对某事件数据质量的最终判定**：confirmed（可信，可用于
--      决策依据）/ contested（不可信，相关决策需复核）；判定人取服务端会话
--      （不信任客户端自报身份）；
--   3) 幂等：同一 (org_id, event_id) 至多一条最终判定（UNIQUE）；
--   4) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS）。
--
-- 回滚语义：全新（additive）；回滚 = DROP TABLE。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_data_quality_confirmation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  event_id varchar(255) NOT NULL,
  verdict varchar(32) NOT NULL,
  note text,
  confirmed_by varchar(255) NOT NULL,
  confirmed_at timestamptz NOT NULL,
  context_json jsonb,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_dq_confirmation_verdict
    CHECK (verdict IN ('confirmed', 'contested')),
  CONSTRAINT chk_ewoh_dq_confirmation_judger
    CHECK (length(btrim(confirmed_by)) > 0),
  CONSTRAINT uq_ewoh_dq_confirmation UNIQUE (org_id, event_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_data_quality_confirmation IS
  '数据质量人工确认台账（DR-4，闭环第②步）。登记人对单一事件数据质量的最终判定：confirmed=可信可用于决策 / contested=不可信相关决策需复核。判定人取服务端会话身份（不信任客户端自报）。同一事件至多一条最终判定（UNIQUE 幂等；改判 = UPDATE 覆盖并留审计）。TENANT_SCOPED（RLS dq_confirmation_org_isolation）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_data_quality_confirmation.context_json IS '判定时数据形态快照（freshness/quality 分级/来源），只作展示留痕，不作为第二事实源';

CREATE INDEX IF NOT EXISTS idx_ewoh_dq_confirmation_event
  ON __EWOH_SCHEMA__.ewoh_data_quality_confirmation (org_id, event_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_data_quality_confirmation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dq_confirmation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_data_quality_confirmation;
CREATE POLICY dq_confirmation_org_isolation
  ON __EWOH_SCHEMA__.ewoh_data_quality_confirmation
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_data_quality_confirmation TO service_role;
