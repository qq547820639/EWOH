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
-- 该 sequence 由 standalone_011_outbox_sequence.sql 创建（011 编号早于本迁移，
-- 空库顺序执行时 sequence 已先行创建；此处 CREATE SEQUENCE IF NOT EXISTS 为
-- 单跑 017 场景兜底）。
-- 迁移顺序终态对齐（审计 SQL-003/005/006 修复，2026-08-17）：008/011/014 对
-- 本迁移补建的表已做 IF EXISTS 守卫——空库顺序执行时它们先行跳过，本迁移的
-- CREATE TABLE 直接包含最终形态：
--   - ewoh_outbox：entity_type/entity_version（008）+ sequence DEFAULT
--     nextval(ewoh_outbox_sequence_seq)（011）+ idx_ewoh_outbox_sequence（008）；
--   - ewoh_scheduling_policy：weights_json（014）。
-- 已应用库重跑：CREATE TABLE IF NOT EXISTS 跳过，ALTER 类语句幂等，无变更。

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

-- ===== ewoh_outbox（对齐 Drizzle ewohOutbox；含 008/011 列与 DEFAULT 终态） =====
CREATE SEQUENCE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_outbox_sequence_seq;

CREATE TABLE IF NOT EXISTS __EWOH_SCHEMA__.ewoh_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id varchar(255) NOT NULL UNIQUE,
  event_type varchar(100) NOT NULL,
  entity_id varchar(255) NOT NULL,
  entity_type varchar(100),
  entity_version integer,
  sequence bigint DEFAULT nextval('__EWOH_SCHEMA__.ewoh_outbox_sequence_seq'),
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
CREATE INDEX IF NOT EXISTS idx_ewoh_outbox_sequence
  ON __EWOH_SCHEMA__.ewoh_outbox (sequence);

-- ===== ewoh_scheduling_policy（对齐 Drizzle ewohSchedulingPolicy；含 014 weights_json 终态） =====
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
