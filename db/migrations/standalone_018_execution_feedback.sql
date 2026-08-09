-- EWOH Command Map 智能调度 — 正式执行领域 (Phase 4 / P4-EXEC, standalone_018)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS（幂等）。
--
-- 背景（最终生产化 §十二）：执行结果不得仅存为 Plan 字段。建立正式执行领域
-- SchedulingExecution：Plan Assignment → Execution 稳定引用，记录 planned vs
-- actual（开始/结束/行程/等待），deviation 触发 replan（§十三），KPI 聚合来源（§十四）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_execution (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id varchar(255) NOT NULL UNIQUE,
  org_id varchar(255),
  run_id varchar(255),
  plan_id varchar(255) NOT NULL,
  assignment_id varchar(255) NOT NULL,
  task_id varchar(255) NOT NULL,
  person_id varchar(255),
  device_id varchar(255),
  station_id varchar(255),
  planned_start_at timestamptz(3),
  planned_end_at timestamptz(3),
  actual_start_at timestamptz(3),
  actual_end_at timestamptz(3),
  planned_travel_ms bigint,
  actual_travel_ms bigint,
  planned_distance_m double precision,
  actual_distance_m double precision,
  planned_waiting_ms bigint,
  actual_waiting_ms bigint,
  -- 执行状态：PLANNED / DISPATCHED / STARTED / PAUSED / COMPLETED / FAILED / CANCELLED
  status varchar(50) NOT NULL DEFAULT 'PLANNED',
  deviation_type varchar(100),
  deviation_reason text,
  snapshot_version varchar(255),
  policy_version integer,
  solver_version varchar(100),
  source varchar(50) NOT NULL DEFAULT 'feedback',
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_execution_org
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_execution_plan
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_execution_assignment
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (assignment_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_execution_task
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (task_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_execution_status
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (status);
-- 唯一键：assignment + status 非终态时唯一（幂等记录；终态可重写为最新）
CREATE UNIQUE INDEX IF NOT EXISTS uq_ewoh_scheduling_execution_assignment
  ON __EWOH_SCHEMA__.ewoh_scheduling_execution (assignment_id);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_execution IS '正式执行领域：Plan Assignment → Execution（planned vs actual + deviation，KPI 聚合与 replan 触发来源）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_execution.status IS '执行状态 PLANNED/DISPATCHED/STARTED/PAUSED/COMPLETED/FAILED/CANCELLED';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_scheduling_execution.deviation_type IS '偏差类型 START_DELAY/END_DELAY/TRAVEL_DELAY/PERSON_CHANGED/DEVICE_CHANGED/STATION_CHANGED/ROUTE_DEVIATION/PERSON_UNAVAILABLE/DEVICE_FAILURE/TASK_CANCELLED/SAFETY_INTERRUPTION/MANUAL_OVERRIDE';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_execution TO service_role;
