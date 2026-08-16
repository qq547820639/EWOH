-- EWOH Agent Manifest 注册表 (standalone_037, ADR-016 / NO-06b, Phase 9)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-016 Agent Manifest 契约，contracts/agent/agent-manifest.schema.json）：
--   1) ewoh_agent_manifest：Agent 注册清单持久化——注册唯一入口（云侧
--      AgentService.register 先经 validateAgentManifest 契约校验 fail-closed
--      再落库）；manifest_json 为完整清单快照（审计），结构化列供过滤/统计；
--   2) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS agent_manifest_org_isolation
--      读 app.current_org_id，与 standalone_025 同 idiom）；业务键唯一约束在
--      (org_id, agent_id)；
--   3) 安全边界（§2/ADR-016）：Safety 角色写范围为空、critical 仅 L0/L1 等
--      由契约层机器规则强制（validateAgentManifest），本表 CHECK 仅守护枚举
--      列（status/risk_level/autonomous_level）；L4 不在任何枚举中。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后 Agent 注册写入将失败（fail-closed，不静默降级）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_agent_manifest：Agent 注册清单（TENANT_SCOPED，RLS 强制租户隔离）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_agent_manifest (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  agent_id varchar(180) NOT NULL,
  name varchar(255) NOT NULL,
  version integer NOT NULL DEFAULT 1,
  role varchar(64) NOT NULL,
  purpose text NOT NULL,
  allowed_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  read_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  write_scope jsonb NOT NULL DEFAULT '{"tokens":[],"commands":[]}'::jsonb,
  autonomous_level varchar(8) NOT NULL,
  risk_level varchar(16) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'registered',
  manifest_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_agent_manifest_status
    CHECK (status IN ('registered', 'suspended')),
  CONSTRAINT chk_ewoh_agent_manifest_risk
    CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT chk_ewoh_agent_manifest_level
    CHECK (autonomous_level IN ('L0', 'L1', 'L2', 'L3')),
  CONSTRAINT chk_ewoh_agent_manifest_version CHECK (version >= 1),
  CONSTRAINT uq_ewoh_agent_manifest UNIQUE (org_id, agent_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_agent_manifest IS
  'Agent 注册清单（ADR-016/NO-06b）。注册唯一入口：validateAgentManifest 契约校验 fail-closed 后落库；manifest_json 为完整清单快照（审计）。TENANT_SCOPED（RLS agent_manifest_org_isolation 强制 org 隔离）。安全边界（Safety 写空/critical 仅 L0-L1/L4 不允许）由契约层机器规则强制。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_manifest.agent_id IS '规范身份 agent:value（ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_manifest.role IS '15 类封闭注册表（contracts/agent schema agentRoleRegistry）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_manifest.autonomous_level IS 'Autonomous Level L0..L3（L4 永不允许，§2）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_manifest.status IS 'registered/suspended（暂停后执行器 fail-closed 拒绝执行）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_agent_manifest.manifest_json IS '完整清单快照（含 approvalRequirement/budget/timeoutSec/fallback/auditTrail，审计同源）';

CREATE INDEX IF NOT EXISTS idx_ewoh_agent_manifest_role
  ON __EWOH_SCHEMA__.ewoh_agent_manifest (org_id, role);
CREATE INDEX IF NOT EXISTS idx_ewoh_agent_manifest_status
  ON __EWOH_SCHEMA__.ewoh_agent_manifest (org_id, status);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_agent_manifest ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_manifest_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_manifest;
CREATE POLICY agent_manifest_org_isolation
  ON __EWOH_SCHEMA__.ewoh_agent_manifest
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_agent_manifest TO service_role;
