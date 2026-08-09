-- EWOH Command Map 智能调度 — 调度领域表补建 (P0-DB-FIX / standalone_017)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: CREATE TABLE IF NOT EXISTS（幂等，可重复执行）。
--
-- 背景（DB 漂移修复，Phase 0 真实 DB 验证发现）：
-- Drizzle schema（server/database/schema.ts）声明了 ewoh_outbox /
-- ewoh_resource_reservation / ewoh_scheduling_policy，服务代码（outbox.service /
-- reservation / scheduling-policy）也正常读写，但迁移目录从未包含这三张表的
-- CREATE TABLE —— 仅 008/009/011/014 以 ALTER TABLE 引用它们，导致在全新
-- PostgreSQL 上执行迁移链时：
--   relation "ewoh_outbox" does not exist
--   relation "ewoh_resource_reservation" does not exist
--   relation "ewoh_scheduling_policy" does not exist
-- 本迁移按 Drizzle 列定义补建三张表（含索引/唯一键/sequence 依赖），
-- 修复后 008/009/011/014 的 ALTER 均可正常执行。表列与 Drizzle schema 对齐。
--
-- 注意：ewoh_outbox.sequence 的 DEFAULT 依赖 ewoh_outbox_sequence_seq，
-- 该 sequence 由 standalone_011_outbox_sequence.sql 创建——本迁移先建表（列无
-- DEFAULT），011 再补 DEFAULT；若 011 已执行过则 CREATE TABLE IF NOT EXISTS 跳过。
-- 为保证既有 011 语义（幂等），此处 sequence 默认值以 011 为准，见 011 文件。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ===== ewoh_resource_reservation（对齐 Drizzle ewohResourceReservation） =====
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_resource_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id varchar(255) NOT NULL UNIQUE,
  resource_type varchar(50) NOT NULL,
  resource_id varchar(255) NOT NULL,
  assignment_id varchar(255),
  plan_id varchar(255),
  task_id varchar(255),
  start_ms bigint NOT NULL,
  end_ms bigint NOT NULL,
  status varchar(50) NOT NULL DEFAULT 'reserved',
  version integer NOT NULL DEFAULT 1,
  org_id varchar(255),
  created_by varchar(255),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_resource
  ON __EWOH_SCHEMA__.ewoh_resource_reservation (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_plan
  ON __EWOH_SCHEMA__.ewoh_resource_reservation (plan_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_resource_reservation_task
  ON __EWOH_SCHEMA__.ewoh_resource_reservation (task_id);

-- ===== ewoh_outbox（对齐 Drizzle ewohOutbox；sequence DEFAULT 由 011 补） =====
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  event_type varchar(100) NOT NULL,
  entity_id varchar(255) NOT NULL,
  entity_type varchar(100),
  entity_version integer,
  sequence bigint,
  status varchar(50) NOT NULL DEFAULT 'pending',
  payload_json jsonb,
  org_id varchar(255),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz(3)
);
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_status
  ON __EWOH_SCHEMA__.ewoh_outbox (status);
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_entity
  ON __EWOH_SCHEMA__.ewoh_outbox (entity_id);

-- ===== ewoh_scheduling_policy（对齐 Drizzle ewohSchedulingPolicy） =====
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_scheduling_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_version integer NOT NULL,
  config_json jsonb NOT NULL,
  weights_json jsonb,
  active boolean NOT NULL DEFAULT true,
  org_id varchar(255),
  updated_by varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_policy_org
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy (org_id);
CREATE INDEX IF NOT EXISTS idx_ewoh_scheduling_policy_active
  ON __EWOH_SCHEMA__.ewoh_scheduling_policy (active);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_resource_reservation IS '资源预约（reservation SSOT；Drizzle 声明补建，P0-DB-FIX）';
COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_outbox IS '可靠领域事件 Outbox（Drizzle 声明补建，P0-DB-FIX）';
COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy IS '版本化调度策略（policy weights SSOT；Drizzle 声明补建，P0-DB-FIX）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_resource_reservation TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_outbox TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_scheduling_policy TO service_role;

-- ===== ewoh_replan_trigger（对齐 Drizzle ewohReplanTrigger；P0-DB-FIX 追加） =====
CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_replan_trigger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_key varchar(512) NOT NULL UNIQUE,
  org_id varchar(255) NOT NULL,
  trigger_type varchar(100) NOT NULL,
  entity_id varchar(255) NOT NULL,
  event_version integer NOT NULL DEFAULT 0,
  status varchar(50) NOT NULL DEFAULT 'processed',
  run_id varchar(255),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ewoh_replan_trigger_org_type
  ON __EWOH_SCHEMA__.ewoh_replan_trigger (org_id, trigger_type);

COMMENT ON TABLE __EWOH_SCHEMA__.ewoh_replan_trigger IS '持久化重排触发（trigger SSOT；Drizzle 声明补建，P0-DB-FIX）';

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE __EWOH_SCHEMA__.ewoh_replan_trigger TO service_role;
