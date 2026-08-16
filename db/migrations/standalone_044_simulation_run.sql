-- EWOH Digital Twin 仿真运行台账 (standalone_044, ADR-025 / NO-12a, §13)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            DROP POLICY IF EXISTS / ENABLE ROW LEVEL SECURITY（幂等可重复执行）。
--
-- 背景（ADR-025，contracts/simulation/simulation-run.schema.json）：
--   1) 仿真运行一等资产：kind ∈ {what_if, capacity, layout, material_flow}
--      ——v1 四类全部有确定性评估器，绝不注册无引擎空类型（§33/§36）；
--      status ∈ {created, running, completed, failed}；
--   2) 隔离三层强制（§13 模拟数据显式标记）：
--      L1 契约面 record.isSimulation 必须 true（validateSimulationRun）；
--      L2 表级 CHECK is_simulation = true（本迁移，DB 兜底）；
--      L3 仿真评估只读 baseRef 快照、绝不写生产 World State 表
--         （SimulationService 写路径只有本表；服务层强约定）；
--   3) base_ref_json 声明基准世界快照（snapshotVersion ≥ 0）——仿真从什么
--      状态改了什么可追溯（§3）；completed 必须 results_json 非空、
--      failed 必须 failure_reason 非空（CHECK 兜底，§33 不静默）；
--   4) 租户边界：TENANT_SCOPED（org_id NOT NULL + RLS simulation_run_org_isolation
--      读 app.current_org_id，与 standalone_025 同 idiom）+ UNIQUE (org_id, run_id)。
--
-- 回滚语义：表为全新（additive）；回滚 = DROP TABLE（索引/约束/RLS 策略随表级联）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_simulation_run：仿真运行台账（TENANT_SCOPED）。
-- ============================================================================
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_simulation_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id varchar(255) NOT NULL,
  run_id varchar(180) NOT NULL,
  kind varchar(32) NOT NULL,
  status varchar(16) NOT NULL,
  is_simulation boolean NOT NULL DEFAULT true,
  base_ref_json jsonb NOT NULL,
  parameters_json jsonb NOT NULL,
  results_json jsonb,
  failure_reason text,
  engine_version varchar(32) NOT NULL,
  record_json jsonb NOT NULL,
  _created_at timestamptz NOT NULL DEFAULT now(),
  _updated_at timestamptz NOT NULL DEFAULT now(),
  _created_by uuid,
  _updated_by uuid,
  CONSTRAINT chk_ewoh_simulation_run_kind
    CHECK (kind IN ('what_if', 'capacity', 'layout', 'material_flow')),
  CONSTRAINT chk_ewoh_simulation_run_status
    CHECK (status IN ('created', 'running', 'completed', 'failed')),
  CONSTRAINT chk_ewoh_simulation_run_isolation
    CHECK (is_simulation = true),
  CONSTRAINT chk_ewoh_simulation_run_completed
    CHECK (status <> 'completed' OR results_json IS NOT NULL),
  CONSTRAINT chk_ewoh_simulation_run_failed
    CHECK (status <> 'failed' OR (failure_reason IS NOT NULL AND length(btrim(failure_reason)) > 0)),
  CONSTRAINT uq_ewoh_simulation_run UNIQUE (org_id, run_id)
);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_simulation_run IS
  'Digital Twin 仿真运行台账（ADR-025/NO-12a，§13）。what-if/容量/布局/物料流四类确定性评估器的运行资产：isSimulation=true 三层强制隔离（契约面 + 表级 CHECK + 绝不写生产 World State）；baseRef 声明基准快照可追溯；completed 必须 results、failed 必须 failureReason（§33 不静默）。TENANT_SCOPED（RLS simulation_run_org_isolation）。';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_simulation_run.is_simulation IS '§13 模拟数据显式标记（CHECK = true 兜底；仿真结果绝不混入生产事实层）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_simulation_run.base_ref_json IS '基准世界快照引用（snapshotVersion ≥ 0 + 可选 scenarioId）——从什么状态改了什么可追溯（§3）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_simulation_run.results_json IS 'completed 必填非空（成功仿真的输出契约面；CHECK 兜底）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_simulation_run.failure_reason IS 'failed 必填非空（CHECK 兜底，§33 不静默失败）';

CREATE INDEX IF NOT EXISTS idx_ewoh_simulation_run_status
  ON __EWOH_SCHEMA__.ewoh_simulation_run (org_id, status);
CREATE INDEX IF NOT EXISTS idx_ewoh_simulation_run_kind
  ON __EWOH_SCHEMA__.ewoh_simulation_run (org_id, kind);

-- ============================================================================
-- 2) RLS：TENANT_SCOPED 隔离（与 standalone_025 同 idiom：读 app.current_org_id，
--    旧名 app.primary_org_id 仅在未设置新名时回退）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_simulation_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS simulation_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_simulation_run;
CREATE POLICY simulation_run_org_isolation
  ON __EWOH_SCHEMA__.ewoh_simulation_run
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

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_simulation_run TO service_role;
