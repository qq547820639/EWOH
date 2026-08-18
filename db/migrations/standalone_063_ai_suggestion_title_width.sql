-- EWOH 2026-08-19 审计整改 — P1：ai_suggestion schema vs 迁移列宽漂移收口
-- (standalone_063, docs/audit-report-2026-08-19.md P1「契约对齐：schema vs 迁移列宽漂移（ai_suggestion）」)
-- Schema: __EWOH_SCHEMA__ (standalone → public)
--
-- 背景：drizzle schema.ts 与 001 迁移在 ewoh_ai_suggestion 四列上漂移——
--   title           schema 500 / DB 255（写入侧 title=input.problem，LLM 问题
--                   文本可超 255 → 生产 'value too long' 稳定 500）；
--   suggestion_type schema 50 / DB 255；
--   status          schema 50 / DB 255；
--   ai_level        schema 10 / DB 255。
--
-- 收敛方向（"类型✓运行时✓schema✓迁移✓四处全改"）：
--   1) DB title 拓宽 255→500（拓宽零数据损失，与 schema.ts 意图一致）；
--   2) schema.ts 其余三列回填 255（DB 实况为准，收窄 DB 反而有截断风险）。
-- Re-entrant：长度判断幂等（DO 块守卫）。

SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ewoh_ai_suggestion'
      AND column_name = 'title'
      AND character_maximum_length = 255
  ) THEN
    ALTER TABLE __EWOH_SCHEMA__.ewoh_ai_suggestion
      ALTER COLUMN title TYPE varchar(500);
  END IF;
END $$;

COMMENT ON COLUMN __EWOH_SCHEMA__.ewoh_ai_suggestion.title IS
  '建议标题（input.problem 原文，可较长；varchar(500) 与 schema.ts 对齐；2026-08-19 审计 P1 列宽收口）';
