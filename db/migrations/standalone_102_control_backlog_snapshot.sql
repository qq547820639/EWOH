-- EWOH 投递积压**历史快照**表（NO-91a）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS + 幂等索引。
--
-- 背景：积压巡检（10 分钟节拍）产出提醒，但"积压随时间的趋势"没有事实载体——
-- 漂移要能被看见（on-time/lateness 有了 KPI 快照表，积压同样需要）。
-- 每次巡检落一条：org + 时间 + totals/devices 聚合（jsonb，逐设备明细内嵌）。
--
-- 回滚语义：DROP TABLE（派生观测数据，可重建）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_control_backlog_snapshot (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        varchar(255) NOT NULL,
  sla_ms        integer NOT NULL,
  escalation_multiplier integer NOT NULL,
  totals        jsonb NOT NULL,
  devices       jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ewoh_control_backlog_snapshot_org_time
  ON __EWOH_SCHEMA__.ewoh_control_backlog_snapshot (org_id, created_at DESC);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_control_backlog_snapshot IS
  '投递积压历史快照（NO-91a；巡检每次落一条，趋势可见漂移早发现）';

-- 租户隔离（RLS）：快照含 org_id，属租户作用域事实——与 KPI 快照表同款
-- org 隔离策略（app.current_org_id / app.primary_org_id GUC；audit-unrls-
-- tenant-tables 门禁裁决：此类表必须开 RLS，不允许"登记豁免"绕过）。
DROP POLICY IF EXISTS control_backlog_snapshot_org_isolation ON __EWOH_SCHEMA__.ewoh_control_backlog_snapshot;
CREATE POLICY control_backlog_snapshot_org_isolation ON __EWOH_SCHEMA__.ewoh_control_backlog_snapshot
  FOR ALL TO service_role
  USING (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  )
  WITH CHECK (
    org_id::text = COALESCE(
      NULLIF(current_setting('app.current_org_id', true), ''),
      NULLIF(current_setting('app.primary_org_id', true), '')
    ) OR org_id IS NULL
  );
ALTER TABLE __EWOH_SCHEMA__.ewoh_control_backlog_snapshot ENABLE ROW LEVEL SECURITY;

-- 运行时角色权限（ewoh_api 需读写；新表不会继承既有授权）
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_control_backlog_snapshot TO ewoh_api;
