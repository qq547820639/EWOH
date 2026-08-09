-- EWOH Command Map 智能调度 — TaskRequirement 任务资源需求落库 (Phase 1 / P1-TREQ)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ALTER TABLE ... ADD COLUMN IF NOT EXISTS（可重复执行，幂等）。
--
-- 背景（docs/scheduler-commandmap-upgrade/01-current-state-review.md §4）：
-- 任务资源需求此前由 taskType 名称硬编码派生（world-state.service.ts
-- deriveRequiredDeviceCapabilities 白名单），是"算法猜测"而非业务事实，
-- 且 Drizzle schema 声明的 required_skills / required_certifications /
-- predecessor_ids / certifications 列从未落入任何 migration（DB 与 schema 漂移）。
--
-- 本迁移（P1-TREQ）：
--   1. ewoh_production_task 新增 TaskRequirement 领域列：
--      required_device_capabilities（设备能力需求，替代 taskType 白名单派生）、
--      candidate_stations（候选工位，替代运行时空数组）；
--   2. 对齐既有 Drizzle 声明但 DB 缺失的列：
--      required_skills / required_certifications / predecessor_ids（ewoh_production_task）、
--      certifications（ewoh_personnel）；
--   3. 旧数据 backfill：按 task_type 白名单为 required_device_capabilities 填派生值
--      （仅限新列 NULL 的旧行；运行时对 backfill 值标记 derived，新写入的真实值
--      不再派生，derived[] 可区分 authoritative/derived/unknown）。
-- 默认值保证旧行零停机可读；jsonb 数组 DEFAULT '[]'。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ===== ewoh_production_task：TaskRequirement 领域列 =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS required_device_capabilities jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS candidate_stations jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_production_task：对齐 Drizzle 声明（DB 漂移修复） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS required_skills jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS required_certifications jsonb DEFAULT '[]'::jsonb;
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS predecessor_ids jsonb DEFAULT '[]'::jsonb;

-- ===== ewoh_personnel：对齐 Drizzle 声明（DB 漂移修复） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS certifications jsonb DEFAULT '[]'::jsonb;

-- ===== 旧数据 backfill（一次性；新写入的真实值不再被覆盖） =====
-- required_device_capabilities：仅当列值为空数组时按 task_type 白名单填充派生值。
-- 与 world-state.service.ts deriveRequiredDeviceCapabilities 白名单保持同源；
-- 运行时对 backfill 值标记 derived（derived: ['requiredDeviceCapabilities']），
-- 写入真实值的行则标记 authoritative，可区分。
UPDATE __EWOH_SCHEMA__.ewoh_production_task
SET required_device_capabilities = CASE
      WHEN lower(coalesce(task_type, '')) LIKE '%lift%'
        OR lower(coalesce(task_type, '')) LIKE '%carry%'
        OR lower(coalesce(task_type, '')) LIKE '%heavy%'
        OR lower(coalesce(task_type, '')) LIKE '%handling%'
        OR coalesce(task_type, '') LIKE '%搬运%'
        OR coalesce(task_type, '') LIKE '%重体力%'
        OR coalesce(task_type, '') LIKE '%物料%'
      THEN '["exo-lift"]'::jsonb
      ELSE '[]'::jsonb
    END
WHERE required_device_capabilities IS NULL
   OR jsonb_array_length(required_device_capabilities) = 0;

-- ===== 索引（可重复） =====
CREATE INDEX IF NOT EXISTS idx_ewoh_production_task_required_device_caps
  ON __EWOH_SCHEMA__.ewoh_production_task USING gin (required_device_capabilities);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.required_device_capabilities IS '设备能力需求 jsonb string[]（TaskRequirement 业务事实，替代 taskType 白名单派生；backfill 值由运行时标记 derived）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.candidate_stations IS '候选工位 jsonb string[]（Task.candidateStations，替代运行时空数组）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.required_skills IS '技能需求 jsonb string[]（Task.requiredSkills，对齐 Drizzle 声明）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.required_certifications IS '证书需求 jsonb string[]（Task.requiredCertifications，对齐 Drizzle 声明）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.predecessor_ids IS '前置任务 jsonb string[]（Task.predecessorIds，对齐 Drizzle 声明）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.certifications IS '证书集合 jsonb string[]（Person.certifications，对齐 Drizzle 声明）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_production_task TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_personnel TO service_role;

-- ===== ewoh_personnel：对齐 Drizzle 声明（version 列漂移修复，P0-DB-FIX） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_personnel
  ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_personnel.version IS '业务版本：每次关键修改自增，用于快照新鲜度判断（对齐 Drizzle）';

-- ===== ewoh_production_task：对齐 Drizzle 声明（version 列漂移修复，P0-DB-FIX） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_production_task
  ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_production_task.version IS '业务版本：每次关键修改自增，用于快照新鲜度判断（对齐 Drizzle）';

-- ===== ewoh_scheduling_plan_assignment：对齐 Drizzle（decision_trace_json 漂移修复） =====
ALTER TABLE __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment
  ADD COLUMN IF NOT EXISTS decision_trace_json jsonb;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment.decision_trace_json IS 'Assignment DecisionTrace 持久化（priority 分解/约束证据/被拒替代，对齐 Drizzle）';
