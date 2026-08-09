-- EWOH Command Map 智能调度 — Policy 生命周期 + 激活审计 (Phase 4 / P4-GATE, standalone_020)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS（幂等）。
--
-- 1) ewoh_scheduling_policy.status：DRAFT/SHADOW/ACTIVE/ARCHIVED 状态机。
--    迁移语义：既有 active=true 行 → ACTIVE；active=false 行 → ARCHIVED（
--    DRAFT/SHADOW 是新流程显式设置的中间态）。active boolean 保留兼容。
-- 2) ewoh_policy_activation：激活审计（operator/reason/before/after/gate 结果/rollback target）。
-- 3) ewoh_schedule_plan.shadow_policy_version：Shadow Plan 标记生成策略版本 +
--    is_shadow 语义化列（服务端 hard guard 依据，approve/dispatch/reserve 拒绝）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy
  ADD COLUMN IF NOT EXISTS status varchar(20);

UPDATE __EWOH_SCHEMA__.ewoh_scheduling_policy
SET status = CASE WHEN active THEN 'ACTIVE' ELSE 'ARCHIVED' END
WHERE status IS NULL;

ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy
  ALTER COLUMN status SET DEFAULT 'DRAFT';
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy
  ALTER COLUMN status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_policy_status
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy (status);
-- 同一 org 同一 status 的版本唯一性（active policy 唯一：org + ACTIVE 唯一）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_policy_org_active
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy (org_id, status)
  WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_policy_activation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activation_id varchar(255) NOT NULL UNIQUE,
  org_id varchar(255),
  policy_version integer NOT NULL,
  before_version integer,
  after_version integer,
  operator varchar(255) NOT NULL,
  reason text,
  gate_result_json jsonb DEFAULT '{}'::jsonb,
  rollback_target integer,
  status varchar(50) NOT NULL DEFAULT 'ACTIVATED',
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ewoh_policy_activation_policy
  ON __EWOH_SCHEMA__.ewoh_policy_activation (policy_version);
CREATE INDEX IF NOT EXISTS idx_ewoh_policy_activation_org
  ON __EWOH_SCHEMA__.ewoh_policy_activation (org_id);

ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS shadow_policy_version integer;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS is_shadow boolean DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_ewoh_schedule_plan_is_shadow
  ON __EWOH_SCHEMA__.ewoh_schedule_plan (is_shadow);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_policy.status IS '策略状态机 DRAFT/SHADOW/ACTIVE/ARCHIVED（P4-GATE）';
COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_policy_activation IS '策略激活审计：operator/reason/before/after/gate/rollback target';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.is_shadow IS 'Shadow Plan 标识（服务端 hard guard：不可 approve/dispatch/reserve）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.shadow_policy_version IS '生成该 Shadow Plan 的策略版本';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_policy_activation TO service_role;
