-- EWOH Edge→Cloud 事件上行传输级幂等去重台账 (standalone_036, ADR-009 / NO-04b)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-009 信封幂等 + §20 可靠性，NO-04b Phase 4 事件骨干）：
--   1) Edge 上行 Catalog 信封事件（EntityDeclared/EntityStateObserved/规则事件等）
--      到 POST /api/ingest/events；重复投递（重试/网络重放）必须在传输级幂等：
--      去重键 = (org_id, source, event_id)——同一租户内同一来源同一事件 ID
--      只落一次事件行，重复消息不重复投递（契约 dedup 语义的租户化执行面；
--      跨租户同 (source,event_id) 互不干扰，§15 多租户边界）。
--   2) 时间语义随台账落库：occurred_at（设备事件时刻）/ received_at（云端接收
--      时刻）/ is_late（>10min 迟到，标记不丢弃）/ clock_drift（越 5min 容忍界，
--      标记不重写）——Late/Drift 全链路可审计（ADR-009/ADR-021 时间语义）。
--   3) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS ingest_event_dedup_org_isolation
--      读 app.current_org_id，与 standalone_025 同 idiom）；业务键唯一约束在
--      (org_id, source, event_id)。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后 Edge 事件上行写入将失败（fail-closed，不静默降级为不去重直写）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_ingest_event_dedup：事件上行传输级幂等去重台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_ingest_event_dedup (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  source varchar(255) NOT NULL,
  event_id varchar(255) NOT NULL,
  event_type varchar(128),
  occurred_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now(),
  is_late boolean NOT NULL DEFAULT false,
  clock_drift boolean NOT NULL DEFAULT false,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ewoh_ingest_event_dedup UNIQUE (org_id, source, event_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_ingest_event_dedup IS
  'Edge→Cloud 事件上行传输级幂等去重台账（ADR-009/NO-04b）。去重键 (org_id, source, event_id)：同租户同来源同事件 ID 只落一次；is_late/clock_drift 随台账落库（ADR-009 时间语义全链路可审计）。TENANT_SCOPED（RLS ingest_event_dedup_org_isolation 强制 org 隔离）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.org_id IS '租户归属（TENANT_SCOPED，RLS ingest_event_dedup_org_isolation 强制）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.source IS '信封 source（如 edge:world-projection / edge:rule-engine）——去重键组成';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.event_id IS '信封 eventId——去重键组成';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.event_type IS 'Catalog 事件类型（contracts/events/event-catalog.yaml，49 类）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.occurred_at IS '事件发生时刻（信封 occurredAt，设备事实时间）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.received_at IS '云端接收时刻（信封 receivedAt）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.is_late IS 'receivedAt − occurredAt > 10min（ADR-009 迟到标记，不丢弃）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ingest_event_dedup.clock_drift IS '时间三元组越 5min 容忍界（ADR-009 漂移标记，不重写）';

CREATE INDEX IF NOT EXISTS idx_ewoh_ingest_event_dedup_org_time
  ON __EWOH_SCHEMA__.ewoh_ingest_event_dedup (org_id, received_at);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_ingest_event_dedup ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ingest_event_dedup_org_isolation
  ON __EWOH_SCHEMA__.ewoh_ingest_event_dedup;
CREATE POLICY ingest_event_dedup_org_isolation
  ON __EWOH_SCHEMA__.ewoh_ingest_event_dedup
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_ingest_event_dedup TO service_role;
