-- EWOH Agent 命令审批台账 (standalone_049, ADR-039 / NO-12p, §11 + ADR-030 决策 4 收口)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-039）：Agent 待批命令原为进程内存（ADR-030 决策 4 显式记录的
-- 已知边界）——进程重启后待批清单清空、审批实例失效（§20 可靠性缺口）。
-- 本表把待批事实落库：propose 写 pending 行；resolve 经 CAS
-- （WHERE status='pending' RETURNING）写 approved/rejected/expired +
-- resolved_at/resolved_by/resolution_json（§33 过期显式不静默）。
-- 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS agent_approval_org_isolation）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_agent_approval (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  approval_id varchar(255) NOT NULL,
  agent_id varchar(255) NOT NULL,
  command varchar(255) NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  roles_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'pending',
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  resolved_at timestamptz(3),
  resolved_by varchar(255),
  resolution_json jsonb,
  _updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT uq_ewoh_agent_approval UNIQUE (org_id, approval_id),
  CONSTRAINT chk_ewoh_agent_approval_status
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  CONSTRAINT chk_ewoh_agent_approval_resolved
    CHECK ((status = 'pending') = (resolved_at IS NULL)),
  CONSTRAINT chk_ewoh_agent_approval_roles
    CHECK (jsonb_typeof(roles_json) = 'array')
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_agent_approval IS
  'Agent 命令审批台账（ADR-039/NO-12p，§11）：Agent 待批命令跨重启持久化（ADR-030 决策 4 边界收口）。propose 落 pending；resolve 经 CAS 写 approved/rejected/expired + resolved_at/resolved_by/resolution_json；状态与 resolved_at 一致性由 CHECK 兜底（pending ⇔ resolved_at IS NULL）。TENANT_SCOPED（RLS agent_approval_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_approval.payload_json IS '待执行命令载荷快照（批准后经 executeAuthorized 原样重放）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_approval.roles_json IS '审批角色列表（propose 时刻 agentApprovalRoles 快照）';

CREATE INDEX IF NOT EXISTS idx_ewoh_agent_approval_status
  ON __EWOH_SCHEMA__.ewoh_agent_approval (org_id, status);

ALTER TABLE __EWOH_SCHEMA__.ewoh_agent_approval ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_approval_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_approval;
CREATE POLICY agent_approval_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_approval
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_agent_approval TO service_role;
