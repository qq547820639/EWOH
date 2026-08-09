-- EWOH Command Map 智能调度驾驶舱 — Conflict Lifecycle 持久化 (Phase 3 / P3-T1)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- No physical foreign keys.
--
-- 背景（02 §6）：冲突从"实时推导"升级为"推导 + 落库 + 生命周期"。
-- 状态机：OPEN → ACKNOWLEDGED → RESOLVED；OPEN → SUPPRESSED（suppressUntil 到期自动回 OPEN）；
-- ACKNOWLEDGED → SUPPRESSED 允许；推导消失 → 自动 RESOLVED（resolution=auto_cleared，决策 D-C）。
-- 全部状态转移写 ewoh_schedule_audit（action=conflict.acknowledge|resolve|suppress|reopen）。
-- conflict_id 为内容种子哈希（跨推导稳定），用于推导结果与落库行归并。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_conflict (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conflict_id varchar(255) NOT NULL UNIQUE,
  type varchar(50) NOT NULL,
  severity varchar(20) NOT NULL,
  scope varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  task_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  resource_id varchar(255),
  resource_type varchar(50),
  plan_id varchar(255),
  snapshot_version varchar(255),
  message text NOT NULL,
  resolution varchar(255),
  data jsonb,
  detected_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_by varchar(255),
  acknowledged_at timestamptz(6),
  resolved_by varchar(255),
  resolved_at timestamptz(6),
  suppress_until timestamptz(6),
  org_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_conflict_status
  ON __EWOH_SCHEMA__.ewoh_scheduling_conflict (status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_conflict_type
  ON __EWOH_SCHEMA__.ewoh_scheduling_conflict (type);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_conflict_org
  ON __EWOH_SCHEMA__.ewoh_scheduling_conflict (org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_conflict_plan
  ON __EWOH_SCHEMA__.ewoh_scheduling_conflict (plan_id);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_conflict IS '调度冲突生命周期持久化（OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED，02 §6.1）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_conflict.conflict_id IS '内容种子哈希稳定 id（跨推导归并键）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_conflict.status IS 'OPEN/ACKNOWLEDGED/RESOLVED/SUPPRESSED';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_conflict.resolution IS '自动消除(auto_cleared)或人工处置说明';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_conflict TO service_role;
