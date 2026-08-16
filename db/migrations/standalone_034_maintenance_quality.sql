-- EWOH Maintenance / Quality 领域表 (standalone_034, ADR-010 / NO-05b)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-010，Phase 6 NO-05b，契约见 contracts/maintenance + contracts/quality）：
--   1) ewoh_maintenance_condition：维护状态事实（conditionType 注册表 / 生命周期
--      detected→acknowledged→work_order_created→resolved→closed / due_at 逾期判定 /
--      severity 走 Canonical Risk 阶梯）。subject_entity_id 为规范身份（ADR-006）。
--   2) ewoh_quality_finding：质量发现事实（findingType 注册表 / 处置生命周期
--      open→under_review→dispositioned→closed / dispositioned 必带 disposition 决策
--      accept|rework|scrap|return）。links 为规范身份引用数组（jsonb）。
--   3) 租户边界：两表均为 TENANT_SCOPED（org_id NOT NULL + RLS 策略
--      <table>_org_isolation 读 app.current_org_id，与 standalone_025 同 idiom）；
--      业务键唯一约束在 (org_id, <id 列>)。
--   4) 事件：状态转移由应用层写 ewoh_event（MaintenanceConditionDetected/Resolved /
--      QualityFindingDetected/Dispositioned，目录契约 contracts/events/event-catalog.yaml）。
--
-- 回滚语义：两表全新（additive）：回滚 = DROP TABLE（索引/约束/RLS 随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_maintenance_condition（TENANT_SCOPED）
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_maintenance_condition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  condition_id varchar(180) NOT NULL,
  subject_entity_id varchar(180) NOT NULL,
  subject_kind varchar(32) NOT NULL,
  condition_type varchar(32) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'detected',
  due_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  work_order_ref varchar(255),
  evidence_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_mc_type CHECK (
    condition_type IN ('wear','calibration_due','fault_recurring','overdue_inspection','battery_degradation','anomaly')
  ),
  CONSTRAINT chk_ewoh_mc_severity CHECK (severity IN ('critical','high','medium','low')),
  CONSTRAINT chk_ewoh_mc_status CHECK (
    status IN ('detected','acknowledged','work_order_created','resolved','closed')
  ),
  CONSTRAINT uq_ewoh_mc_org_id UNIQUE (org_id, condition_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_maintenance_condition IS
  '维护状态事实（ADR-010/NO-05b）：conditionType 注册表 + 生命周期（resolved 前必须 work_order_created）+ due_at 逾期判定（机器可执行，供调度维护状态输入）；TENANT_SCOPED（RLS 强制）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_maintenance_condition.subject_entity_id IS '维护对象规范身份 kind:value（machine:/exo:/device:/tool:，ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_maintenance_condition.subject_kind IS '维护对象 kind（冗余落库，供过滤与统计）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_maintenance_condition.severity IS 'Canonical Risk 阶梯 critical/high/medium/low（ADR-007）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_maintenance_condition.due_at IS '维护截止（< now 且未 resolved/closed → overdue）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_maintenance_condition.work_order_ref IS '关联工单引用（work_order_created 后填写，可审计）';

CREATE INDEX IF NOT EXISTS idx_ewoh_mc_subject
  ON __EWOH_SCHEMA__.ewoh_maintenance_condition (subject_entity_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_mc_status
  ON __EWOH_SCHEMA__.ewoh_maintenance_condition (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_mc_due
  ON __EWOH_SCHEMA__.ewoh_maintenance_condition (org_id, due_at);

-- ============================================================================
-- 2) ewoh_quality_finding（TENANT_SCOPED）
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_quality_finding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  finding_id varchar(180) NOT NULL,
  finding_type varchar(32) NOT NULL,
  severity varchar(16) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'open',
  disposition varchar(16),
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  dispositioned_at timestamptz,
  evidence_id varchar(255),
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_qf_type CHECK (
    finding_type IN ('defect','dimension_out_of_tolerance','nonconformance','material_mismatch','process_deviation')
  ),
  CONSTRAINT chk_ewoh_qf_severity CHECK (severity IN ('critical','high','medium','low')),
  CONSTRAINT chk_ewoh_qf_status CHECK (status IN ('open','under_review','dispositioned','closed')),
  CONSTRAINT chk_ewoh_qf_disposition CHECK (disposition IS NULL OR disposition IN ('accept','rework','scrap','return')),
  CONSTRAINT chk_ewoh_qf_disposition_required CHECK (
    status <> 'dispositioned' OR disposition IS NOT NULL
  ),
  CONSTRAINT uq_ewoh_qf_org_id UNIQUE (org_id, finding_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_quality_finding IS
  '质量发现事实（ADR-010/NO-05b）：findingType 注册表 + 处置生命周期（dispositioned 必带 disposition 决策）+ links 规范身份引用；TENANT_SCOPED（RLS 强制）。';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_quality_finding.disposition IS '处置决策 accept|rework|scrap|return（dispositioned 必填，CHECK 强制）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_quality_finding.links IS '关联规范身份引用数组（order:/material:/station:/task:，ADR-006）';

CREATE INDEX IF NOT EXISTS idx_ewoh_qf_status
  ON __EWOH_SCHEMA__.ewoh_quality_finding (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_qf_links
  ON __EWOH_SCHEMA__.ewoh_quality_finding USING gin (links);

-- ============================================================================
-- 3) RLS（与 standalone_025 同 idiom：读 app.current_org_id，primary 回退）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_maintenance_condition ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS maintenance_condition_org_isolation ON __EWOH_SCHEMA__.ewoh_maintenance_condition;
CREATE POLICY maintenance_condition_org_isolation
  ON __EWOH_SCHEMA__.ewoh_maintenance_condition
  FOR ALL TO service_role
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')))
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')));

ALTER TABLE __EWOH_SCHEMA__.ewoh_quality_finding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quality_finding_org_isolation ON __EWOH_SCHEMA__.ewoh_quality_finding;
CREATE POLICY quality_finding_org_isolation
  ON __EWOH_SCHEMA__.ewoh_quality_finding
  FOR ALL TO service_role
  USING (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')))
  WITH CHECK (org_id = COALESCE(NULLIF(current_setting('app.current_org_id', true), ''), NULLIF(current_setting('app.primary_org_id', true), '')));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_maintenance_condition TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_quality_finding TO service_role;
