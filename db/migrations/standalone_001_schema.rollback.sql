-- EWOH standalone schema rollback
-- DESTRUCTIVE (scoped, see below). Shared cluster roles (anon, authenticated,
-- service_role) are intentionally retained.
--
-- 审计 SQL-038 修复（2026-08-17）：原实现对全部 56 张表一律 DROP TABLE
-- CASCADE。standalone_001 的表分两类：
--   A) 001 全新创建（managed_tables status=new，如 ewoh_audit_log /
--      ewoh_workstation* / ewoh_control_* 等）→ DROP TABLE 合理（数据本身
--      由 001 体系创建）；
--   B) 「既有物理表基线」（status=altered / mapped-existing：ewoh_device /
--      ewoh_event / ewoh_personnel / ewoh_production_task /
--      ewoh_schedule_plan / ewoh_scheduler_config / ewoh_telemetry /
--      ewoh_world_state / ewoh_topology / ewoh_spatial_entity /
--      ewoh_model_registry / ewoh_event_chain / ewoh_environment /
--      ewoh_organization / ewoh_device_binding / ewoh_device_config /
--      ewoh_ai_suggestion）——在既有库（Miaoda 基线）上 001 仅以
--      ALTER ADD COLUMN IF NOT EXISTS 补列，原 rollback 的 DROP TABLE 会
--      整表删除既有业务数据（破坏性，超出 001 的变更范围）。
-- B 类表回滚改为：DROP POLICY（先于 DROP COLUMN，避免残留 policy 引用已删
-- 列）→ DISABLE ROW LEVEL SECURITY → 仅 DROP 001 增量列
-- （org_id / _created_by / _updated_by）。_created_at / _updated_at 在既有
-- 表上可能先于 001 存在，回滚保留（additive-safe：列存在与否不影响 001
-- 重放，ALTER ADD COLUMN IF NOT EXISTS 幂等）。
-- 回滚 001 前请确认：A 类表数据可放弃；B 类表增量列数据可放弃。
SELECT set_config('search_path', 'public, pg_temp', false);

-- ===== A) 001 全新创建的表：DROP TABLE（原语义保留） =====
DROP TABLE IF EXISTS public.ewoh_asset_package CASCADE;
DROP TABLE IF EXISTS public.ewoh_factory_profile CASCADE;
DROP TABLE IF EXISTS public.ewoh_factory_template CASCADE;
DROP TABLE IF EXISTS public.ewoh_audit_log CASCADE;
DROP TABLE IF EXISTS public.ewoh_notification CASCADE;
DROP TABLE IF EXISTS public.ewoh_knowledge_entry CASCADE;
DROP TABLE IF EXISTS public.ewoh_knowledge_base CASCADE;
DROP TABLE IF EXISTS public.ewoh_system_config CASCADE;
DROP TABLE IF EXISTS public.ewoh_world_delta_log CASCADE;
DROP TABLE IF EXISTS public.ewoh_world_snapshot CASCADE;
DROP TABLE IF EXISTS public.ewoh_event_subscription CASCADE;
DROP TABLE IF EXISTS public.ewoh_event_action CASCADE;
DROP TABLE IF EXISTS public.ewoh_event_rule CASCADE;
DROP TABLE IF EXISTS public.ewoh_control_result CASCADE;
DROP TABLE IF EXISTS public.ewoh_control_command CASCADE;
DROP TABLE IF EXISTS public.ewoh_control_request CASCADE;
DROP TABLE IF EXISTS public.ewoh_resource_binding CASCADE;
DROP TABLE IF EXISTS public.ewoh_resource_preorder CASCADE;
DROP TABLE IF EXISTS public.ewoh_schedule_assignment CASCADE;
DROP TABLE IF EXISTS public.ewoh_schedule_task_step CASCADE;
DROP TABLE IF EXISTS public.ewoh_schedule_task CASCADE;
DROP TABLE IF EXISTS public.ewoh_task_skill_req CASCADE;
DROP TABLE IF EXISTS public.ewoh_task_step CASCADE;
DROP TABLE IF EXISTS public.ewoh_task_template CASCADE;
DROP TABLE IF EXISTS public.ewoh_workstation_relation CASCADE;
DROP TABLE IF EXISTS public.ewoh_workstation_skill CASCADE;
DROP TABLE IF EXISTS public.ewoh_workstation_person CASCADE;
DROP TABLE IF EXISTS public.ewoh_workstation_device CASCADE;
DROP TABLE IF EXISTS public.ewoh_workstation CASCADE;
DROP TABLE IF EXISTS public.ewoh_model_binding CASCADE;
DROP TABLE IF EXISTS public.ewoh_model_asset CASCADE;
DROP TABLE IF EXISTS public.ewoh_spatial_hierarchy CASCADE;
DROP TABLE IF EXISTS public.ewoh_spatial_relation CASCADE;
DROP TABLE IF EXISTS public.ewoh_device_capability CASCADE;
DROP TABLE IF EXISTS public.ewoh_person_role CASCADE;
DROP TABLE IF EXISTS public.ewoh_role CASCADE;
DROP TABLE IF EXISTS public.ewoh_skill CASCADE;
DROP TABLE IF EXISTS public.ewoh_person_skill CASCADE;

-- ===== B) 既有物理表（altered / mapped-existing）：撤 001 增量（policy +
--      RLS 开关 + org_id/_created_by/_updated_by 列），不 DROP TABLE =====
DO $$
DECLARE
  t text;
  v_existing_tables text[] := ARRAY[
    'ewoh_world_state',
    'ewoh_topology',
    'ewoh_telemetry',
    'ewoh_spatial_entity',
    'ewoh_scheduler_config',
    'ewoh_schedule_plan',
    'ewoh_schedule_audit',
    'ewoh_production_task',
    'ewoh_personnel',
    'ewoh_organization',
    'ewoh_model_registry',
    'ewoh_event_chain',
    'ewoh_event',
    'ewoh_environment',
    'ewoh_device_config',
    'ewoh_device_binding',
    'ewoh_device',
    'ewoh_ai_suggestion'
  ];
BEGIN
  FOREACH t IN ARRAY v_existing_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS ewoh_org_select ON public.%I', t);
      EXECUTE format('DROP POLICY IF EXISTS ewoh_service_all ON public.%I', t);
      EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS org_id', t);
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS _created_by', t);
      EXECUTE format('ALTER TABLE public.%I DROP COLUMN IF EXISTS _updated_by', t);
    END IF;
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.ewoh_append_audit_log(uuid, text, text, text, text, jsonb, jsonb, text, text, text, boolean, text);
DROP FUNCTION IF EXISTS public.ewoh_org_visible(uuid);
