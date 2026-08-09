-- EWOH Command Map 智能调度驾驶舱 — 领域模型新列 (Phase 1 / P1-T1)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS（可重复执行，幂等）。
--
-- 背景（见 docs/scheduler-commandmap-upgrade/01-current-state-review.md）：
-- 调度领域字段此前由 taskType/priority 白名单派生或 extra 非正式字段承载，
-- 无法落库、无法审计。本迁移为 Task / Resource / Station / Run 补齐真实业务列：
--   1. ewoh_production_task：base_priority / 时间窗 / safety_critical /
--      preemptible / skill_match_mode / production_impact / downstream_impact /
--      required_station_capabilities / preferred_resources / excluded_resources；
--   2. ewoh_personnel：shift / workload / current_task_id / certification_expiry
--      （证书到期为 certifications 的平行列，见决策 D-A，不破坏现有 string[] API 形状）；
--   3. ewoh_device：capabilities / location_lat / location_lng / location_updated_at /
--      location_confidence / telemetry_updated_at / available_windows
--      （能力替代型号白名单派生，位置替代借用人员坐标，均见 01 §4.1）；
--   4. ewoh_spatial_entity：capacity / queue / available_windows
--      （容量替代 extra.capacity 非正式字段）；
--   5. ewoh_scheduling_run：failure_reason（run 失败原因落库，替代仅日志）。
-- 默认值保证旧行零停机可读；布尔/枚举类 NOT NULL 或带 DEFAULT，数组类 jsonb DEFAULT '[]'。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ===== ewoh_production_task =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS base_priority varchar(50);
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS earliest_start_ms bigint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS latest_finish_ms bigint;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS safety_critical boolean NOT NULL DEFAULT false;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS preemptible boolean NOT NULL DEFAULT false;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS skill_match_mode varchar(10) DEFAULT 'ALL';
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS production_impact real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS downstream_impact real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS required_station_capabilities jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS preferred_resources jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS excluded_resources jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_personnel =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS shift varchar(100);
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS workload real;
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS current_task_id varchar(255);
-- 证书到期平行列（决策 D-A）：对象数组 [{ name, expiresAtMs }]，与 certifications string[] 并行。
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS certification_expiry jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_device =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS capabilities jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS location_lat real;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS location_lng real;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS location_updated_at timestamptz(6);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS location_confidence real DEFAULT 0;
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS telemetry_updated_at timestamptz(6);
ALTER TABLE __EWOH_SCHEMA__.ewoh_device
  ADD COLUMN IF NOT EXISTS available_windows jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_spatial_entity =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  ADD COLUMN IF NOT EXISTS capacity integer;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  ADD COLUMN IF NOT EXISTS queue jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_spatial_entity
  ADD COLUMN IF NOT EXISTS available_windows jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_scheduling_run =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_run
  ADD COLUMN IF NOT EXISTS failure_reason text;

-- ===== 索引（可重复） =====
CREATE INDEX IF NOT EXISTS idx_ewoh_production_task_safety
  ON __EWOH_SCHEMA__.ewoh_production_task (safety_critical);
CREATE INDEX IF NOT EXISTS idx_ewoh_personnel_current_task
  ON __EWOH_SCHEMA__.ewoh_personnel (current_task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_run_failure
  ON __EWOH_SCHEMA__.ewoh_scheduling_run (failure_reason) WHERE failure_reason IS NOT NULL;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.base_priority IS 'Task.basePriority 真实业务值（不再从 title/taskType 猜测）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.safety_critical IS '安全关键任务真实标记（替代 deriveSafetyCritical 白名单派生）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.preemptible IS '是否可抢占（替代固定 false）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.skill_match_mode IS '技能匹配语义 ALL/ANY（缺省 ALL）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.production_impact IS '生产影响度 0..1（替代 deriveProductionImpact）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.downstream_impact IS '下游影响度 0..1';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.required_station_capabilities IS '工位能力需求 jsonb string[]';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.preferred_resources IS '偏好资源 jsonb string[]';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.excluded_resources IS '排除资源 jsonb string[]';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.shift IS '人员班次';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.workload IS '当前负载 0..1（currentLoad jsonb 之外的独立数值列）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.current_task_id IS '当前任务 id';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.certification_expiry IS '证书到期平行列 [{name, expiresAtMs}]（决策 D-A）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.capabilities IS '真实能力集合 jsonb string[]（替代型号白名单派生）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.location_lat IS '设备自身位置纬度/毫米坐标（替代借用人员坐标）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.location_lng IS '设备自身位置经度/毫米坐标（替代借用人员坐标）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.location_updated_at IS '位置更新时间';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.location_confidence IS '位置置信度 0..1';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.telemetry_updated_at IS '遥测更新时间';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_device.available_windows IS '设备可用窗口 jsonb [{startMs,endMs}]（替代恒空）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.capacity IS '工位容量（替代 extra.capacity 非正式字段）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.queue IS '工位队列 jsonb string[]';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_spatial_entity.available_windows IS '工位可用窗口 jsonb [{startMs,endMs}]';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_run.failure_reason IS 'run 失败原因（替代仅日志，供审计追溯）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_production_task TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_personnel TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_device TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_spatial_entity TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_run TO service_role;
