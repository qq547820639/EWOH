-- EWOH 外骨骼配置台账 (standalone_051, ADR-051/ADR-052 / §7)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-051，contracts/exo/exo-config.schema.json + ADR-052 台账接线）：
--   1) §7 Support Mode / Assist Profile / Fit / Calibration 配置事实台账；
--   2) kind 封闭（assist_profile/fit/calibration）+ status 按 kind 合法
--      （CHECK 兜底，服务层契约门双强制）；
--   3) 判定事实完整（CHECK 兜底，§33）：
--      - assist_profile：support_mode 非空（vendor_specific → vendor_mode_name 非空）；
--      - fit：person_id 非空（person: 前缀）；fitter 非空；
--      - calibration：calibration_kind + result 非空；
--   4) 时间不倒退：effective_to >= effective_from、next_due_at >= calibrated_at；
--   5) 规范身份：exo_id device: 前缀（ADR-006，CHECK + 服务层契约双强制）；
--   6) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS exo_config_org_isolation）。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_exo_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  config_id varchar(255) NOT NULL,
  kind varchar(32) NOT NULL,
  exo_id varchar(255) NOT NULL,
  status varchar(32) NOT NULL,
  support_mode varchar(32),
  vendor_mode_name varchar(255),
  parameters_json jsonb,
  effective_from timestamptz,
  effective_to timestamptz,
  superseded_by varchar(255),
  set_by varchar(255),
  person_id varchar(255),
  fitted_at timestamptz,
  fitter varchar(255),
  measured_values_json jsonb,
  calibration_kind varchar(32),
  result varchar(32),
  calibrated_at timestamptz,
  calibrated_by varchar(255),
  next_due_at timestamptz,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_exo_config_kind
    CHECK (kind IN ('assist_profile', 'fit', 'calibration')),
  CONSTRAINT chk_ewoh_exo_config_status_by_kind
    CHECK (
      (kind = 'assist_profile' AND status IN ('active', 'superseded', 'retired'))
      OR (kind = 'fit' AND status IN ('pending', 'fitted', 'adjusted', 'invalidated'))
      OR (kind = 'calibration' AND status IN ('pending', 'passed', 'failed'))
    ),
  CONSTRAINT chk_ewoh_exo_config_exo_id
    CHECK (exo_id LIKE 'device:%'),
  CONSTRAINT chk_ewoh_exo_config_support_mode
    CHECK (
      kind <> 'assist_profile' OR (
        support_mode IN (
          'passive', 'lift_assist', 'carry_assist', 'stand_assist',
          'balance_assist', 'upper_limb_assist', 'lower_limb_assist',
          'vendor_specific'
        )
        AND (support_mode <> 'vendor_specific' OR vendor_mode_name IS NOT NULL)
      )
    ),
  CONSTRAINT chk_ewoh_exo_config_profile_facts
    CHECK (kind <> 'assist_profile' OR effective_from IS NOT NULL),
  CONSTRAINT chk_ewoh_exo_config_profile_superseded
    CHECK (kind <> 'assist_profile' OR status <> 'superseded' OR superseded_by IS NOT NULL),
  CONSTRAINT chk_ewoh_exo_config_fit_facts
    CHECK (kind <> 'fit' OR (person_id IS NOT NULL AND person_id LIKE 'person:%' AND fitted_at IS NOT NULL AND fitter IS NOT NULL)),
  CONSTRAINT chk_ewoh_exo_config_calibration_facts
    CHECK (kind <> 'calibration' OR (calibration_kind IN ('zeroing', 'load_cell', 'imu') AND result IS NOT NULL AND calibrated_at IS NOT NULL AND calibrated_by IS NOT NULL)),
  CONSTRAINT chk_ewoh_exo_config_time_order
    CHECK (effective_to IS NULL OR effective_from IS NOT NULL AND effective_to >= effective_from),
  CONSTRAINT chk_ewoh_exo_config_next_due_order
    CHECK (next_due_at IS NULL OR calibrated_at IS NOT NULL AND next_due_at >= calibrated_at),
  CONSTRAINT uq_ewoh_exo_config UNIQUE (org_id, config_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_exo_config IS
  '外骨骼配置台账（ADR-051/ADR-052/§7）：Support Mode / Assist Profile / Fit / Calibration 配置事实（kind 封闭 + status 按 kind + 判定事实完整 CHECK 兜底 + 时间不倒退 + exo_id device: 规范身份）。TENANT_SCOPED（RLS exo_config_org_isolation）。record_json = 契约形态全量留痕。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_config.exo_id IS '外骨骼规范身份（device: 前缀，ADR-006）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_config.support_mode IS '§7 Support Mode（封闭注册表；vendor_specific 显式桶 + vendor_mode_name）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_exo_config.record_json IS '契约形态全量（ADR-051 exo-config v1；判定事实留痕）';

-- 查询索引：按设备/类型/状态。
CREATE INDEX IF NOT EXISTS idx_ewoh_exo_config_exo
  ON __EWOH_SCHEMA__.ewoh_exo_config (org_id, exo_id, kind);
CREATE INDEX IF NOT EXISTS idx_ewoh_exo_config_active_profile
  ON __EWOH_SCHEMA__.ewoh_exo_config (org_id, exo_id, support_mode)
  WHERE kind = 'assist_profile' AND status = 'active';

ALTER TABLE __EWOH_SCHEMA__.ewoh_exo_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS exo_config_org_isolation
  ON __EWOH_SCHEMA__.ewoh_exo_config;
CREATE POLICY exo_config_org_isolation
  ON __EWOH_SCHEMA__.ewoh_exo_config
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_exo_config TO service_role;
