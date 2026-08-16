-- EWOH 全链路 trace span 台账 (standalone_042, ADR-022 / NO-10a, §19 Observability)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-022）：TracingInterceptor 的 HTTP traceId = §19 端到端
-- correlation id。本表持久化 HTTP span（追踪索引，7 天 TTL + 行上限防爆
-- 由 service 层 bounded 执行；审计事实仍在 ewoh_audit_log，本表非审计资产）：
--   1) 唯一 (trace_id, span_id)；索引 (trace_id, started_at)（缝合查询面）；
--   2) org_id 为 lineage（可空）——观测基建跨租户诊断诉求；行级可见性由
--      策略 trace_span_org_or_global 表达：本租户行（ewoh_org_visible）
--      或全局管理员（app.is_global_admin='true'），与 ewoh_world_snapshot
--      全局行先例同 idiom（非 loose 策略，001_verify 通过）；
--   3) 写入语义：interceptor 异步 best-effort（失败 logger 留痕不阻断
--      响应——span 丢失不影响业务事实层）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。
--   回滚后 span 持久化失败（服务层 catch+log，追踪面退化为内存 span）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_trace_span：HTTP span 持久化台账（GLOBAL_SHARED 语义，org lineage）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_trace_span (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id varchar(64) NOT NULL,
  span_id varchar(64) NOT NULL,
  path varchar(255) NOT NULL,
  method varchar(16) NOT NULL,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  error text,
  org_id varchar(255),
  request_user varchar(128),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_ewoh_trace_span_status CHECK (status_code >= 100 AND status_code <= 599),
  CONSTRAINT chk_ewoh_trace_span_duration CHECK (duration_ms >= 0),
  CONSTRAINT chk_ewoh_trace_span_time CHECK (finished_at >= started_at),
  CONSTRAINT uq_ewoh_trace_span UNIQUE (trace_id, span_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_trace_span IS
  '全链路 trace span 台账（ADR-022/NO-10a）。HTTP traceId=§19 correlation id；追踪索引（7 天 TTL + 行上限由 service 层 bounded），非审计资产（审计事实在 ewoh_audit_log）。org_id 为 lineage（可空）；可见性=trace_span_org_or_global（本租户行或全局管理员）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_trace_span.trace_id IS 'HTTP traceId = 全链路 correlation id（§19 单一关联键）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_trace_span.org_id IS 'lineage（可空；GLOBAL_SHARED 语义——观测基建跨租户诊断）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_trace_span.request_user IS 'lineage：请求用户（可空）';

CREATE INDEX IF NOT EXISTS idx_ewoh_trace_span_trace
  ON __EWOH_SCHEMA__.ewoh_trace_span (trace_id, started_at);

-- ============================================================================
-- 2) RLS：org lineage + 全局管理员可见（ewoh_world_snapshot 全局行先例 idiom，
--    非 loose 策略——qual 不为字面 true，001_verify loose_policies=0 保持）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_trace_span ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trace_span_org_or_global
  ON __EWOH_SCHEMA__.ewoh_trace_span;
CREATE POLICY trace_span_org_or_global
  ON __EWOH_SCHEMA__.ewoh_trace_span
  FOR ALL
  TO service_role
  USING (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id::uuid)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  )
  WITH CHECK (
    __EWOH_SCHEMA__.ewoh_org_visible(org_id::uuid)
    OR coalesce(current_setting('app.is_global_admin', true), '') = 'true'
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_trace_span TO service_role;
