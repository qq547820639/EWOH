-- EWOH 外骨骼会话台账 (standalone_046, ADR-032 / §7)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-032，contracts/exo/exo-session.schema.json）：
--   1) §7：外骨骼与 Person 的绑定必须是显式、临时且可审计的 Session
--      （不得永久假定一台设备属于某个人）；status 状态机
--      active→{ended, aborted}（终态不可复开）；
--   2) 唯一性机器强制：同一 (org_id, exo_id) 同时至多一个 active 会话
--      （部分唯一索引 WHERE status='active'——服务层 + DB 双强制）；
--   3) 结束事实完整：ended/aborted 必须 actual_end_at（CHECK 兜底，
--      §33 不悬空）；actual_end_at ≥ started_at（时间不倒退）；
--   4) 规范身份：exo_id device: 前缀 / person_id person: 前缀（ADR-006，
--      CHECK 前缀 + 服务层契约双强制）；
--   5) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS
--      exo_session_org_isolation）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_exo_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  session_id varchar(255) NOT NULL,
  exo_id varchar(255) NOT NULL,
  person_id varchar(255) NOT NULL,
  status varchar(16) NOT NULL,
  started_at timestamptz NOT NULL,
  expected_end_at timestamptz,
  actual_end_at timestamptz,
  ended_by varchar(255),
  reason text,
  operator_id varchar(255),
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_exo_session_status
    CHECK (status IN ('active', 'ended', 'aborted')),
  CONSTRAINT chk_ewoh_exo_session_exo_id
    CHECK (exo_id LIKE 'device:%'),
  CONSTRAINT chk_ewoh_exo_session_person_id
    CHECK (person_id LIKE 'person:%'),
  CONSTRAINT chk_ewoh_exo_session_end
    CHECK (status IN ('ended', 'aborted') OR actual_end_at IS NULL),
  CONSTRAINT chk_ewoh_exo_session_end_complete
    CHECK (status NOT IN ('ended', 'aborted') OR (actual_end_at IS NOT NULL AND ended_by IS NOT NULL)),
  CONSTRAINT chk_ewoh_exo_session_time_order
    CHECK (actual_end_at IS NULL OR actual_end_at >= started_at),
  CONSTRAINT uq_ewoh_exo_session UNIQUE (org_id, session_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_exo_session IS
  '外骨骼↔人员绑定会话台账（ADR-032/§7）。绑定是显式、临时且可审计的 Session（不得永久假定设备属于某人）：active→ended/aborted 终态状态机 + 同一外骨骼同时至多一个 active（部分唯一索引机器强制）+ 结束事实完整（ended/aborted 必须 actual_end_at + ended_by）。TENANT_SCOPED（RLS exo_session_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_session.exo_id IS '外骨骼规范身份（device: 前缀，ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_session.person_id IS '人员规范身份（person: 前缀，ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_session.actual_end_at IS 'ended/aborted 必填（结束事实完整，CHECK 兜底）';

-- 部分唯一索引：同一外骨骼同时至多一个 active 会话（§7 机器强制）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_exo_session_active_exo
  ON __EWOH_SCHEMA__.ewoh_exo_session (org_id, exo_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_ewoh_exo_session_status
  ON __EWOH_SCHEMA__.ewoh_exo_session (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_exo_session_person
  ON __EWOH_SCHEMA__.ewoh_exo_session (org_id, person_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_exo_session ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exo_session_org_isolation
  ON __EWOH_SCHEMA__.ewoh_exo_session;
CREATE POLICY exo_session_org_isolation
  ON __EWOH_SCHEMA__.ewoh_exo_session
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_exo_session TO service_role;
