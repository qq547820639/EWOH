-- standalone_064 verify：ewoh_schedule_plan 双列存在 + 来源约束语义自证。
--
-- 2026-09-12（NO-58 烧账）：原文件用 psql 专属 `\gset` 把结果抓进变量再拼 `:var`，
-- node 迁移 runner（postgres.js）无法执行 → 全链 verify 永远失败。改为**纯 SQL 自证**：
-- 断言全部成立才返回 `standalone_064_verified = 1` 一行，否则**不返回行**（runner 判 FAIL）。
SELECT set_config('search_path', '__EWOH_SCHEMA__, pg_temp', false);

SELECT 1 AS standalone_064_verified
 WHERE (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'ai_narration') = 1
   AND (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'narration_source') = 1
   AND (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'ai_narration'
           AND data_type = 'text') = 1
   AND (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'ewoh_schedule_plan'
           AND column_name = 'narration_source'
           AND character_maximum_length = 32) = 1;
