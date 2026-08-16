-- EWOH Work Order 领域表 (standalone_035, ADR-012 / NO-05e-b)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-012，Phase 6 NO-05e-b，契约见 contracts/workorder/work-order.schema.json）：
--   1) ewoh_work_order：工单 Execution 事实（workOrderType 注册表 {maintenance,
--      quality_rework, inspection} / origin={origin_kind, origin_id} 必填可追溯 /
--      六态生命周期 created→scheduled→in_progress→completed→closed
--      （created/scheduled 可 cancelled；in_progress 起不可取消由应用层契约强制，
--      DB 层以 CHECK 保证终态规则）/ severity 走 Canonical Risk 阶梯）。
--   2) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS work_order_org_isolation
--      读 app.current_org_id，与 standalone_025/032/034 同 idiom）；
--      业务键唯一约束 (org_id, work_order_id)。
--   3) external_ref 为第三方工单号（MES 工单号）alias——内部 work_order_id 由
--      EWOH 确定性推导（wo:sha256(originKind:originId)[:12]），第三方 ID 绝不
--      充当内部 ID（ADR-006）。
--   4) 事件：创建/终态由应用层写 ewoh_event（WorkOrderCreated/WorkOrderCompleted，
--      目录契约 contracts/events/event-catalog.yaml）。
--
-- 回滚语义：全新表（additive）：回滚 = DROP TABLE（索引/约束/RLS 随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_work_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  work_order_id varchar(180) NOT NULL,
  work_order_type varchar(32) NOT NULL,
  origin_kind varchar(32) NOT NULL,
  origin_id varchar(180) NOT NULL,
  subject_entity_id varchar(180) NOT NULL,
  subject_kind varchar(32) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'created',
  scheduled_for timestamptz,
  completed_at timestamptz,
  cancelled_reason varchar(255),
  external_ref varchar(255),
  evidence_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_wo_type CHECK (
    work_order_type IN ('maintenance','quality_rework','inspection')
  ),
  CONSTRAINT chk_ewoh_wo_origin_kind CHECK (
    origin_kind IN ('maintenance_condition','quality_finding')
  ),
  CONSTRAINT chk_ewoh_wo_severity CHECK (severity IN ('critical','high','medium','low')),
  CONSTRAINT chk_ewoh_wo_status CHECK (
    status IN ('created','scheduled','in_progress','completed','closed','cancelled')
  ),
  CONSTRAINT chk_ewoh_wo_completion CHECK (
    status NOT IN ('completed','closed') OR completed_at IS NOT NULL
  ),
  CONSTRAINT chk_ewoh_wo_cancellation CHECK (
    status <> 'cancelled' OR (cancelled_reason IS NOT NULL AND cancelled_reason <> '')
  ),
  CONSTRAINT uq_ewoh_wo_org_id UNIQUE (org_id, work_order_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_work_order IS
  '工单 Execution 事实（ADR-012/NO-05e-b）：workOrderType + origin 必填可追溯 + 六态生命周期（completed/closed 必带 completed_at；cancelled 必带 reason）；TENANT_SCOPED（RLS 强制）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.work_order_id IS 'EWOH 内部工单 ID（wo:sha256(originKind:originId)[:12] 确定性推导，EWOH 生成）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.origin_kind IS '起源事实 kind：maintenance_condition | quality_finding（契约 originKindRegistry）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.origin_id IS '起源事实 id（condition_id / finding_id，可追溯）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.subject_entity_id IS '执行落点规范身份 kind:value（station:/device:/person:，ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.external_ref IS '第三方工单号（MES 工单号）alias——绝不充当内部 ID（ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_work_order.severity IS 'Canonical Risk 阶梯 critical/high/medium/low（ADR-007）';

CREATE INDEX IF NOT EXISTS idx_ewoh_wo_subject
  ON __EWOH_SCHEMA__.ewoh_work_order (subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_wo_status
  ON __EWOH_SCHEMA__.ewoh_work_order (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_wo_origin
  ON __EWOH_SCHEMA__.ewoh_work_order (org_id, origin_kind, origin_id);

-- ============================================================================
-- RLS（与 standalone_025 同 idiom：读 app.current_org_id，primary 回退）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_work_order ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS work_order_org_isolation ON __EWOH_SCHEMA__.ewoh_work_order;
CREATE POLICY work_order_org_isolation
  ON __EWOH_SCHEMA__.ewoh_work_order
  FOR ALL TO service_role
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')))
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_work_order TO service_role;
