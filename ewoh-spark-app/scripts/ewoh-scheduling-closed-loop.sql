-- EWOH 智能调度执行闭环：新增调度列/表（向后兼容，幂等）
-- 应用于 Miaoda/PostgreSQL。既有列保留，仅新增。

-- 1) ewoh_production_task 新增调度字段
ALTER TABLE ewoh_production_task ADD COLUMN IF NOT EXISTS predecessor_ids JSONB;
ALTER TABLE ewoh_production_task ADD COLUMN IF NOT EXISTS required_skills JSONB;
ALTER TABLE ewoh_production_task ADD COLUMN IF NOT EXISTS required_certifications JSONB;
ALTER TABLE ewoh_production_task ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- 2) ewoh_personnel 新增资质/版本字段
ALTER TABLE ewoh_personnel ADD COLUMN IF NOT EXISTS certifications JSONB;
ALTER TABLE ewoh_personnel ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- 3) 资源预占表（防双重占用）
CREATE TABLE IF NOT EXISTS ewoh_resource_reservation (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  reservation_id VARCHAR(255) NOT NULL UNIQUE,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(255) NOT NULL,
  assignment_id VARCHAR(255),
  plan_id VARCHAR(255),
  task_id VARCHAR(255),
  start_ms BIGINT NOT NULL,
  end_ms BIGINT NOT NULL,
  status VARCHAR(50) DEFAULT 'reserved',
  version INTEGER DEFAULT 1,
  org_id VARCHAR(255),
  created_by VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_resource ON ewoh_resource_reservation(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_plan ON ewoh_resource_reservation(plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_task ON ewoh_resource_reservation(task_id);

-- 4) Outbox（可靠领域事件）
CREATE TABLE IF NOT EXISTS ewoh_outbox (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  sequence BIGINT DEFAULT 0,
  status VARCHAR(50) DEFAULT 'pending',
  payload_json JSONB,
  org_id VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  published_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_status ON ewoh_outbox(status);
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_entity ON ewoh_outbox(entity_id);

-- 5) 版本化调度策略配置
CREATE TABLE IF NOT EXISTS ewoh_scheduling_policy (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  config_version INTEGER NOT NULL,
  config_json JSONB NOT NULL,
  active BOOLEAN DEFAULT TRUE NOT NULL,
  org_id VARCHAR(255),
  updated_by VARCHAR(255),
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL,
  _updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_policy_org ON ewoh_scheduling_policy(org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_policy_active ON ewoh_scheduling_policy(active);

-- 6) 持久化重排触发（幂等去重键）
CREATE TABLE IF NOT EXISTS ewoh_replan_trigger (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trigger_key VARCHAR(512) NOT NULL UNIQUE,
  org_id VARCHAR(255) NOT NULL,
  trigger_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  event_version INTEGER DEFAULT 0,
  status VARCHAR(50) DEFAULT 'processed',
  run_id VARCHAR(255),
  _created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ewoh_replan_trigger_org_type ON ewoh_replan_trigger(org_id, trigger_type);