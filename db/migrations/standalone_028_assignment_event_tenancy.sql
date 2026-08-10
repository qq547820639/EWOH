-- EWOH Command Map — Scheduler V2 派生租户归属（Task 3, standalone_028）
-- Schema: __EWOH_SCHEMA__ (standalone → public)
-- Re-entrant: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS /
--            CREATE OR REPLACE FUNCTION / DROP TRIGGER IF EXISTS（幂等可重复执行）。
--
-- 背景（Task 3，Scheduler V2 多租户/RLS 边界，ADR-004）：
--   ewoh_assignment_event 属 DERIVED_TENANT_OWNERSHIP 分类：RLS 保持关闭（保留
--   eventId 全局唯一审计流语义，见 standalone_025 头注释与 ADR-004 决策），但租户
--   边界必须可从归属行推导并以**数据库可验证**的方式落库，供 verify 与 E2E 断言：
--
--     ewoh_assignment_event.assignment_id
--       → ewoh_scheduling_plan_assignment.assignment_id（取 org_id，回退 plan_id）
--       → ewoh_schedule_plan.plan_id（取 org_id）
--
--   事件行上无 planId/runId 列（仅 assignment_id/task_id/person_id/device_id），
--   故推导路径为「assignment → plan_assignment → plan」；task/person/device 级事件
--   无 assignment 归属时保持 org_id 为 NULL（防御：不失败、不误标）。
--
-- 语义：
--   - 显式写入的 org_id 优先（派生不覆盖非空值）；
--   - 归属无法解析时保持 NULL（绝不因派生失败而中止 INSERT/UPDATE）；
--   - 派生在 AFTER INSERT OR UPDATE 触发器内以受保护的自 UPDATE 落库
--     （UPDATE ... WHERE org_id IS NULL），函数入口对非空 org_id 提前返回，
--     自更新触发的第二次触发立即短路，递归有界（单层）；
--   - 数据库可验证不变量：非空 org_id 恒等于其 plan_assignment / plan 的 org_id
--     （见 db/verify/standalone_028_assignment_event_tenancy.verify.sql 与
--      scripts/verify-scheduler-multitenant.mjs）。
--   - 本迁移**不**对 ewoh_assignment_event 启用 RLS（全局审计流按 eventId 全量留痕，
--     SSE/审计读取跨 org 属设计语义，见 ADR-004 的 DERIVED_TENANT_OWNERSHIP 后果）。
--
-- 回滚语义（见 standalone_028_assignment_event_tenancy.rollback.sql 头注释）：
--   撤销触发器 + 函数 + 索引；org_id 列保留（additive safe，回滚后可安全重放 028）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

-- ============================================================================
-- 1) ewoh_assignment_event：补齐 org_id 归属列（此前 schema 无该列）。
-- ============================================================================
ALTER TABLE __EWOH_SCHEMA__.ewoh_assignment_event
  ADD COLUMN IF NOT EXISTS org_id varchar(255);

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_assignment_event.org_id IS
  '租户归属（DERIVED_TENANT_OWNERSHIP，ADR-004）：RLS 关闭，org_id 由派生触发器 trg_assignment_event_derive_org 从归属 plan/assignment 推导；数据库可验证不变量（standalone_028）';

-- ============================================================================
-- 2) org_id 检索索引（RLS 未启用，索引服务于派生回填查询与审计按 org 检索）。
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_ewoh_assignment_event_org
  ON __EWOH_SCHEMA__.ewoh_assignment_event (org_id);

-- ============================================================================
-- 3) 派生函数（防御式）：org_id 为 NULL 时从归属 assignment/plan 推导；无法解析
--    则保持 NULL，绝不 RAISE。
-- ============================================================================
CREATE OR REPLACE FUNCTION derive_assignment_event_org() RETURNS trigger AS $$
DECLARE
  v_org_id varchar(255);
BEGIN
  -- 显式写入优先；AFTER 触发器对非空 org_id 提前返回（自 UPDATE 的二次触发在此短路）。
  IF NEW.org_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- 首选：经 ewoh_scheduling_plan_assignment 直接取 org_id（分配行带 org_id 列）。
  SELECT pa.org_id INTO v_org_id
    FROM __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment pa
   WHERE pa.assignment_id = NEW.assignment_id;

  -- 回退：经 plan_assignment → ewoh_schedule_plan（分配行 org_id 为空但方案有归属）。
  IF v_org_id IS NULL THEN
    SELECT p.org_id INTO v_org_id
      FROM __EWOH_SCHEMA__.ewoh_schedule_plan p
      JOIN __EWOH_SCHEMA__.ewoh_scheduling_plan_assignment pa ON pa.plan_id = p.plan_id
     WHERE pa.assignment_id = NEW.assignment_id
     LIMIT 1;
  END IF;

  -- 归属可解析 → 落库；否则保持 NULL（防御：不失败、不误标）。
  IF v_org_id IS NOT NULL THEN
    UPDATE __EWOH_SCHEMA__.ewoh_assignment_event
       SET org_id = v_org_id
     WHERE id = NEW.id
       AND org_id IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 4) AFTER INSERT OR UPDATE 触发器（幂等：先 DROP IF EXISTS 再 CREATE）。
-- ============================================================================
DROP TRIGGER IF EXISTS trg_assignment_event_derive_org
  ON __EWOH_SCHEMA__.ewoh_assignment_event;
CREATE TRIGGER trg_assignment_event_derive_org
  AFTER INSERT OR UPDATE ON __EWOH_SCHEMA__.ewoh_assignment_event
  FOR EACH ROW EXECUTE FUNCTION derive_assignment_event_org();
