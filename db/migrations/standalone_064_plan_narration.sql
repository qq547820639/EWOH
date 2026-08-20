-- EWOH 2026-08-21 — AI 调度说明层（standalone_064）
-- 给 ewoh_schedule_plan 增加 ai_narration（LLM/规则模板生成的自然语言方案说明）
-- 与 narration_source（llm | rule_fallback）。
-- 幂等：DO 块按列存在性守卫，重复执行无副作用。
-- Schema: __EWOH_SCHEMA__ (standalone → public)

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'ai_narration'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
      ADD COLUMN ai_narration text;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_schedule_plan'
      AND column_name = 'narration_source'
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_schedule_plan
      ADD COLUMN narration_source varchar(32);
  END IF;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.ai_narration IS
  'AI（LLM）或规则模板生成的自然语言调度方案说明（2026-08-21 narration 层；LLM 纯后置只读，不参与求解）';
COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_schedule_plan.narration_source IS
  '说明来源：llm | rule_fallback（LLM 不可用/超时/失败时规则模板兜底）';
