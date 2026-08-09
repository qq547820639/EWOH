-- EWOH Command Map 智能调度升级 — 增量列 + 索引 + RLS (Phase 0/1, standalone_023)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP POLICY IF EXISTS。
--
-- 背景（05 §4）：本次增量为调度约束生命周期、计划约束快照、空间/设备坐标类型化
-- 建立真实列，支撑：
--   P0-2 持久化人工约束生命周期（valid_from_ms / expires_at_ms / org_id / source /
--        deactivated_at / deactivated_by；求解前按 org + active + 有效期过滤）；
--   P0-2 确定性 replay（ewoh_schedule_plan.constraints_json + effective_constraints_hash）；
--   P0-3 坐标类型统一（ewoh_spatial_entity.coordinate_type / floor_id；
--        ewoh_device.location_coordinate_type）。
-- 约束行仅新增列，不删除既有列/索引（向后兼容）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_scheduling_constraint：约束生命周期真实列
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS valid_from_ms bigint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS expires_at_ms bigint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS org_id varchar(255);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS source varchar(20) NOT NULL DEFAULT 'manual';
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz(6);
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint
  ADD COLUMN IF NOT EXISTS deactivated_by varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.valid_from_ms IS '约束生效起始（epoch ms；null=立即生效，替代 valueJson 内嵌 validFrom）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.expires_at_ms IS '约束失效时间（epoch ms；求解前过滤依据：expires_at_ms != null AND expires_at_ms < now 视为失效）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.org_id IS '租户隔离（RLS + 应用层过滤；null=全局约束）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.source IS '约束来源：manual（人工干预）/ system（系统策略）/ auto（自动派生）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.deactivated_at IS '软删除时间（显式 deactivate 时写，active=false 并存保持审计兼容）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_constraint.deactivated_by IS '软删除操作人';

-- ============================================================================
-- 2) ewoh_schedule_plan：计划约束快照（确定性 replay + 审计）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS constraints_json jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
  ADD COLUMN IF NOT EXISTS effective_constraints_hash varchar(64);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.constraints_json IS '求解所用 effective constraints 快照（确定性 replay + 审计）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.effective_constraints_hash IS 'constraints 稳定哈希（键排序 JSON 序列化 → SHA-256；replay 校验）';

-- ============================================================================
-- 3) ewoh_spatial_entity：坐标类型 + 楼层
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  ADD COLUMN IF NOT EXISTS coordinate_type varchar(20) NOT NULL DEFAULT 'FACTORY_CARTESIAN';
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  ADD COLUMN IF NOT EXISTS floor_id varchar(100);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.coordinate_type IS '坐标类型：FACTORY_CARTESIAN / WGS84 / UNKNOWN（P0-3 坐标统一）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.floor_id IS 'FACTORY_CARTESIAN 楼层标识（仅笛卡尔坐标时使用；WGS84 为 null）';

-- ============================================================================
-- 4) ewoh_device：设备位置坐标类型（location_lat/lng 可能为 WGS84）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS location_coordinate_type varchar(20) NOT NULL DEFAULT 'FACTORY_CARTESIAN';

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.location_coordinate_type IS '设备位置坐标类型：FACTORY_CARTESIAN / WGS84 / UNKNOWN（默认笛卡尔，向后兼容）';

-- ============================================================================
-- 5) 索引
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_constraint_org_active
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (org_id, active);
CREATE INDEX IF NOT EXISTS idx_constraint_expiry
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint (expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_schedule_plan_constraint_hash
  ON __EWOH_SCHEMA__.ewoh_schedule_plan (effective_constraints_hash);

-- ============================================================================
-- 6) RLS：约束表组织隔离（org_id = current_setting('app.primary_org_id') OR NULL 放行）
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint;
CREATE POLICY scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  FOR ALL
  TO service_role
  USING (
    org_id = current_setting('app.primary_org_id', true)
    OR org_id IS NULL
  );

COMMENT ON POLICY scheduler_constraint_org_isolation
  ON __EWOH_SCHEMA__.ewoh_scheduling_constraint
  IS '约束组织隔离：org_id 匹配当前 primary_org_id 或 NULL（全局）放行';

-- ============================================================================
-- 7) 权限
-- ============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_constraint TO service_role;
GRANT SELECT, UPDATE ON TABLE __EWOH_SCHEMA__.ewoh_schedule_plan TO service_role;
GRANT SELECT, UPDATE ON TABLE __EWOH_SCHEMA__.ewoh_spatial_entity TO service_role;
GRANT SELECT, UPDATE ON TABLE __EWOH_SCHEMA__.ewoh_device TO service_role;
